import { Badge, Button, Card, CardHeader, EmptyState } from "@/platform/ui";
import { can } from "@/platform/authz";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { listMembers } from "@/platform/auth/identity";
import { listTerritories, targetProgress } from "@/modules/crm/service";
import { orgToday } from "@/modules/dashboard/service";
import { localeText, pct, resolveRevenue, section, tabLabels } from "../shared";
import { RevenueTabs } from "../RevenueTabs";
import {
  applyTerritoryRulesAction,
  createTerritoryAction,
  setTargetAction,
  updateTerritoryAction,
} from "./actions";

const input = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-sm text-ink";
const field = "flex flex-col gap-1 text-xs text-ink-muted";
const METRICS = ["revenue", "bookings", "margin", "activities", "new_customers"] as const;

/**
 * H27 — targets and territories. Targets are dated rows (a later row for the
 * same scope and period supersedes, history stays); progress states its
 * basis in words. Territories are rule sets that assign only unassigned
 * customers. No activity surveillance: activity targets count the person's
 * own logged work, nothing more.
 */
export default async function TargetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; n?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { resolved, t, locale } = await resolveRevenue(orgId, "crm.forecast.view");
  const canManage = can(resolved.archetype, "crm.targets.manage");
  const seesPrice = resolved.ctx.pricePrivileged;
  const currency = resolved.baseCurrency as CurrencyCode;
  const asOf = orgToday(new Date(), resolved.timezone);
  const money = (n: number | null | undefined, cur?: string | null) =>
    seesPrice && n !== null && n !== undefined
      ? formatMoney(n, (cur ?? currency) as CurrencyCode, { locale })
      : t("common.restricted");
  const [progress, territories, members] = await Promise.all([
    section(() => targetProgress(resolved.ctx, resolved.archetype, asOf)),
    listTerritories(resolved.ctx, resolved.archetype),
    can(resolved.archetype, "members.view")
      ? listMembers(resolved.ctx, resolved.archetype)
      : Promise.resolve([]),
  ]);
  const year = asOf.slice(0, 4);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("revenue.targets.title")}</h1>
        <RevenueTabs
          orgId={orgId}
          active="targets"
          archetype={resolved.archetype}
          labels={tabLabels(t)}
        />
      </header>
      {sp.error ? (
        <Badge tone="danger">{t(`revenue.targets.error.${sp.error}`)}</Badge>
      ) : sp.ok ? (
        <Badge tone="success">{t(`revenue.targets.ok.${sp.ok}`, { n: sp.n ?? "0" })}</Badge>
      ) : null}

      <Card>
        <CardHeader title={t("revenue.targets.progress")} />
        {progress.ok ? (
          progress.data.length === 0 ? (
            <EmptyState title={t("revenue.targets.none")} />
          ) : (
            <ul className="flex flex-col gap-2">
              {progress.data.map((tp) => (
                <li
                  key={tp.id}
                  className="flex flex-col gap-1 rounded-md border border-line p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-ink">
                      <Badge tone="brand">{t(`revenue.metric.${tp.metric}`)}</Badge>{" "}
                      {t(`revenue.scope.${tp.scopeKind}`)}
                      {tp.scopeName ? ` · ${tp.scopeName}` : ""}{" "}
                      <span className="text-xs text-ink-muted" dir="ltr">
                        {formatDate(tp.periodStart, { locale })} →{" "}
                        {formatDate(tp.periodEnd, { locale })}
                      </span>
                    </span>
                    <span className="font-medium text-ink" dir="ltr">
                      {tp.targetCount !== null
                        ? `${tp.actualCount ?? 0} / ${tp.targetCount}`
                        : `${money(tp.actualMinor, tp.currency)} / ${money(tp.targetMinor, tp.currency)}`}{" "}
                      ({pct(tp.progressPct)})
                    </span>
                  </div>
                  <div className="h-2 w-full rounded bg-sunken" aria-hidden>
                    <div
                      className="h-2 rounded bg-brand"
                      style={{ width: `${Math.min(100, Math.max(0, tp.progressPct ?? 0))}%` }}
                    />
                  </div>
                  <span className="text-xs text-ink-muted">
                    {t("revenue.targets.basis")}: {tp.basis} · {t("revenue.targets.effective")}{" "}
                    {formatDate(tp.effectiveFrom, { locale })}
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="text-sm text-danger">
            {t("revenue.section_failed", { section: t("revenue.targets.progress") })}
          </p>
        )}
        {canManage ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-semibold text-ink">
              {t("revenue.targets.set")}
            </summary>
            <form
              action={setTargetAction.bind(null, orgId)}
              className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4"
            >
              <label className={field}>
                {t("revenue.targets.metric")}
                <select name="metric" defaultValue="revenue" className={input}>
                  {METRICS.map((m) => (
                    <option key={m} value={m}>
                      {t(`revenue.metric.${m}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={field}>
                {t("revenue.targets.scope")}
                <select name="scope_kind" defaultValue="org" className={input}>
                  {(["org", "user", "territory"] as const).map((s) => (
                    <option key={s} value={s}>
                      {t(`revenue.scope.${s}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={`${field} col-span-2`}>
                {t("revenue.targets.scope_id")}
                <select name="scope_id" defaultValue="" className={input}>
                  <option value="">{t("revenue.scope.org")}</option>
                  <optgroup label={t("revenue.scope.user")}>
                    {members
                      .filter((m) => !m.deactivatedAt)
                      .map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.fullName}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label={t("revenue.scope.territory")}>
                    {territories.map((tr) => (
                      <option key={tr.id} value={tr.id}>
                        {localeText(tr.name, locale, tr.key)}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
              <label className={field}>
                {t("common.from")}
                <input
                  name="period_start"
                  type="date"
                  required
                  defaultValue={`${year}-01-01`}
                  className={input}
                  dir="ltr"
                />
              </label>
              <label className={field}>
                {t("common.to")}
                <input
                  name="period_end"
                  type="date"
                  required
                  defaultValue={`${year}-12-31`}
                  className={input}
                  dir="ltr"
                />
              </label>
              <label className={field}>
                {t("revenue.targets.amount")}
                <span className="flex gap-1">
                  <input
                    name="amount_major"
                    inputMode="decimal"
                    className={`${input} w-full`}
                    dir="ltr"
                  />
                  <input
                    name="currency"
                    defaultValue={currency}
                    maxLength={3}
                    className={`${input} w-20`}
                    dir="ltr"
                  />
                </span>
              </label>
              <label className={field}>
                {t("revenue.targets.count")}
                <input name="count_target" inputMode="numeric" className={input} dir="ltr" />
              </label>
              <label className={`${field} col-span-2 lg:col-span-3`}>
                {t("common.notes")}
                <input name="note" maxLength={500} className={input} />
              </label>
              <div className="flex items-end">
                <Button type="submit">{t("revenue.targets.set")}</Button>
              </div>
            </form>
            <p className="mt-2 text-xs text-ink-muted">{t("revenue.targets.hint")}</p>
          </details>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title={t("revenue.territory.title")}
          meta={
            canManage && territories.length > 0 ? (
              <form action={applyTerritoryRulesAction.bind(null, orgId)}>
                <Button type="submit" variant="secondary" size="md">
                  {t("revenue.territory.apply_rules")}
                </Button>
              </form>
            ) : null
          }
        />
        {territories.length === 0 ? (
          <EmptyState title={t("revenue.territory.none")} />
        ) : (
          <ul className="flex flex-col gap-2">
            {territories.map((tr) => (
              <li
                key={tr.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3 text-sm"
              >
                <span className="text-ink">
                  {localeText(tr.name, locale, tr.key)}{" "}
                  <Badge tone={tr.active ? "success" : "neutral"}>
                    {tr.active ? t("common.active") : t("common.inactive")}
                  </Badge>
                  <span className="block text-xs text-ink-muted" dir="ltr">
                    {[
                      tr.rules.countries?.length
                        ? `${t("common.country")}: ${tr.rules.countries.join(", ")}`
                        : null,
                      tr.rules.tags?.length
                        ? `${t("revenue.customer.tags")}: ${tr.rules.tags.join(", ")}`
                        : null,
                      tr.rules.segments?.length
                        ? `${t("revenue.customer.segment")}: ${tr.rules.segments.join(", ")}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || t("revenue.territory.no_rules")}
                  </span>
                </span>
                <span className="flex items-center gap-3 text-xs text-ink-muted">
                  <span>
                    {tr.customers} {t("revenue.territory.customers")}
                  </span>
                  {tr.ownerName ? <span>{tr.ownerName}</span> : null}
                  {canManage ? (
                    <form
                      action={updateTerritoryAction.bind(null, orgId)}
                      className="flex items-center gap-2"
                    >
                      <input type="hidden" name="id" value={tr.id} />
                      <label className="flex items-center gap-1 text-ink">
                        <input
                          type="checkbox"
                          name="active"
                          defaultChecked={tr.active}
                          className="size-5"
                        />
                        {t("common.active")}
                      </label>
                      <Button type="submit" variant="ghost" size="md">
                        {t("common.save")}
                      </Button>
                    </form>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-semibold text-ink">
              {t("revenue.territory.create")}
            </summary>
            <form
              action={createTerritoryAction.bind(null, orgId)}
              className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
            >
              <label className={field}>
                {t("revenue.territory.key")}
                <input
                  name="key"
                  required
                  pattern="[a-z][a-z0-9_]{0,39}"
                  className={input}
                  dir="ltr"
                />
              </label>
              <label className={field}>
                {t("common.name")} (EN)
                <input name="name_en" maxLength={120} className={input} />
              </label>
              <label className={field}>
                {t("common.name")} (AR)
                <input name="name_ar" maxLength={120} className={input} dir="rtl" />
              </label>
              {members.length > 0 ? (
                <label className={field}>
                  {t("revenue.filter.owner")}
                  <select name="owner_user_id" defaultValue="" className={input}>
                    <option value="">—</option>
                    {members
                      .filter((m) => !m.deactivatedAt)
                      .map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.fullName}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}
              <label className={field}>
                {t("revenue.territory.countries")}
                <input name="countries" placeholder="AE, SA" className={input} dir="ltr" />
              </label>
              <label className={field}>
                {t("revenue.customer.tags")}
                <input name="tags" className={input} />
              </label>
              <label className={field}>
                {t("revenue.customer.segment")}
                <input name="segments" className={input} dir="ltr" />
              </label>
              <div className="flex items-end">
                <Button type="submit" variant="secondary">
                  {t("revenue.territory.create")}
                </Button>
              </div>
            </form>
          </details>
        ) : null}
      </Card>
    </div>
  );
}
