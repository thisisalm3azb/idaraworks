/**
 * H29 — channels and the document lifecycle (ADR-72, ADR-73).
 *
 * A channel is where an establishment's connection to an authority lives: which
 * adapter, which environment, which credential NAME, and what state it is in. A
 * channel can be created and configured by an organisation; it can only reach
 * `ready` when a credential actually resolves, and it can be stopped at any
 * time without losing the evidence of what has already happened.
 *
 * Sandbox and production are separate rows with separate credentials. A sandbox
 * credential can never be used by a production channel, because they are
 * different records with different names.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { adapterFor, credentialPresent } from "./registry";
import type { EInvoiceEnvironment } from "./adapters/types";

export class EInvoiceError extends Error {
  constructor(
    message: string,
    public readonly kind: "not_found" | "invalid" | "state" | "unavailable",
  ) {
    super(message);
    this.name = "EInvoiceError";
  }
}

export type ChannelRow = {
  id: string;
  establishmentId: string;
  country: string;
  adapterKey: string;
  environment: EInvoiceEnvironment;
  status:
    | "not_configured"
    | "sandbox_configured"
    | "onboarding"
    | "validating"
    | "ready"
    | "suspended"
    | "retired";
  credentialRef: string | null;
  /** Whether that credential actually resolves here. Never the value. */
  credentialPresent: boolean;
  stopped: boolean;
  stopReason: string | null;
  activatedAt: string | null;
  lastHealth: string | null;
  lastHealthAt: string | null;
};

export const CreateChannelInput = z.object({
  establishmentId: z.string().uuid(),
  adapterKey: z.string().trim().min(1).max(40),
  environment: z.enum(["sandbox", "production"]),
});

export const ConfigureChannelInput = z.object({
  id: z.string().uuid(),
  /** The NAME of an environment variable, never a secret. */
  credentialRef: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{2,119}$/, "a credential reference is the NAME of a server variable")
    .nullable()
    .optional(),
  stopped: z.boolean().optional(),
  stopReason: z.string().trim().max(500).nullable().optional(),
});

function rowOf(r: Record<string, unknown>, env: Record<string, string | undefined>): ChannelRow {
  const ref = (r.credential_ref as string | null) ?? null;
  return {
    id: String(r.id),
    establishmentId: String(r.establishment_id),
    country: String(r.country),
    adapterKey: String(r.adapter_key),
    environment: String(r.environment) as EInvoiceEnvironment,
    status: String(r.status) as ChannelRow["status"],
    credentialRef: ref,
    credentialPresent: credentialPresent(ref, env),
    stopped: Boolean(r.stopped),
    stopReason: (r.stop_reason as string | null) ?? null,
    activatedAt: (r.activated_at as string | null) ?? null,
    lastHealth: (r.last_health as string | null) ?? null,
    lastHealthAt: (r.last_health_at as string | null) ?? null,
  };
}

const SELECT = sql`
  select id::text as id, establishment_id::text as establishment_id, country, adapter_key,
         environment, status, credential_ref, stopped, stop_reason,
         activated_at::text as activated_at, last_health, last_health_at::text as last_health_at
  from public.einvoice_channel`;

export async function listChannels(
  ctx: Ctx,
  establishmentId?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ChannelRow[]> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      ${SELECT} where org_id = ${ctx.orgId}
        and (${establishmentId ?? null}::uuid is null or establishment_id = ${establishmentId ?? null}::uuid)
      order by adapter_key, environment`)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => rowOf(r, env));
  });
}

export async function createChannel(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<ChannelRow> {
  assertCan(archetype, "country.manage");
  const input = CreateChannelInput.parse(raw);
  const adapter = adapterFor(input.adapterKey);
  if (!adapter) throw new EInvoiceError(`unknown adapter ${input.adapterKey}`, "not_found");

  return command<ChannelRow>(
    ctx,
    {
      audit: (result) => ({
        action: "einvoice.channel.create",
        entityType: "establishment",
        entityId: result.establishmentId,
        summary: `Created a ${result.environment} ${result.adapterKey} channel`,
      }),
    },
    async (tx) => {
      const establishment = (await tx.execute(sql`
        select country from public.establishment
        where id = ${input.establishmentId} and org_id = ${ctx.orgId}`)) as unknown as Array<{
        country: string;
      }>;
      if (!establishment[0]) throw new EInvoiceError("establishment not found", "not_found");
      if (!adapter.countries.includes(establishment[0].country))
        throw new EInvoiceError(
          `${adapter.key} serves ${adapter.countries.join(", ")}, not ${establishment[0].country}`,
          "invalid",
        );

      const rows = (await tx.execute(sql`
        insert into public.einvoice_channel (org_id, establishment_id, country, adapter_key, environment)
        values (${ctx.orgId}, ${input.establishmentId}, ${establishment[0].country},
                ${input.adapterKey}, ${input.environment})
        on conflict (org_id, establishment_id, adapter_key, environment) do update
          set updated_at = now()
        returning id::text as id, establishment_id::text as establishment_id, country, adapter_key,
                  environment, status, credential_ref, stopped, stop_reason,
                  activated_at::text as activated_at, last_health,
                  last_health_at::text as last_health_at`)) as unknown as Array<
        Record<string, unknown>
      >;
      return rowOf(rows[0]!, env);
    },
  );
}

/**
 * Recording a credential name does not activate a channel. The status moves to
 * `sandbox_configured` or `onboarding` — never straight to `ready` — because
 * readiness is something the authority confirms, not something a form asserts.
 */
export async function configureChannel(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<ChannelRow> {
  assertCan(archetype, "country.manage");
  const input = ConfigureChannelInput.parse(raw);

  return command<ChannelRow>(
    ctx,
    {
      audit: (result) => ({
        action: "einvoice.channel.configure",
        entityType: "establishment",
        entityId: result.establishmentId,
        // The credential NAME is auditable; there is no value to leak.
        summary: result.stopped
          ? `Stopped the ${result.environment} ${result.adapterKey} channel`
          : `Configured the ${result.environment} ${result.adapterKey} channel with ${result.credentialRef ?? "no credential"}`,
      }),
    },
    async (tx) => {
      const current = (await tx.execute(sql`
        ${SELECT} where id = ${input.id} and org_id = ${ctx.orgId}`)) as unknown as Array<
        Record<string, unknown>
      >;
      if (!current[0]) throw new EInvoiceError("channel not found", "not_found");

      const ref =
        input.credentialRef === undefined
          ? ((current[0].credential_ref as string | null) ?? null)
          : input.credentialRef;
      const present = credentialPresent(ref, env);
      const environment = String(current[0].environment);
      const status = !present
        ? "not_configured"
        : environment === "sandbox"
          ? "sandbox_configured"
          : "onboarding";

      const rows = (await tx.execute(sql`
        update public.einvoice_channel set
          credential_ref = ${ref},
          status = ${status},
          stopped = coalesce(${input.stopped ?? null}, stopped),
          stop_reason = ${input.stopReason === undefined ? sql`stop_reason` : (input.stopReason ?? null)},
          updated_at = now()
        where id = ${input.id} and org_id = ${ctx.orgId}
        returning id::text as id, establishment_id::text as establishment_id, country, adapter_key,
                  environment, status, credential_ref, stopped, stop_reason,
                  activated_at::text as activated_at, last_health,
                  last_health_at::text as last_health_at`)) as unknown as Array<
        Record<string, unknown>
      >;
      return rowOf(rows[0]!, env);
    },
  );
}
