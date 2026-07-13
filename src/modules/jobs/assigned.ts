/**
 * The F-6 assigned_job resolver (doc 06, audit F-6) — THE one assignment
 * source: `user = job.manager_user_id ∨ user = job.foreman_user_id ∨ the
 * user's linked employee has an active job_crew row`. Every assigned-scope
 * gate (foreman job visibility, stage/task/report conditions) uses this;
 * no other assignment source exists in MVP.
 */
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";

/** SQL fragment for narrowing a jobs query (alias the job table as j). */
export function assignedJobCondition(ctx: Ctx) {
  return sql`(
    j.manager_user_id = ${ctx.userId}
    or j.foreman_user_id = ${ctx.userId}
    or exists (
      select 1 from public.job_crew jc
      join public.employee e on e.id = jc.employee_id
      where jc.job_id = j.id and jc.removed_at is null and e.user_id = ${ctx.userId}
    )
  )`;
}

/** In-transaction point check for one job. */
export async function isAssignedIn(tx: TenantTx, ctx: Ctx, jobId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    select 1 as ok from public.job j
    where j.org_id = ${ctx.orgId} and j.id = ${jobId} and ${assignedJobCondition(ctx)}
  `)) as unknown as Array<{ ok: number }>;
  return rows.length > 0;
}

export async function isAssigned(ctx: Ctx, jobId: string): Promise<boolean> {
  return withCtx(ctx, (tx) => isAssignedIn(tx, ctx, jobId));
}
