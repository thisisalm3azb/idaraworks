/**
 * H29 — adopting a pack version, and the preview that must come first
 * (ADR-69, ADR-71).
 *
 * A new version never applies by existing. Someone with the authority looks at
 * what would change, chooses a date, and adopts it. The adoption row is
 * history: it is inserted, never edited, and a later one supersedes it.
 *
 * The preview is computed by comparing two pack definitions and counting what
 * is already issued. It writes nothing.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { getPack, packsFor, type CountryPack } from "@/platform/country";
import { CountryError, listEstablishmentsIn } from "./establishments";
import { establishmentReadiness } from "./readiness";
import type { AdoptionRow, ImpactLine, ImpactPreview } from "./types";

export const AdoptPackInput = z.object({
  establishmentId: z.string().uuid(),
  packKey: z.string().trim().min(1).max(40),
  effectiveFrom: z.string().date(),
  note: z.string().trim().max(1000).optional(),
});

function diff(before: CountryPack | null, after: CountryPack): ImpactLine[] {
  const lines: ImpactLine[] = [];
  const add = (
    area: ImpactLine["area"],
    labelKey: string,
    b: string | null,
    a: string | null,
    actionRequired = false,
  ) => {
    if (b !== a) lines.push({ area, labelKey, before: b, after: a, actionRequired });
  };

  add(
    "format",
    "country.impact.currency",
    before?.format.currency ?? null,
    after.format.currency,
    true,
  );
  add(
    "format",
    "country.impact.timezone",
    before?.format.defaultTimezone ?? null,
    after.format.defaultTimezone,
  );
  add(
    "format",
    "country.impact.required_document_languages",
    before ? before.format.requiredDocumentLanguages.value.join(", ") : null,
    after.format.requiredDocumentLanguages.value.join(", "),
    after.format.requiredDocumentLanguages.value.length > 0,
  );
  add(
    "week",
    "country.impact.working_days",
    before ? before.week.defaultWorkingDays.join(", ") : null,
    after.week.defaultWorkingDays.join(", "),
  );
  add(
    "identity",
    "country.impact.identifiers",
    before ? before.identifiers.map((i) => i.key).join(", ") : null,
    after.identifiers.map((i) => i.key).join(", "),
    true,
  );
  add(
    "banking",
    "country.impact.iban_length",
    before ? String(before.banking.ibanLength ?? "—") : null,
    String(after.banking.ibanLength ?? "—"),
  );

  for (const taxModule of after.tax) {
    const was = before?.tax.find((t) => t.key === taxModule.key);
    add(
      "tax",
      "country.impact.tax_rate",
      was ? String(was.standardRatePercent.value ?? "—") : null,
      String(taxModule.standardRatePercent.value ?? "—"),
      true,
    );
    add(
      "tax",
      "country.impact.tax_document_fields",
      was ? String(was.documentFields.value.length) : null,
      String(taxModule.documentFields.value.length),
      true,
    );
  }

  if (after.payroll) {
    add(
      "payroll",
      "country.impact.payroll_engine",
      before?.payroll?.engineVersion ?? null,
      after.payroll.engineVersion,
      after.payroll.engineVersion === null,
    );
    add(
      "payroll",
      "country.impact.statutory_contributions",
      before?.payroll ? String(before.payroll.statutoryContributions.length) : null,
      String(after.payroll.statutoryContributions.length),
      true,
    );
  }

  add(
    "einvoicing",
    "country.impact.einvoice_model",
    before?.einvoicing.model ?? null,
    after.einvoicing.model,
    after.einvoicing.model !== "none",
  );
  return lines;
}

/** What is already issued and therefore cannot change (ADR-70). */
async function issuedCounts(
  tx: TenantTx,
  ctx: Ctx,
): Promise<Array<{ kind: string; count: number; note: string }>> {
  const rows = (await tx.execute(sql`
    select
      (select count(*) from public.invoice where org_id = ${ctx.orgId})::int as invoices,
      (select count(*) from public.pay_run where org_id = ${ctx.orgId})::int as pay_runs,
      (select count(*) from public.journal_entry where org_id = ${ctx.orgId})::int as journals
  `)) as unknown as Array<{ invoices: number; pay_runs: number; journals: number }>;
  const r = rows[0] ?? { invoices: 0, pay_runs: 0, journals: 0 };
  return [
    {
      kind: "invoice",
      count: Number(r.invoices),
      note: "Issued invoices keep the pack version that produced them.",
    },
    {
      kind: "pay_run",
      count: Number(r.pay_runs),
      note: "Payroll runs keep their own calculation snapshot.",
    },
    {
      kind: "journal_entry",
      count: Number(r.journals),
      note: "Posted entries are immutable and unaffected.",
    },
  ];
}

