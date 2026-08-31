/**
 * The weekly plan (H22.0).
 *
 * The week was a derived view over jobs and tasks, which is fine to look at and
 * impossible to issue: there was nothing to number, nothing to revise and
 * nothing to freeze. This adds the record that makes a week a document.
 *
 * It deliberately owns very little. Which jobs a week covers is a link table;
 * the phases, tasks, owners and dates render from the live work records at the
 * moment the document is produced. The plan stores what only a plan knows —
 * which week, who is responsible, the notes, and the issue and revision history.
 *
 * Lifecycle, matching every other issued document in the product:
 *   draft    → editable, renders with a DRAFT watermark, no snapshot
 *   issued   → frozen, carries its issuer snapshot, numbered
 *   revised  → superseded by a newer plan that names it and says why
 *   cancelled→ withdrawn, with a reason, history intact
 */
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { captureDocumentIssuerIn } from "./service";

export const WEEK_PLAN_STATUSES = ["draft", "issued", "revised", "cancelled"] as const;
export type WeekPlanStatus = (typeof WEEK_PLAN_STATUSES)[number];

export class WeekPlanImmutableError extends Error {
  constructor(status: string) {
    super(`a ${status} weekly plan cannot be edited`);
    this.name = "WeekPlanImmutableError";
  }
}
export class WeekPlanReasonRequiredError extends Error {
  constructor(what: string) {
    super(`${what} requires a reason`);
    this.name = "WeekPlanReasonRequiredError";
  }
}

export type WeekPlanRow = {
  id: string;
  reference: string;
  weekStart: string;
  weekEnd: string;
  title: string | null;
  managerUserId: string | null;
  managerName: string | null;
  notes: string | null;
  status: WeekPlanStatus;
  issuedAt: string | null;
  revisionOfId: string | null;
  revisionReason: string | null;
  cancelledReason: string | null;
  jobCount: number;
};

const mapRow = (r: Record<string, unknown>): WeekPlanRow => ({
  id: r.id as string,
  reference: r.reference as string,
  weekStart: r.week_start as string,
  weekEnd: r.week_end as string,
  title: (r.title as string | null) ?? null,
  managerUserId: (r.manager_user_id as string | null) ?? null,
  managerName: (r.manager_name as string | null) ?? null,
  notes: (r.notes as string | null) ?? null,
  status: r.status as WeekPlanStatus,
  issuedAt: (r.issued_at as string | null) ?? null,
  revisionOfId: (r.revision_of_id as string | null) ?? null,
  revisionReason: (r.revision_reason as string | null) ?? null,
  cancelledReason: (r.cancelled_reason as string | null) ?? null,
  jobCount: Number(r.job_count ?? 0),
});

const SELECT = sql`
  select p.id::text as id, p.reference, p.week_start::text as week_start,
         p.week_end::text as week_end, p.title, p.manager_user_id::text as manager_user_id,
         u.full_name as manager_name, p.notes, p.status, p.issued_at::text as issued_at,
         p.revision_of_id::text as revision_of_id, p.revision_reason, p.cancelled_reason,
         (select count(*)::int from public.week_plan_job j where j.week_plan_id = p.id) as job_count
  from public.week_plan p
  left join public.user_profile u on u.id = p.manager_user_id
`;

/**
 * The next reference for the org. Weekly plans are numbered by the week they
 * cover rather than a running counter, so WP-2026-W36 tells a reader which week
 * it is without opening it — and a re-issued week reuses its own number with a
 * revision suffix rather than jumping the sequence.
 */
function weekReference(weekStart: string, revision: number): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  // ISO week: Thursday of the current week decides the year.
  const target = new Date(d);
  target.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  const base = `WP-${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  return revision > 0 ? `${base}-R${revision}` : base;
}

/** Monday of the week containing `date`, in the organization's own calendar. */
export function weekStartOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

export async function listWeekPlans(
  ctx: Ctx,
  archetype: RoleArchetype,
  limit = 50,
): Promise<WeekPlanRow[]> {
  assertCan(archetype, "week.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`${SELECT} where p.org_id = ${ctx.orgId}
                   order by p.week_start desc, p.created_at desc
                   limit ${Math.min(Math.max(limit, 1), 200)}`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

export async function getWeekPlan(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<WeekPlanRow | null> {
  assertCan(archetype, "week.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`${SELECT} where p.org_id = ${ctx.orgId} and p.id = ${id}`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * The work a plan currently covers, for the draft editor.
 *
 * Scoped to one plan, so the row count is bounded by how much work a single
 * week covers rather than by how long the organization has been running.
 */
export async function listWeekPlanJobIds(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<string[]> {
  assertCan(archetype, "week.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select job_id::text as job_id from public.week_plan_job
      where org_id = ${ctx.orgId} and week_plan_id = ${id}
      order by sort
    `),
  )) as unknown as Array<{ job_id: string }>;
  return rows.map((r) => r.job_id);
}

