/**
 * Tasks — the micro-steps that break work down (H21; originally S2 checklists).
 *
 * Preserved from S2: tasks never feed the progress math (that stays derived from
 * stage weights), manager+ manage them, a foreman updates status on assigned
 * work only, and nothing is ever deleted.
 *
 * H21 adds what a real micro-step needs: description, priority, own dates,
 * effort, parent/child structure, dependency-aware readiness, an explained
 * blocked state, and an optional completion approval. Status KEYS are stable —
 * 'pending' is still the not-started key, and its LABEL reads "Not started" —
 * because renaming a key would rewrite history for every existing row.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, ForbiddenError } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { submitForApproval } from "@/modules/approvals/service";
import { isAssignedIn } from "./assigned";
import { assertWorkMutableIn } from "./lifecycle";
import {
  countUnfinishedBlockersIn,
  recomputeDownstreamReadinessIn,
  TaskBlockedError,
} from "./dependencies";

export const TASK_STATUSES = [
  "pending",
  "ready",
  "in_progress",
  "blocked",
  "awaiting_approval",
  "completed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Statuses a task can hold while work on it is still expected. */
export const TASK_OPEN_STATUSES = [
  "pending",
  "ready",
  "in_progress",
  "blocked",
  "awaiting_approval",
] as const;

/**
 * Legal task transitions for a PERSON. Completion from in_progress is the normal
 * path; awaiting_approval is reached only when the task requires approval.
 *
 * Nothing here lets a person leave awaiting_approval for completed or back to
 * in_progress, because that state belongs to the approval engine: it writes
 * completed on approval and in_progress on rejection or withdrawal, straight to
 * the row. Allowing the owner to also write those meant a foreman could submit a
 * task for approval and then tick it complete himself, leaving the approval row
 * live; a later rejection would update no rows and the task would read Completed
 * over a rejected approval. Backing out is withdrawApproval, which the engine
 * routes to in_progress.
 */
const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["pending", "ready", "in_progress", "blocked", "cancelled"],
  ready: ["ready", "pending", "in_progress", "blocked", "cancelled"],
  in_progress: ["in_progress", "blocked", "awaiting_approval", "completed", "cancelled", "ready"],
  blocked: ["blocked", "pending", "ready", "in_progress", "cancelled"],
  awaiting_approval: ["awaiting_approval", "cancelled"],
  completed: ["completed", "in_progress"], // reopening is explicit and audited
  cancelled: ["cancelled", "pending"], // restoring is explicit and audited
};

/** Nesting is bounded at parent + child. Deeper trees stop being readable on a
 * phone and turn every task read into an unbounded walk. */
export const MAX_TASK_DEPTH = 2;

export class TaskTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`a task cannot move from ${from} to ${to}`);
    this.name = "TaskTransitionError";
  }
}
export class TaskChildrenOpenError extends Error {
  constructor(public readonly open: number) {
    super(`this task still has ${open} unfinished step(s) inside it`);
    this.name = "TaskChildrenOpenError";
  }
}
export class TaskDepthError extends Error {
  constructor() {
    super("a step inside a step cannot itself contain steps");
    this.name = "TaskDepthError";
  }
}
export class TaskReasonRequiredError extends Error {
  constructor() {
    super("a blocked task must say what is blocking it");
    this.name = "TaskReasonRequiredError";
  }
}

const DateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

export const TaskInput = z.object({
  jobId: z.string().uuid(),
  stageId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  assigneeEmployeeId: z.string().uuid().optional(),
  priority: z.enum(TASK_PRIORITIES).default("normal"),
  startDate: DateString,
  dueDate: DateString,
  estimatedMinutes: z.number().int().min(0).max(100000).optional(),
  parentTaskId: z.string().uuid().optional(),
  requiresApproval: z.boolean().default(false),
});

