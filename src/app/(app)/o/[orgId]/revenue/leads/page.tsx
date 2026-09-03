import { revenueStudioEnabled } from "@/platform/flags";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Badge, Button, Card, EmptyState, Pager } from "@/platform/ui";
import { can } from "@/platform/authz";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import {
  DISQUALIFY_REASONS,
  findLeadDuplicates,
  LEAD_SOURCE_KINDS,
  leadPage,
  leadSourceAdapters,
  listCampaigns,
  type LeadListRow,
} from "@/modules/crm/service";
import { listCustomers } from "@/modules/masters/service";
import { pageOffset, resolveRevenue, section, tabLabels, withParam } from "../shared";
import { RevenueTabs } from "../RevenueTabs";
import {
  captureLeadAction,
  convertLeadAction,
  disqualifyLeadAction,
  qualifyLeadAction,
  reviewQuarantineAction,
} from "./actions";

const LIMIT = 50;
const input = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-sm text-ink";
const field = "flex flex-col gap-1 text-xs text-ink-muted";

/**
 * H27 — enquiries and leads: capture by hand (trusted), review what arrived
 * from the outside (quarantined until a person trusts it), qualify with
 * evidence, disqualify with a reason, and convert safely — the duplicate
 * candidates are shown before a second customer can be created.
 */
