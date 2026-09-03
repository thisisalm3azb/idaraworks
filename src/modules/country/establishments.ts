/**
 * H29 — establishments: the jurisdictional unit (ADR-67).
 *
 * Reads never throw and never require a pack. An organisation that has not
 * created an establishment gets a derived one from its own country, timezone,
 * currency and working week, so H29 changes nothing for anyone until they
 * choose it.
 *
 * The country of an establishment is set once. Changing it after records exist
 * would reinterpret them, so it is a governed operation with its own preview,
 * not a column update — which is why the migration does not grant it.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, can } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import {
  addressProblems,
  countrySupported,
  ibanProblems,
  identifierProblems,
  resolvePack,
  WEEKDAYS,
  type FieldProblem,
  type Weekday,
} from "@/platform/country";
import type { EffectiveConfig, EstablishmentRow, RegistrationRow } from "./types";

export class CountryError extends Error {
  constructor(
    message: string,
    public readonly kind: "not_found" | "invalid" | "state" | "unsupported",
    public readonly problems: FieldProblem[] = [],
  ) {
    super(message);
    this.name = "CountryError";
  }
}

const WeekdayEnum = z.enum(WEEKDAYS);

export const CreateEstablishmentInput = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9][A-Z0-9_-]{0,23}$/, "code must be upper-case letters, digits, _ or -"),
  legalName: z.string().trim().min(1).max(200),
  tradingName: z.string().trim().min(1).max(200).optional(),
  legalNameLocal: z.string().trim().min(1).max(200).optional(),
  country: z.string().trim().length(2),
  timezone: z.string().trim().min(1).max(64),
  baseCurrency: z.string().trim().length(3),
  workingDays: z.array(WeekdayEnum).max(7).optional(),
  address: z.record(z.string(), z.string().max(200)).optional(),
  isPrimary: z.boolean().optional(),
});

export const UpdateEstablishmentInput = z.object({
  id: z.string().uuid(),
  legalName: z.string().trim().min(1).max(200).optional(),
  tradingName: z.string().trim().max(200).nullable().optional(),
  legalNameLocal: z.string().trim().max(200).nullable().optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  baseCurrency: z.string().trim().length(3).optional(),
  workingDays: z.array(WeekdayEnum).max(7).optional(),
  address: z.record(z.string(), z.string().max(200)).optional(),
  invoiceIdentity: z.record(z.string(), z.unknown()).optional(),
  banking: z
    .object({ bankName: z.string().max(120).optional(), iban: z.string().max(60).optional() })
    .optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

function rowOf(r: Record<string, unknown>): EstablishmentRow {
  return {
    id: String(r.id),
    code: String(r.code),
    legalName: String(r.legal_name),
    tradingName: (r.trading_name as string | null) ?? null,
    legalNameLocal: (r.legal_name_local as string | null) ?? null,
    country: String(r.country),
    packKey: (r.pack_key as string | null) ?? null,
    timezone: String(r.timezone),
    baseCurrency: String(r.base_currency),
    workingDays: asJson<Weekday[]>(r.working_days) ?? [],
    address: asJson<Record<string, string>>(r.address) ?? {},
    invoiceIdentity: asJson<Record<string, unknown>>(r.invoice_identity) ?? {},
    banking: asJson<Record<string, unknown>>(r.banking) ?? {},
    isPrimary: Boolean(r.is_primary),
    status: String(r.status) as "active" | "inactive",
    verificationState: String(r.verification_state) as EstablishmentRow["verificationState"],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** postgres.js returns jsonb already parsed; a string can still arrive from a cast. */
function asJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

/**
 * Every establishment an organisation has, unpaged and on purpose.
 *
 * An establishment is a legal presence: one per branch, registration or country.
 * Organisations have a handful of them, the way they have a handful of teams or
 * templates, and readiness has to be computed across all of them at once for the
 * centre to mean anything. The unbounded-growth tables H29 adds — pack
 * adoptions, electronic-invoicing documents and their events — are paged.
 */
