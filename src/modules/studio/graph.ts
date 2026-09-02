/**
 * H25B — the planning-graph mutations: plans, nodes, edges, conversion.
 *
 * ONE TRUTH (ADR-1/ADR-2): a node either LINKS a canonical record — whose
 * business fields are read from and written through the owning module — or
 * holds planning-only content. Field updates ROUTE: schedule/status fields of
 * a linked task go through the jobs door (its permissions, transitions and
 * audit intact); canvas placement and draft fields update studio tables with
 * optimistic row-versioning; scenario edits divert into scenario_change and
 * never touch anything live (ADR-7).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, can } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { requireCapability } from "@/platform/entitlements";
import { addDependency, removeDependency, createTask, updateTask } from "@/modules/jobs/service";
import { createIssue } from "@/modules/issues/service";
import {
  DEP_KINDS,
  EDGE_TYPES,
  LINKABLE_RECORDS,
  NODE_TYPES,
  parseNodeData,
  StudioError,
  type LinkableRecordType,
  type NodeType,
} from "./types";

const DateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

// ── plans ────────────────────────────────────────────────────────────────────

export async function createStudioPlan(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "studio.manage");
  await requireCapability(ctx, "cap.studio");
  const input = z
    .object({
      name: z.string().trim().min(1).max(200),
      description: z.string().trim().max(4000).optional(),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string; reference: string }) => ({
        action: "studio.plan.create",
        entityType: "studio_plan",
        entityId: r.id,
        summary: `Created plan ${r.reference} "${input.name}"`,
      }),
    },
    async (tx) => {
      const seq = await allocateReference(tx, ctx, "studio_plan");
      const reference = formatRef("PLN", seq, 3);
      const rows = (await tx.execute(sql`
        insert into public.studio_plan (org_id, reference, name, description, created_by)
        values (${ctx.orgId}, ${reference}, ${input.name}, ${input.description ?? null},
                ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id, reference };
    },
  );
}

export type StudioPlanRow = {
  id: string;
  reference: string;
  name: string;
  description: string | null;
  status: string;
  settings: Record<string, unknown>;
  rowVersion: number;
  updatedAt: string;
  nodeCount: number;
};

export async function listStudioPlans(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { includeArchived?: boolean } = {},
): Promise<StudioPlanRow[]> {
  assertCan(archetype, "studio.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select p.id::text as id, p.reference, p.name, p.description, p.status,
             p.settings, p.row_version, p.updated_at::text as updated_at,
             (select count(*)::int from public.studio_node n
              where n.plan_id = p.id and n.org_id = p.org_id
                and n.archived_at is null) as node_count
      from public.studio_plan p
      where p.org_id = ${ctx.orgId}
        and (${opts.includeArchived === true} or p.status = 'active')
      order by p.updated_at desc
      limit 200
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    reference: r.reference as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    status: r.status as string,
    settings: (r.settings as Record<string, unknown>) ?? {},
    rowVersion: Number(r.row_version),
    updatedAt: r.updated_at as string,
    nodeCount: r.node_count as number,
  }));
}

export async function updateStudioPlan(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "studio.manage");
  const input = z
    .object({
      planId: z.string().uuid(),
      name: z.string().trim().min(1).max(200).optional(),
      description: z.string().trim().max(4000).nullable().optional(),
      status: z.enum(["active", "archived"]).optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "studio.plan.update",
        entityType: "studio_plan",
        entityId: input.planId,
        summary: "Updated plan",
      },
    },
    async (tx) => {
      const res = (await tx.execute(sql`
        update public.studio_plan set
          name = coalesce(${input.name ?? null}, name),
          description = ${input.description === undefined ? sql`description` : (input.description ?? null)},
          status = coalesce(${input.status ?? null}, status),
          settings = coalesce(${input.settings === undefined ? null : JSON.stringify(input.settings)}::jsonb, settings),
          row_version = row_version + 1,
          updated_by = ${ctx.userId}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${input.planId}
        returning id
      `)) as unknown as unknown[];
      if (res.length === 0) throw new StudioError("plan not found", "not_found");
    },
  );
}

// ── shared helpers ───────────────────────────────────────────────────────────

async function planRowIn(tx: TenantTx, ctx: Ctx, planId: string) {
  const rows = (await tx.execute(sql`
    select id::text as id, status from public.studio_plan
    where org_id = ${ctx.orgId} and id = ${planId}
  `)) as unknown as Array<{ id: string; status: string }>;
  if (!rows[0]) throw new StudioError("plan not found", "not_found");
  if (rows[0].status !== "active") throw new StudioError("plan is archived", "invalid_state");
  return rows[0];
}

async function nodeRowIn(tx: TenantTx, ctx: Ctx, nodeId: string) {
  const rows = (await tx.execute(sql`
    select id::text as id, plan_id::text as plan_id, node_type,
           record_type, record_id::text as record_id, row_version, archived_at
    from public.studio_node
    where org_id = ${ctx.orgId} and id = ${nodeId}
  `)) as unknown as Array<{
    id: string;
    plan_id: string;
    node_type: NodeType;
    record_type: string | null;
    record_id: string | null;
    row_version: string | number;
    archived_at: string | null;
  }>;
  if (!rows[0] || rows[0].archived_at) throw new StudioError("node not found", "not_found");
  return rows[0];
}

/** The linked record must exist in THIS org (RLS narrows; this names it). */
async function assertRecordExistsIn(
  tx: TenantTx,
  ctx: Ctx,
  recordType: LinkableRecordType,
  recordId: string,
): Promise<void> {
  const table = LINKABLE_RECORDS[recordType].table;
  const rows = (await tx.execute(
    sql`select 1 as ok from ${sql.raw(`public.${table}`)} where org_id = ${ctx.orgId} and id = ${recordId}`,
  )) as unknown as unknown[];
  if (rows.length === 0) {
    throw new StudioError(`linked ${recordType} not found in this organization`, "invalid_link");
  }
}

