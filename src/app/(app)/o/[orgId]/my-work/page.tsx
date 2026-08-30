import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import { cn } from "@/lib/cn";
import { formatDate } from "@/platform/format";
import { getMyWork, type MyTask } from "@/modules/jobs/service";
import { myWorkHref, orgToday, parseMyWorkSearch } from "@/modules/dashboard/service";
import { myWorkStatusAction } from "./actions";

/**
 * H21 Part L — one person's execution view.
 *
 * Everything here is already reachable by this user: tasks assigned to their
 * own staff record, and work they are assigned to through the same resolver the
 * rest of the app uses. Every count is a link to exactly the records behind it.
 * The language stays factual: what is late, what is blocked, what is next —
 * never a score, never encouragement, never a judgement about the person.
 */
export default async function MyWorkPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ focus?: string; ok?: string; error?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "jobs.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const jobsTerm = term("job", terms, "plural");
  const { focus } = parseMyWorkSearch(sp);
  const asOf = orgToday(new Date(), resolved.timezone);

  const view = await getMyWork(resolved.ctx, resolved.archetype, { asOf });
  const canUpdate = can(resolved.archetype, "tasks.update_status");
  const setStatus = myWorkStatusAction.bind(null, orgId);

  const sections: Array<{ key: string; rows: MyTask[] }> = [
    { key: "overdue", rows: view.overdueTasks },
    { key: "today", rows: view.dueTodayTasks },
    { key: "blocked", rows: view.blockedTasks },
    { key: "approvals", rows: view.awaitingApproval },
    { key: "next", rows: view.upcomingTasks },
  ];
  const counts: Record<string, number> = Object.fromEntries(
    sections.map((s) => [s.key, s.rows.length]),
  );
  const needsAttention = (counts.overdue ?? 0) + (counts.today ?? 0) + (counts.blocked ?? 0);
  const visible =
    focus === "now"
      ? sections.filter((s) => s.rows.length > 0)
      : sections.filter((s) => s.key === focus);

  const taskRow = (task: MyTask) => {
    const overdue = task.dueDate !== null && task.dueDate < asOf;
    return (
      <li
        key={task.id}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-card px-3 py-2.5 text-sm"
      >
        <Link
          href={`/o/${orgId}/jobs/${task.jobId}?tab=tasks`}
          className="min-w-0 flex-1 truncate font-medium text-ink hover:underline"
        >
          {task.title}
        </Link>
        <span className="text-xs text-ink-secondary">{task.jobReference}</span>
        <Badge
          tone={
            task.status === "blocked"
              ? "warning"
              : task.status === "awaiting_approval"
                ? "info"
                : "neutral"
          }
        >
          {t(`tasks.status.${task.status}`)}
        </Badge>
        {task.blockers > 0 ? (
          <span className="text-xs text-warning">
            {t("tasks.blocked_by", { count: task.blockers })}
          </span>
        ) : null}
        {task.blockedReason ? (
          <span className="min-w-0 basis-full truncate text-xs text-ink-secondary">
            {task.blockedReason}
          </span>
        ) : null}
        {task.dueDate ? (
          <span
            className={cn("text-xs", overdue ? "font-medium text-danger" : "text-ink-secondary")}
            dir="ltr"
          >
            {formatDate(task.dueDate, { locale })}
          </span>
        ) : null}
        {canUpdate && task.status !== "awaiting_approval" ? (
          <form action={setStatus} className="flex items-center gap-2">
            <input type="hidden" name="task_id" value={task.id} />
            <label className="sr-only" htmlFor={`st-${task.id}`}>
              {t("tasks.move_to")}
            </label>
            <select
              id={`st-${task.id}`}
              name="status"
              defaultValue={task.status}
              className="min-h-11 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
            >
              {(["pending", "ready", "in_progress", "completed"] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`tasks.status.${s}`)}
                </option>
              ))}
            </select>
            <Button type="submit" variant="ghost">
              {t("tasks.apply")}
            </Button>
          </form>
        ) : null}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("my_work.title")} meta={t("my_work.subtitle")} />
        {sp.error ? (
          <p role="alert" className="mb-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {t("common.action_failed")}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("my_work.title")}>
          {(["now", "overdue", "today", "blocked", "approvals", "next"] as const).map((k) => (
            <Link
              key={k}
              href={myWorkHref(orgId, k)}
              aria-current={focus === k ? "true" : undefined}
              className={cn(
                "inline-flex min-h-9 items-center gap-2 rounded-full border px-3 text-xs font-medium",
                focus === k
                  ? "border-ink bg-ink text-card"
                  : "border-line bg-card text-ink-secondary",
              )}
            >
              {t(`my_work.focus.${k}`)}
              {k !== "now" && counts[k] ? (
                <span dir="ltr" className="font-mono">
                  {counts[k]}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      </Card>

      {view.employeeId === null ? (
        <Card>
          <p className="text-sm text-ink-secondary">{t("my_work.no_employee")}</p>
        </Card>
      ) : null}

      {focus === "now" && needsAttention === 0 && counts.approvals === 0 ? (
        <Card>
          <EmptyState title={t("my_work.empty.now")} />
        </Card>
      ) : null}

      {visible.map((section) =>
        section.rows.length === 0 ? (
          <Card key={section.key}>
            <CardHeader title={t(`my_work.focus.${section.key}`)} />
            <p className="text-sm text-ink-secondary">{t("my_work.empty.section")}</p>
          </Card>
        ) : (
          <Card key={section.key}>
            <CardHeader
              title={t(`my_work.focus.${section.key}`)}
              meta={<span dir="ltr">{section.rows.length}</span>}
            />
            <ul className="flex flex-col gap-2">{section.rows.map(taskRow)}</ul>
          </Card>
        ),
      )}

      {view.myWork.length > 0 ? (
        <Card>
          <CardHeader title={t("my_work.my_jobs", { jobs: jobsTerm })} />
          <ul className="divide-y divide-line">
            {view.myWork.slice(0, 10).map((w) => (
              <li key={w.id}>
                <Link
                  href={`/o/${orgId}/jobs/${w.id}`}
                  className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2 text-sm hover:bg-sunken"
                >
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">
                    {w.reference} · {w.name}
                  </span>
                  {w.dueDate ? (
                    <span
                      className={cn(
                        "text-xs",
                        w.dueDate < asOf ? "font-medium text-danger" : "text-ink-secondary",
                      )}
                      dir="ltr"
                    >
                      {formatDate(w.dueDate, { locale })}
                    </span>
                  ) : null}
                  {w.openTasks > 0 ? (
                    <span className="text-xs text-ink-secondary">
                      {t("work.tasks_summary", { count: w.openTasks })}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {view.recentActivity.length > 0 ? (
        <Card>
          <CardHeader title={t("my_work.recent")} />
          <ul className="flex flex-col gap-1 text-sm">
            {view.recentActivity.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
                <span className="min-w-0 flex-1 truncate text-ink">{a.summary}</span>
                <span className="text-xs text-ink-secondary" dir="ltr">
                  {formatDate(a.at, { locale })}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
