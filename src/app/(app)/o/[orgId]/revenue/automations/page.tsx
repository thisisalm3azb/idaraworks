import { Badge, Button, Card, CardHeader, EmptyState } from "@/platform/ui";
import { can } from "@/platform/authz";
import { formatDate } from "@/platform/format";
import { listMembers } from "@/platform/auth/identity";
import { AUTOMATION_TRIGGERS, listAutomations, listRuns } from "@/modules/crm/service";
import { resolveRevenue, section, tabLabels } from "../shared";
import { RevenueTabs } from "../RevenueTabs";
import { createAutomationAction, runAutomationAction, toggleAutomationAction } from "./actions";

const input = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-sm text-ink";
const field = "flex flex-col gap-1 text-xs text-ink-muted";
const OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "empty", "not_empty", "truthy"] as const;
const ACTION_KINDS = [
  "create_task",
  "notify",
  "flag_risk",
  "set_forecast_category",
  "request_approval",
  "assign_owner",
] as const;
const FACTS: Record<string, string[]> = {
  lead_created: [
    "status",
    "source_kind",
    "quarantine",
    "value_minor",
    "age_days",
    "idle_days",
    "unassigned",
  ],
  lead_unassigned: ["status", "source_kind", "value_minor", "age_days", "idle_days"],
  lead_stale: ["status", "source_kind", "value_minor", "age_days", "idle_days"],
  opportunity_stage_aged: [
    "stage_key",
    "forecast_category",
    "kind",
    "value_minor",
    "probability",
    "stage_age_days",
    "inactive_days",
    "over_max_age",
  ],
  opportunity_stalled: [
    "stage_key",
    "forecast_category",
    "value_minor",
    "inactive_days",
    "stage_age_days",
  ],
  opportunity_close_date_passed: ["stage_key", "forecast_category", "value_minor", "close_passed"],
  opportunity_stage_entered: ["stage_key", "forecast_category", "value_minor"],
  renewal_due: ["days_left", "customer_id"],
  customer_at_risk: ["overdue_invoices", "churn_flags", "idle_days"],
  follow_up_overdue: ["overdue_days", "kind"],
};

/**
 * H27 — automations: each one has an owner, a trigger, conditions, actions,
 * an enabled state and a dry-run mode; every run is recorded per subject
 * and occurrence (idempotent) with its outcome or failure. Actions are
 * bounded to reviewed work: tasks, notifications, risk flags, forecast
 * category, an approval request — never a signature, a send, a posting or
 * a merge.
 */
