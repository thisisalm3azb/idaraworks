/**
 * H25D — the graph → engine bridge (ADR-2's spine for every time-based view).
 *
 * Resolves the plan (with an optional scenario overlay), maps every
 * schedulable node and dependency edge into the pure engine's inputs, runs the
 * forward/backward pass over the org's WORKING calendar, and hands back the
 * result keyed by node id. Baselines are captured from the same computation
 * and compared in working days. Nothing here is a second scheduling truth:
 * the Gantt, timeline, critical-path, roadmap, workload and 3D views all read
 * THIS.
 *
 * Truthfulness: a node whose linked record the viewer may not see cannot be
 * scheduled honestly for that viewer — it is listed as unscheduled with the
 * reason, never guessed at.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { loadCalendar, workingDaysBetween, type Calendar } from "@/platform/calendar/calendar";
import {
  computeSchedule,
  type ScheduleDep,
  type ScheduleResult,
  type ScheduleTask,
  type ScheduledTask,
} from "./engine/cpm";
import { resolvePlanGraph, type EffectiveNode, type ResolvedGraph } from "./resolve";
import { StudioError, type NodeType } from "./types";

/** Node types the engine treats as activities. Everything else is context. */
export const SCHEDULABLE_TYPES: readonly NodeType[] = [
  "task",
  "milestone",
  "deliverable",
  "phase",
  "project",
  "initiative",
  "action",
];

export type PlanSchedule = {
  graph: ResolvedGraph;
  result: ScheduleResult;
  /** Scheduled activity per node id (absent when unscheduled). */
  byNode: Map<string, ScheduledTask>;
  unscheduled: Array<{ nodeId: string; title: string; reason: string }>;
  calendar: { workingDaysPerWeek: number; holidayRanges: number };
  baseline: BaselineComparison | null;
};

export type BaselineComparison = {
  baselineId: string;
  name: string;
  capturedAt: string;
  /** Per node: finish variance in working days (+ = later than baseline). */
  variance: Map<
    string,
    { baselineStart: string; baselineFinish: string; finishVarianceDays: number }
  >;
  /** Nodes the baseline knew that no longer schedule, and vice versa. */
  droppedNodeIds: string[];
  newNodeIds: string[];
};

function toEngineTask(n: EffectiveNode): ScheduleTask {
  return {
    id: n.id,
    title: n.title,
    durationDays: n.durationDays,
    startDate: n.startDate,
    dueDate: n.dueDate,
    isMilestone: n.isMilestone || n.nodeType === "milestone",
    constraintKind: (n.constraintKind as ScheduleTask["constraintKind"]) ?? "none",
    constraintDate: n.constraintDate,
    deadlineDate: n.deadlineDate,
    done: n.statusCategory === "done",
  };
}

/** Pure: schedule a resolved graph. Exported so views and tests can drive it. */
export function scheduleGraph(
  cal: Calendar,
  graph: ResolvedGraph,
  opts: { projectStart?: string } = {},
): Omit<PlanSchedule, "graph" | "calendar" | "baseline"> {
  const withheld: PlanSchedule["unscheduled"] = [];
  const tasks: ScheduleTask[] = [];
  for (const n of graph.nodes) {
    if (!SCHEDULABLE_TYPES.includes(n.nodeType)) continue;
    if (n.statusCategory === "dropped") continue;
    if (n.recordId && !n.recordVisible) {
      withheld.push({ nodeId: n.id, title: n.title, reason: "record details withheld" });
      continue;
    }
    tasks.push(toEngineTask(n));
  }
  const ids = new Set(tasks.map((t) => t.id));
  const deps: ScheduleDep[] = graph.edges
    .filter(
      (e) =>
        e.edgeType === "dependency" &&
        e.depKind !== null &&
        ids.has(e.sourceNodeId) &&
        ids.has(e.targetNodeId),
    )
    .map((e) => ({
      predecessorId: e.sourceNodeId,
      successorId: e.targetNodeId,
      kind: e.depKind!,
      lagDays: e.lagDays,
    }));
  const result = computeSchedule(cal, tasks, deps, opts);
  const titles = new Map(graph.nodes.map((n) => [n.id, n.title]));
  const unscheduled = [
    ...withheld,
    ...result.unscheduled.map((u) => ({
      nodeId: u.id,
      title: titles.get(u.id) ?? u.id,
      reason: u.reason,
    })),
  ];
  return { result, byNode: result.tasks, unscheduled };
}