export async function previewAdoption(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<ImpactPreview> {
  assertCan(archetype, "country.simulate");
  const input = AdoptPackInput.parse(raw);
  const target = getPack(input.packKey);
  if (!target) throw new CountryError(`unknown pack ${input.packKey}`, "not_found");

  return withCtx(ctx, async (tx) => {
    const establishment = (await listEstablishmentsIn(tx, ctx)).find(
      (e) => e.id === input.establishmentId,
    );
    if (!establishment) throw new CountryError("establishment not found", "not_found");
    if (establishment.country !== target.country)
      throw new CountryError(
        `pack ${target.packKey} is for ${target.country}, not ${establishment.country}`,
        "invalid",
      );

    const currentKey =
      (
        (await tx.execute(sql`
        select app.establishment_pack_on(${establishment.id}::uuid, ${input.effectiveFrom}::date) as pack_key`)) as unknown as Array<{
          pack_key: string | null;
        }>
      )[0]?.pack_key ?? null;
    const current = currentKey ? getPack(currentKey) : null;

    const readiness = await establishmentReadiness(ctx, establishment.id, input.effectiveFrom);
    return {
      establishmentId: establishment.id,
      fromPackKey: currentKey,
      toPackKey: target.packKey,
      effectiveFrom: input.effectiveFrom,
      changes: diff(current, target),
      unchanged: await issuedCounts(tx, ctx),
      stillMissing: (readiness?.areas ?? [])
        .flatMap((a) => a.checks)
        .filter((c) => c.state === "missing" || c.state === "blocked"),
      newProviderRequirements: target.einvoicing.requiredProviders.filter(
        (p) => !(current?.einvoicing.requiredProviders ?? []).includes(p),
      ),
    };
  });
}

export async function adoptPack(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<AdoptionRow> {
  assertCan(archetype, "country.adopt");
  const input = AdoptPackInput.parse(raw);
  const target = getPack(input.packKey);
  if (!target) throw new CountryError(`unknown pack ${input.packKey}`, "not_found");
  if (input.effectiveFrom < target.effectiveFrom)
    throw new CountryError(
      `a version cannot apply before it exists: ${target.packKey} starts ${target.effectiveFrom}`,
      "invalid",
    );
  if (target.status === "draft" || target.status === "review")
    throw new CountryError(
      `pack ${target.packKey} is ${target.status} and cannot be adopted`,
      "state",
    );

  // The preview is not optional: it is computed here and stored on the row, so
  // the record shows what the person was shown.
  const impact = await previewAdoption(ctx, archetype, input);

  return command<AdoptionRow>(
    ctx,
    {
      audit: (result) => ({
        action: "establishment.pack.adopt",
        entityType: "establishment",
        entityId: result.establishmentId,
        summary: `Adopted country pack ${result.packKey} from ${result.effectiveFrom}`,
        before: { packKey: impact.fromPackKey },
        after: { packKey: result.packKey, effectiveFrom: result.effectiveFrom },
      }),
    },
    async (tx) => {
      const establishment = (await listEstablishmentsIn(tx, ctx)).find(
        (e) => e.id === input.establishmentId,
      );
      if (!establishment) throw new CountryError("establishment not found", "not_found");

      const rows = (await tx.execute(sql`
        insert into public.establishment_pack_adoption
          (org_id, establishment_id, pack_key, effective_from, adopted_by, impact, note)
        values (${ctx.orgId}, ${input.establishmentId}, ${input.packKey}, ${input.effectiveFrom},
                ${ctx.userId}, ${JSON.stringify(impact)}::jsonb, ${input.note ?? null})
        returning id::text as id, establishment_id::text as establishment_id, pack_key,
                  effective_from::text as effective_from, adopted_by::text as adopted_by,
                  note, superseded_by::text as superseded_by, created_at::text as created_at
      `)) as unknown as Array<Record<string, unknown>>;
      const row = rows[0]!;

      // The establishment's current pointer follows the newest adoption whose
      // date has arrived; earlier rows stay exactly as they were.
      await tx.execute(sql`
        update public.establishment
        set pack_key = app.establishment_pack_on(${input.establishmentId}::uuid, current_date),
            updated_at = now()
        where id = ${input.establishmentId} and org_id = ${ctx.orgId}`);

      return {
        id: String(row.id),
        establishmentId: String(row.establishment_id),
        packKey: String(row.pack_key),
        effectiveFrom: String(row.effective_from),
        adoptedBy: String(row.adopted_by),
        note: (row.note as string | null) ?? null,
        supersededBy: (row.superseded_by as string | null) ?? null,
        createdAt: String(row.created_at),
      };
    },
  );
}

export async function listAdoptions(ctx: Ctx, establishmentId: string): Promise<AdoptionRow[]> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, establishment_id::text as establishment_id, pack_key,
             effective_from::text as effective_from, adopted_by::text as adopted_by,
             note, superseded_by::text as superseded_by, created_at::text as created_at
      from public.establishment_pack_adoption
      where org_id = ${ctx.orgId} and establishment_id = ${establishmentId}
      order by effective_from desc, created_at desc`)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      establishmentId: String(r.establishment_id),
      packKey: String(r.pack_key),
      effectiveFrom: String(r.effective_from),
      adoptedBy: String(r.adopted_by),
      note: (r.note as string | null) ?? null,
      supersededBy: (r.superseded_by as string | null) ?? null,
      createdAt: String(r.created_at),
    }));
  });
}

/** Every version of a country, with the one in force on a date marked. */
export function packTimeline(
  country: string,
  on: string = new Date().toISOString().slice(0, 10),
): Array<{ pack: CountryPack; inForce: boolean; future: boolean }> {
  return packsFor(country).map((pack) => ({
    pack,
    inForce: on >= pack.effectiveFrom && (pack.effectiveTo === null || on < pack.effectiveTo),
    future: pack.effectiveFrom > on,
  }));
}