export async function createWeekPlan(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: { weekStart: string; title?: string | null; managerUserId?: string | null },
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "week.manage");
  const start = weekStartOf(input.weekStart);
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  const weekEnd = end.toISOString().slice(0, 10);
  const reference = weekReference(start, 0);

  return command<{ id: string; reference: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "week_plan.create",
        entityType: "week_plan" as const,
        entityId: r.id,
        summary: `Created weekly plan ${r.reference}`,
      }),
    },
    async (tx) => {
      const [row] = (await tx.execute(sql`
        insert into public.week_plan
          (org_id, reference, week_start, week_end, title, manager_user_id, created_by)
        values (${ctx.orgId}, ${reference}, ${start}::date, ${weekEnd}::date,
                ${input.title ?? null}, ${input.managerUserId ?? null}, ${ctx.userId})
        returning id::text as id, reference
      `)) as unknown as Array<{ id: string; reference: string }>;
      return { id: row!.id, reference: row!.reference };
    },
  );
}

/** Guard: a plan that is no longer a draft refuses every content edit. */
async function assertDraft(
  tx: Parameters<Parameters<typeof withCtx>[1]>[0],
  ctx: Ctx,
  id: string,
): Promise<void> {
  const rows = (await tx.execute(sql`
    select status from public.week_plan where id = ${id} and org_id = ${ctx.orgId} for update
  `)) as unknown as Array<{ status: string }>;
  if (!rows[0]) throw new Error("weekly plan not found");
  if (rows[0].status !== "draft") throw new WeekPlanImmutableError(rows[0].status);
}

export async function setWeekPlanJobs(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  jobIds: readonly string[],
): Promise<void> {
  assertCan(archetype, "week.manage");
  await command(
    ctx,
    {
      audit: {
        action: "week_plan.update",
        entityType: "week_plan",
        entityId: id,
        summary: `Set the work covered by the weekly plan (${jobIds.length})`,
      },
    },
    async (tx) => {
      await assertDraft(tx, ctx, id);
      await tx.execute(sql`
        delete from public.week_plan_job where org_id = ${ctx.orgId} and week_plan_id = ${id}
      `);
      for (const [i, jobId] of jobIds.entries()) {
        await tx.execute(sql`
          insert into public.week_plan_job (org_id, week_plan_id, job_id, sort)
          values (${ctx.orgId}, ${id}, ${jobId}, ${i})
          on conflict (week_plan_id, job_id) do nothing
        `);
      }
    },
  );
}

export async function updateWeekPlan(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  input: { title?: string | null; managerUserId?: string | null; notes?: string | null },
): Promise<void> {
  assertCan(archetype, "week.manage");
  await command(
    ctx,
    {
      audit: {
        action: "week_plan.update",
        entityType: "week_plan",
        entityId: id,
        summary: "Updated the weekly plan",
      },
    },
    async (tx) => {
      await assertDraft(tx, ctx, id);
      await tx.execute(sql`
        update public.week_plan set
          title = ${input.title === undefined ? sql`title` : (input.title ?? null)},
          manager_user_id = ${input.managerUserId === undefined ? sql`manager_user_id` : (input.managerUserId ?? null)},
          notes = ${input.notes === undefined ? sql`notes` : (input.notes ?? null)},
          updated_at = now()
        where id = ${id} and org_id = ${ctx.orgId}
      `);
    },
  );
}

/**
 * Issue the plan. This is the moment it stops being editable and starts being a
 * document, so the issuer identity is captured in the same transaction.
 */
