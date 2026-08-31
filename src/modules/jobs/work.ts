/**
 * H21 — the work reads behind the work hub, My Work and the schedule.
 *
 * Every query here is bounded and org-scoped, aggregates in SQL rather than in
 * the process, and never loops per task. Assignment scope reuses the one
 * resolver the rest of the app uses (assignedJobCondition), so a foreman sees
 * exactly the work they see everywhere else.
 *
 * Nothing here invents capacity. Where working hours are unknown the language
 * stays factual — counts and scheduled load, never "overloaded".
 */
import { assertCan, can } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { assignedJobCondition } from "./assigned";

export const WORK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type WorkPriority = (typeof WORK_PRIORITIES)[number];

export type WorkListFilters = {
  q?: string;
  /** Semantic category, not the org's own status key. */
  category?: string;
  stageKey?: string;
  ownerUserId?: string;
  /** Employee id — work whose crew or tasks include this person. */
  assigneeEmployeeId?: string;
  customerId?: string;
  /** One priority or a set of them. */
  priority?: WorkPriority | readonly WorkPriority[];
  /** Only work with no owner assigned. */
  unowned?: boolean;
  /** Only work still open (draft, active or on hold). */
  openOnly?: boolean;
  origin?: "quotation" | "opportunity" | "direct";
  /** Target date window (inclusive, org calendar dates). */
  dueFrom?: string;
  dueTo?: string;
  /** Past its target date and still open, as of this org day. */
  overdue?: string;
  archived?: boolean;
  scope?: "mine";
  limit?: number;
};

export type WorkRow = {
  id: string;
  reference: string;
  name: string;
  statusKey: string;
  statusCategory: string;
  priority: WorkPriority;
  customerId: string | null;
  customerName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  startDate: string | null;
  dueDate: string | null;
  completedDate: string | null;
  currentStageName: { en: string; ar: string } | null;
  origin: string;
  archived: boolean;
  openTasks: number;
  overdueTasks: number;
  blockedTasks: number;
};

function mapWork(r: Record<string, unknown>): WorkRow {
  return {
    id: r.id as string,
    reference: r.reference as string,
    name: r.name as string,
    statusKey: r.status_key as string,
    statusCategory: r.status_category as string,
    priority: (r.priority as WorkPriority) ?? "normal",
    customerId: (r.customer_id as string | null) ?? null,
    customerName: (r.customer_name as string | null) ?? null,
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null,
    startDate: (r.start_date as string | null) ?? null,
    dueDate: (r.due_date as string | null) ?? null,
    completedDate: (r.completed_date as string | null) ?? null,
    currentStageName: (r.current_stage_name as { en: string; ar: string } | null) ?? null,
    origin: (r.origin as string) ?? "direct",
    archived: r.archived === true,
    openTasks: Number(r.open_tasks ?? 0),
    overdueTasks: Number(r.overdue_tasks ?? 0),
    blockedTasks: Number(r.blocked_tasks ?? 0),
  };
}

export const OPEN_TASK_STATUSES = [
  "pending",
  "ready",
  "in_progress",
  "blocked",
  "awaiting_approval",
] as const;

/** A CODE CONSTANT rendered inline: a bound array parameter is expanded by the
 * driver into a row constructor, which cannot be cast to text[]. No user input
 * ever reaches this fragment. */
const OPEN_TASK_SQL = sql.raw(`('${OPEN_TASK_STATUSES.join("','")}')`);

/**
 * The work hub list. Task counts come from ONE grouped subquery — never a
 * per-row query — so the list costs the same at ten records or a thousand.
 */
