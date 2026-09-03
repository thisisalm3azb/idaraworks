/**
 * H28 — the organisation's privacy register and self-service policy (ADR-54/61).
 *
 * A provider becomes usable for an organisation only after an administrator
 * records the lawful basis, the processor agreement, the transfer mechanism,
 * confirms minimisation and notes retention (what the sources in the truth
 * map C.7 require an operator to record). Self-service policy changes append
 * a new version that copies every operator-set field unchanged: an
 * organisation can disable AI, restrict domains and tighten its own limits,
 * never widen its allowance.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { resolveAiPolicy } from "./budget";
import { AI_PROVIDERS, type AiProviderKey } from "./registry";

export type PrivacyRow = {
  id: string;
  providerKey: AiProviderKey;
  lawfulBasis: string;
  processorAgreementRef: string;
  transferMechanism: string;
  retentionNote: string | null;
  minimisationConfirmed: boolean;
  ropaRef: string | null;
  dpoChecked: boolean;
  recordedBy: string;
  recordedAt: string;
};

export const PrivacyInput = z.object({
  providerKey: z.enum(["openai", "anthropic"]),
  lawfulBasis: z.string().trim().min(1).max(200),
  processorAgreementRef: z.string().trim().min(1).max(200),
  transferMechanism: z.string().trim().min(1).max(200),
  retentionNote: z.string().trim().max(500).optional(),
  minimisationConfirmed: z.boolean(),
  ropaRef: z.string().trim().max(200).optional(),
  dpoChecked: z.boolean().default(false),
});

export async function listPrivacyRegister(ctx: Ctx): Promise<PrivacyRow[]> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, provider_key, lawful_basis, processor_agreement_ref, transfer_mechanism, retention_note,
             minimisation_confirmed, ropa_ref, dpo_checked, recorded_by::text as recorded_by, recorded_at::text as recorded_at
      from public.ai_privacy_register where org_id = ${ctx.orgId} and revoked_at is null order by provider_key`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    providerKey: String(r.provider_key) as AiProviderKey,
    lawfulBasis: String(r.lawful_basis),
    processorAgreementRef: String(r.processor_agreement_ref),
    transferMechanism: String(r.transfer_mechanism),
    retentionNote: (r.retention_note as string | null) ?? null,
    minimisationConfirmed: Boolean(r.minimisation_confirmed),
    ropaRef: (r.ropa_ref as string | null) ?? null,
    dpoChecked: Boolean(r.dpo_checked),
    recordedBy: String(r.recorded_by),
    recordedAt: String(r.recorded_at),
  }));
}

/** Record (or replace) the register entry for a provider. */
export async function recordPrivacyRegister(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<PrivacyRow> {
  assertCan(archetype, "config.manage");
  const input = PrivacyInput.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "idara.privacy.record",
        entityType: "ai_privacy_register",
        summary: `${AI_PROVIDERS[input.providerKey].name}: basis "${input.lawfulBasis}", transfer "${input.transferMechanism}", minimisation ${input.minimisationConfirmed}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.ai_privacy_register set revoked_at = now(), revoked_by = ${ctx.userId}
        where org_id = ${ctx.orgId} and provider_key = ${input.providerKey} and revoked_at is null`);
      await tx.execute(sql`
        insert into public.ai_privacy_register
          (org_id, provider_key, lawful_basis, processor_agreement_ref, transfer_mechanism, retention_note, minimisation_confirmed, ropa_ref, dpo_checked, recorded_by)
        values (${ctx.orgId}, ${input.providerKey}, ${input.lawfulBasis}, ${input.processorAgreementRef}, ${input.transferMechanism},
                ${input.retentionNote ?? null}, ${input.minimisationConfirmed}, ${input.ropaRef ?? null}, ${input.dpoChecked}, ${ctx.userId})`);
      return null;
    },
  );
  const rows = await listPrivacyRegister(ctx);
  return rows.find((r) => r.providerKey === input.providerKey)!;
}

export async function revokePrivacyRegister(
  ctx: Ctx,
  archetype: RoleArchetype,
  providerKey: string,
): Promise<void> {
  assertCan(archetype, "config.manage");
  await command(
    ctx,
    {
      audit: {
        action: "idara.privacy.revoke",
        entityType: "ai_privacy_register",
        summary: "register entry revoked; provider unavailable",
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.ai_privacy_register set revoked_at = now(), revoked_by = ${ctx.userId}
        where org_id = ${ctx.orgId} and provider_key = ${providerKey} and revoked_at is null`);
      return null;
    },
  );
}

// ── self-service policy (narrowing only) ────────────────────────────────────

export const SelfServicePolicyInput = z.object({
  aiEnabledByOrg: z.boolean(),
  restrictedDomains: z
    .array(
      z.enum([
        "hr_payroll",
        "finance",
        "tax",
        "sales",
        "customer_success",
        "documents",
        "operations",
        "project",
        "reporting",
        "administration",
        "executive",
      ]),
    )
    .max(11)
    .default([]),
  perUserDailyCredits: z.number().int().min(0).max(1_000_000).nullable().default(null),
  softWarnPct: z.number().int().min(1).max(100).default(80),
  reason: z.string().trim().max(500).optional(),
});

/** Append a policy version with the organisation's own choices; operator-set fields are copied unchanged. */
export async function setSelfServicePolicy(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "config.manage");
  const input = SelfServicePolicyInput.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "idara.policy.self_service",
        entityType: "ai_entitlement",
        entityId: ctx.orgId,
        summary: `ai ${input.aiEnabledByOrg ? "enabled" : "disabled"} by organisation; restricted ${input.restrictedDomains.join(",") || "none"}`,
      },
    },
    async (tx) => {
      const current = await resolveAiPolicy(tx, ctx);
      const next = (await tx.execute(
        sql`select coalesce(max(version), 0) + 1 as v from public.ai_entitlement where org_id = ${ctx.orgId}`,
      )) as unknown as Array<{ v: number }>;
      await tx.execute(sql`
        insert into public.ai_entitlement
          (org_id, version, mode, monthly_credits, daily_credit_limit, per_user_daily_credits, per_agent_limits, model_allow,
           max_cost_per_request_credits, soft_warn_pct, hard_stop, overage_allowed, restricted_domains, ai_enabled_by_org, reason, set_by, set_by_operator)
        values (${ctx.orgId}, ${Number(next[0]!.v)}, ${current.mode}, ${current.monthlyCredits}, ${current.dailyCreditLimit},
                ${input.perUserDailyCredits}, ${JSON.stringify(current.perAgentLimits)}::jsonb, ${JSON.stringify(current.modelAllow)}::jsonb,
                ${current.maxCostPerRequestCredits}, ${input.softWarnPct}, ${current.hardStop}, ${current.overageAllowed},
                ${JSON.stringify(input.restrictedDomains)}::jsonb, ${input.aiEnabledByOrg}, ${input.reason ?? "organisation self-service"}, ${ctx.userId}, false)`);
      return null;
    },
  );
}
