import Link from "next/link";
import { Badge, Card, EmptyState } from "@/platform/ui";
import { cn } from "@/lib/cn";
import type { WorkRow, ScheduleItem } from "@/modules/jobs/service";
import type { Translator } from "@/platform/i18n/server";
import type { Locale } from "@/platform/registries";
import { formatDate } from "@/platform/format";

/**
 * H21 — the work hub's three presentations over ONE list of records: a list, a
 * board grouped by current phase, and a date-ordered schedule. They are views,
 * not separate data: the same server query and the same permissions feed all
 * three, so no view can show something another would hide.
 */

const STATUS_TONE: Record<string, "neutral" | "info" | "warning" | "success" | "danger"> = {
  draft: "neutral",
  active: "info",
  on_hold: "warning",
  done: "success",
  cancelled: "neutral",
};

const PRIORITY_TONE: Record<string, "neutral" | "info" | "warning" | "danger"> = {
  low: "neutral",
  normal: "neutral",
  high: "warning",
  urgent: "danger",
};

export type WorkViewsDict = {
  t: Translator;
  locale: Locale;
  orgId: string;
  asOf: string;
  statusLabels: Record<string, string>;
  jobsTerm: string;
};

export function WorkRowItem({
  row,
  d,
  showProgress,
}: {
  row: WorkRow;
  d: WorkViewsDict;
  showProgress?: boolean;
}) {
  const { t, locale, orgId, asOf } = d;
  const overdue =
    row.dueDate !== null &&
    row.dueDate < asOf &&
    ["draft", "active", "on_hold"].includes(row.statusCategory);
  return (
    <Link
      href={`/o/${orgId}/jobs/${row.id}`}
      className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2.5 hover:bg-sunken"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">
          {row.reference} · {row.name}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-secondary">
          {row.customerName ? <span className="truncate">{row.customerName}</span> : null}
          {row.currentStageName ? (
            <span>{locale === "ar" ? row.currentStageName.ar : row.currentStageName.en}</span>
          ) : null}
          {row.openTasks > 0 ? (
            <span>{t("work.tasks_summary", { count: row.openTasks })}</span>
          ) : null}
          {row.blockedTasks > 0 ? (
            <span className="text-warning">
              {t("work.tasks_blocked", { count: row.blockedTasks })}
            </span>
          ) : null}
          {row.overdueTasks > 0 ? (
            <span className="text-warning">
              {t("work.tasks_overdue", { count: row.overdueTasks })}
            </span>
          ) : null}
        </span>
      </span>
      {row.priority !== "normal" && row.priority !== "low" ? (
        <Badge tone={PRIORITY_TONE[row.priority] ?? "neutral"}>
          {t(`work.priority.${row.priority}`)}
        </Badge>
      ) : null}
      {row.dueDate ? (
        <span
          className={cn("text-xs", overdue ? "font-medium text-danger" : "text-ink-secondary")}
          dir="ltr"
        >
          {formatDate(row.dueDate, { locale })}
        </span>
      ) : null}
      <Badge tone={STATUS_TONE[row.statusCategory] ?? "neutral"}>
        {d.statusLabels[row.statusKey] ?? row.statusKey}
      </Badge>
      {showProgress === false ? null : null}
    </Link>
  );
}

export function WorkList({
  rows,
  d,
  emptyTitle,
  emptyHint,
}: {
  rows: WorkRow[];
  d: WorkViewsDict;
  emptyTitle: string;
  emptyHint?: string;
}) {
  if (rows.length === 0) return <EmptyState title={emptyTitle} description={emptyHint} />;
  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => (
        <li key={row.id}>
          <WorkRowItem row={row} d={d} />
        </li>
      ))}
    </ul>
  );
}

/** Grouped by the work's CURRENT phase — the snapshot on each record, so a
 * blueprint change never reshuffles work that already exists. */
