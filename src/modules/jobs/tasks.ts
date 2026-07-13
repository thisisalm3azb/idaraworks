/**
 * Tasks (doc 01: checklists that inform humans, never the progress math — U7).
 * Manager+ manage; foreman updates STATUS on assigned jobs (doc 06 "C
 * (assigned)"). Cancelled, never deleted (D-1.7).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, ForbiddenError } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { isAssignedIn } from "./assigned";

export const TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

export const TaskInput = z.object({
  jobId: z.string().uuid(),
  stageId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200),
  assigneeEmployeeId: z.string().uuid().optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
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
    (tx) =>
      tx.execute(sql`
        insert into public.task
          (id, org_id, job_id, stage_id, title, assignee_employee_id, due_date, created_by)
        values (${id}, ${ctx.orgId}, ${data.jobId}, ${data.stageId ?? null}, ${data.title},
                ${data.assigneeEmployeeId ?? null}, ${data.dueDate ?? null}, ${ctx.userId})
      `),
  );
  return { id };
}

export const TaskStatusInput = z.object({ status: z.enum(TASK_STATUSES) });

export async function updateTaskStatus(
  ctx: Ctx,
  archetype: RoleArchetype,
  taskId: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "tasks.update_status");
  const { status } = TaskStatusInput.parse(input);
  // Cancelling is task MANAGEMENT (manager+), not a field status update.
  if (status === "cancelled") assertCan(archetype, "tasks.manage");
  await command(
    ctx,
    {
      audit: (r: { title: string }) => ({
        action: "task.status",
        entityType: "task" as const,
        entityId: taskId,
        summary: `Task "${r.title}" → ${status}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select title, job_id::text as job_id from public.task
        where org_id = ${ctx.orgId} and id = ${taskId}
      `)) as unknown as Array<{ title: string; job_id: string }>;
      const task = rows[0];
      if (!task) throw new Error("task not found");
      if (archetype === "foreman" && !(await isAssignedIn(tx, ctx, task.job_id))) {
        throw new ForbiddenError("tasks.update_status");
      }
      await tx.execute(sql`
        update public.task set status = ${status}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${taskId}
      `);
      return { title: task.title };
    },
  );
}

export type TaskRow = {
  id: string;
  title: string;
  status: (typeof TASK_STATUSES)[number];
  stageId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
};

export async function listJobTasks(ctx: Ctx, jobId: string): Promise<TaskRow[]> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select t.id::text as id, t.title, t.status, t.stage_id::text as stage_id,
             e.name as assignee_name, t.due_date::text as due_date
      from public.task t
      left join public.employee e on e.id = t.assignee_employee_id
      where t.org_id = ${ctx.orgId} and t.job_id = ${jobId}
      order by t.status, t.due_date nulls last, t.created_at
    `),
  )) as unknown as Array<{
    id: string;
    title: string;
    status: (typeof TASK_STATUSES)[number];
    stage_id: string | null;
    assignee_name: string | null;
    due_date: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    stageId: r.stage_id,
    assigneeName: r.assignee_name,
    dueDate: r.due_date,
  }));
}
