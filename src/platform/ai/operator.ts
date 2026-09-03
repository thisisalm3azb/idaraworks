/**
 * H28 — the platform operator surface (ADR-55): IdaraWorks-owner reads and
 * controls across organisations.
 *
 * Operator reads run in a USER context with NO organisation (withUserCtx), so
 * an org-scoped session can never reach them, and every function is a
 * security-definer that asserts `app.assert_platform_operator()` first. Every
 * summary number drills down to the usage rows behind it. Kill switches,
 * entitlement changes and credit grants are audited in `platform_audit` with
 * the operator's identity.
 */
import { sql, withUserCtx } from "@/platform/tenancy";
import { AI_MODELS, AI_PROVIDERS, type AiModelKey, type AiProviderKey } from "./registry";

export class NotOperatorError extends Error {
  constructor() {
    super("platform operator only");
  }
}

async function asOperator<T>(
  userId: string,
  fn: (tx: Parameters<Parameters<typeof withUserCtx>[1]>[0]) => Promise<T>,
): Promise<T> {
  try {
    return await withUserCtx(userId, fn);
  } catch (e) {
    if (/platform operator only/.test(String((e as Error).message))) throw new NotOperatorError();
    throw e;
  }
}

export async function isPlatformOperator(userId: string): Promise<boolean> {
  const rows = (await withUserCtx(userId, (tx) =>
    tx.execute(sql`select app.is_platform_operator() as ok`),
  )) as unknown as Array<{ ok: boolean }>;
  return Boolean(rows[0]?.ok);
}

export type OperatorUsageRow = {
  orgId: string;
  orgName: string;
  agentId: string | null;
  provider: string | null;
  model: string | null;
  requests: number;
  failed: number;
  retried: number;
  denied: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  estCostMicros: string;
  actualCostMicros: string;
  credits: number;
};

