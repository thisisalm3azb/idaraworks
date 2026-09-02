/**
 * H25G — Monte Carlo over the CPM engine: reproducible, honest, refusing.
 */
import { describe, expect, it } from "vitest";
import type { Calendar } from "@/platform/calendar/calendar";
import type { ScheduleDep } from "@/modules/studio/engine/cpm";
import {
  mulberry32,
  simulateSchedule,
  triangular,
  type EstimatedTask,
} from "@/modules/studio/engine/monte-carlo";

const FIVE_DAY: Calendar = {
  workingDays: new Set(["mon", "tue", "wed", "thu", "fri"]),
  holidays: [],
};
const START = "2026-09-07"; // Monday

function task(
  id: string,
  durationDays: number | null,
  extra: Partial<EstimatedTask> = {},
): EstimatedTask {
  return {
    id,
    durationDays,
    startDate: null,
    dueDate: null,
    isMilestone: false,
    constraintKind: "none",
    constraintDate: null,
    deadlineDate: null,
    optimisticDays: null,
    pessimisticDays: null,
    ...extra,
  };
}
const fs = (p: string, s: string): ScheduleDep => ({
  predecessorId: p,
  successorId: s,
  kind: "finish_to_start",
  lagDays: 0,
});

const estimated = () => [
  task("A", 3, { optimisticDays: 2, pessimisticDays: 6 }),
  task("B", 2, { optimisticDays: 1, pessimisticDays: 5 }),
  task("C", 5, { optimisticDays: 4, pessimisticDays: 9 }),
  task("D", 2, { optimisticDays: 2, pessimisticDays: 4 }),
  task("M", null, { isMilestone: true }),
];
const diamond = [fs("A", "B"), fs("A", "C"), fs("B", "D"), fs("C", "D"), fs("D", "M")];

describe("sampling primitives", () => {
  it("mulberry32 is deterministic and uniform-ish", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    const ys = Array.from({ length: 1000 }, () => b());
    expect(xs).toEqual(ys);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it("triangular stays inside [a, b] and hits the mode at its cdf", () => {
    expect(triangular(0, 2, 3, 6)).toBe(2);
    expect(triangular(1, 2, 3, 6)).toBe(6);
    expect(triangular(0.25, 2, 3, 6)).toBeCloseTo(3, 6); // c = (3-2)/(6-2)
    expect(triangular(0.5, 4, 4, 4)).toBe(4); // degenerate
  });
});

describe("simulateSchedule", () => {
  it("refuses without explicit three-point estimates, naming the tasks", () => {
    const tasks = estimated();
    tasks[2] = task("C", 5); // no estimates
    const r = simulateSchedule(FIVE_DAY, tasks, diamond, {
      samples: 200,
      seed: 7,
      projectStart: START,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("insufficient_estimates");
      expect(r.missing).toEqual(["C"]);
    }
  });

  it("does not require estimates for milestones or finished work", () => {
    const tasks = estimated();
    tasks[0] = task("A", 3, { done: true, startDate: START }); // actual, no spread
    const r = simulateSchedule(FIVE_DAY, tasks, diamond, {
      samples: 200,
      seed: 7,
      projectStart: START,
    });
    expect(r.ok).toBe(true);
  });

  it("is reproducible from its seed and honest about spread", () => {
    const opts = { samples: 500, seed: 20260907, projectStart: START };
    const r1 = simulateSchedule(FIVE_DAY, estimated(), diamond, opts);
    const r2 = simulateSchedule(FIVE_DAY, estimated(), diamond, opts);
    expect(r1).toEqual(r2);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.seed).toBe(20260907);
    expect(r1.samples).toBe(500);
    // Deterministic CPM: A3 → C5 → D2 = 10 working days (D ends Fri 09-18);
    // the trailing milestone M sits on the next working day, Mon 09-21.
    expect(r1.deterministicDurationDays).toBe(10);
    expect(r1.deterministicFinish).toBe("2026-09-21");
    expect(r1.finish.p50 <= r1.finish.p80).toBe(true);
    expect(r1.finish.p80 <= r1.finish.p90).toBe(true);
    expect(r1.finish.min <= r1.finish.p50).toBe(true);
    expect(r1.finish.p90 <= r1.finish.max).toBe(true);
    expect(r1.durationDays.p50).toBeLessThanOrEqual(r1.durationDays.p80);
    expect(r1.confidenceInDeterministic).toBeGreaterThan(0);
    expect(r1.confidenceInDeterministic).toBeLessThan(1);
    // Right-skewed estimates: the P80 is later than the single-point plan.
    expect(r1.finish.p80 > r1.deterministicFinish).toBe(true);
    // Criticality: C is on the deterministic critical path and stays mostly
    // critical; B (float 3) is critical only in the tail. Milestone shares D's fate.
    expect(r1.criticality.get("C")!).toBeGreaterThan(r1.criticality.get("B")!);
    expect(r1.criticality.get("A")).toBe(1);
    expect(r1.failedSamples).toBe(0);
  });

  it("a different seed gives a different but similarly-shaped answer", () => {
    const base = { samples: 500, projectStart: START };
    const a = simulateSchedule(FIVE_DAY, estimated(), diamond, { ...base, seed: 1 });
    const b = simulateSchedule(FIVE_DAY, estimated(), diamond, { ...base, seed: 2 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.finish.p50 === b.finish.p50 || a.finish.p80 === b.finish.p80).toBe(true);
    expect(Math.abs(a.durationDays.mean - b.durationDays.mean)).toBeLessThan(1.5);
  });

  it("clamps the sample count and refuses an empty network", () => {
    const r = simulateSchedule(FIVE_DAY, estimated(), diamond, {
      samples: 5,
      seed: 3,
      projectStart: START,
    });
    expect(r.ok && r.samples === 100).toBe(true);
    const empty = simulateSchedule(FIVE_DAY, [], [], { samples: 100, seed: 3 });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe("no_tasks");
  });
});
