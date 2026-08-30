/**
 * H21 — task dependencies: "this task waits for that one".
 *
 * Trust rules, all enforced server-side:
 *  - a task never depends on itself (DB constraint and this service),
 *  - a live edge exists at most once per ordered pair (partial unique index),
 *  - both ends belong to the same organization AND the same work,
 *  - cycles are rejected before insertion by walking upstream with an explicit
 *    visited set and depth limit (no unbounded recursive SQL),
 *  - removal is soft, so the relationship that shaped a decision stays readable.
 *
 * Readiness is recomputed from the real edges after a dependency changes or an
 * upstream task finishes or reopens — never guessed, never cached anywhere else.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { assertWorkMutableIn } from "./lifecycle";

export const DEPENDENCY_KINDS = ["finish_to_start", "blocks"] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

/** Traversal bounds — a dependency graph this deep is a modelling problem, and
 * refusing loudly beats hanging on a pathological chain. */
const MAX_DEPTH = 50;
const MAX_NODES = 500;

/** Statuses that no longer block anything downstream. */
const SATISFIED = ["completed", "cancelled"] as const;

/** Code constants rendered inline: a bound array parameter is expanded by the
 * driver into a row constructor, which cannot be cast to an array type. */
const SATISFIED_SQL = sql.raw(`('${SATISFIED.join("','")}')`);
/** A dynamic uuid list, passed as ONE bound string and split server-side. */
const uuidList = (ids: readonly string[]) => sql`string_to_array(${ids.join(",")}, ',')::uuid[]`;

export class DependencyCycleError extends Error {
  constructor() {
    super("that dependency would create a cycle");
    this.name = "DependencyCycleError";
  }
}
export class DependencyScopeError extends Error {
  constructor() {
    super("both tasks must belong to the same work");
    this.name = "DependencyScopeError";
  }
}
export class TaskBlockedError extends Error {
  constructor(public readonly blockers: number) {
    super(`this task still waits on ${blockers} unfinished task(s)`);
    this.name = "TaskBlockedError";
  }
}

export const DependencyInput = z.object({
  taskId: z.string().uuid(),
  dependsOnTaskId: z.string().uuid(),
  kind: z.enum(DEPENDENCY_KINDS).default("finish_to_start"),
});

/**
 * Would adding taskId -> dependsOnTaskId close a loop? Walk UPSTREAM from the
 * proposed prerequisite: if the dependent task is anywhere up that chain, the
 * edge would create a cycle.
 */
async function wouldCycle(
  tx: TenantTx,
  ctx: Ctx,
  taskId: string,
  dependsOnTaskId: string,
): Promise<boolean> {
  if (taskId === dependsOnTaskId) return true;
  const seen = new Set<string>([dependsOnTaskId]);
  let frontier = [dependsOnTaskId];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const rows = (await tx.execute(sql`
      select depends_on_task_id::text as up
      from public.task_dependency
      where org_id = ${ctx.orgId} and removed_at is null
        and task_id = any(${uuidList(frontier)})
      limit ${MAX_NODES}
    `)) as unknown as Array<{ up: string }>;
    const next: string[] = [];
    for (const r of rows) {
      if (r.up === taskId) return true;
      if (!seen.has(r.up)) {
        seen.add(r.up);
        next.push(r.up);
      }
    }
    if (seen.size > MAX_NODES) return true; // refuse rather than traverse forever
    frontier = next;
  }
  return false;
}

