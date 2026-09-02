import Link from "next/link";
import { Badge, Button, Card, CardHeader, EmptyState } from "@/platform/ui";
import { can } from "@/platform/authz";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { listMembers } from "@/platform/auth/identity";
import {
  applyOverlay,
  computeForecast,
  forecastAccuracy,
  listPipelines,
  listScenarios,
  listStageSettings,
  summarise,
  type ForecastBucket,
} from "@/modules/crm/service";
import { orgToday } from "@/modules/dashboard/service";
import { localeText, pct, resolveRevenue, section, tabLabels } from "../shared";
import { RevenueTabs } from "../RevenueTabs";
import { ScenarioBuilder } from "./ScenarioBuilder";
import { applyScenarioAction, captureSnapshotAction } from "./actions";

const input = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-sm text-ink";
const field = "flex flex-col gap-1 text-xs text-ink-muted";

/**
 * H27 — the forecast: deterministic and explainable. Every figure names the
 * model that produced it; weighted values are expectations, never promised
 * revenue; snapshots are kept so accuracy can be measured; scenarios are
 * overlays until an owner applies them through the governed commands.
 */
export default async function ForecastPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { resolved, t, locale } = await resolveRevenue(orgId, "crm.forecast.view");
  const seesPrice = resolved.ctx.pricePrivileged;
  const currency = resolved.baseCurrency as CurrencyCode;
  const asOf = orgToday(new Date(), resolved.timezone);
  const canApply = can(resolved.archetype, "pipeline.configure");
  const money = (n: number | null | undefined) =>
    seesPrice && n !== null && n !== undefined
      ? formatMoney(n, currency, { locale })
      : t("common.restricted");

  const [forecast, pipelines, stages, members, accuracy, scenarios] = await Promise.all([
    computeForecast(resolved.ctx, resolved.archetype, {
      pipelineId: sp.pipeline || null,
      ownerUserId: sp.owner || null,
      kind: sp.kind || null,
      from: sp.from || null,
      to: sp.to || null,
      stalledDays: sp.stalled ? Number(sp.stalled) : 30,
    }),
    listPipelines(resolved.ctx, resolved.archetype),
    listStageSettings(resolved.ctx, resolved.archetype, sp.pipeline || null),
    can(resolved.archetype, "members.view")
      ? listMembers(resolved.ctx, resolved.archetype)
      : Promise.resolve([]),
    section(() => forecastAccuracy(resolved.ctx, resolved.archetype, 12)),
    section(() => listScenarios(resolved.ctx, resolved.archetype)),
  ]);
  const scenario =
    sp.scenario && scenarios.ok ? scenarios.data.find((s) => s.id === sp.scenario) : undefined;
  const scenarioSummary = scenario
    ? summarise(applyOverlay(forecast.rows, scenario.overlay))
    : null;
  const liveSummary = summarise(forecast.rows);
  const stageLabel = (key: string) =>
    localeText(stages.find((s) => s.key === key)?.label, locale, key);
  const memberName = (id: string) => members.find((m) => m.userId === id)?.fullName ?? id;
  const bucketTable = (title: string, rows: ForecastBucket[], labelOf: (k: string) => string) => (
    <Card>
      <CardHeader title={title} />
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("common.none")}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-ink-muted">
            <tr>
              <th className="py-1 text-start">{title}</th>
              <th className="py-1 text-end">{t("revenue.board.cards")}</th>
              <th className="py-1 text-end">{t("revenue.value")}</th>
              <th className="py-1 text-end">{t("revenue.weighted")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.key} className="border-t border-line">
                <td className="py-1 text-ink">{labelOf(b.key)}</td>
                <td className="py-1 text-end" dir="ltr">
                  {b.count}
                </td>
                <td className="py-1 text-end font-mono" dir="ltr">
                  {money(b.valueMinor)}
                </td>
                <td className="py-1 text-end font-mono" dir="ltr">
                  {money(b.weightedMinor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
  const period = asOf.slice(0, 7);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("revenue.forecast.title")}</h1>
        <RevenueTabs
          orgId={orgId}
          active="forecast"
          archetype={resolved.archetype}
          labels={tabLabels(t)}
        />
      </header>
      {sp.error ? (
        <Badge tone="danger">{t(`revenue.forecast.error.${sp.error}`)}</Badge>
      ) : sp.ok ? (
        <Badge tone="success">
          {t(`revenue.forecast.ok.${sp.ok}`, {
            applied: sp.applied ?? "0",
            skipped: sp.skipped ?? "0",
            period: sp.period ?? "",
          })}
        </Badge>
      ) : null}
      <p className="text-xs text-ink-muted">{t("revenue.forecast.disclaimer")}</p>

      <Card>
        <form method="get" className="grid grid-cols-2 gap-2 lg:grid-cols-6">
          <label className={field}>
            {t("revenue.pipeline.pipeline")}
            <select name="pipeline" defaultValue={sp.pipeline ?? ""} className={input}>
              <option value="">{t("common.all")}</option>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {localeText(p.name, locale, p.key)}
                </option>
              ))}
            </select>
          </label>
          {members.length > 0 ? (
            <label className={field}>
              {t("revenue.filter.owner")}
              <select name="owner" defaultValue={sp.owner ?? ""} className={input}>
                <option value="">{t("common.all")}</option>
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
            {t("revenue.deal.kind")}
            <select name="kind" defaultValue={sp.kind ?? ""} className={input}>
              <option value="">{t("common.all")}</option>
              {(["new_business", "expansion", "renewal"] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`revenue.kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("common.from")}
            <input
              name="from"
              type="date"
              defaultValue={sp.from ?? ""}
              className={input}
              dir="ltr"
            />
          </label>
          <label className={field}>
            {t("common.to")}
            <input name="to" type="date" defaultValue={sp.to ?? ""} className={input} dir="ltr" />
          </label>
          <div className="flex items-end gap-2">
            <Button type="submit">{t("common.apply")}</Button>
            <Link
              href={`/o/${orgId}/revenue/forecast`}
              className="text-sm text-ink-secondary hover:underline"
            >
              {t("common.clear")}
            </Link>
          </div>
        </form>
      </Card>

      <section
        className="grid grid-cols-2 gap-2 lg:grid-cols-5"
        aria-label={t("revenue.forecast.totals")}
      >
        {[
          ["pipeline", forecast.totals.pipelineMinor, t("revenue.forecast.model_sum")],
          ["weighted", forecast.totals.weightedMinor, forecast.model.weighted],
          ["commit", forecast.totals.commitMinor, t("revenue.forecast.model_commit")],
          ["best_case", forecast.totals.bestCaseMinor, t("revenue.forecast.model_best")],
          ["omitted", forecast.totals.omittedMinor, t("revenue.forecast.model_omitted")],
        ].map(([k, v, model]) => (
          <div
            key={String(k)}
            className="flex flex-col gap-0.5 rounded-lg border border-line bg-card p-3"
          >
            <span className="text-xs text-ink-muted">{t(`revenue.forecast.total.${k}`)}</span>
            <span className="text-lg font-semibold text-ink" dir="ltr">
              {money(Number(v))}
            </span>
            <span className="text-[11px] text-ink-muted" dir="ltr">
              {String(model)}
            </span>
          </div>
        ))}
      </section>

      <Card>
        <CardHeader title={t("revenue.forecast.conversion")} />
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
          {[
            [t("revenue.forecast.won"), forecast.conversion.won],
            [t("revenue.forecast.lost"), forecast.conversion.lost],
            [
              t("revenue.forecast.win_rate"),
              pct(forecast.conversion.winRate === null ? null : forecast.conversion.winRate * 100),
            ],
            [
              t("revenue.forecast.cycle"),
              forecast.conversion.avgCycleDays === null
                ? "—"
                : `${Math.round(forecast.conversion.avgCycleDays)} ${t("revenue.days")}`,
            ],
            [t("revenue.forecast.avg_won"), money(forecast.conversion.avgWonMinor)],
            [
              t("revenue.forecast.velocity"),
              forecast.conversion.velocityMinorPerDay === null
                ? "—"
                : `${money(Math.round(forecast.conversion.velocityMinorPerDay))}/${t("revenue.day")}`,
            ],
          ].map(([k, v]) => (
            <div key={String(k)} className="rounded-md border border-line px-3 py-2">
              <dt className="text-xs text-ink-muted">{k}</dt>
              <dd className="font-medium text-ink" dir="ltr">
                {String(v)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-ink-muted" dir="ltr">
          {t("revenue.forecast.model_label")}: {forecast.model.velocity}
        </p>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {bucketTable(t("revenue.forecast.by_month"), forecast.byPeriod.month, (k) => k)}
        {bucketTable(t("revenue.forecast.by_quarter"), forecast.byPeriod.quarter, (k) => k)}
        {bucketTable(t("revenue.filter.owner"), forecast.byOwner, (k) =>
          k === "unassigned" ? t("revenue.unassigned") : memberName(k),
        )}
        <Card>
          <CardHeader title={t("revenue.forecast.by_stage")} />
          <table className="w-full text-sm">
            <thead className="text-xs text-ink-muted">
              <tr>
                <th className="py-1 text-start">{t("revenue.board.move_to")}</th>
                <th className="py-1 text-end">{t("revenue.board.cards")}</th>
                <th className="py-1 text-end">{t("revenue.weighted")}</th>
                <th className="py-1 text-end">{t("revenue.forecast.avg_age")}</th>
              </tr>
            </thead>
            <tbody>
              {forecast.byStage.map((b) => (
                <tr key={b.key} className="border-t border-line">
                  <td className="py-1 text-ink">{stageLabel(b.key)}</td>
                  <td className="py-1 text-end" dir="ltr">
                    {b.count}
                  </td>
                  <td className="py-1 text-end font-mono" dir="ltr">
                    {money(b.weightedMinor)}
                  </td>
                  <td className="py-1 text-end" dir="ltr">
                    {Math.round(b.avgAgeDays)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card>
        <CardHeader
          title={t("revenue.stalled_deals")}
          meta={
            <span className="text-xs text-ink-muted">
              {t("revenue.forecast.stalled_hint", { n: sp.stalled ?? 30 })}
            </span>
          }
        />
        {forecast.stalled.length === 0 ? (
          <EmptyState title={t("revenue.stalled_none")} />
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {forecast.stalled.slice(0, 20).map((o) => (
              <li key={o.id} className="flex justify-between gap-2">
                <Link
                  href={`/o/${orgId}/revenue/deals/${o.id}`}
                  className="truncate text-ink hover:underline"
                >
                  {o.name}
                  {o.customerName ? (
                    <span className="text-ink-muted"> · {o.customerName}</span>
                  ) : null}
                </Link>
                <span className="shrink-0 text-xs text-warning" dir="ltr">
                  {o.stageAgeDays} {t("revenue.days")} · {money(o.valueMinor)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("revenue.forecast.snapshots")} />
          <form
            action={captureSnapshotAction.bind(null, orgId)}
            className="flex flex-wrap items-end gap-2"
          >
            <label className={field}>
              {t("revenue.forecast.period")}
              <input
                name="period_key"
                defaultValue={period}
                pattern="[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])"
                className={`${input} w-32`}
                dir="ltr"
              />
            </label>
            <label className={`${field} min-w-40 flex-1`}>
              {t("common.notes")}
              <input name="note" maxLength={500} className={input} />
            </label>
            <Button type="submit" variant="secondary">
              {t("revenue.forecast.capture")}
            </Button>
          </form>
          {accuracy.ok && accuracy.data.length > 0 ? (
            <table className="mt-3 w-full text-sm">
              <thead className="text-xs text-ink-muted">
                <tr>
                  <th className="py-1 text-start">{t("revenue.forecast.period")}</th>
                  <th className="py-1 text-end">{t("revenue.weighted")}</th>
                  <th className="py-1 text-end">{t("revenue.forecast.won")}</th>
                  <th className="py-1 text-end">{t("revenue.forecast.error")}</th>
                  <th className="py-1 text-end">{t("revenue.forecast.commit_hit")}</th>
                </tr>
              </thead>
              <tbody>
                {accuracy.data.map((s) => (
                  <tr key={s.id} className="border-t border-line">
                    <td className="py-1 text-ink" dir="ltr">
                      {s.periodKey}{" "}
                      <span className="text-xs text-ink-muted">
                        {formatDate(s.capturedAt.slice(0, 10), { locale })}
                      </span>
                    </td>
                    <td className="py-1 text-end font-mono" dir="ltr">
                      {money(s.predicted.weightedMinor)}
                    </td>
                    <td className="py-1 text-end font-mono" dir="ltr">
                      {money(s.actual.wonMinor)}
                    </td>
                    <td className="py-1 text-end" dir="ltr">
                      {pct(s.weightedErrorPct)}
                    </td>
                    <td className="py-1 text-end" dir="ltr">
                      {pct(s.commitHitPct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-2 text-xs text-ink-muted">{t("revenue.forecast.no_snapshots")}</p>
          )}
        </Card>

        <Card>
          <CardHeader title={t("revenue.forecast.scenarios")} />
          {scenarios.ok && scenarios.data.length > 0 ? (
            <ul className="mb-3 flex flex-col gap-1 text-sm">
              {scenarios.data.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
                >
                  <span className="text-ink">
                    {s.name}{" "}
                    <Badge tone={s.status === "applied" ? "success" : "neutral"}>
                      {t(`revenue.scenario.${s.status}`)}
                    </Badge>
                  </span>
                  <span className="flex items-center gap-2 text-xs">
                    <Link
                      href={`/o/${orgId}/revenue/forecast?scenario=${s.id}`}
                      className="text-brand hover:underline"
                    >
                      {t("revenue.forecast.compare")}
                    </Link>
                    {canApply && s.status !== "applied" ? (
                      <form
                        action={applyScenarioAction.bind(null, orgId)}
                        className="flex items-center gap-1"
                      >
                        <input type="hidden" name="id" value={s.id} />
                        <input
                          name="reason"
                          required
                          placeholder={t("revenue.board.reason")}
                          maxLength={500}
                          className="min-h-9 w-36 rounded-md border border-line bg-card px-2 text-xs text-ink"
                        />
                        <Button type="submit" variant="ghost" size="md">
                          {t("revenue.forecast.apply")}
                        </Button>
                      </form>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {scenario && scenarioSummary ? (
            <div className="mb-3 rounded-md border border-line p-3 text-sm">
              <p className="mb-1 font-medium text-ink">
                {t("revenue.forecast.compare")}: {scenario.name}
              </p>
              {scenario.assumptions ? (
                <p className="mb-2 text-xs text-ink-muted">{scenario.assumptions}</p>
              ) : null}
              <table className="w-full">
                <thead className="text-xs text-ink-muted">
                  <tr>
                    <th className="py-1 text-start"></th>
                    <th className="py-1 text-end">{t("revenue.forecast.live")}</th>
                    <th className="py-1 text-end">{t("revenue.forecast.scenario")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [t("revenue.board.cards"), liveSummary.count, scenarioSummary.count],
                    [
                      t("revenue.forecast.total.pipeline"),
                      money(liveSummary.pipelineMinor),
                      money(scenarioSummary.pipelineMinor),
                    ],
                    [
                      t("revenue.weighted"),
                      money(liveSummary.weightedMinor),
                      money(scenarioSummary.weightedMinor),
                    ],
                    [
                      t("revenue.forecast.total.commit"),
                      money(liveSummary.commitMinor),
                      money(scenarioSummary.commitMinor),
                    ],
                  ].map(([k, a, b]) => (
                    <tr key={String(k)} className="border-t border-line">
                      <td className="py-1 text-ink">{String(k)}</td>
                      <td className="py-1 text-end font-mono" dir="ltr">
                        {String(a)}
                      </td>
                      <td className="py-1 text-end font-mono" dir="ltr">
                        {String(b)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <ScenarioBuilder
            orgId={orgId}
            deals={forecast.rows.slice(0, 200).map((r) => ({
              id: r.id,
              name: r.customerName ? `${r.name} · ${r.customerName}` : r.name,
            }))}
            dict={{
              title: t("revenue.scenario.build"),
              name: t("revenue.leads.name"),
              assumptions: t("revenue.scenario.assumptions"),
              deal: t("revenue.scenario.deal"),
              change: t("revenue.scenario.change"),
              exclude: t("revenue.scenario.exclude"),
              slip: t("revenue.scenario.slip"),
              probability: t("revenue.deal.probability"),
              category: t("revenue.filter.category"),
              months: t("revenue.scenario.months"),
              add: t("common.add"),
              remove: t("common.remove"),
              save: t("common.save"),
              saved: t("revenue.scenario.saved"),
              failed: t("common.error"),
              forbidden: t("common.forbidden"),
              none: t("revenue.scenario.no_deals"),
              categories: {
                pipeline: t("revenue.category.pipeline"),
                best_case: t("revenue.category.best_case"),
                commit: t("revenue.category.commit"),
                omitted: t("revenue.category.omitted"),
              },
            }}
          />
        </Card>
      </div>
    </div>
  );
}