export function WorkBoard({ rows, d }: { rows: WorkRow[]; d: WorkViewsDict }) {
  const { t, locale } = d;
  const groups = new Map<string, { label: string; rows: WorkRow[] }>();
  for (const row of rows) {
    const label = row.currentStageName
      ? locale === "ar"
        ? row.currentStageName.ar
        : row.currentStageName.en
      : t("work.board.no_stage");
    const existing = groups.get(label);
    if (existing) existing.rows.push(row);
    else groups.set(label, { label, rows: [row] });
  }
  const columns = [...groups.values()];
  if (columns.length === 0) {
    return <EmptyState title={t("work.empty.title")} description={t("work.empty.hint")} />;
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {columns.map((col) => (
        <section key={col.label} aria-label={col.label}>
          <Card className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">{col.label}</h2>
              <span className="text-xs text-ink-secondary">{col.rows.length}</span>
            </div>
            {col.rows.length === 0 ? (
              <p className="text-xs text-ink-secondary">{t("work.board.empty")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {col.rows.map((row) => (
                  <li
                    key={row.id}
                    className="rounded-lg border border-line bg-card px-1 hover:bg-sunken"
                  >
                    <WorkRowItem row={row} d={d} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      ))}
    </div>
  );
}

/**
 * Date-ordered work and steps. Dates here are calendar deadlines in the
 * organization's own timezone, not exact-time events — the copy says "due", it
 * never implies a clock time the product does not hold.
 */
export function WorkSchedule({
  items,
  unscheduled,
  d,
}: {
  items: ScheduleItem[];
  unscheduled: ScheduleItem[];
  d: WorkViewsDict;
}) {
  const { t, locale, orgId } = d;
  const byDate = new Map<string, ScheduleItem[]>();
  for (const item of items) {
    const key = item.dueDate ?? item.startDate ?? "";
    if (!key) continue;
    const list = byDate.get(key);
    if (list) list.push(item);
    else byDate.set(key, [item]);
  }
  const days = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <div className="flex flex-col gap-4">
      {days.length === 0 ? (
        <Card>
          <EmptyState title={t("work.schedule.empty")} />
        </Card>
      ) : (
        days.map(([date, dayItems]) => (
          <Card key={date}>
            <h2 className="mb-2 text-sm font-semibold text-ink" dir="ltr">
              {formatDate(date, { locale })}
            </h2>
            <ul className="flex flex-col gap-2">
              {dayItems.map((item) => (
                <li key={`${item.kind}-${item.id}`}>
                  <Link
                    href={`/o/${orgId}/jobs/${item.jobId}${item.kind === "task" ? "?tab=tasks" : ""}`}
                    className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-card px-3 py-2 text-sm hover:bg-sunken"
                  >
                    <Badge tone={item.kind === "work" ? "info" : "neutral"}>
                      {item.kind === "work"
                        ? t("nav.item.jobs", { jobs: d.jobsTerm })
                        : t("tasks.title")}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-ink">{item.title}</span>
                    {item.assigneeName ? (
                      <span className="text-xs text-ink-secondary">{item.assigneeName}</span>
                    ) : null}
                    {item.overdue ? <Badge tone="danger">{t("work.filter.overdue")}</Badge> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
      {unscheduled.length > 0 ? (
        <Card>
          <h2 className="text-sm font-semibold text-ink">{t("work.schedule.unscheduled")}</h2>
          <p className="mb-2 text-xs text-ink-secondary">{t("work.schedule.unscheduled_hint")}</p>
          <ul className="flex flex-col gap-2">
            {unscheduled.slice(0, 50).map((item) => (
              <li key={`${item.kind}-${item.id}`}>
                <Link
                  href={`/o/${orgId}/jobs/${item.jobId}${item.kind === "task" ? "?tab=tasks" : ""}`}
                  className="flex min-h-11 items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm hover:bg-sunken"
                >
                  <Badge tone="neutral">
                    {item.kind === "work"
                      ? t("nav.item.jobs", { jobs: d.jobsTerm })
                      : t("tasks.title")}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-ink">{item.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