/** Count the upstream tasks that are not yet finished. */
export async function countUnfinishedBlockersIn(
  tx: TenantTx,
  ctx: Ctx,
  taskId: string,
): Promise<number> {
  const rows = (await tx.execute(sql`
    select count(*)::int as n
    from public.task_dependency d
    join public.task up on up.id = d.depends_on_task_id and up.org_id = d.org_id
    where d.org_id = ${ctx.orgId} and d.task_id = ${taskId} and d.removed_at is null
      and up.status not in ${SATISFIED_SQL}
  `)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/**
 * After an upstream task finishes or reopens, move its direct dependents
 * between pending and ready to match reality. Bounded to direct neighbours —
 * their own dependents recompute when they in turn change.
 */
export async function recomputeDownstreamReadinessIn(
  tx: TenantTx,
  ctx: Ctx,
  upstreamTaskId: string,
): Promise<void> {
  const rows = (await tx.execute(sql`
    select d.task_id::text as id, t.status
    from public.task_dependency d
    join public.task t on t.id = d.task_id and t.org_id = d.org_id
    where d.org_id = ${ctx.orgId} and d.depends_on_task_id = ${upstreamTaskId}
      and d.removed_at is null and t.archived = false
      and t.status in ('pending', 'ready')
    limit ${MAX_NODES}
  `)) as unknown as Array<{ id: string; status: string }>;
  for (const row of rows) {
    const blockers = await countUnfinishedBlockersIn(tx, ctx, row.id);
    const next = blockers === 0 ? "ready" : "pending";
    if (next !== row.status) {
      await tx.execute(sql`
        update public.task set status = ${next}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${row.id}
      `);
    }
  }
}

export async function addDependency(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "tasks.manage");
  const data = DependencyInput.parse(input);
  const id = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "task.dependency_add",
        entityType: "task",
        entityId: data.taskId,
        summary: "Added a dependency",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select id::text as id, job_id::text as job_id, title from public.task
        where org_id = ${ctx.orgId} and id = any(${uuidList([data.taskId, data.dependsOnTaskId])})
      `)) as unknown as Array<{ id: string; job_id: string; title: string }>;
      const dependent = rows.find((r) => r.id === data.taskId);
      const prerequisite = rows.find((r) => r.id === data.dependsOnTaskId);
      if (!dependent || !prerequisite) throw new Error("task not found");
      if (dependent.job_id !== prerequisite.job_id) throw new DependencyScopeError();
      await assertWorkMutableIn(tx, ctx, dependent.job_id);
      if (await wouldCycle(tx, ctx, data.taskId, data.dependsOnTaskId)) {
        throw new DependencyCycleError();
      }
      await tx.execute(sql`
        insert into public.task_dependency
          (id, org_id, task_id, depends_on_task_id, kind, created_by)
        values (${id}, ${ctx.orgId}, ${data.taskId}, ${data.dependsOnTaskId}, ${data.kind},
                ${ctx.userId})
        on conflict (org_id, task_id, depends_on_task_id) where removed_at is null do nothing
      `);
      // The new edge may have just blocked a task that called itself ready.
      const blockers = await countUnfinishedBlockersIn(tx, ctx, data.taskId);
      if (blockers > 0) {
        await tx.execute(sql`
          update public.task set status = 'pending', updated_at = now()
          where org_id = ${ctx.orgId} and id = ${data.taskId} and status = 'ready'
        `);
      }
    },
  );
  return { id };
}

export async function removeDependency(
  ctx: Ctx,
  archetype: RoleArchetype,
  dependencyId: string,
): Promise<void> {
  assertCan(archetype, "tasks.manage");
  await command(
    ctx,
    {
      audit: (r: { taskId: string }) => ({
        action: "task.dependency_remove",
        entityType: "task" as const,
        entityId: r.taskId,
        summary: "Removed a dependency",
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.task_dependency
        set removed_at = now(), removed_by = ${ctx.userId}
        where org_id = ${ctx.orgId} and id = ${dependencyId} and removed_at is null
        returning task_id::text as task_id
      `)) as unknown as Array<{ task_id: string }>;
      const taskId = rows[0]?.task_id;
      if (!taskId) throw new Error("dependency not found");
      // Removing a blocker can make the dependent ready immediately.
      const blockers = await countUnfinishedBlockersIn(tx, ctx, taskId);
      if (blockers === 0) {
        await tx.execute(sql`
          update public.task set status = 'ready', updated_at = now()
          where org_id = ${ctx.orgId} and id = ${taskId} and status = 'pending'
        `);
      }
      return { taskId };
    },
  );
}

export type DependencyEdge = {
  id: string;
  taskId: string;
  taskTitle: string;
  dependsOnTaskId: string;
  dependsOnTitle: string;
  dependsOnStatus: string;
  kind: DependencyKind;
  satisfied: boolean;
};

/** Upstream blockers and downstream affected tasks for one task. */
export async function getTaskDependencies(
  ctx: Ctx,
  archetype: RoleArchetype,
  taskId: string,
): Promise<{ blockedBy: DependencyEdge[]; blocks: DependencyEdge[] }> {
  assertCan(archetype, "jobs.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select d.id::text as id, d.kind, d.task_id::text as task_id,
             d.depends_on_task_id::text as depends_on_task_id,
             dep.title as dependent_title, dep.status as dependent_status,
             up.title as upstream_title, up.status as upstream_status,
             (d.task_id = ${taskId}) as is_upstream_edge
      from public.task_dependency d
      join public.task dep on dep.id = d.task_id and dep.org_id = d.org_id
      join public.task up on up.id = d.depends_on_task_id and up.org_id = d.org_id
      where d.org_id = ${ctx.orgId} and d.removed_at is null
        and (d.task_id = ${taskId} or d.depends_on_task_id = ${taskId})
      order by up.title
      limit 200
    `),
  )) as unknown as Array<Record<string, unknown>>;
  const blockedBy: DependencyEdge[] = [];
  const blocks: DependencyEdge[] = [];
  for (const r of rows) {
    const upstreamStatus = r.upstream_status as string;
    const edge: DependencyEdge = {
      id: r.id as string,
      taskId: r.task_id as string,
      taskTitle: r.dependent_title as string,
      dependsOnTaskId: r.depends_on_task_id as string,
      dependsOnTitle: r.upstream_title as string,
      dependsOnStatus: upstreamStatus,
      kind: r.kind as DependencyKind,
      satisfied: (SATISFIED as readonly string[]).includes(upstreamStatus),
    };
    if (r.is_upstream_edge === true) blockedBy.push(edge);
    else blocks.push(edge);
  }
  return { blockedBy, blocks };
}

/** Blocker counts for a whole work record, in ONE query (no per-task loop). */
export async function blockerCountsForJob(ctx: Ctx, jobId: string): Promise<Map<string, number>> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select d.task_id::text as id, count(*)::int as n
      from public.task_dependency d
      join public.task t on t.id = d.task_id and t.org_id = d.org_id
      join public.task up on up.id = d.depends_on_task_id and up.org_id = d.org_id
      where d.org_id = ${ctx.orgId} and d.removed_at is null and t.job_id = ${jobId}
        and up.status not in ${SATISFIED_SQL}
      group by 1
    `),
  )) as unknown as Array<{ id: string; n: number }>;
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}