export async function issueWeekPlan(ctx: Ctx, archetype: RoleArchetype, id: string): Promise<void> {
  assertCan(archetype, "week.manage");
  await command(
    ctx,
    {
      audit: {
        action: "week_plan.issue",
        entityType: "week_plan",
        entityId: id,
        summary: "Issued the weekly plan",
      },
    },
    async (tx) => {
      await assertDraft(tx, ctx, id);
      await tx.execute(sql`
        update public.week_plan
        set status = 'issued', issued_at = now(), issued_by = ${ctx.userId}, updated_at = now()
        where id = ${id} and org_id = ${ctx.orgId} and status = 'draft'
      `);
      await captureDocumentIssuerIn(tx, ctx, "week_plan", id);
    },
  );
}

/**
 * Revise an issued plan: the original is marked revised and KEPT, and a new
 * draft is created that names it and records why. Nothing is overwritten, so
 * the plan that was circulated stays exactly as it was circulated.
 */
export async function reviseWeekPlan(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  reason: string,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "week.manage");
  const trimmed = reason.trim();
  if (!trimmed) throw new WeekPlanReasonRequiredError("Revising a plan");

  return command<{ id: string; reference: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "week_plan.revise",
        entityType: "week_plan" as const,
        entityId: r.id,
        summary: `Revised the weekly plan as ${r.reference}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select status, week_start::text as week_start, week_end::text as week_end,
               title, manager_user_id::text as manager_user_id, notes,
               (select count(*)::int from public.week_plan p2
                 where p2.org_id = ${ctx.orgId} and p2.week_start = p.week_start) as siblings
        from public.week_plan p where p.id = ${id} and p.org_id = ${ctx.orgId} for update
      `)) as unknown as Array<Record<string, unknown>>;
      const prev = rows[0];
      if (!prev) throw new Error("weekly plan not found");
      if (prev.status !== "issued") throw new WeekPlanImmutableError(String(prev.status));

      // The superseded plan keeps its row and its snapshot.
      await tx.execute(sql`
        update public.week_plan set status = 'revised', updated_at = now()
        where id = ${id} and org_id = ${ctx.orgId}
      `);
      const reference = weekReference(prev.week_start as string, Number(prev.siblings ?? 1));
      const [row] = (await tx.execute(sql`
        insert into public.week_plan
          (org_id, reference, week_start, week_end, title, manager_user_id, notes,
           revision_of_id, revision_reason, created_by)
        values (${ctx.orgId}, ${reference}, ${prev.week_start}::date, ${prev.week_end}::date,
                ${prev.title ?? null}, ${prev.manager_user_id ?? null}, ${prev.notes ?? null},
                ${id}, ${trimmed}, ${ctx.userId})
        returning id::text as id, reference
      `)) as unknown as Array<{ id: string; reference: string }>;
      // The new draft covers the same work until someone changes it.
      await tx.execute(sql`
        insert into public.week_plan_job (org_id, week_plan_id, job_id, sort, note)
        select ${ctx.orgId}, ${row!.id}, j.job_id, j.sort, j.note
        from public.week_plan_job j
        where j.org_id = ${ctx.orgId} and j.week_plan_id = ${id}
      `);
      return { id: row!.id, reference: row!.reference };
    },
  );
}

export async function cancelWeekPlan(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  reason: string,
): Promise<void> {
  assertCan(archetype, "week.manage");
  const trimmed = reason.trim();
  if (!trimmed) throw new WeekPlanReasonRequiredError("Cancelling a plan");
  await command(
    ctx,
    {
      audit: {
        action: "week_plan.cancel",
        entityType: "week_plan",
        entityId: id,
        summary: `Cancelled the weekly plan: ${trimmed}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select status from public.week_plan where id = ${id} and org_id = ${ctx.orgId} for update
      `)) as unknown as Array<{ status: string }>;
      if (!rows[0]) throw new Error("weekly plan not found");
      if (rows[0].status === "cancelled") return;
      await tx.execute(sql`
        update public.week_plan
        set status = 'cancelled', cancelled_reason = ${trimmed},
            issued_at = coalesce(issued_at, now()), issued_by = coalesce(issued_by, ${ctx.userId}),
            updated_at = now()
        where id = ${id} and org_id = ${ctx.orgId}
      `);
    },
  );
}