export async function scheduleForPlan(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<PlanSchedule> {
  assertCan(archetype, "studio.view");
  const input = z
    .object({
      planId: z.string().uuid(),
      scenarioId: z.string().uuid().optional(),
      baselineId: z.string().uuid().optional(),
      projectStart: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .parse(raw);
  const [graph, cal] = await Promise.all([
    resolvePlanGraph(ctx, archetype, { planId: input.planId, scenarioId: input.scenarioId }),
    loadCalendar(ctx),
  ]);
  const scheduled = scheduleGraph(cal, graph, { projectStart: input.projectStart });
  const baseline = input.baselineId
    ? await compareToBaseline(ctx, cal, input.planId, input.baselineId, scheduled.byNode)
    : null;
  return {
    graph,
    ...scheduled,
    calendar: { workingDaysPerWeek: cal.workingDays.size, holidayRanges: cal.holidays.length },
    baseline,
  };
}

// ── baselines: frozen copies of a computed schedule ─────────────────────────

type BaselineEntry = {
  nodeId: string;
  title: string;
  start: string;
  finish: string;
  durationDays: number;
  amountMinor: number | null;
};

export async function captureBaseline(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; entries: number }> {
  assertCan(archetype, "studio.schedule");
  const input = z
    .object({
      planId: z.string().uuid(),
      name: z.string().trim().min(1).max(120),
      scenarioId: z.string().uuid().optional(),
    })
    .parse(raw);
  const plan = await scheduleForPlan(ctx, archetype, {
    planId: input.planId,
    scenarioId: input.scenarioId,
  });
  if (!plan.result.ok) {
    throw new StudioError("the plan has a dependency cycle; fix it before baselining");
  }
  const amounts = new Map(plan.graph.nodes.map((n) => [n.id, n.amountMinor]));
  const entries: BaselineEntry[] = [...plan.byNode.values()].map((t) => ({
    nodeId: t.id,
    title: plan.graph.nodes.find((n) => n.id === t.id)?.title ?? t.id,
    start: t.earlyStart,
    finish: t.earlyFinish,
    durationDays: t.durationDays,
    amountMinor: amounts.get(t.id) ?? null,
  }));
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "studio.baseline.capture",
        entityType: "studio_baseline",
        entityId: r.id,
        summary: `Captured baseline "${input.name}" (${entries.length} activities)`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.studio_baseline (org_id, plan_id, name, snapshot, captured_by)
        values (${ctx.orgId}, ${input.planId}, ${input.name},
                ${JSON.stringify(entries)}::jsonb, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id, entries: entries.length };
    },
  );
}

export async function listBaselines(
  ctx: Ctx,
  archetype: RoleArchetype,
  planId: string,
): Promise<Array<{ id: string; name: string; capturedAt: string; entries: number }>> {
  assertCan(archetype, "studio.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, captured_at::text as captured_at,
             jsonb_array_length(snapshot)::int as entries
      from public.studio_baseline
      where org_id = ${ctx.orgId} and plan_id = ${planId}
      order by captured_at desc limit 50
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    capturedAt: r.captured_at as string,
    entries: r.entries as number,
  }));
}

async function compareToBaseline(
  ctx: Ctx,
  cal: Calendar,
  planId: string,
  baselineId: string,
  byNode: Map<string, ScheduledTask>,
): Promise<BaselineComparison> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, captured_at::text as captured_at, snapshot
      from public.studio_baseline
      where org_id = ${ctx.orgId} and id = ${baselineId} and plan_id = ${planId}
    `),
  )) as unknown as Array<{
    id: string;
    name: string;
    captured_at: string;
    snapshot: BaselineEntry[];
  }>;
  const b = rows[0];
  if (!b) throw new StudioError("baseline not found", "not_found");
  const variance: BaselineComparison["variance"] = new Map();
  const baselineIds = new Set<string>();
  for (const e of b.snapshot) {
    baselineIds.add(e.nodeId);
    const now = byNode.get(e.nodeId);
    if (!now) continue;
    // Signed working-day distance between finishes.
    const later = now.earlyFinish >= e.finish;
    const days = later
      ? workingDaysBetween(cal, e.finish, now.earlyFinish)
      : -workingDaysBetween(cal, now.earlyFinish, e.finish);
    variance.set(e.nodeId, {
      baselineStart: e.start,
      baselineFinish: e.finish,
      finishVarianceDays: days,
    });
  }
  return {
    baselineId: b.id,
    name: b.name,
    capturedAt: b.captured_at,
    variance,
    droppedNodeIds: [...baselineIds].filter((id) => !byNode.has(id)),
    newNodeIds: [...byNode.keys()].filter((id) => !baselineIds.has(id)),
  };
}
