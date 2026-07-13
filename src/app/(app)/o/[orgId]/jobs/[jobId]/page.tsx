import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState, Field } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import {
  computeProgress,
  getJob,
  getJobStatusLabels,
  listAssignableMembers,
  listCrew,
  listJobTasks,
  listStages,
  type StageRow,
} from "@/modules/jobs/service";
import { listCustomers, listEmployees } from "@/modules/masters/service";
import { listComments } from "@/platform/comments";
import { listEntityFiles, signRead } from "@/platform/files";
import type { FieldDefinitionSet } from "@/platform/config";
import { sql, withCtx, supabaseServer } from "@/platform/tenancy";
import { formatDate, formatDateTime } from "@/platform/format";
import {
  addCommentAction,
  addCrewAction,
  adjustmentAction,
  clearOverrideAction,
  completeStageAction,
  createTaskAction,
  jobStatusAction,
  overrideAction,
  pricingAction,
  removeCrewAction,
  reopenStageAction,
  requestCompleteAction,
  startStageAction,
  taskStatusAction,
  updateJobCoreAction,
} from "./actions";
import { submitReportAction } from "../actions";
import { JobPhotoUpload } from "./JobPhotoUpload";

const TABS = ["overview", "stages", "tasks", "activity", "files", "comments"] as const;
type Tab = (typeof TABS)[number];

const STAGE_TONE = {
  not_started: "neutral",
  in_progress: "info",
  completed: "success",
  skipped: "neutral",
} as const;

type Resolved = Exclude<Awaited<ReturnType<typeof resolveCtx>>, string>;

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; jobId: string }>;
  searchParams: Promise<{ tab?: string; error?: string; notice?: string }>;
}) {
  const { orgId, jobId } = await params;
  const sp = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? "")
    ? (sp.tab as Tab)
    : "overview";
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const a = resolved.archetype;

  const job = await getJob(resolved.ctx, a, jobId);
  if (!job) notFound();
  const stages = await listStages(resolved.ctx, jobId);
  const statusLabels = await getJobStatusLabels(resolved.ctx, locale);
  const derived = computeProgress(stages);
  const progress = job.progressOverridden ? job.progress : derived;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={`${job.reference} — ${job.name}`}
          meta={
            <span className="flex items-center gap-2">
              <Badge tone={job.statusCategory === "active" ? "info" : "neutral"}>
                {statusLabels[job.statusKey] ?? job.statusKey}
              </Badge>
              {job.progressOverridden ? (
                <Badge tone="warning">{t("jobs.progress.overridden")}</Badge>
              ) : null}
            </span>
          }
        />
        {progress !== null && progress !== undefined ? (
          <div className="mb-2">
            <div className="mb-1 flex justify-between text-xs text-ink-muted">
              <span>{t("jobs.progress")}</span>
              <span>{progress}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-sunken">
              <div className="h-full bg-brand" style={{ width: `${progress}%` }} />
            </div>
          </div>
        ) : null}
        {job.dueDate ? (
          <p className="text-xs text-ink-muted">
            {t("jobs.due")}: {formatDate(job.dueDate, { locale })}
          </p>
        ) : null}
      </Card>

      <nav className="flex gap-1 overflow-x-auto">
        {TABS.map((key) => (
          <Link
            key={key}
            href={`/o/${orgId}/jobs/${jobId}?tab=${key}`}
            className={`min-h-11 whitespace-nowrap rounded-md px-3 py-2.5 text-sm ${
              tab === key ? "bg-brand text-ink-inverse" : "border border-line bg-card text-ink"
            }`}
          >
            {t(`jobs.tab.${key}`, {
              job_stages: term("job_stage", terms, "plural"),
              tasks: term("task", terms, "plural"),
            })}
          </Link>
        ))}
      </nav>

      {sp.error ? (
        <p className="rounded-md bg-danger-soft p-3 text-sm text-danger">{t("common.error")}</p>
      ) : null}

      {tab === "overview" ? (
        <OverviewTab
          orgId={orgId}
          jobId={jobId}
          resolved={resolved}
          jobName={job.name}
          statusKey={job.statusKey}
          statusLabels={statusLabels}
          derived={derived}
          notice={sp.notice}
        />
      ) : null}
      {tab === "stages" ? (
        <StagesTab
          orgId={orgId}
          jobId={jobId}
          resolved={resolved}
          stages={stages}
          locale={locale}
        />
      ) : null}
      {tab === "tasks" ? (
        <TasksTab orgId={orgId} jobId={jobId} resolved={resolved} locale={locale} />
      ) : null}
      {tab === "activity" ? (
        <ActivityTab resolved={resolved} jobId={jobId} locale={locale} />
      ) : null}
      {tab === "files" ? <FilesTab orgId={orgId} jobId={jobId} resolved={resolved} /> : null}
      {tab === "comments" ? (
        <CommentsTab orgId={orgId} jobId={jobId} resolved={resolved} locale={locale} />
      ) : null}
    </div>
  );
}

