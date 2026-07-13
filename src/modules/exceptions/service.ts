/**
 * The exception engine (doc 04; doc 11 S5 "Measure"). Materialized exception rows
 * with a deterministic raise/clear lifecycle, dedup-by-key upsert (one OPEN row per
 * condition that AGES, never a daily duplicate — D-4.1), and holiday/working-calendar
 * awareness (F-41) so the daily rules don't storm during Eid.
 *
 * The engine is the SOLE writer of public.exception (BUILD_BIBLE §3.7). Raise sources:
 *  - nightly evaluator (E-01 missing report, E-02 overdue, E-04 blocking issue) —
 *    each a raise+clear+self-heal pass over its subjects, calendar-aware;
 *  - the cross-module SIGNAL materializer (E-03 approval stuck from the S4 stub,
 *    F-5 billing-point reopen) consuming exception/raised;
 *  - the report-submit anomaly check (E-07 labour outlier);
 *  - the costing engine's quote/selling-price divergence (C-10).
 * Auto-clear is engine-controlled; a USER dismiss/resolve (owner/admin/manager,
 * audience+scope-limited) runs through the command path (audited). Rows are
 * materialized derivations — engine raise/clear uses withCtx (no audit flood); the
 * row's raised_at/resolved_at IS the record (§4.8). Notifications for act-within-
 * hours rules (E-03/E-04) carry REDACTED bodies (F-23) — never a cost/amount.
 */
import { z } from "zod";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { command } from "@/platform/audit/command";
import { createNotificationIn } from "@/platform/notifications/notify";
import { assertCan } from "@/platform/authz/can";
import type { RoleArchetype, ExceptionSeverity } from "@/platform/registries";
import {
  loadCalendar,
  workingDaysBetween,
  addDays,
  type Calendar,
} from "@/platform/calendar/calendar";