export async function operatorUsage(
  userId: string,
  from: Date,
  to: Date,
): Promise<OperatorUsageRow[]> {
  const rows = (await asOperator(userId, (tx) =>
    tx.execute(sql`
      select org_id::text as org_id, org_name, agent_id, provider, model, requests::int as requests, failed::int as failed,
             retried::int as retried, denied::int as denied, input_tokens::text as input_tokens, output_tokens::text as output_tokens,
             cache_read_tokens::text as cache_read_tokens, reasoning_tokens::text as reasoning_tokens,
             est_cost_micros::text as est_cost_micros, actual_cost_micros::text as actual_cost_micros, credits::int as credits
      from app.ai_platform_usage(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz)`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    orgId: String(r.org_id),
    orgName: String(r.org_name),
    agentId: (r.agent_id as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    requests: Number(r.requests),
    failed: Number(r.failed),
    retried: Number(r.retried),
    denied: Number(r.denied),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    reasoningTokens: Number(r.reasoning_tokens),
    estCostMicros: String(r.est_cost_micros),
    actualCostMicros: String(r.actual_cost_micros),
    credits: Number(r.credits),
  }));
}

/** Drill-down: the individual usage rows behind any summary number. */
export async function operatorUsageRows(
  userId: string,
  q: { orgId?: string | null; from: Date; to: Date; limit?: number; offset?: number },
): Promise<Array<Record<string, unknown>>> {
  return asOperator(
    userId,
    async (tx) =>
      (await tx.execute(sql`
      select * from app.ai_platform_usage_rows(${q.orgId ?? null}::uuid, ${q.from.toISOString()}::timestamptz, ${q.to.toISOString()}::timestamptz,
                                               ${q.limit ?? 100}, ${q.offset ?? 0})`)) as unknown as Array<
        Record<string, unknown>
      >,
  );
}

export type OperatorOrgRow = {
  orgId: string;
  orgName: string;
  mode: string | null;
  aiEnabledByOrg: boolean | null;
  policyVersion: number | null;
  byokProviders: string[];
  privacyProviders: string[];
};

export async function operatorOrgs(userId: string): Promise<OperatorOrgRow[]> {
  const rows = (await asOperator(userId, (tx) =>
    tx.execute(sql`select * from app.ai_platform_orgs()`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    orgId: String(r.org_id),
    orgName: String(r.org_name),
    mode: (r.mode as string | null) ?? null,
    aiEnabledByOrg:
      r.ai_enabled_by_org === null || r.ai_enabled_by_org === undefined
        ? null
        : Boolean(r.ai_enabled_by_org),
    policyVersion:
      r.policy_version === null || r.policy_version === undefined ? null : Number(r.policy_version),
    byokProviders: Array.isArray(r.byok_providers)
      ? (r.byok_providers as unknown[]).map(String)
      : [],
    privacyProviders: Array.isArray(r.privacy_providers)
      ? (r.privacy_providers as unknown[]).map(String)
      : [],
  }));
}

export type SwitchRow = {
  id: string;
  scope: string;
  scopeKey: string;
  reason: string | null;
  setAt: string;
};

export async function operatorSwitches(userId: string): Promise<SwitchRow[]> {
  const rows = (await asOperator(userId, (tx) =>
    tx.execute(sql`
      select id::text as id, scope, scope_key, reason, set_at::text as set_at from public.ai_kill_switch where active order by set_at desc limit 100`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    scope: String(r.scope),
    scopeKey: String(r.scope_key),
    reason: (r.reason as string | null) ?? null,
    setAt: String(r.set_at),
  }));
}

export async function operatorProviderHealth(userId: string): Promise<
  Array<{
    providerKey: string;
    enabled: boolean;
    health: string;
    consecutiveFailures: number;
    breakerOpenUntil: string | null;
    lastError: string | null;
  }>
> {
  const rows = (await asOperator(userId, (tx) =>
    tx.execute(sql`
      select provider_key, enabled, health, consecutive_failures, breaker_open_until::text as breaker_open_until, last_error
      from public.ai_provider_state order by provider_key`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    providerKey: String(r.provider_key),
    enabled: Boolean(r.enabled),
    health: String(r.health),
    consecutiveFailures: Number(r.consecutive_failures),
    breakerOpenUntil: (r.breaker_open_until as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
  }));
}

// ── controls (audited in platform_audit by the definer functions) ───────────

export async function setKillSwitch(
  userId: string,
  scope: "global" | "org" | "agent" | "provider" | "model",
  scopeKey: string,
  active: boolean,
  reason: string,
): Promise<void> {
  await asOperator(userId, async (tx) => {
    await tx.execute(
      sql`select app.ai_kill_switch_set(${scope}, ${scopeKey}, ${active}, ${reason})`,
    );
    return null;
  });
}

export async function setProviderEnabled(
  userId: string,
  providerKey: AiProviderKey,
  enabled: boolean,
  reason: string,
): Promise<void> {
  await asOperator(userId, async (tx) => {
    await tx.execute(
      sql`select app.ai_provider_set_enabled(${providerKey}, ${enabled}, ${reason})`,
    );
    return null;
  });
}

export async function setModelEnabled(
  userId: string,
  modelKey: AiModelKey,
  enabled: boolean,
  reason: string,
): Promise<void> {
  await asOperator(userId, async (tx) => {
    await tx.execute(sql`select app.ai_model_set_enabled(${modelKey}, ${enabled}, ${reason})`);
    return null;
  });
}

export async function addPriceBookRow(
  userId: string,
  row: {
    providerKey: AiProviderKey;
    modelKey: AiModelKey;
    effectiveFrom: Date;
    currency: string;
    inputPerMtokMicros: number;
    outputPerMtokMicros: number;
    cacheReadPerMtokMicros?: number | null;
    cacheWritePerMtokMicros?: number | null;
    reasoningPerMtokMicros?: number | null;
    sourceUrl: string;
    note?: string;
  },
): Promise<string> {
  const rows = (await asOperator(userId, (tx) =>
    tx.execute(sql`
      select app.ai_price_book_add(${row.providerKey}, ${row.modelKey}, ${row.effectiveFrom.toISOString()}::timestamptz, ${row.currency},
        ${row.inputPerMtokMicros}, ${row.outputPerMtokMicros}, ${row.cacheReadPerMtokMicros ?? null}, ${row.cacheWritePerMtokMicros ?? null},
        ${row.reasoningPerMtokMicros ?? null}, ${row.sourceUrl}, ${row.note ?? null})::text as id`),
  )) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

export async function setOrgAiPolicy(
  userId: string,
  orgId: string,
  policy: Record<string, unknown>,
  reason: string,
): Promise<string> {
  const rows = (await asOperator(userId, (tx) =>
    tx.execute(
      sql`select app.ai_entitlement_set(${orgId}::uuid, ${JSON.stringify(policy)}::jsonb, ${reason})::text as id`,
    ),
  )) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

export async function grantCredits(
  userId: string,
  orgId: string,
  credits: number,
  kind: "pack" | "manual" | "allowance_adjust" | "refund" | "expiry",
  periodKey: string,
  note: string,
): Promise<string> {
  const rows = (await asOperator(userId, (tx) =>
    tx.execute(
      sql`select app.ai_credit_grant(${orgId}::uuid, ${credits}, ${kind}, ${periodKey}, ${note})::text as id`,
    ),
  )) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

export async function operatorAudit(
  userId: string,
  limit = 50,
): Promise<
  Array<{
    id: string;
    actorUserId: string;
    action: string;
    scope: string | null;
    scopeKey: string | null;
    summary: string;
    createdAt: string;
  }>
> {
  const rows = (await asOperator(userId, (tx) =>
    tx.execute(sql`
      select id::text as id, actor_user_id::text as actor_user_id, action, scope, scope_key, summary, created_at::text as created_at
      from public.platform_audit order by created_at desc limit ${Math.min(Math.max(limit, 1), 200)}`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    actorUserId: String(r.actor_user_id),
    action: String(r.action),
    scope: (r.scope as string | null) ?? null,
    scopeKey: (r.scope_key as string | null) ?? null,
    summary: String(r.summary),
    createdAt: String(r.created_at),
  }));
}

// ── economics ───────────────────────────────────────────────────────────────

export type Economics = {
  from: string;
  to: string;
  organisations: number;
  requests: number;
  failed: number;
  denied: number;
  credits: number;
  estCostMicros: bigint;
  actualCostMicros: bigint;
  /** Revenue is 0 until charging is enabled; margin is therefore not claimed. */
  revenueMinor: number | null;
  marginPct: number | null;
  forecastMonthEndMicros: bigint;
  byOrg: OperatorUsageRow[];
  byAgent: Array<{ agentId: string; requests: number; credits: number; estCostMicros: string }>;
  byModel: Array<{ model: string; requests: number; credits: number; estCostMicros: string }>;
  heaviest: OperatorUsageRow[];
};

export async function operatorEconomics(
  userId: string,
  from: Date,
  to: Date,
  now: Date = new Date(),
): Promise<Economics> {
  const rows = await operatorUsage(userId, from, to);
  const sum = (f: (r: OperatorUsageRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  const bigSum = (f: (r: OperatorUsageRow) => string) =>
    rows.reduce((n, r) => n + BigInt(f(r) || "0"), 0n);
  const group = <K extends string>(key: (r: OperatorUsageRow) => K) => {
    const m = new Map<K, { requests: number; credits: number; est: bigint }>();
    for (const r of rows) {
      const k = key(r);
      const e = m.get(k) ?? { requests: 0, credits: 0, est: 0n };
      e.requests += r.requests;
      e.credits += r.credits;
      e.est += BigInt(r.estCostMicros || "0");
      m.set(k, e);
    }
    return m;
  };
  const est = bigSum((r) => r.estCostMicros);
  const daysElapsed = Math.max(1, Math.ceil((now.getTime() - from.getTime()) / 86_400_000));
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const forecast = (est * BigInt(daysInMonth)) / BigInt(daysElapsed);
  const byAgent = [...group((r) => (r.agentId ?? "none") as string)].map(([agentId, v]) => ({
    agentId,
    requests: v.requests,
    credits: v.credits,
    estCostMicros: v.est.toString(),
  }));
  const byModel = [...group((r) => (r.model ?? "none") as string)].map(([model, v]) => ({
    model,
    requests: v.requests,
    credits: v.credits,
    estCostMicros: v.est.toString(),
  }));
  const heaviest = [...rows]
    .sort((a, b) => Number(BigInt(b.estCostMicros || "0") - BigInt(a.estCostMicros || "0")))
    .slice(0, 10);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    organisations: new Set(rows.map((r) => r.orgId)).size,
    requests: sum((r) => r.requests),
    failed: sum((r) => r.failed),
    denied: sum((r) => r.denied),
    credits: sum((r) => r.credits),
    estCostMicros: est,
    actualCostMicros: bigSum((r) => r.actualCostMicros),
    revenueMinor: null,
    marginPct: null,
    forecastMonthEndMicros: forecast,
    byOrg: rows,
    byAgent,
    byModel,
    heaviest,
  };
}

/** Registry facts the operator centre shows next to live state. */
export function registrySnapshot(): { providers: typeof AI_PROVIDERS; models: typeof AI_MODELS } {
  return { providers: AI_PROVIDERS, models: AI_MODELS };
}
