/**
 * H25D — the scheduling engine, checked against hand-computed CPM.
 *
 * Every expectation below was worked by hand on a Mon–Fri calendar with
 * project start Monday 2026-09-07 (ordinal 0). Working-day ordinals:
 *   0 Mon 09-07 · 1 Tue 09-08 · 2 Wed 09-09 · 3 Thu 09-10 · 4 Fri 09-11
 *   5 Mon 09-14 · 6 Tue 09-15 · 7 Wed 09-16 · 8 Thu 09-17 · 9 Fri 09-18
 *   10 Mon 09-21 · …
 * The critical path must come out of the network and the calendar — the
 * engine is never told which tasks are critical.
 */
import { describe, expect, it } from "vitest";
import type { Calendar } from "@/platform/calendar/calendar";
import { computeSchedule, type ScheduleDep, type ScheduleTask } from "@/modules/studio/engine/cpm";

const FIVE_DAY: Calendar = {
  workingDays: new Set(["mon", "tue", "wed", "thu", "fri"]),
  holidays: [],
};
const START = "2026-09-07"; // Monday

function task(
  id: string,
  durationDays: number | null,
  extra: Partial<ScheduleTask> = {},
): ScheduleTask {
  return {
    id,
    durationDays,
    startDate: null,
    dueDate: null,
    isMilestone: false,
    constraintKind: "none",
    constraintDate: null,
    deadlineDate: null,
    ...extra,
  };
}
const fs = (p: string, s: string, lagDays = 0): ScheduleDep => ({
  predecessorId: p,
  successorId: s,
  kind: "finish_to_start",
  lagDays,
});

describe("forward and backward pass", () => {
  // A(3) → B(2) → D(2); A → C(5) → D. Classic textbook diamond.
  const diamond = () =>
    computeSchedule(
      FIVE_DAY,
      [task("A", 3), task("B", 2), task("C", 5), task("D", 2)],
      [fs("A", "B"), fs("A", "C"), fs("B", "D"), fs("C", "D")],
      { projectStart: START },
    );

  it("computes early/late dates, floats and ONE critical path", () => {
    const r = diamond();
    expect(r.ok).toBe(true);
    expect(r.cycle).toEqual([]);
    expect(r.projectStart).toBe("2026-09-07");
    expect(r.projectFinish).toBe("2026-09-18"); // 10 working days, Fri
    expect(r.projectDurationDays).toBe(10);

    const A = r.tasks.get("A")!;
    expect([A.earlyStart, A.earlyFinish, A.lateStart, A.lateFinish]).toEqual([
      "2026-09-07",
      "2026-09-09",
      "2026-09-07",
      "2026-09-09",
    ]);
    expect(A.totalFloatDays).toBe(0);
    expect(A.freeFloatDays).toBe(0);
    expect(A.critical).toBe(true);

    const B = r.tasks.get("B")!;
    expect([B.earlyStart, B.earlyFinish]).toEqual(["2026-09-10", "2026-09-11"]);
    expect([B.lateStart, B.lateFinish]).toEqual(["2026-09-15", "2026-09-16"]);
    expect(B.totalFloatDays).toBe(3);
    expect(B.freeFloatDays).toBe(3);
    expect(B.critical).toBe(false);

    const C = r.tasks.get("C")!;
    expect([C.earlyStart, C.earlyFinish]).toEqual(["2026-09-10", "2026-09-16"]);
    expect(C.totalFloatDays).toBe(0);

    const D = r.tasks.get("D")!;
    expect([D.earlyStart, D.earlyFinish]).toEqual(["2026-09-17", "2026-09-18"]);
    expect(D.totalFloatDays).toBe(0);

    expect(r.criticalPaths).toEqual([["A", "C", "D"]]);
    expect(r.health).toMatchObject({
      taskCount: 4,
      missingLogicCount: 0,
      hardConstraintCount: 0,
      highFloatCount: 0,
      negativeFloatCount: 0,
    });
  });

  it("reports EVERY distinct zero-float chain when two branches tie", () => {
    // A(3) → B(2) → D(1); A → C(2) → D — B and C both drive D.
    const r = computeSchedule(
      FIVE_DAY,
      [task("A", 3), task("B", 2), task("C", 2), task("D", 1)],
      [fs("A", "B"), fs("A", "C"), fs("B", "D"), fs("C", "D")],
      { projectStart: START },
    );
    expect(r.tasks.get("B")!.totalFloatDays).toBe(0);
    expect(r.tasks.get("C")!.totalFloatDays).toBe(0);
    const paths = r.criticalPaths.map((p) => p.join(">")).sort();
    expect(paths).toEqual(["A>B>D", "A>C>D"]);
  });
});

