/**
 * S9 lifecycle workers (platform, no tenant context — so they can call the
 * assert_platform_task-guarded DEFINER path). Three directly-invokable functions (also wired to a
 * daily cron that stays dormant in production until Inngest is provisioned):
 *
 *  • sweepLifecycle  — the passive, deadline-driven engine: land ended trials on the free base
 *    plan, walk the dunning ladder when a window elapses, and schedule/execute purge (legal-hold-
 *    guarded by the DB). Also records dunning reminders while an org is in past_due/grace, flips
 *    period-end add-on removals to 'removed', and applies scheduled plan downgrades at period end.
 *  • runReconciliation — compare each org's LOCAL subscription state to the provider's view and
 *    record drift (never auto-overwrite governed local state — surface it for an operator).
 *
 * Everything routes through the sole writers (`applyTransition` / `applyPlanChange` /
 * `app.set_org_addon`), so the state machine + audit + cache invalidation are identical to the
 * webhook path.
 */
import { createAppDb, sql } from "@/platform/tenancy";
import { getBillingProvider } from "@/platform/billing/adapter";
import { invalidateEntitlements } from "@/platform/entitlements/resolve";
import { TRIAL_LANDING_PLAN } from "@/platform/entitlements/catalogue";
// Import the subscription module ONLY via its service.ts (which re-exports the machine/windows
// surface) — modules talk to other modules through service.ts, never internal files (§3.3).
import {
  applyTransition,
  applyPlanChange,
  nextForEvent,
  dueSignal,
  monthlyPeriodEnd,
  LIFECYCLE_WINDOWS,
  type LifecycleRow,
} from "@/modules/subscription/service";
import { inngest } from "@/platform/events";
import { cron } from "inngest";
import { logger } from "@/platform/logger";

type ScanRow = LifecycleRow & { org_id: string };

export type SweepResult = {
  scanned: number;
  transitioned: number;
  dunned: number;
  addonsRemoved: number;
  plansApplied: number;
};

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
      // S10: the ENTIRE per-org body is fault-isolated — a dunning-record error (or any single
      // org's failure) must not abort the sweep for every remaining org.
      try {
        // Dunning reminders while dunning is active (records + tenant-visible; email is the disabled seam).
        if (row.billing_state === "past_due" || row.billing_state === "grace") {
          if (await recordDunning(db, row, nowMs)) dunned++;
        }
        // Deadline-driven transition.
        const signal = dueSignal(row, nowMs);
        if (!signal) continue;
        // Trial landing (add-on model): a trial that ran out lands on the REAL free base plan and
        // stays 'active' (trialing→active is a legal transition) — never suspension, which is
        // reserved for the PAID dunning ladder (active→past_due→grace→suspended, untouched below).
        if (signal === "trial_ended" && row.billing_state === "trialing") {
          await applyTransition(
            db,
            row.org_id,
            row.billing_state,
            "active",
            "trial ended → free base plan",
            nowMs,
            { planKey: TRIAL_LANDING_PLAN, eventType: `lifecycle.${signal}` },
          );
          transitioned++;
          continue;
        }
        const res = nextForEvent(row.billing_state, signal);
        if (res.to === null) continue;
        await applyTransition(db, row.org_id, row.billing_state, res.to, res.reason, nowMs, {
          eventType: `lifecycle.${signal}`,
        });
        transitioned++;
      } catch (err) {
        // e.g. legal-hold purge refusal — log + carry on (the finding is worth surfacing).
        logger.warn(
          { orgId: row.org_id, err: (err as Error).message },
          "lifecycle per-org step skipped",
        );
      }
    }
    const addonsRemoved = await sweepAddonRemovals(db, nowMs);
    const plansApplied = await sweepScheduledPlans(db, nowMs);
    return { scanned: rows.length, transitioned, dunned, addonsRemoved, plansApplied };
  } finally {
    await end();
  }
}