// ── nodes ────────────────────────────────────────────────────────────────────

export const AddNodeInput = z.object({
  planId: z.string().uuid(),
  nodeType: z.enum(NODE_TYPES),
  title: z.string().trim().max(300).optional(),
  description: z.string().trim().max(4000).optional(),
  recordType: z
    .enum(Object.keys(LINKABLE_RECORDS) as [LinkableRecordType, ...LinkableRecordType[]])
    .optional(),
  recordId: z.string().uuid().optional(),
  x: z.number().finite().default(0),
  y: z.number().finite().default(0),
  w: z.number().finite().positive().max(100000).optional(),
  h: z.number().finite().positive().max(100000).optional(),
  parentNodeId: z.string().uuid().optional(),
  layerKey: z.string().trim().max(40).optional(),
  startDate: DateString,
  dueDate: DateString,
  durationDays: z.number().int().min(0).max(3650).optional(),
  ownerUserId: z.string().uuid().optional(),
  assigneeEmployeeId: z.string().uuid().optional(),
  amountMinor: z.number().int().optional(),
  currency: z.string().length(3).optional(),
  data: z.unknown().optional(),
  style: z.record(z.string(), z.unknown()).optional(),
});

export async function addNode(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "studio.manage");
  const input = AddNodeInput.parse(raw);
  if ((input.recordType == null) !== (input.recordId == null)) {
    throw new StudioError("a record link needs both type and id", "invalid_link");
  }
  const data = parseNodeData(input.nodeType, input.data);
  const id = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "studio.node.add",
        entityType: "studio_node",
        entityId: id,
        summary: `Added ${input.nodeType} node`,
      },
    },
    async (tx) => {
      await planRowIn(tx, ctx, input.planId);
      if (input.recordType && input.recordId) {
        await assertRecordExistsIn(tx, ctx, input.recordType, input.recordId);
      }
      if (input.parentNodeId) {
        const parent = await nodeRowIn(tx, ctx, input.parentNodeId);
        if (parent.plan_id !== input.planId) {
          throw new StudioError("parent belongs to another plan", "invalid_state");
        }
      }
      await tx.execute(sql`
        insert into public.studio_node
          (id, org_id, plan_id, node_type, title, description, record_type, record_id,
           x, y, w, h, parent_node_id, layer_key, start_date, due_date, duration_days,
           owner_user_id, assignee_employee_id, amount_minor, currency, data, style,
           created_by)
        values (${id}, ${ctx.orgId}, ${input.planId}, ${input.nodeType},
                ${input.title ?? null}, ${input.description ?? null},
                ${input.recordType ?? null}, ${input.recordId ?? null},
                ${input.x}, ${input.y}, ${input.w ?? null}, ${input.h ?? null},
                ${input.parentNodeId ?? null}, ${input.layerKey ?? null},
                ${input.startDate ?? null}, ${input.dueDate ?? null},
                ${input.durationDays ?? null}, ${input.ownerUserId ?? null},
                ${input.assigneeEmployeeId ?? null}, ${input.amountMinor ?? null},
                ${input.currency ?? null}, ${JSON.stringify(data)}::jsonb,
                ${JSON.stringify(input.style ?? {})}::jsonb, ${ctx.userId})
      `);
      await touchPlanIn(tx, ctx, input.planId);
    },
  );
  return { id };
}