describe("the working calendar is honoured, never raw arithmetic", () => {
  it("a five-day task started Monday finishes Friday; weekends are skipped", () => {
    const r = computeSchedule(FIVE_DAY, [task("A", 5), task("B", 1)], [fs("A", "B")], {
      projectStart: START,
    });
    expect(r.tasks.get("A")!.earlyFinish).toBe("2026-09-11"); // Fri
    expect(r.tasks.get("B")!.earlyStart).toBe("2026-09-14"); // next Mon
  });

  it("holidays are skipped and the finish moves out", () => {
    const withHoliday: Calendar = {
      ...FIVE_DAY,
      holidays: [{ start: "2026-09-09", end: "2026-09-09" }], // Wed off
    };
    const r = computeSchedule(withHoliday, [task("A", 3)], [], { projectStart: START });
    // Mon, Tue, (Wed holiday), Thu → finishes Thursday
    expect(r.tasks.get("A")!.earlyFinish).toBe("2026-09-10");
  });

  it("a non-working input date snaps forward AND is reported", () => {
    const r = computeSchedule(
      FIVE_DAY,
      [task("A", 2, { startDate: "2026-09-05" })], // Saturday
      [],
      { projectStart: START },
    );
    expect(r.tasks.get("A")!.earlyStart).toBe("2026-09-07");
    expect(r.warnings.some((w) => w.includes("2026-09-05") && w.includes("non-working"))).toBe(
      true,
    );
  });

  it("derives duration from a dated window in working days", () => {
    const r = computeSchedule(
      FIVE_DAY,
      [task("A", null, { startDate: "2026-09-07", dueDate: "2026-09-11" })],
      [],
    );
    expect(r.tasks.get("A")!.durationDays).toBe(5);
    expect(r.unscheduled).toEqual([]);
  });
});

describe("dependency kinds with lead and lag", () => {
  it("start-to-start with lag and finish-to-finish", () => {
    // A(4); B(2) SS+1 after A; C(3) FF after A.
    const r = computeSchedule(
      FIVE_DAY,
      [task("A", 4), task("B", 2), task("C", 3)],
      [
        { predecessorId: "A", successorId: "B", kind: "start_to_start", lagDays: 1 },
        { predecessorId: "A", successorId: "C", kind: "finish_to_finish", lagDays: 0 },
      ],
      { projectStart: START },
    );
    const B = r.tasks.get("B")!;
    expect(B.earlyStart).toBe("2026-09-08"); // A.ES + 1
    expect(B.earlyFinish).toBe("2026-09-09");
    expect(B.totalFloatDays).toBe(1);
    const C = r.tasks.get("C")!;
    expect(C.earlyFinish).toBe("2026-09-10"); // pinned to A's finish
    expect(C.earlyStart).toBe("2026-09-08");
    expect(C.totalFloatDays).toBe(0);
    expect(r.criticalPaths).toEqual([["A", "C"]]);
  });

  it("finish-to-start lag pushes the successor; a lead pulls it in", () => {
    const lagged = computeSchedule(FIVE_DAY, [task("A", 2), task("B", 1)], [fs("A", "B", 2)], {
      projectStart: START,
    });
    expect(lagged.tasks.get("B")!.earlyStart).toBe("2026-09-11"); // EF 2 + lag 2 = ord 4
    const lead = computeSchedule(FIVE_DAY, [task("A", 3), task("B", 1)], [fs("A", "B", -1)], {
      projectStart: START,
    });
    expect(lead.tasks.get("B")!.earlyStart).toBe("2026-09-09"); // EF 3 − 1 = ord 2
  });
});

