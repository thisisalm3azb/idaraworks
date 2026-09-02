/**
 * H25G — the scenario laboratory.
 *
 * A scenario is an OVERLAY on the one living plan (ADR-7): edits made while a
 * scenario is active land in `studio_scenario_change`, the resolution applies
 * them on top of the live plan, and nothing canonical moves until an
 * authorized APPLY replays the approved changes through the owning services.
 *
 * Lifecycle: draft → under_review (submitted to the approval engine as a
 * `scenario_apply` subject) → approved → applied; or → discarded at any point
 * before apply. Approval only makes a scenario applicable; applying is its own
 * command with its own permission (scenario.apply), and it refuses when the
 * live plan has drifted from the values the scenario was built on.
 *
 * Monte Carlo runs are reproducible (stored seed + sample count) and refuse
 * without explicit three-point estimates. A forecast is never shown as a
 * date; it is a distribution.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { loadCalendar, workingDaysBetween } from "@/platform/calendar/calendar";
import { submitForApproval, supersedeApprovalsForSubjectIn } from "@/modules/approvals/service";
import { FIELD_TO_PROP, StudioError } from "./types";
import { resolvePlanGraph, type EffectiveNode, type ResolvedGraph } from "./resolve";
import { scheduleGraph, toScheduleInputs } from "./schedule";
import { updateNode } from "./graph";
import { simulateSchedule, type SimulationResult } from "./engine/monte-carlo";

// ── shapes ───────────────────────────────────────────────────────────────────

export const SCENARIO_STATUSES = [
  "draft",
  "under_review",
  "approved",
  "applied",
  "discarded",
] as const;
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number];

const Assumption = z.object({
  text: z.string().trim().min(1).max(500),
  confidence: z.enum(["low", "medium", "high"]),
  owner: z.string().trim().max(200).optional(),
});
export type Assumption = z.infer<typeof Assumption>;

const Decision = z.object({
  question: z.string().trim().max(1000).optional(),
  recommendation: z.string().trim().max(4000).optional(),
  decision: z.string().trim().max(4000).optional(),
  rationale: z.string().trim().max(4000).optional(),
});
export type DecisionRecord = z.infer<typeof Decision>;

/** What is persisted from a run: enough to reproduce and to summarise. */
export type StoredSimulation = {
  seed: number;
  samples: number;
  ranAt: string;
  deterministicFinish: string;
  finish: { p50: string; p80: string; p90: string; min: string; max: string };
  confidenceInDeterministic: number;
  /** Top criticality indexes, node id → 0..1 (at most 20 entries). */
  criticality: Record<string, number>;
  warnings: string[];
};

export type ScenarioRow = {
  id: string;
  planId: string;
  name: string;
  description: string | null;
  status: ScenarioStatus;
  isShared: boolean;
  assumptions: Assumption[];
  simulation: StoredSimulation | null;
  decision: DecisionRecord;
  baseCapturedAt: string;
  appliedAt: string | null;
  appliedBy: string | null;
  rowVersion: number;
  createdBy: string;
  createdAt: string;
  changeCount: number;
};

type Raw = {
  id: string;
  plan_id: string;
  name: string;
  description: string | null;
  status: ScenarioStatus;
  is_shared: boolean;
  assumptions: unknown;
  simulation: unknown;
  decision: unknown;
  base_captured_at: string;
  applied_at: string | null;
  applied_by: string | null;
  row_version: string | number;
  created_by: string;
  created_at: string;
  change_count: string | number;
};

function mapRow(r: Raw): ScenarioRow {
  const sim =
    r.simulation && typeof r.simulation === "object" ? (r.simulation as StoredSimulation) : null;
  return {
    id: r.id,
    planId: r.plan_id,
    name: r.name,
    description: r.description,
    status: r.status,
    isShared: r.is_shared,
    assumptions: Array.isArray(r.assumptions) ? (r.assumptions as Assumption[]) : [],
    simulation: sim && typeof sim.seed === "number" ? sim : null,
    decision: r.decision && typeof r.decision === "object" ? (r.decision as DecisionRecord) : {},
    baseCapturedAt: r.base_captured_at,
    appliedAt: r.applied_at,
    appliedBy: r.applied_by,
    rowVersion: Number(r.row_version),
    createdBy: r.created_by,
    createdAt: r.created_at,
    changeCount: Number(r.change_count),
  };
}

