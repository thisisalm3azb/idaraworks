/**
 * H25H — task allocations: which people give what share of their working day
 * to a task while it runs. Owned by the jobs module (the task is canonical);
 * the studio's capacity engine reads these through the door and never writes
 * them from a view. A task keeps its single `assignee` (who is accountable);
 * allocations are who does the work.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";

export type AllocationRow = {
  id: string;
  taskId: string;
  employeeId: string;
  employeeName: string;
  sharePct: number;
  note: string | null;
};

const CHUNK = 500;

/** Live allocations for the given tasks, chunked so any plan size is safe. */
export async function listTaskAllocations(
  ctx: Ctx,
  archetype: RoleArchetype,
  taskIds: string[],
): Promise<AllocationRow[]> {
  assertCan(archetype, "tasks.view");
  const out: AllocationRow[] = [];
  if (taskIds.length === 0) return out;
  for (let i = 0; i < taskIds.length; i += CHUNK) {
    const slice = taskIds.slice(i, i + CHUNK);
    const rows = (await withCtx(ctx, (tx) =>
      tx.execute(sql`
        select a.id::text as id, a.task_id::text as task_id, a.employee_id::text as employee_id,
               e.name as employee_name, a.share_pct, a.note
        from public.task_allocation a
        join public.employee e on e.id = a.employee_id and e.org_id = a.org_id
        where a.org_id = ${ctx.orgId} and a.removed_at is null
          and a.task_id = any(string_to_array(${slice.join(",")}, ',')::uuid[])
        order by e.name
      `),
    )) as unknown as Array<{
      id: string;
      task_id: string;
      employee_id: string;
      employee_name: string;
      share_pct: number;
      note: string | null;
    }>;
    for (const r of rows) {
      out.push({
        id: r.id,
        taskId: r.task_id,
        employeeId: r.employee_id,
        employeeName: r.employee_name,
        sharePct: Number(r.share_pct),
        note: r.note,
      });
    }
  }
  return out;
}

export const AllocateTaskInput = z.object({
  taskId: z.string().uuid(),
  employeeId: z.string().uuid(),
  sharePct: z.number().int().min(1).max(100).default(100),
  note: z.string().trim().max(500).optional(),
});

/** Add a person to a task, or change their share if already on it. */
export async function allocateTask(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "tasks.manage");
  const input = AllocateTaskInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "task.allocate",
        entityType: "task_allocation",
        entityId: r.id,
        summary: `Allocated ${input.sharePct}% of a person to a task`,
      }),
    },
    async (tx) => {
      const updated = (await tx.execute(sql`
        update public.task_allocation
        set share_pct = ${input.sharePct}, note = ${input.note ?? null}, updated_at = now()
        where org_id = ${ctx.orgId} and task_id = ${input.taskId}
          and employee_id = ${input.employeeId} and removed_at is null
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      if (updated[0]) return { id: updated[0].id };
      const rows = (await tx.execute(sql`
        insert into public.task_allocation (org_id, task_id, employee_id, share_pct, note, created_by)
        values (${ctx.orgId}, ${input.taskId}, ${input.employeeId}, ${input.sharePct},
                ${input.note ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export async function unallocateTask(
  ctx: Ctx,
  archetype: RoleArchetype,
  allocationId: string,
): Promise<void> {
  assertCan(archetype, "tasks.manage");
  await command(
    ctx,
    {
      audit: {
        action: "task.unallocate",
        entityType: "task_allocation",
        entityId: allocationId,
        summary: "Removed a person from a task",
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.task_allocation set removed_at = now(), updated_at = now()
        where org_id = ${ctx.orgId} and id = ${allocationId} and removed_at is null
      `);
    },
  );
}