describe("constraints, deadlines and milestones", () => {
  it("start-no-earlier holds a task back and counts as a hard constraint", () => {
    const r = computeSchedule(
      FIVE_DAY,
      [task("A", 2, { constraintKind: "start_no_earlier", constraintDate: "2026-09-10" })],
      [],
      { projectStart: START },
    );
    expect(r.tasks.get("A")!.earlyStart).toBe("2026-09-10");
    expect(r.health.hardConstraintCount).toBe(1);
  });

  it("a deadline that cannot be met yields NEGATIVE float and a named breach", () => {
    const r = computeSchedule(
      FIVE_DAY,
      [task("A", 5, { deadlineDate: "2026-09-09" })], // needs 5 days, must end Wed
      [],
      { projectStart: START },
    );
    const A = r.tasks.get("A")!;
    expect(A.totalFloatDays).toBe(-2);
    expect(A.critical).toBe(true);
    expect(A.deadlineBreachedDays).toBe(2);
    expect(r.health.negativeFloatCount).toBe(1);
  });

  it("a milestone has zero duration and starts where it finishes", () => {
    const r = computeSchedule(
      FIVE_DAY,
      [task("A", 3), task("M", null, { isMilestone: true })],
      [fs("A", "M")],
      { projectStart: START },
    );
    const M = r.tasks.get("M")!;
    expect(M.durationDays).toBe(0);
    expect(M.earlyStart).toBe("2026-09-10");
    expect(M.earlyFinish).toBe("2026-09-10");
  });
});

describe("honesty: cycles, unschedulable work, missing logic", () => {
  it("refuses a cyclic network and names the tasks in the cycle", () => {
    const r = computeSchedule(
      FIVE_DAY,
      [task("A", 1), task("B", 1), task("C", 1)],
      [fs("A", "B"), fs("B", "A")],
      { projectStart: START },
    );
    expect(r.ok).toBe(false);
    expect([...r.cycle].sort()).toEqual(["A", "B"]);
    expect(r.tasks.size).toBe(0);
  });

  it("lists tasks it cannot place, with the reason, and schedules the rest", () => {
    const r = computeSchedule(FIVE_DAY, [task("A", 2), task("B", null)], [], {
      projectStart: START,
    });
    expect(r.ok).toBe(true);
    expect(r.tasks.has("A")).toBe(true);
    expect(r.unscheduled).toEqual([{ id: "B", reason: "no duration and no dates" }]);
  });

  it("refuses to invent a start when nothing is dated", () => {
    const r = computeSchedule(FIVE_DAY, [task("A", 2)], []);
    expect(r.ok).toBe(true);
    expect(r.tasks.size).toBe(0);
    expect(r.unscheduled.some((u) => u.id === "A")).toBe(true);
    expect(r.warnings.some((w) => w.includes("no project start"))).toBe(true);
  });

  it("flags missing logic (DCMA #1) as a percentage of tasks", () => {
    const r = computeSchedule(FIVE_DAY, [task("A", 1), task("B", 1)], [], {
      projectStart: START,
    });
    expect(r.health.missingLogicCount).toBe(2);
    expect(r.health.missingLogicPct).toBe(100);
  });

  it("an empty calendar is refused, not scheduled around", () => {
    const r = computeSchedule({ workingDays: new Set(), holidays: [] }, [task("A", 1)], [], {
      projectStart: START,
    });
    expect(r.tasks.size).toBe(0);
    expect(r.warnings[0]).toMatch(/no working days/);
  });
});
