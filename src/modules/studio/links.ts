/**
 * H25C — pickers for linking existing records onto the canvas and for
 * converting draft shapes into real work. Read-only, bounded, permission-
 * checked with the RECORD's own view action (a plan never widens access).
 */
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { listJobTasks } from "@/modules/jobs/service";

export type LinkableJob = {
  id: string;
  reference: string;
  name: string;
  statusCategory: string;
  stages: Array<{ id: string; name: string }>;
};

export async function listLinkableJobs(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { search?: string; limit?: number } = {},
): Promise<LinkableJob[]> {
  assertCan(archetype, "studio.view");
  assertCan(archetype, "jobs.view");
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 300);
  const pattern = opts.search ? `%${opts.search.trim()}%` : null;
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select j.id::text as id, j.reference, j.name, j.status_category,
             coalesce((
               select json_agg(json_build_object('id', s.id::text, 'name', s.name->>'en')
                                order by s.sort)
               from public.job_stage s where s.job_id = j.id and s.org_id = j.org_id
             ), '[]'::json) as stages
      from public.job j
      where j.org_id = ${ctx.orgId} and j.archived = false
        and j.status_category in ('draft', 'active', 'on_hold')
        ${pattern ? sql`and (j.name ilike ${pattern} or j.reference ilike ${pattern})` : sql``}
      order by j.updated_at desc
      limit ${limit}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    reference: r.reference as string,
    name: r.name as string,
    statusCategory: r.status_category as string,
    stages: (r.stages as Array<{ id: string; name: string }>) ?? [],
  }));
}

export type LinkableTask = { id: string; title: string; status: string; dueDate: string | null };

export async function listLinkableTasks(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
): Promise<LinkableTask[]> {
  assertCan(archetype, "studio.view");
  assertCan(archetype, "tasks.view");
  const tasks = await listJobTasks(ctx, jobId, { limit: 300 });
  return tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, dueDate: t.dueDate }));
}
