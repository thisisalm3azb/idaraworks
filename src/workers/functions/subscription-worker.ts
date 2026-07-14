/**
 * S9 lifecycle workers (platform, no tenant context — so they can call the
 * assert_platform_task-guarded DEFINER path). Three directly-invokable functions (also wired to a
 * daily cron that stays dormant in production until Inngest is provisioned):
 *
 *  • sweepLifecycle  — the passive, deadline-driven engine: expire trials, walk the dunning ladder
 *    when a window elapses, and schedule/execute purge (legal-hold-guarded by the DB). Also records
 *    dunning reminders while an org is in past_due/grace.
 *  • runReconciliation — compare each org's LOCAL subscription state to the provider's view and
 *    record drift (never auto-overwrite governed local state — surface it for an operator).
 *
 * Everything routes through the sole-writer `applyTransition`, so the state machine + audit + cache
 * invalidation are identical to the webhook path.
 */
import { createAppDb, sql } from "@/platform/tenancy";
import { getBillingProvider } from "@/platform/billing/adapter";
// Import the subscription module ONLY via its service.ts (which re-exports the machine/windows
// surface) — modules talk to other modules through service.ts, never internal files (§3.3).
import {
  applyTransition,
  nextForEvent,
  dueSignal,
  LIFECYCLE_WINDOWS,
  type LifecycleRow,
} from "@/modules/subscription/service";
import { inngest } from "@/platform/events";
import { cron } from "inngest";
import { logger } from "@/platform/logger";

type ScanRow = LifecycleRow & { org_id: string };

export type SweepResult = { scanned: number; transitioned: number; dunned: number };

/** Run the deadline-driven lifecycle for every org whose window has passed. Idempotent + per-org
 * fault-isolated (one org's error — e.g. a legal-hold purge refusal — never aborts the sweep). */
export async function sweepLifecycle(nowMs: number): Promise<SweepResult> {
  const { db, end } = createAppDb({ max: 1 });
  let transitioned = 0;
  let dunned = 0;
  try {
    const rows = (await db.execute(sql`
      select org_id::text as org_id, billing_state, period_start::text as period_start,
             trial_end::text as trial_end, grace_until::text as grace_until,
             suspend_at::text as suspend_at, purge_at::text as purge_at
      from app.lifecycle_scan()`)) as unknown as ScanRow[];
    for (const row of rows) {
      // Dunning reminders while dunning is active (records + tenant-visible; email is the disabled seam).
      if (row.billing_state === "past_due" || row.billing_state === "grace") {
        if (await recordDunning(db, row, nowMs)) dunned++;
      }
      // Deadline-driven transition.
      const signal = dueSignal(row, nowMs);
      if (!signal) continue;
      const res = nextForEvent(row.billing_state, signal);
      if (res.to === null) continue;
      try {
        await applyTransition(db, row.org_id, row.billing_state, res.to, res.reason, nowMs, {
          eventType: `lifecycle.${signal}`,
        });
        transitioned++;
      } catch (err) {
        // e.g. legal-hold purge refusal — log + carry on (the finding is worth surfacing).
        logger.warn(
          { orgId: row.org_id, to: res.to, err: (err as Error).message },
          "lifecycle transition skipped",
        );
      }
    }
    return { scanned: rows.length, transitioned, dunned };
  } finally {
    await end();
  }
}

/** Record the due dunning reminder for a past_due/grace org (idempotent per attempt). Returns
 * whether a NEW reminder was recorded this run. Reminders at ~0% / 50% / 90% of the dunning window. */
async function recordDunning(
  db: ReturnType<typeof createAppDb>["db"],
  row: ScanRow,
  nowMs: number,
): Promise<boolean> {
  if (!row.grace_until) return false;
  const cycleKey = row.grace_until.slice(0, 19); // the dunning cycle id (past_due entry → grace deadline)
  const windowMs = LIFECYCLE_WINDOWS.dunningDays * 86_400_000;
  const start = Date.parse(row.grace_until) - windowMs;
  const frac = windowMs > 0 ? (nowMs - start) / windowMs : 1;
  const attempt = frac >= 0.9 ? 3 : frac >= 0.5 ? 2 : 1;
  const r = (await db.execute(sql`
    select app.record_dunning_attempt(${row.org_id}::uuid, ${cycleKey}, ${attempt}) as result`)) as unknown as Array<{
    result: string;
  }>;
  if (r[0]?.result === "sent") {
    await db.execute(sql`
      select app.record_platform_audit(${row.org_id}::uuid, null, 'billing.dunning_reminder',
        'subscription', ${row.org_id}::uuid, ${`Payment reminder ${attempt}/3 sent`}, '{}'::jsonb)`);
    return true;
  }
  return false;
}

export type ReconResult = { scanned: number; findings: number };

/** Compare local subscription state to the provider's view; record drift (surface, never overwrite). */
export async function runReconciliation(): Promise<ReconResult> {
  const provider = getBillingProvider();
  const { db, end } = createAppDb({ max: 1 });
  let findings = 0;
  try {
    const rows = (await db.execute(sql`
      select org_id::text as org_id, billing_state, plan_key, provider,
             provider_customer_id, provider_subscription_id
      from app.subscription_recon_scan()`)) as unknown as Array<{
      org_id: string;
      billing_state: string;
      plan_key: string;
      provider: string;
      provider_customer_id: string | null;
      provider_subscription_id: string | null;
    }>;
    for (const row of rows) {
      if (!row.provider_customer_id) continue;
      const remote = await provider.fetchProviderState(row.provider_customer_id);
      let kind: string | null = null;
      let detail: Record<string, unknown> = {};
      if (remote === null) {
        kind = "missing_provider_customer";
        detail = { provider: row.provider, customerId: row.provider_customer_id };
      } else if (remote.billingState !== row.billing_state) {
        // Name the well-known divergences explicitly; else the generic state_divergence.
        kind =
          row.billing_state === "active" && remote.billingState === "cancelled"
            ? "local_active_provider_cancelled"
            : row.billing_state === "cancelled" && remote.billingState === "active"
              ? "local_cancelled_provider_active"
              : "state_divergence";
        detail = { local: row.billing_state, provider: remote.billingState };
      } else if (remote.planKey && remote.planKey !== row.plan_key) {
        kind = "plan_mismatch";
        detail = { local: row.plan_key, provider: remote.planKey };
      }
      if (kind) {
        const r = (await db.execute(sql`
          select app.record_reconciliation(${row.org_id}::uuid, ${kind}, ${JSON.stringify(detail)}::jsonb) as result`)) as unknown as Array<{
          result: string;
        }>;
        if (r[0]?.result === "recorded") findings++;
      }
    }
    return { scanned: rows.length, findings };
  } finally {
    await end();
  }
}

// ── Cron registrations (dormant in prod until Inngest is provisioned; directly invokable above) ──
export const subscriptionLifecycleCron = inngest.createFunction(
  { id: "subscription-lifecycle", retries: 1, triggers: [cron("0 2 * * *")] }, // ~02:00 UTC daily
  async () => {
    const sweep = await sweepLifecycle(Date.now());
    const recon = await runReconciliation();
    return { sweep, recon };
  },
);