export default async function AutomationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { resolved, t, locale } = await resolveRevenue(orgId, "crm.automations.manage");
  const [automations, members] = await Promise.all([
    listAutomations(resolved.ctx, resolved.archetype),
    can(resolved.archetype, "members.view")
      ? listMembers(resolved.ctx, resolved.archetype)
      : Promise.resolve([]),
  ]);
  const runs = sp.runs
    ? await section(() => listRuns(resolved.ctx, resolved.archetype, sp.runs!))
    : null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("revenue.automations.title")}</h1>
        <RevenueTabs
          orgId={orgId}
          active="automations"
          archetype={resolved.archetype}
          labels={tabLabels(t)}
        />
      </header>
      {sp.error ? (
        <Badge tone="danger">{t(`revenue.automations.error.${sp.error}`)}</Badge>
      ) : sp.ok === "ran" ? (
        <Badge tone="success">
          {t("revenue.automations.ran", {
            mode: t(`revenue.automations.mode.${sp.mode ?? "dry_run"}`),
            matched: sp.matched ?? "0",
            applied: sp.applied ?? "0",
            skipped: sp.skipped ?? "0",
            failed: sp.failed ?? "0",
          })}
        </Badge>
      ) : sp.ok ? (
        <Badge tone="success">{t(`revenue.automations.ok.${sp.ok}`)}</Badge>
      ) : null}
      <p className="text-xs text-ink-muted">{t("revenue.automations.limits")}</p>

      {automations.length === 0 ? (
        <EmptyState title={t("revenue.automations.none")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {automations.map((a) => (
            <li key={a.id} className="rounded-lg border border-line bg-card p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">
                  {a.name}{" "}
                  <Badge tone={a.enabled ? "success" : "neutral"}>
                    {a.enabled ? t("common.enabled") : t("common.disabled")}
                  </Badge>{" "}
                  {a.dryRun ? (
                    <Badge tone="info">{t("revenue.automations.mode.dry_run")}</Badge>
                  ) : null}
                </span>
                <span className="text-xs text-ink-muted">
                  {t(`revenue.trigger.${a.trigger}`)} · {a.ownerName ?? ""} · {a.runs}{" "}
                  {t("revenue.automations.runs")}
                  {a.lastRunAt ? ` · ${formatDate(a.lastRunAt.slice(0, 10), { locale })}` : ""}
                </span>
              </div>
              {a.description ? <p className="text-xs text-ink-secondary">{a.description}</p> : null}
              <p className="mt-1 text-xs text-ink-muted" dir="ltr">
                {t("revenue.automations.conditions")}: {JSON.stringify(a.conditions)} ·{" "}
                {t("revenue.automations.actions")}: {a.actions.map((x) => x.kind).join(", ")}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <form action={runAutomationAction.bind(null, orgId)}>
                  <input type="hidden" name="id" value={a.id} />
                  <input type="hidden" name="mode" value="dry_run" />
                  <Button type="submit" variant="secondary" size="md">
                    {t("revenue.automations.dry_run")}
                  </Button>
                </form>
                {a.enabled && !a.dryRun ? (
                  <form action={runAutomationAction.bind(null, orgId)}>
                    <input type="hidden" name="id" value={a.id} />
                    <input type="hidden" name="mode" value="live" />
                    <Button type="submit" size="md">
                      {t("revenue.automations.run_live")}
                    </Button>
                  </form>
                ) : null}
                <form action={toggleAutomationAction.bind(null, orgId)}>
                  <input type="hidden" name="id" value={a.id} />
                  <input type="hidden" name="intent" value={a.enabled ? "disable" : "enable"} />
                  <Button type="submit" variant="ghost" size="md">
                    {a.enabled ? t("revenue.automations.disable") : t("revenue.automations.enable")}
                  </Button>
                </form>
                <a
                  href={`/o/${orgId}/revenue/automations?runs=${a.id}`}
                  className="inline-flex min-h-11 items-center px-2 text-sm text-brand hover:underline"
                >
                  {t("revenue.automations.history")}
                </a>
              </div>
              {sp.runs === a.id && runs ? (
                runs.ok ? (
                  runs.data.length === 0 ? (
                    <p className="mt-2 text-xs text-ink-muted">
                      {t("revenue.automations.no_runs")}
                    </p>
                  ) : (
                    <table className="mt-2 w-full text-xs">
                      <thead className="text-ink-muted">
                        <tr>
                          <th className="py-1 text-start">{t("revenue.automations.subject")}</th>
                          <th className="py-1 text-start">{t("revenue.automations.occurrence")}</th>
                          <th className="py-1 text-start">{t("revenue.automations.mode_label")}</th>
                          <th className="py-1 text-start">{t("revenue.filter.status")}</th>
                          <th className="py-1 text-start">{t("common.date")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.data.slice(0, 50).map((r) => (
                          <tr key={r.id} className="border-t border-line">
                            <td className="py-1 text-ink" dir="ltr">
                              {r.subjectType} {r.subjectId.slice(0, 8)}
                            </td>
                            <td className="py-1 text-ink" dir="ltr">
                              {r.occurrenceKey}
                            </td>
                            <td className="py-1">{t(`revenue.automations.mode.${r.mode}`)}</td>
                            <td className="py-1">
                              <Badge
                                tone={
                                  r.status === "failed"
                                    ? "danger"
                                    : r.status === "applied"
                                      ? "success"
                                      : "neutral"
                                }
                              >
                                {r.status}
                              </Badge>
                              {r.error ? (
                                <span className="ms-1 text-danger" dir="ltr">
                                  {r.error.slice(0, 80)}
                                </span>
                              ) : null}
                            </td>
                            <td className="py-1 text-ink-muted" dir="ltr">
                              {formatDate(r.ranAt.slice(0, 10), { locale })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                ) : (
                  <p className="mt-2 text-xs text-danger">{t("common.error")}</p>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Card>
        <CardHeader title={t("revenue.automations.create")} />
        <form action={createAutomationAction.bind(null, orgId)} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className={field}>
              {t("revenue.leads.name")}
              <input name="name" required maxLength={120} className={input} />
            </label>
            <label className={field}>
              {t("revenue.automations.trigger")}
              <select name="trigger" defaultValue="opportunity_stage_aged" className={input}>
                {AUTOMATION_TRIGGERS.map((tr) => (
                  <option key={tr} value={tr}>
                    {t(`revenue.trigger.${tr}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className={field}>
              {t("common.description")}
              <input name="description" maxLength={1000} className={input} />
            </label>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-medium text-ink">
              {t("revenue.automations.conditions")}
            </legend>
            <p className="text-xs text-ink-muted" dir="ltr">
              {t("revenue.automations.facts")}:{" "}
              {Object.entries(FACTS)
                .map(([k, v]) => `${k}: ${v.join(", ")}`)
                .join(" · ")}
            </p>
            {[0, 1, 2].map((i) => (
              <div key={i} className="grid grid-cols-3 gap-2">
                <input
                  name={`c${i}_key`}
                  placeholder="stage_age_days"
                  className={input}
                  dir="ltr"
                />
                <select name={`c${i}_op`} defaultValue={i === 0 ? "gte" : ""} className={input}>
                  <option value="">—</option>
                  {OPS.map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </select>
                <input name={`c${i}_value`} placeholder="14" className={input} dir="ltr" />
              </div>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-medium text-ink">
              {t("revenue.automations.actions")}
            </legend>
            {[0, 1, 2].map((i) => (
              <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <select
                  name={`a${i}_kind`}
                  defaultValue={i === 0 ? "create_task" : ""}
                  className={input}
                >
                  <option value="">—</option>
                  {ACTION_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`revenue.action.${k}`)}
                    </option>
                  ))}
                </select>
                <input
                  name={`a${i}_title`}
                  placeholder={t("common.title")}
                  maxLength={200}
                  className={`${input} sm:col-span-2`}
                />
                <input
                  name={`a${i}_days`}
                  placeholder={t("revenue.automations.due_days")}
                  inputMode="numeric"
                  className={input}
                  dir="ltr"
                />
                <div className="flex gap-1">
                  <select
                    name={`a${i}_severity`}
                    defaultValue="medium"
                    className={`${input} w-full`}
                    aria-label={t("revenue.severity.title")}
                  >
                    {(["low", "medium", "high"] as const).map((s) => (
                      <option key={s} value={s}>
                        {t(`revenue.severity.${s}`)}
                      </option>
                    ))}
                  </select>
                  <select
                    name={`a${i}_category`}
                    defaultValue="pipeline"
                    className={`${input} w-full`}
                    aria-label={t("revenue.filter.category")}
                  >
                    {(["pipeline", "best_case", "commit", "omitted"] as const).map((c) => (
                      <option key={c} value={c}>
                        {t(`revenue.category.${c}`)}
                      </option>
                    ))}
                  </select>
                </div>
                {members.length > 0 ? (
                  <select
                    name={`a${i}_user`}
                    defaultValue=""
                    className={`${input} col-span-2 sm:col-span-5`}
                    aria-label={t("revenue.filter.owner")}
                  >
                    <option value="">{t("revenue.action.assign_owner")}: —</option>
                    {members
                      .filter((m) => !m.deactivatedAt)
                      .map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.fullName}
                        </option>
                      ))}
                  </select>
                ) : null}
              </div>
            ))}
          </fieldset>
          <p className="text-xs text-ink-muted">{t("revenue.automations.create_hint")}</p>
          <div>
            <Button type="submit">{t("revenue.automations.create")}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
