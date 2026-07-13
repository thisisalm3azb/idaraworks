/**
 * U7 progress model (doc 01 D-1.4 — DERIVED, never stored): stage weights are
 * the progress math; completed = 1, in_progress = 0.5 (the U7 heuristic),
 * not_started = 0; SKIPPED stages leave the denominator (a 13S without
 * Upholstery renormalizes over the remaining 93 weight). Tasks never feed
 * this. progress_override (auditable who/when/why) overrides DISPLAY only and
 * surfaces as a chip — never silently (D-1.4).
 */
export type StageForProgress = {
  weight: number;
  status: "not_started" | "in_progress" | "completed" | "skipped";
};

const FACTOR: Record<StageForProgress["status"], number> = {
  completed: 1,
  in_progress: 0.5,
  not_started: 0,
  skipped: 0,
};

/** Derived percent 0–100 (1dp), or null when every stage is skipped/absent. */
export function computeProgress(stages: readonly StageForProgress[]): number | null {
  let num = 0;
  let denom = 0;
  for (const s of stages) {
    if (s.status === "skipped") continue;
    denom += s.weight;
    num += s.weight * FACTOR[s.status];
  }
  if (denom === 0) return null;
  return Math.round((num / denom) * 1000) / 10;
}

/** Display progress: the override wins when set (with its chip), else derived. */
export function displayProgress(
  stages: readonly StageForProgress[],
  override: number | null,
): { percent: number | null; overridden: boolean } {
  if (override !== null) return { percent: override, overridden: true };
  return { percent: computeProgress(stages), overridden: false };
}

/**
 * The sanctioned denormalisation (doc 01): current stage = the earliest
 * in_progress stage by template order; else the earliest not_started; null
 * when nothing remains (all completed/skipped).
 */
export function currentStage<T extends StageForProgress & { sort: number }>(
  stages: readonly T[],
): T | null {
  const ordered = [...stages].sort((a, b) => a.sort - b.sort);
  return (
    ordered.find((s) => s.status === "in_progress") ??
    ordered.find((s) => s.status === "not_started") ??
    null
  );
}