export const RULE_KEYS = [
  "missing_report",
  "overdue_stage",
  "approval_stuck",
  "blocking_issue",
  "labour_outlier",
  "quote_divergence",
  "billing_point_reopened",
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

// Act-within-hours rules push to their audience; the rest surface on Today (pull).
const PUSH_RULES: ReadonlySet<RuleKey> = new Set(["approval_stuck", "blocking_issue"]);

// Wall-clock age (MVP) for the intra-day rules E-03/E-04. Working-hours precision is
// a documented refinement (F-31 herd-hardening slice); E-01/E-02 are the daily rules
// that use the working calendar and would storm during Eid without it.
const BLOCKER_WARN_MS = 4 * 60 * 60 * 1000; // E-04: 4 hours unactioned → warning

export class ExceptionNotFoundError extends Error {
  constructor() {
    super("exception not found");
    this.name = "ExceptionNotFoundError";
  }
}
export class ExceptionScopeError extends Error {
  constructor(msg = "exception outside your audience or job scope") {
    super(msg);
    this.name = "ExceptionScopeError";
  }
}

export type RaiseSpec = {
  ruleKey: RuleKey;
  severity: ExceptionSeverity;
  jobId?: string | null;
  subjectType?: string;
  subjectId?: string;
  evidenceRefs?: unknown[];
  audienceRoles: RoleArchetype[];
  dedupKey: string;
  /** Redacted (no cost/amount) title for the audience notification (E-03/E-04). */
  notifyTitle?: { en: string; ar: string };
};

function textArray(values: readonly string[]) {
  if (values.length === 0) return sql`array[]::text[]`;
  return sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * Raise (or age) an exception, in the caller's transaction. Upserts by the partial
 * unique (org_id, dedup_key) WHERE resolved_at IS NULL — a second raise while one is
 * open AGES the row (updates severity + last_evaluated_at) instead of duplicating.
 * Returns whether a NEW row was created (xmax = 0), so the caller notifies only once.
 */
export async function raiseExceptionIn(
  tx: TenantTx,
  ctx: Ctx,
  spec: RaiseSpec,
): Promise<{ id: string; created: boolean }> {
  const rows = (await tx.execute(sql`
    insert into public.exception
      (org_id, rule_key, severity, job_id, subject_type, subject_id,
       evidence_refs, audience_roles, dedup_key, raised_at, last_evaluated_at)
    values (${ctx.orgId}, ${spec.ruleKey}, ${spec.severity}, ${spec.jobId ?? null},
            ${spec.subjectType ?? null}, ${spec.subjectId ?? null},
            ${JSON.stringify(spec.evidenceRefs ?? [])}::jsonb,
            ${textArray(spec.audienceRoles)}, ${spec.dedupKey}, now(), now())
    on conflict (org_id, dedup_key) where resolved_at is null
    do update set severity = excluded.severity,
                  evidence_refs = excluded.evidence_refs,
                  audience_roles = excluded.audience_roles,
                  last_evaluated_at = now()
    returning id::text as id, (xmax = 0) as created
  `)) as unknown as Array<{ id: string; created: boolean }>;
  const row = rows[0]!;
  if (row.created && spec.notifyTitle && PUSH_RULES.has(spec.ruleKey)) {
    await notifyAudienceIn(tx, ctx, spec, row.id);
  }
  return row;
}

async function notifyAudienceIn(tx: TenantTx, ctx: Ctx, spec: RaiseSpec, exceptionId: string) {
  if (spec.audienceRoles.length === 0 || !spec.notifyTitle) return;
  const members = (await tx.execute(sql`
    select m.user_id::text as user_id
    from public.membership m
    join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
    where m.org_id = ${ctx.orgId} and m.deactivated_at is null
      and r.archetype in (${sql.join(
        spec.audienceRoles.map((a) => sql`${a}`),
        sql`, `,
      )})
  `)) as unknown as Array<{ user_id: string }>;
  for (const mem of members) {
    // Body is intentionally omitted (a redacted title only, F-23 — no cost/amount).
    await createNotificationIn(tx, ctx, {
      recipientUserId: mem.user_id,
      kind: "exception_raised",
      title: spec.notifyTitle.en,
      entityType: "exception",
      entityId: exceptionId,
    });
  }
}

/** Clear the OPEN exception for a dedup_key (engine auto-clear or a report-arrival clear). */
export async function clearExceptionIn(
  tx: TenantTx,
  ctx: Ctx,
  dedupKey: string,
  resolution: "auto" | "actioned" = "auto",
): Promise<void> {
  await tx.execute(sql`
    update public.exception
    set resolved_at = now(), resolution = ${resolution}
    where org_id = ${ctx.orgId} and dedup_key = ${dedupKey} and resolved_at is null
  `);
}

// ── Standalone wrappers (engine callers outside a command tx) ─────────────────
export async function raiseException(ctx: Ctx, spec: RaiseSpec): Promise<{ created: boolean }> {
  return withCtx(ctx, async (tx) => {
    const { created } = await raiseExceptionIn(tx, ctx, spec);
    return { created };
  });
}
export async function clearException(ctx: Ctx, dedupKey: string): Promise<void> {
  await withCtx(ctx, (tx) => clearExceptionIn(tx, ctx, dedupKey));
}

// ── E-03 / billing-point: materialize a cross-module SIGNAL (exception/raised) ─
export async function materializeApprovalStuck(
  ctx: Ctx,
  params: { approvalId: string; severity: ExceptionSeverity },
): Promise<{ created: boolean }> {
  return withCtx(ctx, async (tx) => {
    const appr = (await tx.execute(sql`
      select assigned_role from public.approval where id = ${params.approvalId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<{ assigned_role: string | null }>;
    const role = appr[0]?.assigned_role ?? null;
    const audience: RoleArchetype[] = ["owner", "admin"];
    if (role && role !== "owner" && role !== "admin") audience.push(role as RoleArchetype);
    const { created } = await raiseExceptionIn(tx, ctx, {
      ruleKey: "approval_stuck",
      severity: params.severity,
      subjectType: "approval",
      subjectId: params.approvalId,
      audienceRoles: audience,
      dedupKey: `approval_stuck:${params.approvalId}`,
      notifyTitle: { en: "An approval is waiting", ar: "طلب موافقة بانتظار القرار" },
    });
    return { created };
  });
}

export async function clearApprovalStuck(ctx: Ctx, approvalId: string): Promise<void> {
  await clearException(ctx, `approval_stuck:${approvalId}`);
}

export async function materializeBillingPointReopened(
  ctx: Ctx,
  params: { jobId: string; stageKey: string },
): Promise<{ created: boolean }> {
  return raiseException(ctx, {
    ruleKey: "billing_point_reopened",
    severity: "warning",
    jobId: params.jobId,
    subjectType: "job_stage",
    audienceRoles: ["owner", "admin", "manager"],
    dedupKey: `billing_point_reopened:${params.jobId}:${params.stageKey}`,
  });
}

// ── C-10: quote / selling-price divergence (raised by the costing engine) ─────
export async function raiseQuoteDivergence(
  ctx: Ctx,
  params: { jobId: string; evidence?: unknown[] },
): Promise<{ created: boolean }> {
  return raiseException(ctx, {
    ruleKey: "quote_divergence",
    severity: "warning",
    jobId: params.jobId,
    subjectType: "job",
    subjectId: params.jobId,
    evidenceRefs: params.evidence,
    audienceRoles: ["owner", "admin"],
    dedupKey: `quote_divergence:${params.jobId}`,
  });
}
export async function clearQuoteDivergence(ctx: Ctx, jobId: string): Promise<void> {
  await clearException(ctx, `quote_divergence:${jobId}`);
}

// ── E-07: labour outlier on report submit (event lane) ────────────────────────
export async function evaluateReportAnomalies(
  ctx: Ctx,
  reportId: string,
): Promise<{ raised: number; cleared: number }> {
  return withCtx(ctx, async (tx) => {
    const meta = (await tx.execute(sql`
      select job_id::text as job_id, status
      from public.daily_report where id = ${reportId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<{ job_id: string | null; status: string }>;
    if (!meta[0] || (meta[0].status !== "submitted" && meta[0].status !== "reviewed")) {
      return { raised: 0, cleared: 0 };
    }
    const jobId = meta[0].job_id;
    // Outlier band: a person with > 12h in a day, OR 0h logged while work lines exist.
    const hasWork = (await tx.execute(sql`
      select 1 from public.report_work_line where report_id = ${reportId} and org_id = ${ctx.orgId} limit 1
    `)) as unknown as Array<{ "?column?": number }>;
    const lines = (await tx.execute(sql`
      select employee_id::text as employee_id, (normal_hours + ot_hours) as hours
      from public.report_labour_line where report_id = ${reportId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<{ employee_id: string; hours: number }>;
    let raised = 0;
    let cleared = 0;
    for (const l of lines) {
      const dedup = `labour_outlier:${reportId}:${l.employee_id}`;
      const outlier = Number(l.hours) > 12 || (Number(l.hours) === 0 && hasWork.length > 0);
      if (outlier) {
        const r = await raiseExceptionIn(tx, ctx, {
          ruleKey: "labour_outlier",
          severity: "info",
          jobId,
          subjectType: "daily_report",
          subjectId: reportId,
          evidenceRefs: [{ employeeId: l.employee_id, hours: Number(l.hours) }],
          audienceRoles: ["manager"], // E-07 audience: manager only (doc 04)
          dedupKey: dedup,
        });
        if (r.created) raised++;
      } else {
        await clearExceptionIn(tx, ctx, dedup);
        cleared++;
      }
    }
    return { raised, cleared };
  });
}

// ── Nightly evaluator: E-01, E-02, E-04 (raise + clear + self-heal), calendar-aware ─
export async function evaluateNightly(
  ctx: Ctx,
  opts: { asOf: string; nowMs: number },
): Promise<{ missing: number; overdue: number; blockers: number; cleared: number }> {
  const cal = await loadCalendar(ctx);
  const [missing, overdue, blockers] = await Promise.all([
    evaluateMissingReports(ctx, cal, opts.asOf),
    evaluateOverdueJobs(ctx, cal, opts.asOf),
    evaluateBlockingIssues(ctx, opts.nowMs),
  ]);
  // The active-only evaluators never revisit a job once it leaves 'active', so an
  // open missing_report/overdue_stage on a now-delivered/cancelled job would linger
  // forever. Self-heal them (review: exceptions never auto-clear once a job leaves
  // active) — mirrors the blocking_issue self-heal.
  const healed = await selfHealInactiveJobExceptions(ctx);
  return {
    missing: missing.raised,
    overdue: overdue.raised,
    blockers: blockers.raised,
    cleared: missing.cleared + overdue.cleared + blockers.cleared + healed,
  };
}

async function selfHealInactiveJobExceptions(ctx: Ctx): Promise<number> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      update public.exception e
      set resolved_at = now(), resolution = 'auto'
      where e.org_id = ${ctx.orgId}
        and e.rule_key in ('missing_report', 'overdue_stage')
        and e.resolved_at is null
        and not exists (
          select 1 from public.job j
          where j.id = e.job_id and j.org_id = ${ctx.orgId}
            and j.status_category = 'active' and j.archived = false
        )
      returning e.id
    `)) as unknown as Array<{ id: string }>;
    return rows.length;
  });
}

async function evaluateMissingReports(ctx: Ctx, cal: Calendar, asOf: string) {
  return withCtx(ctx, async (tx) => {
    // Active jobs with an assignment (a real production job): last report date, or
    // the job start_date if none, drives the working-day gap.
    const jobs = (await tx.execute(sql`
      select j.id::text as job_id,
             coalesce(max(r.report_date), j.start_date)::text as last_date
      from public.job j
      left join public.daily_report r
        on r.job_id = j.id and r.org_id = ${ctx.orgId} and r.status in ('submitted','reviewed')
      where j.org_id = ${ctx.orgId} and j.status_category = 'active' and j.archived = false
      group by j.id, j.start_date
    `)) as unknown as Array<{ job_id: string; last_date: string | null }>;
    let raised = 0;
    let cleared = 0;
    for (const j of jobs) {
      const dedup = `missing_report:${j.job_id}`;
      // Count only FULLY-ELAPSED working days — exclude asOf (today, still in progress
      // at the ~3am sweep). A job whose last report is the PREVIOUS working day is
      // current (gap 0), not missing; without this the rule flags every up-to-date job
      // every working morning (review: E-01 off-by-one).
      const gap = j.last_date ? workingDaysBetween(cal, j.last_date, addDays(asOf, -1)) : 0;
      if (gap >= 1) {
        const severity: ExceptionSeverity = gap >= 3 ? "critical" : "warning";
        const r = await raiseExceptionIn(tx, ctx, {
          ruleKey: "missing_report",
          severity,
          jobId: j.job_id,
          subjectType: "job",
          subjectId: j.job_id,
          evidenceRefs: [{ lastReportDate: j.last_date, workingDaysMissed: gap }],
          audienceRoles: ["owner", "admin", "manager"],
          dedupKey: dedup,
        });
        if (r.created) raised++;
      } else {
        await clearExceptionIn(tx, ctx, dedup);
        cleared++;
      }
    }
    return { raised, cleared };
  });
}

async function evaluateOverdueJobs(ctx: Ctx, cal: Calendar, asOf: string) {
  return withCtx(ctx, async (tx) => {
    // E-02 adaptation (the MVP schema has no per-stage due date): an active job past
    // its due_date and not done is overdue; > 7 WORKING days past → critical. Subject =
    // the job's current stage where present, else the job. The critical escalation
    // counts WORKING days (F-41) so a job due before a long Eid closure doesn't storm
    // to critical purely from holiday days (review: E-02 ignored the calendar).
    const jobs = (await tx.execute(sql`
      select j.id::text as job_id, j.due_date::text as due_date,
             j.current_stage_id::text as stage_id
      from public.job j
      where j.org_id = ${ctx.orgId} and j.status_category = 'active'
        and j.archived = false and j.due_date is not null
    `)) as unknown as Array<{ job_id: string; due_date: string; stage_id: string | null }>;
    let raised = 0;
    let cleared = 0;
    for (const j of jobs) {
      const dedup = `overdue_stage:${j.job_id}`;
      if (asOf > j.due_date) {
        const daysOver = workingDaysBetween(cal, j.due_date, asOf);
        const severity: ExceptionSeverity = daysOver > 7 ? "critical" : "warning";
        const r = await raiseExceptionIn(tx, ctx, {
          ruleKey: "overdue_stage",
          severity,
          jobId: j.job_id,
          subjectType: j.stage_id ? "job_stage" : "job",
          subjectId: j.stage_id ?? j.job_id,
          evidenceRefs: [{ dueDate: j.due_date, daysOverdue: daysOver }],
          audienceRoles: ["owner", "admin", "manager"],
          dedupKey: dedup,
        });
        if (r.created) raised++;
      } else {
        await clearExceptionIn(tx, ctx, dedup);
        cleared++;
      }
    }
    return { raised, cleared };
  });
}

async function evaluateBlockingIssues(ctx: Ctx, nowMs: number) {
  return withCtx(ctx, async (tx) => {
    // E-04: a blocking issue that is unresolved AND (no assignee) — aged past the
    // 4-hour warning threshold (wall-clock MVP). Clear when resolved or assigned.
    const issues = (await tx.execute(sql`
      select i.id::text as id, i.job_id::text as job_id,
             extract(epoch from now() - i.created_at) * 1000 as age_ms,
             (i.assignee_employee_id is null) as unassigned
      from public.issue i
      where i.org_id = ${ctx.orgId} and i.is_blocker = true
        and i.status in ('open','in_progress') and i.resolved_at is null
    `)) as unknown as Array<{
      id: string;
      job_id: string | null;
      age_ms: number;
      unassigned: boolean;
    }>;
    let raised = 0;
    let cleared = 0;
    for (const i of issues) {
      const dedup = `blocking_issue:${i.id}`;
      if (i.unassigned && Number(i.age_ms) >= BLOCKER_WARN_MS) {
        const r = await raiseExceptionIn(tx, ctx, {
          ruleKey: "blocking_issue",
          severity: "warning",
          jobId: i.job_id,
          subjectType: "issue",
          subjectId: i.id,
          audienceRoles: ["owner", "admin", "manager"],
          dedupKey: dedup,
          notifyTitle: { en: "A blocking issue needs action", ar: "مشكلة معطّلة بحاجة إلى إجراء" },
        });
        if (r.created) raised++;
      } else {
        await clearExceptionIn(tx, ctx, dedup);
        cleared++;
      }
    }
    // Self-heal: any open blocker exception whose issue is now resolved/closed clears.
    const healed = (await tx.execute(sql`
      update public.exception e
      set resolved_at = now(), resolution = 'auto'
      where e.org_id = ${ctx.orgId} and e.rule_key = 'blocking_issue' and e.resolved_at is null
        and not exists (
          select 1 from public.issue i
          where i.id = e.subject_id and i.org_id = ${ctx.orgId}
            and i.is_blocker = true and i.status in ('open','in_progress') and i.resolved_at is null
        )
      returning e.id
    `)) as unknown as Array<{ id: string }>;
    void nowMs;
    cleared += healed.length;
    return { raised, cleared };
  });
}

// ── Reads (audience-scoped) ───────────────────────────────────────────────────
export type ExceptionView = {
  id: string;
  ruleKey: string;
  severity: string;
  jobId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  raisedAt: string;
  evidenceRefs: unknown;
};

/** Open exceptions this archetype may see (audience ∩ archetype), newest first. */
export async function listOpenExceptions(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { jobId?: string; limit?: number } = {},
): Promise<ExceptionView[]> {
  assertCan(archetype, "exceptions.view");
  const limit = Math.min(opts.limit ?? 100, 500);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, rule_key, severity, job_id::text as job_id,
             subject_type, subject_id::text as subject_id,
             raised_at::text as raised_at, evidence_refs
      from public.exception
      where org_id = ${ctx.orgId} and resolved_at is null
        and ${archetype} = any(audience_roles)
        ${opts.jobId ? sql`and job_id = ${opts.jobId}` : sql``}
      order by array_position(array['critical','warning','info']::text[], severity), raised_at desc
      limit ${limit}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      ruleKey: r.rule_key as string,
      severity: r.severity as string,
      jobId: (r.job_id as string | null) ?? null,
      subjectType: (r.subject_type as string | null) ?? null,
      subjectId: (r.subject_id as string | null) ?? null,
      raisedAt: r.raised_at as string,
      evidenceRefs: r.evidence_refs,
    }));
  });
}

