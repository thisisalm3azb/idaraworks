/**
 * H25H — leveling proposes, never moves: it delays the task with float, never
 * critical work, and reports what it could not clear.
 */
import { describe, expect, it } from "vitest";
import { proposeLeveling, type CapacityReport } from "@/modules/studio/capacity";

const CAL = {
  workingDaysPerWeek: 5,
  holidayRanges: 0,
  workingWeekdays: [1, 2, 3, 4, 5],
  holidays: [] as Array<{ start: string; end: string }>,
};
const WEEK = "2026-10-05"; // Monday

function report(
  items: Array<{ nodeId: string; title: string; share: number }>,
  demand: number,
): CapacityReport {
  return {
    weeks: [WEEK, "2026-10-12"],
    people: [
      {
        employeeId: "salem",
        name: "Salem",
        teamName: null,
        skills: [],
        cells: {
          [WEEK]: {
            demandDays: demand,
            capacityDays: 5,
            items: items.map((i) => ({ ...i, implicit: false })),
          },
          "2026-10-12": { demandDays: 0, capacityDays: 5, items: [] },
        },
        totalDemand: demand,
        totalCapacity: 10,
      },
    ],
    unassigned: {},
    overloads: [{ employeeId: "salem", week: WEEK, demandDays: demand, capacityDays: 5 }],
    warnings: [],
  };
}

describe("proposeLeveling", () => {
  it("delays the task with the most float to the next working week", () => {
    const r = report(
      [
        { nodeId: "A", title: "Survey", share: 1 },
        { nodeId: "B", title: "Rigging", share: 1 },
      ],
      7,
    );
    const schedule = new Map([
      [
        "A",
        { earlyStart: "2026-10-05", earlyFinish: "2026-10-07", totalFloatDays: 0, critical: true },
      ],
      [
        "B",
        { earlyStart: "2026-10-06", earlyFinish: "2026-10-09", totalFloatDays: 8, critical: false },
      ],
    ]);
    const { proposals, unresolved } = proposeLeveling(r, schedule, CAL);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      nodeId: "B",
      fromStart: "2026-10-06",
      toStart: "2026-10-12",
    });
    expect(proposals[0]!.delayDays).toBe(4); // Tue..Fri
    expect(unresolved).toHaveLength(0);
  });

  it("never moves critical work and reports the overload it cannot clear", () => {
    const r = report(
      [
        { nodeId: "A", title: "Survey", share: 1 },
        { nodeId: "B", title: "Rigging", share: 1 },
      ],
      7,
    );
    const schedule = new Map([
      [
        "A",
        { earlyStart: "2026-10-05", earlyFinish: "2026-10-07", totalFloatDays: 0, critical: true },
      ],
      [
        "B",
        { earlyStart: "2026-10-06", earlyFinish: "2026-10-09", totalFloatDays: 0, critical: true },
      ],
    ]);
    const { proposals, unresolved } = proposeLeveling(r, schedule, CAL);
    expect(proposals).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
  });

  it("does not delay past a task's float", () => {
    const r = report([{ nodeId: "B", title: "Rigging", share: 1 }], 6);
    const schedule = new Map([
      [
        "B",
        { earlyStart: "2026-10-06", earlyFinish: "2026-10-09", totalFloatDays: 2, critical: false },
      ],
    ]);
    const { proposals, unresolved } = proposeLeveling(r, schedule, CAL);
    expect(proposals).toHaveLength(0); // needs 4 days, has 2
    expect(unresolved).toHaveLength(1);
  });
});
