import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { cn } from "@/lib/cn";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { listOverdueFollowUps, listPipelineStages, salesOverview } from "@/modules/crm/service";
import {
  opportunitiesHref,
  orgToday,
  parseSalesSearch,
  salesHref,
  SALES_PERIODS,
} from "@/modules/dashboard/service";
import { salesFollowUpDoneAction } from "./actions";

/**
 * H20 — the sales overview. Every number keeps its own label: forecast value
 * is never combined with quoted, invoiced or cash figures, and every count
 * drills down to the exact records behind it.
 */
export default async function SalesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "opportunities.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const { days } = parseSalesSearch(sp);
  const asOf = orgToday(new Date(), resolved.timezone);
  const seesPrice = resolved.ctx.pricePrivileged;
  const currency = resolved.baseCurrency as CurrencyCode;
  const canManage = can(resolved.archetype, "opportunities.manage");

  const [overview, stages, overdue] = await Promise.all([
    salesOverview(resolved.ctx, resolved.archetype, { asOf, days }),
    listPipelineStages(resolved.ctx, resolved.archetype),
    listOverdueFollowUps(resolved.ctx, resolved.archetype, asOf),
  ]);
  const stageLabel = (key: string) => {
    const s = stages.find((x) => x.key === key);
    return s ? (locale === "ar" ? s.label.ar : s.label.en) : key;
  };
  const openTotal = overview.openByStage.reduce((acc, s) => acc + s.count, 0);
  const openForecast = seesPrice
    ? overview.openByStage.reduce((acc, s) => acc + (s.forecastMinor ?? 0), 0)
    : null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={t("sales.title")}
          meta={
            can(resolved.archetype, "pipeline.configure") ? (
              <Link
                href={`/o/${orgId}/settings/pipeline`}
                className="text-sm text-ink-secondary underline underline-offset-2 hover:text-ink"
              >
                {t("sales.configure_pipeline")}
              </Link>
            ) : (
              t("sales.subtitle")
            )
          }
        />
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("sales.period_label")}>
          {SALES_PERIODS.map((d) => (
            <Link
              key={d}
              href={salesHref(orgId, d)}
              aria-current={days === d ? "true" : undefined}
              className={cn(
                "inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium",
                days === d
                  ? "border-ink bg-ink text-card"
                  : "border-line bg-card text-ink-secondary",
              )}
            >
              {t("sales.period_days", { days: d })}
            </Link>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title={t("sales.pipeline.title")} meta={t("sales.pipeline.hint")} />
        {openTotal === 0 ? (
          <p className="text-sm text-ink-secondary">{t("sales.pipeline.empty")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {overview.openByStage.map((s) => (
              <li key={s.stageKey}>
                <Link
                  href={opportunitiesHref(orgId, { stage: s.stageKey, view: "list" })}
                  className="flex min-h-11 flex-wrap items-center gap-3 px-1 py-2 text-sm hover:bg-sunken"
                >
                  <span className="min-w-0 flex-1 font-medium text-ink">
                    {stageLabel(s.stageKey)}
                  </span>
                  <span className="text-ink-secondary">
                    {t("opps.board.count", { count: s.count })}
                  </span>
                  {/* Zero here would mean "no estimates recorded", not a real
                      figure — suppress it (same rule as the board totals). */}
                  {seesPrice && s.forecastMinor !== null && s.forecastMinor > 0 ? (
                    <span dir="ltr" className="font-mono text-xs text-ink">
                      {formatMoney(s.forecastMinor, currency, { locale })}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {seesPrice && openForecast !== null && openTotal > 0 ? (
          <p className="mt-3 border-t border-line pt-3 text-sm text-ink">
            {t("sales.pipeline.total_label")}{" "}
            <span dir="ltr" className="font-mono">
              {formatMoney(openForecast, currency, { locale })}
            </span>
            <span className="ms-2 text-xs text-ink-secondary">{t("sales.forecast_note")}</span>
          </p>
        ) : null}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("sales.closed.title", { days })} />
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border border-line bg-card p-3">
              <dt className="text-ink-secondary">{t("sales.closed.won")}</dt>
              <dd className="text-lg font-semibold text-ink" dir="ltr">
                {overview.wonCount}
              </dd>
              {seesPrice && overview.wonForecastMinor !== null && overview.wonForecastMinor > 0 ? (
                <dd className="text-xs text-ink-secondary" dir="ltr">
                  {formatMoney(overview.wonForecastMinor, currency, { locale })}
                </dd>
              ) : null}
            </div>
            <div className="rounded-lg border border-line bg-card p-3">
              <dt className="text-ink-secondary">{t("sales.closed.lost")}</dt>
              <dd className="text-lg font-semibold text-ink" dir="ltr">
                {overview.lostCount}
              </dd>
              {seesPrice &&
              overview.lostForecastMinor !== null &&
              overview.lostForecastMinor > 0 ? (
                <dd className="text-xs text-ink-secondary" dir="ltr">
                  {formatMoney(overview.lostForecastMinor, currency, { locale })}
                </dd>
              ) : null}
            </div>
            <div className="rounded-lg border border-line bg-card p-3">
              <dt className="text-ink-secondary">{t("sales.leads_created")}</dt>
              <dd className="text-lg font-semibold text-ink" dir="ltr">
                {overview.leadsCreated}
              </dd>
            </div>
            <div className="rounded-lg border border-line bg-card p-3">
              <dt className="text-ink-secondary">{t("sales.leads_converted")}</dt>
              <dd className="text-lg font-semibold text-ink" dir="ltr">
                {overview.leadsConverted}
              </dd>
            </div>
          </dl>
          {seesPrice && (overview.wonCount > 0 || overview.lostCount > 0) ? (
            <p className="mt-2 text-xs text-ink-secondary">{t("sales.closed.value_note")}</p>
          ) : null}
        </Card>

        <Card>
          <CardHeader title={t("sales.expected.title")} />
          <ul className="flex flex-col gap-2 text-sm">
            <li>
              <Link
                href={opportunitiesHref(orgId, { closing: 7, view: "list" })}
                className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-line bg-card px-3 hover:bg-sunken"
              >
                <span className="text-ink">{t("sales.expected.in7")}</span>
                <span className="font-semibold text-ink" dir="ltr">
                  {overview.closingIn7}
                </span>
              </Link>
            </li>
            <li>
              <Link
                href={opportunitiesHref(orgId, { closing: 30, view: "list" })}
                className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-line bg-card px-3 hover:bg-sunken"
              >
                <span className="text-ink">{t("sales.expected.in30")}</span>
                <span className="font-semibold text-ink" dir="ltr">
                  {overview.closingIn30}
                </span>
              </Link>
            </li>
            <li>
              {/* The count covers lead AND opportunity follow-ups — the
                  complete list lives in this page's own section below. */}
              <Link
                href="#followups"
                className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-line bg-card px-3 hover:bg-sunken"
              >
                <span className="text-ink">{t("sales.expected.overdue_leads")}</span>
                <span className="font-semibold text-ink" dir="ltr">
                  {overview.overdueFollowUps}
                </span>
              </Link>
            </li>
          </ul>
          {overview.lossReasons.length > 0 ? (
            <div className="mt-4 border-t border-line pt-3">
              <p className="mb-2 text-sm font-medium text-ink">{t("sales.loss.title", { days })}</p>
              <ul className="flex flex-col gap-1 text-sm">
                {overview.lossReasons.map((r) => (
                  <li key={r.reason} className="flex items-center justify-between gap-3">
                    <span className="text-ink-secondary">{t(`opps.loss.${r.reason}`)}</span>
                    <span className="font-medium text-ink" dir="ltr">
                      {r.count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      </div>

      <Card id="followups">
        <CardHeader title={t("sales.followups.title")} meta={t("sales.followups.hint")} />
        {overdue.length === 0 ? (
          <p className="text-sm text-ink-secondary">{t("sales.followups.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {overdue.map((a) => {
              const done = salesFollowUpDoneAction.bind(null, orgId);
              const href = a.opportunityId
                ? `/o/${orgId}/opportunities/${a.opportunityId}`
                : a.leadId
                  ? `/o/${orgId}/leads/${a.leadId}`
                  : null;
              return (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-card px-3 py-2.5 text-sm"
                >
                  <Badge tone="warning">{t("sales.kind.follow_up")}</Badge>
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-ink">
                    {href ? (
                      <Link href={href} className="underline underline-offset-2">
                        {a.opportunityName ?? a.leadName ?? t("sales.followups.record")}
                      </Link>
                    ) : (
                      (a.opportunityName ?? a.leadName ?? "")
                    )}
                    {a.body ? <span className="text-ink-secondary">{a.body}</span> : null}
                  </span>
                  {a.dueDate ? (
                    <span className="text-xs text-ink-secondary" dir="ltr">
                      {t("sales.activity.due_on", { date: formatDate(a.dueDate, { locale }) })}
                    </span>
                  ) : null}
                  {a.ownerName ? (
                    <span className="text-xs text-ink-secondary">{a.ownerName}</span>
                  ) : null}
                  {canManage ? (
                    <form action={done}>
                      <input type="hidden" name="activity_id" value={a.id} />
                      <Button type="submit" variant="ghost">
                        {t("sales.activity.mark_done")}
                      </Button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
