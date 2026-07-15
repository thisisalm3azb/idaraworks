/**
 * S9 subscription state machine (pure): transition legality + the v1 §13 dunning ladder and
 * cancellation→purge path. This is the testable core the service, webhook processor, and
 * lifecycle worker all share.
 */
import { describe, it, expect } from "vitest";
import { canTransition, nextForEvent, BILLING_STATES } from "@/modules/subscription/machine";

describe("canTransition (v1 §13 legality)", () => {
  it("allows the active→past_due→grace→suspended dunning ladder", () => {
    expect(canTransition("active", "past_due")).toBe(true);
    expect(canTransition("past_due", "grace")).toBe(true);
    expect(canTransition("grace", "suspended")).toBe(true);
  });

  it("allows recovery from every failed-payment state back to active", () => {
    for (const s of ["past_due", "grace", "suspended"] as const) {
      expect(canTransition(s, "active")).toBe(true);
    }
  });

  it("treats a self-loop as legal (idempotent no-op)", () => {
    for (const s of BILLING_STATES) expect(canTransition(s, s)).toBe(true);
  });

  it("makes 'purged' terminal — no outgoing transition", () => {
    for (const s of BILLING_STATES) {
      if (s !== "purged") expect(canTransition("purged", s)).toBe(false);
    }
  });

  it("forbids illegal jumps (active→suspended, trialing→purged, active→purge_pending)", () => {
    expect(canTransition("active", "suspended")).toBe(false); // must go through the ladder
    expect(canTransition("trialing", "purged")).toBe(false);
    expect(canTransition("active", "purge_pending")).toBe(false);
  });
});

describe("nextForEvent (signal → target)", () => {
  it("walks the dunning ladder on repeated payment_failed", () => {
    expect(nextForEvent("active", "payment_failed").to).toBe("past_due");
    expect(nextForEvent("past_due", "payment_failed").to).toBe("grace");
    expect(nextForEvent("grace", "payment_failed").to).toBe("suspended");
    expect(nextForEvent("suspended", "payment_failed").to).toBeNull(); // no further ladder
  });

  it("recovers to active from any dunning state on payment_recovered", () => {
    expect(nextForEvent("past_due", "payment_recovered").to).toBe("active");
    expect(nextForEvent("grace", "payment_recovered").to).toBe("active");
    expect(nextForEvent("suspended", "payment_recovered").to).toBe("active");
    expect(nextForEvent("active", "payment_recovered").to).toBeNull();
  });

  it("activates a trial/suspended org on a successful payment (idempotent when already active)", () => {
    expect(nextForEvent("trialing", "activated").to).toBe("active");
    expect(nextForEvent("suspended", "activated").to).toBe("active");
    expect(nextForEvent("active", "activated").to).toBeNull();
    expect(nextForEvent("purged", "activated").to).toBeNull();
  });

  it("ends an unconverted trial into read-only suspension, not deletion", () => {
    expect(nextForEvent("trialing", "trial_ended").to).toBe("suspended");
    expect(nextForEvent("active", "trial_ended").to).toBeNull(); // already converted
  });

  it("cancels from any live state but no-ops from terminal/cancelled", () => {
    expect(nextForEvent("active", "canceled").to).toBe("cancelled");
    expect(nextForEvent("trialing", "canceled").to).toBe("cancelled");
    expect(nextForEvent("cancelled", "canceled").to).toBeNull();
    expect(nextForEvent("purged", "canceled").to).toBeNull();
  });

  it("schedules purge only from a read-only window, then purges only from purge_pending", () => {
    expect(nextForEvent("suspended", "purge_due").to).toBe("purge_pending");
    expect(nextForEvent("cancelled", "purge_due").to).toBe("purge_pending");
    expect(nextForEvent("active", "purge_due").to).toBeNull();
    expect(nextForEvent("purge_pending", "purged").to).toBe("purged");
    expect(nextForEvent("suspended", "purged").to).toBeNull();
  });

  it("every computed target is itself a legal transition from the source", () => {
    const signals = [
      "activated",
      "payment_failed",
      "payment_recovered",
      "canceled",
      "trial_ended",
      "grace_elapsed",
      "purge_due",
      "purged",
    ] as const;
    for (const from of BILLING_STATES) {
      for (const sig of signals) {
        const r = nextForEvent(from, sig);
        if (r.to !== null) expect(canTransition(from, r.to)).toBe(true);
      }
    }
  });
});

// 0068 contract (adversarial-review CRITICAL regression): a trial deadline is EXPLICIT ONLY.
// trial_end NULL = no deadline — dueSignal must never derive one from period_start, no matter
// how old the org is. This is what makes the protected production orgs (trialing, trial_end
// NULL) permanently exempt from the sweep.
import { dueSignal, effectiveTrialEnd } from "@/modules/subscription/windows";

describe("trial deadlines are explicit only (0068)", () => {
  const base = {
    billing_state: "trialing" as const,
    grace_until: null,
    suspend_at: null,
    purge_at: null,
  };

  it("trial_end NULL yields NO deadline and NO due signal, even for a very old org", () => {
    const row = { ...base, period_start: "2020-01-01T00:00:00.000Z", trial_end: null };
    expect(effectiveTrialEnd(row)).toBeNull();
    expect(dueSignal(row, Date.now())).toBeNull();
  });

  it("an explicit passed trial_end still fires trial_ended", () => {
    const row = {
      ...base,
      period_start: "2020-01-01T00:00:00.000Z",
      trial_end: "2020-01-15T00:00:00.000Z",
    };
    expect(dueSignal(row, Date.parse("2020-01-16T00:00:00.000Z"))).toBe("trial_ended");
    expect(dueSignal(row, Date.parse("2020-01-14T00:00:00.000Z"))).toBeNull();
  });
});
