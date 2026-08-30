/**
 * H17 — the adaptive dashboard's data gatherer (module public surface).
 *
 * ONE server-side place that fetches the live facts the pure composer
 * (./compose.ts) needs, and nothing more: every source is fetched only when
 * the acting user's permission could surface it (no data for hidden cards),
 * independent sources run CONCURRENTLY, and each non-critical source is
 * individually guarded — one failed read degrades its own section to an
 * honest "not available" label instead of failing the whole dashboard
 * (H17 Part L). Redaction stays with the owning services (computeAR,
 * getDashboardExtras, listInbox all self-redact); this file never widens
 * what they decided the caller may see.
 *
 * Date boundaries use the ORGANIZATION's calendar day (orgToday) — the org
 * timezone decides when "today" flips, not the server's UTC clock (Part G).
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { can } from "@/platform/authz";
import { assignedJobCondition } from "@/modules/jobs/service";
import { listOpenExceptions } from "@/modules/exceptions/service";
import { computeAR } from "@/modules/invoices/service";
import { listInbox } from "@/modules/approvals/service";
import { getDashboardExtras } from "@/modules/today/service";
import { countMissingToday, countReviewQueue } from "@/modules/reports/service";
import { salesDashboardCounts } from "@/modules/crm/service";
import type { RoleArchetype } from "@/platform/registries";
import type { DashboardData } from "./compose";

// H18 canonical drill-down filter contracts (module public surface).
export * from "./filters";

export {
  composeAdaptiveDashboard,
  cardAllowed,
  allowedCards,
  priorityOf,
  sortItems,
  CARD_ACTION,
  CARD_ROLES,
  HORIZON_DAYS,
  type AdaptiveDashboardView,
  type ComposeContext,
  type CompiledRoleDashboard,
  type DashboardData,
  type DashboardItem,
  type PulseMetric,
  type Severity,
} from "./compose";

/** The org's current calendar date (YYYY-MM-DD) in its own timezone.
 * Falls back to the UTC date when the timezone is missing or invalid. */
export function orgToday(now: Date, timezone: string | null): string {
  if (timezone) {
    try {
      // en-CA formats as YYYY-MM-DD.
      return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
    } catch {
      // Unknown zone id — fall through to UTC.
    }
  }
  return now.toISOString().slice(0, 10);
}

async function guarded<T>(
  key: string,
  failed: string[],
  fetcher: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fetcher();
  } catch {
    failed.push(key);
    return null;
  }
}

export async function gatherDashboardData(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { asOf: string; computedAt: string; horizonDays?: number },
): Promise<DashboardData> {
  const failed: string[] = [];
  const foreman = archetype === "foreman";

  const [exceptions, extras, inbox, ar, field, reviewQueue, sales] = await Promise.all([
    can(archetype, "exceptions.view")
      ? guarded("exceptions", failed, () => listOpenExceptions(ctx, archetype, { limit: 200 }))
      : Promise.resolve(null),
    guarded("extras", failed, () => getDashboardExtras(ctx, archetype, opts)),
    can(archetype, "approvals.decide")
      ? guarded("approvals", failed, () => listInbox(ctx, archetype))
      : Promise.resolve(null),
    can(archetype, "ar.view")
      ? guarded("receivables", failed, () => computeAR(ctx, archetype, opts.asOf))
      : Promise.resolve(null),
    foreman ? guarded("field", failed, () => fieldQueues(ctx)) : Promise.resolve(null),
    can(archetype, "reports.review")
      ? guarded("reports", failed, async () => ({
          // The SAME service definitions the review page lists from (H18
          // count-to-record parity by construction).
          toReview: await countReviewQueue(ctx, archetype),
          missingToday: await countMissingToday(ctx, archetype, opts.asOf),
        }))
      : Promise.resolve(null),
    // H20: sales pipeline counts — same horizon the composer's "Next" section
    // uses, so every count drills to exactly its records.
    can(archetype, "opportunities.view")
      ? guarded("sales", failed, () =>
          salesDashboardCounts(ctx, archetype, {
            asOf: opts.asOf,
            horizonDays: opts.horizonDays ?? 7,
          }),
        )
      : Promise.resolve(null),
  ]);

  return {
    exceptions,
    extras,
    inbox,
    ar,
    myJobs: field?.myJobs ?? null,
    returnedReports: field?.returned ?? null,
    reviewQueue,
    sales,
    failed,
  };
}

/** The field user's own queues: assigned active jobs with last-report
 * freshness, and own reports returned for correction (same shape and scope
 * as the pre-H17 foreman screen; bounded). */
async function fieldQueues(ctx: Ctx) {
  return withCtx(ctx, async (tx) => {
    const myJobs = (await tx.execute(sql`
      select j.id::text as id, j.reference, j.name,
             (select max(r.report_date)::text from public.daily_report r
              where r.job_id = j.id and r.org_id = ${ctx.orgId}
                and r.status in ('submitted','reviewed')) as last_report
      from public.job j
      where j.org_id = ${ctx.orgId} and j.status_category = 'active' and j.archived = false
        and ${assignedJobCondition(ctx)}
      order by j.reference
      limit 100
    `)) as unknown as Array<{
      id: string;
      reference: string;
      name: string;
      last_report: string | null;
    }>;
    const returned = (await tx.execute(sql`
      select r.id::text as id, r.report_date::text as report_date, j.reference
      from public.daily_report r
      join public.job j on j.id = r.job_id
      where r.org_id = ${ctx.orgId} and r.submitted_by = ${ctx.userId} and r.status = 'returned'
      order by r.report_date desc limit 50
    `)) as unknown as Array<{ id: string; report_date: string; reference: string }>;
    return {
      myJobs: myJobs.map((j) => ({
        id: j.id,
        reference: j.reference,
        name: j.name,
        lastReport: j.last_report,
      })),
      returned: returned.map((r) => ({
        id: r.id,
        reference: r.reference,
        reportDate: r.report_date,
      })),
    };
  });
}
