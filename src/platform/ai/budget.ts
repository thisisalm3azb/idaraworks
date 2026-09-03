/**
 * H28 — organisation AI policy, allowance and the budget decision (ADR-54).
 *
 * The decision is a PURE function over facts read beforehand so it is
 * unit-testable and its order is explicit: global stop → provider, model and
 * agent switches → organisation policy and limits → allowance → platform
 * daily breaker. Every decision is recorded on the usage row by the gateway.
 */
import { getLimit } from "@/platform/entitlements";
import { sql, type Ctx, type TenantTx } from "@/platform/tenancy";

export const AI_MODES = ["disabled", "trial", "included", "prepaid", "enterprise", "byok"] as const;
export type AiMode = (typeof AI_MODES)[number];

export type AiPolicy = {
  id: string | null;
  version: number;
  mode: AiMode;
  monthlyCredits: number | null;
  dailyCreditLimit: number | null;
  perUserDailyCredits: number | null;
  perAgentLimits: Record<string, number>;
  modelAllow: string[];
  maxCostPerRequestCredits: number | null;
  softWarnPct: number;
  hardStop: boolean;
  overageAllowed: boolean;
  restrictedDomains: string[];
  aiEnabledByOrg: boolean;
  reason: string | null;
  effectiveFrom: string | null;
};

export const DEFAULT_POLICY: AiPolicy = {
  id: null,
  version: 0,
  mode: "disabled",
  monthlyCredits: null,
  dailyCreditLimit: null,
  perUserDailyCredits: null,
  perAgentLimits: {},
  modelAllow: [],
  maxCostPerRequestCredits: null,
  softWarnPct: 80,
  hardStop: true,
  overageAllowed: false,
  restrictedDomains: [],
  aiEnabledByOrg: true,
  reason: null,
  effectiveFrom: null,
};

function asJson(v: unknown): unknown {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** The latest effective policy version for the organisation (default: disabled). */
export async function resolveAiPolicy(
  tx: TenantTx,
  ctx: Ctx,
  at: Date = new Date(),
): Promise<AiPolicy> {
  const rows = (await tx.execute(sql`
    select id::text as id, version, mode, monthly_credits, daily_credit_limit, per_user_daily_credits,
           per_agent_limits, model_allow, max_cost_per_request_credits, soft_warn_pct, hard_stop,
           overage_allowed, restricted_domains, ai_enabled_by_org, reason, effective_from::text as effective_from
    from public.ai_entitlement
    where org_id = ${ctx.orgId} and effective_from <= ${at.toISOString()}::timestamptz
      and (effective_to is null or effective_to > ${at.toISOString()}::timestamptz)
    order by version desc limit 1`)) as unknown as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return DEFAULT_POLICY;
  const agentLimits = (asJson(r.per_agent_limits) ?? {}) as Record<string, unknown>;
  const modelAllow = asJson(r.model_allow);
  const restricted = asJson(r.restricted_domains);
  return {
    id: String(r.id),
    version: Number(r.version),
    mode: String(r.mode) as AiMode,
    monthlyCredits: numOrNull(r.monthly_credits),
    dailyCreditLimit: numOrNull(r.daily_credit_limit),
    perUserDailyCredits: numOrNull(r.per_user_daily_credits),
    perAgentLimits: Object.fromEntries(Object.entries(agentLimits).map(([k, v]) => [k, Number(v)])),
    modelAllow: Array.isArray(modelAllow) ? (modelAllow as unknown[]).map(String) : [],
    maxCostPerRequestCredits: numOrNull(r.max_cost_per_request_credits),
    softWarnPct: Number(r.soft_warn_pct ?? 80),
    hardStop: Boolean(r.hard_stop),
    overageAllowed: Boolean(r.overage_allowed),
    restrictedDomains: Array.isArray(restricted) ? (restricted as unknown[]).map(String) : [],
    aiEnabledByOrg: Boolean(r.ai_enabled_by_org),
    reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
    effectiveFrom: String(r.effective_from),
  };
}

export type AllowanceStatus = {
  periodKey: string;
  /** Plan allowance (limit.ai_credits_month with add-ons and overrides); null = unlimited. */
  planCredits: number | null;
  /** Ledger grants (packs, manual, adjustments, refunds, expiry) for the period. */
  ledgerCredits: number;
  /** Effective allowance; null = unlimited. */
  allowance: number | null;
  consumed: number;
  remaining: number | null;
  usedPct: number | null;
  todayOrg: number;
  todayUser: number;
  monthByAgent: Record<string, number>;
};

export function periodKeyOf(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7);
}

