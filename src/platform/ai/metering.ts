/**
 * H28 — metering (ADR-51): ONE `ai_interaction` row per gateway call,
 * including denials and failures, plus the credit consumption row in the
 * ledger and the billing-grade `usage_event` meter (deduplicated by the
 * interaction id) whenever credits were charged.
 */
import { sql, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { GatewayUsage } from "./adapters/types";
import type { BudgetDecision } from "./budget";
import { periodKeyOf } from "./budget";

export const AI_FEATURES = [
  "agent_run",
  "agent_route",
  "agent_tool",
  "agent_eval",
  "schedule_run",
  "gateway",
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export type InteractionInput = {
  id: string;
  feature: AiFeature;
  purpose: string | null;
  agentId: string | null;
  conversationId: string | null;
  runId: string | null;
  stepNo: number | null;
  provider: string;
  model: string;
  modelVersion: string | null;
  usage: GatewayUsage;
  toolCalls: number;
  providerRequestId: string | null;
  latencyMs: number | null;
  status: "ok" | "failed" | "disabled";
  retryCount: number;
  estCostMicros: bigint | null;
  estCurrency: string | null;
  priceBookId: string | null;
  credits: number;
  rateSource: string | null;
  budgetDecision: BudgetDecision;
  error: string | null;
  validatorVerdict?: "pass" | "fail" | "na";
  subjectType?: string | null;
  subjectId?: string | null;
  extras?: Record<string, unknown>;
};

export async function recordInteraction(
  tx: TenantTx,
  ctx: Ctx,
  row: InteractionInput,
): Promise<void> {
  await tx.execute(sql`
    insert into public.ai_interaction
      (id, org_id, feature, provider, model, input_tokens, output_tokens, credits, cost_micros, validator_verdict,
       status, subject_type, subject_id, created_by, agent_id, conversation_id, run_id, step_no, model_version,
       cache_read_tokens, cache_write_tokens, reasoning_tokens, tool_calls, extras, provider_request_id, latency_ms,
       retry_count, est_cost_micros, est_currency, price_book_id, rate_source, budget_decision, purpose, error)
    values
      (${row.id}, ${ctx.orgId}, ${row.feature}, ${row.provider.slice(0, 40)}, ${row.model.slice(0, 80)},
       ${row.usage.input}, ${row.usage.output}, ${row.credits},
       ${row.estCostMicros === null ? null : row.estCostMicros.toString()}::bigint,
       ${row.validatorVerdict ?? "na"}, ${row.status}, ${row.subjectType ?? null}, ${row.subjectId ?? null}, ${ctx.userId},
       ${row.agentId}, ${row.conversationId}, ${row.runId}, ${row.stepNo}, ${row.modelVersion?.slice(0, 120) ?? null},
       ${row.usage.cacheRead}, ${row.usage.cacheWrite}, ${row.usage.reasoning}, ${row.toolCalls},
       ${JSON.stringify(row.extras ?? {})}::jsonb, ${row.providerRequestId?.slice(0, 200) ?? null}, ${row.latencyMs},
       ${row.retryCount}, ${row.estCostMicros === null ? null : row.estCostMicros.toString()}::bigint,
       ${row.estCurrency}, ${row.priceBookId}, ${row.rateSource}, ${row.budgetDecision}, ${row.purpose?.slice(0, 60) ?? null},
       ${row.error?.slice(0, 1000) ?? null})`);
  if (row.credits > 0) {
    const period = periodKeyOf();
    await tx.execute(sql`
      insert into public.ai_credit_ledger (org_id, kind, credits, period_key, ref_type, ref_id, note, created_by)
      values (${ctx.orgId}, 'consumption', ${-row.credits}, ${period}, 'ai_interaction', ${row.id},
              ${`${row.feature}${row.agentId ? " " + row.agentId : ""}`}, ${ctx.userId})`);
    await tx.execute(sql`
      insert into public.usage_event (org_id, meter_key, period_key, dedup_key, delta)
      values (${ctx.orgId}, 'ai_credits', ${period}, ${"ai_interaction:" + row.id}, ${row.credits})
      on conflict (org_id, meter_key, dedup_key) do nothing`);
  }
}

export type UsageRow = {
  id: string;
  createdAt: string;
  feature: string;
  purpose: string | null;
  agentId: string | null;
  provider: string | null;
  model: string | null;
  status: string;
  budgetDecision: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  credits: number;
  estCostMicros: string | null;
  estCurrency: string | null;
  latencyMs: number | null;
  retryCount: number;
  runId: string | null;
  conversationId: string | null;
  createdBy: string | null;
  error: string | null;
};

/** Organisation usage rows, paged in the database (bounded page, total over the full filter). */
export async function listUsage(
  tx: TenantTx,
  ctx: Ctx,
  q: {
    from?: Date;
    to?: Date;
    agentId?: string | null;
    userId?: string | null;
    limit: number;
    offset: number;
  },
): Promise<{
  rows: UsageRow[];
  total: number;
  totals: { credits: number; requests: number; failed: number };
}> {
  const limit = Math.min(Math.max(q.limit, 1), 200);
  const offset = Math.max(q.offset, 0);
  const from = q.from ?? new Date(Date.now() - 30 * 86_400_000);
  const to = q.to ?? new Date();
  const where = sql`i.org_id = ${ctx.orgId} and i.created_at >= ${from.toISOString()}::timestamptz and i.created_at < ${to.toISOString()}::timestamptz
    and (${q.agentId ?? null}::text is null or i.agent_id = ${q.agentId ?? null})
    and (${q.userId ?? null}::uuid is null or i.created_by = ${q.userId ?? null}::uuid)`;
  const rows = (await tx.execute(sql`
    select i.id::text as id, i.created_at::text as created_at, i.feature, i.purpose, i.agent_id, i.provider, i.model, i.status,
           i.budget_decision, i.input_tokens, i.output_tokens, i.cache_read_tokens, i.reasoning_tokens, i.credits,
           i.est_cost_micros::text as est_cost_micros, i.est_currency, i.latency_ms, i.retry_count,
           i.run_id::text as run_id, i.conversation_id::text as conversation_id, i.created_by::text as created_by, i.error
    from public.ai_interaction i where ${where}
    order by i.created_at desc limit ${limit} offset ${offset}`)) as unknown as Array<
    Record<string, unknown>
  >;
  const agg = (await tx.execute(sql`
    select count(*)::int as total, coalesce(sum(i.credits), 0)::int as credits,
           count(*) filter (where i.status = 'failed')::int as failed
    from public.ai_interaction i where ${where}`)) as unknown as Array<{
    total: number;
    credits: number;
    failed: number;
  }>;
  return {
    rows: rows.map((r) => ({
      id: String(r.id),
      createdAt: String(r.created_at),
      feature: String(r.feature),
      purpose: (r.purpose as string | null) ?? null,
      agentId: (r.agent_id as string | null) ?? null,
      provider: (r.provider as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      status: String(r.status),
      budgetDecision: String(r.budget_decision),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      reasoningTokens: Number(r.reasoning_tokens),
      credits: Number(r.credits),
      estCostMicros: (r.est_cost_micros as string | null) ?? null,
      estCurrency: (r.est_currency as string | null) ?? null,
      latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
      retryCount: Number(r.retry_count),
      runId: (r.run_id as string | null) ?? null,
      conversationId: (r.conversation_id as string | null) ?? null,
      createdBy: (r.created_by as string | null) ?? null,
      error: (r.error as string | null) ?? null,
    })),
    total: Number(agg[0]?.total ?? 0),
    totals: {
      credits: Number(agg[0]?.credits ?? 0),
      requests: Number(agg[0]?.total ?? 0),
      failed: Number(agg[0]?.failed ?? 0),
    },
  };
}
