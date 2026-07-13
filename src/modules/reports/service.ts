/**
 * Reports module service — S3 "Report: the heartbeat" (doc 11; doc 01 D-1.5).
 * The daily report is now a full structured document: a header + work / material
 * / labour lines, an exactly-once idempotent submit (offline outbox, doc 10 #20),
 * a manager review loop (submitted → reviewed | returned, C-6 immutable once
 * reviewed), a FROZEN labour-cost snapshot behind the D-6.2 cost wall, and
 * attendance derived from labour hours (U3/C-3). Every mutation runs through the
 * command() path (audit + activity + transactional-outbox events, one tx).
 *
 * The cost wall: a foreman ENTERS hours (report_labour_line) but the cost
 * snapshot (report_labour_cost) is written by the SECURITY DEFINER
 * app.freeze_report_labour_costs — so a non-cost-privileged submit freezes cost
 * WITHOUT the foreman ever reading it (the RLS select wall stays intact).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, ForbiddenError } from "@/platform/authz";
import {
  DAILY_REPORT_SUBMITTED,
  DAILY_REPORT_REVIEWED,
  DAILY_REPORT_RETURNED,
} from "@/platform/events";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { isAssignedIn } from "@/modules/jobs/service";
import type { RoleArchetype } from "@/platform/registries";

// ── Typed errors (translatable at the surface) ──────────────────────────────
export class DuplicateReportError extends Error {
  constructor(jobId: string, reportDate: string) {
    super(`a daily report for ${reportDate} already exists on job ${jobId}`);
    this.name = "DuplicateReportError";
  }
}
export class ReportIdentityMismatchError extends Error {
  constructor() {
    super("idempotency key reused for a different job/date");
    this.name = "ReportIdentityMismatchError";
  }
}
export class ReportNotFoundError extends Error {
  constructor(id: string) {
    super(`report ${id} not found`);
    this.name = "ReportNotFoundError";
  }
}
export class ReportStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportStateError";
  }
}
export class InvalidReportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReportInputError";
  }
}

// ── Input schemas ────────────────────────────────────────────────────────────
const WorkLineInput = z.object({
  stageKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .optional(),
  stageId: z.string().uuid().optional(),
  description: z.string().trim().min(1).max(2000),
  progressNote: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v : undefined)),
});
const MaterialLineInput = z.object({
  itemId: z.string().uuid().optional(),
  itemName: z.string().trim().min(1).max(160),
  qty: z.number().positive().max(1_000_000_000),
  unit: z.string().trim().min(1).max(16),
});
const LabourLineInput = z.object({
  employeeId: z.string().uuid(),
  normalHours: z.number().min(0).max(24),
  otHours: z.number().min(0).max(24),
});

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const SaveReportInput = z.object({
  jobId: z.string().uuid(),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  summary: z.string().trim().min(1).max(2000),
  blockers: optionalText(2000),
  nextSteps: optionalText(2000),
  // Client-generated, stable across offline retries AND across a returned-report
  // re-edit — the logical identity of this submission (doc 10 #20).
  idempotencyKey: z.string().trim().min(8).max(128),
  isBackfill: z.boolean().optional().default(false),
  workLines: z.array(WorkLineInput).max(50).optional().default([]),
  materialLines: z.array(MaterialLineInput).max(100).optional().default([]),
  labourLines: z.array(LabourLineInput).max(100).optional().default([]),
});
export type SaveReportInput = z.infer<typeof SaveReportInput>;

type ExistingReport = { id: string; status: string; job_id: string; report_date: string };

// Rollback sentinel: a rare in-tx race where the report was finalised by a
// concurrent submit between our pre-check and our row lock. Throwing it rolls the
// command tx back (so NO audit/activity is written for a no-op) and the caller
// converts it to a deduped result — exactly-once with zero duplicate writes.
class AlreadyFinalizedSignal extends Error {
  constructor(
    readonly reportId: string,
    readonly submitted: boolean,
  ) {
    super("report already finalised");
    this.name = "AlreadyFinalizedSignal";
  }
}

// ── saveReport: the ONE upsert covering draft / submit / re-edit / retry ─────
// Keyed by idempotency_key, it creates or resolves the logical report, replaces
// its lines (while editable), and — when submit=true — freezes labour cost,
// derives attendance and emits the submitted event. Exactly-once by construction.
async function saveReport(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
  submit: boolean,
): Promise<{ id: string; deduped: boolean; submitted: boolean }> {
  assertCan(archetype, "reports.create");
  const data = SaveReportInput.parse(input);

  // Server-authoritative date gate (review finding A): a field user must NOT be
  // able to self-authorize backdating by simply omitting is_backfill, nor fabricate
  // FUTURE attendance/labour-cost. The reference is the SERVER date (UTC), never
  // the client flag. A generous recent window (14 days back, 1 day forward — GCC
  // tz offset + a night-shift catch-up) is "normal"; older is backfill (owner/
  // admin only, doc 06); further-future is rejected for everyone. is_backfill is
  // DERIVED here, not trusted from the client.
  const RECENT_PAST_DAYS = 14;
  const FUTURE_GRACE_DAYS = 1;
  const now = new Date();
  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const [ry, rm, rd] = data.reportDate.split("-").map(Number);
  const reportUtcMs = Date.UTC(ry!, rm! - 1, rd!);
  const DAY = 86_400_000;
  if (reportUtcMs > todayUtcMs + FUTURE_GRACE_DAYS * DAY) {
    throw new InvalidReportInputError("report date cannot be in the future");
  }
  const isBackfill = reportUtcMs < todayUtcMs - RECENT_PAST_DAYS * DAY;
  if (isBackfill) assertCan(archetype, "reports.backfill");

  // Reject duplicate employees up front (the labour unique would 23505 anyway).
  const empIds = data.labourLines.map((l) => l.employeeId);
  if (new Set(empIds).size !== empIds.length) {
    throw new InvalidReportInputError("an employee appears more than once in labour lines");
  }

  // Fast idempotent path (P1: reporting must never be slow): a retry of an
  // ALREADY-finalised report writes nothing and returns the existing id.
  const pre = await findByIdempotencyKey(ctx, data.idempotencyKey);
  if (pre) {
    if (pre.job_id !== data.jobId || pre.report_date !== data.reportDate) {
      throw new ReportIdentityMismatchError();
    }
    if (pre.status === "submitted" || pre.status === "reviewed") {
      return { id: pre.id, deduped: true, submitted: pre.status === "submitted" };
    }
  }

  try {
    const result = await command<{ id: string; submitted: boolean }>(
      ctx,
      {
        audit: (r) => ({
          action: submit ? "daily_report.submit" : "daily_report.save_draft",
          entityType: "daily_report",
          entityId: r.id,
          summary: `${submit ? "Submitted" : "Saved draft"} daily report for ${data.reportDate}`,
        }),
        activity: {
          entityType: "job",
          entityId: data.jobId,
          verb: submit ? "reported" : "drafted",
          summary: `${submit ? "submitted" : "saved a draft of"} the daily report for ${data.reportDate}`,
        },
        events: (r) =>
          submit
            ? [
                {
                  name: DAILY_REPORT_SUBMITTED,
                  payload: {
                    orgId: ctx.orgId,
                    actorUserId: ctx.userId,
                    reportId: r.id,
                    jobId: data.jobId,
                    reportDate: data.reportDate,
                  },
                },
              ]
            : [],
      },
      async (tx) => {
        if (archetype === "foreman" && !(await isAssignedIn(tx, ctx, data.jobId))) {
          throw new ForbiddenError("reports.create");
        }

        // Resolve any existing report for this idempotency key (lock it).
        const existingRows = (await tx.execute(sql`
          select id::text as id, status, job_id::text as job_id, report_date::text as report_date
          from public.daily_report
          where org_id = ${ctx.orgId} and idempotency_key = ${data.idempotencyKey}
          for update
        `)) as unknown as ExistingReport[];
        const existing = existingRows[0];

        let reportId: string;
        if (existing) {
          if (existing.job_id !== data.jobId || existing.report_date !== data.reportDate) {
            throw new ReportIdentityMismatchError();
          }
          reportId = existing.id;
          // Finalised by a concurrent submit in our window → rollback + dedup.
          if (existing.status === "submitted" || existing.status === "reviewed") {
            throw new AlreadyFinalizedSignal(reportId, existing.status === "submitted");
          }
          // draft | returned → editable: update the header (status untouched here).
          await tx.execute(sql`
            update public.daily_report
            set summary = ${data.summary}, blockers = ${data.blockers ?? null},
                next_steps = ${data.nextSteps ?? null}, updated_at = now()
            where id = ${reportId} and org_id = ${ctx.orgId}
          `);
        } else {
          reportId = randomUUID();
          await tx.execute(sql`
            insert into public.daily_report
              (id, org_id, job_id, report_date, summary, blockers, next_steps,
               status, submitted_by, idempotency_key, is_backfill)
            values (${reportId}, ${ctx.orgId}, ${data.jobId}, ${data.reportDate},
                    ${data.summary}, ${data.blockers ?? null}, ${data.nextSteps ?? null},
                    'draft', ${ctx.userId}, ${data.idempotencyKey}, ${isBackfill})
          `);
        }

        // Replace lines (report is draft/returned/new-draft → DELETE gate allows it).
        await replaceLines(tx, ctx, reportId, data);

        if (submit) {
          await tx.execute(sql`
            update public.daily_report
            set status = 'submitted', submitted_at = now(),
                reviewed_by = null, reviewed_at = null,
                returned_by = null, returned_at = null, return_reason = null,
                updated_at = now()
            where id = ${reportId} and org_id = ${ctx.orgId}
          `);
          // Freeze cost (DEFINER, crosses the wall) + derive attendance (C-3).
          await tx.execute(sql`select app.freeze_report_labour_costs(${reportId}::uuid)`);
          await tx.execute(sql`select app.derive_attendance_from_report(${reportId}::uuid)`);
        }

        return { id: reportId, submitted: submit };
      },
    );
    return { id: result.id, deduped: false, submitted: result.submitted };
  } catch (err) {
    if (err instanceof AlreadyFinalizedSignal) {
      return { id: err.reportId, deduped: true, submitted: err.submitted };
    }
    const cause = (err as { cause?: { code?: string; constraint_name?: string } }).cause;
    if (cause?.code === "23505") {
      // EITHER unique (idem OR job_date) can fire first for a concurrent SAME-key
      // race (review finding D): resolve by OUR key regardless of which constraint
      // Postgres reported. If a report now exists for this key, dedup to it —
      // exactly-once. Only a DIFFERENT key colliding on (job, date) is a genuine
      // "already reported today".
      const existing = await findByIdempotencyKey(ctx, data.idempotencyKey);
      if (existing) {
        if (existing.job_id !== data.jobId || existing.report_date !== data.reportDate) {
          throw new ReportIdentityMismatchError();
        }
        return { id: existing.id, deduped: true, submitted: existing.status === "submitted" };
      }
      if (cause.constraint_name === "daily_report_job_date_uq") {
        throw new DuplicateReportError(data.jobId, data.reportDate);
      }
    }
    throw err;
  }
}

async function findByIdempotencyKey(ctx: Ctx, key: string): Promise<ExistingReport | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, status, job_id::text as job_id, report_date::text as report_date
      from public.daily_report
      where org_id = ${ctx.orgId} and idempotency_key = ${key}
    `),
  )) as unknown as ExistingReport[];
  return rows[0] ?? null;
}

// Replace the report's lines. Item-linked materials snapshot the catalog name /
// unit / cost server-side (D-1.6, never trusting a client cost); free-text
// materials carry no cost (cost_source 'none'). cost_only stays TRUE and
// deducted_from_inventory FALSE — S3 does NO stock movement (P3).
async function replaceLines(
  tx: TenantTx,
  ctx: Ctx,
  reportId: string,
  data: SaveReportInput,
): Promise<void> {
  // SOFT delete (D-1.7: void, never hard-delete) — supersede the active lines,
  // then insert the new set. Reads filter superseded_at IS NULL; the partial
  // unique on labour lets a superseded employee be re-added.
  await tx.execute(
    sql`update public.report_work_line set superseded_at = now()
        where report_id = ${reportId} and org_id = ${ctx.orgId} and superseded_at is null`,
  );
  await tx.execute(
    sql`update public.report_material_line set superseded_at = now()
        where report_id = ${reportId} and org_id = ${ctx.orgId} and superseded_at is null`,
  );
  await tx.execute(
    sql`update public.report_labour_line set superseded_at = now()
        where report_id = ${reportId} and org_id = ${ctx.orgId} and superseded_at is null`,
  );

  for (const [i, w] of data.workLines.entries()) {
    await tx.execute(sql`
      insert into public.report_work_line
        (id, org_id, report_id, stage_key, stage_id, description, progress_note, sort)
      values (${randomUUID()}, ${ctx.orgId}, ${reportId}, ${w.stageKey ?? null},
              ${w.stageId ?? null}, ${w.description}, ${w.progressNote ?? null}, ${i})
    `);
  }

  // Batch-validate item ids belong to this org (FK would catch cross-org, but a
  // clear error beats a raw 23503). Snapshot name/unit/cost from the catalog.
  const itemIds = [...new Set(data.materialLines.map((m) => m.itemId).filter(Boolean))] as string[];
  const itemMap = new Map<string, { name: string; unit: string; unit_cost_minor: string | null }>();
  if (itemIds.length > 0) {
    const items = (await tx.execute(sql`
      select id::text as id, name, unit, unit_cost_minor::text as unit_cost_minor
      from public.item
      where org_id = ${ctx.orgId}
        and id in (${sql.join(
          itemIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        and active = true
    `)) as unknown as Array<{
      id: string;
      name: string;
      unit: string;
      unit_cost_minor: string | null;
    }>;
    for (const it of items) itemMap.set(it.id, it);
    const missing = itemIds.filter((id) => !itemMap.has(id));
    if (missing.length > 0) {
      throw new InvalidReportInputError(
        `unknown or inactive catalog item(s): ${missing.join(", ")}`,
      );
    }
  }
  for (const [i, m] of data.materialLines.entries()) {
    const cat = m.itemId ? itemMap.get(m.itemId) : undefined;
    const itemName = cat ? cat.name : m.itemName;
    const unit = cat ? cat.unit : m.unit;
    const unitCost = cat ? cat.unit_cost_minor : null;
    const costSource = cat ? "catalog" : "none";
    await tx.execute(sql`
      insert into public.report_material_line
        (id, org_id, report_id, item_id, item_name, qty, unit,
         unit_cost_minor, cost_source, cost_only, deducted_from_inventory, sort)
      values (${randomUUID()}, ${ctx.orgId}, ${reportId}, ${m.itemId ?? null}, ${itemName},
              ${m.qty}, ${unit}, ${unitCost}, ${costSource}, true, false, ${i})
    `);
  }

  // Validate labour employees are in-org + active (clear error before the FK).
  if (data.labourLines.length > 0) {
    const ids = data.labourLines.map((l) => l.employeeId);
    const found = (await tx.execute(sql`
      select id::text as id from public.employee
      where org_id = ${ctx.orgId}
        and id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        and active = true
    `)) as unknown as Array<{ id: string }>;
    const foundSet = new Set(found.map((r) => r.id));
    const missing = ids.filter((id) => !foundSet.has(id));
    if (missing.length > 0) {
      throw new InvalidReportInputError(`unknown or inactive employee(s): ${missing.join(", ")}`);
    }
  }
  for (const [i, l] of data.labourLines.entries()) {
    await tx.execute(sql`
      insert into public.report_labour_line
        (id, org_id, report_id, employee_id, normal_hours, ot_hours, sort)
      values (${randomUUID()}, ${ctx.orgId}, ${reportId}, ${l.employeeId},
              ${l.normalHours}, ${l.otHours}, ${i})
    `);
  }
}

export function submitDailyReport(ctx: Ctx, archetype: RoleArchetype, input: unknown) {
  return saveReport(ctx, archetype, input, true);
}
export function saveReportDraft(ctx: Ctx, archetype: RoleArchetype, input: unknown) {
  return saveReport(ctx, archetype, input, false);
}

// ── Review loop (A/M) ────────────────────────────────────────────────────────
async function transitionReview(
  ctx: Ctx,
  archetype: RoleArchetype,
  reportId: string,
  to: "reviewed" | "returned",
  reason?: string,
): Promise<{ id: string; jobId: string; reportDate: string }> {
  assertCan(archetype, "reports.review");
  if (to === "returned" && (!reason || reason.trim().length === 0)) {
    throw new InvalidReportInputError("a return requires a reason");
  }
  return command<{ id: string; jobId: string; reportDate: string }>(
    ctx,
    {
      audit: (r) => ({
        action: to === "reviewed" ? "daily_report.review" : "daily_report.return",
        entityType: "daily_report",
        entityId: r.id,
        summary: `${to === "reviewed" ? "Reviewed" : "Returned"} daily report for ${r.reportDate}`,
      }),
      activity: (r) => ({
        entityType: "job",
        entityId: r.jobId,
        verb: to === "reviewed" ? "reviewed" : "returned",
        summary: `${to === "reviewed" ? "reviewed" : "returned"} the daily report for ${r.reportDate}`,
      }),
      events: (r) => [
        to === "reviewed"
          ? {
              name: DAILY_REPORT_REVIEWED,
              payload: {
                orgId: ctx.orgId,
                actorUserId: ctx.userId,
                reportId: r.id,
                jobId: r.jobId,
                reportDate: r.reportDate,
              },
            }
          : {
              name: DAILY_REPORT_RETURNED,
              payload: {
                orgId: ctx.orgId,
                actorUserId: ctx.userId,
                reportId: r.id,
                jobId: r.jobId,
                reportDate: r.reportDate,
                reason: reason!.trim(),
              },
            },
      ],
    },
    async (tx) => {
      // Plain SELECT (org-scoped SELECT policy sees the row in ANY status) for a
      // precise error. NB: a `SELECT ... FOR UPDATE` here would be filtered by the
      // status-restricted UPDATE policies (0031) — a reviewed report isn't
      // lockable — so we validate with a plain read and race-guard on the UPDATE.
      const rows = (await tx.execute(sql`
        select status from public.daily_report
        where id = ${reportId} and org_id = ${ctx.orgId}
      `)) as unknown as Array<{ status: string }>;
      if (!rows[0]) throw new ReportNotFoundError(reportId);
      if (rows[0].status !== "submitted") {
        throw new ReportStateError(`only a submitted report can be ${to} (was ${rows[0].status})`);
      }
      // Guarded UPDATE: `status = 'submitted'` in the WHERE + the review RLS policy
      // make a concurrent double-review a 0-row no-op we detect via RETURNING.
      const updated = (to === "reviewed"
        ? await tx.execute(sql`
              update public.daily_report
              set status = 'reviewed', reviewed_by = ${ctx.userId}, reviewed_at = now(), updated_at = now()
              where id = ${reportId} and org_id = ${ctx.orgId} and status = 'submitted'
              returning id::text as id, job_id::text as job_id, report_date::text as report_date
            `)
        : await tx.execute(sql`
              update public.daily_report
              set status = 'returned', returned_by = ${ctx.userId}, returned_at = now(),
                  return_reason = ${reason!.trim()}, updated_at = now()
              where id = ${reportId} and org_id = ${ctx.orgId} and status = 'submitted'
              returning id::text as id, job_id::text as job_id, report_date::text as report_date
            `)) as unknown as Array<{ id: string; job_id: string; report_date: string }>;
      const row = updated[0];
      if (!row) throw new ReportStateError(`report was concurrently changed; cannot ${to}`);
      return { id: row.id, jobId: row.job_id, reportDate: row.report_date };
    },
  );
}

export function reviewReport(ctx: Ctx, archetype: RoleArchetype, reportId: string) {
  return transitionReview(ctx, archetype, reportId, "reviewed");
}
export function returnReport(ctx: Ctx, archetype: RoleArchetype, reportId: string, reason: string) {
  return transitionReview(ctx, archetype, reportId, "returned", reason);
}

// ── Reads ────────────────────────────────────────────────────────────────────
export type ReportRow = {
  id: string;
  reportDate: string;
  summary: string;
  blockers: string | null;
  nextSteps: string | null;
  status: string;
  submittedByName: string | null;
};

export async function listJobReports(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
): Promise<ReportRow[]> {
  assertCan(archetype, "jobs.view");
  if (archetype === "foreman" && !(await withCtx(ctx, (tx) => isAssignedIn(tx, ctx, jobId)))) {
    return [];
  }
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select r.id::text as id, r.report_date::text as report_date, r.summary,
             r.blockers, r.next_steps, r.status, u.full_name as submitted_by_name
      from public.daily_report r
      left join public.user_profile u on u.id = r.submitted_by
      where r.org_id = ${ctx.orgId} and r.job_id = ${jobId}
      order by r.report_date desc, r.created_at desc
    `),
  )) as unknown as Array<{
    id: string;
    report_date: string;
    summary: string;
    blockers: string | null;
    next_steps: string | null;
    status: string;
    submitted_by_name: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    reportDate: r.report_date,
    summary: r.summary,
    blockers: r.blockers,
    nextSteps: r.next_steps,
    status: r.status,
    submittedByName: r.submitted_by_name,
  }));
}

export type ReviewQueueRow = {
  id: string;
  jobId: string;
  jobReference: string | null;
  reportDate: string;
  summary: string;
  submittedByName: string | null;
};

export async function listReviewQueue(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<ReviewQueueRow[]> {
  assertCan(archetype, "reports.review");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select r.id::text as id, r.job_id::text as job_id, j.reference as job_reference,
             r.report_date::text as report_date, r.summary, u.full_name as submitted_by_name
      from public.daily_report r
      join public.job j on j.id = r.job_id and j.org_id = r.org_id
      left join public.user_profile u on u.id = r.submitted_by
      where r.org_id = ${ctx.orgId} and r.status = 'submitted'
      order by r.report_date asc, r.submitted_at asc
    `),
  )) as unknown as Array<{
    id: string;
    job_id: string;
    job_reference: string | null;
    report_date: string;
    summary: string;
    submitted_by_name: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    jobReference: r.job_reference,
    reportDate: r.report_date,
    summary: r.summary,
    submittedByName: r.submitted_by_name,
  }));
}

export type WorkLine = {
  id: string;
  stageKey: string | null;
  description: string;
  progressNote: string | null;
};
export type MaterialLine = {
  id: string;
  itemId: string | null;
  itemName: string;
  qty: string;
  unit: string;
  costSource: string;
};
export type LabourLine = {
  employeeId: string;
  employeeName: string | null;
  normalHours: string;
  otHours: string;
  /** Present ONLY for a cost-privileged reader (the D-6.2 wall). */
  labourCostMinor: string | null;
};
export type ReportDetail = {
  id: string;
  jobId: string;
  reportDate: string;
  summary: string;
  blockers: string | null;
  nextSteps: string | null;
  status: string;
  isBackfill: boolean;
  isAuthor: boolean;
  submittedByName: string | null;
  reviewedByName: string | null;
  returnReason: string | null;
  workLines: WorkLine[];
  materialLines: MaterialLine[];
  labourLines: LabourLine[];
};

