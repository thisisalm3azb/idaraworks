/**
 * H25B — ONE graph resolution, many projections (ADR-2).
 *
 * resolvePlanGraph() is the only read every studio view consumes: typed nodes
 * and edges with EFFECTIVE fields — canonical record fields for linked nodes
 * (read here, never stored), draft fields for planning-only nodes, and the
 * scenario overlay applied last (ADR-7). Permission law (ADR-8): a linked
 * node never widens access — without the record's own view action the viewer
 * gets existence + neutral title only, and money fields ride the price/cost
 * walls exactly as everywhere else.
 */
import { z } from "zod";
import { assertCan, can } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import {
  draftStatusCategory,
  jobStatusCategory,
  LINKABLE_RECORDS,
  StudioError,
  taskStatusCategory,
  type DepKind,
  type EdgeType,
  type LinkableRecordType,
  type NodeType,
  type StatusCategory,
} from "./types";

export type EffectiveNode = {
  id: string;
  nodeType: NodeType;
  title: string;
  description: string | null;
  recordType: LinkableRecordType | null;
  recordId: string | null;
  /** false when the viewer lacks the record's own view action — details withheld. */
  recordVisible: boolean;
  statusCategory: StatusCategory;
  rawStatus: string | null;
  priority: string;
  startDate: string | null;
  dueDate: string | null;
  durationDays: number | null;
  progressPct: number | null;
  isMilestone: boolean;
  constraintKind: string | null;
  constraintDate: string | null;
  deadlineDate: string | null;
  estimateOptimisticDays: number | null;
  estimatePessimisticDays: number | null;
  ownerUserId: string | null;
  assigneeEmployeeId: string | null;
  assigneeName: string | null;
  amountMinor: number | null;
  currency: string | null;
  data: Record<string, unknown>;
  // canvas
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  z: number;
  parentNodeId: string | null;
  layerKey: string | null;
  locked: boolean;
  style: Record<string, unknown>;
  rowVersion: number;
  /** Data-quality notices (truthfulness law): never silently repaired. */
  warnings: string[];
  /** Which scenario fields overlay this node (empty outside scenarios). */
  overlaidFields: string[];
};

export type EffectiveEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: EdgeType;
  depKind: DepKind | null;
  lagDays: number;
  label: string | null;
  taskDependencyId: string | null;
  /** A dependency drawn between tasks but not (yet) canonical — visible truth. */
  materialized: boolean;
  waypoints: unknown[];
  style: Record<string, unknown>;
};

export type ResolvedGraph = {
  planId: string;
  planName: string;
  planReference: string;
  planRowVersion: number;
  scenarioId: string | null;
  nodes: EffectiveNode[];
  edges: EffectiveEdge[];
  warnings: string[];
  truncated: boolean;
};

const MAX_NODES = 5000;
const MAX_EDGES = 10000;

type Overlay = Map<string, Map<string, unknown>>; // targetId -> field -> value

async function loadOverlay(
  tx: TenantTx,
  ctx: Ctx,
  scenarioId: string,
): Promise<{ nodeOverlay: Overlay; recordOverlay: Overlay }> {
  const rows = (await tx.execute(sql`
    select target_kind, target_id::text as target_id, field, new_value
    from public.studio_scenario_change
    where org_id = ${ctx.orgId} and scenario_id = ${scenarioId}
  `)) as unknown as Array<{
    target_kind: string;
    target_id: string;
    field: string;
    new_value: unknown;
  }>;
  const nodeOverlay: Overlay = new Map();
  const recordOverlay: Overlay = new Map();
  for (const r of rows) {
    const map = r.target_kind === "node" ? nodeOverlay : recordOverlay;
    const m = map.get(r.target_id) ?? new Map<string, unknown>();
    m.set(r.field, r.new_value);
    map.set(r.target_id, m);
  }
  return { nodeOverlay, recordOverlay };
}

function overlayValue<T>(m: Map<string, unknown> | undefined, field: string, base: T): T {
  if (!m || !m.has(field)) return base;
  return m.get(field) as T;
}