const SELECT = sql`
  select s.id::text as id, s.plan_id::text as plan_id, s.name, s.description, s.status,
         s.is_shared, s.assumptions, s.simulation, s.decision,
         s.base_captured_at::text as base_captured_at, s.applied_at::text as applied_at,
         s.applied_by::text as applied_by, s.row_version, s.created_by::text as created_by,
         s.created_at::text as created_at,
         (select count(*) from public.studio_scenario_change c
           where c.org_id = s.org_id and c.scenario_id = s.id) as change_count
  from public.studio_scenario s
`;

async function scenarioIn(tx: TenantTx, ctx: Ctx, id: string): Promise<ScenarioRow> {
  const rows = (await tx.execute(sql`
    ${SELECT} where s.org_id = ${ctx.orgId} and s.id = ${id}
  `)) as unknown as Raw[];
  if (!rows[0]) throw new StudioError("scenario not found", "not_found");
  return mapRow(rows[0]);
}

// ── create / list / read / update ────────────────────────────────────────────

export const CreateScenarioInput = z.object({
  planId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  isShared: z.boolean().optional(),
  assumptions: z.array(Assumption).max(50).optional(),
});

export async function createScenario(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "scenario.manage");
  const input = CreateScenarioInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "studio.scenario.create",
        entityType: "studio_scenario",
        entityId: r.id,
        summary: `Branched scenario "${input.name}"`,
      }),
    },
    async (tx) => {
      const plan = (await tx.execute(sql`
        select id from public.studio_plan where org_id = ${ctx.orgId} and id = ${input.planId}
      `)) as unknown as Array<{ id: string }>;
      if (!plan[0]) throw new StudioError("plan not found", "not_found");
      const rows = (await tx.execute(sql`
        insert into public.studio_scenario
          (org_id, plan_id, name, description, is_shared, assumptions, created_by)
        values (${ctx.orgId}, ${input.planId}, ${input.name}, ${input.description ?? null},
                ${input.isShared ?? false}, ${JSON.stringify(input.assumptions ?? [])}::jsonb,
                ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export async function listScenarios(
  ctx: Ctx,
  archetype: RoleArchetype,
  planId: string,
): Promise<ScenarioRow[]> {
  assertCan(archetype, "studio.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      ${SELECT} where s.org_id = ${ctx.orgId} and s.plan_id = ${planId}
      order by s.created_at desc
    `),
  )) as unknown as Raw[];
  return rows.map(mapRow);
}

export async function getScenario(
  ctx: Ctx,
  archetype: RoleArchetype,
  scenarioId: string,
): Promise<ScenarioRow | null> {
  assertCan(archetype, "studio.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`${SELECT} where s.org_id = ${ctx.orgId} and s.id = ${scenarioId}`),
  )) as unknown as Raw[];
  return rows[0] ? mapRow(rows[0]) : null;
}

export const UpdateScenarioInput = z.object({
  scenarioId: z.string().uuid(),
  expectedRowVersion: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  isShared: z.boolean().optional(),
  assumptions: z.array(Assumption).max(50).optional(),
  decision: Decision.optional(),
});

export async function updateScenario(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ rowVersion: number }> {
  assertCan(archetype, "scenario.manage");
  const input = UpdateScenarioInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "studio.scenario.update",
        entityType: "studio_scenario",
        entityId: input.scenarioId,
        summary: "Updated scenario",
      },
    },
    async (tx) => {
      const s = await scenarioIn(tx, ctx, input.scenarioId);
      if (input.expectedRowVersion !== undefined && s.rowVersion !== input.expectedRowVersion) {
        throw new StudioError("scenario changed since you loaded it", "conflict");
      }
      if (s.status === "applied" || s.status === "discarded") {
        throw new StudioError("scenario is closed", "invalid_state");
      }
      const rows = (await tx.execute(sql`
        update public.studio_scenario set
          name = coalesce(${input.name ?? null}, name),
          description = ${input.description === undefined ? sql`description` : (input.description ?? null)},
          is_shared = coalesce(${input.isShared ?? null}, is_shared),
          assumptions = coalesce(${input.assumptions === undefined ? null : JSON.stringify(input.assumptions)}::jsonb, assumptions),
          decision = coalesce(${input.decision === undefined ? null : JSON.stringify(input.decision)}::jsonb, decision),
          row_version = row_version + 1, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${input.scenarioId}
        returning row_version
      `)) as unknown as Array<{ row_version: string | number }>;
      return { rowVersion: Number(rows[0]!.row_version) };
    },
  );
}