export async function listWork(
  ctx: Ctx,
  archetype: RoleArchetype,
  filters: WorkListFilters = {},
): Promise<WorkRow[]> {
  assertCan(archetype, "jobs.view");
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const q = (filters.q ?? "").trim();
  const pattern = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  // A foreman is ALWAYS narrowed to assigned work, whatever the caller asked.
  const assignedOnly = archetype === "foreman" || filters.scope === "mine";
  const asOf = filters.overdue ?? null;
  // A bound JS array becomes a row constructor, not an array literal, so the set
  // travels as a comma string and is split server-side. Values are closed
  // vocabulary, already whitelisted by the parser.
  const priorities = filters.priority
    ? (Array.isArray(filters.priority) ? filters.priority : [filters.priority]).join(",")
    : null;

  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      with task_counts as (
        select job_id,
               count(*) filter (where status in ${OPEN_TASK_SQL})::int as open_tasks,
               count(*) filter (where status in ${OPEN_TASK_SQL}
                                 and due_date is not null
                                 and due_date < coalesce(${asOf}::date, current_date))::int as overdue_tasks,
               count(*) filter (where status = 'blocked')::int as blocked_tasks
        from public.task
        where org_id = ${ctx.orgId} and archived = false
        group by job_id
      )
      select j.id::text as id, j.reference, j.name, j.status_key, j.status_category, j.priority,
             j.customer_id::text as customer_id, c.name as customer_name,
             j.owner_user_id::text as owner_user_id, u.full_name as owner_name,
             j.start_date::text as start_date, j.due_date::text as due_date,
             j.completed_date::text as completed_date, j.origin, j.archived,
             cs.name as current_stage_name,
             coalesce(tc.open_tasks, 0) as open_tasks,
             coalesce(tc.overdue_tasks, 0) as overdue_tasks,
             coalesce(tc.blocked_tasks, 0) as blocked_tasks
      from public.job j
      left join public.customer c on c.id = j.customer_id
      left join public.user_profile u on u.id = j.owner_user_id
      left join public.job_stage cs on cs.id = j.current_stage_id
      left join task_counts tc on tc.job_id = j.id
      where j.org_id = ${ctx.orgId}
        and j.archived = ${filters.archived === true}
        and (${filters.category ?? null}::text is null or j.status_category = ${filters.category ?? null})
        and (${priorities}::text is null
             or j.priority = any(string_to_array(${priorities}, ',')))
        and (${!filters.unowned} or j.owner_user_id is null)
        and (${!filters.openOnly} or j.status_category in ('draft', 'active', 'on_hold'))
        and (${filters.origin ?? null}::text is null or j.origin = ${filters.origin ?? null})
        and (${filters.customerId ?? null}::uuid is null or j.customer_id = ${filters.customerId ?? null}::uuid)
        and (${filters.ownerUserId ?? null}::uuid is null or j.owner_user_id = ${filters.ownerUserId ?? null}::uuid)
        and (${filters.stageKey ?? null}::text is null or cs.stage_key = ${filters.stageKey ?? null})
        and (${filters.dueFrom ?? null}::date is null or j.due_date >= ${filters.dueFrom ?? null}::date)
        and (${filters.dueTo ?? null}::date is null or j.due_date <= ${filters.dueTo ?? null}::date)
        and (${asOf}::date is null or (
              j.due_date is not null and j.due_date < ${asOf}::date
              and j.status_category in ('draft', 'active', 'on_hold')))
        and (${pattern}::text is null
             or j.name ilike ${pattern} or j.reference ilike ${pattern}
             or coalesce(c.name, '') ilike ${pattern})
        and (${filters.assigneeEmployeeId ?? null}::uuid is null or exists (
              select 1 from public.job_crew jc
              where jc.org_id = j.org_id and jc.job_id = j.id and jc.removed_at is null
                and jc.employee_id = ${filters.assigneeEmployeeId ?? null}::uuid))
        and (${!assignedOnly} or ${assignedJobCondition(ctx)})
      order by
        case j.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
        j.due_date nulls last, j.created_at desc
      limit ${limit}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map(mapWork);
}

