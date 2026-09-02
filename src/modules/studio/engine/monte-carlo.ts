/**
 * H25G — Monte Carlo schedule risk over the CPM engine.
 *
 * Pure and deterministic: the same seed, sample count and inputs always give
 * the same answer, so a stored seed makes any run reproducible. Every task
 * that still has work ahead of it needs an explicit three-point estimate
 * (optimistic, most likely = its duration, pessimistic); where one is missing
 * the simulation REFUSES with the list of tasks, because inventing a spread
 * would be presenting a guess as a measurement. Finished tasks keep their
 * actual duration; milestones have none.
 *
 * Output is a distribution (P50/P80/P90, the chance of making the
 * deterministic date, each task's criticality index), never a single promised
 * date.
 */
import type { Calendar } from "@/platform/calendar/calendar";
import { computeSchedule, type ScheduleDep, type ScheduleTask } from "./cpm";

export type EstimatedTask = ScheduleTask & {
  optimisticDays: number | null;
  pessimisticDays: number | null;
};

export type SimulationOptions = {
  /** 100..5000; clamped. */
  samples: number;
  /** Any 32-bit integer; stored with the result so a rerun reproduces it. */
  seed: number;
  projectStart?: string;
};

export type Percentiles = { p50: string; p80: string; p90: string; min: string; max: string };

export type SimulationResult =
  | {
      ok: false;
      reason: "no_tasks" | "insufficient_estimates" | "unschedulable";
      /** Task ids lacking a usable three-point estimate. */
      missing: string[];
      warnings: string[];
    }
  | {
      ok: true;
      seed: number;
      samples: number;
      projectStart: string;
      /** The single-value CPM answer the distribution is measured against. */
      deterministicFinish: string;
      deterministicDurationDays: number;
      finish: Percentiles;
      durationDays: {
        p50: number;
        p80: number;
        p90: number;
        mean: number;
        min: number;
        max: number;
      };
      /** Share of samples finishing on or before the deterministic finish (0..1). */
      confidenceInDeterministic: number;
      /** Per task: share of samples in which it was critical (0..1). */
      criticality: Map<string, number>;
      /** Per task: finish percentiles. */
      finishByNode: Map<string, { p50: string; p80: string; p90: string }>;
      /** Samples the engine could not schedule (constraints made the network impossible). */
      failedSamples: number;
      warnings: string[];
    };

/** mulberry32: small, fast, good enough for schedule sampling; seedable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Triangular(a, m, b) by inverse CDF; a ≤ m ≤ b. */
export function triangular(u: number, a: number, m: number, b: number): number {
  if (b <= a) return a;
  const c = (m - a) / (b - a);
  return u < c ? a + Math.sqrt(u * (b - a) * (m - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - m));
}

function percentile<T>(sorted: T[], p: number): T {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

export function simulateSchedule(
  cal: Calendar,
  rawTasks: EstimatedTask[],
  deps: ScheduleDep[],
  options: SimulationOptions,
): SimulationResult {
  const samples = Math.max(100, Math.min(5000, Math.floor(options.samples)));
  const seed = options.seed | 0;
  const warnings: string[] = [];

  // The deterministic pass fixes which tasks are in play and their mode
  // (a task dated but not sized derives its duration from its window).
  const base = computeSchedule(cal, rawTasks, deps, { projectStart: options.projectStart });
  if (!base.ok || base.projectStart === null || base.projectFinish === null) {
    return {
      ok: false,
      reason: base.tasks.size === 0 ? "no_tasks" : "unschedulable",
      missing: [],
      warnings: base.warnings,
    };
  }

  const missing: string[] = [];
  const modes = new Map<string, number>();
  for (const t of rawTasks) {
    const sched = base.tasks.get(t.id);
    if (!sched) continue; // engine dropped it (no duration and no dates)
    const mode = sched.durationDays;
    modes.set(t.id, mode);
    if (t.isMilestone || mode === 0 || t.done) continue;
    const a = t.optimisticDays;
    const b = t.pessimisticDays;
    if (a === null || b === null || a > mode || b < mode || a < 0) missing.push(t.id);
  }
  if (missing.length > 0) {
    return { ok: false, reason: "insufficient_estimates", missing, warnings };
  }

  const rand = mulberry32(seed);
  const ids = [...base.tasks.keys()];
  const finishes: string[] = [];
  const durations: number[] = [];
  const criticalCount = new Map<string, number>(ids.map((id) => [id, 0]));
  const nodeFinish = new Map<string, string[]>(ids.map((id) => [id, []]));
  let failed = 0;

  for (let s = 0; s < samples; s++) {
    const drawn: ScheduleTask[] = rawTasks
      .filter((t) => base.tasks.has(t.id))
      .map((t) => {
        const mode = modes.get(t.id)!;
        if (t.isMilestone || mode === 0 || t.done) return { ...t, durationDays: mode };
        const d = triangular(rand(), t.optimisticDays!, mode, t.pessimisticDays!);
        return { ...t, durationDays: Math.max(0, Math.round(d)) };
      });
    const r = computeSchedule(cal, drawn, deps, { projectStart: base.projectStart });
    if (!r.ok || r.projectFinish === null) {
      failed++;
      continue;
    }
    finishes.push(r.projectFinish);
    durations.push(r.projectDurationDays);
    for (const [id, st] of r.tasks) {
      if (st.critical) criticalCount.set(id, (criticalCount.get(id) ?? 0) + 1);
      nodeFinish.get(id)?.push(st.earlyFinish);
    }
  }

  if (finishes.length === 0) {
    return { ok: false, reason: "unschedulable", missing: [], warnings };
  }
  finishes.sort();
  durations.sort((x, y) => x - y);
  const n = finishes.length;
  const good = n;
  const confidence = finishes.filter((f) => f <= base.projectFinish!).length / n;
  const criticality = new Map<string, number>();
  for (const [id, c] of criticalCount) criticality.set(id, c / good);
  const finishByNode = new Map<string, { p50: string; p80: string; p90: string }>();
  for (const [id, arr] of nodeFinish) {
    if (arr.length === 0) continue;
    arr.sort();
    finishByNode.set(id, {
      p50: percentile(arr, 0.5),
      p80: percentile(arr, 0.8),
      p90: percentile(arr, 0.9),
    });
  }
  if (failed > 0) warnings.push(`${failed} of ${samples} samples could not be scheduled`);

  return {
    ok: true,
    seed,
    samples,
    projectStart: base.projectStart,
    deterministicFinish: base.projectFinish,
    deterministicDurationDays: base.projectDurationDays,
    finish: {
      p50: percentile(finishes, 0.5),
      p80: percentile(finishes, 0.8),
      p90: percentile(finishes, 0.9),
      min: finishes[0]!,
      max: finishes[n - 1]!,
    },
    durationDays: {
      p50: percentile(durations, 0.5),
      p80: percentile(durations, 0.8),
      p90: percentile(durations, 0.9),
      mean: Math.round((durations.reduce((a, b) => a + b, 0) / n) * 10) / 10,
      min: durations[0]!,
      max: durations[n - 1]!,
    },
    confidenceInDeterministic: Math.round(confidence * 1000) / 1000,
    criticality,
    finishByNode,
    failedSamples: failed,
    warnings,
  };
}
