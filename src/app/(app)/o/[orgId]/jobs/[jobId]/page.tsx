import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState, Field } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import { getJob, getJobStatusLabels } from "@/modules/jobs/service";
import { listJobReports } from "@/modules/reports/service";
import { formatDate } from "@/platform/format";
import { submitReportAction } from "../actions";

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; jobId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { orgId, jobId } = await params;
  const { error, notice } = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const reportTerm = term("daily_report", terms, "singular");
  const reportsTerm = term("daily_report", terms, "plural");

  const job = await getJob(resolved.ctx, resolved.archetype, jobId);
  if (!job) notFound();
  const statusLabels = await getJobStatusLabels(resolved.ctx, locale);
  const reports = await listJobReports(resolved.ctx, resolved.archetype, jobId);
  const canReport = can(resolved.archetype, "reports.create");
  const submitWithOrg = submitReportAction.bind(null, orgId);
  // The Gulf workday, not the UTC day (review minor): between midnight and
  // ~4am UAE the UTC date is still "yesterday". en-CA gives YYYY-MM-DD.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={`${job.reference} — ${job.name}`}
          meta={
            <Badge tone={job.statusCategory === "active" ? "info" : "neutral"}>
              {statusLabels[job.statusKey] ?? job.statusKey}
            </Badge>
          }
        />
        <p className="text-sm text-ink-secondary">
          {job.presetCode ?? ""} {job.customerName ? `· ${job.customerName}` : ""}
        </p>
      </Card>

      {canReport ? (
        <Card>
          <CardHeader title={t("reports.form.title", { daily_report: reportTerm })} />
          {notice === "submitted" ? (
            <p className="mb-3 rounded-md bg-success-soft p-3 text-sm text-success">
              {t("reports.notice.submitted")}
            </p>
          ) : null}
          {error === "duplicate" ? (
            <p className="mb-3 rounded-md bg-warning-soft p-3 text-sm text-warning">
              {t("reports.duplicate", { daily_report: reportTerm })}
            </p>
          ) : error ? (
            <p className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
              {t("common.error")}
            </p>
          ) : null}
          <form action={submitWithOrg} className="flex flex-col gap-4">
            <input type="hidden" name="job_id" value={jobId} />
            <Field
              label={t("common.date")}
              name="report_date"
              type="date"
              defaultValue={today}
              required
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="summary" className="text-sm font-medium text-ink">
                {t("reports.form.summary")}
              </label>
              <textarea
                id="summary"
                name="summary"
                required
                rows={3}
                maxLength={2000}
                className="rounded-md border border-line-strong bg-card px-3 py-2 text-base text-ink"
              />
            </div>
            <Field label={t("reports.form.blockers")} name="blockers" />
            <Field label={t("reports.form.next_steps")} name="next_steps" />
            <Button type="submit">{t("reports.form.cta")}</Button>
          </form>
        </Card>
      ) : null}

      <Card>
        <CardHeader title={t("reports.title", { daily_reports: reportsTerm })} />
        {reports.length === 0 ? (
          <EmptyState title={t("reports.empty", { daily_reports: reportsTerm })} />
        ) : (
          <ul className="divide-y divide-line">
            {reports.map((r) => (
              <li key={r.id} className="py-3">
                <p className="text-xs text-ink-muted">
                  {formatDate(r.reportDate, { locale })} · {r.submittedByName ?? ""}
                </p>
                <p className="text-sm text-ink">{r.summary}</p>
                {r.blockers ? <p className="mt-1 text-xs text-warning">⚠ {r.blockers}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