export async function listEstablishmentsIn(tx: TenantTx, ctx: Ctx): Promise<EstablishmentRow[]> {
  const rows = (await tx.execute(sql`
    select id::text as id, code, legal_name, trading_name, legal_name_local, country, pack_key,
           timezone, base_currency, working_days, address, invoice_identity, banking,
           is_primary, status, verification_state, created_at::text as created_at,
           updated_at::text as updated_at
    from public.establishment where org_id = ${ctx.orgId}
    order by is_primary desc, code`)) as unknown as Array<Record<string, unknown>>;
  return rows.map(rowOf);
}

export async function listEstablishments(ctx: Ctx): Promise<EstablishmentRow[]> {
  return withCtx(ctx, (tx) => listEstablishmentsIn(tx, ctx));
}

export async function getEstablishment(ctx: Ctx, id: string): Promise<EstablishmentRow | null> {
  const rows = await listEstablishments(ctx);
  return rows.find((r) => r.id === id) ?? null;
}

/**
 * The configuration in force for an establishment on a date — or, when the
 * organisation has none, one derived from the organisation itself. Never
 * throws: a surface that asks about a country with no pack gets `pack: null`
 * and can say so.
 */
export async function effectiveConfig(
  ctx: Ctx,
  opts: { establishmentId?: string | null; on?: string } = {},
): Promise<EffectiveConfig> {
  const on = opts.on ?? new Date().toISOString().slice(0, 10);
  return withCtx(ctx, async (tx) => {
    const establishments = await listEstablishmentsIn(tx, ctx);
    const chosen = opts.establishmentId
      ? establishments.find((e) => e.id === opts.establishmentId)
      : (establishments.find((e) => e.isPrimary) ??
        establishments.find((e) => e.status === "active"));

    if (chosen) {
      // The adopted version for this date, which may be older than the newest.
      const adopted = (await tx.execute(sql`
        select app.establishment_pack_on(${chosen.id}::uuid, ${on}::date) as pack_key`)) as unknown as Array<{
        pack_key: string | null;
      }>;
      const packKey = adopted[0]?.pack_key ?? null;
      const pack = packKey
        ? resolvePack(chosen.country, on)?.packKey === packKey
          ? resolvePack(chosen.country, on)
          : null
        : null;
      return {
        establishmentId: chosen.id,
        derived: false,
        country: chosen.country,
        timezone: chosen.timezone,
        currency: chosen.baseCurrency,
        workingDays: chosen.workingDays,
        packKey,
        pack,
        on,
      };
    }

    const org = (await tx.execute(sql`
      select country, timezone, base_currency, working_week
      from public.org where id = ${ctx.orgId}`)) as unknown as Array<Record<string, unknown>>;
    const o = org[0];
    const week = asJson<{ days?: Weekday[] }>(o?.working_week) ?? {};
    return {
      establishmentId: null,
      derived: true,
      country: String(o?.country ?? ""),
      timezone: String(o?.timezone ?? "UTC"),
      currency: String(o?.base_currency ?? ""),
      workingDays: week.days ?? [],
      packKey: null,
      pack: null,
      on,
    };
  });
}

// ── writes ──────────────────────────────────────────────────────────────────

