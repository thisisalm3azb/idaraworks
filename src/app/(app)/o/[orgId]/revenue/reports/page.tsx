import { revenueStudioEnabled } from "@/platform/flags";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { can } from "@/platform/authz";
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import {
  activityReport,
  funnelReport,
  listStageSettings,
  winLossReport,
} from "@/modules/crm/service";
import { orgToday } from "@/modules/dashboard/service";
import { localeText, pct, resolveRevenue, section, tabLabels } from "../shared";
import { RevenueTabs } from "../RevenueTabs";

const input = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-sm text-ink";
const field = "flex flex-col gap-1 text-xs text-ink-muted";

/**
 * H27 — reports: funnel, activity and win/loss over a date range, every
 * figure an aggregate over the full result with its basis stated; CSV
 * exports through the governed export route; a branded PDF through the
 * document shell.
 */
export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  if (!revenueStudioEnabled()) notFound(); // page-level gate: layouts and pages render concurrently
  const { orgId } = await params;
  const sp = await searchParams;
  const { resolved, t, locale } = await resolveRevenue(orgId, "crm.forecast.view");
  const seesPrice = resolved.ctx.pricePrivileged;
  const currency = resolved.baseCurrency as CurrencyCode;
  const asOf = orgToday(new Date(), resolved.timezone);
  const from =
    sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? sp.from : `${asOf.slice(0, 4)}-01-01`;
  const to = sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? sp.to : asOf;
  const money = (n: number | null | undefined) =>
    seesPrice && n !== null && n !== undefined
      ? formatMoney(n, currency, { locale })
      : t("common.restricted");
  const [funnel, activity, winLoss, stages] = await Promise.all([
    section(() => funnelReport(resolved.ctx, resolved.archetype, { from, to })),
    section(() => activityReport(resolved.ctx, resolved.archetype, { from, to })),
    section(() => winLossReport(resolved.ctx, resolved.archetype, { from, to })),
    listStageSettings(resolved.ctx, resolved.archetype, null),
  ]);
  const stageLabel = (key: string) =>
    localeText(stages.find((s) => s.key === key)?.label, locale, key);
  const qs = `from=${from}&to=${to}`;
  const canExport = can(resolved.archetype, "data.export");
  const failed = (label: string) => (
    <p className="text-sm text-danger">{t("revenue.section_failed", { section: label })}</p>
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("revenue.reports.title")}</h1>
        <RevenueTabs
          orgId={orgId}
          active="reports"
          archetype={resolved.archetype}
          labels={tabLabels(t)}
        />
      </header>

      <Card>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className={field}>
            {t("common.from")}
            <input name="from" type="date" defaultValue={from} className={input} dir="ltr" />
          </label>
          <label className={field}>
            {t("common.to")}
            <input name="to" type="date" defaultValue={to} className={input} dir="ltr" />
          </label>
          <Button type="submit" variant="secondary">
            {t("common.apply")}
          </Button>
          <span className="ms-auto flex flex-wrap gap-2 text-sm">
            <a
              href={`/api/o/${orgId}/revenue/report?${qs}&format=pdf`}
              className="inline-flex min-h-11 items-center rounded-md border border-line px-3 text-ink hover:bg-sunken"
            >
              {t("revenue.reports.pdf")}
            </a>
            {canExport ? (
              <>
                {(["leads", "opportunities", "sales_activities"] as const).map((e) => (
                  <a
                    key={e}
                    href={`/api/o/${orgId}/export?entity=${e}`}
                    download
                    className="inline-flex min-h-11 items-center rounded-md border border-line px-3 text-ink hover:bg-sunken"
                  >
                    {t("revenue.reports.csv", { entity: t(`export.entity.${e}`) })}
                  </a>
                ))}
              </>
            ) : null}
          </span>
        </form>
      </Card>

      <Card>
        <CardHeader title={t("revenue.reports.funnel")} />
        {funnel.ok ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 text-sm">
              {[
                [t("revenue.tab.leads"), funnel.data.leads.total, `/o/${orgId}/revenue/leads`],
                [
                  t("revenue.quarantine.quarantined"),
                  funnel.data.leads.quarantined,
                  `/o/${orgId}/revenue/leads?quarantine=quarantined`,
                ],
                [
                  t("revenue.reports.opportunities_created"),
                  funnel.data.opportunities.created,
                  `/o/${orgId}/revenue/pipeline?status=all`,
                ],
                [
                  t("revenue.kpi.open"),
                  funnel.data.opportunities.open,
                  `/o/${orgId}/revenue/pipeline`,
                ],
                [
                  t("revenue.forecast.won"),
                  funnel.data.opportunities.won.count,
                  `/o/${orgId}/revenue/pipeline?status=won`,
                ],
                [
                  t("revenue.forecast.lost"),
                  funnel.data.opportunities.lost.count,
                  `/o/${orgId}/revenue/pipeline?status=lost`,
                ],
              ].map(([k, v, href]) => (
                <Link
                  key={String(k)}
                  href={String(href)}
                  className="rounded-md border border-line px-3 py-2 hover:bg-sunken"
                >
                  <span className="block text-xs text-ink-muted">{String(k)}</span>
                  <span className="text-lg font-semibold text-ink" dir="ltr">
                    {String(v)}
                  </span>
                </Link>
              ))}
            </div>
            <p className="text-sm text-ink">
              {t("revenue.reports.lead_to_opp")}:{" "}
              <strong dir="ltr">{pct(funnel.data.conversion.leadToOpportunityPct)}</strong> ·{" "}
              {t("revenue.reports.opp_to_won")}:{" "}
              <strong dir="ltr">{pct(funnel.data.conversion.opportunityToWonPct)}</strong> ·{" "}
              {t("revenue.forecast.won")} {money(funnel.data.opportunities.won.valueMinor)}
            </p>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <div className="w-0 min-w-full overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-ink-muted">
                    <tr>
                      <th className="py-1 text-start">{t("revenue.lead_status.title")}</th>
                      <th className="py-1 text-end">#</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(funnel.data.leads.byStatus).map(([k, n]) => (
                      <tr key={k} className="border-t border-line">
                        <td className="py-1 text-ink">{t(`revenue.lead_status.${k}`)}</td>
                        <td className="py-1 text-end" dir="ltr">
                          {n}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="w-0 min-w-full overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-ink-muted">
                    <tr>
                      <th className="py-1 text-start">{t("revenue.leads.source_kind")}</th>
                      <th className="py-1 text-end">#</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(funnel.data.leads.bySource).map(([k, n]) => (
                      <tr key={k} className="border-t border-line">
                        <td className="py-1 text-ink">{t(`revenue.source.${k}`)}</td>
                        <td className="py-1 text-end" dir="ltr">
                          {n}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="w-0 min-w-full overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-ink-muted">
                    <tr>
                      <th className="py-1 text-start">{t("revenue.board.move_to")}</th>
                      <th className="py-1 text-end">#</th>
                      <th className="py-1 text-end">{t("revenue.value")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {funnel.data.opportunities.byStage.map((s) => (
                      <tr key={s.stageKey} className="border-t border-line">
                        <td className="py-1 text-ink">{stageLabel(s.stageKey)}</td>
                        <td className="py-1 text-end" dir="ltr">
                          {s.count}
                        </td>
                        <td className="py-1 text-end font-mono" dir="ltr">
                          {money(s.valueMinor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="text-xs text-ink-muted">{funnel.data.basis}</p>
          </div>
        ) : (
          failed(t("revenue.reports.funnel"))
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("revenue.reports.win_loss")} />
          {winLoss.ok ? (
            <div className="flex flex-col gap-2 text-sm">
              <p className="text-ink">
                {t("revenue.forecast.won")} <strong dir="ltr">{winLoss.data.won.count}</strong> (
                {money(winLoss.data.won.valueMinor)}) · {t("revenue.forecast.lost")}{" "}
                <strong dir="ltr">{winLoss.data.lost.count}</strong> (
                {money(winLoss.data.lost.valueMinor)}) · {t("revenue.forecast.win_rate")}{" "}
                <strong dir="ltr">{pct(winLoss.data.winRatePct)}</strong> ·{" "}
                {t("revenue.forecast.cycle")}{" "}
                <strong dir="ltr">
                  {winLoss.data.won.avgCycleDays === null
                    ? "—"
                    : `${Math.round(winLoss.data.won.avgCycleDays)} ${t("revenue.days")}`}
                </strong>
              </p>
              <div className="w-0 min-w-full overflow-x-auto">
                <table className="w-full">
                  <thead className="text-xs text-ink-muted">
                    <tr>
                      <th className="py-1 text-start">{t("revenue.reports.loss_reason")}</th>
                      <th className="py-1 text-end">#</th>
                    </tr>
                  </thead>
                  <tbody>
                    {winLoss.data.lossReasons.map((r) => (
                      <tr key={r.reason} className="border-t border-line">
                        <td className="py-1 text-ink">{r.reason}</td>
                        <td className="py-1 text-end" dir="ltr">
                          {r.count}
                        </td>
                      </tr>
                    ))}
                    {winLoss.data.lossReasons.length === 0 ? (
                      <tr>
                        <td className="py-1 text-ink-muted" colSpan={2}>
                          {t("common.none")}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              <div className="w-0 min-w-full overflow-x-auto">
                <table className="w-full">
                  <thead className="text-xs text-ink-muted">
                    <tr>
                      <th className="py-1 text-start">{t("revenue.filter.owner")}</th>
                      <th className="py-1 text-end">{t("revenue.forecast.won")}</th>
                      <th className="py-1 text-end">{t("revenue.forecast.lost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {winLoss.data.byOwner.map((o) => (
                      <tr key={o.ownerUserId ?? "none"} className="border-t border-line">
                        <td className="py-1 text-ink">{o.ownerName ?? t("revenue.unassigned")}</td>
                        <td className="py-1 text-end" dir="ltr">
                          {o.won}
                        </td>
                        <td className="py-1 text-end" dir="ltr">
                          {o.lost}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-ink-muted">{winLoss.data.basis}</p>
            </div>
          ) : (
            failed(t("revenue.reports.win_loss"))
          )}
        </Card>
        <Card>
          <CardHeader
            title={t("revenue.reports.activity")}
            meta={activity.ok ? <Badge tone="brand">{activity.data.total}</Badge> : null}
          />
          {activity.ok ? (
            <div className="flex flex-col gap-2 text-sm">
              <div className="w-0 min-w-full overflow-x-auto">
                <table className="w-full">
                  <thead className="text-xs text-ink-muted">
                    <tr>
                      <th className="py-1 text-start">{t("revenue.activity.kind")}</th>
                      <th className="py-1 text-end">#</th>
                      <th className="py-1 text-end">{t("revenue.reports.completed")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.data.byKind.map((k) => (
                      <tr key={k.kind} className="border-t border-line">
                        <td className="py-1 text-ink">{t(`revenue.activity.${k.kind}`)}</td>
                        <td className="py-1 text-end" dir="ltr">
                          {k.count}
                        </td>
                        <td className="py-1 text-end" dir="ltr">
                          {k.completed}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="w-0 min-w-full overflow-x-auto">
                <table className="w-full">
                  <thead className="text-xs text-ink-muted">
                    <tr>
                      <th className="py-1 text-start">{t("revenue.filter.owner")}</th>
                      <th className="py-1 text-end">#</th>
                      <th className="py-1 text-end">{t("revenue.reports.completed")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.data.byOwner.map((o) => (
                      <tr key={o.ownerUserId ?? "none"} className="border-t border-line">
                        <td className="py-1 text-ink">{o.ownerName ?? t("revenue.unassigned")}</td>
                        <td className="py-1 text-end" dir="ltr">
                          {o.count}
                        </td>
                        <td className="py-1 text-end" dir="ltr">
                          {o.completed}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {activity.data.byOutcome.length > 0 ? (
                <p className="text-xs text-ink-muted">
                  {t("revenue.activity.outcome")}:{" "}
                  {activity.data.byOutcome
                    .map((o) => `${t(`revenue.outcome.${o.outcome}`)} ${o.count}`)
                    .join(" · ")}
                </p>
              ) : null}
              <p className="text-xs text-ink-muted">{activity.data.basis}</p>
              <p className="text-xs text-ink-muted">{t("revenue.reports.no_surveillance")}</p>
            </div>
          ) : (
            failed(t("revenue.reports.activity"))
          )}
        </Card>
      </div>
    </div>
  );
}