/** Counts for the hub's filter chips — one grouped query, never N queries. */
export async function workCountsByCategory(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<Record<string, number>> {
  assertCan(archetype, "jobs.view");
  const assignedOnly = archetype === "foreman";
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select j.status_category as k, count(*)::int as n
      from public.job j
      where j.org_id = ${ctx.orgId} and j.archived = false
        and (${!assignedOnly} or ${assignedJobCondition(ctx)})
      group by 1
    `),
  )) as unknown as Array<{ k: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));
}

// ── My Work (Part L) ────────────────────────────────────────────────────────
export type MyTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  blockedReason: string | null;
  jobId: string;
  jobReference: string;
  jobName: string;
  blockers: number;
};

/** The buckets My Work is divided into. Order is the order they are shown. */
export const MY_WORK_BUCKETS = ["overdue", "today", "blocked", "approvals", "next"] as const;
export type MyWorkBucketKey = (typeof MY_WORK_BUCKETS)[number];

/** One page of a bucket. 50 is a page a person can actually read on a phone. */
export const MY_WORK_PAGE_SIZE = 50;
/** How many rows of each bucket the combined "now" view previews. */
export const MY_WORK_PREVIEW = 5;

export type MyWorkBucket = {
  key: MyWorkBucketKey;
  /** The TRUE number of records in this bucket, counted in SQL over all of them. */
  total: number;
  /** The rows actually being shown: a page when focused, a preview otherwise. */
  rows: MyTask[];
  /** 1-based. */
  page: number;
  pageSize: number;
  /** True when this bucket holds records beyond the rows above. */
  hasMore: boolean;
};

export type MyWorkView = {
  /** The employee record linked to this user, if any — tasks hang off it. */
  employeeId: string | null;
  buckets: Record<MyWorkBucketKey, MyWorkBucket>;
  /** The page of work records shown, and the true total behind it. */
  myWork: WorkRow[];
  myWorkTotal: number;
  overdueWork: WorkRow[];
  recentActivity: Array<{ id: string; summary: string; at: string; jobId: string | null }>;
};

function mapMyTask(r: Record<string, unknown>): MyTask {
  return {
    id: r.id as string,
    title: r.title as string,
    status: r.status as string,
    priority: (r.priority as string) ?? "normal",
    dueDate: (r.due_date as string | null) ?? null,
    blockedReason: (r.blocked_reason as string | null) ?? null,
    jobId: r.job_id as string,
    jobReference: r.job_reference as string,
    jobName: r.job_name as string,
    blockers: Number(r.blockers ?? 0),
  };
}

/**
 * THE definition of each My Work bucket, written once.
 *
 * Everything that reports a number about a person's steps builds it from these:
 * the bucket totals, the rows in each bucket, and the dashboard cards that drill
 * into them. Previously the buckets were JS filters over a 300-row page, so past
 * 300 steps a count described a different set than the list it opened. Predicates
 * that live in one place cannot drift apart.
 *
 * They read against a row that already carries `blockers` (see myTasksCte).
 */
/* Predicates read `due_date_raw` — the DATE column — because the row projection
 * also carries a text copy for the client. Both CTEs below expose that name. */
function myWorkBucketSql(key: MyWorkBucketKey, asOf: string, until: string) {
  switch (key) {
    case "overdue":
      // A step waiting on someone else's decision is not the assignee's to chase.
      return sql`due_date_raw is not null and due_date_raw < ${asOf}::date and status <> 'awaiting_approval'`;
    case "today":
      return sql`due_date_raw = ${asOf}::date`;
    case "blocked":
      return sql`(status = 'blocked' or blockers > 0)`;
    case "approvals":
      return sql`status = 'awaiting_approval'`;
    case "next":
      return sql`due_date_raw is not null and due_date_raw > ${asOf}::date and due_date_raw <= ${until}::date`;
  }
}

/** The one row-set My Work reads: this person's open, unarchived steps. */
function myTasksCte(ctx: Ctx, employeeId: string) {
  return sql`
    select t.id::text as id, t.title, t.status, t.priority, t.due_date::text as due_date,
           t.due_date as due_date_raw, t.created_at, t.blocked_reason,
           t.job_id::text as job_id, j.reference as job_reference, j.name as job_name,
           (select count(*)::int from public.task_dependency d
             join public.task up on up.id = d.depends_on_task_id and up.org_id = d.org_id
             where d.org_id = t.org_id and d.task_id = t.id and d.removed_at is null
               and up.status not in ('completed', 'cancelled')) as blockers
    from public.task t
    join public.job j on j.id = t.job_id and j.org_id = t.org_id
    where t.org_id = ${ctx.orgId} and t.assignee_employee_id = ${employeeId}
      and t.archived = false and j.archived = false
      and t.status in ${OPEN_TASK_SQL}
  `;
}

/**
 * One person's execution view. Tasks are reached through the employee record
 * linked to this user (people without a login still hold assignments, so the
 * link is optional by design); work is reached through the same assignment
 * resolver used everywhere else.
 *
 * Bucket totals are exact and counted over every matching row. The rows returned
 * are a bounded page of the focused bucket, or a short preview of each bucket in
 * the combined view — so nothing is ever hidden silently: a bucket showing fewer
 * rows than its total says so, and the rest are one page away.
 */
export async function getMyWork(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: {
    asOf: string;
    horizonDays?: number;
    /** Which bucket is being read in full; omitted means the combined view. */
    focus?: MyWorkBucketKey | null;
    /** 1-based page within the focused bucket. */
    page?: number;
  },
): Promise<MyWorkView> {
  assertCan(archetype, "jobs.view");
  const horizon = Math.min(Math.max(opts.horizonDays ?? 7, 1), 90);
  const focus = opts.focus ?? null;
  const page = Math.min(Math.max(Math.trunc(opts.page ?? 1), 1), 10_000);
  return withCtx(ctx, async (tx) => {
    const emp = (await tx.execute(sql`
      select id::text as id from public.employee
      where org_id = ${ctx.orgId} and user_id = ${ctx.userId} and active = true
    `)) as unknown as Array<{ id: string }>;
    const employeeId = emp[0]?.id ?? null;

    const horizonEnd = (await tx.execute(sql`
      select (${opts.asOf}::date + ${horizon}::int)::text as d
    `)) as unknown as Array<{ d: string }>;
    const until = horizonEnd[0]!.d;

    const empty = (key: MyWorkBucketKey): MyWorkBucket => ({
      key,
      total: 0,
      rows: [],
      page: 1,
      pageSize: MY_WORK_PAGE_SIZE,
      hasMore: false,
    });
    const buckets = Object.fromEntries(MY_WORK_BUCKETS.map((k) => [k, empty(k)])) as Record<
      MyWorkBucketKey,
      MyWorkBucket
    >;

    if (employeeId) {
      // Exact totals for every bucket, over every matching row — one query.
      const [totals] = (await tx.execute(sql`
        with my_tasks as (${myTasksCte(ctx, employeeId)})
        select
          count(*) filter (where ${myWorkBucketSql("overdue", opts.asOf, until)})::int as overdue,
          count(*) filter (where ${myWorkBucketSql("today", opts.asOf, until)})::int as today,
          count(*) filter (where ${myWorkBucketSql("blocked", opts.asOf, until)})::int as blocked,
          count(*) filter (where ${myWorkBucketSql("approvals", opts.asOf, until)})::int as approvals,
          count(*) filter (where ${myWorkBucketSql("next", opts.asOf, until)})::int as next
        from my_tasks
      `)) as unknown as Array<Record<MyWorkBucketKey, number>>;
      for (const k of MY_WORK_BUCKETS) buckets[k].total = Number(totals?.[k] ?? 0);

      // Rows: the focused bucket in pages, or a short preview of each bucket.
      // The ordering ends in id so a page boundary is deterministic.
      const wanted: MyWorkBucketKey[] = focus ? [focus] : [...MY_WORK_BUCKETS];
      const limit = focus ? MY_WORK_PAGE_SIZE : MY_WORK_PREVIEW;
      const offset = focus ? (page - 1) * MY_WORK_PAGE_SIZE : 0;
      for (const key of wanted) {
        if (buckets[key].total === 0) continue;
        const rows = (await tx.execute(sql`
          with my_tasks as (${myTasksCte(ctx, employeeId)})
          select * from my_tasks
          where ${myWorkBucketSql(key, opts.asOf, until)}
          order by due_date_raw nulls last, created_at, id
          limit ${limit} offset ${offset}
        `)) as unknown as Array<Record<string, unknown>>;
        buckets[key] = {
          key,
          total: buckets[key].total,
          rows: rows.map(mapMyTask),
          page: focus === key ? page : 1,
          pageSize: limit,
          hasMore: offset + rows.length < buckets[key].total,
        };
      }
    }

    const myWork = await listWork(ctx, archetype, { scope: "mine", limit: MY_WORK_PAGE_SIZE });
    // The true number of work records assigned to this person, so the page can
    // say "showing 50 of N" instead of quietly stopping at the page size.
    const [workTotal] = (await tx.execute(sql`
      select count(*)::int as n from public.job j
      where j.org_id = ${ctx.orgId} and j.archived = false
        and ${assignedJobCondition(ctx)}
    `)) as unknown as Array<{ n: number }>;
    const myWorkTotal = Number(workTotal?.n ?? 0);
    const overdueWork = myWork.filter(
      (w) =>
        w.dueDate !== null &&
        w.dueDate < opts.asOf &&
        ["draft", "active", "on_hold"].includes(w.statusCategory),
    );

    const activity = (await tx.execute(sql`
      select a.id::text as id, a.summary, a.created_at::text as at,
             case when a.entity_type = 'job' then a.entity_id::text else null end as job_id
      from public.activity a
      where a.org_id = ${ctx.orgId} and a.actor_user_id = ${ctx.userId}
      order by a.created_at desc
      limit 10
    `)) as unknown as Array<{ id: string; summary: string; at: string; job_id: string | null }>;

    return {
      employeeId,
      buckets,
      myWork,
      myWorkTotal,
      overdueWork,
      recentActivity: activity.map((a) => ({
        id: a.id,
        summary: a.summary,
        at: a.at,
        jobId: a.job_id,
      })),
    };
  });
}

// ── Schedule (Part H) ───────────────────────────────────────────────────────
export type ScheduleItem = {
  kind: "work" | "task";
  id: string;
  title: string;
  reference: string | null;
  jobId: string;
  jobReference: string;
  startDate: string | null;
  /** Date-only deadline. This product has no exact-time events yet. */
  dueDate: string | null;
  status: string;
  priority: string;
  assigneeName: string | null;
  overdue: boolean;
};

export type ScheduleView = {
  items: ScheduleItem[];
  /** Records with no dates at all — visible, never silently dropped. */
  unscheduled: ScheduleItem[];
};

/**
 * Work and tasks that carry dates inside a window, plus everything that has no
 * date at all. Dates here are calendar dates in the organization's own
 * timezone: deadlines, not timestamps.
 */
export async function getSchedule(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: {
    from: string;
    to: string;
    asOf: string;
    scope?: "mine";
    assigneeEmployeeId?: string;
    jobId?: string;
  },
): Promise<ScheduleView> {
  assertCan(archetype, "week.view");
  const assignedOnly = archetype === "foreman" || opts.scope === "mine";
  return withCtx(ctx, async (tx) => {
    const workRows = (await tx.execute(sql`
      select j.id::text as id, j.reference, j.name, j.start_date::text as start_date,
             j.due_date::text as due_date, j.status_category, j.priority,
             u.full_name as owner_name
      from public.job j
      left join public.user_profile u on u.id = j.owner_user_id
      where j.org_id = ${ctx.orgId} and j.archived = false
        and j.status_category in ('draft', 'active', 'on_hold')
        and (${opts.jobId ?? null}::uuid is null or j.id = ${opts.jobId ?? null}::uuid)
        and (${!assignedOnly} or ${assignedJobCondition(ctx)})
        and (
          (j.due_date is not null and j.due_date between ${opts.from}::date and ${opts.to}::date)
          or (j.start_date is not null and j.start_date between ${opts.from}::date and ${opts.to}::date)
          or (j.start_date is null and j.due_date is null)
        )
      order by j.due_date nulls last, j.reference
      limit 300
    `)) as unknown as Array<Record<string, unknown>>;

    const taskRows = (await tx.execute(sql`
      select t.id::text as id, t.title, t.start_date::text as start_date,
             t.due_date::text as due_date, t.status, t.priority,
             t.job_id::text as job_id, j.reference as job_reference,
             e.name as assignee_name
      from public.task t
      join public.job j on j.id = t.job_id and j.org_id = t.org_id
      left join public.employee e on e.id = t.assignee_employee_id
      where t.org_id = ${ctx.orgId} and t.archived = false and j.archived = false
        and t.status in ${OPEN_TASK_SQL}
        and (${opts.jobId ?? null}::uuid is null or t.job_id = ${opts.jobId ?? null}::uuid)
        and (${opts.assigneeEmployeeId ?? null}::uuid is null
             or t.assignee_employee_id = ${opts.assigneeEmployeeId ?? null}::uuid)
        and (${!assignedOnly} or ${assignedJobCondition(ctx)})
        and (
          (t.due_date is not null and t.due_date between ${opts.from}::date and ${opts.to}::date)
          or (t.start_date is not null and t.start_date between ${opts.from}::date and ${opts.to}::date)
          or (t.start_date is null and t.due_date is null)
        )
      order by t.due_date nulls last, t.created_at
      limit 500
    `)) as unknown as Array<Record<string, unknown>>;

    const items: ScheduleItem[] = [];
    const unscheduled: ScheduleItem[] = [];
    for (const r of workRows) {
      const due = (r.due_date as string | null) ?? null;
      const item: ScheduleItem = {
        kind: "work",
        id: r.id as string,
        title: r.name as string,
        reference: r.reference as string,
        jobId: r.id as string,
        jobReference: r.reference as string,
        startDate: (r.start_date as string | null) ?? null,
        dueDate: due,
        status: r.status_category as string,
        priority: (r.priority as string) ?? "normal",
        assigneeName: (r.owner_name as string | null) ?? null,
        overdue: due !== null && due < opts.asOf,
      };
      (item.startDate === null && item.dueDate === null ? unscheduled : items).push(item);
    }
    for (const r of taskRows) {
      const due = (r.due_date as string | null) ?? null;
      const item: ScheduleItem = {
        kind: "task",
        id: r.id as string,
        title: r.title as string,
        reference: null,
        jobId: r.job_id as string,
        jobReference: r.job_reference as string,
        startDate: (r.start_date as string | null) ?? null,
        dueDate: due,
        status: r.status as string,
        priority: (r.priority as string) ?? "normal",
        assigneeName: (r.assignee_name as string | null) ?? null,
        overdue: due !== null && due < opts.asOf,
      };
      (item.startDate === null && item.dueDate === null ? unscheduled : items).push(item);
    }
    items.sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
    return { items, unscheduled };
  });
}

// ── Workload (Part G) ───────────────────────────────────────────────────────
export type WorkloadRow = {
  employeeId: string;
  name: string;
  openTasks: number;
  overdueTasks: number;
  estimatedMinutes: number | null;
  assignedWork: number;
};

/**
 * Scheduled load per person. This is a COUNT of assigned work, not a capacity
 * judgement: the product does not know anyone's working hours, so it never says
 * "over capacity" — only what is currently on their list.
 */
export async function getWorkload(
  ctx: Ctx,
  archetype: RoleArchetype,
  asOf: string,
): Promise<WorkloadRow[]> {
  assertCan(archetype, "employees.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select e.id::text as employee_id, e.name,
             count(t.id) filter (where t.id is not null)::int as open_tasks,
             count(t.id) filter (where t.due_date is not null and t.due_date < ${asOf}::date)::int
               as overdue_tasks,
             sum(t.estimated_minutes)::int as estimated_minutes,
             (select count(distinct jc.job_id)::int from public.job_crew jc
               join public.job j2 on j2.id = jc.job_id and j2.org_id = jc.org_id
               where jc.org_id = e.org_id and jc.employee_id = e.id and jc.removed_at is null
                 and j2.archived = false
                 and j2.status_category in ('draft', 'active', 'on_hold')) as assigned_work
      from public.employee e
      left join public.task t
        on t.assignee_employee_id = e.id and t.org_id = e.org_id
       and t.archived = false and t.status in ${OPEN_TASK_SQL}
      where e.org_id = ${ctx.orgId} and e.active = true
      group by e.id, e.name, e.org_id
      order by open_tasks desc, e.name
      limit 200
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    employeeId: r.employee_id as string,
    name: r.name as string,
    openTasks: Number(r.open_tasks ?? 0),
    overdueTasks: Number(r.overdue_tasks ?? 0),
    estimatedMinutes: r.estimated_minutes === null ? null : Number(r.estimated_minutes),
    assignedWork: Number(r.assigned_work ?? 0),
  }));
}

// ── Dashboard aggregates (Part M) ───────────────────────────────────────────
export type WorkDashboardCounts = {
  activeWork: number;
  overdueWork: number;
  workDueSoon: number;
  overdueTasks: number;
  blockedTasks: number;
  unassignedUrgentWork: number;
};

/** Every dashboard number in ONE bounded query. */
export async function workDashboardCounts(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { asOf: string; horizonDays: number },
): Promise<WorkDashboardCounts> {
  assertCan(archetype, "jobs.view");
  const assignedOnly = archetype === "foreman";
  // The two STEP counts drill into My Work, which shows only the viewer's own
  // assigned steps, so they are counted the same way: same employee resolution,
  // same bucket predicates. Counted org-wide they were a number whose records
  // the link could not reach - an admin saw "7 steps are blocked" and landed on
  // an empty page. The WORK counts stay org-wide because their link, the work
  // hub, is org-wide too (a foreman is narrowed on both sides).
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      with scoped as (
        select j.id, j.due_date, j.status_category, j.priority, j.owner_user_id
        from public.job j
        where j.org_id = ${ctx.orgId} and j.archived = false
          and (${!assignedOnly} or ${assignedJobCondition(ctx)})
      ),
      me as (
        select id from public.employee
        where org_id = ${ctx.orgId} and user_id = ${ctx.userId} and active = true
      ),
      my_tasks as (
        select t.id, t.status, t.due_date as due_date_raw,
               (select count(*)::int from public.task_dependency d
                 join public.task up on up.id = d.depends_on_task_id and up.org_id = d.org_id
                 where d.org_id = t.org_id and d.task_id = t.id and d.removed_at is null
                   and up.status not in ('completed', 'cancelled')) as blockers
        from public.task t
        join public.job j on j.id = t.job_id and j.org_id = t.org_id
        where t.org_id = ${ctx.orgId}
          and t.assignee_employee_id in (select id from me)
          and t.archived = false and j.archived = false
          and t.status in ${OPEN_TASK_SQL}
      )
      -- The two step counts below use myWorkBucketSql, the SAME predicates My
      -- Work builds its buckets from, so a card and the page it opens can never
      -- describe different sets.
      select
        (select count(*)::int from scoped where status_category = 'active') as active_work,
        (select count(*)::int from scoped
          where status_category in ('draft', 'active', 'on_hold')
            and due_date is not null and due_date < ${opts.asOf}::date) as overdue_work,
        (select count(*)::int from scoped
          where status_category in ('draft', 'active', 'on_hold')
            and due_date is not null and due_date >= ${opts.asOf}::date
            and due_date <= (${opts.asOf}::date + ${opts.horizonDays}::int)) as work_due_soon,
        (select count(*)::int from scoped
          where status_category in ('draft', 'active') and priority in ('high', 'urgent')
            and owner_user_id is null) as unassigned_urgent,
        (select count(*)::int from my_tasks
          where ${myWorkBucketSql("overdue", opts.asOf, opts.asOf)}) as overdue_tasks,
        (select count(*)::int from my_tasks
          where ${myWorkBucketSql("blocked", opts.asOf, opts.asOf)}) as blocked_tasks
    `),
  )) as unknown as Array<Record<string, string | number>>;
  const r = rows[0]!;
  return {
    activeWork: Number(r.active_work),
    overdueWork: Number(r.overdue_work),
    workDueSoon: Number(r.work_due_soon),
    overdueTasks: Number(r.overdue_tasks),
    blockedTasks: Number(r.blocked_tasks),
    unassignedUrgentWork: Number(r.unassigned_urgent),
  };
}

