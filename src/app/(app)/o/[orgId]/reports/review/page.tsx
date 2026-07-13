import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { listReviewQueue } from "@/modules/reports/service";
import { formatDate } from "@/platform/format";

export default async function ReviewQueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId } = await params;
  const { ok } = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "reports.review")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const queue = await listReviewQueue(resolved.ctx, resolved.archetype);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("reports.review.title")}</h1>
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
      {queue.length === 0 ? (
        <EmptyState title={t("reports.review.queue_empty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {queue.map((r) => (
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
