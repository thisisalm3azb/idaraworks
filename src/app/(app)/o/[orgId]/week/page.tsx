import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Card, CardHeader, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { getWeekView } from "@/modules/jobs/service";
import { formatDate } from "@/platform/format";

/** Monday of the week containing `iso` (org working weeks vary; Monday is the
 * neutral anchor for the derived view — F-15: nothing is stored). */
function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function WeekPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ start?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(sp.start ?? "")
    ? mondayOf(sp.start!)
    : mondayOf(today);
  const view = await getWeekView(resolved.ctx, resolved.archetype, { weekStart });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={t("week.title", { date: formatDate(weekStart, { locale }) })}
          meta={
            <span className="flex gap-2 text-sm">
              <Link
                href={`/o/${orgId}/week?start=${addDays(weekStart, -7)}`}
                className="text-ink-secondary"
              >
                {t("week.prev")}
              </Link>
              <Link
                href={`/o/${orgId}/week?start=${addDays(weekStart, 7)}`}
                className="text-ink-secondary"
              >
                {t("week.next")}
              </Link>
            </span>
          }
        />
        {view.jobs.length === 0 ? (
          <EmptyState title={t("week.empty")} />
        ) : (
          <ul className="divide-y divide-line">
            {view.jobs.map((j) => (
              <li key={j.id} className="py-3">
                <Link href={`/o/${orgId}/jobs/${j.id}`} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-ink">
                      {j.reference} — {j.name}
                    </p>
                    <span className="flex items-center gap-1">
                      {j.overdue ? <Badge tone="danger">{t("week.overdue")}</Badge> : null}
                      {j.dueThisWeek && !j.overdue ? (
                        <Badge tone="warning">{t("week.due_this_week")}</Badge>
                      ) : null}
                    </span>
                  </div>
                  <p className="text-xs text-ink-muted">
                    {j.currentStage
                      ? locale === "ar"
                        ? j.currentStage.ar
                        : j.currentStage.en
                      : ""}
                    {j.progress !== null ? ` · ${j.progress}%` : ""}
                    {j.dueDate ? ` · ${t("jobs.due")}: ${formatDate(j.dueDate, { locale })}` : ""}
                  </p>
                  {j.crew.length > 0 ? (
                    <p className="text-xs text-ink-secondary">{j.crew.join("، ")}</p>
                  ) : null}
                  {j.tasksDue.length > 0 ? (
                    <p className="text-xs text-warning">
                      {t("week.tasks_due", { tasks: term("task", terms, "plural") })}:{" "}
                      {j.tasksDue.map((task) => task.title).join(" · ")}
                    </p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