export async function createTask(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "tasks.manage");
  const data = TaskInput.parse(input);
  const id = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "task.create",
        entityType: "task",
        entityId: id,
        summary: `Added task: ${data.title}`,
      },
      activity: {
        entityType: "job",
        entityId: data.jobId,
        verb: "added",
        summary: `added task "${data.title}"`,
      },
    },
    async (tx) => {
      // RLS blocks cross-org, not cross-job inside the org: validate every
      // reference against THIS job before inserting.
      await assertWorkMutableIn(tx, ctx, data.jobId);
      if (data.stageId) {
        const st = (await tx.execute(sql`
          select 1 as ok from public.job_stage
          where org_id = ${ctx.orgId} and id = ${data.stageId} and job_id = ${data.jobId}
        `)) as unknown as Array<{ ok: number }>;
        if (st.length === 0) throw new Error("stage does not belong to this job");
      }
      if (data.assigneeEmployeeId) {
        const emp = (await tx.execute(sql`
          select 1 as ok from public.employee
          where org_id = ${ctx.orgId} and id = ${data.assigneeEmployeeId} and active = true
        `)) as unknown as Array<{ ok: number }>;
        if (emp.length === 0) throw new Error("assignee not found");
      }
      if (data.parentTaskId) {
        const parent = (await tx.execute(sql`
          select job_id::text as job_id, parent_task_id from public.task
          where org_id = ${ctx.orgId} and id = ${data.parentTaskId}
        `)) as unknown as Array<{ job_id: string; parent_task_id: string | null }>;
        if (!parent[0]) throw new Error("parent task not found");
        if (parent[0].job_id !== data.jobId) throw new Error("parent belongs to other work");
        if (parent[0].parent_task_id !== null) throw new TaskDepthError();
      }
      await tx.execute(sql`
        insert into public.task
          (id, org_id, job_id, stage_id, title, description, assignee_employee_id, priority,
           start_date, due_date, estimated_minutes, parent_task_id, requires_approval, created_by)
        values (${id}, ${ctx.orgId}, ${data.jobId}, ${data.stageId ?? null}, ${data.title},
                ${data.description ?? null}, ${data.assigneeEmployeeId ?? null}, ${data.priority},
                ${data.startDate ?? null}, ${data.dueDate ?? null},
                ${data.estimatedMinutes ?? null}, ${data.parentTaskId ?? null},
                ${data.requiresApproval}, ${ctx.userId})
      `);
    },
  );
  return { id };
}

export const TaskPatchInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).optional(),
  stageId: z.string().uuid().nullable().optional(),
  assigneeEmployeeId: z.string().uuid().nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
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
  estimatedMinutes: z.number().int().min(0).max(100000).nullable().optional(),
  requiresApproval: z.boolean().optional(),
});

