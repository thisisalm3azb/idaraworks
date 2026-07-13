import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { getReportDetail } from "@/modules/reports/service";
import { formatDate } from "@/platform/format";
import { reviewReportAction, returnReportAction } from "../actions";

const STATUS_TONE = {
  draft: "neutral",
  submitted: "info",
  reviewed: "success",
  returned: "warning",
} as const;

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; reportId: string }>;
}) {
  const { orgId, reportId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const a = resolved.archetype;

  const report = await getReportDetail(resolved.ctx, a, reportId);
  if (!report) notFound();

  const canReview = can(a, "reports.review") && report.status === "submitted";
  const review = reviewReportAction.bind(null, orgId);
  const returnAction = returnReportAction.bind(null, orgId);
  const showCost = report.labourLines.some((l) => l.labourCostMinor !== null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <Link href={`/o/${orgId}/jobs/${report.jobId}`} className="text-sm text-ink-secondary">
          ← {formatDate(report.reportDate, { locale })}
        </Link>
        <Badge tone={STATUS_TONE[report.status as keyof typeof STATUS_TONE] ?? "neutral"}>
          {t(`reports.status.${report.status}`)}
        </Badge>
      </div>

      {report.status === "returned" && report.returnReason ? (
        <Card>
          <p className="text-sm font-medium text-ink">{t("reports.detail.return_reason")}</p>
          <p className="text-sm text-ink-secondary">{report.returnReason}</p>
          {report.isAuthor ? (
            <Link
              href={`/o/${orgId}/reports/new?job=${report.jobId}&date=${report.reportDate}`}
              className="mt-3 inline-flex min-h-11 items-center rounded-md bg-brand px-4 text-sm text-ink-inverse"
            >
              {t("reports.detail.edit_resubmit")}
            </Link>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardHeader title={t("reports.section.summary")} />
        <p className="whitespace-pre-line text-sm text-ink">{report.summary}</p>
        {report.blockers ? (
          <>
            <p className="mt-3 text-sm font-medium text-ink">{t("reports.section.blockers")}</p>
            <p className="whitespace-pre-line text-sm text-ink-secondary">{report.blockers}</p>
          </>
        ) : null}
        <p className="mt-3 text-xs text-ink-muted">
          {t("reports.detail.submitted_by")}: {report.submittedByName ?? "—"}
          {report.reviewedByName
            ? ` · ${t("reports.detail.reviewed_by")}: ${report.reviewedByName}`
            : ""}
        </p>
      </Card>

      {report.workLines.length > 0 ? (
        <Card>
          <CardHeader title={t("reports.section.work")} />
          <ul className="divide-y divide-line">
            {report.workLines.map((w) => (
              <li key={w.id} className="py-2 text-sm text-ink">
                {w.stageKey ? <span className="text-ink-muted">{w.stageKey}: </span> : null}
                {w.description}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {report.labourLines.length > 0 ? (
        <Card>
          <CardHeader title={t("reports.section.labour")} />
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-ink-muted">
                <th className="py-1 text-start font-normal">{t("reports.detail.submitted_by")}</th>
                <th className="py-1 text-end font-normal">{t("reports.detail.hours")}</th>
                <th className="py-1 text-end font-normal">{t("reports.detail.overtime")}</th>
                {showCost ? (
                  <th className="py-1 text-end font-normal">{t("reports.detail.labour_cost")}</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {report.labourLines.map((l) => (
                <tr key={l.employeeId} className="border-t border-line">
                  <td className="py-1.5 text-ink">{l.employeeName ?? "—"}</td>
                  <td className="py-1.5 text-end text-ink">{l.normalHours}</td>
                  <td className="py-1.5 text-end text-ink">{l.otHours}</td>
                  {showCost ? (
                    <td className="py-1.5 text-end text-ink">{l.labourCostMinor ?? "—"}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {report.materialLines.length > 0 ? (
        <Card>
          <CardHeader title={t("reports.section.materials")} />
          <ul className="divide-y divide-line">
            {report.materialLines.map((m) => (
              <li key={m.id} className="flex items-center justify-between py-2 text-sm text-ink">
                <span>{m.itemName}</span>
                <span className="text-ink-secondary">
                  {m.qty} {m.unit}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {canReview ? (
        <Card>
          <CardHeader title={t("reports.review.title")} />
          <form action={review} className="mb-3">
            <input type="hidden" name="report_id" value={report.id} />
            <Button type="submit" size="lg" className="w-full">
              {t("reports.review.approve")}
            </Button>
          </form>
          <form action={returnAction} className="flex flex-col gap-2">
            <input type="hidden" name="report_id" value={report.id} />
            <input
              name="reason"
              required
              maxLength={2000}
              placeholder={t("reports.review.return_reason")}
              className="min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            />
            <Button type="submit" variant="secondary">
              {t("reports.review.return")}
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