export async function createEstablishment(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<EstablishmentRow> {
  assertCan(archetype, "country.manage");
  const input = CreateEstablishmentInput.parse(raw);
  if (!countrySupported(input.country))
    throw new CountryError(`no country pack exists for ${input.country}`, "unsupported", [
      { field: "country", messageKey: "country.validation.country_unsupported" },
    ]);

  const pack = resolvePack(input.country, new Date().toISOString().slice(0, 10));
  if (pack) {
    const problems = addressProblems(pack.address, input.address ?? {});
    // An address is checked only once something was entered; an establishment
    // may be created before its address is known.
    if (Object.keys(input.address ?? {}).length > 0 && problems.length)
      throw new CountryError(
        "the address does not match the country's format",
        "invalid",
        problems,
      );
  }

  return command<EstablishmentRow>(
    ctx,
    {
      audit: (result) => ({
        action: "establishment.create",
        entityType: "establishment",
        entityId: result.id,
        summary: `Created establishment ${result.code} in ${result.country}`,
        after: { code: result.code, country: result.country, timezone: result.timezone },
      }),
    },
    async (tx) => {
      const existing = await listEstablishmentsIn(tx, ctx);
      const isPrimary = input.isPrimary ?? existing.length === 0;
      if (isPrimary && existing.some((e) => e.isPrimary))
        await tx.execute(sql`
          update public.establishment set is_primary = false, updated_at = now()
          where org_id = ${ctx.orgId} and is_primary`);

      const workingDays = input.workingDays ?? pack?.week.defaultWorkingDays ?? [];
      const rows = (await tx.execute(sql`
        insert into public.establishment
          (org_id, code, legal_name, trading_name, legal_name_local, country, timezone,
           base_currency, working_days, address, is_primary)
        values (${ctx.orgId}, ${input.code}, ${input.legalName}, ${input.tradingName ?? null},
                ${input.legalNameLocal ?? null}, ${input.country}, ${input.timezone},
                ${input.baseCurrency}, ${JSON.stringify(workingDays)}::jsonb,
                ${JSON.stringify(input.address ?? {})}::jsonb, ${isPrimary})
        returning id::text as id, code, legal_name, trading_name, legal_name_local, country,
                  pack_key, timezone, base_currency, working_days, address, invoice_identity,
                  banking, is_primary, status, verification_state,
                  created_at::text as created_at, updated_at::text as updated_at`)) as unknown as Array<
        Record<string, unknown>
      >;
      return rowOf(rows[0]!);
    },
  );
}

export async function updateEstablishment(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<EstablishmentRow> {
  assertCan(archetype, "country.manage");
  const input = UpdateEstablishmentInput.parse(raw);
  const current = await getEstablishment(ctx, input.id);
  if (!current) throw new CountryError("establishment not found", "not_found");

  const pack = resolvePack(current.country, new Date().toISOString().slice(0, 10));
  const problems: FieldProblem[] = [];
  if (pack && input.address) problems.push(...addressProblems(pack.address, input.address));
  if (pack && input.banking?.iban) problems.push(...ibanProblems(input.banking.iban, pack));
  if (problems.length)
    throw new CountryError("the details do not match the country", "invalid", problems);

  return command<EstablishmentRow>(
    ctx,
    {
      audit: (result) => ({
        action: "establishment.update",
        entityType: "establishment",
        entityId: result.id,
        summary: `Updated establishment ${result.code}`,
        before: {
          timezone: current.timezone,
          baseCurrency: current.baseCurrency,
          workingDays: current.workingDays,
        },
        after: {
          timezone: result.timezone,
          baseCurrency: result.baseCurrency,
          workingDays: result.workingDays,
        },
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.establishment set
          legal_name = coalesce(${input.legalName ?? null}, legal_name),
          trading_name = ${input.tradingName === undefined ? sql`trading_name` : (input.tradingName ?? null)},
          legal_name_local = ${input.legalNameLocal === undefined ? sql`legal_name_local` : (input.legalNameLocal ?? null)},
          timezone = coalesce(${input.timezone ?? null}, timezone),
          base_currency = coalesce(${input.baseCurrency ?? null}, base_currency),
          working_days = coalesce(${input.workingDays ? JSON.stringify(input.workingDays) : null}::jsonb, working_days),
          address = coalesce(${input.address ? JSON.stringify(input.address) : null}::jsonb, address),
          invoice_identity = coalesce(${input.invoiceIdentity ? JSON.stringify(input.invoiceIdentity) : null}::jsonb, invoice_identity),
          banking = coalesce(${input.banking ? JSON.stringify(input.banking) : null}::jsonb, banking),
          status = coalesce(${input.status ?? null}, status),
          updated_at = now()
        where id = ${input.id} and org_id = ${ctx.orgId}
        returning id::text as id, code, legal_name, trading_name, legal_name_local, country,
                  pack_key, timezone, base_currency, working_days, address, invoice_identity,
                  banking, is_primary, status, verification_state,
                  created_at::text as created_at, updated_at::text as updated_at`)) as unknown as Array<
        Record<string, unknown>
      >;
      if (!rows[0]) throw new CountryError("establishment not found", "not_found");
      return rowOf(rows[0]);
    },
  );
}

// ── registrations ───────────────────────────────────────────────────────────

export const SetRegistrationInput = z.object({
  establishmentId: z.string().uuid(),
  identifierKey: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(80),
  issuedOn: z.string().date().optional(),
  expiresOn: z.string().date().optional(),
});

export async function listRegistrations(
  ctx: Ctx,
  establishmentId: string,
): Promise<RegistrationRow[]> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, establishment_id::text as establishment_id, identifier_key, kind,
             authority, value, issued_on::text as issued_on, expires_on::text as expires_on,
             verification_state
      from public.establishment_registration
      where org_id = ${ctx.orgId} and establishment_id = ${establishmentId}
      order by identifier_key`)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      establishmentId: String(r.establishment_id),
      identifierKey: String(r.identifier_key),
      kind: String(r.kind),
      authority: String(r.authority),
      value: String(r.value),
      issuedOn: (r.issued_on as string | null) ?? null,
      expiresOn: (r.expires_on as string | null) ?? null,
      verificationState: String(r.verification_state) as RegistrationRow["verificationState"],
    }));
  });
}