export async function getReportDetail(
  ctx: Ctx,
  archetype: RoleArchetype,
  reportId: string,
): Promise<ReportDetail | null> {
  assertCan(archetype, "jobs.view");
  return withCtx(ctx, async (tx) => {
    const headRows = (await tx.execute(sql`
      select r.id::text as id, r.job_id::text as job_id, r.report_date::text as report_date,
             r.summary, r.blockers, r.next_steps, r.status, r.is_backfill, r.return_reason,
             (r.submitted_by = ${ctx.userId}) as is_author,
             s.full_name as submitted_by_name, v.full_name as reviewed_by_name
      from public.daily_report r
      left join public.user_profile s on s.id = r.submitted_by
      left join public.user_profile v on v.id = r.reviewed_by
      where r.id = ${reportId} and r.org_id = ${ctx.orgId}
    `)) as unknown as Array<{
      id: string;
      job_id: string;
      report_date: string;
      summary: string;
      blockers: string | null;
      next_steps: string | null;
      status: string;
      is_backfill: boolean;
      is_author: boolean;
      return_reason: string | null;
      submitted_by_name: string | null;
      reviewed_by_name: string | null;
    }>;
    const head = headRows[0];
    if (!head) return null;
    // Foreman: assigned-job scope (F-6).
    if (archetype === "foreman" && !(await isAssignedIn(tx, ctx, head.job_id))) return null;

    const work = (await tx.execute(sql`
      select id::text as id, stage_key, description, progress_note
      from public.report_work_line
      where report_id = ${reportId} and org_id = ${ctx.orgId} and superseded_at is null
      order by sort asc
    `)) as unknown as Array<{
      id: string;
      stage_key: string | null;
      description: string;
      progress_note: string | null;
    }>;

    const materials = (await tx.execute(sql`
      select id::text as id, item_id::text as item_id, item_name, qty::text as qty, unit, cost_source
      from public.report_material_line
      where report_id = ${reportId} and org_id = ${ctx.orgId} and superseded_at is null
      order by sort asc
    `)) as unknown as Array<{
      id: string;
      item_id: string | null;
      item_name: string;
      qty: string;
      unit: string;
      cost_source: string;
    }>;

    // Labour hours are always visible; the cost snapshot is joined ONLY for a
    // cost-privileged reader. The RLS wall means a non-cost session reads zero
    // report_labour_cost rows anyway — the service gate is the belt to that braces.
    const labour = (await tx.execute(sql`
      select l.employee_id::text as employee_id, e.name as employee_name,
             l.normal_hours::text as normal_hours, l.ot_hours::text as ot_hours,
             ${ctx.costPrivileged ? sql`c.labour_cost_minor::text` : sql`null`} as labour_cost_minor
      from public.report_labour_line l
      left join public.employee e on e.id = l.employee_id and e.org_id = l.org_id
      ${
        ctx.costPrivileged
          ? sql`left join public.report_labour_cost c on c.report_id = l.report_id and c.employee_id = l.employee_id`
          : sql``
      }
      where l.report_id = ${reportId} and l.org_id = ${ctx.orgId} and l.superseded_at is null
      order by l.sort asc
    `)) as unknown as Array<{
      employee_id: string;
      employee_name: string | null;
      normal_hours: string;
      ot_hours: string;
      labour_cost_minor: string | null;
    }>;

    return {
      id: head.id,
      jobId: head.job_id,
      reportDate: head.report_date,
      summary: head.summary,
      blockers: head.blockers,
      nextSteps: head.next_steps,
      status: head.status,
      isBackfill: head.is_backfill,
      isAuthor: head.is_author,
      submittedByName: head.submitted_by_name,
      reviewedByName: head.reviewed_by_name,
      returnReason: head.return_reason,
      workLines: work.map((w) => ({
        id: w.id,
        stageKey: w.stage_key,
        description: w.description,
        progressNote: w.progress_note,
      })),
      materialLines: materials.map((m) => ({
        id: m.id,
        itemId: m.item_id,
        itemName: m.item_name,
        qty: m.qty,
        unit: m.unit,
        costSource: m.cost_source,
      })),
      labourLines: labour.map((l) => ({
        employeeId: l.employee_id,
        employeeName: l.employee_name,
        normalHours: l.normal_hours,
        otHours: l.ot_hours,
        labourCostMinor: l.labour_cost_minor,
      })),
    };
  });
}