// ── compare ──────────────────────────────────────────────────────────────────

export type ScenarioChange = {
  id: string;
  targetKind: "node" | "edge" | "record";
  targetId: string;
  /** The plan element the change shows on (a record change maps to its linked node). */
  nodeId: string | null;
  title: string;
  recordType: string | null;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  liveValue: unknown;
  /** The live plan no longer holds the value this change was built on. */
  drifted: boolean;
};

export type ScenarioComparison = {
  scenario: ScenarioRow;
  changes: ScenarioChange[];
  schedule: {
    live: SideSummary;
    scenario: SideSummary;
    /** Working days; + = the scenario finishes later. */
    finishDeltaDays: number | null;
    nodes: Array<{
      nodeId: string;
      title: string;
      liveFinish: string | null;
      scenarioFinish: string | null;
      deltaDays: number | null;
      liveCritical: boolean;
      scenarioCritical: boolean;
    }>;
  };
};

type SideSummary = {
  projectStart: string | null;
  projectFinish: string | null;
  durationDays: number;
  criticalIds: string[];
  unscheduled: number;
};

type ChangeRaw = {
  id: string;
  target_kind: "node" | "edge" | "record";
  target_id: string;
  record_type: string | null;
  field: string;
  old_value: unknown;
  new_value: unknown;
};

async function changesIn(tx: TenantTx, ctx: Ctx, scenarioId: string): Promise<ChangeRaw[]> {
  return (await tx.execute(sql`
    select id::text as id, target_kind, target_id::text as target_id, record_type, field,
           old_value, new_value
    from public.studio_scenario_change
    where org_id = ${ctx.orgId} and scenario_id = ${scenarioId}
    order by created_at
  `)) as unknown as ChangeRaw[];
}

