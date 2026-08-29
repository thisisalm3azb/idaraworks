import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState, FilterBar } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listJobsMissingToday, listReviewQueue } from "@/modules/reports/service";
import { orgToday, parseReviewSearch, reviewHref } from "@/modules/dashboard/service";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { formatDate } from "@/platform/format";

/**
 * H18 — the review destination now represents BOTH dashboard signals with
 * the exact records behind their counts: the default queue view lists
 * submitted reports awaiting review (manager scoped to assigned jobs, the
 * same rule as the dashboard count), and ?focus=missing lists the active
 * jobs with no report yet for the ORG's current day.
 */
export default async function ReviewQueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; focus?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { ok } = sp;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "reports.review")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const vars = {
    job: term("job", terms, "singular"),
    jobs: term("job", terms, "plural"),
    daily_report: term("daily_report", terms, "singular"),
    daily_reports: term("daily_report", terms, "plural"),
  };
  const { focus } = parseReviewSearch(sp);
  const asOf = orgToday(new Date(), resolved.timezone);
  const missing =
    focus === "missing" ? await listJobsMissingToday(resolved.ctx, resolved.archetype, asOf) : null;
  const queue = focus === "queue" ? await listReviewQueue(resolved.ctx, resolved.archetype) : null;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">
        {focus === "missing"
          ? t("filters.review.missing_title", vars)
          : t("reports.review.title", vars)}
      </h1>
      {focus === "missing" ? (
        <FilterBar
          summary={t("filters.review.missing_summary", vars)}
          countLabel={t("filters.count", { count: missing?.length ?? 0 })}
          clearHref={reviewHref(orgId)}
          clearLabel={t("filters.review.show_queue", vars)}
        />
      ) : null}
      {ok === "reviewed" ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {t("reports.review.reviewed_notice")}
        </p>
      ) : null}
      {ok === "returned" ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-ink">
          {t("reports.review.returned_notice")}
        </p>
      ) : null}

      {focus === "missing" ? (
        (missing?.length ?? 0) === 0 ? (
          <EmptyState title={t("filters.empty")} description={t("filters.empty_hint")} />
        ) : (
          <ul className="flex flex-col gap-2">
            {missing!.map((m) => (
              <li key={m.jobId}>
                <Link
                  href={`/o/${orgId}/jobs/${m.jobId}`}
                  className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-line bg-card p-4 hover:bg-sunken"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink">
                      {m.reference} {m.name}
                    </span>
                    <span className="block text-xs text-ink-muted">
                      {m.lastReport
                        ? t("filters.review.last_report", {
                            ...vars,
                            date: formatDate(m.lastReport, { locale }),
                          })
                        : t("dashboard.no_report_yet")}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : (queue?.length ?? 0) === 0 ? (
        <EmptyState title={t("reports.review.queue_empty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {queue!.map((r) => (
            <li key={r.id}>
              <Link
                href={`/o/${orgId}/reports/${r.id}`}
                className="block rounded-md border border-line bg-card p-4 hover:bg-sunken"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">{r.jobReference ?? "—"}</span>
                  <span className="text-sm text-ink-secondary">
                    {formatDate(r.reportDate, { locale })}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-ink-secondary">{r.summary}</p>
                <p className="mt-1 text-xs text-ink-muted">{r.submittedByName ?? "—"}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
