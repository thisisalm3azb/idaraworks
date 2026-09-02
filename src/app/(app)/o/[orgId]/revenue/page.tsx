import Link from "next/link";
import { Badge, Card, CardHeader, EmptyState } from "@/platform/ui";
import { can } from "@/platform/authz";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import {
  boardPage,
  computeForecast,
  leadPage,
  listAutomations,
  listCampaigns,
  listStageSettings,
  myCommercialQueue,
  targetProgress,
} from "@/modules/crm/service";
import { orgToday } from "@/modules/dashboard/service";
import { localeText, resolveRevenue, section, tabLabels } from "./shared";
import { RevenueTabs } from "./RevenueTabs";
import { LazyCharts } from "./LazyCharts";
import { RevenueCommandPalette } from "./RevenueCommandPalette";

/**
 * H27 — the Revenue Growth Studio hub: the funnel, the pipeline by stage,
 * weighted forecast by month, stalled deals, the person's own commercial
 * queue, targets and campaign performance — every count across the full
 * result, every money figure redacted by privilege, every section honest
 * when it cannot load.
 */
export default async function RevenueHubPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { resolved, t, locale } = await resolveRevenue(orgId, "opportunities.view");
  const seesPrice = resolved.ctx.pricePrivileged;
  const currency = resolved.baseCurrency as CurrencyCode;
  const asOf = orgToday(new Date(), resolved.timezone);
  const money = (n: number | null | undefined) =>
    seesPrice && n !== null && n !== undefined ? formatMoney(n, currency, { locale }) : null;
  const seesForecast = can(resolved.archetype, "crm.forecast.view");

  const [board, stages, leads, queue, forecast, targets, campaigns, automations] =
    await Promise.all([
      section(() => boardPage(resolved.ctx, resolved.archetype, { limit: 1 })),
      section(() => listStageSettings(resolved.ctx, resolved.archetype, null)),
      section(() =>
        can(resolved.archetype, "leads.view")
          ? leadPage(resolved.ctx, resolved.archetype, { limit: 1 })
          : Promise.resolve(null),
      ),
      section(() => myCommercialQueue(resolved.ctx, resolved.archetype, asOf)),
      section(() =>
        seesForecast
          ? computeForecast(resolved.ctx, resolved.archetype, {})
          : Promise.resolve(null),
      ),
      section(() =>
        seesForecast ? targetProgress(resolved.ctx, resolved.archetype, asOf) : Promise.resolve([]),
      ),
      section(() =>
        can(resolved.archetype, "crm.campaigns.manage")
          ? listCampaigns(resolved.ctx, resolved.archetype)
          : Promise.resolve([]),
      ),
      section(() =>
        can(resolved.archetype, "crm.automations.manage")
          ? listAutomations(resolved.ctx, resolved.archetype)
          : Promise.resolve([]),
      ),
    ]);

  const leadsData = leads.ok ? leads.data : null;
  const stageLabel = (key: string) =>
    stages.ok ? localeText(stages.data.find((s) => s.key === key)?.label, locale, key) : key;
  const stageBars = board.ok
    ? board.data.stages
        .filter((s) => s.count > 0)
        .map((s) => ({
          key: s.stageKey,
          label: stageLabel(s.stageKey),
          count: s.count,
          value: seesPrice ? (s.valueMinor ?? 0) : s.count,
          valueText: money(s.valueMinor),
        }))
    : [];
  const monthBars =
    forecast.ok && forecast.data
      ? forecast.data.byPeriod.month.slice(0, 8).map((m) => ({
          key: m.key,
          label: m.key,
          count: m.count,
          value: seesPrice ? m.weightedMinor : m.count,
          valueText: money(m.weightedMinor),
        }))
      : [];
  const failed = (label: string) => (
    <p className="text-sm text-danger">{t("revenue.section_failed", { section: label })}</p>
  );
  const kpi = (label: string, value: string | number | null, hint?: string) => (
    <div className="flex flex-col gap-0.5 rounded-lg border border-line bg-card p-3">
      <span className="text-xs text-ink-muted">{label}</span>
      <span className="text-lg font-semibold text-ink" dir="ltr">
        {value ?? t("common.restricted")}
      </span>
      {hint ? <span className="text-xs text-ink-muted">{hint}</span> : null}
    </div>
  );
  const commands = [
    { id: "pipeline", label: t("revenue.tab.pipeline"), href: `/o/${orgId}/revenue/pipeline` },
    { id: "leads", label: t("revenue.tab.leads"), href: `/o/${orgId}/revenue/leads` },
    { id: "forecast", label: t("revenue.tab.forecast"), href: `/o/${orgId}/revenue/forecast` },
    { id: "campaigns", label: t("revenue.tab.campaigns"), href: `/o/${orgId}/revenue/campaigns` },
    { id: "targets", label: t("revenue.tab.targets"), href: `/o/${orgId}/revenue/targets` },
    { id: "success", label: t("revenue.tab.success"), href: `/o/${orgId}/revenue/success` },
    {
      id: "automations",
      label: t("revenue.tab.automations"),
      href: `/o/${orgId}/revenue/automations`,
    },
    { id: "reports", label: t("revenue.tab.reports"), href: `/o/${orgId}/revenue/reports` },
    { id: "settings", label: t("revenue.tab.settings"), href: `/o/${orgId}/revenue/settings` },
    { id: "imports", label: t("imports.title"), href: `/o/${orgId}/imports` },
  ];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold text-ink">{t("revenue.title")}</h1>
            <p className="text-sm text-ink-muted">{t("revenue.subtitle")}</p>
          </div>
          <RevenueCommandPalette
            orgId={orgId}
            commands={commands}
            dict={{
              open: t("revenue.palette.open"),
              placeholder: t("revenue.palette.placeholder"),
              nothing: t("revenue.palette.nothing"),
              commands: t("revenue.palette.commands"),
              results: t("revenue.palette.results"),
              shortcut: "Ctrl+K",
            }}
          />
        </div>
        <RevenueTabs
          orgId={orgId}
          active="hub"
          archetype={resolved.archetype}
          labels={tabLabels(t)}
        />
      </header>

      <section aria-label={t("revenue.kpis")} className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {board.ok ? kpi(t("revenue.kpi.open"), board.data.total) : kpi(t("revenue.kpi.open"), "—")}
        {board.ok
          ? kpi(t("revenue.kpi.pipeline"), money(board.data.totals.valueMinor))
          : kpi(t("revenue.kpi.pipeline"), "—")}
        {forecast.ok && forecast.data
          ? kpi(
              t("revenue.kpi.weighted"),
              money(forecast.data.totals.weightedMinor),
              t("revenue.model.weighted"),
            )
          : kpi(t("revenue.kpi.weighted"), seesForecast ? "—" : null)}
        {forecast.ok && forecast.data
          ? kpi(
              t("revenue.kpi.commit"),
              money(forecast.data.totals.commitMinor),
              t("revenue.kpi.commit_hint"),
            )
          : kpi(t("revenue.kpi.commit"), seesForecast ? "—" : null)}
      </section>

      <Card>
        <CardHeader title={t("revenue.funnel")} />
        {leadsData ? (
          <div className="flex flex-wrap gap-2 text-sm">
            {(["new", "contacted", "qualified", "converted", "disqualified"] as const).map((s) => (
              <Link
                key={s}
                href={`/o/${orgId}/revenue/leads?status=${s}`}
                className="rounded-md border border-line px-3 py-2 hover:bg-sunken"
              >
                <span className="block text-xs text-ink-muted">
                  {t(`revenue.lead_status.${s}`)}
                </span>
                <span className="text-base font-semibold text-ink">
                  {leadsData.byStatus[s] ?? 0}
                </span>
              </Link>
            ))}
            {leadsData.quarantined > 0 ? (
              <Link
                href={`/o/${orgId}/revenue/leads?quarantine=quarantined`}
                className="rounded-md border border-warning px-3 py-2 hover:bg-sunken"
              >
                <span className="block text-xs text-warning">{t("revenue.quarantine.title")}</span>
                <span className="text-base font-semibold text-ink">{leadsData.quarantined}</span>
              </Link>
            ) : null}
            {board.ok ? (
              <Link
                href={`/o/${orgId}/revenue/pipeline`}
                className="rounded-md border border-line px-3 py-2 hover:bg-sunken"
              >
                <span className="block text-xs text-ink-muted">{t("revenue.kpi.open")}</span>
                <span className="text-base font-semibold text-ink">{board.data.total}</span>
              </Link>
            ) : null}
            {forecast.ok && forecast.data ? (
              <span className="rounded-md border border-line px-3 py-2">
                <span className="block text-xs text-ink-muted">{t("revenue.won_window")}</span>
                <span className="text-base font-semibold text-ink">
                  {forecast.data.conversion.won}
                </span>
              </span>
            ) : null}
          </div>
        ) : leads.ok ? null : (
          failed(t("revenue.funnel"))
        )}
        {board.ok ? (
          <div className="mt-3">
            <LazyCharts
              stages={stageBars}
              months={monthBars}
              labels={{
                stages: t("revenue.chart.stages"),
                months: t("revenue.chart.months"),
                count: t("revenue.board.cards"),
                none: t("revenue.chart.none"),
              }}
            />
          </div>
        ) : (
          failed(t("revenue.tab.pipeline"))
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title={t("revenue.queue.title")}
            meta={
              queue.ok ? (
                <span className="text-xs text-ink-muted">
                  {t("revenue.queue.summary", {
                    overdue: queue.data.overdue.length,
                    today: queue.data.today.length,
                  })}
                </span>
              ) : null
            }
          />
          {queue.ok ? (
            [...queue.data.overdue, ...queue.data.today, ...queue.data.upcoming].length === 0 ? (
              <EmptyState title={t("revenue.queue.empty")} />
            ) : (
              <ul className="flex flex-col gap-1">
                {[
                  ...queue.data.overdue,
                  ...queue.data.today,
                  ...queue.data.upcoming.slice(0, 5),
                ].map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm"
                  >
                    <Link
                      href={
                        a.opportunityId
                          ? `/o/${orgId}/revenue/deals/${a.opportunityId}`
                          : a.customerId
                            ? `/o/${orgId}/revenue/customers/${a.customerId}`
                            : a.leadId
                              ? `/o/${orgId}/leads/${a.leadId}`
                              : `/o/${orgId}/revenue`
                      }
                      className="min-w-0 truncate text-ink hover:underline"
                    >
                      {a.title ?? t(`revenue.activity.${a.kind}`)}
                    </Link>
                    <span
                      dir="ltr"
                      className={
                        a.dueDate && a.dueDate < asOf
                          ? "text-xs text-danger"
                          : "text-xs text-ink-muted"
                      }
                    >
                      {a.dueDate ? formatDate(a.dueDate, { locale }) : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            failed(t("revenue.queue.title"))
          )}
        </Card>

        <Card>
          <CardHeader title={t("revenue.stalled_deals")} />
          {forecast.ok && forecast.data ? (
            forecast.data.stalled.length === 0 ? (
              <EmptyState title={t("revenue.stalled_none")} />
            ) : (
              <ul className="flex flex-col gap-1">
                {forecast.data.stalled.slice(0, 8).map((o) => (
                  <li
                    key={o.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm"
                  >
                    <Link
                      href={`/o/${orgId}/revenue/deals/${o.id}`}
                      className="min-w-0 truncate text-ink hover:underline"
                    >
                      {o.name}
                      {o.customerName ? (
                        <span className="text-ink-muted"> · {o.customerName}</span>
                      ) : null}
                    </Link>
                    <span className="shrink-0 text-xs text-warning">
                      {o.stageAgeDays} {t("revenue.days")}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : seesForecast ? (
            failed(t("revenue.stalled_deals"))
          ) : (
            <p className="text-sm text-ink-muted">{t("common.restricted")}</p>
          )}
        </Card>
      </div>

      {seesForecast ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader
              title={t("revenue.tab.targets")}
              meta={
                <Link
                  href={`/o/${orgId}/revenue/targets`}
                  className="text-xs text-brand hover:underline"
                >
                  {t("common.view_all")}
                </Link>
              }
            />
            {targets.ok ? (
              targets.data.length === 0 ? (
                <EmptyState title={t("revenue.targets.none")} />
              ) : (
                <ul className="flex flex-col gap-2">
                  {targets.data.slice(0, 5).map((tp) => (
                    <li key={tp.id} className="flex flex-col gap-1 text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="truncate text-ink">
                          {t(`revenue.metric.${tp.metric}`)}
                          {tp.scopeName ? ` · ${tp.scopeName}` : ""}
                        </span>
                        <span className="text-xs text-ink-muted" dir="ltr">
                          {tp.progressPct === null ? "—" : `${Math.round(tp.progressPct)}%`}
                        </span>
                      </div>
                      <div className="h-2 w-full rounded bg-sunken" aria-hidden>
                        <div
                          className="h-2 rounded bg-brand"
                          style={{ width: `${Math.min(100, Math.max(0, tp.progressPct ?? 0))}%` }}
                        />
                      </div>
                      <span className="text-xs text-ink-muted">{tp.basis}</span>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              failed(t("revenue.tab.targets"))
            )}
          </Card>
          <Card>
            <CardHeader
              title={t("revenue.tab.campaigns")}
              meta={
                <Link
                  href={`/o/${orgId}/revenue/campaigns`}
                  className="text-xs text-brand hover:underline"
                >
                  {t("common.view_all")}
                </Link>
              }
            />
            {campaigns.ok ? (
              campaigns.data.length === 0 ? (
                <EmptyState title={t("revenue.campaigns.none")} />
              ) : (
                <ul className="flex flex-col gap-1">
                  {campaigns.data.slice(0, 5).map((c) => (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate text-ink">{c.name}</span>
                      <span className="flex gap-2 text-xs text-ink-muted">
                        <Badge tone={c.status === "active" ? "success" : "neutral"}>
                          {t(`revenue.campaign_status.${c.status}`)}
                        </Badge>
                        <span>
                          {c.leads} {t("revenue.tab.leads")} · {c.opportunities}{" "}
                          {t("revenue.kpi.open")}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              failed(t("revenue.tab.campaigns"))
            )}
          </Card>
        </div>
      ) : null}

      {automations.ok && automations.data.length > 0 ? (
        <p className="text-xs text-ink-muted">
          {t("revenue.automations.summary", {
            enabled: automations.data.filter((a) => a.enabled).length,
            total: automations.data.length,
          })}{" "}
          <Link href={`/o/${orgId}/revenue/automations`} className="text-brand hover:underline">
            {t("common.view_all")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
