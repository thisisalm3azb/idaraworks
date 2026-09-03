import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState } from "@/platform/ui";
import { can } from "@/platform/authz";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { listMembers } from "@/platform/auth/identity";
import {
  ACTIVITY_KINDS,
  ACTIVITY_OUTCOMES,
  crmAiAvailability,
  gatherDealRoom,
  getDealCanvas,
  getOpportunityCommercial,
  listActivities,
  listStageSettings,
} from "@/modules/crm/service";
import { listCustomerContacts } from "@/modules/masters/service";
import { localeText, resolveRevenue, section, tabLabels } from "../../shared";
import { RevenueTabs } from "../../RevenueTabs";
import { LazyCanvas } from "./LazyCanvas";
import { AiPane } from "./AiPane";
import {
  addCompetitorAction,
  addProductLineAction,
  addRiskAction,
  addStakeholderAction,
  logDealActivityAction,
  moveStageFormAction,
  requestDiscountAction,
  setRiskStatusAction,
  updateCommercialAction,
} from "./actions";

const TABS = [
  "overview",
  "stakeholders",
  "products",
  "risks",
  "commercial",
  "history",
  "canvas",
  "assistant",
] as const;
type Tab = (typeof TABS)[number];
const ROLE_KINDS = [
  "decision_maker",
  "economic_buyer",
  "influencer",
  "champion",
  "user",
  "procurement",
  "finance",
  "technical",
  "blocker",
  "other",
] as const;
const input = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-sm text-ink";
const field = "flex flex-col gap-1 text-xs text-ink-muted";

/**
 * H27 — the deal room: one opportunity with its stakeholders and coverage,
 * products and totals, competitors and risks, commercial context, discount
 * requests (approved by a person), stage and forecast history, an optional
 * canvas and the fail-closed assistant. Winning stays an explicit act on the
 * H20 page; stage moves go through the governed command.
 */
