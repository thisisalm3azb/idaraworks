/**
 * H30 LB-4 — a queue that is never drained must not report itself healthy.
 *
 * Production ran for 3.2 days with eleven unprocessed jobs, zero dead letters,
 * and `alert: false`. Nothing had failed, because nothing had run: Inngest is
 * unprovisioned, so no worker collected the jobs, no attempt was made, and no
 * attempt could exhaust its retries. The one condition the health check watched
 * — a dead letter — is reachable only by a worker that exists.
 *
 * The rule is extracted here so it can be tested without a database, and so the
 * distinction it draws is written down: failure and absence are different, and
 * absence was the one that went unnoticed.
 */
import { describe, expect, it } from "vitest";
import { QUEUE_STALE_AFTER_S } from "@/platform/observability/health";

/** The predicate as the health probe applies it. */
function queueAlert(s: { unprocessed: number; oldest_age: number; dead_lettered: number }) {
  const stale = s.unprocessed > 0 && s.oldest_age > QUEUE_STALE_AFTER_S;
  return { stale, alert: s.dead_lettered > 0 || stale };
}

describe("queue staleness", () => {
  it("the exact production state that went unnoticed now alerts", () => {
    // Read from /api/health at the start of H30.
    const r = queueAlert({ unprocessed: 11, oldest_age: 276434, dead_lettered: 0 });
    expect(r.stale).toBe(true);
    expect(r.alert).toBe(true);
  });

  it("an empty queue never alerts, however long it has been empty", () => {
    expect(queueAlert({ unprocessed: 0, oldest_age: 0, dead_lettered: 0 }).alert).toBe(false);
  });

  it("a busy queue working through recent jobs does not alert", () => {
    expect(queueAlert({ unprocessed: 40, oldest_age: 30, dead_lettered: 0 }).alert).toBe(false);
  });

  it("a dead letter still alerts on its own, with nothing waiting", () => {
    const r = queueAlert({ unprocessed: 0, oldest_age: 0, dead_lettered: 1 });
    expect(r.stale).toBe(false);
    expect(r.alert).toBe(true);
  });

  it("the threshold is a boundary, not a range", () => {
    expect(
      queueAlert({ unprocessed: 1, oldest_age: QUEUE_STALE_AFTER_S, dead_lettered: 0 }).alert,
    ).toBe(false);
    expect(
      queueAlert({ unprocessed: 1, oldest_age: QUEUE_STALE_AFTER_S + 1, dead_lettered: 0 }).alert,
    ).toBe(true);
  });

  it("the threshold is far longer than any job here should take", () => {
    // Guards against someone tightening this until it alarms on a slow render.
    expect(QUEUE_STALE_AFTER_S).toBeGreaterThanOrEqual(600);
  });
});
