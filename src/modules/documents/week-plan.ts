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

/** More work than any real week covers; a longer list is a malformed post. */
export const MAX_WEEK_PLAN_JOBS = 500;

export class WeekPlanTooManyJobsError extends Error {
  constructor(count: number) {
    super(`a weekly plan covers at most ${MAX_WEEK_PLAN_JOBS} jobs, received ${count}`);
    this.name = "WeekPlanTooManyJobsError";
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
         (select count(*)::int from public.week_plan_job j
           where j.week_plan_id = p.id and j.removed_at is null) as job_count
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

/**
 * A page of plans, newest week first.
 *
 * week_plan is an archive: one row per week per org, plus one per revision,
 * forever. A silent cap would quietly hide older weeks with nothing in the UI to
 * say so, which is why this reports whether more exist rather than just handing
 * back a truncated list.
 */
export async function listWeekPlans(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ rows: WeekPlanRow[]; hasMore: boolean }> {
  assertCan(archetype, "week.view");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  // One row beyond the page, to know whether a "show older" control is honest.
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`${SELECT} where p.org_id = ${ctx.orgId}
                   order by p.week_start desc, p.created_at desc
                   limit ${limit + 1} offset ${offset}`),
  )) as unknown as Array<Record<string, unknown>>;
  return { rows: rows.slice(0, limit).map(mapRow), hasMore: rows.length > limit };
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
      where org_id = ${ctx.orgId} and week_plan_id = ${id} and removed_at is null
      order by sort
    `),
  )) as unknown as Array<{ job_id: string }>;
  return rows.map((r) => r.job_id);
}

/** Jobs offered in the draft's work picker. */
const PICKER_LIMIT = 300;

export type PickerJob = {
  id: string;
  reference: string;
  name: string;
  customerName: string | null;
  dueDate: string | null;
  selected: boolean;
};

/**
 * The work a draft plan may cover: open jobs, plus anything already selected.
 *
 * The already-selected arm is not a nicety. setWeekPlanJobs REPLACES the set
 * from what the form posts, so a selected job the picker did not render would be
 * dropped silently the next time anyone pressed save. Including it guarantees
 * the form always posts back everything it is responsible for.
 *
 * public.job grows for the life of the tenant, so the open arm is capped and
 * ordered by due date: a plan is made from what is due, not from the archive.
 */
export async function listWeekPlanPickerJobs(
  ctx: Ctx,
  archetype: RoleArchetype,
  planId: string,
): Promise<PickerJob[]> {
  assertCan(archetype, "week.manage");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      with selected as (
        select job_id from public.week_plan_job
        where org_id = ${ctx.orgId} and week_plan_id = ${planId} and removed_at is null
      ),
      candidates as (
        select j.id
        from public.job j
        where j.org_id = ${ctx.orgId} and j.archived = false
          and j.status_category in ('active', 'on_hold')
        order by j.due_date nulls last, j.reference
        limit ${PICKER_LIMIT}
      )
      select j.id::text as id, j.reference, j.name, c.name as customer_name,
             j.due_date::text as due_date,
             (s.job_id is not null) as selected
      from public.job j
      left join selected s on s.job_id = j.id
      left join public.customer c on c.id = j.customer_id and c.org_id = j.org_id
      where j.org_id = ${ctx.orgId}
        and (j.id in (select id from candidates) or s.job_id is not null)
      order by (s.job_id is not null) desc, j.due_date nulls last, j.reference
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    reference: r.reference as string,
    name: r.name as string,
    customerName: (r.customer_name as string | null) ?? null,
    dueDate: (r.due_date as string | null) ?? null,
    selected: r.selected === true,
  }));
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
      /*
       * The reference is numbered from how many plans this week has already
       * had, not fixed at revision 0.
       *
       * `week_plan_reference_uq` covers every status, while the live-week index
       * is partial. Always computing revision 0 therefore made a cancelled plan
       * burn its week permanently: the week is free by the live index, so the
       * business may plan it again, but the reference is taken forever and the
       * insert fails. Counting siblings gives the new plan the next number, and
       * says truthfully that it is not the first document issued for that week.
       */
      const [prior] = (await tx.execute(sql`
        select count(*)::int as n from public.week_plan
        where org_id = ${ctx.orgId} and week_start = ${start}::date
      `)) as unknown as Array<{ n: number }>;
      const reference = weekReference(start, Number(prior?.n ?? 0));

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
  // The selection arrives from a form, so it is whatever was posted: deduplicate
  // it, and refuse a list long enough to hold a transaction open for hundreds of
  // round trips on a shared transaction-mode pool.
  const unique = [...new Set(jobIds.filter(Boolean))];
  if (unique.length > MAX_WEEK_PLAN_JOBS) {
    throw new WeekPlanTooManyJobsError(unique.length);
  }

  await command(
    ctx,
    {
      audit: {
        action: "week_plan.update",
        entityType: "week_plan",
        entityId: id,
        summary: `Set the work covered by the weekly plan (${unique.length})`,
      },
    },
    async (tx) => {
      await assertDraft(tx, ctx, id);
      // Mark everything off the plan, then revive exactly what was selected.
      // Nothing is deleted, so the app role needs no DELETE grant and an issued
      // plan's lines cannot be destroyed by any code path (D-1.7).
      await tx.execute(sql`
        update public.week_plan_job set removed_at = now()
        where org_id = ${ctx.orgId} and week_plan_id = ${id} and removed_at is null
      `);
      if (unique.length === 0) return;
      // One statement rather than one per job. The ids are passed as a single
      // text parameter and split server-side: binding a JS array here would make
      // drizzle expand it into row constructors.
      await tx.execute(sql`
        insert into public.week_plan_job (org_id, week_plan_id, job_id, sort)
        select ${ctx.orgId}, ${id}, j.id::uuid, j.ord - 1
        from unnest(string_to_array(${unique.join(",")}, ',')::uuid[])
             with ordinality as j(id, ord)
        on conflict (week_plan_id, job_id)
        do update set sort = excluded.sort, removed_at = null
      `);
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
        where j.org_id = ${ctx.orgId} and j.week_plan_id = ${id} and j.removed_at is null
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
      /*
       * Only a plan that was actually issued can be withdrawn.
       *
       * Cancelling a DRAFT used to write `issued_at = coalesce(issued_at, now())`,
       * inventing an issue record for a document that was never issued — the
       * audit trail would then show a plan issued and withdrawn on the same day
       * that nobody ever saw. A draft is deleted from the working set by simply
       * not issuing it; there is nothing to withdraw.
       *
       * A REVISED plan is already superseded and must stay exactly as it was
       * circulated, so it is not cancellable either: cancel its live successor.
       */
      if (rows[0].status !== "issued") throw new WeekPlanImmutableError(rows[0].status);
      await tx.execute(sql`
        update public.week_plan
        set status = 'cancelled', cancelled_reason = ${trimmed}, updated_at = now()
        where id = ${id} and org_id = ${ctx.orgId} and status = 'issued'
      `);
    },
  );
}