async function OverviewTab(props: {
  orgId: string;
  jobId: string;
  resolved: Resolved;
  jobName: string;
  statusKey: string;
  statusLabels: Record<string, string>;
  derived: number | null;
  notice?: string;
}) {
  const { orgId, jobId, resolved } = props;
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const a = resolved.archetype;
  const canEdit = can(a, "jobs.edit");
  const canCrew = can(a, "crew.manage");
  const canPricing = can(a, "jobs.price.manage") && resolved.ctx.pricePrivileged;
  const canAdjust = can(a, "jobs.price.adjust");
  const canOverride = can(a, "jobs.progress.override");

  const crew = await listCrew(resolved.ctx, jobId);
  const employees = canCrew ? await listEmployees(resolved.ctx, a) : [];
  const customers = canEdit && can(a, "customers.view") ? await listCustomers(resolved.ctx, a) : [];
  const members = canEdit ? await listAssignableMembers(resolved.ctx, a) : [];

  const detail = (await withCtx(resolved.ctx, (tx) =>
    tx.execute(sql`
      select start_date::text as start_date, due_date::text as due_date,
             customer_id::text as customer_id, foreman_user_id::text as foreman_user_id,
             custom_values, selling_price_minor, payment_terms, price_adjustments,
             progress_override, progress_override_reason
      from public.job where org_id = ${resolved.ctx.orgId} and id = ${jobId}
    `),
  )) as unknown as Array<{
    start_date: string | null;
    due_date: string | null;
    customer_id: string | null;
    foreman_user_id: string | null;
    custom_values: Record<string, unknown>;
    selling_price_minor: number | null;
    payment_terms: string | null;
    price_adjustments: Array<{ amount_minor: number; reason: string; at: string }>;
    progress_override: number | null;
    progress_override_reason: string | null;
  }>;
  const d = detail[0]!;

  const fieldDefs = (await withCtx(resolved.ctx, (tx) =>
    tx.execute(sql`
      select value from public.app_settings
      where org_id = ${resolved.ctx.orgId} and key = 'config.fields.job'
    `),
  )) as unknown as Array<{ value: FieldDefinitionSet | null }>;
  const fields = (fieldDefs[0]?.value?.fields ?? []).filter(
    (f) => !f.retired && (f.visibility.length === 0 || (f.visibility as string[]).includes(a)),
  );

  const statusForm = jobStatusAction.bind(null, orgId, jobId);
  const coreForm = updateJobCoreAction.bind(null, orgId, jobId);
  const crewAdd = addCrewAction.bind(null, orgId, jobId);
  const crewRemove = removeCrewAction.bind(null, orgId, jobId);
  const pricingForm = pricingAction.bind(null, orgId, jobId);
  const adjustForm = adjustmentAction.bind(null, orgId, jobId);
  const overrideForm = overrideAction.bind(null, orgId, jobId);
  const clearOverrideForm = clearOverrideAction.bind(null, orgId, jobId);
  const reportForm = submitReportAction.bind(null, orgId);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());

  return (
    <div className="flex flex-col gap-4">
      {canEdit ? (
        <Card>
          <CardHeader title={t("jobs.status.change")} />
          <form action={statusForm} className="flex items-end gap-2">
            <select
              name="status_key"
              defaultValue={props.statusKey}
              className="min-h-11 flex-1 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            >
              {Object.entries(props.statusLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <Button type="submit" variant="secondary">
              {t("common.save")}
            </Button>
          </form>
        </Card>
      ) : null}

      <Card>
        <CardHeader title={t("fields.title")} />
        {canEdit ? (
          <form action={coreForm} className="flex flex-col gap-4">
            <Field label={t("common.name")} name="name" defaultValue={props.jobName} required />
            <Field
              label={t("jobs.start")}
              name="start_date"
              type="date"
              defaultValue={d.start_date ?? ""}
            />
            <Field
              label={t("jobs.due")}
              name="due_date"
              type="date"
              defaultValue={d.due_date ?? ""}
            />
            {customers.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="customer_id" className="text-sm font-medium text-ink">
                  {t("jobs.customer", { customer: term("customer", terms, "singular") })}
                </label>
                <select
                  id="customer_id"
                  name="customer_id"
                  defaultValue={d.customer_id ?? ""}
                  className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                >
                  <option value="">{t("common.none")}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {members.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="foreman_user_id" className="text-sm font-medium text-ink">
                  {t("jobs.new.foreman")}
                </label>
                <select
                  id="foreman_user_id"
                  name="foreman_user_id"
                  defaultValue={d.foreman_user_id ?? ""}
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
            {fields.map((f) => (
              <Field
                key={f.field_key}
                label={locale === "ar" ? f.labels.ar : f.labels.en}
                name={`cf_${f.field_key}`}
                defaultValue={String(d.custom_values?.[f.field_key] ?? "")}
                required={f.required}
              />
            ))}
            <Button type="submit">{t("common.save")}</Button>
          </form>
        ) : (
          <dl className="flex flex-col gap-2 text-sm">
            {fields.map((f) => (
              <div key={f.field_key} className="flex justify-between gap-2">
                <dt className="text-ink-muted">{locale === "ar" ? f.labels.ar : f.labels.en}</dt>
                <dd className="text-ink">{String(d.custom_values?.[f.field_key] ?? "—")}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>

      <Card>
        <CardHeader title={t("jobs.crew.title")} />
        {crew.length === 0 ? (
          <EmptyState title={t("common.none")} />
        ) : (
          <ul className="divide-y divide-line">
            {crew.map((c) => (
              <li key={c.employeeId} className="flex min-h-11 items-center justify-between py-2">
                <p className="text-sm text-ink">
                  {c.name} <span className="text-xs text-ink-muted">{c.teamName ?? ""}</span>
                </p>
                {canCrew ? (
                  <form action={crewRemove}>
                    <input type="hidden" name="employee_id" value={c.employeeId} />
                    <Button type="submit" variant="ghost" className="text-danger">
                      {t("jobs.crew.remove")}
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canCrew && employees.length > 0 ? (
          <form action={crewAdd} className="mt-3 flex items-end gap-2">
            <select
              name="employee_id"
              className="min-h-11 flex-1 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            >
              {employees
                .filter((e) => e.active && !crew.some((c) => c.employeeId === e.id))
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </select>
            <Button type="submit" variant="secondary">
              {t("jobs.crew.add")}
            </Button>
          </form>
        ) : null}
      </Card>

      {canOverride ? (
        <Card>
          <CardHeader title={t("jobs.override.title")} />
          {d.progress_override !== null ? (
            <div className="mb-3 flex items-center justify-between gap-2 text-sm">
              <span className="text-ink">
                {Number(d.progress_override)}% — {d.progress_override_reason}
              </span>
              <form action={clearOverrideForm}>
                <Button type="submit" variant="ghost">
                  {t("jobs.override.clear")}
                </Button>
              </form>
            </div>
          ) : null}
          <form action={overrideForm} className="flex flex-col gap-3">
            <Field
              label={t("jobs.override.percent")}
              name="percent"
              type="number"
              min={0}
              max={100}
              defaultValue={props.derived !== null ? String(props.derived) : "0"}
              required
            />
            <Field label={t("jobs.override.reason")} name="reason" required maxLength={500} />
            <Button type="submit" variant="secondary">
              {t("jobs.override.set")}
            </Button>
          </form>
        </Card>
      ) : null}

      {canPricing ? (
        <Card>
          <CardHeader title={t("jobs.pricing.title")} />
          <form action={pricingForm} className="flex flex-col gap-3">
            <Field
              label={t("jobs.pricing.selling_price")}
              name="selling_price_minor"
              type="number"
              defaultValue={d.selling_price_minor !== null ? String(d.selling_price_minor) : ""}
            />
            <Field
              label={t("jobs.pricing.payment_terms")}
              name="payment_terms"
              defaultValue={d.payment_terms ?? ""}
            />
            <Button type="submit" variant="secondary">
              {t("common.save")}
            </Button>
          </form>
          {(d.price_adjustments ?? []).length > 0 ? (
            <div className="mt-3">
              <p className="text-sm font-medium text-ink">{t("jobs.pricing.adjustments")}</p>
              <ul className="divide-y divide-line text-sm">
                {d.price_adjustments.map((adj, i) => (
                  <li key={i} className="py-2">
                    <span className="font-mono" dir="ltr">
                      {adj.amount_minor}
                    </span>{" "}
                    — {adj.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {canAdjust ? (
            <form action={adjustForm} className="mt-3 flex flex-col gap-3">
              <Field
                label={t("jobs.pricing.adjust.amount")}
                name="amount_minor"
                type="number"
                required
              />
              <Field
                label={t("jobs.pricing.adjust.reason")}
                name="reason"
                required
                maxLength={500}
              />
              <Button type="submit" variant="secondary">
                {t("jobs.pricing.adjust.cta")}
              </Button>
            </form>
          ) : null}
        </Card>
      ) : null}

      {can(a, "reports.create") ? (
        <Card>
          <CardHeader
            title={t("reports.form.title", {
              daily_report: term("daily_report", terms, "singular"),
            })}
          />
          {props.notice === "submitted" ? (
            <p className="mb-3 rounded-md bg-success-soft p-3 text-sm text-success">
              {t("reports.notice.submitted")}
            </p>
          ) : null}
          <form action={reportForm} className="flex flex-col gap-4">
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
            <Button type="submit">{t("reports.form.cta")}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

async function StagesTab(props: {
  orgId: string;
  jobId: string;
  resolved: Resolved;
  stages: StageRow[];
  locale: "en" | "ar";
}) {
  const t = await getT();
  const a = props.resolved.archetype;
  const canStages = can(a, "stages.update");
  const canRequest = can(a, "stages.request_complete");
  const canReopen = can(a, "stages.reopen");
  const start = startStageAction.bind(null, props.orgId, props.jobId);
  const request = requestCompleteAction.bind(null, props.orgId, props.jobId);
  const complete = completeStageAction.bind(null, props.orgId, props.jobId);
  const reopen = reopenStageAction.bind(null, props.orgId, props.jobId);

  return (
    <Card>
      <ul className="divide-y divide-line">
        {props.stages.map((s) => (
          <li key={s.id} className="flex flex-col gap-2 py-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-ink">
                {props.locale === "ar" ? s.name.ar : s.name.en}{" "}
                <span className="text-xs text-ink-muted">({s.weight})</span>
              </p>
              <Badge tone={STAGE_TONE[s.status]}>{t(`stages.status.${s.status}`)}</Badge>
            </div>
            {s.completionRequestedAt && s.status === "in_progress" ? (
              <p className="text-xs text-warning">{t("stages.requested")}</p>
            ) : null}
            <div className="flex flex-wrap items-end gap-2">
              {s.status === "not_started" && (canStages || canRequest) ? (
                <form action={start}>
                  <input type="hidden" name="stage_id" value={s.id} />
                  <Button type="submit" variant="secondary">
                    {t("stages.start")}
                  </Button>
                </form>
              ) : null}
              {s.status === "in_progress" && canRequest && !canStages ? (
                <form action={request}>
                  <input type="hidden" name="stage_id" value={s.id} />
                  <Button type="submit" variant="secondary">
                    {t("stages.request_complete")}
                  </Button>
                </form>
              ) : null}
              {s.status === "in_progress" && canStages ? (
                <form action={complete}>
                  <input type="hidden" name="stage_id" value={s.id} />
                  <Button type="submit">{t("stages.complete")}</Button>
                </form>
              ) : null}
              {s.status === "completed" && canReopen ? (
                <form action={reopen} className="flex flex-1 items-end gap-2">
                  <input type="hidden" name="stage_id" value={s.id} />
                  <div className="flex-1">
                    <Field
                      label={t("stages.reopen.reason")}
                      name="reason"
                      required
                      maxLength={500}
                    />
                  </div>
                  <Button type="submit" variant="ghost" className="text-danger">
                    {t("stages.reopen")}
                  </Button>
                </form>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

async function TasksTab(props: {
  orgId: string;
  jobId: string;
  resolved: Resolved;
  locale: "en" | "ar";
}) {
  const t = await getT();
  const a = props.resolved.archetype;
  const canTasks = can(a, "tasks.manage");
  const canTaskStatus = can(a, "tasks.update_status");
  const terms = await loadOrgTerminology(props.resolved.ctx, props.locale);
  const tasks = await listJobTasks(props.resolved.ctx, props.jobId);
  const employees = canTasks ? await listEmployees(props.resolved.ctx, a) : [];
  const create = createTaskAction.bind(null, props.orgId, props.jobId);
  const setStatus = taskStatusAction.bind(null, props.orgId, props.jobId);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        {tasks.length === 0 ? (
          <EmptyState title={t("common.none")} />
        ) : (
          <ul className="divide-y divide-line">
            {tasks.map((task) => (
              <li key={task.id} className="flex min-h-14 items-center justify-between gap-2 py-2">
                <div>
                  <p
                    className={`text-sm ${
                      task.status === "completed" ? "text-ink-muted line-through" : "text-ink"
                    }`}
                  >
                    {task.title}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {task.assigneeName ?? ""}
                    {task.dueDate ? ` · ${formatDate(task.dueDate, { locale: props.locale })}` : ""}
                  </p>
                </div>
                {canTaskStatus ? (
                  <form action={setStatus} className="flex items-center gap-1">
                    <input type="hidden" name="task_id" value={task.id} />
                    <select
                      name="status"
                      defaultValue={task.status}
                      className="min-h-11 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
                    >
                      {(canTasks
                        ? (["pending", "in_progress", "completed", "cancelled"] as const)
                        : (["pending", "in_progress", "completed"] as const)
                      ).map((st) => (
                        <option key={st} value={st}>
                          {t(`tasks.status.${st}`)}
                        </option>
                      ))}
                    </select>
                    <Button type="submit" variant="ghost">
                      ✓
                    </Button>
                  </form>
                ) : (
                  <Badge tone={task.status === "completed" ? "success" : "neutral"}>
                    {t(`tasks.status.${task.status}`)}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {canTasks ? (
        <Card>
          <CardHeader title={t("tasks.add", { task: term("task", terms, "singular") })} />
          <form action={create} className="flex flex-col gap-3">
            <Field label={t("tasks.title_label")} name="title" required maxLength={200} />
            {employees.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="assignee_employee_id" className="text-sm font-medium text-ink">
                  {t("tasks.assignee")}
                </label>
                <select
                  id="assignee_employee_id"
                  name="assignee_employee_id"
                  className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                >
                  <option value="">{t("common.none")}</option>
                  {employees
                    .filter((e) => e.active)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                </select>
              </div>
            ) : null}
            <Field label={t("tasks.due")} name="due_date" type="date" />
            <Button type="submit">{t("common.add")}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

async function ActivityTab(props: { resolved: Resolved; jobId: string; locale: "en" | "ar" }) {
  const t = await getT();
  const rows = (await withCtx(props.resolved.ctx, (tx) =>
    tx.execute(sql`
      select a.summary, a.created_at::text as created_at, u.full_name
      from public.activity a
      left join public.user_profile u on u.id = a.actor_user_id
      where a.org_id = ${props.resolved.ctx.orgId} and a.entity_type = 'job'
        and a.entity_id = ${props.jobId}
      order by a.created_at desc
      limit 50
    `),
  )) as unknown as Array<{ summary: string; created_at: string; full_name: string | null }>;
  return (
    <Card>
      {rows.length === 0 ? (
        <EmptyState title={t("activity.empty")} />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r, i) => (
            <li key={i} className="py-2">
              <p className="text-sm text-ink">
                <span className="font-medium">{r.full_name ?? ""}</span> {r.summary}
              </p>
              <p className="text-xs text-ink-muted">
                {formatDateTime(r.created_at, { locale: props.locale })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

async function FilesTab(props: { orgId: string; jobId: string; resolved: Resolved }) {
  const t = await getT();
  const files = await listEntityFiles(props.resolved.ctx, "job", props.jobId);
  const store = await cookies();
  const { data } = await supabaseServer(store).auth.getSession();
  const token = data.session?.access_token ?? "";
  const thumbs: Array<{ id: string; name: string; url: string | null }> = [];
  for (const f of files) {
    let url: string | null = null;
    if (token && f.status === "ready") {
      try {
        url = (await signRead(props.resolved.ctx, props.resolved.archetype, token, f.id, "thumb"))
          .url;
      } catch {
        url = null; // class denial or missing variant — show the name only
      }
    }
    thumbs.push({ id: f.id, name: f.originalName, url });
  }
  const labels = {
    idle: t("upload.idle"),
    compressing: t("upload.compressing"),
    signing: t("upload.signing"),
    uploading: t("upload.uploading"),
    confirming: t("upload.confirming"),
    done: t("upload.done"),
    retry: t("upload.retry"),
    quotaWarn: t("upload.quota_warn"),
  };
  return (
    <Card>
      <div className="mb-3">
        <JobPhotoUpload orgId={props.orgId} jobId={props.jobId} labels={labels} />
      </div>
      {thumbs.length === 0 ? (
        <EmptyState title={t("files.empty")} />
      ) : (
        <ul className="grid grid-cols-3 gap-2">
          {thumbs.map((f) => (
            <li key={f.id} className="overflow-hidden rounded-md border border-line">
              {f.url ? (
                // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                <img src={f.url} alt={f.name} className="h-24 w-full object-cover" />
              ) : (
                <p className="p-2 text-xs text-ink-muted">{f.name}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

async function CommentsTab(props: {
  orgId: string;
  jobId: string;
  resolved: Resolved;
  locale: "en" | "ar";
}) {
  const t = await getT();
  const comments = await listComments(props.resolved.ctx, "job", props.jobId);
  const add = addCommentAction.bind(null, props.orgId, props.jobId);
  return (
    <Card>
      <form action={add} className="mb-4 flex flex-col gap-2">
        <textarea
          name="body"
          required
          rows={2}
          maxLength={4000}
          className="rounded-md border border-line-strong bg-card px-3 py-2 text-base text-ink"
          placeholder={t("comments.add")}
        />
        <Button type="submit" variant="secondary">
          {t("comments.add")}
        </Button>
      </form>
      {comments.length === 0 ? (
        <EmptyState title={t("comments.empty")} />
      ) : (
        <ul className="divide-y divide-line">
          {comments
            .filter((c) => !c.deletedAt)
            .map((c) => (
              <li key={c.id} className="py-2">
                <p className="text-sm text-ink">{c.body}</p>
                <p className="text-xs text-ink-muted">
                  {c.authorName} · {formatDateTime(c.createdAt, { locale: props.locale })}
                </p>
              </li>
            ))}
        </ul>
      )}
    </Card>
  );
}
