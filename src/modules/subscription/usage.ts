/**
 * Billing-grade usage metering (S9; append-only usage_event, 0054). Org-scoped, IDEMPOTENT (a
 * unique (org, meter, dedup_key) — a duplicate delivery inserts nothing), CONCURRENCY-SAFE
 * (distinct dedup keys never conflict; identical ones collapse), PERIOD-AWARE (period_key buckets),
 * and RECONCILABLE (the current value is sum(delta) over the log; corrections are negative rows,
 * never edits). checkMeteredLimit reads the metered value and compares to the resolved plan limit —
 * governing the ability to ADD, never to read (FR-9).
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { getLimit } from "@/platform/entitlements/resolve";
import type { LimitKey } from "@/platform/entitlements/catalogue";

/** The month bucket for a metering timestamp (UTC — the meter is timezone-safe by pinning to UTC). */
export function monthPeriodKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7); // 'YYYY-MM'
}

/**
 * Record a metered usage delta. Idempotent per (org, meter, dedupKey): re-delivering the same event
 * is a no-op. Returns whether a NEW row was written. The tenant may only meter its own org (RLS).
 */
export async function recordUsage(
  ctx: Ctx,
  meterKey: string,
  dedupKey: string,
  delta: number,
  periodKey: string,
): Promise<{ recorded: boolean }> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into public.usage_event (org_id, meter_key, period_key, dedup_key, delta)
      values (${ctx.orgId}, ${meterKey}, ${periodKey}, ${dedupKey}, ${delta})
      on conflict (org_id, meter_key, dedup_key) do nothing
      returning id`)) as unknown as Array<{ id: string }>;
    return { recorded: rows.length > 0 };
  });
}

/** Current metered value for (org, meter, period) — the sum of the append-only deltas. */
export async function getUsage(ctx: Ctx, meterKey: string, periodKey: string): Promise<number> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select coalesce(sum(delta), 0)::bigint as total from public.usage_event
      where org_id = ${ctx.orgId} and meter_key = ${meterKey} and period_key = ${periodKey}`)) as unknown as Array<{
      total: string;
    }>;
    return Number(rows[0]?.total ?? 0);
  });
}

export type MeteredLimitCheck = {
  allowed: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
};

/**
 * Is there metered room to add `amount` more this period against `limitKey`? Unlimited (null) is
 * always allowed. Governs ADD only — a reader is never blocked (FR-9).
 */
export async function checkMeteredLimit(
  ctx: Ctx,
  limitKey: LimitKey,
  meterKey: string,
  periodKey: string,
  amount = 1,
): Promise<MeteredLimitCheck> {
  const limit = await getLimit(ctx, limitKey);
  const used = await getUsage(ctx, meterKey, periodKey);
  if (limit === null) return { allowed: true, limit: null, used, remaining: null };
  return { allowed: used + amount <= limit, limit, used, remaining: Math.max(0, limit - used) };
}
