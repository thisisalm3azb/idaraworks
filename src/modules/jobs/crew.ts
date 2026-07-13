/**
 * job_crew (F-14: plain job × employee membership; the F-6 assignment source).
 * Manager+ manage; soft removal (removed_at) — history preserved, no DELETE.
 */
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";

export async function addCrewMember(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  employeeId: string,
): Promise<void> {
  assertCan(archetype, "crew.manage");
  await command(
    ctx,
    {
      audit: (r: { name: string }) => ({
        action: "job_crew.add",
        entityType: "job" as const,
        entityId: jobId,
        summary: `Added ${r.name} to the crew`,
      }),
      activity: (r: { name: string }) => ({
        entityType: "job" as const,
        entityId: jobId,
        verb: "assigned",
        summary: `assigned ${r.name} to the crew`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select name from public.employee where org_id = ${ctx.orgId} and id = ${employeeId}
      `)) as unknown as Array<{ name: string }>;
      if (!rows[0]) throw new Error("employee not found");
      // Re-adding a removed member revives the SAME row (PK job+employee).
      await tx.execute(sql`
        insert into public.job_crew (org_id, job_id, employee_id, added_by)
        values (${ctx.orgId}, ${jobId}, ${employeeId}, ${ctx.userId})
        on conflict (job_id, employee_id) do update
          set removed_at = null, removed_by = null, added_by = ${ctx.userId}, added_at = now()
      `);
      return { name: rows[0].name };
    },
  );
}

export async function removeCrewMember(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  employeeId: string,
): Promise<void> {
  assertCan(archetype, "crew.manage");
  await command(
    ctx,
    {
      audit: (r: { name: string }) => ({
        action: "job_crew.remove",
        entityType: "job" as const,
        entityId: jobId,
        summary: `Removed ${r.name} from the crew`,
      }),
      activity: (r: { name: string }) => ({
        entityType: "job" as const,
        entityId: jobId,
        verb: "unassigned",
        summary: `removed ${r.name} from the crew`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select e.name from public.job_crew jc
        join public.employee e on e.id = jc.employee_id
        where jc.org_id = ${ctx.orgId} and jc.job_id = ${jobId}
          and jc.employee_id = ${employeeId} and jc.removed_at is null
      `)) as unknown as Array<{ name: string }>;
      if (!rows[0]) throw new Error("crew member not found");
      await tx.execute(sql`
        update public.job_crew
        set removed_at = now(), removed_by = ${ctx.userId}
        where org_id = ${ctx.orgId} and job_id = ${jobId} and employee_id = ${employeeId}
      `);
      return { name: rows[0].name };
    },
  );
}

export type CrewRow = { employeeId: string; name: string; teamName: string | null };

export async function listCrew(ctx: Ctx, jobId: string): Promise<CrewRow[]> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select jc.employee_id::text as employee_id, e.name, t.name as team_name
      from public.job_crew jc
      join public.employee e on e.id = jc.employee_id
      left join public.team t on t.id = e.team_id
      where jc.org_id = ${ctx.orgId} and jc.job_id = ${jobId} and jc.removed_at is null
      order by e.name
    `),
  )) as unknown as Array<{ employee_id: string; name: string; team_name: string | null }>;
  return rows.map((r) => ({ employeeId: r.employee_id, name: r.name, teamName: r.team_name }));
}
