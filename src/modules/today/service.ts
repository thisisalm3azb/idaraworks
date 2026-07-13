/**
 * The Today composer (doc 03 D-3.1; doc 11 S5). ONE server-side composition point
 * per role that assembles a role's cards (queries + open exceptions from the S5
 * engine) into a single typed payload. It is the single place for tenancy, per-role
 * cost REDACTION (doc 06 / F-23), and freshness stamping (D-3.2). S5 ships the
 * FOREMAN and MANAGER compositions (owner/admin see the manager composition;
 * owner/accounts/procurement SPECIALISED Today screens are S6).
 *
 * No money on either screen (doc 03): the foreman screen is "for doing, not
 * monitoring"; the manager cards are operational (plan / blockers / reviews /
 * decisions / missing) and carry NO amounts. Every card carries `computedAt`, and
 * the field-derived cards carry `lastInputAt` per job (D-3.2 — "no report since
 * Tue"). The compose is LIVE (not cached): freshness is always truthful — the 60s
 * server-compose cache (D-3.1) is a deferred perf lever, added only with a proper
 * role/config-revision invalidation story (§8.9), not a bare TTL.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assignedJobCondition } from "@/modules/jobs/service";
import { listOpenExceptions } from "@/modules/exceptions/service";
import { computeAR } from "@/modules/invoices/service";
import type { RoleArchetype } from "@/platform/registries";

export type FreshnessStamp = { computedAt: string; lastInputAt?: string | null };
export type TodayCard = {
  key: string;
  count: number;
  items: Array<Record<string, unknown>>;
  freshness: FreshnessStamp;
};
export type TodayScreen = "foreman" | "manager" | "owner" | "accounts" | "procurement";
export type TodayPayload = {
  screen: TodayScreen;
  computedAt: string;
  cards: TodayCard[];
};

export async function composeToday(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { asOf: string; computedAt: string },
): Promise<TodayPayload> {
  const screen: TodayScreen =
    archetype === "foreman"
      ? "foreman"
      : archetype === "accounts"
        ? "accounts"
        : archetype === "procurement"
          ? "procurement"
          : archetype === "owner" || archetype === "admin"
            ? "owner"
            : "manager";
  const cards =
    screen === "foreman"
      ? await foremanCards(ctx, opts)
      : screen === "accounts"
        ? await accountsCards(ctx, archetype, opts)
        : screen === "procurement"
          ? await procurementCards(ctx, opts)
          : screen === "owner"
            ? await ownerCards(ctx, archetype, opts)
            : await managerCards(ctx, archetype, opts);
  return { screen, computedAt: opts.computedAt, cards };
}

async function foremanCards(
  ctx: Ctx,
  opts: { asOf: string; computedAt: string },
): Promise<TodayCard[]> {
  return withCtx(ctx, async (tx) => {
    // My jobs today: assigned active jobs (F-6 resolver), with last-report freshness.
    const myJobs = (await tx.execute(sql`
      select j.id::text as id, j.reference, j.name,
             (select max(r.report_date)::text from public.daily_report r
              where r.job_id = j.id and r.org_id = ${ctx.orgId}
                and r.status in ('submitted','reviewed')) as last_report
      from public.job j
      where j.org_id = ${ctx.orgId} and j.status_category = 'active' and j.archived = false
        and ${assignedJobCondition(ctx)}
      order by j.reference
    `)) as unknown as Array<{
      id: string;
      reference: string;
      name: string;
      last_report: string | null;
    }>;

    // Submit daily report: which of my jobs have no report for today.
    const submitNeeded = myJobs.filter((j) => (j.last_report ?? "") < opts.asOf);

    // Waiting on me: reports of mine that were RETURNED for correction.
    const returned = (await tx.execute(sql`
      select r.id::text as id, r.report_date::text as report_date, j.reference
      from public.daily_report r
      join public.job j on j.id = r.job_id
      where r.org_id = ${ctx.orgId} and r.submitted_by = ${ctx.userId} and r.status = 'returned'
      order by r.report_date desc limit 50
    `)) as unknown as Array<{ id: string; report_date: string; reference: string }>;

    const fr = (lastInputAt?: string | null): FreshnessStamp => ({
      computedAt: opts.computedAt,
      lastInputAt: lastInputAt ?? null,
    });
    return [
      {
        key: "my_jobs_today",
        count: myJobs.length,
        items: myJobs.map((j) => ({
          id: j.id,
          reference: j.reference,
          name: j.name,
          lastReport: j.last_report,
        })),
        freshness: fr(myJobs[0]?.last_report ?? null),
      },
      {
        key: "submit_daily_report",
        count: submitNeeded.length,
        items: submitNeeded.map((j) => ({ id: j.id, reference: j.reference, name: j.name })),
        freshness: fr(),
      },
      {
        key: "waiting_on_me",
        count: returned.length,
        items: returned.map((r) => ({
          id: r.id,
          reference: r.reference,
          reportDate: r.report_date,
        })),
        freshness: fr(),
      },
    ];
  });
}

async function managerCards(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { asOf: string; computedAt: string },
): Promise<TodayCard[]> {
  // Open exceptions this role may see (audience-scoped), grouped into cards.
  const exceptions = await listOpenExceptions(ctx, archetype, { limit: 200 });
  const byRule = (rule: string) => exceptions.filter((e) => e.ruleKey === rule);

  const fr = (): FreshnessStamp => ({ computedAt: opts.computedAt });

  const dbCards = await withCtx(ctx, async (tx) => {
    // Reports to review: submitted reports on jobs I manage (F-6 scope for manager;
    // owner/admin see all). Anomaly chips come from the labour_outlier exceptions.
    const scope = archetype === "manager" ? sql`and ${assignedJobCondition(ctx)}` : sql``;
    const toReview = (await tx.execute(sql`
      select r.id::text as id, r.report_date::text as report_date, j.reference
      from public.daily_report r
      join public.job j on j.id = r.job_id
      where r.org_id = ${ctx.orgId} and r.status = 'submitted' ${scope}
      order by r.report_date desc limit 50
    `)) as unknown as Array<{ id: string; report_date: string; reference: string }>;

    // Missing today: active jobs (scoped) with no submitted/reviewed report for asOf
    // (the C-7 intra-day PLAIN QUERY — not an exception; nightly E-01 owns that).
    const missing = (await tx.execute(sql`
      select j.id::text as id, j.reference, j.name,
             (select max(r.report_date)::text from public.daily_report r
              where r.job_id = j.id and r.org_id = ${ctx.orgId}
                and r.status in ('submitted','reviewed')) as last_report
      from public.job j
      where j.org_id = ${ctx.orgId} and j.status_category = 'active' and j.archived = false ${scope}
      order by j.reference
    `)) as unknown as Array<{
      id: string;
      reference: string;
      name: string;
      last_report: string | null;
    }>;
    const missingToday = missing.filter((j) => (j.last_report ?? "") < opts.asOf);
    return { toReview, missingToday };
  });

  const anomalyReports = new Set(
    byRule("labour_outlier")
      .map((e) => e.subjectId)
      .filter((x): x is string => !!x),
  );

  return [
    {
      key: "missing_reports",
      count: byRule("missing_report").length,
      items: byRule("missing_report").map((e) => ({
        id: e.id,
        jobId: e.jobId,
        severity: e.severity,
        evidence: e.evidenceRefs,
      })),
      freshness: fr(),
    },
    {
      key: "overdue",
      count: byRule("overdue_stage").length,
      items: byRule("overdue_stage").map((e) => ({
        id: e.id,
        jobId: e.jobId,
        severity: e.severity,
        evidence: e.evidenceRefs,
      })),
      freshness: fr(),
    },
    {
      key: "blockers",
      count: byRule("blocking_issue").length,
      items: byRule("blocking_issue").map((e) => ({
        id: e.id,
        jobId: e.jobId,
        subjectId: e.subjectId,
        severity: e.severity,
      })),
      freshness: fr(),
    },
    {
      key: "reports_to_review",
      count: dbCards.toReview.length,
      items: dbCards.toReview.map((r) => ({
        id: r.id,
        reference: r.reference,
        reportDate: r.report_date,
        anomaly: anomalyReports.has(r.id),
      })),
      freshness: fr(),
    },
    {
      key: "missing_today",
      count: dbCards.missingToday.length,
      items: dbCards.missingToday.map((j) => ({
        id: j.id,
        reference: j.reference,
        name: j.name,
        lastReport: j.last_report,
      })),
      freshness: fr(),
    },
  ];
}

// ── S6 "Bill" screens: Accounts, Owner, Procurement (doc 03) ─────────────────
function fr(computedAt: string): FreshnessStamp {
  return { computedAt };
}

async function accountsCards(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { asOf: string; computedAt: string },
): Promise<TodayCard[]> {
  const exceptions = await listOpenExceptions(ctx, archetype, { limit: 200 });
  const byRule = (rule: string) => exceptions.filter((e) => e.ruleKey === rule);
  // computeAR already redacts money (null) when !pricePrivileged; mirror that for the
  // raw payments-sum below so no money reaches a non-price-privileged viewer's payload.
  const seesPrice = ctx.pricePrivileged;
  const ar = await computeAR(ctx, archetype, opts.asOf);
  const db = await withCtx(ctx, async (tx) => {
    const payments = (await tx.execute(sql`
      select count(*)::int as n, coalesce(sum(base_amount_minor),0)::bigint as total
      from public.payment where org_id = ${ctx.orgId} and status in ('recorded','confirmed')
        and payment_date >= (${opts.asOf}::date - 7)
    `)) as unknown as Array<{ n: number; total: string }>;
    const expenses = (await tx.execute(sql`
      select count(*)::int as n from public.expense
      where org_id = ${ctx.orgId} and voided_at is null and payment_status = 'unpaid'
    `)) as unknown as Array<{ n: number }>;
    return { payments: payments[0]!, expenses: expenses[0]! };
  });
  return [
    {
      key: "invoices_to_issue",
      count: byRule("billing_point_uninvoiced").length,
      items: byRule("billing_point_uninvoiced").map((e) => ({
        id: e.id,
        jobId: e.jobId,
        severity: e.severity,
      })),
      freshness: fr(opts.computedAt),
    },
    {
      key: "overdue_receivables",
      count: byRule("overdue_invoice").length,
      items: byRule("overdue_invoice").map((e) => ({
        id: e.id,
        subjectId: e.subjectId,
        severity: e.severity,
        evidence: e.evidenceRefs,
      })),
      freshness: fr(opts.computedAt),
    },
    {
      key: "ar_summary",
      count: ar.outstandingMinor ?? 0,
      items: [
        {
          outstandingMinor: ar.outstandingMinor,
          current: ar.current,
          d1_30: ar.d1_30,
          d31_60: ar.d31_60,
          d61_90: ar.d61_90,
          over90: ar.over90,
        },
      ],
      freshness: fr(opts.computedAt),
    },
    {
      key: "payments_week",
      count: db.payments.n,
      items: [{ amountMinor: seesPrice ? Number(db.payments.total) : null }],
      freshness: fr(opts.computedAt),
    },
    {
      key: "expenses_queue",
      count: db.expenses.n,
      items: [],
      freshness: fr(opts.computedAt),
    },
  ];
}

async function ownerCards(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { asOf: string; computedAt: string },
): Promise<TodayCard[]> {
  const exceptions = await listOpenExceptions(ctx, archetype, { limit: 200 });
  const atRisk = exceptions.filter((e) =>
    ["overdue_stage", "missing_report", "overdue_invoice", "billing_point_uninvoiced"].includes(
      e.ruleKey,
    ),
  );
  const ar = await computeAR(ctx, archetype, opts.asOf);
  const db = await withCtx(ctx, async (tx) => {
    const pending = (await tx.execute(sql`
      select count(*)::int as n from public.approval
      where org_id = ${ctx.orgId} and state = 'pending'
    `)) as unknown as Array<{ n: number }>;
    return { pending: pending[0]! };
  });
  return [
    {
      key: "needs_decision",
      count: db.pending.n,
      items: [],
      freshness: fr(opts.computedAt),
    },
    {
      key: "at_risk",
      count: atRisk.length,
      items: atRisk
        .slice(0, 10)
        .map((e) => ({ id: e.id, ruleKey: e.ruleKey, jobId: e.jobId, severity: e.severity })),
      freshness: fr(opts.computedAt),
    },
    {
      key: "collections",
      count: ar.outstandingMinor ?? 0,
      items: [{ outstandingMinor: ar.outstandingMinor, over90: ar.over90 }],
      freshness: fr(opts.computedAt),
    },
  ];
}

async function procurementCards(
  ctx: Ctx,
  opts: { asOf: string; computedAt: string },
): Promise<TodayCard[]> {
  return withCtx(ctx, async (tx) => {
    const approvedMrs = (await tx.execute(sql`
      select count(*)::int as n from public.material_request
      where org_id = ${ctx.orgId} and status = 'approved'
    `)) as unknown as Array<{ n: number }>;
    const openPos = (await tx.execute(sql`
      select count(*)::int as n from public.purchase_order
      where org_id = ${ctx.orgId} and status in ('approved','sent','partially_received')
    `)) as unknown as Array<{ n: number }>;
    return [
      { key: "approved_mrs", count: approvedMrs[0]!.n, items: [], freshness: fr(opts.computedAt) },
      { key: "open_pos", count: openPos[0]!.n, items: [], freshness: fr(opts.computedAt) },
    ];
  });
}
