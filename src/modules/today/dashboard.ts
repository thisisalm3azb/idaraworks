/**
 * U5 dashboard extras — the small READ-ONLY aggregates the redesigned Today
 * screens need beyond composeToday's attention cards (which stay the source
 * for queues/lists). Same composition-point law as composeToday (doc 03
 * D-3.1): ONE server-side place per role for tenancy, per-role cost/price
 * REDACTION (F-23) and scope (F-6 — manager/foreman see assigned jobs only).
 *
 * Every block is gated by the SAME can() actions that gate its page — a
 * number never reaches a role that could not open the page behind it — and
 * money figures additionally require ctx.pricePrivileged (computeAR already
 * redacts internally; the payments trend redacts here). The foreman branch
 * never selects a money column at all.
 */
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { can } from "@/platform/authz";
import { assignedJobCondition } from "@/modules/jobs/service";
import type { RoleArchetype } from "@/platform/registries";

export type StageSlice = { key: string; name: { en: string; ar: string } | null; count: number };
export type TrendPointData = { date: string; value: number };
export type TrendSeriesData = { unit: "count" | "money"; points: TrendPointData[] };
export type DeadlineRow = {
  id: string;
  reference: string;
  name: string;
  dueDate: string;
  overdue: boolean;
};
export type OrgActivityRow = {
  id: string;
  summary: string;
  createdAt: string;
  actorName: string | null;
};

export type DashboardExtras = {
  computedAt: string;
  /** jobs.view — manager/foreman scoped to assigned jobs (F-6). */
  jobs: { active: number; doneThisWeek: number; overdue: number } | null;
  /** jobs.view, management screens: active jobs per current stage. */
  stageDist: StageSlice[] | null;
  /** reports.review (org) or reports.create (own): submitted per day, 14d. */
  reportTrend: TrendSeriesData | null;
  reportsThisWeek: number;
  reportsPrevWeek: number;
  /** week.view: nearest due dates (next 14 days + anything overdue). */
  deadlines: DeadlineRow[] | null;
  /** Recent operational narrative; foreman sees assigned-job rows only. */
  activity: OrgActivityRow[];
  /** approvals.decide */
  approvalsPending: number | null;
  /** issues.raise — open issues (foreman: on assigned jobs). */
  openIssues: number | null;
  /** payments.view + pricePrivileged → money/day; else count/day. 30d. */
  paymentsTrend: TrendSeriesData | null;
  paymentsWeekMinor: number | null;
  /** quotes.view: quotes awaiting action (draft/pending approval). */
  quotesAwaiting: number | null;
  /** expenses.view: unpaid, non-void expenses. */
  unpaidExpenses: number | null;
  /** po.view: open purchase orders by state. */
  poStatus: { approved: number; sent: number; partial: number } | null;
  /** po.view: material requests in flight. */
  mrOpen: { submitted: number; approved: number } | null;
  /** billing.view: active seats for the subscription/usage strip (U5 owner). */
  seats: { office: number; viewer: number } | null;
};

