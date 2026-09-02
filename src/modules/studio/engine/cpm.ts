/**
 * H25D — the scheduling engine: forward/backward pass over WORKING days.
 *
 * Pure, deterministic TypeScript (ADR-5): plain inputs, no database, no
 * clock. The critical path is CALCULATED from the dependency network and the
 * working calendar — never colored by hand (mandate H25D). Method anchors:
 * PMI/Praxis CPM (ES/EF/LS/LF, TF = LS−ES, free float), DCMA 14-point
 * thresholds for the schedule-health checks (H25-EVIDENCE-LOG.md).
 *
 * Date model: every date is converted to a WORKING-DAY ORDINAL (count of
 * working days since an epoch). A task occupies `durationDays` working days;
 * start/finish ordinals are start-inclusive / finish-exclusive internally and
 * convert back to inclusive calendar dates at the end. Milestones have
 * duration 0 (start = finish). Non-working input dates snap forward to the
 * next working day, and the snap is REPORTED, never silent.
 */
import { addDays, isWorkingDay, weekdayOf, type Calendar } from "@/platform/calendar/calendar";

export type DepKind = "finish_to_start" | "start_to_start" | "finish_to_finish" | "start_to_finish";

export type ScheduleTask = {
  id: string;
  title?: string;
  /** Working days. Milestones use 0. Absent → derived from start/due dates. */
  durationDays: number | null;
  startDate: string | null;
  dueDate: string | null;
  isMilestone: boolean;
  constraintKind: "none" | "start_no_earlier" | "finish_no_later";
  constraintDate: string | null;
  deadlineDate: string | null;
  /** done tasks are pinned to their actual window. */
  done?: boolean;
};

export type ScheduleDep = {
  predecessorId: string;
  successorId: string;
  kind: DepKind;
  lagDays: number;
};

export type ScheduledTask = {
  id: string;
  earlyStart: string;
  earlyFinish: string;
  lateStart: string;
  lateFinish: string;
  durationDays: number;
  totalFloatDays: number;
  freeFloatDays: number;
  critical: boolean;
  deadlineBreachedDays: number | null;
};

export type ScheduleHealth = {
  taskCount: number;
  /** DCMA #1 missing logic: tasks with neither predecessor nor successor. */
  missingLogicCount: number;
  missingLogicPct: number;
  /** DCMA #8 hard constraints (dated constraints). */
  hardConstraintCount: number;
  hardConstraintPct: number;
  /** DCMA #6 high float: TF > 44 working days. */
  highFloatCount: number;
  highFloatPct: number;
  /** DCMA #7 negative float: must be zero in a credible schedule. */
  negativeFloatCount: number;
};

export type ScheduleResult = {
  ok: boolean;
  /** Task ids forming a dependency cycle (schedule refused when non-empty). */
  cycle: string[];
  tasks: Map<string, ScheduledTask>;
  projectStart: string | null;
  projectFinish: string | null;
  projectDurationDays: number;
  /** Every distinct zero-float driving chain, longest first (≤ 10 reported). */
  criticalPaths: string[][];
  /** Tasks that could not be scheduled, with the reason (truthfulness law). */
  unscheduled: Array<{ id: string; reason: string }>;
  /** Input repairs and notices — visible, never silent. */
  warnings: string[];
  health: ScheduleHealth;
};

const HIGH_FLOAT_THRESHOLD = 44; // working days, DCMA #6

/** Working-day ordinal machinery over a bounded window. */
class WorkdayIndex {
  private ordinals = new Map<string, number>();
  private dates: string[] = [];
  constructor(
    private cal: Calendar,
    epoch: string,
    horizonDays: number,
  ) {
    let cur = epoch;
    let guard = 0;
    while (this.dates.length < horizonDays && guard < horizonDays * 4 + 400) {
      if (isWorkingDay(cal, cur)) {
        this.ordinals.set(cur, this.dates.length);
        this.dates.push(cur);
      }
      cur = addDays(cur, 1);
      guard++;
    }
  }
  /** Ordinal of a date, snapping forward to the next working day. */
  toOrdinal(date: string): { ord: number; snapped: boolean } {
    let cur = date;
    let snapped = false;
    for (let i = 0; i < 400; i++) {
      const o = this.ordinals.get(cur);
      if (o !== undefined) return { ord: o, snapped };
      cur = addDays(cur, 1);
      snapped = true;
    }
    throw new Error(`date outside scheduling window: ${date}`);
  }
  toDate(ord: number): string {
    const clamped = Math.max(0, Math.min(ord, this.dates.length - 1));
    return this.dates[clamped]!;
  }
  get size(): number {
    return this.dates.length;
  }
}

