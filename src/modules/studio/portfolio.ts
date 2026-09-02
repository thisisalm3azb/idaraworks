/**
 * H25I — the portfolio: every plan of the organisation on one page, each
 * summarised from its own resolution (finish, critical chain, DCMA health,
 * capacity, open governance) and scored TRANSPARENTLY: the score is the sum
 * of three named components, each shown with the fact it came from, so a
 * manager can argue with it. Plans that cannot be scored say why.
 */
import { assertCan } from "@/platform/authz";
import type { Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { listStudioPlans, type StudioPlanRow } from "./graph";
import { scheduleForPlan } from "./schedule";
import { capacityForPlan } from "./capacity";
import { listScenarios } from "./scenarios";
import { listRegister } from "./registers";

export type ScoreComponent = {
  key: "schedule" | "risk" | "capacity";
  points: number;
  max: number;
  /** The fact behind the points, in words. */
  basis: string;
};

export type PortfolioRow = {
  plan: StudioPlanRow;
  scheduled: number;
  projectStart: string | null;
  projectFinish: string | null;
  durationDays: number | null;
  criticalCount: number;
  missingLogicPct: number | null;
  negativeFloat: number;
  overloads: number;
  unassignedDays: number;
  openRisks: number;
  unscoredRisks: number;
  scenariosUnderReview: number;
  /** null when the plan has nothing scheduled: there is nothing to score. */
  score: number | null;
  components: ScoreComponent[];
  warnings: string[];
};

const MAX_PLANS = 50;

export async function portfolioSummary(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<{ rows: PortfolioRow[]; truncated: boolean }> {
  assertCan(archetype, "studio.view");
  const plans = await listStudioPlans(ctx, archetype);
  const rows: PortfolioRow[] = [];
  for (const plan of plans.slice(0, MAX_PLANS)) {
    const warnings: string[] = [];
    const sched = await scheduleForPlan(ctx, archetype, { planId: plan.id });
    const scheduled = sched.byNode.size;
    const critical = new Set(sched.result.criticalPaths.flat());
    let overloads = 0;
    let unassignedDays = 0;
    try {
      const cap = await capacityForPlan(ctx, archetype, { planId: plan.id });
      overloads = cap.overloads.length;
      unassignedDays = Object.values(cap.unassigned).reduce((s, c) => s + c.demandDays, 0);
      if (cap.warnings.includes("people withheld")) warnings.push("people withheld");
    } catch {
      warnings.push("capacity unavailable");
    }
    const [risks, scenarios] = await Promise.all([
      listRegister(ctx, archetype, { kind: "risk", planId: plan.id, status: "open", limit: 500 }),
      listScenarios(ctx, archetype, plan.id),
    ]);
    const unscored = risks.rows.filter((r) => r.score === null).length;
    const underReview = scenarios.filter((s) => s.status === "under_review").length;
    const health = sched.result.health;

    let score: number | null = null;
    const components: ScoreComponent[] = [];
    if (scheduled > 0) {
      // Schedule (40): a credible network — logic present, no negative float.
      let schedulePts = 40;
      const logicPenalty = Math.min(20, Math.round(health.missingLogicPct / 5));
      schedulePts -= logicPenalty;
      const negPenalty = Math.min(20, health.negativeFloatCount * 10);
      schedulePts -= negPenalty;
      components.push({
        key: "schedule",
        points: Math.max(0, schedulePts),
        max: 40,
        basis: `${Math.round(health.missingLogicPct)}% without logic (−${logicPenalty}), ${health.negativeFloatCount} with negative float (−${negPenalty})`,
      });
      // Risk (30): risks known and scored.
      let riskPts = 30;
      const unscoredPenalty = Math.min(15, unscored * 5);
      const highPenalty = Math.min(15, risks.rows.filter((r) => (r.score ?? 0) >= 15).length * 5);
      riskPts -= unscoredPenalty + highPenalty;
      components.push({
        key: "risk",
        points: Math.max(0, riskPts),
        max: 30,
        basis: `${risks.total} open, ${unscored} unscored (−${unscoredPenalty}), ${risks.rows.filter((r) => (r.score ?? 0) >= 15).length} scored 15+ (−${highPenalty})`,
      });
      // Capacity (30): people not overloaded, work owned.
      let capPts = 30;
      const overloadPenalty = Math.min(20, overloads * 5);
      const unassignedPenalty = Math.min(10, Math.round(unassignedDays / 5));
      capPts -= overloadPenalty + unassignedPenalty;
      components.push({
        key: "capacity",
        points: Math.max(0, capPts),
        max: 30,
        basis: `${overloads} overloaded person-weeks (−${overloadPenalty}), ${unassignedDays} unassigned days (−${unassignedPenalty})`,
      });
      score = components.reduce((s, c) => s + c.points, 0);
    } else {
      warnings.push("nothing scheduled");
    }

    rows.push({
      plan,
      scheduled,
      projectStart: sched.result.projectStart,
      projectFinish: sched.result.projectFinish,
      durationDays: scheduled > 0 ? sched.result.projectDurationDays : null,
      criticalCount: critical.size,
      missingLogicPct: scheduled > 0 ? Math.round(health.missingLogicPct) : null,
      negativeFloat: health.negativeFloatCount,
      overloads,
      unassignedDays,
      openRisks: risks.total,
      unscoredRisks: unscored,
      scenariosUnderReview: underReview,
      score,
      components,
      warnings,
    });
  }
  // Attention first: lowest score, then unscored plans.
  rows.sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
  return { rows, truncated: plans.length > MAX_PLANS };
}