export default async function DealRoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; opportunityId: string }>;
  searchParams: Promise<{ tab?: string; ok?: string; error?: string; unmet?: string }>;
}) {
  const { orgId, opportunityId } = await params;
  const sp = await searchParams;
  const { resolved, t, locale } = await resolveRevenue(orgId, "opportunities.view");
  const canManage = can(resolved.archetype, "opportunities.manage");
  const seesPrice = resolved.ctx.pricePrivileged;
  const tab: Tab = TABS.includes(sp.tab as Tab) ? (sp.tab as Tab) : "overview";
  const o = await getOpportunityCommercial(resolved.ctx, resolved.archetype, opportunityId);
  if (!o) notFound();
  const currency = (o.currency ?? resolved.baseCurrency) as CurrencyCode;
  const money = (n: number | null | undefined) =>
    seesPrice && n !== null && n !== undefined ? formatMoney(n, currency, { locale }) : null;
  const [stages, room, activities, canvas, ai, contacts, members] = await Promise.all([
    listStageSettings(resolved.ctx, resolved.archetype, o.pipelineId),
    gatherDealRoom(resolved.ctx, resolved.archetype, opportunityId),
    tab === "history"
      ? section(() =>
          listActivities(resolved.ctx, resolved.archetype, { opportunityId, limit: 60 }),
        )
      : Promise.resolve(null),
    tab === "canvas" ? getDealCanvas(resolved.ctx, resolved.archetype, opportunityId) : null,
    tab === "assistant" ? crmAiAvailability(resolved.ctx) : null,
    o.customerId && canManage
      ? section(() => listCustomerContacts(resolved.ctx, resolved.archetype, o.customerId!))
      : Promise.resolve(null),
    canManage && can(resolved.archetype, "members.view")
      ? section(() => listMembers(resolved.ctx, resolved.archetype))
      : Promise.resolve(null),
  ]);
  const stage = stages.find((s) => s.key === o.stageKey);
  const stageLabel = (key: string) =>
    localeText(stages.find((s) => s.key === key)?.label, locale, key);
  const base = `/o/${orgId}/revenue/deals/${opportunityId}`;
  const act = <F extends (o: string, id: string, f: FormData) => Promise<void>>(a: F) =>
    a.bind(null, orgId, opportunityId);
  const tabHref = (k: Tab) => (k === "overview" ? base : `${base}?tab=${k}`);
  const catTone =
    o.forecastCategory === "commit"
      ? "success"
      : o.forecastCategory === "omitted"
        ? "neutral"
        : "info";

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-ink">{o.name}</h1>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
              {o.customerId ? (
                <Link
                  href={`/o/${orgId}/revenue/customers/${o.customerId}`}
                  className="hover:underline"
                >
                  {o.customerName}
                </Link>
              ) : (
                <span>{t("revenue.deal.no_customer")}</span>
              )}
              <Badge
                tone={o.status === "won" ? "success" : o.status === "lost" ? "danger" : "brand"}
              >
                {stageLabel(o.stageKey)}
              </Badge>
              <Badge tone={catTone}>{t(`revenue.category.${o.forecastCategory}`)}</Badge>
              <span>{t(`revenue.kind.${o.kind}`)}</span>
              {money(o.estimatedValueMinor) ? (
                <span dir="ltr" className="font-mono text-ink">
                  {money(o.estimatedValueMinor)}
                </span>
              ) : null}
              {o.probability !== null ? <span dir="ltr">{o.probability}%</span> : null}
              {o.expectedCloseDate ? (
                <span dir="ltr">{formatDate(o.expectedCloseDate, { locale })}</span>
              ) : null}
              {o.ownerName ? <span>{o.ownerName}</span> : null}
              <span
                className={
                  stage?.maxAgeDays !== null &&
                  stage?.maxAgeDays !== undefined &&
                  o.stageAgeDays > stage.maxAgeDays
                    ? "text-warning"
                    : ""
                }
              >
                {o.stageAgeDays} {t("revenue.days")}
              </span>
            </p>
          </div>
          <Link
            href={`/o/${orgId}/opportunities/${opportunityId}`}
            className="inline-flex min-h-10 items-center rounded-md border border-line px-3 text-sm text-ink hover:bg-sunken"
          >
            {t("revenue.deal.classic_page")}
          </Link>
        </div>
        <RevenueTabs
          orgId={orgId}
          active="pipeline"
          archetype={resolved.archetype}
          labels={tabLabels(t)}
        />
      </header>
      {sp.error ? (
        <p className="rounded-md border border-danger p-2 text-sm text-danger">
          {t(`revenue.deal.error.${sp.error}`)}
          {sp.unmet
            ? `: ${sp.unmet
                .split(",")
                .map((u) => t(`revenue.requirement.${u}`))
                .join(", ")}`
            : ""}
        </p>
      ) : sp.ok ? (
        <Badge tone="success">{t(`revenue.deal.ok.${sp.ok}`)}</Badge>
      ) : null}

      <nav
        aria-label={t("revenue.deal.tabs")}
        className="flex w-0 min-w-full gap-1 overflow-x-auto [scrollbar-width:thin]"
      >
        {TABS.map((k) => (
          <Link
            key={k}
            href={tabHref(k)}
            aria-current={k === tab ? "page" : undefined}
            className={`inline-flex min-h-10 shrink-0 items-center rounded-md px-3 text-sm ${
              k === tab ? "bg-sunken font-medium text-ink" : "text-ink-secondary hover:text-ink"
            }`}
          >
            {t(`revenue.deal.tab.${k}`)}
            {k === "risks" && room.risks.filter((r) => r.status === "open").length > 0
              ? ` (${room.risks.filter((r) => r.status === "open").length})`
              : ""}
          </Link>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader title={t("revenue.deal.coverage")} />
            <ul className="flex flex-col gap-1 text-sm">
              {(["decisionMaker", "champion", "economicBuyer"] as const).map((k) => (
                <li key={k} className="flex justify-between">
                  <span className="text-ink">{t(`revenue.deal.coverage_${k}`)}</span>
                  <Badge tone={room.coverage[k] ? "success" : "warning"}>
                    {room.coverage[k] ? t("common.yes") : t("common.no")}
                  </Badge>
                </li>
              ))}
              <li className="flex justify-between">
                <span className="text-ink">{t("revenue.deal.blockers")}</span>
                <Badge tone={room.coverage.blockers > 0 ? "danger" : "neutral"}>
                  {room.coverage.blockers}
                </Badge>
              </li>
            </ul>
            {o.nextAction ? (
              <p className="mt-3 text-sm text-ink">
                <span className="text-xs text-ink-muted">{t("revenue.deal.next_action")}: </span>
                {o.nextAction}
                {o.nextActionDue ? (
                  <span className="text-ink-muted" dir="ltr">
                    {" "}
                    {formatDate(o.nextActionDue, { locale })}
                  </span>
                ) : null}
              </p>
            ) : null}
          </Card>
          <Card>
            <CardHeader title={t("revenue.board.move")} />
            {canManage && o.status === "open" ? (
              <form action={act(moveStageFormAction)} className="flex flex-col gap-2">
                <input type="hidden" name="row_version" value={o.rowVersion} />
                <label className={field}>
                  {t("revenue.board.move_to")}
                  <select name="stage_key" defaultValue="" className={input} required>
                    <option value="">—</option>
                    {stages
                      .filter((s) => s.active && s.key !== o.stageKey)
                      .map((s) => (
                        <option key={s.key} value={s.key}>
                          {localeText(s.label, locale, s.key)}
                          {s.requirements.length
                            ? ` (${s.requirements.map((r) => t(`revenue.requirement.${r}`)).join(", ")})`
                            : ""}
                        </option>
                      ))}
                  </select>
                </label>
                <label className={field}>
                  {t("revenue.board.reason")}
                  <input name="reason" maxLength={500} className={input} />
                </label>
                <Button type="submit" variant="secondary">
                  {t("revenue.board.confirm")}
                </Button>
              </form>
            ) : (
              <p className="text-sm text-ink-muted">{t("revenue.deal.no_move")}</p>
            )}
          </Card>
          <Card>
            <CardHeader title={t("revenue.deal.linked")} />
            <ul className="flex flex-col gap-1 text-sm">
              {o.quoteId ? (
                <li>
                  <Link
                    href={`/o/${orgId}/quotes/${o.quoteId}`}
                    className="text-brand hover:underline"
                  >
                    {t("revenue.deal.quote")} {o.quoteReference ?? ""}
                  </Link>
                </li>
              ) : null}
              {room.contract ? (
                <li>
                  <Link
                    href={`/o/${orgId}/documents/${room.contract.id}`}
                    className="text-brand hover:underline"
                  >
                    {t("revenue.deal.contract")} {room.contract.reference} · {room.contract.title}
                  </Link>{" "}
                  <Badge tone="neutral">{room.contract.status}</Badge>
                </li>
              ) : null}
              {room.jobs.map((j) => (
                <li key={j.id}>
                  <Link href={`/o/${orgId}/jobs/${j.id}`} className="text-brand hover:underline">
                    {j.reference} · {j.name}
                  </Link>{" "}
                  <Badge tone="neutral">{j.statusCategory}</Badge>
                </li>
              ))}
              {room.invoices.map((i) => (
                <li key={i.id} className="flex justify-between gap-2">
                  <Link
                    href={`/o/${orgId}/invoices/${i.id}`}
                    className="text-brand hover:underline"
                  >
                    {i.reference}
                  </Link>
                  <span className="text-xs text-ink-muted" dir="ltr">
                    {money(i.totalMinor) ?? ""} {i.status}
                  </span>
                </li>
              ))}
              {!o.quoteId &&
              !room.contract &&
              room.jobs.length === 0 &&
              room.invoices.length === 0 ? (
                <li className="text-ink-muted">{t("common.none")}</li>
              ) : null}
            </ul>
          </Card>
        </div>
      ) : null}

      {tab === "stakeholders" ? (
        <Card>
          <CardHeader title={t("revenue.stakeholders")} />
          {room.stakeholders.length === 0 ? (
            <EmptyState title={t("revenue.deal.no_stakeholders")} />
          ) : (
            <ul className="flex flex-col gap-1">
              {room.stakeholders.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm"
                >
                  <span className="text-ink">
                    {s.name}{" "}
                    <span className="text-ink-muted">· {t(`revenue.role.${s.roleKind}`)}</span>
                  </span>
                  <span className="flex gap-2 text-xs">
                    <Badge tone="neutral">
                      {t("revenue.deal.influence")} {s.influence}/5
                    </Badge>
                    <Badge
                      tone={
                        s.sentiment === "supporter"
                          ? "success"
                          : s.sentiment === "detractor"
                            ? "danger"
                            : "neutral"
                      }
                    >
                      {t(`revenue.sentiment.${s.sentiment}`)}
                    </Badge>
                  </span>
                  {s.notes ? (
                    <span className="w-full text-xs text-ink-secondary">{s.notes}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canManage ? (
            <form
              action={act(addStakeholderAction)}
              className="mt-3 grid grid-cols-1 gap-2 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-5"
            >
              {contacts?.ok && contacts.data.length > 0 ? (
                <label className={field}>
                  {t("revenue.customer.contact")}
                  <select name="contact_id" defaultValue="" className={input}>
                    <option value="">—</option>
                    {contacts.data.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className={field}>
                {t("revenue.leads.name")}
                <input name="name" maxLength={120} className={input} />
              </label>
              <label className={field}>
                {t("revenue.customer.role")}
                <select name="role_kind" defaultValue="other" className={input}>
                  {ROLE_KINDS.map((r) => (
                    <option key={r} value={r}>
                      {t(`revenue.role.${r}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={field}>
                {t("revenue.deal.influence")}
                <select name="influence" defaultValue="3" className={input}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className={field}>
                {t("revenue.deal.sentiment")}
                <select name="sentiment" defaultValue="unknown" className={input}>
                  {(["supporter", "neutral", "detractor", "unknown"] as const).map((s) => (
                    <option key={s} value={s}>
                      {t(`revenue.sentiment.${s}`)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="sm:col-span-2 lg:col-span-5">
                <Button type="submit" variant="secondary">
                  {t("revenue.deal.add_stakeholder")}
                </Button>
              </div>
            </form>
          ) : null}
        </Card>
      ) : null}

      {tab === "products" ? (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader
              title={t("revenue.deal.products")}
              meta={
                seesPrice ? (
                  <span className="text-xs text-ink-muted" dir="ltr">
                    {t("revenue.deal.net")} {money(room.totals.netMinor) ?? "—"} ·{" "}
                    {t("revenue.deal.vat")} {money(room.totals.vatMinor) ?? "—"} ·{" "}
                    {t("revenue.deal.total")} {money(room.totals.totalMinor) ?? "—"}
                    {room.totals.marginMinor !== null
                      ? ` · ${t("revenue.deal.margin")} ${money(room.totals.marginMinor)}`
                      : ""}
                    {room.totals.recurringMinor
                      ? ` · ${t("revenue.deal.recurring")} ${money(room.totals.recurringMinor)}`
                      : ""}
                  </span>
                ) : null
              }
            />
            {room.products.length === 0 ? (
              <EmptyState
                title={t("revenue.deal.no_products")}
                description={t("revenue.deal.products_hint")}
              />
            ) : (
              <div className="w-0 min-w-full overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-ink-muted">
                    <tr>
                      <th className="py-1 text-start">{t("common.description")}</th>
                      <th className="py-1 text-end">{t("revenue.deal.qty")}</th>
                      <th className="py-1 text-end">{t("revenue.deal.unit_price")}</th>
                      <th className="py-1 text-end">{t("revenue.deal.discount")}</th>
                      <th className="py-1 text-end">{t("revenue.deal.vat")}</th>
                      <th className="py-1 text-end">{t("revenue.deal.total")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {room.products.map((p) => (
                      <tr key={p.id} className="border-t border-line">
                        <td className="py-1 text-ink">
                          {p.description}
                          {p.optional ? (
                            <Badge tone="neutral">{t("revenue.deal.optional")}</Badge>
                          ) : null}
                          {p.recurrenceMonths ? (
                            <span className="text-xs text-ink-muted">
                              {" "}
                              · /{p.recurrenceMonths}m
                            </span>
                          ) : null}
                        </td>
                        <td className="py-1 text-end" dir="ltr">
                          {p.qty} {p.unit}
                        </td>
                        <td className="py-1 text-end" dir="ltr">
                          {money(p.unitPriceMinor) ?? "—"}
                        </td>
                        <td className="py-1 text-end" dir="ltr">
                          {p.discountPct}%
                        </td>
                        <td className="py-1 text-end" dir="ltr">
                          {p.vatRate}%
                        </td>
                        <td className="py-1 text-end font-mono" dir="ltr">
                          {money(p.lineTotalMinor) ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {canManage && o.status === "open" ? (
              <form
                action={act(addProductLineAction)}
                className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3 lg:grid-cols-7"
              >
                <label className={`${field} col-span-2`}>
                  {t("common.description")}
                  <input name="description" required maxLength={300} className={input} />
                </label>
                <label className={field}>
                  {t("revenue.deal.qty")}
                  <input
                    name="qty"
                    inputMode="decimal"
                    defaultValue="1"
                    className={input}
                    dir="ltr"
                  />
                </label>
                <label className={field}>
                  {t("revenue.deal.unit")}
                  <input name="unit" defaultValue="ea" maxLength={16} className={input} dir="ltr" />
                </label>
                <label className={field}>
                  {t("revenue.deal.unit_price")}
                  <input
                    name="unit_price_major"
                    inputMode="decimal"
                    required
                    className={input}
                    dir="ltr"
                  />
                </label>
                <label className={field}>
                  {t("revenue.deal.discount")} %
                  <input
                    name="discount_pct"
                    inputMode="decimal"
                    defaultValue="0"
                    className={input}
                    dir="ltr"
                  />
                </label>
                <label className={field}>
                  {t("revenue.deal.vat")} %
                  <input
                    name="vat_rate"
                    inputMode="decimal"
                    defaultValue="0"
                    className={input}
                    dir="ltr"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" name="optional" className="size-5" />
                  {t("revenue.deal.optional")}
                </label>
                <label className={field}>
                  {t("revenue.deal.recurrence_months")}
                  <input name="recurrence_months" inputMode="numeric" className={input} dir="ltr" />
                </label>
                <div className="col-span-2 lg:col-span-7">
                  <Button type="submit" variant="secondary">
                    {t("revenue.deal.add_product")}
                  </Button>
                </div>
              </form>
            ) : null}
            <p className="mt-2 text-xs text-ink-muted">{t("revenue.deal.tax_note")}</p>
          </Card>
          <Card>
            <CardHeader title={t("revenue.deal.discounts")} />
            {room.discounts.length === 0 ? (
              <p className="text-sm text-ink-muted">{t("common.none")}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {room.discounts.map((d) => (
                  <li key={d.id} className="flex flex-wrap justify-between gap-2">
                    <span className="text-ink">
                      {d.requestedPct}% · {d.reason}
                    </span>
                    <span className="flex gap-2 text-xs">
                      <Badge
                        tone={
                          d.status === "approved"
                            ? "success"
                            : d.status === "rejected"
                              ? "danger"
                              : "warning"
                        }
                      >
                        {t(`revenue.discount.${d.status}`)}
                      </Badge>
                      <span className="text-ink-muted" dir="ltr">
                        {formatDate(d.createdAt.slice(0, 10), { locale })}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {canManage && o.status === "open" && seesPrice ? (
              <form
                action={act(requestDiscountAction)}
                className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3"
              >
                <label className={field}>
                  {t("revenue.discount.pct")}
                  <input
                    name="requested_pct"
                    inputMode="decimal"
                    required
                    className={`${input} w-24`}
                    dir="ltr"
                  />
                </label>
                <label className={`${field} min-w-60 flex-1`}>
                  {t("revenue.leads.reason")}
                  <input name="reason" required maxLength={500} className={input} />
                </label>
                <Button type="submit" variant="secondary">
                  {t("revenue.discount.request")}
                </Button>
                <span className="w-full text-xs text-ink-muted">{t("revenue.discount.note")}</span>
              </form>
            ) : null}
          </Card>
        </div>
      ) : null}

      {tab === "risks" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title={t("revenue.risks")} />
            {room.risks.length === 0 ? (
              <p className="text-sm text-ink-muted">{t("common.none")}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {room.risks.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-col gap-1 rounded-md border border-line px-3 py-2 text-sm"
                  >
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-ink">
                        <Badge
                          tone={
                            r.severity === "high"
                              ? "danger"
                              : r.severity === "medium"
                                ? "warning"
                                : "neutral"
                          }
                        >
                          {t(`revenue.severity.${r.severity}`)}
                        </Badge>{" "}
                        {r.title}{" "}
                        <span className="text-xs text-ink-muted">
                          · {t(`revenue.risk_kind.${r.kind}`)}
                        </span>
                      </span>
                      <Badge tone={r.status === "open" ? "warning" : "success"}>
                        {t(`revenue.risk_status.${r.status}`)}
                      </Badge>
                    </span>
                    {r.mitigation ? (
                      <span className="text-xs text-ink-secondary">{r.mitigation}</span>
                    ) : null}
                    {canManage && r.status === "open" ? (
                      <form action={act(setRiskStatusAction)} className="flex gap-2">
                        <input type="hidden" name="id" value={r.id} />
                        <Button
                          type="submit"
                          name="status"
                          value="mitigated"
                          variant="ghost"
                          size="md"
                        >
                          {t("revenue.risk_status.mitigated")}
                        </Button>
                        <Button
                          type="submit"
                          name="status"
                          value="closed"
                          variant="ghost"
                          size="md"
                        >
                          {t("revenue.risk_status.closed")}
                        </Button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canManage ? (
              <form
                action={act(addRiskAction)}
                className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3"
              >
                <label className={`${field} col-span-2`}>
                  {t("common.title")}
                  <input name="title" required maxLength={200} className={input} />
                </label>
                <label className={field}>
                  {t("revenue.activity.kind")}
                  <select name="kind" defaultValue="risk" className={input}>
                    {(["risk", "blocker", "dependency"] as const).map((k) => (
                      <option key={k} value={k}>
                        {t(`revenue.risk_kind.${k}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={field}>
                  {t("revenue.severity.title")}
                  <select name="severity" defaultValue="medium" className={input}>
                    {(["low", "medium", "high"] as const).map((k) => (
                      <option key={k} value={k}>
                        {t(`revenue.severity.${k}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={`${field} col-span-2`}>
                  {t("revenue.deal.mitigation")}
                  <input name="mitigation" maxLength={1000} className={input} />
                </label>
                {members?.ok ? (
                  <label className={field}>
                    {t("revenue.filter.owner")}
                    <select name="owner_user_id" defaultValue="" className={input}>
                      <option value="">—</option>
                      {members.data
                        .filter((m) => !m.deactivatedAt)
                        .map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.fullName}
                          </option>
                        ))}
                    </select>
                  </label>
                ) : null}
                <div className="col-span-2">
                  <Button type="submit" variant="secondary">
                    {t("revenue.deal.add_risk")}
                  </Button>
                </div>
              </form>
            ) : null}
          </Card>
          <Card>
            <CardHeader title={t("revenue.deal.competitors")} />
            {room.competitors.length === 0 ? (
              <p className="text-sm text-ink-muted">{t("common.none")}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {room.competitors.map((c) => (
                  <li key={c.id} className="rounded-md border border-line px-3 py-2">
                    <span className="flex justify-between gap-2">
                      <span className="text-ink">{c.name}</span>
                      <Badge tone="neutral">{t(`revenue.competitor_status.${c.status}`)}</Badge>
                    </span>
                    {c.strengths ? (
                      <span className="block text-xs text-ink-secondary">+ {c.strengths}</span>
                    ) : null}
                    {c.weaknesses ? (
                      <span className="block text-xs text-ink-secondary">− {c.weaknesses}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canManage ? (
              <form
                action={act(addCompetitorAction)}
                className="mt-3 grid grid-cols-1 gap-2 border-t border-line pt-3"
              >
                <label className={field}>
                  {t("revenue.leads.name")}
                  <input name="name" required maxLength={120} className={input} />
                </label>
                <label className={field}>
                  {t("revenue.deal.strengths")}
                  <input name="strengths" maxLength={1000} className={input} />
                </label>
                <label className={field}>
                  {t("revenue.deal.weaknesses")}
                  <input name="weaknesses" maxLength={1000} className={input} />
                </label>
                <Button type="submit" variant="secondary">
                  {t("revenue.deal.add_competitor")}
                </Button>
              </form>
            ) : null}
          </Card>
        </div>
      ) : null}

      {tab === "commercial" ? (
        <Card>
          <CardHeader title={t("revenue.deal.tab.commercial")} />
          {canManage && o.status === "open" ? (
            <form
              action={act(updateCommercialAction)}
              className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
            >
              <input type="hidden" name="row_version" value={o.rowVersion} />
              <label className={field}>
                {t("revenue.filter.category")}
                <select
                  name="forecast_category"
                  defaultValue={o.forecastCategory}
                  className={input}
                >
                  {(["pipeline", "best_case", "commit", "omitted"] as const).map((c) => (
                    <option key={c} value={c}>
                      {t(`revenue.category.${c}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={field}>
                {t("revenue.deal.kind")}
                <select name="kind" defaultValue={o.kind} className={input}>
                  {(["new_business", "expansion", "renewal"] as const).map((k) => (
                    <option key={k} value={k}>
                      {t(`revenue.kind.${k}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={field}>
                {t("revenue.deal.amount_kind")}
                <select name="amount_kind" defaultValue={o.amountKind} className={input}>
                  {(["one_time", "recurring", "mixed"] as const).map((k) => (
                    <option key={k} value={k}>
                      {t(`revenue.amount_kind.${k}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={field}>
                {t("revenue.deal.probability")}
                <input
                  name="probability"
                  inputMode="numeric"
                  defaultValue={o.probability ?? ""}
                  className={input}
                  dir="ltr"
                />
              </label>
              <label className={field}>
                {t("revenue.close_date")}
                <input
                  name="close_date"
                  type="date"
                  defaultValue={o.expectedCloseDate ?? ""}
                  className={input}
                  dir="ltr"
                />
              </label>
              <label className={field}>
                {t("revenue.currency")}
                <input
                  name="currency"
                  defaultValue={o.currency ?? resolved.baseCurrency}
                  maxLength={3}
                  className={input}
                  dir="ltr"
                />
              </label>
              <label className={field}>
                {t("revenue.deal.recurring")}
                <input
                  name="recurring_major"
                  inputMode="decimal"
                  defaultValue={o.recurringMinor !== null ? o.recurringMinor / 100 : ""}
                  className={input}
                  dir="ltr"
                />
              </label>
              <label className={field}>
                {t("revenue.deal.recurrence_months")}
                <input
                  name="recurrence_months"
                  inputMode="numeric"
                  defaultValue={o.recurrenceMonths ?? ""}
                  className={input}
                  dir="ltr"
                />
              </label>
              <label className={`${field} sm:col-span-2`}>
                {t("revenue.deal.decision_criteria")}
                <textarea
                  name="decision_criteria"
                  rows={3}
                  maxLength={2000}
                  defaultValue={o.decisionCriteria ?? ""}
                  className={input}
                />
              </label>
              <label className={`${field} sm:col-span-2`}>
                {t("revenue.deal.needs")}
                <textarea
                  name="needs"
                  rows={3}
                  maxLength={4000}
                  defaultValue={o.needs ?? ""}
                  className={input}
                />
              </label>
              <label className={`${field} sm:col-span-2 lg:col-span-4`}>
                {t("revenue.deal.buying_process")}
                <textarea
                  name="buying_process"
                  rows={4}
                  className={input}
                  defaultValue={o.buyingProcess
                    .map(
                      (s) =>
                        `${s.done ? "[x] " : ""}${s.step}${s.owner ? ` | ${s.owner}` : ""}${s.due ? ` | ${s.due}` : ""}`,
                    )
                    .join("\n")}
                />
                <span>{t("revenue.deal.buying_process_hint")}</span>
              </label>
              <div className="sm:col-span-2 lg:col-span-4">
                <Button type="submit">{t("common.save")}</Button>
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-ink-muted">{t("revenue.deal.decision_criteria")}</dt>
              <dd className="text-ink">{o.decisionCriteria ?? "—"}</dd>
              <dt className="text-ink-muted">{t("revenue.deal.needs")}</dt>
              <dd className="text-ink">{o.needs ?? "—"}</dd>
            </dl>
          )}
        </Card>
      ) : null}

      {tab === "history" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title={t("revenue.deal.stage_history")} />
            {room.stageHistory.length === 0 ? (
              <p className="text-sm text-ink-muted">{t("common.none")}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {room.stageHistory.map((h, i) => (
                  <li
                    key={i}
                    className="flex flex-wrap justify-between gap-2 rounded-md border border-line px-3 py-2"
                  >
                    <span className="text-ink">
                      {stageLabel(h.from)} → {stageLabel(h.to)}
                      {h.reason ? <span className="text-ink-muted"> · {h.reason}</span> : null}
                    </span>
                    <span className="text-xs text-ink-muted" dir="ltr">
                      {formatDate(h.at.slice(0, 10), { locale })} {h.actorName ?? ""}
                      {h.ageDays !== null ? ` · ${h.ageDays} ${t("revenue.days")}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {room.forecastHistory.length > 0 ? (
              <>
                <h3 className="mt-3 text-sm font-semibold text-ink">
                  {t("revenue.deal.forecast_history")}
                </h3>
                <ul className="flex flex-col gap-1 text-xs">
                  {room.forecastHistory.map((h, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="text-ink">
                        {t(`revenue.category.${h.from}`)} → {t(`revenue.category.${h.to}`)}
                      </span>
                      <span className="text-ink-muted" dir="ltr">
                        {formatDate(h.at.slice(0, 10), { locale })} {h.actorName ?? ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </Card>
          <Card>
            <CardHeader title={t("revenue.customer.timeline")} />
            {canManage ? (
              <form action={act(logDealActivityAction)} className="mb-3 flex flex-col gap-2">
                <div className="grid grid-cols-3 gap-2">
                  <label className={field}>
                    {t("revenue.activity.kind")}
                    <select name="kind" defaultValue="note" className={input}>
                      {ACTIVITY_KINDS.filter((k) => k !== "custom").map((k) => (
                        <option key={k} value={k}>
                          {t(`revenue.activity.${k}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={field}>
                    {t("revenue.activity.outcome")}
                    <select name="outcome" defaultValue="" className={input}>
                      <option value="">—</option>
                      {ACTIVITY_OUTCOMES.map((k) => (
                        <option key={k} value={k}>
                          {t(`revenue.outcome.${k}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={field}>
                    {t("revenue.activity.due")}
                    <input name="due_date" type="date" className={input} dir="ltr" />
                  </label>
                </div>
                <label className={field}>
                  {t("common.title")}
                  <input name="title" maxLength={200} className={input} />
                </label>
                <label className={field}>
                  {t("common.notes")}
                  <textarea name="body" rows={2} maxLength={4000} className={input} />
                </label>
                <Button type="submit" variant="secondary">
                  {t("revenue.activity.log")}
                </Button>
              </form>
            ) : null}
            {activities?.ok ? (
              activities.data.rows.length === 0 ? (
                <p className="text-sm text-ink-muted">{t("common.none")}</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {activities.data.rows.map((a) => (
                    <li
                      key={a.id}
                      className="flex flex-col rounded-md border border-line px-3 py-2"
                    >
                      <span className="flex justify-between gap-2">
                        <span className="truncate text-ink">
                          <Badge tone="neutral">{t(`revenue.activity.${a.kind}`)}</Badge>{" "}
                          {a.title ?? ""}
                        </span>
                        <span className="text-xs text-ink-muted" dir="ltr">
                          {formatDate(a.createdAt.slice(0, 10), { locale })}
                        </span>
                      </span>
                      {a.body ? (
                        <span className="text-xs text-ink-secondary">{a.body.slice(0, 240)}</span>
                      ) : null}
                      <span className="text-xs text-ink-muted">
                        {a.actorName ?? ""}
                        {a.outcome ? ` · ${t(`revenue.outcome.${a.outcome}`)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </Card>
        </div>
      ) : null}

      {tab === "canvas" && canvas ? (
        <Card>
          <CardHeader title={t("revenue.deal.tab.canvas")} />
          <LazyCanvas
            orgId={orgId}
            opportunityId={opportunityId}
            initial={canvas.doc}
            initialRowVersion={canvas.rowVersion}
            canManage={canManage}
            dict={{
              add: t("revenue.canvas.add"),
              label: t("revenue.canvas.label"),
              kind: {
                stakeholder: t("revenue.canvas.kind.stakeholder"),
                decision: t("revenue.canvas.kind.decision"),
                risk: t("revenue.canvas.kind.risk"),
                document: t("revenue.canvas.kind.document"),
                step: t("revenue.canvas.kind.step"),
                note: t("revenue.canvas.kind.note"),
                competitor: t("revenue.canvas.kind.competitor"),
                product: t("revenue.canvas.kind.product"),
              },
              save: t("common.save"),
              saved: t("revenue.canvas.saved"),
              conflict: t("revenue.board.conflict"),
              failed: t("common.error"),
              forbidden: t("common.forbidden"),
              hint: t("revenue.canvas.hint"),
            }}
          />
        </Card>
      ) : null}

      {tab === "assistant" && ai ? (
        <Card>
          <CardHeader title={t("revenue.ai.title")} />
          <AiPane
            orgId={orgId}
            opportunityId={opportunityId}
            available={ai.available}
            ownerAction={ai.ownerAction}
            dict={{
              title: t("revenue.ai.mode"),
              ask: t("revenue.ai.ask"),
              mode: {
                brief: t("revenue.ai.mode.brief"),
                actions: t("revenue.ai.mode.actions"),
                risks: t("revenue.ai.mode.risks"),
                ask: t("revenue.ai.mode.ask"),
              },
              question: t("revenue.ai.question"),
              unavailable: t("revenue.ai.unavailable"),
              ownerAction: t("revenue.ai.owner_action"),
              evidence: t("revenue.ai.evidence"),
              noEvidence: t("revenue.ai.no_evidence"),
              notice: t("revenue.ai.notice"),
              failed: t("common.error"),
            }}
          />
        </Card>
      ) : null}
    </div>
  );
}
