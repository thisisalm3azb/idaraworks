/**
 * The subscription state machine (S9; v1 §13 billing lifecycle). PURE — no DB, no provider — so
 * the transition legality is unit-tested in isolation and the same rules run in the service, the
 * webhook processor, and the lifecycle worker.
 *
 * v1 §13 law: transitions are driven by PROVIDER EVENTS (or the platform lifecycle worker's
 * deadline sweep), NEVER by a client claim. This module answers two questions: is a transition
 * LEGAL (`canTransition`), and what target does a normalized provider event imply from the
 * current state (`nextForEvent`). Persistence + guards live in `app.advance_subscription` (0053);
 * this is the legality layer above it.
 */

// The reconciled state set (0052). `paused` is deferred (S10+); `purged` is terminal.
export const BILLING_STATES = [
  "internal_pilot",
  "trialing",
  "active",
  "past_due",
  "grace",
  "suspended",
  "cancelled",
  "purge_pending",
  "purged",
] as const;
export type BillingState = (typeof BILLING_STATES)[number];

/**
 * Legal transitions (superset). "Never delete data / read-only, not lockout" (FR-9) is enforced
 * by the enforcement layer, not here — here we only gate which state may follow which.
 * A self-loop (X→X) is always legal and is treated as an idempotent no-op by the writer.
 */
const ALLOWED: Record<BillingState, readonly BillingState[]> = {
  // Platform-managed pilot orgs: a platform admin may convert to a real trial/active or cancel.
  internal_pilot: ["trialing", "active", "cancelled"],
  // Trial converts to active (payment), or ends without conversion → suspended (read-only), or is abandoned.
  trialing: ["active", "suspended", "cancelled"],
  // Active: a failed payment drops to past_due; the customer may cancel.
  active: ["past_due", "cancelled"],
  // Dunning: recovers to active, or retries exhaust into the short grace buffer, or cancels.
  past_due: ["active", "grace", "cancelled"],
  // Grace buffer: recovers, or lapses into read-only suspension, or cancels.
  grace: ["active", "suspended", "cancelled"],
  // Suspended (read-only): may be reactivated on payment, cancelled, or scheduled for purge.
  suspended: ["active", "cancelled", "purge_pending"],
  // Cancelled (read-only + exportable window): reactivate within the window, or schedule purge.
  cancelled: ["active", "purge_pending"],
  // Scheduled purge: a last-chance reactivation, or the purge executes.
  purge_pending: ["active", "purged"],
  // Terminal.
  purged: [],
};

export function canTransition(from: BillingState, to: BillingState): boolean {
  if (from === to) return true; // idempotent no-op
  return ALLOWED[from].includes(to);
}

// The normalized signal vocabulary lives in the platform billing adapter (which produces it);
// re-exported here for the machine's consumers. A module may import platform (BUILD_BIBLE §3.3).
import type { SubscriptionSignal } from "@/platform/billing/adapter";
export type { SubscriptionSignal };

export type SignalResolution = { to: BillingState; reason: string } | { to: null; reason: string };

/**
 * Given the current state and a normalized signal, compute the target state — encoding the v1 §13
 * failed-payment ladder (active → past_due → grace → suspended) and the cancellation → purge path.
 * Returns `to: null` when the signal is a no-op / not applicable from the current state (idempotent).
 */
export function nextForEvent(from: BillingState, signal: SubscriptionSignal): SignalResolution {
  switch (signal) {
    case "activated":
      // Any non-terminal, non-active state can be (re)activated by a successful payment.
      if (from === "purged") return { to: null, reason: "purged is terminal" };
      if (from === "active") return { to: null, reason: "already active" };
      return canTransition(from, "active")
        ? { to: "active", reason: "payment succeeded / reactivated" }
        : { to: null, reason: `no active transition from ${from}` };
    case "payment_failed":
      // The dunning ladder: active → past_due; past_due → grace; grace → suspended.
      if (from === "active") return { to: "past_due", reason: "first failed charge → dunning" };
      if (from === "past_due") return { to: "grace", reason: "retries exhausted → grace buffer" };
      if (from === "grace") return { to: "suspended", reason: "grace elapsed → read-only" };
      return { to: null, reason: `payment_failed no-op from ${from}` };
    case "payment_recovered":
      if (["past_due", "grace", "suspended"].includes(from))
        return { to: "active", reason: "payment recovered" };
      return { to: null, reason: `payment_recovered no-op from ${from}` };
    case "canceled":
      if (from === "cancelled" || from === "purged" || from === "purge_pending")
        return { to: null, reason: `cancel no-op from ${from}` };
      return { to: "cancelled", reason: "subscription cancelled" };
    case "plan_changed":
      // A plan change never moves billing_state — the service handles it (plan_key / scheduled_plan_key).
      return { to: null, reason: "plan change is not a state transition" };
    case "addon_changed":
      // An add-on change never moves billing_state — the service handles it (org_addon rows).
      return { to: null, reason: "addon change is not a state transition" };
    case "trial_ended":
      // A trial that never converted becomes read-only (not deleted). If already converted (active), no-op.
      return from === "trialing"
        ? { to: "suspended", reason: "trial ended without conversion → read-only" }
        : { to: null, reason: `trial_ended no-op from ${from}` };
    case "grace_elapsed":
      return from === "grace"
        ? { to: "suspended", reason: "grace window elapsed → read-only" }
        : { to: null, reason: `grace_elapsed no-op from ${from}` };
    case "purge_due":
      return from === "suspended" || from === "cancelled"
        ? { to: "purge_pending", reason: "read-only window elapsed → scheduled purge" }
        : { to: null, reason: `purge_due no-op from ${from}` };
    case "purged":
      return from === "purge_pending"
        ? { to: "purged", reason: "purge executed" }
        : { to: null, reason: `purged no-op from ${from}` };
  }
}
