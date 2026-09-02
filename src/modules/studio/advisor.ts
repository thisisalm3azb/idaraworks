/**
 * H25M — controlled assistance in two tiers (ADR-11).
 *
 * Tier 1, deterministic: `reviewPlan` reads the one resolution (schedule
 * health, estimates, capacity, registers, scenarios, baselines) and returns
 * FINDINGS with the fact behind each and a suggested next step. A suggestion
 * is a pointer to an ordinary action the person runs themselves; nothing here
 * commits, moves, allocates, approves or posts anything.
 *
 * Tier 2, the A1 seam: `draftReviewNarrative` asks the platform's agent
 * provider to phrase the findings. The provider fails closed until the owner
 * provisions one, and the result is text for a person to read, never an
 * instruction the system acts on.
 */
import { z } from "zod";
import { assertCan } from "@/platform/authz";
import type { Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { AgentProviderDisabledError, getAgentProvider } from "@/platform/agents/provider";
import { scheduleForPlan, listBaselines } from "./schedule";
import { capacityForPlan } from "./capacity";
import { listScenarios } from "./scenarios";
import { listRegister } from "./registers";

export type Severity = "high" | "medium" | "low";

export type SuggestedAction =
  | { kind: "open_view"; view: string }
  | { kind: "select"; nodeId: string }
  | { kind: "open_scenarios" }
  | { kind: "level" }
  | { kind: "simulate" }
  | { kind: "capture_baseline" };

export type Finding = {
  key: string;
  severity: Severity;
  title: string;
  /** The fact, in words, with its numbers. */
  detail: string;
  nodeIds: string[];
  action?: SuggestedAction;
};

export const ReviewInput = z.object({
  planId: z.string().uuid(),
  scenarioId: z.string().uuid().optional(),
});

export async function reviewPlan(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ findings: Finding[]; basis: string[] }> {
  assertCan(archetype, "studio.view");
  const input = ReviewInput.parse(raw);
  const findings: Finding[] = [];
  const basis: string[] = [];

  const plan = await scheduleForPlan(ctx, archetype, {
    planId: input.planId,
    scenarioId: input.scenarioId,
  });
  const scheduled = plan.graph.nodes.filter((n) => plan.byNode.has(n.id));
  basis.push(`${scheduled.length} scheduled elements over the org calendar`);

  if (!plan.result.ok && plan.result.cycle.length > 0) {
    findings.push({
      key: "cycle",
      severity: "high",
      title: "The network has a cycle",
      detail: `${plan.result.cycle.length} elements depend on each other in a loop; nothing can be scheduled until one link is removed.`,
      nodeIds: plan.result.cycle,
      action: { kind: "open_view", view: "network" },
    });
    return { findings, basis };
  }
  if (scheduled.length === 0) {
    findings.push({
      key: "empty",
      severity: "low",
      title: "Nothing is scheduled yet",
      detail: "Give activities a duration or dates, and connect them, to get a schedule.",
      nodeIds: [],
      action: { kind: "open_view", view: "canvas" },
    });
    return { findings, basis };
  }

  const h = plan.result.health;
  if (h.negativeFloatCount > 0) {
    const ids = [...plan.byNode.entries()]
      .filter(([, s]) => s.totalFloatDays < 0)
      .map(([id]) => id);
    findings.push({
      key: "negative_float",
      severity: "high",
      title: "A deadline or constraint cannot be met",
      detail: `${h.negativeFloatCount} activities have negative float: their late dates fall before their early dates.`,
      nodeIds: ids,
      action: { kind: "open_view", view: "gantt" },
    });
  }
  if (h.missingLogicPct > 5) {
    findings.push({
      key: "missing_logic",
      severity: "medium",
      title: "Activities without logic",
      detail: `${h.missingLogicCount} of ${h.taskCount} (${Math.round(h.missingLogicPct)}%) have no predecessor and no successor; DCMA expects at most 5%.`,
      nodeIds: [],
      action: { kind: "open_view", view: "network" },
    });
  }
  if (h.hardConstraintPct > 5) {
    findings.push({
      key: "hard_constraints",
      severity: "low",
      title: "Many dated constraints",
      detail: `${h.hardConstraintCount} activities (${Math.round(h.hardConstraintPct)}%) carry dated constraints; the network, not dates, should drive most starts.`,
      nodeIds: [],
      action: { kind: "open_view", view: "table" },
    });
  }
  if (h.highFloatCount > 0 && h.highFloatPct > 5) {
    findings.push({
      key: "high_float",
      severity: "low",
      title: "Unusually high float",
      detail: `${h.highFloatCount} activities have more than 44 working days of float; check that their links are real.`,
      nodeIds: [],
      action: { kind: "open_view", view: "table" },
    });
  }
  if (plan.unscheduled.length > 0) {
    findings.push({
      key: "unscheduled",
      severity: "medium",
      title: "Elements the engine could not place",
      detail: plan.unscheduled
        .slice(0, 5)
        .map((u) => `${u.title}: ${u.reason}`)
        .join("; "),
      nodeIds: plan.unscheduled.map((u) => u.nodeId),
      action: { kind: "open_view", view: "table" },
    });
  }

  // Estimates: the simulation refuses without them.
  const open = scheduled.filter(
    (n) => n.statusCategory !== "done" && plan.byNode.get(n.id)!.durationDays > 0,
  );
  const missingEst = open.filter(
    (n) => n.estimateOptimisticDays === null || n.estimatePessimisticDays === null,
  );
  if (open.length > 0 && missingEst.length > 0) {
    findings.push({
      key: "estimates",
      severity: missingEst.length === open.length ? "medium" : "low",
      title: "Three-point estimates missing",
      detail: `${missingEst.length} of ${open.length} unfinished activities lack optimistic and pessimistic estimates, so schedule risk cannot be simulated.`,
      nodeIds: missingEst.map((n) => n.id),
      action: missingEst[0] ? { kind: "select", nodeId: missingEst[0].id } : undefined,
    });
  } else if (open.length > 0) {
    const scenarios = await listScenarios(ctx, archetype, input.planId);
    if (!scenarios.some((s) => s.simulation)) {
      findings.push({
        key: "no_simulation",
        severity: "low",
        title: "Estimates are in place but no simulation has run",
        detail:
          "Every activity has a three-point estimate; a Monte Carlo run would give P50/P80/P90 dates.",
        nodeIds: [],
        action: { kind: "simulate" },
      });
    }
  }

  // Capacity.
  try {
    const cap = await capacityForPlan(ctx, archetype, {
      planId: input.planId,
      scenarioId: input.scenarioId,
    });
    basis.push(`${cap.people.length} people, ${cap.weeks.length} weeks of demand`);
    if (cap.overloads.length > 0) {
      const names = [
        ...new Set(
          cap.overloads.map(
            (o) => cap.people.find((p) => p.employeeId === o.employeeId)?.name ?? "?",
          ),
        ),
      ];
      findings.push({
        key: "overloads",
        severity: "high",
        title: "People over capacity",
        detail: `${cap.overloads.length} person-weeks exceed calendar capacity (${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}).`,
        nodeIds: [],
        action: { kind: "level" },
      });
    }
    const unassigned = Object.values(cap.unassigned).reduce((s, c) => s + c.demandDays, 0);
    if (unassigned > 0) {
      findings.push({
        key: "unassigned",
        severity: "medium",
        title: "Work nobody owns",
        detail: `${unassigned} working days of scheduled activities have no one allocated or assigned.`,
        nodeIds: [
          ...new Set(Object.values(cap.unassigned).flatMap((c) => c.items.map((i) => i.nodeId))),
        ],
        action: { kind: "open_view", view: "workload" },
      });
    }
  } catch {
    basis.push("capacity not available for this role");
  }

  // Registers.
  const risks = await listRegister(ctx, archetype, {
    kind: "risk",
    planId: input.planId,
    status: "open",
    limit: 500,
  });
  const unscored = risks.rows.filter((r) => r.score === null);
  if (unscored.length > 0) {
    findings.push({
      key: "unscored_risks",
      severity: "medium",
      title: "Risks without a score",
      detail: `${unscored.length} of ${risks.total} open risks have no likelihood and impact, so they cannot be placed on the matrix.`,
      nodeIds: unscored.map((r) => r.id),
      action: { kind: "open_view", view: "risk" },
    });
  }
  const severe = risks.rows.filter(
    (r) => (r.score ?? 0) >= 15 && !(r.data.mitigation as string | undefined)?.trim(),
  );
  if (severe.length > 0) {
    findings.push({
      key: "severe_risks",
      severity: "high",
      title: "Severe risks without a mitigation",
      detail: `${severe.length} risks score 15 or more and carry no mitigation text.`,
      nodeIds: severe.map((r) => r.id),
      action: severe[0] ? { kind: "select", nodeId: severe[0].id } : undefined,
    });
  }
  const decisions = await listRegister(ctx, archetype, {
    kind: "decision",
    planId: input.planId,
    status: "open",
    limit: 500,
  });
  const today = new Date().toISOString().slice(0, 10);
  const overdue = decisions.rows.filter((d) => d.dueDate && d.dueDate < today);
  if (overdue.length > 0) {
    findings.push({
      key: "overdue_decisions",
      severity: "medium",
      title: "Decisions past their date",
      detail: `${overdue.length} open decisions are past their due date.`,
      nodeIds: overdue.map((d) => d.id),
      action: overdue[0] ? { kind: "select", nodeId: overdue[0].id } : undefined,
    });
  }

  // Governance of change.
  const baselines = await listBaselines(ctx, archetype, input.planId);
  if (baselines.length === 0) {
    findings.push({
      key: "no_baseline",
      severity: "low",
      title: "No baseline captured",
      detail:
        "Without a baseline, variance cannot be measured; capture one when the plan is agreed.",
      nodeIds: [],
      action: { kind: "capture_baseline" },
    });
  }
  const scen = await listScenarios(ctx, archetype, input.planId);
  const waiting = scen.filter((s) => s.status === "under_review");
  if (waiting.length > 0) {
    findings.push({
      key: "scenarios_waiting",
      severity: "low",
      title: "Scenarios awaiting a decision",
      detail: `${waiting.length} scenario(s) are under review: ${waiting
        .map((s) => s.name)
        .slice(0, 3)
        .join(", ")}.`,
      nodeIds: [],
      action: { kind: "open_scenarios" },
    });
  }

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { findings, basis };
}

export type Narrative =
  { available: true; text: string; provider: string } | { available: false; reason: string };

/** A1 seam: phrase the findings for a person. Fails closed; never acts. */
export async function draftReviewNarrative(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<Narrative> {
  assertCan(archetype, "studio.view");
  const input = ReviewInput.extend({ locale: z.enum(["en", "ar"]).default("en") }).parse(raw);
  const review = await reviewPlan(ctx, archetype, {
    planId: input.planId,
    scenarioId: input.scenarioId,
  });
  const provider = getAgentProvider();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await provider.complete(
      {
        agentId: "project",
        correlationId: `studio-review:${input.planId}:${Date.now()}`,
        locale: input.locale,
        system:
          "You summarise plan review findings for a manager. Report only what the findings say; propose no changes to records; do not invent numbers.",
        context: [
          {
            source: "read.work_overview",
            records: [{ type: "studio_plan", id: input.planId }],
            content: JSON.stringify({ findings: review.findings, basis: review.basis }),
          },
        ],
        input: "Summarise these findings in plain language, most severe first.",
        consultedToolIds: ["read.work_overview"],
      },
      { signal: controller.signal },
    );
    const text = typeof res.output === "string" ? res.output : JSON.stringify(res.output);
    return { available: true, text, provider: provider.name };
  } catch (err) {
    if (err instanceof AgentProviderDisabledError) {
      return { available: false, reason: "assistant not provisioned" };
    }
    return {
      available: false,
      reason: err instanceof Error ? err.message : "assistant unavailable",
    };
  } finally {
    clearTimeout(timer);
  }
}
