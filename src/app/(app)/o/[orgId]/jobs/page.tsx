import { redirect } from "next/navigation";
import Link from "next/link";
import { Badge, Button, Card, CardHeader, Field, FilterBar } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import {
  getJobStatusLabels,
  listActivePresets,
  listAssignableMembers,
  listJobs,
  listWork,
  getSchedule,
  getWorkload,
} from "@/modules/jobs/service";
import { getCustomer, listCustomers } from "@/modules/masters/service";
import { createJobAction } from "./actions";
import {
  jobIsDueSoon,
  jobIsOverdue,
  jobsHref,
  orgToday,
  parseJobsSearch,
  parseWorkSearch,
  workHref,
  WORK_CATEGORY_FILTERS,
} from "@/modules/dashboard/service";
import { cn } from "@/lib/cn";
import { WorkList, WorkBoard, WorkSchedule, type WorkViewsDict } from "./WorkViews";

export default async function JobsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{
    error?: string;
    stage?: string;
    filter?: string;
    days?: string;
    scope?: string;
    customer?: string;
    // H21 work hub.
    view?: string;
    q?: string;
    category?: string;
    priority?: string;
    origin?: string;
    owner?: string;
    assignee?: string;
    unowned?: string;
    open?: string;
    from?: string;
    to?: string;
    focus?: string;
  }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { error, customer } = sp;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const jobTerm = term("job", terms, "singular");
  const jobsTerm = term("job", terms, "plural");

  // H18/H19 canonical filter contract: server-validated params, the SAME
  // inclusion rules and ORG-timezone day boundary the dashboard uses,
  // scope=mine via the aggregate's assignment resolver, and ?customer=
  // narrowing SQL-side (H19: the param now FILTERS the list and still
  // preselects the create form below). A foreign or unknown customer id
  // yields the same honest empty list as any random uuid.
  const f = parseJobsSearch(sp);
  const allJobs = await listJobs(resolved.ctx, resolved.archetype, {
    assignedOnly: f.scope === "mine",
    customerId: f.customerId ?? undefined,
  });
  const filterCustomer = f.customerId
    ? await getCustomer(resolved.ctx, resolved.archetype, f.customerId).catch(() => null)
    : null;
  const asOf = orgToday(new Date(), resolved.timezone);
  const jobs = allJobs.filter((j) => {
    if (f.stage && j.currentStageKey !== f.stage) return false;
    if (f.filter === "overdue") return jobIsOverdue(j, asOf);
    if (f.filter === "due_soon") return jobIsDueSoon(j, asOf, f.days ?? 7);
    return true;
  });

  // H21 — the work hub reads over the SAME records with richer rollups. The
  // H18 drill-down params keep working by mapping onto the work filters, so a
  // dashboard link lands on exactly the records it counted.
  const w = parseWorkSearch(sp);
  const workRows = await listWork(resolved.ctx, resolved.archetype, {
    q: w.q ?? undefined,
    category: w.category ?? undefined,
    // The parser already whitelisted these against the same closed vocabularies.
    priority: (w.priority as ("low" | "normal" | "high" | "urgent")[] | null) ?? undefined,
    unowned: w.unowned || undefined,
    openOnly: w.open || undefined,
    origin: (w.origin as "quotation" | "opportunity" | "direct" | null) ?? undefined,
    stageKey: w.stage ?? f.stage ?? undefined,
    ownerUserId: w.owner ?? undefined,
    assigneeEmployeeId: w.assignee ?? undefined,
    customerId: f.customerId ?? undefined,
    dueFrom: w.dueFrom ?? undefined,
    dueTo:
      w.dueTo ??
      (f.filter === "due_soon"
        ? new Date(Date.parse(`${asOf}T00:00:00Z`) + (f.days ?? 7) * 86_400_000)
            .toISOString()
            .slice(0, 10)
        : undefined),
    overdue: w.overdue || f.filter === "overdue" ? asOf : undefined,
    archived: w.archived,
    scope: w.scope ?? f.scope ?? undefined,
  });
  const schedule =
    w.view === "schedule"
      ? await getSchedule(resolved.ctx, resolved.archetype, {
          from: asOf,
          to: new Date(Date.parse(`${asOf}T00:00:00Z`) + 60 * 86_400_000)
            .toISOString()
            .slice(0, 10),
          asOf,
          scope: w.scope ?? undefined,
        })
      : null;
  // Scheduled load per person (Part G). Behind progressive disclosure so the hub
  // stays a list of work rather than a wall of panels, and only for roles that
  // may see people at all.
  const workload = can(resolved.archetype, "employees.view")
    ? await getWorkload(resolved.ctx, resolved.archetype, asOf)
    : [];
  // "High" is stated RELATIVE TO THIS TEAM, never as a capacity verdict: the
  // product does not know anyone's working hours. Twice the team average, and
  // only once there is a team to average over.
  const loadMean =
    workload.length > 0 ? workload.reduce((s, r) => s + r.openTasks, 0) / workload.length : 0;
  const highLoad = (openTasks: number) =>
    workload.length >= 3 && openTasks > 0 && openTasks >= 2 * loadMean;

  const filtered =
    f.filter !== null || f.stage !== null || f.scope !== null || f.customerId !== null;
  const filterSummary = !filtered
    ? null
    : [
        f.filter === "overdue"
          ? t("filters.jobs.overdue", { jobs: jobsTerm })
          : f.filter === "due_soon"
            ? t("filters.jobs.due_soon", { jobs: jobsTerm, days: f.days ?? 7 })
            : null,
        f.stage ? t("filters.jobs.stage") : null,
        f.scope === "mine" ? t("filters.scope_mine") : null,
        f.customerId
          ? filterCustomer
            ? t("filters.customer", { name: filterCustomer.name })
            : t("filters.customer_generic", { customer: term("customer", terms, "singular") })
          : null,
      ]
        .filter(Boolean)
        .join(locale === "ar" ? "، " : " · ");
  const statusLabels = await getJobStatusLabels(resolved.ctx, locale);
  const viewsDict: WorkViewsDict = { t, locale, orgId, asOf, statusLabels, jobsTerm };
  const canCreate = can(resolved.archetype, "jobs.create");
  const presets = canCreate ? await listActivePresets(resolved.ctx, resolved.archetype) : [];
  const members = canCreate ? await listAssignableMembers(resolved.ctx, resolved.archetype) : [];
  const customers = can(resolved.archetype, "customers.view")
    ? await listCustomers(resolved.ctx, resolved.archetype)
    : [];
  const createWithOrg = createJobAction.bind(null, orgId);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("jobs.title", { jobs: jobsTerm })} />
        {filtered && filterSummary ? (
          <FilterBar
            summary={filterSummary}
            countLabel={t("filters.count", { count: jobs.length })}
            clearHref={jobsHref(orgId)}
            clearLabel={t("jobs.filter_clear")}
          />
        ) : null}
        {error === "limit" ? (
          <p className="mb-3 rounded-md bg-warning-soft p-3 text-sm text-warning">
            {t("jobs.limit_reached", { job: jobTerm, jobs: jobsTerm })}
          </p>
        ) : error ? (
          <p className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
            {t("common.error")}
          </p>
        ) : null}
        {/* H21 — search, view toggle and filter chips, all URL-backed. */}
        <form method="get" className="mt-3 flex flex-wrap items-end gap-2" role="search">
          {w.category ? <input type="hidden" name="category" value={w.category} /> : null}
          {w.view !== "list" ? <input type="hidden" name="view" value={w.view} /> : null}
          <div className="min-w-48 flex-1">
            <Field label={t("common.search")} name="q" defaultValue={w.q ?? ""} maxLength={120} />
          </div>
          <Button type="submit" variant="secondary">
            {t("common.search")}
          </Button>
        </form>
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={t("work.filter.label")}>
          {(["list", "board", "schedule"] as const).map((v) => (
            <Link
              key={v}
              href={workHref(orgId, { ...w, view: v })}
              aria-current={w.view === v ? "true" : undefined}
              className={cn(
                "inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium",
                w.view === v
                  ? "border-ink bg-ink text-card"
                  : "border-line bg-card text-ink-secondary",
              )}
            >
              {t(`work.view.${v}`)}
            </Link>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={t("work.filter.label")}>
          {[
            { key: null as string | null, label: t("work.filter.all") },
            ...WORK_CATEGORY_FILTERS.map((c) => ({ key: c, label: t(`work.category.${c}`) })),
          ].map((chip) => (
            <Link
              key={chip.key ?? "all"}
              href={workHref(orgId, { ...w, category: chip.key, overdue: false, archived: false })}
              aria-current={
                w.category === chip.key && !w.overdue && !w.archived ? "true" : undefined
              }
              className={cn(
                "inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium",
                w.category === chip.key && !w.overdue && !w.archived
                  ? "border-ink bg-ink text-card"
                  : "border-line bg-card text-ink-secondary",
              )}
            >
              {chip.label}
            </Link>
          ))}
          <Link
            href={workHref(orgId, { ...w, category: null, overdue: true, archived: false })}
            aria-current={w.overdue ? "true" : undefined}
            className={cn(
              "inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium",
              w.overdue ? "border-ink bg-ink text-card" : "border-line bg-card text-ink-secondary",
            )}
          >
            {t("work.filter.overdue")}
          </Link>
          <Link
            href={workHref(orgId, { ...w, category: null, overdue: false, archived: true })}
            aria-current={w.archived ? "true" : undefined}
            className={cn(
              "inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium",
              w.archived ? "border-ink bg-ink text-card" : "border-line bg-card text-ink-secondary",
            )}
          >
            {t("work.filter.archived")}
          </Link>
        </div>
      </Card>

      {w.view === "board" ? (
        <WorkBoard rows={workRows} d={viewsDict} />
      ) : w.view === "schedule" && schedule ? (
        <WorkSchedule items={schedule.items} unscheduled={schedule.unscheduled} d={viewsDict} />
      ) : (
        <Card>
          <WorkList
            rows={workRows}
            d={viewsDict}
            emptyTitle={filtered ? t("filters.empty") : t("work.empty.title")}
            emptyHint={filtered ? t("filters.empty_hint") : t("work.empty.hint")}
          />
        </Card>
      )}

      {workload.length > 0 ? (
        <Card>
          <details>
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-ink">
              {t("work.workload.title")}
            </summary>
            <p className="mt-2 text-xs text-ink-muted">{t("work.workload.hint")}</p>
            <ul className="mt-3 divide-y divide-line">
              {workload.map((r) => (
                <li key={r.employeeId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="min-w-32 flex-1 text-sm text-ink">{r.name}</span>
                  <span className="text-xs text-ink-secondary">
                    {t("work.workload.open_tasks")}: {r.openTasks}
                  </span>
                  <span className="text-xs text-ink-secondary">
                    {t("work.workload.assigned_work")}: {r.assignedWork}
                  </span>
                  {highLoad(r.openTasks) ? (
                    <Badge tone="warning">{t("work.workload.high_load")}</Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        </Card>
      ) : null}

      {canCreate && presets.length > 0 ? (
        <Card>
          <CardHeader title={t("jobs.new.title", { job: jobTerm })} />
          <form action={createWithOrg} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="preset_id" className="text-sm font-medium text-ink">
                {t("jobs.new.preset")}
              </label>
              <select
                id="preset_id"
                name="preset_id"
                required
                className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              >
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} — {locale === "ar" ? p.names.ar : p.names.en}
                  </option>
                ))}
              </select>
            </div>
            <Field label={t("common.name")} name="name" required />
            {members.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="foreman_user_id" className="text-sm font-medium text-ink">
                  {t("jobs.new.foreman")}
                </label>
                <select
                  id="foreman_user_id"
                  name="foreman_user_id"
                  className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                >
                  <option value="">{t("common.none")}</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.fullName || m.userId.slice(0, 8)} ({m.roleKey})
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {customers.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="customer_id" className="text-sm font-medium text-ink">
                  {t("jobs.new.customer", { customer: term("customer", terms, "singular") })}
                </label>
                <select
                  id="customer_id"
                  name="customer_id"
                  // ?customer= continuity (003C): preselect only when the id is in
                  // the org-scoped ACTIVE list — foreign/archived ids fall back to none.
                  defaultValue={
                    customers.some((c) => c.active && c.id === customer) ? customer : ""
                  }
                  className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                >
                  <option value="">{t("common.none")}</option>
                  {customers
                    .filter((c) => c.active)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>
            ) : null}
            <Button type="submit">{t("jobs.new.cta", { job: jobTerm })}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