/** Allowance and consumption facts for the current period, computed in the database (full result, never paged). */
export async function allowanceStatus(
  tx: TenantTx,
  ctx: Ctx,
  policy: AiPolicy,
  now: Date = new Date(),
): Promise<AllowanceStatus> {
  const periodKey = periodKeyOf(now);
  const planLimit = policy.monthlyCredits ?? (await getLimit(ctx, "limit.ai_credits_month"));
  const ledger = (await tx.execute(sql`
    select coalesce(sum(credits), 0)::int as n from public.ai_credit_ledger
    where org_id = ${ctx.orgId} and period_key = ${periodKey} and kind <> 'consumption'`)) as unknown as Array<{
    n: number;
  }>;
  const consumed = (await tx.execute(sql`
    select coalesce(sum(credits), 0)::int as n from public.ai_interaction
    where org_id = ${ctx.orgId} and created_at >= date_trunc('month', ${now.toISOString()}::timestamptz)`)) as unknown as Array<{
    n: number;
  }>;
  const today = (await tx.execute(sql`
    select coalesce(sum(credits), 0)::int as org_n,
           coalesce(sum(credits) filter (where created_by = ${ctx.userId}), 0)::int as user_n
    from public.ai_interaction
    where org_id = ${ctx.orgId} and created_at >= date_trunc('day', ${now.toISOString()}::timestamptz)`)) as unknown as Array<{
    org_n: number;
    user_n: number;
  }>;
  const byAgent = (await tx.execute(sql`
    select agent_id, coalesce(sum(credits), 0)::int as n from public.ai_interaction
    where org_id = ${ctx.orgId} and agent_id is not null
      and created_at >= date_trunc('month', ${now.toISOString()}::timestamptz)
    group by agent_id`)) as unknown as Array<{ agent_id: string; n: number }>;
  const ledgerCredits = Number(ledger[0]?.n ?? 0);
  const allowance = planLimit === null ? null : Math.max(0, Number(planLimit) + ledgerCredits);
  const used = Number(consumed[0]?.n ?? 0);
  return {
    periodKey,
    planCredits: planLimit === null ? null : Number(planLimit),
    ledgerCredits,
    allowance,
    consumed: used,
    remaining: allowance === null ? null : Math.max(0, allowance - used),
    usedPct:
      allowance === null || allowance === 0
        ? null
        : Math.min(999, Math.round((used / allowance) * 100)),
    todayOrg: Number(today[0]?.org_n ?? 0),
    todayUser: Number(today[0]?.user_n ?? 0),
    monthByAgent: Object.fromEntries(byAgent.map((r) => [r.agent_id, Number(r.n)])),
  };
}

export type SwitchState = {
  globalStop: boolean;
  orgStop: boolean;
  agentStop: boolean;
  providerStop: boolean;
  modelStop: boolean;
};

export async function readSwitches(
  tx: TenantTx,
  orgId: string,
  agentId: string,
  providerKey: string,
  modelKey: string,
): Promise<SwitchState> {
  const rows = (await tx.execute(sql`
    select scope, scope_key from public.ai_kill_switch where active
      and ((scope = 'global') or (scope = 'org' and scope_key = ${orgId}) or (scope = 'agent' and scope_key = ${agentId})
        or (scope = 'provider' and scope_key = ${providerKey}) or (scope = 'model' and scope_key = ${modelKey}))`)) as unknown as Array<{
    scope: string;
    scope_key: string;
  }>;
  const has = (scope: string) => rows.some((r) => r.scope === scope);
  return {
    globalStop: has("global"),
    orgStop: has("org"),
    agentStop: has("agent"),
    providerStop: has("provider"),
    modelStop: has("model"),
  };
}

export type BudgetDecision = "allow" | "warn" | "deny" | "stopped" | "breaker";

export type BudgetReason =
  | "ok"
  | "soft_warning"
  | "global_stop"
  | "org_stop"
  | "agent_stop"
  | "provider_stop"
  | "model_stop"
  | "provider_disabled"
  | "model_disabled"
  | "breaker_open"
  | "org_ai_disabled"
  | "org_mode_disabled"
  | "agent_disabled"
  | "domain_restricted"
  | "model_not_allowed"
  | "request_cost_cap"
  | "daily_limit"
  | "user_daily_limit"
  | "agent_limit"
  | "allowance_exhausted"
  | "platform_breaker";