export async function setRegistration(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<RegistrationRow> {
  assertCan(archetype, "country.manage");
  const input = SetRegistrationInput.parse(raw);
  const establishment = await getEstablishment(ctx, input.establishmentId);
  if (!establishment) throw new CountryError("establishment not found", "not_found");

  const pack = resolvePack(establishment.country, new Date().toISOString().slice(0, 10));
  const spec = pack?.identifiers.find((i) => i.key === input.identifierKey);
  if (!spec)
    throw new CountryError(
      `${establishment.country} has no identifier called ${input.identifierKey}`,
      "invalid",
      [{ field: input.identifierKey, messageKey: "country.validation.identifier_unknown" }],
    );
  const problems = identifierProblems(spec, input.value);
  if (problems.length)
    throw new CountryError(
      "the identifier does not match its published shape",
      "invalid",
      problems,
    );

  return command<RegistrationRow>(
    ctx,
    {
      audit: (result) => ({
        action: "establishment.registration.set",
        entityType: "establishment",
        entityId: result.establishmentId,
        // The number itself is not written to the audit summary; the identifier
        // it belongs to and the authority that issued it are.
        summary: `Recorded ${result.identifierKey} issued by ${result.authority}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.establishment_registration
          (org_id, establishment_id, identifier_key, kind, authority, value, issued_on, expires_on)
        values (${ctx.orgId}, ${input.establishmentId}, ${input.identifierKey}, ${spec.kind},
                ${spec.authority}, ${input.value}, ${input.issuedOn ?? null}, ${input.expiresOn ?? null})
        on conflict (org_id, establishment_id, identifier_key) do update set
          value = excluded.value,
          authority = excluded.authority,
          issued_on = excluded.issued_on,
          expires_on = excluded.expires_on,
          updated_at = now()
        returning id::text as id, establishment_id::text as establishment_id, identifier_key, kind,
                  authority, value, issued_on::text as issued_on, expires_on::text as expires_on,
                  verification_state`)) as unknown as Array<Record<string, unknown>>;
      const r = rows[0]!;
      return {
        id: String(r.id),
        establishmentId: String(r.establishment_id),
        identifierKey: String(r.identifier_key),
        kind: String(r.kind),
        authority: String(r.authority),
        value: String(r.value),
        issuedOn: (r.issued_on as string | null) ?? null,
        expiresOn: (r.expires_on as string | null) ?? null,
        verificationState: String(r.verification_state) as RegistrationRow["verificationState"],
      };
    },
  );
}

/** Reads are wide; a viewer may see the configuration without changing it. */
export function mayViewCountries(archetype: RoleArchetype): boolean {
  return can(archetype, "country.view");
}