export const DismissInput = z.object({
  exceptionId: z.string().uuid(),
  note: z.string().trim().max(500).optional(),
});

/** Dismiss (manual-resolve) an exception — owner/admin/manager, audience+scope gated. */
export async function dismissException(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "exceptions.dismiss");
  const input = DismissInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "exception.dismiss",
        entityType: "exception",
        entityId: input.exceptionId,
        summary: `Dismissed exception${input.note ? `: ${input.note}` : ""}`,
      },
    },
    async (tx) => {
      // A guarded update: only an OPEN exception whose audience includes this
      // archetype may be dismissed (scope enforced at the DB, not just the read).
      const rows = (await tx.execute(sql`
        update public.exception
        set resolved_at = now(), resolution = 'dismissed',
            resolved_by = ${ctx.userId}, resolution_note = ${input.note ?? null}
        where id = ${input.exceptionId} and org_id = ${ctx.orgId}
          and resolved_at is null and ${archetype} = any(audience_roles)
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) {
        // Distinguish "no such open row" from "out of your audience" for the caller.
        const exists = (await tx.execute(sql`
          select 1 from public.exception
          where id = ${input.exceptionId} and org_id = ${ctx.orgId} and resolved_at is null
        `)) as unknown as Array<{ "?column?": number }>;
        if (exists.length > 0) throw new ExceptionScopeError();
        throw new ExceptionNotFoundError();
      }
      return rows[0];
    },
  );
}