function nodeForChange(graph: ResolvedGraph, c: ChangeRaw): EffectiveNode | null {
  if (c.target_kind === "node") return graph.nodes.find((n) => n.id === c.target_id) ?? null;
  if (c.target_kind === "record") {
    return (
      graph.nodes.find((n) => n.recordType === c.record_type && n.recordId === c.target_id) ?? null
    );
  }
  return null;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function summarize(s: ReturnType<typeof scheduleGraph>): SideSummary {
  return {
    projectStart: s.result.projectStart,
    projectFinish: s.result.projectFinish,
    durationDays: s.result.projectDurationDays,
    criticalIds: [...new Set(s.result.criticalPaths.flat())],
    unscheduled: s.unscheduled.length,
  };
}

export async function compareScenario(
  ctx: Ctx,
  archetype: RoleArchetype,
  scenarioId: string,
): Promise<ScenarioComparison> {
  assertCan(archetype, "studio.view");
  const { scenario, changes } = await withCtx(ctx, async (tx) => ({
    scenario: await scenarioIn(tx, ctx, scenarioId),
    changes: await changesIn(tx, ctx, scenarioId),
  }));
  const [live, branch, cal] = await Promise.all([
    resolvePlanGraph(ctx, archetype, { planId: scenario.planId }),
    resolvePlanGraph(ctx, archetype, { planId: scenario.planId, scenarioId }),
    loadCalendar(ctx),
  ]);
  const liveSched = scheduleGraph(cal, live);
  const branchSched = scheduleGraph(cal, branch);

  const mapped: ScenarioChange[] = changes.map((c) => {
    const node = nodeForChange(live, c);
    const prop = (FIELD_TO_PROP as Record<string, keyof EffectiveNode>)[c.field];
    const liveValue = node && prop ? node[prop] : null;
    return {
      id: c.id,
      targetKind: c.target_kind,
      targetId: c.target_id,
      nodeId: node?.id ?? null,
      title: node?.title ?? c.target_id,
      recordType: c.record_type,
      field: c.field,
      oldValue: c.old_value,
      newValue: c.new_value,
      liveValue,
      drifted: node === null || !same(liveValue, c.old_value),
    };
  });

  const liveCritical = new Set(liveSched.result.criticalPaths.flat());
  const branchCritical = new Set(branchSched.result.criticalPaths.flat());
  const ids = new Set([...liveSched.byNode.keys(), ...branchSched.byNode.keys()]);
  const titles = new Map(branch.nodes.map((n) => [n.id, n.title]));
  for (const n of live.nodes) if (!titles.has(n.id)) titles.set(n.id, n.title);
  const nodes = [...ids].map((id) => {
    const a = liveSched.byNode.get(id);
    const b = branchSched.byNode.get(id);
    const deltaDays = a && b ? signedWorkingDays(cal, a.earlyFinish, b.earlyFinish) : null;
    return {
      nodeId: id,
      title: titles.get(id) ?? id,
      liveFinish: a?.earlyFinish ?? null,
      scenarioFinish: b?.earlyFinish ?? null,
      deltaDays,
      liveCritical: liveCritical.has(id),
      scenarioCritical: branchCritical.has(id),
    };
  });
  const finishDeltaDays =
    liveSched.result.projectFinish && branchSched.result.projectFinish
      ? signedWorkingDays(cal, liveSched.result.projectFinish, branchSched.result.projectFinish)
      : null;

  return {
    scenario,
    changes: mapped,
    schedule: {
      live: summarize(liveSched),
      scenario: summarize(branchSched),
      finishDeltaDays,
      nodes: nodes.filter((n) => n.deltaDays !== 0 || n.liveCritical !== n.scenarioCritical),
    },
  };
}

/** Working days from `from` to `to`; negative when `to` is earlier. */
function signedWorkingDays(
  cal: Awaited<ReturnType<typeof loadCalendar>>,
  from: string,
  to: string,
): number {
  if (from === to) return 0;
  return from < to ? workingDaysBetween(cal, from, to) : -workingDaysBetween(cal, to, from);
}

// ── lifecycle ────────────────────────────────────────────────────────────────

export async function submitScenario(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ status: ScenarioStatus; approvalId: string }> {
  assertCan(archetype, "scenario.manage");
  const input = z
    .object({ scenarioId: z.string().uuid(), expectedRowVersion: z.number().int().optional() })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { status: ScenarioStatus }) => ({
        action: "studio.scenario.submit",
        entityType: "studio_scenario",
        entityId: input.scenarioId,
        summary: `Submitted scenario for review (${r.status})`,
      }),
    },
    async (tx) => {
      const s = await scenarioIn(tx, ctx, input.scenarioId);
      if (input.expectedRowVersion !== undefined && s.rowVersion !== input.expectedRowVersion) {
        throw new StudioError("scenario changed since you loaded it", "conflict");
      }
      if (s.status !== "draft")
        throw new StudioError("only a draft can be submitted", "invalid_state");
      if (s.changeCount === 0) throw new StudioError("the scenario has no changes to apply");
      // The engine's guarded update advances under_review → approved when a rule
      // auto-approves, so the subject must already be in its live state.
      await tx.execute(sql`
        update public.studio_scenario set status = 'under_review',
          row_version = row_version + 1, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${input.scenarioId} and status = 'draft'
      `);
      const res = await submitForApproval(tx, ctx, {
        subjectType: "scenario_apply",
        subjectId: input.scenarioId,
        subjectSummary: { title: s.name },
      });
      return { status: res.decided ? "approved" : "under_review", approvalId: res.approvalId };
    },
  );
}

export async function discardScenario(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "scenario.manage");
  const input = z.object({ scenarioId: z.string().uuid() }).parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "studio.scenario.discard",
        entityType: "studio_scenario",
        entityId: input.scenarioId,
        summary: "Discarded scenario",
      },
    },
    async (tx) => {
      const s = await scenarioIn(tx, ctx, input.scenarioId);
      if (s.status === "applied")
        throw new StudioError("an applied scenario cannot be discarded", "invalid_state");
      if (s.status === "discarded") return;
      if (s.status === "under_review") {
        await supersedeApprovalsForSubjectIn(tx, ctx, {
          subjectType: "scenario_apply",
          subjectId: input.scenarioId,
          reason: "scenario discarded",
        });
      }
      await tx.execute(sql`
        update public.studio_scenario set status = 'discarded',
          row_version = row_version + 1, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${input.scenarioId}
      `);
    },
  );
}