// Find the id of an EDITABLE (draft|returned) report for a (job, date) — the
// composer uses it to pre-load a returned report for re-edit (review finding C).
export async function findEditableReportId(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  reportDate: string,
): Promise<string | null> {
  assertCan(archetype, "reports.create");
  return withCtx(ctx, async (tx) => {
    if (archetype === "foreman" && !(await isAssignedIn(tx, ctx, jobId))) return null;
    const rows = (await tx.execute(sql`
      select id::text as id from public.daily_report
      where org_id = ${ctx.orgId} and job_id = ${jobId} and report_date = ${reportDate}
        and status in ('draft', 'returned')
    `)) as unknown as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  });
}

// ── Scoped lookups for the foreman composer (NO employees.view/catalog.view) ──
// A foreman has neither masters permission, so the report form gets its OWN
// scoped, minimal lookups: the job's crew (labour picker) and stages (work
// picker). Gated by reports.create + the F-6 assignment, never by masters perms.
export type ReportCrewOption = { id: string; name: string };
export async function listReportableEmployees(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
): Promise<ReportCrewOption[]> {
  assertCan(archetype, "reports.create");
  return withCtx(ctx, async (tx) => {
    if (archetype === "foreman" && !(await isAssignedIn(tx, ctx, jobId))) return [];
    const rows = (await tx.execute(sql`
      select e.id::text as id, e.name from public.job_crew jc
      join public.employee e on e.id = jc.employee_id and e.org_id = jc.org_id
      where jc.org_id = ${ctx.orgId} and jc.job_id = ${jobId}
        and jc.removed_at is null and e.active = true
      order by e.name asc
    `)) as unknown as Array<{ id: string; name: string }>;
    return rows.map((r) => ({ id: r.id, name: r.name }));
  });
}