export type BudgetFacts = {
  switches: SwitchState;
  providerEnabled: boolean;
  modelEnabled: boolean;
  breakerOpen: boolean;
  policy: AiPolicy;
  agentEnabled: boolean;
  agentDomain: string;
  modelKey: string;
  allowance: AllowanceStatus;
  agentId: string;
  estimatedCredits: number;
  platformDailySpendMicros: bigint;
  platformDailyCapMicros: bigint;
};

export type BudgetVerdict = { decision: BudgetDecision; reason: BudgetReason };

/** The one ordered decision (ADR-54). Pure. */
export function decideBudget(f: BudgetFacts): BudgetVerdict {
  if (f.switches.globalStop) return { decision: "stopped", reason: "global_stop" };
  if (f.switches.orgStop) return { decision: "stopped", reason: "org_stop" };
  if (f.switches.providerStop) return { decision: "stopped", reason: "provider_stop" };
  if (f.switches.modelStop) return { decision: "stopped", reason: "model_stop" };
  if (f.switches.agentStop) return { decision: "stopped", reason: "agent_stop" };
  if (!f.providerEnabled) return { decision: "deny", reason: "provider_disabled" };
  if (!f.modelEnabled) return { decision: "deny", reason: "model_disabled" };
  if (f.breakerOpen) return { decision: "breaker", reason: "breaker_open" };
  const p = f.policy;
  if (!p.aiEnabledByOrg) return { decision: "deny", reason: "org_ai_disabled" };
  if (p.mode === "disabled") return { decision: "deny", reason: "org_mode_disabled" };
  if (!f.agentEnabled) return { decision: "deny", reason: "agent_disabled" };
  if (p.restrictedDomains.includes(f.agentDomain))
    return { decision: "deny", reason: "domain_restricted" };
  if (p.modelAllow.length > 0 && !p.modelAllow.includes(f.modelKey))
    return { decision: "deny", reason: "model_not_allowed" };
  if (p.maxCostPerRequestCredits !== null && f.estimatedCredits > p.maxCostPerRequestCredits) {
    return { decision: "deny", reason: "request_cost_cap" };
  }
  const a = f.allowance;
  if (p.dailyCreditLimit !== null && a.todayOrg + f.estimatedCredits > p.dailyCreditLimit) {
    return { decision: "deny", reason: "daily_limit" };
  }
  if (p.perUserDailyCredits !== null && a.todayUser + f.estimatedCredits > p.perUserDailyCredits) {
    return { decision: "deny", reason: "user_daily_limit" };
  }
  const agentCap = p.perAgentLimits[f.agentId];
  if (agentCap !== undefined && (a.monthByAgent[f.agentId] ?? 0) + f.estimatedCredits > agentCap) {
    return { decision: "deny", reason: "agent_limit" };
  }
  if (f.platformDailySpendMicros >= f.platformDailyCapMicros)
    return { decision: "breaker", reason: "platform_breaker" };
  if (a.allowance !== null) {
    const after = a.consumed + f.estimatedCredits;
    if (after > a.allowance) {
      if (p.hardStop && !p.overageAllowed)
        return { decision: "deny", reason: "allowance_exhausted" };
      return { decision: "warn", reason: "allowance_exhausted" };
    }
    if (a.allowance > 0 && (after / a.allowance) * 100 >= p.softWarnPct)
      return { decision: "warn", reason: "soft_warning" };
  }
  return { decision: "allow", reason: "ok" };
}

/** Human-readable owner action for each non-allow reason (English source text; UI translates by key). */
export const BUDGET_REASON_KEY: Record<BudgetReason, string> = {
  ok: "idara.budget.ok",
  soft_warning: "idara.budget.soft_warning",
  global_stop: "idara.budget.global_stop",
  org_stop: "idara.budget.org_stop",
  agent_stop: "idara.budget.agent_stop",
  provider_stop: "idara.budget.provider_stop",
  model_stop: "idara.budget.model_stop",
  provider_disabled: "idara.budget.provider_disabled",
  model_disabled: "idara.budget.model_disabled",
  breaker_open: "idara.budget.breaker_open",
  org_ai_disabled: "idara.budget.org_ai_disabled",
  org_mode_disabled: "idara.budget.org_mode_disabled",
  agent_disabled: "idara.budget.agent_disabled",
  domain_restricted: "idara.budget.domain_restricted",
  model_not_allowed: "idara.budget.model_not_allowed",
  request_cost_cap: "idara.budget.request_cost_cap",
  daily_limit: "idara.budget.daily_limit",
  user_daily_limit: "idara.budget.user_daily_limit",
  agent_limit: "idara.budget.agent_limit",
  allowance_exhausted: "idara.budget.allowance_exhausted",
  platform_breaker: "idara.budget.platform_breaker",
};