/**
 * Replay an APPROVED scenario onto the live plan through the owning services
 * (a linked task's fields go through the jobs door with its rules and audit;
 * a draft element's through the studio). Every change is validated against
 * the live plan first: any drift refuses the whole apply, because applying a
 * change on top of a value nobody reviewed would be a silent overwrite.
 */
export async function applyScenario(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ applied: number }> {
  assertCan(archetype, "scenario.apply");
  const input = z
    .object({ scenarioId: z.string().uuid(), expectedRowVersion: z.number().int().optional() })
    .parse(raw);
  const cmp = await compareScenario(ctx, archetype, input.scenarioId);
  if (
    input.expectedRowVersion !== undefined &&
    cmp.scenario.rowVersion !== input.expectedRowVersion
  ) {
    throw new StudioError("scenario changed since you loaded it", "conflict");
  }
  if (cmp.scenario.status !== "approved") {
    throw new StudioError("only an approved scenario can be applied", "invalid_state");
  }
  const drifted = cmp.changes.filter((c) => c.drifted);
  if (drifted.length > 0) {
    throw new StudioError(
      `the plan moved since this scenario was approved (${drifted
        .map((c) => `${c.title}: ${c.field}`)
        .slice(0, 5)
        .join(", ")}); branch again from the current plan`,
      "drift",
    );
  }
  // Group by element so each element is one update (one audit row each).
  const byNode = new Map<string, Record<string, unknown>>();
  for (const c of cmp.changes) {
    if (!c.nodeId) throw new StudioError(`element for ${c.field} no longer exists`, "drift");
    const patch = byNode.get(c.nodeId) ?? {};
    patch[c.field] = c.newValue;
    byNode.set(c.nodeId, patch);
  }
  let applied = 0;
  for (const [nodeId, fields] of byNode) {
    await updateNode(ctx, archetype, { nodeId, ...fields });
    applied += Object.keys(fields).length;
  }
  await command(
    ctx,
    {
      audit: {
        action: "studio.scenario.apply",
        entityType: "studio_scenario",
        entityId: input.scenarioId,
        summary: `Applied scenario "${cmp.scenario.name}" (${applied} change(s) on ${byNode.size} element(s))`,
      },
    },
    async (tx) => {
      const moved = (await tx.execute(sql`
        update public.studio_scenario set status = 'applied', applied_at = now(),
          applied_by = ${ctx.userId}, row_version = row_version + 1, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${input.scenarioId} and status = 'approved'
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (!moved[0]) throw new StudioError("scenario was concurrently changed", "conflict");
    },
  );
  return { applied };
}

// ── Monte Carlo ──────────────────────────────────────────────────────────────

export const SimulateInput = z.object({
  planId: z.string().uuid(),
  scenarioId: z.string().uuid().optional(),
  samples: z.number().int().min(100).max(5000).optional(),
  seed: z.number().int().optional(),
});

export async function simulatePlan(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<SimulationResult> {
  assertCan(archetype, "studio.schedule");
  const input = SimulateInput.parse(raw);
  const [graph, cal] = await Promise.all([
    resolvePlanGraph(ctx, archetype, { planId: input.planId, scenarioId: input.scenarioId }),
    loadCalendar(ctx),
  ]);
  const { tasks, deps } = toScheduleInputs(graph);
  const seed = input.seed ?? Date.now() % 2147483647;
  const result = simulateSchedule(cal, tasks, deps, { samples: input.samples ?? 1000, seed });

  if (input.scenarioId && result.ok) {
    const top = [...result.criticality.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    const stored: StoredSimulation = {
      seed: result.seed,
      samples: result.samples,
      ranAt: new Date().toISOString(),
      deterministicFinish: result.deterministicFinish,
      finish: result.finish,
      confidenceInDeterministic: result.confidenceInDeterministic,
      criticality: Object.fromEntries(top),
      warnings: result.warnings,
    };
    await command(
      ctx,
      {
        audit: {
          action: "studio.scenario.simulate",
          entityType: "studio_scenario",
          entityId: input.scenarioId,
          summary: `Ran ${result.samples} samples (seed ${result.seed})`,
        },
      },
      async (tx) => {
        await tx.execute(sql`
          update public.studio_scenario set simulation = ${JSON.stringify(stored)}::jsonb,
            updated_at = now()
          where org_id = ${ctx.orgId} and id = ${input.scenarioId}
        `);
      },
    );
  }
  return result;
}
