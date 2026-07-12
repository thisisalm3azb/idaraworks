/**
 * Reports module service — S1 walking-skeleton scope (doc 11: "one
 * hardcoded-form daily report"; lines/review land in S3). Submitting writes the
 * header row + audit + activity + daily_report.submitted event atomically.
 * Foreman scope (doc 06 "assigned, own"): in S1 a foreman may only report on a
 * job where he IS the foreman or which he created — job_crew arrives in S2.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, ForbiddenError } from "@/platform/authz";
import { DAILY_REPORT_SUBMITTED } from "@/platform/events";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";

export class DuplicateReportError extends Error {
  constructor(jobId: string, reportDate: string) {
    super(`a daily report for ${reportDate} already exists on job ${jobId}`);
    this.name = "DuplicateReportError";
  }
}

export const SubmitReportInput = z.object({
  jobId: z.string().uuid(),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  summary: z.string().trim().min(1).max(2000),
  blockers: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v ? v : undefined)),
  nextSteps: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export async function submitDailyReport(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "reports.create");
  const data = SubmitReportInput.parse(input);

  // Foreman condition (doc 06 "assigned"): S1 assignment = job.foreman_user_id
  // or creator; managers+ report on any job.
  if (archetype === "foreman") {
    const rows = (await withCtx(ctx, (tx) =>
      tx.execute(sql`
        select 1 as ok from public.job
        where org_id = ${ctx.orgId} and id = ${data.jobId}
          and (foreman_user_id = ${ctx.userId} or created_by = ${ctx.userId})
      `),
    )) as unknown as Array<{ ok: number }>;
    if (rows.length === 0) throw new ForbiddenError("reports.create");
  }

  const id = randomUUID();
  try {
    await command(
      ctx,
      {
        audit: {
          action: "daily_report.submit",
          entityType: "daily_report",
          entityId: id,
          summary: `Submitted daily report for ${data.reportDate}`,
        },
        activity: {
          entityType: "job",
          entityId: data.jobId,
          verb: "reported",
          summary: `submitted the daily report for ${data.reportDate}`,
        },
        events: [
          {
            name: DAILY_REPORT_SUBMITTED,
            payload: {
              orgId: ctx.orgId,
              actorUserId: ctx.userId,
              reportId: id,
              jobId: data.jobId,
              reportDate: data.reportDate,
            },
          },
        ],
      },
      (tx) =>
        tx.execute(sql`
        insert into public.daily_report
          (id, org_id, job_id, report_date, summary, blockers, next_steps, status, submitted_by, submitted_at)
        values (${id}, ${ctx.orgId}, ${data.jobId}, ${data.reportDate}, ${data.summary},
                ${data.blockers ?? null}, ${data.nextSteps ?? null}, 'submitted', ${ctx.userId}, now())
      `),
    );
  } catch (err) {
    // One report per job per day (0022 unique) → a typed, translatable error.
    const cause = (err as { cause?: { code?: string; constraint_name?: string } }).cause;
    if (cause?.code === "23505" && cause.constraint_name === "daily_report_job_date_uq") {
      throw new DuplicateReportError(data.jobId, data.reportDate);
    }
    throw err;
  }
  return { id };
}

export type ReportRow = {
  id: string;
  reportDate: string;
  summary: string;
  blockers: string | null;
  nextSteps: string | null;
  submittedByName: string | null;
};

export async function listJobReports(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
): Promise<ReportRow[]> {
  assertCan(archetype, "jobs.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select r.id::text as id, r.report_date::text as report_date, r.summary,
             r.blockers, r.next_steps, u.full_name as submitted_by_name
      from public.daily_report r
      left join public.user_profile u on u.id = r.submitted_by
      where r.org_id = ${ctx.orgId} and r.job_id = ${jobId}
      order by r.report_date desc
    `),
  )) as unknown as Array<{
    id: string;
    report_date: string;
    summary: string;
    blockers: string | null;
    next_steps: string | null;
    submitted_by_name: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    reportDate: r.report_date,
    summary: r.summary,
    blockers: r.blockers,
    nextSteps: r.next_steps,
    submittedByName: r.submitted_by_name,
  }));
}