/** Customer 360's work summary (Part M) — bounded, permission-checked. */
export async function customerWork(
  ctx: Ctx,
  archetype: RoleArchetype,
  customerId: string,
  asOf: string,
): Promise<{ rows: WorkRow[]; activeCount: number; completedCount: number; overdueCount: number }> {
  assertCan(archetype, "jobs.view");
  const rows = await listWork(ctx, archetype, { customerId, limit: 25 });
  // The counts are the customer's TOTALS, so they are aggregated over every
  // matching row rather than over the 25 shown. Deriving them from the page made
  // the header understate any customer with more work than fits on it, while the
  // adjacent "view all" link opened a longer list than the summary claimed.
  // Same org scope and same foreman narrowing as the list above.
  const assignedOnly = archetype === "foreman";
  const [totals] = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select
        count(*) filter (where j.status_category in ('draft', 'active', 'on_hold'))::int as active,
        count(*) filter (where j.status_category = 'done')::int as completed,
        count(*) filter (where j.status_category in ('draft', 'active', 'on_hold')
                           and j.due_date is not null
                           and j.due_date < ${asOf}::date)::int as overdue
      from public.job j
      where j.org_id = ${ctx.orgId}
        and j.archived = false
        and j.customer_id = ${customerId}::uuid
        and (${!assignedOnly} or ${assignedJobCondition(ctx)})
    `),
  )) as unknown as Array<{ active: number; completed: number; overdue: number }>;
  return {
    rows,
    activeCount: Number(totals?.active ?? 0),
    completedCount: Number(totals?.completed ?? 0),
    overdueCount: Number(totals?.overdue ?? 0),
  };
}

/** True when this archetype may see money on work surfaces. */
export function seesWorkMoney(ctx: Ctx, archetype: RoleArchetype): boolean {
  return ctx.pricePrivileged && can(archetype, "jobs.price.manage");
}