export async function resolvePlanGraph(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<ResolvedGraph> {
  assertCan(archetype, "studio.view");
  const input = z
    .object({ planId: z.string().uuid(), scenarioId: z.string().uuid().optional() })
    .parse(raw);
  return withCtx(ctx, async (tx) => {
    const plans = (await tx.execute(sql`
      select id::text as id, name, reference, row_version from public.studio_plan
      where org_id = ${ctx.orgId} and id = ${input.planId}
    `)) as unknown as Array<{ id: string; name: string; reference: string; row_version: number }>;
    if (!plans[0]) throw new StudioError("plan not found", "not_found");

    const nodeRows = (await tx.execute(sql`
      select id::text as id, node_type, title, description, record_type,
             record_id::text as record_id, status, priority,
             start_date::text as start_date, due_date::text as due_date,
             duration_days, progress_pct, owner_user_id::text as owner_user_id,
             assignee_employee_id::text as assignee_employee_id,
             amount_minor::text as amount_minor, currency, data,
             x::float8 as x, y::float8 as y, w::float8 as w, h::float8 as h, z,
             parent_node_id::text as parent_node_id, layer_key, locked, style,
             row_version
      from public.studio_node
      where org_id = ${ctx.orgId} and plan_id = ${input.planId} and archived_at is null
      order by z, created_at
      limit ${MAX_NODES + 1}
    `)) as unknown as Array<Record<string, unknown>>;
    const truncatedNodes = nodeRows.length > MAX_NODES;
    const nodes = nodeRows.slice(0, MAX_NODES);

    const edgeRows = (await tx.execute(sql`
      select id::text as id, source_node_id::text as source, target_node_id::text as target,
             edge_type, dep_kind, lag_days, label,
             task_dependency_id::text as task_dependency_id, waypoints, style
      from public.studio_edge
      where org_id = ${ctx.orgId} and plan_id = ${input.planId} and removed_at is null
      limit ${MAX_EDGES + 1}
    `)) as unknown as Array<Record<string, unknown>>;
    const truncatedEdges = edgeRows.length > MAX_EDGES;
    const edges = edgeRows.slice(0, MAX_EDGES);

    const overlays = input.scenarioId
      ? await loadOverlay(tx, ctx, input.scenarioId)
      : { nodeOverlay: new Map() as Overlay, recordOverlay: new Map() as Overlay };

    // ── batch-load linked records per type, permission-checked ──────────────
    const byType = new Map<LinkableRecordType, string[]>();
    for (const n of nodes) {
      const rt = n.record_type as LinkableRecordType | null;
      if (rt && n.record_id) {
        byType.set(rt, [...(byType.get(rt) ?? []), n.record_id as string]);
      }
    }
    const resolved = new Map<string, Record<string, unknown>>(); // `${type}:${id}`
    for (const [rt, ids] of byType) {
      const spec = LINKABLE_RECORDS[rt];
      if (!can(archetype, spec.viewAction)) continue; // withheld, not leaked
      const uniq = [...new Set(ids)];
      const loaded = await loadRecords(tx, ctx, rt, uniq);
      for (const [id, rec] of loaded) resolved.set(`${rt}:${id}`, rec);
    }

    const warnings: string[] = [];
    const outNodes: EffectiveNode[] = nodes.map((n) => {
      const id = n.id as string;
      const rt = (n.record_type as LinkableRecordType | null) ?? null;
      const rid = (n.record_id as string | null) ?? null;
      const rec = rt && rid ? resolved.get(`${rt}:${rid}`) : undefined;
      const recordVisible = !rt || rec !== undefined;
      const overlay = rt && rid ? overlays.recordOverlay.get(rid) : overlays.nodeOverlay.get(id);
      const overlaidFields = overlay ? [...overlay.keys()] : [];

      const nodeWarnings: string[] = [];
      if (rt && rid && recordVisible === false) {
        // viewer lacks the record's view action — that is not a data problem.
      } else if (
        rt &&
        rid &&
        rec === undefined &&
        can(archetype, LINKABLE_RECORDS[rt].viewAction)
      ) {
        nodeWarnings.push("linked record no longer exists");
      }

      const base: EffectiveNode = {
        id,
        nodeType: n.node_type as NodeType,
        title:
          (rec?.title as string | undefined) ??
          ((n.title as string | null) || (rt ? `${rt} (restricted)` : "Untitled")),
        description: recordVisible
          ? ((rec?.description as string | null) ?? (n.description as string | null) ?? null)
          : null,
        recordType: rt,
        recordId: rid,
        recordVisible,
        statusCategory: rec
          ? (rec.statusCategory as StatusCategory)
          : draftStatusCategory(n.status as string),
        rawStatus: (rec?.rawStatus as string | null) ?? (n.status as string),
        priority: (rec?.priority as string | undefined) ?? (n.priority as string) ?? "normal",
        startDate: overlayValue(
          overlay,
          "startDate",
          (rec?.startDate as string | null) ?? (n.start_date as string | null) ?? null,
        ),
        dueDate: overlayValue(
          overlay,
          "dueDate",
          (rec?.dueDate as string | null) ?? (n.due_date as string | null) ?? null,
        ),
        durationDays: overlayValue(
          overlay,
          "durationDays",
          rec?.durationDays !== undefined
            ? (rec.durationDays as number | null)
            : n.duration_days == null
              ? null
              : Number(n.duration_days),
        ),
        progressPct:
          rec?.progressPct !== undefined
            ? (rec.progressPct as number | null)
            : n.progress_pct == null
              ? null
              : Number(n.progress_pct),
        isMilestone:
          (rec?.isMilestone as boolean | undefined) ?? (n.node_type as string) === "milestone",
        constraintKind: (rec?.constraintKind as string | null) ?? null,
        constraintDate: (rec?.constraintDate as string | null) ?? null,
        deadlineDate: (rec?.deadlineDate as string | null) ?? null,
        estimateOptimisticDays: (rec?.estimateOptimisticDays as number | null) ?? null,
        estimatePessimisticDays: (rec?.estimatePessimisticDays as number | null) ?? null,
        ownerUserId: (n.owner_user_id as string | null) ?? null,
        assigneeEmployeeId:
          (rec?.assigneeEmployeeId as string | null) ??
          (n.assignee_employee_id as string | null) ??
          null,
        assigneeName: (rec?.assigneeName as string | null) ?? null,
        amountMinor: recordVisible
          ? ((rec?.amountMinor as number | null) ??
            (n.amount_minor == null ? null : Number(n.amount_minor)))
          : null,
        currency: (rec?.currency as string | null) ?? (n.currency as string | null) ?? null,
        data: (n.data as Record<string, unknown>) ?? {},
        x: Number(n.x),
        y: Number(n.y),
        w: n.w == null ? null : Number(n.w),
        h: n.h == null ? null : Number(n.h),
        z: Number(n.z),
        parentNodeId: (n.parent_node_id as string | null) ?? null,
        layerKey: (n.layer_key as string | null) ?? null,
        locked: n.locked === true,
        style: (n.style as Record<string, unknown>) ?? {},
        rowVersion: Number(n.row_version),
        warnings: nodeWarnings,
        overlaidFields,
      };
      return base;
    });

    const outEdges: EffectiveEdge[] = edges.map((e) => {
      const materialized = e.edge_type !== "dependency" || e.task_dependency_id != null;
      return {
        id: e.id as string,
        sourceNodeId: e.source as string,
        targetNodeId: e.target as string,
        edgeType: e.edge_type as EdgeType,
        depKind: (e.dep_kind as DepKind | null) ?? null,
        lagDays: Number(e.lag_days ?? 0),
        label: (e.label as string | null) ?? null,
        taskDependencyId: (e.task_dependency_id as string | null) ?? null,
        materialized,
        waypoints: (e.waypoints as unknown[]) ?? [],
        style: (e.style as Record<string, unknown>) ?? {},
      };
    });

    if (truncatedNodes) warnings.push(`showing the first ${MAX_NODES} nodes — refine the view`);
    if (truncatedEdges) warnings.push(`showing the first ${MAX_EDGES} edges — refine the view`);

    return {
      planId: input.planId,
      planName: plans[0].name,
      planReference: plans[0].reference,
      planRowVersion: Number(plans[0].row_version),
      scenarioId: input.scenarioId ?? null,
      nodes: outNodes,
      edges: outEdges,
      warnings,
      truncated: truncatedNodes || truncatedEdges,
    };
  });
}

/** Batch record loaders. Money fields load ONLY behind the walls. */
async function loadRecords(
  tx: TenantTx,
  ctx: Ctx,
  rt: LinkableRecordType,
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return out;
  // House array-binding pattern (jobs/dependencies.ts): one text param.
  const idList = sql`string_to_array(${ids.join(",")}, ',')::uuid[]`;
  switch (rt) {
    case "task": {
      const rows = (await tx.execute(sql`
        select t.id::text as id, t.title, t.description, t.status, t.priority,
               t.start_date::text as sd, t.due_date::text as dd, t.duration_days,
               t.is_milestone, t.constraint_kind, t.constraint_date::text as cd,
               t.deadline_date::text as dl, t.estimate_optimistic_days,
               t.estimate_pessimistic_days,
               t.assignee_employee_id::text as aid, e.name as aname
        from public.task t
        left join public.employee e on e.id = t.assignee_employee_id
        where t.org_id = ${ctx.orgId} and t.id = any(${idList})
      `)) as unknown as Array<Record<string, unknown>>;
      for (const r of rows) {
        out.set(r.id as string, {
          title: r.title,
          description: r.description ?? null,
          statusCategory: taskStatusCategory(r.status as string),
          rawStatus: r.status,
          priority: r.priority,
          startDate: r.sd ?? null,
          dueDate: r.dd ?? null,
          durationDays: r.duration_days == null ? null : Number(r.duration_days),
          isMilestone: r.is_milestone === true,
          constraintKind: r.constraint_kind ?? null,
          constraintDate: r.cd ?? null,
          deadlineDate: r.dl ?? null,
          estimateOptimisticDays:
            r.estimate_optimistic_days == null ? null : Number(r.estimate_optimistic_days),
          estimatePessimisticDays:
            r.estimate_pessimistic_days == null ? null : Number(r.estimate_pessimistic_days),
          assigneeEmployeeId: r.aid ?? null,
          assigneeName: r.aname ?? null,
        });
      }
      return out;
    }
    case "job": {
      const priceOk = ctx.pricePrivileged === true;
      const rows = (await tx.execute(sql`
        select id::text as id, name, status_category, priority,
               start_date::text as sd, due_date::text as dd,
               selling_price_minor::text as price
        from public.job
        where org_id = ${ctx.orgId} and id = any(${idList})
      `)) as unknown as Array<Record<string, unknown>>;
      for (const r of rows) {
        out.set(r.id as string, {
          title: r.name,
          statusCategory: jobStatusCategory(r.status_category as string),
          rawStatus: r.status_category,
          priority: r.priority ?? "normal",
          startDate: r.sd ?? null,
          dueDate: r.dd ?? null,
          amountMinor: priceOk && r.price != null ? Number(r.price) : null,
        });
      }
      return out;
    }
    case "employee": {
      const rows = (await tx.execute(sql`
        select id::text as id, name, lifecycle from public.employee
        where org_id = ${ctx.orgId} and id = any(${idList})
      `)) as unknown as Array<Record<string, unknown>>;
      for (const r of rows) {
        out.set(r.id as string, {
          title: r.name,
          statusCategory: r.lifecycle === "active" ? "active" : "planned",
          rawStatus: r.lifecycle,
        });
      }
      return out;
    }
    case "invoice": {
      const priceOk = ctx.pricePrivileged === true;
      const rows = (await tx.execute(sql`
        select id::text as id, reference, status, total_minor::text as total, currency,
               due_date::text as dd
        from public.invoice
        where org_id = ${ctx.orgId} and id = any(${idList})
      `)) as unknown as Array<Record<string, unknown>>;
      for (const r of rows) {
        out.set(r.id as string, {
          title: r.reference,
          statusCategory:
            r.status === "paid" ? "done" : r.status === "cancelled" ? "dropped" : "active",
          rawStatus: r.status,
          dueDate: r.dd ?? null,
          amountMinor: priceOk && r.total != null ? Number(r.total) : null,
          currency: r.currency,
        });
      }
      return out;
    }
    default: {
      // Generic loader: table + name-ish column resolution, no money.
      const table = LINKABLE_RECORDS[rt].table;
      const rows = (await tx.execute(
        sql`select id::text as id,
              coalesce(
                to_jsonb(t.*) ->> 'name',
                to_jsonb(t.*) ->> 'title',
                to_jsonb(t.*) ->> 'reference',
                to_jsonb(t.*) ->> 'label'
              ) as title,
              coalesce(to_jsonb(t.*) ->> 'status', '') as status
            from ${sql.raw(`public.${table}`)} t
            where t.org_id = ${ctx.orgId} and t.id = any(${idList})`,
      )) as unknown as Array<Record<string, unknown>>;
      for (const r of rows) {
        out.set(r.id as string, {
          title: r.title ?? rt,
          statusCategory: "active" as StatusCategory,
          rawStatus: (r.status as string) || null,
        });
      }
      return out;
    }
  }
}