export default async function LeadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  if (!revenueStudioEnabled()) notFound(); // page-level gate: layouts and pages render concurrently
  const { orgId } = await params;
  const sp = await searchParams;
  const { resolved, t, locale } = await resolveRevenue(orgId, "leads.view");
  const canManage = can(resolved.archetype, "leads.manage");
  const seesPrice = resolved.ctx.pricePrivileged;
  const currency = resolved.baseCurrency as CurrencyCode;
  const { page, offset } = pageOffset(sp.page, LIMIT);

  const [leads, campaigns, customers] = await Promise.all([
    leadPage(resolved.ctx, resolved.archetype, {
      status: sp.status || "all",
      quarantine: sp.quarantine || "all",
      sourceKind: sp.source || null,
      search: sp.q || undefined,
      limit: LIMIT,
      offset,
    }),
    section(() =>
      can(resolved.archetype, "crm.campaigns.manage")
        ? listCampaigns(resolved.ctx, resolved.archetype)
        : Promise.resolve([]),
    ),
    section(() =>
      canManage
        ? listCustomers(resolved.ctx, resolved.archetype, { status: "active", limit: 200 })
        : Promise.resolve([]),
    ),
  ]);
  const openLead = sp.open ? leads.rows.find((l) => l.id === sp.open) : undefined;
  const dupes =
    openLead && canManage
      ? await findLeadDuplicates(resolved.ctx, resolved.archetype, {
          name: openLead.name,
          email: openLead.email,
          phone: openLead.phone,
          country: openLead.country,
          excludeLeadId: openLead.id,
        })
      : [];
  const adapters = leadSourceAdapters();
  const base = { ...sp, page: undefined, open: undefined, ok: undefined, error: undefined };
  const hrefFor = (p: number) => `/o/${orgId}/revenue/leads${withParam(base, "page", p)}`;
  const money = (l: LeadListRow) =>
    seesPrice && l.estimatedValueMinor !== null
      ? formatMoney(l.estimatedValueMinor, (l.currency ?? currency) as CurrencyCode, { locale })
      : null;
  const tone = (s: string) =>
    s === "converted"
      ? "success"
      : s === "disqualified"
        ? "neutral"
        : s === "qualified"
          ? "brand"
          : "info";

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("revenue.leads.title")}</h1>
        <RevenueTabs
          orgId={orgId}
          active="leads"
          archetype={resolved.archetype}
          labels={tabLabels(t)}
        />
      </header>
      {sp.error ? (
        <Badge tone="danger">{t(`revenue.leads.error.${sp.error}`)}</Badge>
      ) : sp.ok ? (
        <Badge tone="success">{t(`revenue.leads.ok.${sp.ok}`)}</Badge>
      ) : null}

      {canManage ? (
        <Card>
          <details open={sp.ok === undefined && leads.total === 0}>
            <summary className="cursor-pointer text-sm font-semibold text-ink">
              {t("revenue.leads.capture")}
            </summary>
            <form
              action={captureLeadAction.bind(null, orgId)}
              className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
            >
              <label className={field}>
                {t("revenue.leads.name")}
                <input name="name" required maxLength={160} className={input} />
              </label>
              <label className={field}>
                {t("revenue.leads.contact_name")}
                <input name="contact_name" maxLength={120} className={input} />
              </label>
              <label className={field}>
                {t("common.email")}
                <input name="email" type="email" maxLength={254} className={input} dir="ltr" />
              </label>
              <label className={field}>
                {t("common.phone")}
                <input name="phone" type="tel" maxLength={32} className={input} dir="ltr" />
              </label>
              <label className={field}>
                {t("common.country")}
                <input name="country" maxLength={2} placeholder="AE" className={input} dir="ltr" />
              </label>
              <label className={field}>
                {t("revenue.leads.source_kind")}
                <select name="source_kind" defaultValue="manual" className={input}>
                  {LEAD_SOURCE_KINDS.filter(
                    (k) => !["form", "email", "messaging", "api"].includes(k),
                  ).map((k) => (
                    <option key={k} value={k}>
                      {t(`revenue.source.${k}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={field}>
                {t("revenue.leads.source")}
                <input name="source" maxLength={80} className={input} />
              </label>
              {campaigns.ok && campaigns.data.length > 0 ? (
                <label className={field}>
                  {t("revenue.tab.campaigns")}
                  <select name="campaign_id" defaultValue="" className={input}>
                    <option value="">—</option>
                    {campaigns.data.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className={field}>
                {t("revenue.value")}
                <span className="flex gap-1">
                  <input
                    name="value_major"
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
                {t("revenue.leads.timeframe")}
                <select name="timeframe" defaultValue="unknown" className={input}>
                  {(["immediate", "quarter", "half_year", "year", "unknown"] as const).map((k) => (
                    <option key={k} value={k}>
                      {t(`revenue.timeframe.${k}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={field}>
                {t("revenue.leads.interest")}
                <input name="interest" maxLength={300} className={input} />
              </label>
              <label className={`${field} sm:col-span-2 lg:col-span-3`}>
                {t("common.notes")}
                <textarea name="notes" maxLength={2000} rows={2} className={input} />
              </label>
              <fieldset className="flex flex-wrap gap-3 text-sm text-ink sm:col-span-2 lg:col-span-3">
                <legend className="text-xs text-ink-muted">
                  {t("revenue.consent.at_capture")}
                </legend>
                {(["email", "sms", "whatsapp", "phone"] as const).map((ch) => (
                  <label key={ch} className="flex items-center gap-2">
                    <input type="checkbox" name={`consent_${ch}`} className="size-5" />
                    {t(`revenue.channel.${ch}`)}
                  </label>
                ))}
              </fieldset>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button type="submit">{t("revenue.leads.capture_submit")}</Button>
              </div>
            </form>
          </details>
          <p className="mt-3 text-xs text-ink-muted">
            {t("revenue.leads.adapters")}:{" "}
            {adapters.map((a) => (
              <span key={a.kind} className="me-2">
                {t(`revenue.source.${a.kind}`)} —{" "}
                {a.configured ? t("common.enabled") : t("revenue.provider.disabled")}
              </span>
            ))}
          </p>
        </Card>
      ) : null}

      <Card>
        <form method="get" className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <label className={field}>
            {t("revenue.filter.status")}
            <select name="status" defaultValue={sp.status ?? "all"} className={input}>
              {(["all", "new", "contacted", "qualified", "converted", "disqualified"] as const).map(
                (s) => (
                  <option key={s} value={s}>
                    {s === "all" ? t("common.all") : t(`revenue.lead_status.${s}`)}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className={field}>
            {t("revenue.quarantine.title")}
            <select name="quarantine" defaultValue={sp.quarantine ?? "all"} className={input}>
              {(["all", "trusted", "quarantined", "spam"] as const).map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? t("common.all") : t(`revenue.quarantine.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("revenue.leads.source_kind")}
            <select name="source" defaultValue={sp.source ?? ""} className={input}>
              <option value="">{t("common.all")}</option>
              {LEAD_SOURCE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`revenue.source.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("revenue.filter.search")}
            <input name="q" defaultValue={sp.q ?? ""} className={input} />
          </label>
          <div className="flex items-end gap-2">
            <Button type="submit">{t("common.apply")}</Button>
            <Link
              href={`/o/${orgId}/revenue/leads`}
              className="text-sm text-ink-secondary hover:underline"
            >
              {t("common.clear")}
            </Link>
          </div>
        </form>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Badge tone="brand">{t("revenue.leads.total", { n: leads.total })}</Badge>
          {Object.entries(leads.byStatus).map(([s, n]) => (
            <Badge key={s} tone="neutral">
              {t(`revenue.lead_status.${s}`)} {n}
            </Badge>
          ))}
          {leads.quarantined > 0 ? (
            <Badge tone="warning">
              {t("revenue.quarantine.quarantined")} {leads.quarantined}
            </Badge>
          ) : null}
        </div>
      </Card>

      {leads.rows.length === 0 ? (
        <EmptyState title={t("revenue.leads.empty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {leads.rows.map((l) => {
            const open = sp.open === l.id;
            return (
              <li key={l.id} className="rounded-lg border border-line bg-card p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      href={`/o/${orgId}/leads/${l.id}`}
                      className="text-sm font-medium text-ink hover:underline"
                    >
                      {l.name}
                    </Link>
                    <p className="flex flex-wrap gap-x-3 text-xs text-ink-secondary">
                      {l.contactName ? <span>{l.contactName}</span> : null}
                      {l.email ? <span dir="ltr">{l.email}</span> : null}
                      {l.phone ? <span dir="ltr">{l.phone}</span> : null}
                      {money(l) ? (
                        <span dir="ltr" className="font-mono">
                          {money(l)}
                        </span>
                      ) : null}
                      {l.ownerName ? <span>{l.ownerName}</span> : null}
                      <span dir="ltr">{formatDate(l.createdAt.slice(0, 10), { locale })}</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={tone(l.status)}>{t(`revenue.lead_status.${l.status}`)}</Badge>
                    <Badge tone="neutral">{t(`revenue.source.${l.sourceKind}`)}</Badge>
                    {l.quarantine !== "trusted" ? (
                      <Badge tone={l.quarantine === "spam" ? "danger" : "warning"}>
                        {t(`revenue.quarantine.${l.quarantine}`)}
                      </Badge>
                    ) : null}
                    {l.campaignName ? <Badge tone="info">{l.campaignName}</Badge> : null}
                    {canManage && l.status !== "converted" ? (
                      <Link
                        href={`/o/${orgId}/revenue/leads${withParam(base, "open", open ? undefined : l.id)}`}
                        className="inline-flex min-h-9 items-center rounded-md border border-line px-2 text-xs text-ink hover:bg-sunken"
                      >
                        {open ? t("common.close") : t("revenue.leads.work")}
                      </Link>
                    ) : null}
                    {l.convertedOpportunityId ? (
                      <Link
                        href={`/o/${orgId}/revenue/deals/${l.convertedOpportunityId}`}
                        className="text-xs text-brand hover:underline"
                      >
                        {t("revenue.leads.view_deal")}
                      </Link>
                    ) : null}
                  </div>
                </div>

                {open && canManage ? (
                  <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
                    {l.quarantine === "quarantined" ? (
                      <form
                        action={reviewQuarantineAction.bind(null, orgId)}
                        className="flex flex-col gap-2 rounded-md border border-warning p-3 lg:col-span-3"
                      >
                        <input type="hidden" name="id" value={l.id} />
                        <p className="text-sm text-ink">{t("revenue.quarantine.review_hint")}</p>
                        <div className="flex gap-2">
                          <Button type="submit" name="decision" value="trust">
                            {t("revenue.quarantine.trust")}
                          </Button>
                          <Button type="submit" name="decision" value="spam" variant="danger">
                            {t("revenue.quarantine.spam")}
                          </Button>
                        </div>
                      </form>
                    ) : null}
                    <form
                      action={qualifyLeadAction.bind(null, orgId)}
                      className="flex flex-col gap-2 rounded-md border border-line p-3"
                    >
                      <input type="hidden" name="id" value={l.id} />
                      <h3 className="text-sm font-semibold text-ink">
                        {t("revenue.leads.qualify")}
                      </h3>
                      {(["budget", "authority", "need", "timing"] as const).map((k) => (
                        <label key={k} className="flex items-center gap-2 text-sm text-ink">
                          <input
                            type="checkbox"
                            name={`q_${k}`}
                            className="size-5"
                            defaultChecked={Boolean(l.qualification?.[k])}
                          />
                          {t(`revenue.qualification.${k}`)}
                        </label>
                      ))}
                      <label className={field}>
                        {t("revenue.value")}
                        <span className="flex gap-1">
                          <input
                            name="value_major"
                            inputMode="decimal"
                            defaultValue={
                              l.estimatedValueMinor !== null ? l.estimatedValueMinor / 100 : ""
                            }
                            className={`${input} w-full`}
                            dir="ltr"
                          />
                          <input
                            name="currency"
                            defaultValue={l.currency ?? currency}
                            maxLength={3}
                            className={`${input} w-20`}
                            dir="ltr"
                          />
                        </span>
                      </label>
                      <label className={field}>
                        {t("revenue.leads.timeframe")}
                        <select
                          name="timeframe"
                          defaultValue={l.timeframe ?? "unknown"}
                          className={input}
                        >
                          {(["immediate", "quarter", "half_year", "year", "unknown"] as const).map(
                            (k) => (
                              <option key={k} value={k}>
                                {t(`revenue.timeframe.${k}`)}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                      <label className={field}>
                        {t("common.notes")}
                        <input
                          name="q_note"
                          maxLength={1000}
                          defaultValue={String(l.qualification?.note ?? "")}
                          className={input}
                        />
                      </label>
                      <Button type="submit" variant="secondary">
                        {t("common.save")}
                      </Button>
                    </form>

                    <form
                      action={convertLeadAction.bind(null, orgId)}
                      className="flex flex-col gap-2 rounded-md border border-line p-3"
                    >
                      <input type="hidden" name="id" value={l.id} />
                      <h3 className="text-sm font-semibold text-ink">
                        {t("revenue.leads.convert")}
                      </h3>
                      <label className={field}>
                        {t("revenue.leads.opportunity_name")}
                        <input
                          name="opportunity_name"
                          defaultValue={l.name}
                          maxLength={160}
                          className={input}
                        />
                      </label>
                      <label className={field}>
                        {t("revenue.leads.customer")}
                        <select name="customer_id" defaultValue="" className={input}>
                          <option value="">{t("revenue.leads.new_customer")}</option>
                          {(customers.ok ? customers.data : []).map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={field}>
                        {t("revenue.value")}
                        <input
                          name="value_major"
                          inputMode="decimal"
                          defaultValue={
                            l.estimatedValueMinor !== null ? l.estimatedValueMinor / 100 : ""
                          }
                          className={input}
                          dir="ltr"
                        />
                      </label>
                      <label className={field}>
                        {t("revenue.close_date")}
                        <input name="close_date" type="date" className={input} dir="ltr" />
                      </label>
                      {dupes.length > 0 ? (
                        <div className="rounded-md border border-warning p-2 text-xs">
                          <p className="font-medium text-warning">
                            {t("revenue.leads.duplicates")}
                          </p>
                          <ul className="mt-1 flex flex-col gap-0.5 text-ink">
                            {dupes.map((d) => (
                              <li key={`${d.kind}:${d.id}`}>
                                {d.kind === "customer" ? (
                                  <Link
                                    href={`/o/${orgId}/revenue/customers/${d.id}`}
                                    className="hover:underline"
                                  >
                                    {d.name}
                                  </Link>
                                ) : (
                                  <Link
                                    href={`/o/${orgId}/leads/${d.id}`}
                                    className="hover:underline"
                                  >
                                    {d.name}
                                  </Link>
                                )}{" "}
                                <span className="text-ink-muted">
                                  ({t(`imports.match.${d.match}`)}, {d.kind})
                                </span>
                              </li>
                            ))}
                          </ul>
                          <label className="mt-2 flex items-center gap-2 text-ink">
                            <input type="checkbox" name="acknowledge" className="size-5" />
                            {t("revenue.leads.acknowledge")}
                          </label>
                        </div>
                      ) : null}
                      <Button type="submit" disabled={l.quarantine === "quarantined"}>
                        {t("revenue.leads.convert_submit")}
                      </Button>
                    </form>

                    <form
                      action={disqualifyLeadAction.bind(null, orgId)}
                      className="flex flex-col gap-2 rounded-md border border-line p-3"
                    >
                      <input type="hidden" name="id" value={l.id} />
                      <h3 className="text-sm font-semibold text-ink">
                        {t("revenue.leads.disqualify")}
                      </h3>
                      <label className={field}>
                        {t("revenue.leads.reason")}
                        <select name="reason" defaultValue="other" className={input}>
                          {DISQUALIFY_REASONS.map((r) => (
                            <option key={r} value={r}>
                              {t(`revenue.disqualify.${r}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={field}>
                        {t("common.notes")}
                        <input name="note" maxLength={1000} className={input} />
                      </label>
                      <Button type="submit" variant="secondary">
                        {t("revenue.leads.disqualify_submit")}
                      </Button>
                    </form>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <Pager
        page={page}
        hasMore={offset + leads.rows.length < leads.total}
        hrefFor={hrefFor}
        labels={{
          previous: t("common.previous"),
          next: t("common.next"),
          page: t("common.page", { n: page }),
        }}
      />
    </div>
  );
}
