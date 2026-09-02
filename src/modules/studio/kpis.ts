/**
 * H25J — the governed KPI catalogue.
 *
 * A closed registry of indicators, each with a stated basis and a formula
 * computed from canonical data (the schedule, baselines, capacity,
 * scenarios, registers). An indicator that lacks its inputs reports
 * "insufficient" with the reason; it never reports zero as if measured.
 * A `kpi` element on a canvas points at a catalogue key and shows the live
 * value of that key; it holds no number of its own.
 */
import { z } from "zod";
import { assertCan } from "@/platform/authz";
import type { Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { scheduleForPlan, listBaselines } from "./schedule";
import { capacityForPlan } from "./capacity";
import { listScenarios } from "./scenarios";
import { listRegister } from "./registers";

export type KpiUnit = "days" | "count" | "percent" | "date" | "ratio";

export type KpiDefinition = {
  key: string;
  name: string;
  unit: KpiUnit;
  /** Plain words: what is counted and how. */
  basis: string;
  /** Lower is better, higher is better, or a date/target. */
  direction: "lower" | "higher" | "neutral";
};

export const KPI_CATALOGUE: readonly KpiDefinition[] = [
  {
    key: "plan.finish",
    name: "Planned finish",
    unit: "date",
    basis: "The engine's early finish over the org calendar (latest displayed finish).",
    direction: "neutral",
  },
  {
    key: "plan.duration_days",
    name: "Critical path length",
    unit: "days",
    basis: "Working days from the earliest start to the finish along the critical chain.",
    direction: "lower",
  },
  {
    key: "plan.finish_variance_days",
    name: "Finish variance vs baseline",
    unit: "days",
    basis:
      "Working days between the latest baseline's finish and today's planned finish; positive is later.",
    direction: "lower",
  },
  {
    key: "plan.missing_logic_pct",
    name: "Activities without logic",
    unit: "percent",
    basis: "DCMA: share of scheduled activities with no predecessor and no successor.",
    direction: "lower",
  },
  {
    key: "plan.negative_float",
    name: "Activities with negative float",
    unit: "count",
    basis:
      "Activities whose late dates fall before their early dates (a deadline or constraint cannot be met).",
    direction: "lower",
  },
  {
    key: "plan.estimate_coverage_pct",
    name: "Three-point estimate coverage",
    unit: "percent",
    basis:
      "Share of unfinished scheduled activities carrying optimistic and pessimistic estimates.",
    direction: "higher",
  },
  {
    key: "plan.confidence_p80",
    name: "P80 finish",
    unit: "date",
    basis:
      "From the most recent stored Monte Carlo run on this plan's scenarios: the date 80% of samples finished by.",
    direction: "neutral",
  },
  {
    key: "capacity.overloaded_person_weeks",
    name: "Overloaded person-weeks",
    unit: "count",
    basis: "Person-weeks where allocated demand exceeds calendar capacity.",
    direction: "lower",
  },
  {
    key: "capacity.unassigned_days",
    name: "Unassigned work",
    unit: "days",
    basis: "Working days of scheduled activities with nobody allocated or assigned.",
    direction: "lower",
  },
  {
    key: "register.open_risks",
    name: "Open risks",
    unit: "count",
    basis: "Risk elements not done or dropped, across the plan.",
    direction: "lower",
  },
  {
    key: "register.unscored_risks",
    name: "Unscored risks",
    unit: "count",
    basis: "Open risks without a validated likelihood and impact.",
    direction: "lower",
  },
  {
    key: "register.open_decisions",
    name: "Open decisions",
    unit: "count",
    basis: "Decision elements not done or dropped.",
    direction: "lower",
  },
  {
    key: "scenario.under_review",
    name: "Scenarios awaiting a decision",
    unit: "count",
    basis: "Scenarios submitted and not yet approved, applied or discarded.",
    direction: "neutral",
  },
] as const;

export type KpiValue =
  | { key: string; status: "ok"; value: number | string; unit: KpiUnit; basis: string }
  | { key: string; status: "insufficient"; reason: string; unit: KpiUnit; basis: string };

export const KpiInput = z.object({
  planId: z.string().uuid(),
  scenarioId: z.string().uuid().optional(),
  keys: z.array(z.string()).max(50).optional(),
});

/** Every catalogue indicator for one plan, each with its basis; nothing invented. */
export async function computeKpis(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<KpiValue[]> {
  assertCan(archetype, "studio.view");
  const input = KpiInput.parse(raw);
  const wanted = new Set(input.keys ?? KPI_CATALOGUE.map((k) => k.key));
  const defs = KPI_CATALOGUE.filter((k) => wanted.has(k.key));
  const out: KpiValue[] = [];
  const ok = (d: KpiDefinition, value: number | string): KpiValue => ({
    key: d.key,
    status: "ok",
    value,
    unit: d.unit,
    basis: d.basis,
  });
  const no = (d: KpiDefinition, reason: string): KpiValue => ({
    key: d.key,
    status: "insufficient",
    reason,
    unit: d.unit,
    basis: d.basis,
  });

  const plan = await scheduleForPlan(ctx, archetype, {
    planId: input.planId,
    scenarioId: input.scenarioId,
  });
  const scheduled = [...plan.byNode.values()];
  const needCapacity = defs.some((d) => d.key.startsWith("capacity."));
  const capacity = needCapacity
    ? await capacityForPlan(ctx, archetype, { planId: input.planId, scenarioId: input.scenarioId })
    : null;
  const needScenarios = defs.some(
    (d) => d.key === "scenario.under_review" || d.key === "plan.confidence_p80",
  );
  const scenarios = needScenarios ? await listScenarios(ctx, archetype, input.planId) : [];

  for (const d of defs) {
    switch (d.key) {
      case "plan.finish":
        out.push(
          plan.result.projectFinish ? ok(d, plan.result.projectFinish) : no(d, "nothing scheduled"),
        );
        break;
      case "plan.duration_days":
        out.push(
          plan.result.ok && scheduled.length > 0
            ? ok(d, plan.result.projectDurationDays)
            : no(d, "nothing scheduled"),
        );
        break;
      case "plan.finish_variance_days": {
        const baselines = await listBaselines(ctx, archetype, input.planId);
        if (baselines.length === 0) {
          out.push(no(d, "no baseline captured"));
          break;
        }
        const withBaseline = await scheduleForPlan(ctx, archetype, {
          planId: input.planId,
          scenarioId: input.scenarioId,
          baselineId: baselines[0]!.id,
        });
        const cmp = withBaseline.baseline;
        if (!cmp || cmp.variance.size === 0) {
          out.push(no(d, "baseline holds no scheduled activities"));
          break;
        }
        const latest = [...cmp.variance.values()].reduce(
          (m, v) => Math.max(m, v.finishVarianceDays),
          Number.NEGATIVE_INFINITY,
        );
        out.push(ok(d, latest));
        break;
      }
      case "plan.missing_logic_pct":
        out.push(
          scheduled.length > 0
            ? ok(d, Math.round(plan.result.health.missingLogicPct))
            : no(d, "nothing scheduled"),
        );
        break;
      case "plan.negative_float":
        out.push(
          scheduled.length > 0
            ? ok(d, plan.result.health.negativeFloatCount)
            : no(d, "nothing scheduled"),
        );
        break;
      case "plan.estimate_coverage_pct": {
        const open = plan.graph.nodes.filter(
          (n) =>
            plan.byNode.has(n.id) &&
            n.statusCategory !== "done" &&
            plan.byNode.get(n.id)!.durationDays > 0,
        );
        if (open.length === 0) {
          out.push(no(d, "no unfinished activities"));
          break;
        }
        const covered = open.filter(
          (n) => n.estimateOptimisticDays !== null && n.estimatePessimisticDays !== null,
        ).length;
        out.push(ok(d, Math.round((covered / open.length) * 100)));
        break;
      }
      case "plan.confidence_p80": {
        const runs = scenarios
          .filter((s) => s.simulation)
          .sort((a, b) => (a.simulation!.ranAt < b.simulation!.ranAt ? 1 : -1));
        out.push(
          runs[0] ? ok(d, runs[0].simulation!.finish.p80) : no(d, "no simulation run stored"),
        );
        break;
      }
      case "capacity.overloaded_person_weeks":
        out.push(
          capacity && capacity.weeks.length > 0
            ? ok(d, capacity.overloads.length)
            : no(
                d,
                capacity?.warnings.includes("people withheld")
                  ? "people withheld"
                  : "nothing scheduled",
              ),
        );
        break;
      case "capacity.unassigned_days":
        out.push(
          capacity && capacity.weeks.length > 0
            ? ok(
                d,
                Object.values(capacity.unassigned).reduce((s, c) => s + c.demandDays, 0),
              )
            : no(d, "nothing scheduled"),
        );
        break;
      case "register.open_risks": {
        const r = await listRegister(ctx, archetype, {
          kind: "risk",
          planId: input.planId,
          status: "open",
          limit: 500,
        });
        out.push(ok(d, r.total));
        break;
      }
      case "register.unscored_risks": {
        const r = await listRegister(ctx, archetype, {
          kind: "risk",
          planId: input.planId,
          status: "open",
          limit: 500,
        });
        out.push(ok(d, r.rows.filter((x) => x.score === null).length));
        break;
      }
      case "register.open_decisions": {
        const r = await listRegister(ctx, archetype, {
          kind: "decision",
          planId: input.planId,
          status: "open",
          limit: 500,
        });
        out.push(ok(d, r.total));
        break;
      }
      case "scenario.under_review":
        out.push(ok(d, scenarios.filter((s) => s.status === "under_review").length));
        break;
      default:
        out.push(no(d, "not computed"));
    }
  }
  return out;
}
