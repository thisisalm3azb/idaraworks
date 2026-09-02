/**
 * H25H — resources and capacity on the living model.
 *
 * Demand comes from the ONE schedule (early dates over the org calendar) and
 * the canonical allocations (jobs door); people and skills from the masters
 * door. Capacity is working days per week over the same calendar. Nothing is
 * stored: the report is a projection. Leveling proposes moves; it never moves
 * work itself — `levelIntoScenario` records the proposal as a scenario so it
 * goes through review and apply like any other change.
 *
 * Privacy: names, teams and skills only. No pay, cost rate or contract data.
 */
import { z } from "zod";
import { assertCan, can } from "@/platform/authz";
import type { Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { listEmployees, listEmployeeSkills } from "@/modules/masters/service";
import { listTaskAllocations } from "@/modules/jobs/service";
import { scheduleForPlan, type PlanSchedule } from "./schedule";
import { createScenario } from "./scenarios";
import { updateNode } from "./graph";
import { StudioError } from "./types";

// ── calendar helpers (UTC, pure) ─────────────────────────────────────────────

function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Monday of the ISO week containing `date`. */
function weekStart(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}
function workingDayTest(cal: PlanSchedule["calendar"]): (d: string) => boolean {
  return (d) => {
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    return (
      cal.workingWeekdays.includes(dow) && !cal.holidays.some((h) => d >= h.start && d <= h.end)
    );
  };
}

// ── shapes ───────────────────────────────────────────────────────────────────

export type CapacityItem = { nodeId: string; title: string; share: number; implicit: boolean };
export type CapacityCell = { demandDays: number; capacityDays: number; items: CapacityItem[] };
export type CapacityPerson = {
  employeeId: string;
  name: string;
  teamName: string | null;
  skills: string[];
  cells: Record<string, CapacityCell>;
  totalDemand: number;
  totalCapacity: number;
};
export type CapacityReport = {
  weeks: string[];
  people: CapacityPerson[];
  /** Work nobody is on yet: demand per week, one full person-day per task day. */
  unassigned: Record<string, { demandDays: number; items: CapacityItem[] }>;
  overloads: Array<{ employeeId: string; week: string; demandDays: number; capacityDays: number }>;
  warnings: string[];
};

const round = (x: number) => Math.round(x * 100) / 100;

export const CapacityInput = z.object({
  planId: z.string().uuid(),
  scenarioId: z.string().uuid().optional(),
});

export async function capacityForPlan(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<CapacityReport> {
  assertCan(archetype, "studio.view");
  const input = CapacityInput.parse(raw);
  const plan = await scheduleForPlan(ctx, archetype, {
    planId: input.planId,
    scenarioId: input.scenarioId,
  });
  const warnings: string[] = [];
  const isWorking = workingDayTest(plan.calendar);

  const scheduled = plan.graph.nodes.filter((n) => plan.byNode.has(n.id));
  if (scheduled.length === 0) {
    return { weeks: [], people: [], unassigned: {}, overloads: [], warnings };
  }
  let min = "9999-12-31";
  let max = "0000-01-01";
  for (const n of scheduled) {
    const s = plan.byNode.get(n.id)!;
    if (s.earlyStart < min) min = s.earlyStart;
    if (s.earlyFinish > max) max = s.earlyFinish;
  }
  const weeks: string[] = [];
  for (let w = weekStart(min); w <= max; w = addDays(w, 7)) weeks.push(w);
  const weekCapacity = new Map<string, number>();
  for (const w of weeks) {
    let c = 0;
    for (let i = 0; i < 7; i++) if (isWorking(addDays(w, i))) c++;
    weekCapacity.set(w, c);
  }

  // People (withheld, not leaked, when the person cannot see employees).
  const peopleVisible = can(archetype, "employees.view");
  const employees = peopleVisible ? await listEmployees(ctx, archetype) : [];
  const skills = peopleVisible ? await listEmployeeSkills(ctx, archetype) : [];
  if (!peopleVisible) warnings.push("people withheld");
  const skillsByEmployee = new Map<string, string[]>();
  for (const s of skills) {
    skillsByEmployee.set(s.employeeId, [
      ...(skillsByEmployee.get(s.employeeId) ?? []),
      s.skillName,
    ]);
  }

  // Allocations for linked tasks; an assignee without allocation counts full time.
  const taskNodes = scheduled.filter((n) => n.recordType === "task" && n.recordId);
  const allocations = can(archetype, "tasks.view")
    ? await listTaskAllocations(
        ctx,
        archetype,
        taskNodes.map((n) => n.recordId!),
      )
    : [];
  const byTask = new Map<string, Array<{ employeeId: string; share: number }>>();
  for (const a of allocations) {
    byTask.set(a.taskId, [
      ...(byTask.get(a.taskId) ?? []),
      { employeeId: a.employeeId, share: a.sharePct / 100 },
    ]);
  }

  const people = new Map<string, CapacityPerson>();
  const personFor = (employeeId: string): CapacityPerson => {
    let p = people.get(employeeId);
    if (!p) {
      const e = employees.find((x) => x.id === employeeId);
      p = {
        employeeId,
        name: e?.name ?? (peopleVisible ? employeeId.slice(0, 8) : "restricted"),
        teamName: e?.teamName ?? null,
        skills: skillsByEmployee.get(employeeId) ?? [],
        cells: {},
        totalDemand: 0,
        totalCapacity: 0,
      };
      for (const w of weeks) {
        p.cells[w] = { demandDays: 0, capacityDays: weekCapacity.get(w) ?? 0, items: [] };
        p.totalCapacity += weekCapacity.get(w) ?? 0;
      }
      people.set(employeeId, p);
    }
    return p;
  };
  const unassigned: CapacityReport["unassigned"] = {};

  for (const n of scheduled) {
    const s = plan.byNode.get(n.id)!;
    if (s.durationDays === 0 || n.statusCategory === "done") continue;
    let shares = n.recordId ? (byTask.get(n.recordId) ?? []) : [];
    let implicit = false;
    if (shares.length === 0 && n.assigneeEmployeeId) {
      shares = [{ employeeId: n.assigneeEmployeeId, share: 1 }];
      implicit = true;
    }
    for (let d = s.earlyStart; d <= s.earlyFinish; d = addDays(d, 1)) {
      if (!isWorking(d)) continue;
      const w = weekStart(d);
      if (shares.length === 0) {
        const cell = (unassigned[w] ??= { demandDays: 0, items: [] });
        cell.demandDays = round(cell.demandDays + 1);
        if (!cell.items.some((i) => i.nodeId === n.id)) {
          cell.items.push({ nodeId: n.id, title: n.title, share: 1, implicit: false });
        }
        continue;
      }
      for (const sh of shares) {
        const p = personFor(sh.employeeId);
        const cell = p.cells[w]!;
        cell.demandDays = round(cell.demandDays + sh.share);
        p.totalDemand = round(p.totalDemand + sh.share);
        if (!cell.items.some((i) => i.nodeId === n.id)) {
          cell.items.push({ nodeId: n.id, title: n.title, share: sh.share, implicit });
        }
      }
    }
  }
  // Everyone visible appears, even with no demand (idle capacity is information).
  for (const e of employees) if (e.active) personFor(e.id);

  const overloads: CapacityReport["overloads"] = [];
  for (const p of people.values()) {
    for (const w of weeks) {
      const c = p.cells[w]!;
      if (c.demandDays > c.capacityDays + 1e-9) {
        overloads.push({
          employeeId: p.employeeId,
          week: w,
          demandDays: c.demandDays,
          capacityDays: c.capacityDays,
        });
      }
    }
  }
  const sorted = [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { weeks, people: sorted, unassigned, overloads, warnings };
}

// ── leveling: a proposal, never a move ───────────────────────────────────────

export type LevelingProposal = {
  nodeId: string;
  title: string;
  employeeId: string;
  week: string;
  fromStart: string;
  toStart: string;
  delayDays: number;
  floatDays: number;
  reason: string;
};

/**
 * Pure and deterministic: for each overloaded person-week, delay the task
 * with the most float by whole working weeks until the week clears or its
 * float is spent. Critical tasks are never moved; a week that cannot be
 * cleared without touching them is reported, not forced.
 */
export function proposeLeveling(
  report: CapacityReport,
  schedule: Map<
    string,
    { earlyStart: string; earlyFinish: string; totalFloatDays: number; critical: boolean }
  >,
  calendar: PlanSchedule["calendar"],
): { proposals: LevelingProposal[]; unresolved: CapacityReport["overloads"] } {
  const isWorking = workingDayTest(calendar);
  /** Working days an activity actually occupies inside one ISO week. */
  const daysInWeek = (s: { earlyStart: string; earlyFinish: string }, week: string): number => {
    let n = 0;
    for (let d = s.earlyStart; d <= s.earlyFinish; d = addDays(d, 1)) {
      if (isWorking(d) && weekStart(d) === week) n++;
    }
    return n;
  };
  const proposals: LevelingProposal[] = [];
  const unresolved: CapacityReport["overloads"] = [];
  const moved = new Set<string>();
  for (const o of report.overloads) {
    const person = report.people.find((p) => p.employeeId === o.employeeId);
    const cell = person?.cells[o.week];
    if (!person || !cell) continue;
    const candidates = cell.items
      .map((i) => ({ item: i, s: schedule.get(i.nodeId) }))
      .filter((c) => c.s && !c.s.critical && c.s.totalFloatDays > 0 && !moved.has(c.item.nodeId))
      .sort((a, b) => b.s!.totalFloatDays - a.s!.totalFloatDays);
    let excess = o.demandDays - o.capacityDays;
    for (const c of candidates) {
      if (excess <= 1e-9) break;
      const s = c.s!;
      // Delay to the Monday after this week, snapped to a working day, capped by float.
      let target = addDays(o.week, 7);
      while (!isWorking(target)) target = addDays(target, 1);
      let delay = 0;
      for (let d = s.earlyStart; d < target; d = addDays(d, 1)) if (isWorking(d)) delay++;
      if (delay <= 0) continue;
      if (delay > s.totalFloatDays) continue; // would go critical or late
      proposals.push({
        nodeId: c.item.nodeId,
        title: c.item.title,
        employeeId: o.employeeId,
        week: o.week,
        fromStart: s.earlyStart,
        toStart: target,
        delayDays: delay,
        floatDays: s.totalFloatDays,
        reason: `${person.name}: ${o.demandDays} of ${o.capacityDays} days in week ${o.week.slice(5)}`,
      });
      moved.add(c.item.nodeId);
      excess -= c.item.share * daysInWeek(s, o.week);
    }
    if (excess > 1e-9) unresolved.push(o);
  }
  return { proposals, unresolved };
}

export const LevelInput = z.object({
  planId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
});

/** Record the leveling proposal as a draft scenario (review, then apply). */
export async function levelIntoScenario(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ scenarioId: string; proposals: LevelingProposal[]; unresolved: number }> {
  assertCan(archetype, "scenario.manage");
  const input = LevelInput.parse(raw);
  const [report, plan] = await Promise.all([
    capacityForPlan(ctx, archetype, { planId: input.planId }),
    scheduleForPlan(ctx, archetype, { planId: input.planId }),
  ]);
  const { proposals, unresolved } = proposeLeveling(report, plan.byNode, plan.calendar);
  if (proposals.length === 0) {
    throw new StudioError(
      unresolved.length > 0
        ? "the overloads cannot be cleared within the float available; moving them would move the finish"
        : "nothing to level: no one is over capacity",
      "invalid_state",
    );
  }
  const { id } = await createScenario(ctx, archetype, {
    planId: input.planId,
    name: input.name,
    assumptions: [
      {
        text: `Leveling proposal from ${new Date().toISOString().slice(0, 10)}: ${proposals.length} move(s), ${unresolved.length} unresolved overload(s)`,
        confidence: "medium",
      },
    ],
  });
  for (const p of proposals) {
    await updateNode(ctx, archetype, { nodeId: p.nodeId, scenarioId: id, startDate: p.toStart });
  }
  return { scenarioId: id, proposals, unresolved: unresolved.length };
}