/** Flip org_addon rows whose scheduled removal deadline passed to 'removed' (the org paid through
 * period end; the entitlement layer counted removal_scheduled until now). Idempotent — a removed
 * row leaves the scan — and per-row fault-isolated like the main sweep. A scan failure (e.g. 0066
 * not yet applied in the deploy-before-migrate window) is logged, never aborts the whole sweep. */
async function sweepAddonRemovals(
  db: ReturnType<typeof createAppDb>["db"],
  nowMs: number,
): Promise<number> {
  let removed = 0;
  let rows: Array<{ org_id: string; addon_key: string; quantity: number; source: string }>;
  try {
    rows = (await db.execute(sql`
      select org_id::text as org_id, addon_key, quantity, source
      from app.addon_removal_scan(${new Date(nowMs).toISOString()}::timestamptz)`)) as unknown as typeof rows;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "add-on removal scan skipped");
    return 0;
  }
  for (const row of rows) {
    try {
      await db.execute(sql`
        select app.set_org_addon(${row.org_id}::uuid, ${row.addon_key}, ${row.quantity},
          'removed', null, ${row.source})`);
      await db.execute(sql`
        select app.record_platform_audit(${row.org_id}::uuid, null, 'subscription.addons_changed',
          'subscription', ${row.org_id}::uuid,
          ${`Add-on ${row.addon_key} removed (scheduled removal reached period end)`},
          ${JSON.stringify({
            addon: row.addon_key,
            quantity: row.quantity,
            status: "removed",
            source: row.source,
            event: "lifecycle.addon_removal",
          })}::jsonb)`);
      invalidateEntitlements(row.org_id);
      removed++;
    } catch (err) {
      logger.warn(
        { orgId: row.org_id, addon: row.addon_key, err: (err as Error).message },
        "add-on removal sweep step skipped",
      );
    }
  }
  return removed;
}

/** Apply scheduled plan downgrades whose period ended (closes the gap where a scheduled_plan_key
 * was recorded but nothing ever applied it). The deadline is the first monthly anniversary of the
 * org's period_start (the deterministic no-provider anchor, set at org creation) after the
 * IMMUTABLE scheduling anchor scheduled_plan_at (0067 — stamped by trigger on the scheduling
 * write; updated_at is only the legacy fallback for rows scheduled before 0067, since the 0005
 * touch trigger bumps it on every later write and would defer the downgrade forever). Routes
 * through the existing applyPlanChange immediate path, which sets plan_key, clears the sentinel,
 * audits and invalidates. */
async function sweepScheduledPlans(
  db: ReturnType<typeof createAppDb>["db"],
  nowMs: number,
): Promise<number> {
  let applied = 0;
  let rows: Array<{
    org_id: string;
    billing_state: string;
    scheduled_plan_key: string;
    period_start: string;
    scheduled_plan_at: string | null;
    updated_at: string;
  }>;
  try {
    rows = (await db.execute(sql`
      select org_id::text as org_id, billing_state, scheduled_plan_key,
             period_start::text as period_start,
             scheduled_plan_at::text as scheduled_plan_at, updated_at::text as updated_at
      from app.scheduled_plan_scan()`)) as unknown as typeof rows;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "scheduled-plan scan skipped");
    return 0;
  }
  for (const row of rows) {
    try {
      const anchor = row.scheduled_plan_at ?? row.updated_at;
      const dueAt = monthlyPeriodEnd(new Date(row.period_start), new Date(anchor));
      if (Date.parse(dueAt) > nowMs) continue;
      await applyPlanChange(db, row.org_id, row.billing_state, row.scheduled_plan_key, "immediate");
      applied++;
    } catch (err) {
      logger.warn(
        { orgId: row.org_id, plan: row.scheduled_plan_key, err: (err as Error).message },
        "scheduled-plan sweep step skipped",
      );
    }
  }
  return applied;
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
      // S10: per-org fault isolation — one org's provider fetch error must not abort the fleet recon.
      try {
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
      } catch (err) {
        logger.warn(
          { orgId: row.org_id, err: (err as Error).message },
          "reconciliation per-org step skipped",
        );
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