export type ReportStageOption = { stageKey: string; name: { en: string; ar: string } };
export async function listReportableStages(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
): Promise<ReportStageOption[]> {
  assertCan(archetype, "reports.create");
  return withCtx(ctx, async (tx) => {
    if (archetype === "foreman" && !(await isAssignedIn(tx, ctx, jobId))) return [];
    const rows = (await tx.execute(sql`
      select stage_key, name from public.job_stage
      where org_id = ${ctx.orgId} and job_id = ${jobId} and status <> 'skipped'
      order by sort asc
    `)) as unknown as Array<{ stage_key: string; name: { en: string; ar: string } }>;
    return rows.map((r) => ({ stageKey: r.stage_key, name: r.name }));
  });
}

// ── Catalog item lookup for the material-line picker (NO cost — F-23) ─────────
export type ReportItemOption = { id: string; sku: string; name: string; unit: string };
export async function listItemsForReport(
  ctx: Ctx,
  archetype: RoleArchetype,
  query?: string,
): Promise<ReportItemOption[]> {
  // Any reporter may look items up; the DTO carries NO cost/price (foremen never
  // see money — the material cost snapshot is a server-side write, not a read).
  assertCan(archetype, "reports.create");
  const like = query && query.trim() ? `%${query.trim().toLowerCase()}%` : null;
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, sku, name, unit
      from public.item
      where org_id = ${ctx.orgId} and active = true
        ${like ? sql`and (lower(name) like ${like} or lower(sku) like ${like})` : sql``}
      order by name asc
      limit 50
    `),
  )) as unknown as Array<{ id: string; sku: string; name: string; unit: string }>;
  return rows.map((r) => ({ id: r.id, sku: r.sku, name: r.name, unit: r.unit }));
}