export async function updateTask(
  ctx: Ctx,
  archetype: RoleArchetype,
  taskId: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "tasks.manage");
  const data = TaskPatchInput.parse(input);
  await command(
    ctx,
    {
      audit: (r: { title: string }) => ({
        action: "task.update",
        entityType: "task" as const,
        entityId: taskId,
        summary: `Updated task "${r.title}"`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select title, job_id::text as job_id from public.task
        where org_id = ${ctx.orgId} and id = ${taskId}
      `)) as unknown as Array<{ title: string; job_id: string }>;
      const task = rows[0];
      if (!task) throw new Error("task not found");
      await assertWorkMutableIn(tx, ctx, task.job_id);
      if (data.stageId) {
        const st = (await tx.execute(sql`
          select 1 as ok from public.job_stage
          where org_id = ${ctx.orgId} and id = ${data.stageId} and job_id = ${task.job_id}
        `)) as unknown as Array<{ ok: number }>;
        if (st.length === 0) throw new Error("stage does not belong to this job");
      }
      if (data.assigneeEmployeeId) {
        const emp = (await tx.execute(sql`
          select 1 as ok from public.employee
          where org_id = ${ctx.orgId} and id = ${data.assigneeEmployeeId} and active = true
        `)) as unknown as Array<{ ok: number }>;
        if (emp.length === 0) throw new Error("assignee not found");
      }
      await tx.execute(sql`
        update public.task set
          title = coalesce(${data.title ?? null}, title),
          description = ${data.description === undefined ? sql`description` : (data.description ?? null)},
          stage_id = ${data.stageId === undefined ? sql`stage_id` : (data.stageId ?? null)},
          assignee_employee_id = ${data.assigneeEmployeeId === undefined ? sql`assignee_employee_id` : (data.assigneeEmployeeId ?? null)},
          priority = coalesce(${data.priority ?? null}, priority),
          start_date = ${data.startDate === undefined ? sql`start_date` : (data.startDate ?? null)},
          due_date = ${data.dueDate === undefined ? sql`due_date` : (data.dueDate ?? null)},
          estimated_minutes = ${data.estimatedMinutes === undefined ? sql`estimated_minutes` : (data.estimatedMinutes ?? null)},
          requires_approval = coalesce(${data.requiresApproval ?? null}, requires_approval),
          updated_by = ${ctx.userId},
          updated_at = now()
        where org_id = ${ctx.orgId} and id = ${taskId}
      `);
      return { title: task.title };
    },
  );
}

export const TaskStatusInput = z.object({
  status: z.enum(TASK_STATUSES),
  /** Required when moving to blocked. */
  reason: z.string().trim().min(1).max(500).optional(),
  /** Optional effort recorded on completion. */
  actualMinutes: z.number().int().min(0).max(100000).optional(),
});

/**
 * The one task-status path. Enforces the transition graph, dependency
 * readiness, the blocked explanation, parent/child completion order, and the
 * optional completion approval; then recomputes downstream readiness.
 */
export async function updateTaskStatus(
  ctx: Ctx,
  archetype: RoleArchetype,
  taskId: string,
  input: unknown,
): Promise<{ status: TaskStatus; approvalRequested: boolean }> {
  assertCan(archetype, "tasks.update_status");
  const data = TaskStatusInput.parse(input);
  // Cancelling and reopening are task MANAGEMENT, not a field status update.
  if (data.status === "cancelled") assertCan(archetype, "tasks.manage");
  return command(
    ctx,
    {
      audit: (r: { title: string; status: string }) => ({
        action: "task.status",
        entityType: "task" as const,
        entityId: taskId,
        summary: `Task "${r.title}" -> ${r.status}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select title, job_id::text as job_id, status, requires_approval,
               parent_task_id::text as parent_task_id
        from public.task
        where org_id = ${ctx.orgId} and id = ${taskId}
        for update
      `)) as unknown as Array<{
        title: string;
        job_id: string;
        status: TaskStatus;
        requires_approval: boolean;
        parent_task_id: string | null;
      }>;
      const task = rows[0];
      if (!task) throw new Error("task not found");
      await assertWorkMutableIn(tx, ctx, task.job_id);
      if (archetype === "foreman" && !(await isAssignedIn(tx, ctx, task.job_id))) {
        throw new ForbiddenError("tasks.update_status");
      }
      // Reopening a completed task is management, like cancelling.
      if (task.status === "completed" && data.status !== "completed") {
        assertCan(archetype, "tasks.manage");
      }
      if (!TASK_TRANSITIONS[task.status].includes(data.status)) {
        throw new TaskTransitionError(task.status, data.status);
      }
      if (data.status === "blocked" && !data.reason) throw new TaskReasonRequiredError();

      // Dependency readiness: a task with unfinished prerequisites cannot claim
      // to be ready or in progress.
      if (data.status === "ready" || data.status === "in_progress") {
        const blockers = await countUnfinishedBlockersIn(tx, ctx, taskId);
        if (blockers > 0) throw new TaskBlockedError(blockers);
      }

      // Parent/child: a container never completes over unfinished contents, and
      // it never silently completes them either.
      let target: TaskStatus = data.status;
      if (target === "completed" || target === "awaiting_approval") {
        const open = (await tx.execute(sql`
          select count(*)::int as n from public.task
          where org_id = ${ctx.orgId} and parent_task_id = ${taskId}
            and archived = false and status <> all(array['completed', 'cancelled']::text[])
        `)) as unknown as Array<{ n: number }>;
        if ((open[0]?.n ?? 0) > 0) throw new TaskChildrenOpenError(open[0]!.n);
      }

      // An approval-gated task routes through the approval engine instead of
      // completing directly. The engine flips it to completed on approval.
      // (The transition graph already refuses completed from awaiting_approval,
      // so this only ever fires on the first submission.)
      let approvalRequested = false;
      if (target === "completed" && task.requires_approval) {
        target = "awaiting_approval";
      }

      await tx.execute(sql`
        update public.task set
          status = ${target},
          blocked_reason = ${target === "blocked" ? (data.reason ?? null) : null},
          completed_at = ${target === "completed" ? sql`coalesce(completed_at, now())` : sql`null`},
          actual_minutes = coalesce(${data.actualMinutes ?? null}, actual_minutes),
          updated_by = ${ctx.userId},
          updated_at = now()
        where org_id = ${ctx.orgId} and id = ${taskId}
      `);

      if (target === "awaiting_approval") {
        const jobRef = (await tx.execute(sql`
          select reference from public.job where org_id = ${ctx.orgId} and id = ${task.job_id}
        `)) as unknown as Array<{ reference: string }>;
        const res = await submitForApproval(tx, ctx, {
          subjectType: "task_completion",
          subjectId: taskId,
          subjectSummary: {
            title: task.title,
            jobRef: jobRef[0]?.reference ?? null,
          },
        });
        approvalRequested = true;
        // An auto-approving rule decides at submission: advance the subject here
        // (the engine hands that back to the caller, as quotes and supply do).
        if (res.decided) {
          await tx.execute(sql`
            update public.task set status = 'completed', completed_at = now(), updated_at = now()
            where org_id = ${ctx.orgId} and id = ${taskId} and status = 'awaiting_approval'
          `);
          target = "completed";
        }
      }

      // Finishing or reopening a task changes what its dependents may do.
      if (target === "completed" || target === "cancelled" || task.status === "completed") {
        await recomputeDownstreamReadinessIn(tx, ctx, taskId);
      }
      return { title: task.title, status: target, approvalRequested };
    },
  ).then((r) => ({ status: r.status, approvalRequested: r.approvalRequested }));
}

export async function setTaskArchived(
  ctx: Ctx,
  archetype: RoleArchetype,
  taskId: string,
  archived: boolean,
): Promise<void> {
  assertCan(archetype, "tasks.manage");
  await command(
    ctx,
    {
      audit: {
        action: archived ? "task.archive" : "task.restore",
        entityType: "task",
        entityId: taskId,
        summary: archived ? "Archived a task" : "Restored a task",
      },
    },
    (tx) =>
      tx.execute(sql`
        update public.task set archived = ${archived}, updated_by = ${ctx.userId}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${taskId}
      `),
  );
}

export type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  stageId: string | null;
  assigneeEmployeeId: string | null;
  assigneeName: string | null;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  parentTaskId: string | null;
  blockedReason: string | null;
  requiresApproval: boolean;
  archived: boolean;
};

function mapTask(r: Record<string, unknown>): TaskRow {
  return {
    id: r.id as string,
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    status: r.status as TaskStatus,
    priority: (r.priority as TaskPriority) ?? "normal",
    stageId: (r.stage_id as string | null) ?? null,
    assigneeEmployeeId: (r.assignee_employee_id as string | null) ?? null,
    assigneeName: (r.assignee_name as string | null) ?? null,
    startDate: (r.start_date as string | null) ?? null,
    dueDate: (r.due_date as string | null) ?? null,
    completedAt: (r.completed_at as string | null) ?? null,
    estimatedMinutes: r.estimated_minutes === null ? null : Number(r.estimated_minutes),
    actualMinutes: r.actual_minutes === null ? null : Number(r.actual_minutes),
    parentTaskId: (r.parent_task_id as string | null) ?? null,
    blockedReason: (r.blocked_reason as string | null) ?? null,
    requiresApproval: r.requires_approval === true,
    archived: r.archived === true,
  };
}

const TASK_SELECT = sql`
  select t.id::text as id, t.title, t.description, t.status, t.priority,
         t.stage_id::text as stage_id, t.assignee_employee_id::text as assignee_employee_id,
         e.name as assignee_name, t.start_date::text as start_date, t.due_date::text as due_date,
         t.completed_at::text as completed_at, t.estimated_minutes, t.actual_minutes,
         t.parent_task_id::text as parent_task_id, t.blocked_reason, t.requires_approval,
         t.archived
  from public.task t
  left join public.employee e on e.id = t.assignee_employee_id
`;

export async function listJobTasks(
  ctx: Ctx,
  jobId: string,
  opts: { includeArchived?: boolean; limit?: number } = {},
): Promise<TaskRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      ${TASK_SELECT}
      where t.org_id = ${ctx.orgId} and t.job_id = ${jobId}
        and (${opts.includeArchived === true} or t.archived = false)
      order by coalesce(t.parent_task_id, t.id), t.parent_task_id nulls first,
               t.due_date nulls last, t.created_at
      limit ${limit}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map(mapTask);
}

export async function getTask(
  ctx: Ctx,
  archetype: RoleArchetype,
  taskId: string,
): Promise<(TaskRow & { jobId: string; jobReference: string }) | null> {
  assertCan(archetype, "jobs.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      ${TASK_SELECT}
      where t.org_id = ${ctx.orgId} and t.id = ${taskId}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) return null;
  const job = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select j.id::text as id, j.reference from public.job j
      join public.task t on t.job_id = j.id
      where t.org_id = ${ctx.orgId} and t.id = ${taskId}
    `),
  )) as unknown as Array<{ id: string; reference: string }>;
  return { ...mapTask(rows[0]), jobId: job[0]?.id ?? "", jobReference: job[0]?.reference ?? "" };
}

/** In-transaction helper the approval engine's completion path can reuse. */
export async function markTaskCompletedIn(tx: TenantTx, ctx: Ctx, taskId: string): Promise<void> {
  await tx.execute(sql`
    update public.task set status = 'completed', completed_at = coalesce(completed_at, now()),
        updated_at = now()
    where org_id = ${ctx.orgId} and id = ${taskId} and status = 'awaiting_approval'
  `);
  await recomputeDownstreamReadinessIn(tx, ctx, taskId);
}