export function computeSchedule(
  cal: Calendar,
  rawTasks: ScheduleTask[],
  rawDeps: ScheduleDep[],
  opts: { projectStart?: string } = {},
): ScheduleResult {
  const warnings: string[] = [];
  const unscheduled: Array<{ id: string; reason: string }> = [];

  if (![...cal.workingDays].length) {
    return emptyResult(["the calendar has no working days"], rawTasks);
  }

  // ── derive durations; drop tasks the engine cannot honestly place ─────────
  const tasks: Array<ScheduleTask & { dur: number }> = [];
  const known = new Set(rawTasks.map((t) => t.id));
  for (const t of rawTasks) {
    let dur = t.isMilestone ? 0 : t.durationDays;
    if (dur == null && t.startDate && t.dueDate && t.dueDate >= t.startDate) {
      // derive from the dated window (inclusive working days)
      dur = countWorkingDaysInclusive(cal, t.startDate, t.dueDate);
    }
    if (dur == null) {
      unscheduled.push({
        id: t.id,
        reason:
          t.startDate || t.dueDate ? "needs a duration or both dates" : "no duration and no dates",
      });
      continue;
    }
    tasks.push({ ...t, dur });
  }
  const deps = rawDeps.filter(
    (d) =>
      known.has(d.predecessorId) &&
      known.has(d.successorId) &&
      tasks.some((t) => t.id === d.predecessorId) &&
      tasks.some((t) => t.id === d.successorId),
  );

  if (tasks.length === 0) {
    return emptyResult(warnings, rawTasks, unscheduled);
  }

  // ── epoch + window ────────────────────────────────────────────────────────
  const datedInputs = tasks
    .flatMap((t) => [t.startDate, t.dueDate, t.constraintDate, t.deadlineDate])
    .filter((d): d is string => !!d);
  const epochCandidate = opts.projectStart ?? (datedInputs.length ? min(datedInputs) : null);
  if (!epochCandidate) {
    return emptyResult(
      ["no project start: give at least one task a date or pass projectStart"],
      rawTasks,
      unscheduled.concat(tasks.map((t) => ({ id: t.id, reason: "no anchor date in the plan" }))),
    );
  }
  const totalDur = tasks.reduce((s, t) => s + Math.max(1, t.dur), 0);
  const horizon = Math.min(Math.max(totalDur * 2 + 260, 400), 15000);
  const idx = new WorkdayIndex(cal, epochCandidate, horizon);

  const ord = (date: string, what: string): number => {
    const { ord, snapped } = idx.toOrdinal(date);
    if (snapped)
      warnings.push(`${what} ${date} falls on a non-working day — treated as the next working day`);
    return ord;
  };

  // ── adjacency + Kahn topological order (cycle detection) ─────────────────
  const succOf = new Map<string, ScheduleDep[]>();
  const predOf = new Map<string, ScheduleDep[]>();
  for (const d of deps) {
    succOf.set(d.predecessorId, [...(succOf.get(d.predecessorId) ?? []), d]);
    predOf.set(d.successorId, [...(predOf.get(d.successorId) ?? []), d]);
  }
  const indeg = new Map<string, number>(tasks.map((t) => [t.id, predOf.get(t.id)?.length ?? 0]));
  const queue = tasks.filter((t) => (indeg.get(t.id) ?? 0) === 0).map((t) => t.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const d of succOf.get(id) ?? []) {
      const left = (indeg.get(d.successorId) ?? 0) - 1;
      indeg.set(d.successorId, left);
      if (left === 0) queue.push(d.successorId);
    }
  }
  if (order.length !== tasks.length) {
    const inCycle = tasks.filter((t) => !order.includes(t.id)).map((t) => t.id);
    return { ...emptyResult(warnings, rawTasks, unscheduled), ok: false, cycle: inCycle };
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const projectStartOrd = 0;

  // ── forward pass: ES (inclusive start ordinal), EF = ES + dur (exclusive) ─
  const ES = new Map<string, number>();
  const EF = new Map<string, number>();
  for (const id of order) {
    const t = byId.get(id)!;
    let es = projectStartOrd;
    // done / explicitly dated tasks anchor at their own start.
    if (t.startDate) es = Math.max(es, ord(t.startDate, `task ${id} start`));
    if (t.done && t.startDate) es = ord(t.startDate, `task ${id} start`);
    if (t.constraintKind === "start_no_earlier" && t.constraintDate) {
      es = Math.max(es, ord(t.constraintDate, `task ${id} constraint`));
    }
    let ef = es + t.dur;
    for (const d of predOf.get(id) ?? []) {
      const p = byId.get(d.predecessorId)!;
      const pES = ES.get(p.id)!;
      const pEF = EF.get(p.id)!;
      const lag = d.lagDays;
      switch (d.kind) {
        case "finish_to_start":
          es = Math.max(es, pEF + lag);
          break;
        case "start_to_start":
          es = Math.max(es, pES + lag);
          break;
        case "finish_to_finish":
          ef = Math.max(ef, pEF + lag);
          break;
        case "start_to_finish":
          ef = Math.max(ef, pES + lag);
          break;
      }
    }
    ef = Math.max(ef, es + t.dur);
    es = ef - t.dur; // FF/SF pulls drag the start with them
    if (t.done && t.startDate) {
      es = ord(t.startDate, `task ${id} start`);
      ef = es + t.dur;
    }
    ES.set(id, es);
    EF.set(id, ef);
  }
  const projectEnd = Math.max(...[...EF.values()], projectStartOrd);

  // ── backward pass: LF (exclusive), LS = LF − dur ──────────────────────────
  const LF = new Map<string, number>();
  const LS = new Map<string, number>();
  for (const id of [...order].reverse()) {
    const t = byId.get(id)!;
    let lf = projectEnd;
    if (t.constraintKind === "finish_no_later" && t.constraintDate) {
      lf = Math.min(lf, ord(t.constraintDate, `task ${id} constraint`) + 1);
    }
    if (t.deadlineDate) {
      lf = Math.min(lf, ord(t.deadlineDate, `task ${id} deadline`) + 1);
    }
    for (const d of succOf.get(id) ?? []) {
      const sLS = LS.get(d.successorId)!;
      const sLF = LF.get(d.successorId)!;
      const lag = d.lagDays;
      switch (d.kind) {
        case "finish_to_start":
          lf = Math.min(lf, sLS - lag);
          break;
        case "start_to_start":
          lf = Math.min(lf, sLS - lag + t.dur);
          break;
        case "finish_to_finish":
          lf = Math.min(lf, sLF - lag);
          break;
        case "start_to_finish":
          lf = Math.min(lf, sLF - lag + t.dur);
          break;
      }
    }
    LF.set(id, lf);
    LS.set(id, lf - t.dur);
  }

  // ── floats, criticality, free float ───────────────────────────────────────
  const out = new Map<string, ScheduledTask>();
  for (const t of tasks) {
    const es = ES.get(t.id)!;
    const ef = EF.get(t.id)!;
    const ls = LS.get(t.id)!;
    const lf = LF.get(t.id)!;
    const tf = ls - es;
    let ff = projectEnd - ef;
    for (const d of succOf.get(t.id) ?? []) {
      const sES = ES.get(d.successorId)!;
      const sEF = EF.get(d.successorId)!;
      switch (d.kind) {
        case "finish_to_start":
          ff = Math.min(ff, sES - d.lagDays - ef);
          break;
        case "start_to_start":
          ff = Math.min(ff, sES - d.lagDays - es);
          break;
        case "finish_to_finish":
          ff = Math.min(ff, sEF - d.lagDays - ef);
          break;
        case "start_to_finish":
          ff = Math.min(ff, sEF - d.lagDays - es);
          break;
      }
    }
    const deadlineBreach =
      t.deadlineDate != null ? Math.max(0, ef - (idx.toOrdinal(t.deadlineDate).ord + 1)) : null;
    out.set(t.id, {
      id: t.id,
      earlyStart: idx.toDate(es),
      earlyFinish: idx.toDate(Math.max(es, ef - 1)),
      lateStart: idx.toDate(ls),
      lateFinish: idx.toDate(Math.max(ls, lf - 1)),
      durationDays: t.dur,
      totalFloatDays: tf,
      freeFloatDays: Math.min(ff, tf),
      critical: tf <= 0,
      deadlineBreachedDays: deadlineBreach,
    });
  }

  // ── critical paths: walk driving links through critical tasks ─────────────
  const driving = (d: ScheduleDep): boolean => {
    const pES = ES.get(d.predecessorId)!;
    const pEF = EF.get(d.predecessorId)!;
    const sES = ES.get(d.successorId)!;
    const sEF = EF.get(d.successorId)!;
    switch (d.kind) {
      case "finish_to_start":
        return sES === pEF + d.lagDays;
      case "start_to_start":
        return sES === pES + d.lagDays;
      case "finish_to_finish":
        return sEF === pEF + d.lagDays;
      case "start_to_finish":
        return sEF === pES + d.lagDays;
    }
  };
  const criticalIds = new Set([...out.values()].filter((t) => t.critical).map((t) => t.id));
  const startsOfPaths = [...criticalIds].filter(
    (id) => !(predOf.get(id) ?? []).some((d) => criticalIds.has(d.predecessorId) && driving(d)),
  );
  const criticalPaths: string[][] = [];
  for (const start of startsOfPaths) {
    const paths = walkCritical(start, succOf, criticalIds, driving);
    for (const p of paths) {
      criticalPaths.push(p);
      if (criticalPaths.length >= 10) break;
    }
    if (criticalPaths.length >= 10) break;
  }
  criticalPaths.sort((a, b) => b.length - a.length);

  // ── DCMA-style health ─────────────────────────────────────────────────────
  const linked = new Set<string>();
  for (const d of deps) {
    linked.add(d.predecessorId);
    linked.add(d.successorId);
  }
  const missingLogic = tasks.filter((t) => !linked.has(t.id)).length;
  const hardConstraints = tasks.filter((t) => t.constraintKind !== "none").length;
  const highFloat = [...out.values()].filter((t) => t.totalFloatDays > HIGH_FLOAT_THRESHOLD).length;
  const negativeFloat = [...out.values()].filter((t) => t.totalFloatDays < 0).length;
  const n = tasks.length;

  return {
    ok: true,
    cycle: [],
    tasks: out,
    projectStart: idx.toDate(Math.min(...[...ES.values()])),
    projectFinish: idx.toDate(
      Math.max(0, ...tasks.map((t) => Math.max(ES.get(t.id)!, EF.get(t.id)! - 1))),
    ),
    projectDurationDays: projectEnd - Math.min(...[...ES.values()]),
    criticalPaths,
    unscheduled,
    warnings: dedupe(warnings),
    health: {
      taskCount: n,
      missingLogicCount: missingLogic,
      missingLogicPct: pct(missingLogic, n),
      hardConstraintCount: hardConstraints,
      hardConstraintPct: pct(hardConstraints, n),
      highFloatCount: highFloat,
      highFloatPct: pct(highFloat, n),
      negativeFloatCount: negativeFloat,
    },
  };
}

