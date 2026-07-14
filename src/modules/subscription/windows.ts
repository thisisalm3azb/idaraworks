/**
 * Subscription lifecycle WINDOWS (S9; v1 §13 timelines). PURE — no DB — so the deadline math is
 * unit-tested and shared by the webhook processor (which SETS the next window on a transition) and
 * the lifecycle sweep worker (which reads a window that has PASSED and emits the due signal).
 *
 * Durations are configurable (env) with the v1 §13 defaults: 14-day trial, ~14-day dunning in
 * past_due, a short grace buffer, a 60-day read-only window before purge, and a purge-warning lead.
 */
import type { SubscriptionSignal } from "@/platform/billing/adapter";
import type { BillingState } from "./machine";

const days = (envKey: string, dflt: number): number => {
  const v = Number(process.env[envKey]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

export const LIFECYCLE_WINDOWS = {
  trialDays: days("SUB_TRIAL_DAYS", 14),
  dunningDays: days("SUB_DUNNING_DAYS", 14), // past_due → grace
  graceDays: days("SUB_GRACE_DAYS", 3), // grace → suspended
  readonlyDays: days("SUB_READONLY_DAYS", 60), // suspended/cancelled → purge_pending
  purgeWarnDays: days("SUB_PURGE_WARN_DAYS", 7), // purge_pending → purged lead
};

const addDays = (nowMs: number, d: number): string =>
  new Date(nowMs + d * 86_400_000).toISOString();

export type LifecycleWindows = {
  trialEnd?: string | null;
  graceUntil?: string | null;
  suspendAt?: string | null;
  purgeAt?: string | null;
};

/**
 * The window timestamps to SET when a subscription enters `target`. Only the fields relevant to the
 * target are returned; the rest are left unchanged by the DB writer (COALESCE). Entering `active`
 * clears the failure windows so a recovered org isn't swept.
 */
export function computeWindows(target: BillingState, nowMs: number): LifecycleWindows {
  switch (target) {
    case "trialing":
      return { trialEnd: addDays(nowMs, LIFECYCLE_WINDOWS.trialDays) };
    case "active":
      // Recovery leaves the stale failure-window timestamps in place — harmless, because the sweep
      // never inspects windows for an `active` org, and each re-entry to past_due/grace/etc.
      // RECOMPUTES its own window. So nothing to set here (the DB writer COALESCEs null = unchanged).
      return {};
    case "past_due":
      return { graceUntil: addDays(nowMs, LIFECYCLE_WINDOWS.dunningDays) };
    case "grace":
      return { suspendAt: addDays(nowMs, LIFECYCLE_WINDOWS.graceDays) };
    case "suspended":
    case "cancelled":
      return { purgeAt: addDays(nowMs, LIFECYCLE_WINDOWS.readonlyDays) };
    default:
      return {};
  }
}

/**
 * The end of the monthly period containing `now`: the FIRST monthly anniversary of `anchor`
 * strictly after `now`, in UTC (an anchor on the 29th–31st clamps into shorter months). This is the
 * deterministic no-provider period boundary (fake provider / pre-D1): scheduled add-on removals and
 * scheduled plan downgrades apply here, never mid-period. Returns an ISO string like the other
 * window math in this file.
 */
export function monthlyPeriodEnd(anchor: Date, now: Date): string {
  const anniversary = (monthsAhead: number): Date => {
    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth() + monthsAhead;
    // Clamp the anchor's day-of-month into the target month (Jan 31 anchor → Feb 28/29).
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(
      Date.UTC(
        y,
        m,
        Math.min(anchor.getUTCDate(), lastDay),
        anchor.getUTCHours(),
        anchor.getUTCMinutes(),
        anchor.getUTCSeconds(),
        anchor.getUTCMilliseconds(),
      ),
    );
  };
  // Whole-month estimate, then walk forward to the first anniversary strictly after `now`
  // (the estimate is never past it — it lands in `now`'s calendar month or earlier).
  let n = Math.max(
    0,
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      (now.getUTCMonth() - anchor.getUTCMonth()),
  );
  while (anniversary(n).getTime() <= now.getTime()) n++;
  return anniversary(n).toISOString();
}

/** A row the sweep inspects (only the fields it needs). */
export type LifecycleRow = {
  billing_state: BillingState;
  period_start: string | null;
  trial_end: string | null;
  grace_until: string | null;
  suspend_at: string | null;
  purge_at: string | null;
};

/** Effective trial end: the explicit trial_end, or period_start + trialDays (orgs created by the
 * unchanged 0005 bootstrap have trial_end NULL, so the trial length is derived from when it began). */
export function effectiveTrialEnd(row: LifecycleRow): string | null {
  if (row.trial_end) return row.trial_end;
  if (!row.period_start) return null;
  return new Date(
    Date.parse(row.period_start) + LIFECYCLE_WINDOWS.trialDays * 86_400_000,
  ).toISOString();
}

/**
 * The signal DUE for an org whose deadline has passed, or null. Encodes the passive lifecycle
 * (deadline-driven, not provider-driven): a trial that ran out, a dunning window that elapsed, a
 * read-only window that ended. The sweep feeds the result through the state machine + advancer.
 */
export function dueSignal(row: LifecycleRow, nowMs: number): SubscriptionSignal | null {
  const passed = (ts: string | null): boolean => ts !== null && Date.parse(ts) <= nowMs;
  switch (row.billing_state) {
    case "trialing":
      return passed(effectiveTrialEnd(row)) ? "trial_ended" : null;
    case "past_due":
      return passed(row.grace_until) ? "payment_failed" : null; // → grace (dunning exhausted)
    case "grace":
      return passed(row.suspend_at) ? "grace_elapsed" : null; // → suspended
    case "suspended":
    case "cancelled":
      return passed(row.purge_at) ? "purge_due" : null; // → purge_pending
    case "purge_pending":
      // Purge executes after the warning lead (purge_at was the read-only end; add the warn lead).
      return passed(addWarn(row.purge_at)) ? "purged" : null;
    default:
      return null;
  }
}

function addWarn(purgeAt: string | null): string | null {
  return purgeAt === null
    ? null
    : new Date(Date.parse(purgeAt) + LIFECYCLE_WINDOWS.purgeWarnDays * 86_400_000).toISOString();
}
