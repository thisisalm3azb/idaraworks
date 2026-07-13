/**
 * The derived week VIEW (doc 11 S2; F-15 — the week_plan ENTITY stays cut).
 * A read-only SQL-side aggregate over jobs/stages/tasks/crew for one week
 * window: nothing is stored, nothing is published. Foreman sees only
 * assigned jobs (F-6).
 */
import { z } from "zod";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { assignedJobCondition } from "./assigned";
import { computeProgress, type StageForProgress } from "./progress";

export const WeekInput = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type WeekJob = {
  id: string;
  reference: string;
  name: string;
  statusKey: string;
  dueDate: string | null;
  dueThisWeek: boolean;
  overdue: boolean;
  currentStage: { en: string; ar: string } | null;
  progress: number | null;
  crew: string[];
  tasksDue: Array<{ id: string; title: string; dueDate: string; assigneeName: string | null }>;
};

export async function getWeekView(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ weekStart: string; weekEnd: string; jobs: WeekJob[] }> {
  assertCan(archetype, "week.view");
  const { weekStart } = WeekInput.parse(input);
  const foreman = archetype === "foreman";

  return withCtx(ctx, async (tx) => {
    const jobs = (await tx.execute(sql`
      select j.id::text as id, j.reference, j.name, j.status_key,
             j.due_date::text as due_date, j.progress_override,
             cs.name as current_stage_name
      from public.job j
      left join public.job_stage cs on cs.id = j.current_stage_id
      where j.org_id = ${ctx.orgId} and j.archived = false
        and (
          j.status_category in ('active', 'on_hold')
          or (j.due_date >= ${weekStart}::date and j.due_date < ${weekStart}::date + 7)
        )
        ${foreman ? sql`and ${assignedJobCondition(ctx)}` : sql``}
      order by j.due_date nulls last, j.reference
    `)) as unknown as Array<{
      id: string;
      reference: string;
      name: string;
      status_key: string;
      due_date: string | null;
      progress_override: number | null;
      current_stage_name: { en: string; ar: string } | null;
    }>;
    if (jobs.length === 0) {
      return { weekStart, weekEnd: addDays(weekStart, 7), jobs: [] };
    }
    const jobIds = jobs.map((j) => j.id);
    // drizzle's `sql` flattens a JS array to comma-separated params, so
    // `= any(${arr}::uuid[])` binds a SCALAR (malformed array literal) — build an
    // explicit IN-list instead. (Fixes a latent S2 week-view crash: this path was
    // never exercised by an S2 test, so the broken idiom shipped unnoticed.)
    const jobIdList = sql.join(
      jobIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );

    const stages = (await tx.execute(sql`
      select job_id::text as job_id, weight, status from public.job_stage
      where org_id = ${ctx.orgId} and job_id in (${jobIdList})
    `)) as unknown as Array<{ job_id: string; weight: number; status: StageForProgress["status"] }>;

    const crew = (await tx.execute(sql`
      select jc.job_id::text as job_id, e.name from public.job_crew jc
      join public.employee e on e.id = jc.employee_id
      where jc.org_id = ${ctx.orgId} and jc.job_id in (${jobIdList})
        and jc.removed_at is null
      order by e.name
    `)) as unknown as Array<{ job_id: string; name: string }>;

    const tasks = (await tx.execute(sql`
      select t.id::text as id, t.job_id::text as job_id, t.title,
             t.due_date::text as due_date, e.name as assignee_name
      from public.task t
      left join public.employee e on e.id = t.assignee_employee_id
      where t.org_id = ${ctx.orgId} and t.job_id in (${jobIdList})
        and t.status in ('pending', 'in_progress')
        and t.due_date >= ${weekStart}::date and t.due_date < ${weekStart}::date + 7
      order by t.due_date
    `)) as unknown as Array<{
      id: string;
      job_id: string;
      title: string;
      due_date: string;
      assignee_name: string | null;
    }>;

    const weekEnd = addDays(weekStart, 7);
    const today = new Date().toISOString().slice(0, 10);
    return {
      weekStart,
      weekEnd,
      jobs: jobs.map((j) => ({
        id: j.id,
        reference: j.reference,
        name: j.name,
        statusKey: j.status_key,
        dueDate: j.due_date,
        dueThisWeek: j.due_date !== null && j.due_date >= weekStart && j.due_date < weekEnd,
        overdue: j.due_date !== null && j.due_date < today,
        currentStage: j.current_stage_name,
        progress:
          j.progress_override !== null
            ? Number(j.progress_override)
            : computeProgress(stages.filter((s) => s.job_id === j.id)),
        crew: crew.filter((c) => c.job_id === j.id).map((c) => c.name),
        tasksDue: tasks
          .filter((t) => t.job_id === j.id)
          .map((t) => ({
            id: t.id,
            title: t.title,
            dueDate: t.due_date,
            assigneeName: t.assignee_name,
          })),
      })),
    };
  });
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