async function touchPlanIn(tx: TenantTx, ctx: Ctx, planId: string): Promise<void> {
  await tx.execute(sql`
    update public.studio_plan set row_version = row_version + 1, updated_at = now()
    where org_id = ${ctx.orgId} and id = ${planId}
  `);
}

/** Fields a LINKED-task node routes through the jobs door. */
const TASK_ROUTED_FIELDS = new Set([
  "title",
  "description",
  "startDate",
  "dueDate",
  "durationDays",
  "assigneeEmployeeId",
  "priority",
  "isMilestone",
  "constraintKind",
  "constraintDate",
  "deadlineDate",
  "estimateOptimisticDays",
  "estimatePessimisticDays",
]);

export const UpdateNodeInput = z.object({
  nodeId: z.string().uuid(),
  expectedRowVersion: z.number().int().positive().optional(),
  scenarioId: z.string().uuid().optional(),
  // draft/planning fields (route to the record when linked)
  title: z.string().trim().max(300).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  status: z.enum(["proposed", "active", "done", "dropped"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  durationDays: z.number().int().min(0).max(3650).nullable().optional(),
  progressPct: z.number().min(0).max(100).nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  assigneeEmployeeId: z.string().uuid().nullable().optional(),
  amountMinor: z.number().int().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  data: z.unknown().optional(),
  isMilestone: z.boolean().optional(),
  constraintKind: z.enum(["none", "start_no_earlier", "finish_no_later"]).optional(),
  constraintDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  deadlineDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  estimateOptimisticDays: z.number().min(0).max(3650).nullable().optional(),
  estimatePessimisticDays: z.number().min(0).max(3650).nullable().optional(),
  // canvas-only fields (always studio-local, even for linked nodes)
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  w: z.number().finite().positive().max(100000).nullable().optional(),
  h: z.number().finite().positive().max(100000).nullable().optional(),
  z: z.number().int().optional(),
  parentNodeId: z.string().uuid().nullable().optional(),
  layerKey: z.string().trim().max(40).nullable().optional(),
  locked: z.boolean().optional(),
  style: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateNodeParams = z.infer<typeof UpdateNodeInput>;

/**
 * The ONE node-edit path (mandate: "if a manager changes a task date in the
 * Gantt view, everything updates"). Scenario edits divert entirely into
 * scenario_change; linked-task business fields route through updateTask.
 */
export async function updateNode(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ routed: "scenario" | "record" | "draft" | "canvas" }> {
  assertCan(archetype, "studio.manage");
  const input = UpdateNodeInput.parse(raw);
  const { nodeId, expectedRowVersion, scenarioId, ...fields } = input;
  const businessEntries = Object.entries(fields).filter(
    ([k, v]) =>
      v !== undefined &&
      !["x", "y", "w", "h", "z", "parentNodeId", "layerKey", "locked", "style"].includes(k),
  );
  const canvasEntries = Object.entries(fields).filter(
    ([k, v]) =>
      v !== undefined &&
      ["x", "y", "w", "h", "z", "parentNodeId", "layerKey", "locked", "style"].includes(k),
  );

  // Scenario edits: EVERY business field diverts to the overlay. Canvas
  // placement is presentation and stays live (a scenario is not a layout).
  if (scenarioId && businessEntries.length > 0) {
    assertCan(archetype, "scenario.manage");
    await recordScenarioChanges(ctx, scenarioId, nodeId, businessEntries);
    if (canvasEntries.length === 0) return { routed: "scenario" };
  }

  let routed: "scenario" | "record" | "draft" | "canvas" = scenarioId ? "scenario" : "canvas";
  await command(
    ctx,
    {
      audit: {
        action: "studio.node.update",
        entityType: "studio_node",
        entityId: nodeId,
        summary: "Updated node",
      },
    },
    async (tx) => {
      const node = await nodeRowIn(tx, ctx, nodeId);
      if (expectedRowVersion !== undefined && Number(node.row_version) !== expectedRowVersion) {
        throw new StudioError("node changed since you loaded it", "conflict");
      }
      const liveBusiness = scenarioId ? [] : businessEntries;

      // Linked TASK: business fields go through the jobs door (its
      // permissions, transition graph and audit).
      if (node.record_type === "task" && liveBusiness.length > 0) {
        const patch: Record<string, unknown> = {};
        for (const [k, v] of liveBusiness) {
          if (!TASK_ROUTED_FIELDS.has(k)) continue;
          patch[k] = v;
        }
        if (Object.keys(patch).length > 0) {
          await updateTask(ctx, archetype, node.record_id!, patch);
          routed = "record";
        }
      } else if (node.record_type == null && liveBusiness.length > 0) {
        // Draft node: update studio fields directly.
        const data =
          fields.data === undefined ? undefined : parseNodeData(node.node_type, fields.data);
        if (fields.constraintKind && fields.constraintKind !== "none" && !fields.constraintDate) {
          throw new StudioError("a dated constraint needs its date");
        }
        await tx.execute(sql`
          update public.studio_node set
            title = ${fields.title === undefined ? sql`title` : (fields.title ?? null)},
            description = ${fields.description === undefined ? sql`description` : (fields.description ?? null)},
            status = coalesce(${fields.status ?? null}, status),
            priority = coalesce(${fields.priority ?? null}, priority),
            start_date = ${fields.startDate === undefined ? sql`start_date` : (fields.startDate ?? null)},
            due_date = ${fields.dueDate === undefined ? sql`due_date` : (fields.dueDate ?? null)},
            duration_days = ${fields.durationDays === undefined ? sql`duration_days` : (fields.durationDays ?? null)},
            progress_pct = ${fields.progressPct === undefined ? sql`progress_pct` : (fields.progressPct ?? null)},
            owner_user_id = ${fields.ownerUserId === undefined ? sql`owner_user_id` : (fields.ownerUserId ?? null)},
            assignee_employee_id = ${fields.assigneeEmployeeId === undefined ? sql`assignee_employee_id` : (fields.assigneeEmployeeId ?? null)},
            amount_minor = ${fields.amountMinor === undefined ? sql`amount_minor` : (fields.amountMinor ?? null)},
            currency = ${fields.currency === undefined ? sql`currency` : (fields.currency ?? null)},
            data = coalesce(${data === undefined ? null : JSON.stringify(data)}::jsonb, data),
            row_version = row_version + 1,
            updated_by = ${ctx.userId}, updated_at = now()
          where org_id = ${ctx.orgId} and id = ${nodeId}
        `);
        routed = "draft";
      } else if (node.record_type && node.record_type !== "task" && liveBusiness.length > 0) {
        // Other linked records are read-only through the studio in v1: their
        // owning surfaces edit them. Refusing beats silently forking truth.
        throw new StudioError(
          `a linked ${node.record_type} is edited on its own surface`,
          "invalid_state",
        );
      }

      if (canvasEntries.length > 0) {
        if (fields.parentNodeId) {
          const parent = await nodeRowIn(tx, ctx, fields.parentNodeId);
          if (parent.plan_id !== node.plan_id) {
            throw new StudioError("parent belongs to another plan", "invalid_state");
          }
        }
        await tx.execute(sql`
          update public.studio_node set
            x = coalesce(${fields.x ?? null}, x),
            y = coalesce(${fields.y ?? null}, y),
            w = ${fields.w === undefined ? sql`w` : (fields.w ?? null)},
            h = ${fields.h === undefined ? sql`h` : (fields.h ?? null)},
            z = coalesce(${fields.z ?? null}, z),
            parent_node_id = ${fields.parentNodeId === undefined ? sql`parent_node_id` : (fields.parentNodeId ?? null)},
            layer_key = ${fields.layerKey === undefined ? sql`layer_key` : (fields.layerKey ?? null)},
            locked = coalesce(${fields.locked ?? null}, locked),
            style = coalesce(${fields.style === undefined ? null : JSON.stringify(fields.style)}::jsonb, style),
            row_version = row_version + 1,
            updated_by = ${ctx.userId}, updated_at = now()
          where org_id = ${ctx.orgId} and id = ${nodeId}
        `);
      }
      await touchPlanIn(tx, ctx, node.plan_id);
    },
  );
  return { routed };
}

async function recordScenarioChanges(
  ctx: Ctx,
  scenarioId: string,
  nodeId: string,
  entries: Array<[string, unknown]>,
): Promise<void> {
  await command(
    ctx,
    {
      audit: {
        action: "studio.scenario.change",
        entityType: "studio_scenario",
        entityId: scenarioId,
        summary: `Recorded ${entries.length} scenario change(s)`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select status from public.studio_scenario
        where org_id = ${ctx.orgId} and id = ${scenarioId}
      `)) as unknown as Array<{ status: string }>;
      if (!rows[0]) throw new StudioError("scenario not found", "not_found");
      if (rows[0].status !== "draft" && rows[0].status !== "under_review") {
        throw new StudioError("scenario is no longer editable", "invalid_state");
      }
      const node = await nodeRowIn(tx, ctx, nodeId);
      const targetKind = node.record_type ? "record" : "node";
      const targetId = node.record_type ? node.record_id! : nodeId;
      for (const [field, value] of entries) {
        await tx.execute(sql`
          insert into public.studio_scenario_change
            (org_id, scenario_id, target_kind, target_id, record_type, field,
             new_value, created_by)
          values (${ctx.orgId}, ${scenarioId}, ${targetKind}, ${targetId},
                  ${node.record_type ?? null}, ${field},
                  ${JSON.stringify(value ?? null)}::jsonb, ${ctx.userId})
          on conflict (org_id, scenario_id, target_kind, target_id, field)
          do update set new_value = excluded.new_value, updated_at = now()
        `);
      }
    },
  );
}

export async function archiveNode(
  ctx: Ctx,
  archetype: RoleArchetype,
  nodeId: string,
): Promise<void> {
  assertCan(archetype, "studio.manage");
  await command(
    ctx,
    {
      audit: {
        action: "studio.node.archive",
        entityType: "studio_node",
        entityId: nodeId,
        summary: "Archived node (edges soft-removed)",
      },
    },
    async (tx) => {
      const node = await nodeRowIn(tx, ctx, nodeId);
      await tx.execute(sql`
        update public.studio_node set archived_at = now(), row_version = row_version + 1,
               updated_by = ${ctx.userId}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${nodeId}
      `);
      // Soft-remove the node's live edges; canonical task_dependency rows are
      // removed through the jobs door so readiness recomputes.
      const edges = (await tx.execute(sql`
        update public.studio_edge
        set removed_at = now(), removed_by = ${ctx.userId}
        where org_id = ${ctx.orgId} and removed_at is null
          and (source_node_id = ${nodeId} or target_node_id = ${nodeId})
        returning task_dependency_id::text as dep
      `)) as unknown as Array<{ dep: string | null }>;
      await touchPlanIn(tx, ctx, node.plan_id);
      for (const e of edges) {
        if (e.dep) await removeDependency(ctx, archetype, e.dep);
      }
    },
  );
}

// ── edges ────────────────────────────────────────────────────────────────────

export const AddEdgeInput = z.object({
  planId: z.string().uuid(),
  sourceNodeId: z.string().uuid(),
  targetNodeId: z.string().uuid(),
  edgeType: z.enum(EDGE_TYPES).default("reference"),
  depKind: z.enum(DEP_KINDS).optional(),
  lagDays: z.number().int().min(-365).max(365).default(0),
  label: z.string().trim().max(200).optional(),
});

/**
 * Connect two shapes. A DEPENDENCY between two linked tasks is materialized
 * canonically (task_dependency through the jobs door — the scheduling engine
 * understands it, mandate core principle); every other pair stays a studio
 * edge until conversion.
 */
export async function addEdge(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; taskDependencyId: string | null }> {
  assertCan(archetype, "studio.manage");
  const input = AddEdgeInput.parse(raw);
  if (input.edgeType === "dependency" && !input.depKind) {
    throw new StudioError("a dependency edge names its kind", "invalid_state");
  }
  const id = randomUUID();
  let taskDependencyId: string | null = null;
  await command(
    ctx,
    {
      audit: {
        action: "studio.edge.add",
        entityType: "studio_edge",
        entityId: id,
        summary: `Connected nodes (${input.edgeType})`,
      },
    },
    async (tx) => {
      await planRowIn(tx, ctx, input.planId);
      const source = await nodeRowIn(tx, ctx, input.sourceNodeId);
      const target = await nodeRowIn(tx, ctx, input.targetNodeId);
      if (source.plan_id !== input.planId || target.plan_id !== input.planId) {
        throw new StudioError("nodes belong to another plan", "invalid_state");
      }
      if (
        input.edgeType === "dependency" &&
        source.record_type === "task" &&
        target.record_type === "task"
      ) {
        // Canonical materialization: target DEPENDS ON source (source→target
        // is the flow of time). Cycle detection lives in the jobs service.
        assertCan(archetype, "studio.schedule");
        const dep = await addDependency(ctx, archetype, {
          taskId: target.record_id!,
          dependsOnTaskId: source.record_id!,
          kind: input.depKind,
          lagDays: input.lagDays,
          allowCrossJob: true,
        });
        taskDependencyId = dep.id;
      }
      await tx.execute(sql`
        insert into public.studio_edge
          (id, org_id, plan_id, source_node_id, target_node_id, edge_type,
           dep_kind, lag_days, task_dependency_id, label, created_by)
        values (${id}, ${ctx.orgId}, ${input.planId}, ${input.sourceNodeId},
                ${input.targetNodeId}, ${input.edgeType}, ${input.depKind ?? null},
                ${input.lagDays}, ${taskDependencyId}, ${input.label ?? null},
                ${ctx.userId})
      `);
      await touchPlanIn(tx, ctx, input.planId);
    },
  );
  return { id, taskDependencyId };
}

export async function removeEdge(
  ctx: Ctx,
  archetype: RoleArchetype,
  edgeId: string,
): Promise<void> {
  assertCan(archetype, "studio.manage");
  await command(
    ctx,
    {
      audit: {
        action: "studio.edge.remove",
        entityType: "studio_edge",
        entityId: edgeId,
        summary: "Removed edge",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.studio_edge
        set removed_at = now(), removed_by = ${ctx.userId}
        where org_id = ${ctx.orgId} and id = ${edgeId} and removed_at is null
        returning task_dependency_id::text as dep, plan_id::text as plan_id
      `)) as unknown as Array<{ dep: string | null; plan_id: string }>;
      if (!rows[0]) throw new StudioError("edge not found", "not_found");
      await touchPlanIn(tx, ctx, rows[0].plan_id);
      if (rows[0].dep) await removeDependency(ctx, archetype, rows[0].dep);
    },
  );
}

// ── conversion: a shape becomes a real record ────────────────────────────────

export const ConvertNodeInput = z.object({
  nodeId: z.string().uuid(),
  to: z.enum(["task", "issue"]),
  // task conversion target
  jobId: z.string().uuid().optional(),
  stageId: z.string().uuid().optional(),
});

/**
 * Convert a planning-only node into a real IdaraWorks record through the
 * owning module. Draft dependency edges whose other end is already a linked
 * task materialize canonically at the same time.
 */
export async function convertNode(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ recordType: string; recordId: string }> {
  assertCan(archetype, "studio.manage");
  const input = ConvertNodeInput.parse(raw);
  let out: { recordType: string; recordId: string } | null = null;

  const node = await withCtx(ctx, (tx) => nodeRowIn(tx, ctx, input.nodeId));
  if (node.record_type) throw new StudioError("node is already linked", "invalid_state");
  const detail = await withCtx(
    ctx,
    async (tx) =>
      (
        (await tx.execute(sql`
          select title, description, start_date::text as start_date,
                 due_date::text as due_date, duration_days, priority,
                 assignee_employee_id::text as assignee
          from public.studio_node where org_id = ${ctx.orgId} and id = ${input.nodeId}
        `)) as unknown as Array<Record<string, unknown>>
      )[0]!,
  );

  if (input.to === "task") {
    if (!input.jobId) throw new StudioError("converting to a task needs the work record");
    const created = await createTask(ctx, archetype, {
      jobId: input.jobId,
      stageId: input.stageId,
      title: (detail.title as string | null) ?? "Untitled task",
      description: (detail.description as string | null) ?? undefined,
      assigneeEmployeeId: (detail.assignee as string | null) ?? undefined,
      priority: (detail.priority as string) ?? "normal",
      startDate: (detail.start_date as string | null) ?? undefined,
      dueDate: (detail.due_date as string | null) ?? undefined,
    });
    if (detail.duration_days != null) {
      await updateTask(ctx, archetype, created.id, {
        durationDays: Number(detail.duration_days),
        isMilestone: node.node_type === "milestone",
      });
    }
    out = { recordType: "task", recordId: created.id };
  } else {
    const created = await createIssue(ctx, archetype, {
      jobId: input.jobId,
      title: (detail.title as string | null) ?? "Untitled issue",
      description: (detail.description as string | null) ?? undefined,
    });
    out = { recordType: "issue", recordId: created.id };
  }

  await command(
    ctx,
    {
      audit: {
        action: "studio.node.convert",
        entityType: "studio_node",
        entityId: input.nodeId,
        summary: `Converted node into ${out.recordType}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.studio_node set
          record_type = ${out!.recordType}, record_id = ${out!.recordId},
          row_version = row_version + 1, updated_by = ${ctx.userId}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${input.nodeId}
      `);
      await touchPlanIn(tx, ctx, node.plan_id);
    },
  );

  // Materialize draft dependency edges now connectable canonically.
  if (out.recordType === "task") {
    const edges = await withCtx(
      ctx,
      async (tx) =>
        (await tx.execute(sql`
          select e.id::text as id, e.dep_kind, e.lag_days,
                 e.source_node_id::text as source_id, e.target_node_id::text as target_id,
                 s.record_type as s_type, s.record_id::text as s_rec,
                 t.record_type as t_type, t.record_id::text as t_rec
          from public.studio_edge e
          join public.studio_node s on s.id = e.source_node_id and s.org_id = e.org_id
          join public.studio_node t on t.id = e.target_node_id and t.org_id = e.org_id
          where e.org_id = ${ctx.orgId} and e.removed_at is null
            and e.edge_type = 'dependency' and e.task_dependency_id is null
            and (e.source_node_id = ${input.nodeId} or e.target_node_id = ${input.nodeId})
        `)) as unknown as Array<Record<string, string | number | null>>,
    );
    for (const e of edges) {
      if (e.s_type === "task" && e.t_type === "task") {
        try {
          const dep = await addDependency(ctx, archetype, {
            taskId: e.t_rec as string,
            dependsOnTaskId: e.s_rec as string,
            kind: (e.dep_kind as string) ?? "finish_to_start",
            lagDays: Number(e.lag_days ?? 0),
            allowCrossJob: true,
          });
          await withCtx(ctx, (tx) =>
            tx.execute(sql`
              update public.studio_edge set task_dependency_id = ${dep.id}
              where org_id = ${ctx.orgId} and id = ${e.id as string}
            `),
          );
        } catch {
          // A cycle or duplicate is reported by the edge staying draft; the
          // resolve layer marks it "not materialized" rather than hiding it.
        }
      }
    }
  }
  return out;
}
