/**
 * H25P — the engine at the mandate's scale: 5,000 activities and 10,000
 * dependencies must schedule within a budget on CI hardware, deterministically,
 * and the critical chain must be the long one by construction.
 */
import { describe, expect, it } from "vitest";
import type { Calendar } from "@/platform/calendar/calendar";
import { computeSchedule, type ScheduleDep, type ScheduleTask } from "@/modules/studio/engine/cpm";

const FIVE_DAY: Calendar = {
  workingDays: new Set(["mon", "tue", "wed", "thu", "fri"]),
  holidays: [{ start: "2026-12-24", end: "2027-01-02" }],
};

function layered(layers: number, width: number) {
  const tasks: ScheduleTask[] = [];
  const deps: ScheduleDep[] = [];
  for (let l = 0; l < layers; l++) {
    for (let w = 0; w < width; w++) {
      const id = `t${l}_${w}`;
      // One lane (w = 0) is deliberately the longest: 3 days; the rest 1 or 2.
      tasks.push({
        id,
        durationDays: w === 0 ? 3 : 1 + ((l + w) % 2),
        startDate: null,
        dueDate: null,
        isMilestone: false,
        constraintKind: "none",
        constraintDate: null,
        deadlineDate: null,
      });
      if (l > 0) {
        deps.push({
          predecessorId: `t${l - 1}_${w}`,
          successorId: id,
          kind: "finish_to_start",
          lagDays: 0,
        });
        deps.push({
          predecessorId: `t${l - 1}_${(w + 1) % width}`,
          successorId: id,
          kind: "finish_to_start",
          lagDays: 0,
        });
      }
    }
  }
  return { tasks, deps };
}

describe("scale", () => {
  it("schedules 5,000 activities / ~10,000 dependencies within budget", () => {
    const { tasks, deps } = layered(100, 50);
    expect(tasks).toHaveLength(5000);
    expect(deps.length).toBeGreaterThanOrEqual(9900);
    const t0 = performance.now();
    const r = computeSchedule(FIVE_DAY, tasks, deps, { projectStart: "2026-09-07" });
    const ms = performance.now() - t0;
    expect(r.ok).toBe(true);
    expect(r.tasks.size).toBe(5000);
    // Every layer waits for the slowest lane (3 days) via the ring dependency,
    // so the project is 100 × 3 working days and lane 0 is critical throughout.
    expect(r.projectDurationDays).toBe(300);
    expect(r.tasks.get("t99_0")!.critical).toBe(true);
    expect(r.criticalPaths.length).toBeGreaterThanOrEqual(1);
    // Budget: generous for CI, tight enough to catch a quadratic regression.
    expect(ms).toBeLessThan(5000);
    // Determinism: a second run is identical.
    const r2 = computeSchedule(FIVE_DAY, tasks, deps, { projectStart: "2026-09-07" });
    expect(r2.projectFinish).toBe(r.projectFinish);
    expect([...r2.tasks.values()].filter((t) => t.critical).length).toBe(
      [...r.tasks.values()].filter((t) => t.critical).length,
    );
  });
});