/** Fill a per-day count map into a dense series over the last `days` days. */
function denseDays(byDate: Map<string, number>, asOf: string, days: number): TrendPointData[] {
  const out: TrendPointData[] = [];
  const end = new Date(`${asOf}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ date: d, value: byDate.get(d) ?? 0 });
  }
  return out;
}

export async function getDashboardExtras(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { asOf: string; computedAt: string },
): Promise<DashboardExtras> {
  const foreman = archetype === "foreman";
  // Manager + foreman operate on their assigned scope (mirrors composeToday).
  const scoped = archetype === "manager" || foreman;

  return withCtx(ctx, async (tx) => {
    const scope = () => (scoped ? sql`and ${assignedJobCondition(ctx)}` : sql``);

    const jobs = can(archetype, "jobs.view") ? await jobCounts(tx, ctx, opts.asOf, scoped) : null;
    const stageDist =
      can(archetype, "jobs.view") && !foreman ? await stageDistribution(tx, ctx, scoped) : null;

    // Reports trend: reviewers see the org (their scope); the foreman sees own.
    let reportTrend: TrendSeriesData | null = null;
    let reportsThisWeek = 0;
    let reportsPrevWeek = 0;
    if (can(archetype, "reports.review") || can(archetype, "reports.create")) {
      const own = !can(archetype, "reports.review");
      const rows = (await tx.execute(sql`
        select r.report_date::text as d, count(*)::int as n
        from public.daily_report r
        join public.job j on j.id = r.job_id
        where r.org_id = ${ctx.orgId} and r.status in ('submitted','reviewed')
          and r.report_date >= (${opts.asOf}::date - 13)
          ${own ? sql`and r.submitted_by = ${ctx.userId}` : scope()}
        group by 1
      `)) as unknown as Array<{ d: string; n: number }>;
      const byDate = new Map(rows.map((r) => [r.d, Number(r.n)]));
      const points = denseDays(byDate, opts.asOf, 14);
      reportTrend = { unit: "count", points };
      reportsThisWeek = points.slice(7).reduce((s, p) => s + p.value, 0);
      reportsPrevWeek = points.slice(0, 7).reduce((s, p) => s + p.value, 0);
    }

    const deadlines = can(archetype, "week.view")
      ? await nearestDeadlines(tx, ctx, opts.asOf, scoped)
      : null;

    const activity = await recentActivity(tx, ctx, foreman);

    let approvalsPending: number | null = null;
    if (can(archetype, "approvals.decide")) {
      const rows = (await tx.execute(sql`
        select count(*)::int as n from public.approval
        where org_id = ${ctx.orgId} and state = 'pending'
      `)) as unknown as Array<{ n: number }>;
      approvalsPending = Number(rows[0]?.n ?? 0);
    }

    let openIssues: number | null = null;
    if (can(archetype, "issues.raise")) {
      const rows = (await tx.execute(sql`
        select count(*)::int as n from public.issue i
        where i.org_id = ${ctx.orgId} and i.status not in ('resolved','closed')
          ${
            foreman
              ? sql`and i.job_id in (select j.id from public.job j
                    where j.org_id = ${ctx.orgId} and ${assignedJobCondition(ctx)})`
              : sql``
          }
      `)) as unknown as Array<{ n: number }>;
      openIssues = Number(rows[0]?.n ?? 0);
    }

    // ── Money blocks (never for the foreman — no money action passes can()) ──
    let paymentsTrend: TrendSeriesData | null = null;
    let paymentsWeekMinor: number | null = null;
    if (can(archetype, "payments.view")) {
      const money = ctx.pricePrivileged;
      const rows = (await tx.execute(sql`
        select payment_date::text as d, count(*)::int as n,
               coalesce(sum(base_amount_minor),0)::bigint as total
        from public.payment
        where org_id = ${ctx.orgId} and status in ('recorded','confirmed')
          and payment_date >= (${opts.asOf}::date - 29)
        group by 1
      `)) as unknown as Array<{ d: string; n: number; total: string }>;
      const byDate = new Map(
        rows.map((r) => [r.d, money ? Number(r.total) : Number(r.n)] as const),
      );
      paymentsTrend = { unit: money ? "money" : "count", points: denseDays(byDate, opts.asOf, 30) };
      if (money) {
        paymentsWeekMinor = paymentsTrend.points.slice(-7).reduce((s, p) => s + p.value, 0);
      }
    }

    let quotesAwaiting: number | null = null;
    if (can(archetype, "quotes.view")) {
      const rows = (await tx.execute(sql`
        select count(*)::int as n from public.quote
        where org_id = ${ctx.orgId} and status in ('draft','pending_approval')
      `)) as unknown as Array<{ n: number }>;
      quotesAwaiting = Number(rows[0]?.n ?? 0);
    }

    let unpaidExpenses: number | null = null;
    if (can(archetype, "expenses.view")) {
      const rows = (await tx.execute(sql`
        select count(*)::int as n from public.expense
        where org_id = ${ctx.orgId} and voided_at is null and payment_status = 'unpaid'
      `)) as unknown as Array<{ n: number }>;
      unpaidExpenses = Number(rows[0]?.n ?? 0);
    }

    let poStatus: DashboardExtras["poStatus"] = null;
    let mrOpen: DashboardExtras["mrOpen"] = null;
    if (can(archetype, "po.view")) {
      const pos = (await tx.execute(sql`
        select
          count(*) filter (where status = 'approved')::int as approved,
          count(*) filter (where status = 'sent')::int as sent,
          count(*) filter (where status = 'partially_received')::int as partial
        from public.purchase_order where org_id = ${ctx.orgId}
      `)) as unknown as Array<{ approved: number; sent: number; partial: number }>;
      poStatus = {
        approved: Number(pos[0]?.approved ?? 0),
        sent: Number(pos[0]?.sent ?? 0),
        partial: Number(pos[0]?.partial ?? 0),
      };
      const mrs = (await tx.execute(sql`
        select
          count(*) filter (where status = 'submitted')::int as submitted,
          count(*) filter (where status = 'approved')::int as approved
        from public.material_request where org_id = ${ctx.orgId}
      `)) as unknown as Array<{ submitted: number; approved: number }>;
      mrOpen = {
        submitted: Number(mrs[0]?.submitted ?? 0),
        approved: Number(mrs[0]?.approved ?? 0),
      };
    }

    let seats: DashboardExtras["seats"] = null;
    if (can(archetype, "billing.view")) {
      // Seat classes mirror identity.ts / the subscription page (office
      // archetypes are limited; field seats are free by product law).
      const rows = (await tx.execute(sql`
        select
          count(*) filter (where r.archetype in ('owner','admin','manager','procurement','accounts'))::int as office,
          count(*) filter (where r.archetype = 'viewer')::int as viewer
        from public.membership m
        join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
        where m.org_id = ${ctx.orgId} and m.deactivated_at is null
      `)) as unknown as Array<{ office: number; viewer: number }>;
      seats = {
        office: Number(rows[0]?.office ?? 0),
        viewer: Number(rows[0]?.viewer ?? 0),
      };
    }

    return {
      computedAt: opts.computedAt,
      jobs,
      stageDist,
      reportTrend,
      reportsThisWeek,
      reportsPrevWeek,
      deadlines,
      activity,
      approvalsPending,
      openIssues,
      paymentsTrend,
      paymentsWeekMinor,
      quotesAwaiting,
      unpaidExpenses,
      poStatus,
      mrOpen,
      seats,
    };
  });
}

async function jobCounts(
  tx: TenantTx,
  ctx: Ctx,
  asOf: string,
  scoped: boolean,
): Promise<{ active: number; doneThisWeek: number; overdue: number }> {
  const rows = (await tx.execute(sql`
    select
      count(*) filter (where j.status_category = 'active')::int as active,
      count(*) filter (where j.status_category = 'done'
        and j.updated_at >= (${asOf}::date - 6))::int as done_week,
      count(*) filter (where j.status_category in ('active','on_hold')
        and j.due_date is not null and j.due_date < ${asOf}::date)::int as overdue
    from public.job j
    where j.org_id = ${ctx.orgId} and j.archived = false
      ${scoped ? sql`and ${assignedJobCondition(ctx)}` : sql``}
  `)) as unknown as Array<{ active: number; done_week: number; overdue: number }>;
  return {
    active: Number(rows[0]?.active ?? 0),
    doneThisWeek: Number(rows[0]?.done_week ?? 0),
    overdue: Number(rows[0]?.overdue ?? 0),
  };
}

async function stageDistribution(tx: TenantTx, ctx: Ctx, scoped: boolean): Promise<StageSlice[]> {
  const rows = (await tx.execute(sql`
    select coalesce(s.stage_key, '_none') as k, s.name, count(*)::int as n
    from public.job j
    left join public.job_stage s on s.id = j.current_stage_id
    where j.org_id = ${ctx.orgId} and j.archived = false and j.status_category = 'active'
      ${scoped ? sql`and ${assignedJobCondition(ctx)}` : sql``}
    group by 1, 2
    order by count(*) desc
    limit 8
  `)) as unknown as Array<{ k: string; name: { en: string; ar: string } | null; n: number }>;
  return rows.map((r) => ({ key: r.k, name: r.name, count: Number(r.n) }));
}

async function nearestDeadlines(
  tx: TenantTx,
  ctx: Ctx,
  asOf: string,
  scoped: boolean,
): Promise<DeadlineRow[]> {
  const rows = (await tx.execute(sql`
    select j.id::text as id, j.reference, j.name, j.due_date::text as due_date
    from public.job j
    where j.org_id = ${ctx.orgId} and j.archived = false
      and j.status_category in ('active','on_hold')
      and j.due_date is not null and j.due_date <= (${asOf}::date + 14)
      ${scoped ? sql`and ${assignedJobCondition(ctx)}` : sql``}
    order by j.due_date asc
    limit 8
  `)) as unknown as Array<{ id: string; reference: string; name: string; due_date: string }>;
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    name: r.name,
    dueDate: r.due_date,
    overdue: r.due_date < asOf,
  }));
}

async function recentActivity(tx: TenantTx, ctx: Ctx, foreman: boolean): Promise<OrgActivityRow[]> {
  // Activity is tenant-visible narrative (command.ts) — but the foreman's feed
  // is narrowed to assigned-job rows (F-6), matching listJobActivity's law.
  const rows = (await tx.execute(sql`
    select a.id::text as id, a.summary, a.created_at::text as created_at, u.full_name
    from public.activity a
    left join public.user_profile u on u.id = a.actor_user_id
    where a.org_id = ${ctx.orgId}
      ${
        foreman
          ? sql`and a.entity_type = 'job' and a.entity_id in (
                select j.id from public.job j
                where j.org_id = ${ctx.orgId} and ${assignedJobCondition(ctx)})`
          : sql``
      }
    order by a.created_at desc
    limit 10
  `)) as unknown as Array<{
    id: string;
    summary: string;
    created_at: string;
    full_name: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    summary: r.summary,
    createdAt: r.created_at,
    actorName: r.full_name,
  }));
}