function walkCritical(
  start: string,
  succOf: Map<string, ScheduleDep[]>,
  critical: Set<string>,
  driving: (d: ScheduleDep) => boolean,
): string[][] {
  const results: string[][] = [];
  const stack: Array<{ id: string; path: string[] }> = [{ id: start, path: [start] }];
  let guard = 0;
  while (stack.length && results.length < 10 && guard < 10000) {
    guard++;
    const { id, path } = stack.pop()!;
    const nexts = (succOf.get(id) ?? []).filter(
      (d) => critical.has(d.successorId) && driving(d) && !path.includes(d.successorId),
    );
    if (nexts.length === 0) {
      results.push(path);
      continue;
    }
    for (const d of nexts) {
      stack.push({ id: d.successorId, path: [...path, d.successorId] });
    }
  }
  return results;
}

function countWorkingDaysInclusive(cal: Calendar, from: string, to: string): number {
  let count = 0;
  let cur = from;
  let guard = 0;
  while (cur <= to && guard < 3660) {
    if (isWorkingDay(cal, cur)) count++;
    cur = addDays(cur, 1);
    guard++;
  }
  return Math.max(count, 1);
}

function min(dates: string[]): string {
  return dates.reduce((a, b) => (b < a ? b : a));
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function emptyResult(
  warnings: string[],
  rawTasks: ScheduleTask[],
  unscheduled: Array<{ id: string; reason: string }> = [],
): ScheduleResult {
  return {
    ok: true,
    cycle: [],
    tasks: new Map(),
    projectStart: null,
    projectFinish: null,
    projectDurationDays: 0,
    criticalPaths: [],
    unscheduled,
    warnings,
    health: {
      taskCount: rawTasks.length,
      missingLogicCount: 0,
      missingLogicPct: 0,
      hardConstraintCount: 0,
      hardConstraintPct: 0,
      highFloatCount: 0,
      highFloatPct: 0,
      negativeFloatCount: 0,
    },
  };
}

export { weekdayOf };
