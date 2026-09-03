import Link from "next/link";
import { Badge, Button, Card, CardHeader, EmptyState } from "@/platform/ui";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { listMembers } from "@/platform/auth/identity";
import { can } from "@/platform/authz";
import {
  attributionReport,
  channelProviders,
  leadPage,
  listCampaigns,
  previewMarketingSend,
  type AttributionModel,
} from "@/modules/crm/service";
import { listCustomers } from "@/modules/masters/service";
import { resolveRevenue, section, tabLabels } from "../shared";
import { RevenueTabs } from "../RevenueTabs";
import {
  createCampaignAction,
  recordTouchAction,
  sendMarketingAction,
  updateCampaignAction,
} from "./actions";

const input = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-sm text-ink";
const field = "flex flex-col gap-1 text-xs text-ink-muted";
const CHANNELS = [
  "email",
  "sms",
  "whatsapp",
  "social",
  "event",
  "referral",
  "web",
  "ads",
  "phone",
  "other",
] as const;
const STATUSES = ["planned", "active", "paused", "completed", "cancelled"] as const;
const MODELS: AttributionModel[] = ["first_touch", "last_touch", "linear"];

/**
 * H27 — campaigns and attribution: each figure states the model that
 * produced it and claims correlation only; marketing messages go out only
 * from an explicit, consent-checked send, and never without a provider.
 */
export default async function CampaignsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const one = (k: string) =>
    Array.isArray(sp[k]) ? (sp[k] as string[])[0] : (sp[k] as string | undefined);
  const many = (k: string) =>
    Array.isArray(sp[k]) ? (sp[k] as string[]) : sp[k] ? [sp[k] as string] : [];
  const { resolved, t, locale } = await resolveRevenue(orgId, "crm.campaigns.manage");
  const seesPrice = resolved.ctx.pricePrivileged;
  const currency = resolved.baseCurrency as CurrencyCode;
  const money = (n: number | null | undefined, cur?: string | null) =>
    seesPrice && n !== null && n !== undefined
      ? formatMoney(n, (cur ?? currency) as CurrencyCode, { locale })
      : t("common.restricted");
  const model: AttributionModel = MODELS.includes(one("model") as AttributionModel)
    ? (one("model") as AttributionModel)
    : "linear";

  const [campaigns, attribution, members, leads, customers] = await Promise.all([
    listCampaigns(resolved.ctx, resolved.archetype),
    section(() =>
      attributionReport(resolved.ctx, resolved.archetype, model, {
        from: one("from") || undefined,
        to: one("to") || undefined,
      }),
    ),
    can(resolved.archetype, "members.view")
      ? listMembers(resolved.ctx, resolved.archetype)
      : Promise.resolve([]),
    section(() =>
      can(resolved.archetype, "leads.view")
        ? leadPage(resolved.ctx, resolved.archetype, { limit: 50 })
        : Promise.resolve(null),
    ),
    section(() =>
      listCustomers(resolved.ctx, resolved.archetype, { status: "active", limit: 200 }),
    ),
  ]);
  const providers = channelProviders();
  const previewRecipients = many("c");
  const preview =
    one("preview") === "1" && one("campaign") && previewRecipients.length > 0
      ? await section(() =>
          previewMarketingSend(resolved.ctx, resolved.archetype, {
            campaignId: one("campaign"),
            channel: one("channel") ?? "email",
            subject: one("subject") ?? "-",
            body: one("body") ?? "-",
            recipients: previewRecipients.map((customerId) => ({ customerId })),
            confirmed: true,
          }),
        )
      : null;
  const ok = one("ok");
  const error = one("error");

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("revenue.campaigns.title")}</h1>
        <RevenueTabs
          orgId={orgId}
          active="campaigns"
          archetype={resolved.archetype}
          labels={tabLabels(t)}
        />
      </header>
      {error ? (
        <Badge tone="danger">{t(`revenue.campaigns.error.${error}`)}</Badge>
      ) : ok ? (
        <Badge tone="success">
          {t(`revenue.campaigns.ok.${ok}`, {
            sent: one("sent") ?? "0",
            skipped: one("skipped") ?? "0",
          })}
        </Badge>
      ) : null}

      <Card>
        <CardHeader title={t("revenue.campaigns.list")} />
        {campaigns.length === 0 ? (
          <EmptyState title={t("revenue.campaigns.none")} />
        ) : (
          <ul className="flex flex-col gap-2">
            {campaigns.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">
                    {c.name}{" "}
                    <Badge tone="neutral">{t(`revenue.campaign_channel.${c.channel}`)}</Badge>{" "}
                    <Badge tone={c.status === "active" ? "success" : "neutral"}>
                      {t(`revenue.campaign_status.${c.status}`)}
                    </Badge>
                  </span>
                  <span className="flex flex-wrap gap-x-3 text-xs text-ink-muted">
                    <span>
                      {c.leads} {t("revenue.tab.leads")} · {c.opportunities} {t("revenue.kpi.open")}
                    </span>
                    <span dir="ltr">
                      {t("revenue.campaigns.budget")} {money(c.budgetMinor, c.currency)} ·{" "}
                      {t("revenue.campaigns.cost")} {money(c.costMinor, c.currency)}
                    </span>
                    {c.wonMinor !== null ? (
                      <span dir="ltr">
                        {t("revenue.forecast.won")} {money(c.wonMinor, c.currency)}
                      </span>
                    ) : null}
                    {c.startsOn ? (
                      <span dir="ltr">
                        {formatDate(c.startsOn, { locale })}
                        {c.endsOn ? ` → ${formatDate(c.endsOn, { locale })}` : ""}
                      </span>
                    ) : null}
                  </span>
                </div>
                {c.objective ? <p className="text-xs text-ink-secondary">{c.objective}</p> : null}
                <form
                  action={updateCampaignAction.bind(null, orgId)}
                  className="flex flex-wrap items-end gap-2"
                >
                  <input type="hidden" name="id" value={c.id} />
                  <label className={field}>
                    {t("revenue.filter.status")}
                    <select name="status" defaultValue={c.status} className={input}>
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {t(`revenue.campaign_status.${s}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={field}>
                    {t("revenue.campaigns.cost")}
                    <input
                      name="cost_major"
                      inputMode="decimal"
                      defaultValue={c.costMinor / 100}
                      className={`${input} w-32`}
                      dir="ltr"
                    />
                  </label>
                  <Button type="submit" variant="ghost" size="md">
                    {t("common.save")}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-semibold text-ink">
            {t("revenue.campaigns.create")}
          </summary>
          <form
            action={createCampaignAction.bind(null, orgId)}
            className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
          >
            <label className={field}>
              {t("revenue.leads.name")}
              <input name="name" required maxLength={160} className={input} />
            </label>
            <label className={field}>
              {t("revenue.campaigns.channel")}
              <select name="channel" defaultValue="other" className={input}>
                {CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>
                    {t(`revenue.campaign_channel.${ch}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className={field}>
              {t("revenue.filter.status")}
              <select name="status" defaultValue="planned" className={input}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`revenue.campaign_status.${s}`)}
                  </option>
                ))}
              </select>
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
              {t("revenue.campaigns.budget")}
              <span className="flex gap-1">
                <input
                  name="budget_major"
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
              {t("common.from")}
              <input name="starts_on" type="date" className={input} dir="ltr" />
            </label>
            <label className={field}>
              {t("common.to")}
              <input name="ends_on" type="date" className={input} dir="ltr" />
            </label>
            <label className={field}>
              {t("revenue.campaigns.audience")}
              <input name="audience" maxLength={500} className={input} />
            </label>
            <label className={`${field} sm:col-span-2 lg:col-span-4`}>
              {t("revenue.campaigns.objective")}
              <input name="objective" maxLength={1000} className={input} />
            </label>
            <div className="sm:col-span-2 lg:col-span-4">
              <Button type="submit">{t("revenue.campaigns.create")}</Button>
            </div>
          </form>
        </details>
      </Card>

      <Card>
        <CardHeader
          title={t("revenue.attribution.title")}
          meta={
            <form method="get" className="flex flex-wrap items-end gap-2">
              <label className={field}>
                {t("revenue.attribution.model")}
                <select name="model" defaultValue={model} className={input}>
                  {MODELS.map((m) => (
                    <option key={m} value={m}>
                      {t(`revenue.attribution.${m}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={field}>
                {t("common.from")}
                <input
                  name="from"
                  type="date"
                  defaultValue={one("from") ?? ""}
                  className={input}
                  dir="ltr"
                />
              </label>
              <label className={field}>
                {t("common.to")}
                <input
                  name="to"
                  type="date"
                  defaultValue={one("to") ?? ""}
                  className={input}
                  dir="ltr"
                />
              </label>
              <Button type="submit" variant="secondary">
                {t("common.apply")}
              </Button>
            </form>
          }
        />
        <p className="mb-2 text-xs text-ink-muted">{t("revenue.attribution.disclaimer")}</p>
        {attribution.ok ? (
          attribution.data.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("revenue.attribution.none")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-ink-muted">
                <tr>
                  <th className="py-1 text-start">{t("revenue.tab.campaigns")}</th>
                  <th className="py-1 text-end">{t("revenue.forecast.won")}</th>
                  <th className="py-1 text-end">{t("revenue.attribution.attributed")}</th>
                  <th className="py-1 text-end">{t("revenue.campaigns.cost")}</th>
                  <th className="py-1 text-end">{t("revenue.attribution.return")}</th>
                </tr>
              </thead>
              <tbody>
                {attribution.data.map((r) => (
                  <tr key={r.campaignId} className="border-t border-line">
                    <td className="py-1 text-ink">
                      {r.campaignName}{" "}
                      <span className="text-xs text-ink-muted">
                        ({t(`revenue.attribution.${r.model}`)})
                      </span>
                    </td>
                    <td className="py-1 text-end" dir="ltr">
                      {r.wonOpportunities}
                    </td>
                    <td className="py-1 text-end font-mono" dir="ltr">
                      {money(r.attributedMinor, r.currency)}
                    </td>
                    <td className="py-1 text-end font-mono" dir="ltr">
                      {money(r.costMinor, r.currency)}
                    </td>
                    <td className="py-1 text-end" dir="ltr">
                      {r.returnRatio === null ? "—" : `${r.returnRatio.toFixed(2)}×`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <p className="text-sm text-danger">
            {t("revenue.section_failed", { section: t("revenue.attribution.title") })}
          </p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("revenue.attribution.touch")} />
          <form
            action={recordTouchAction.bind(null, orgId)}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <label className={field}>
              {t("revenue.tab.campaigns")}
              <select name="campaign_id" required className={input} defaultValue="">
                <option value="">—</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={field}>
              {t("revenue.activity.kind")}
              <select name="kind" defaultValue="manual" className={input}>
                {(["exposure", "click", "reply", "visit", "referral", "manual"] as const).map(
                  (k) => (
                    <option key={k} value={k}>
                      {t(`revenue.touch.${k}`)}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label className={field}>
              {t("revenue.tab.leads")}
              <select name="lead_id" defaultValue="" className={input}>
                <option value="">—</option>
                {(leads.ok && leads.data ? leads.data.rows : []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={field}>
              {t("revenue.leads.customer")}
              <select name="customer_id" defaultValue="" className={input}>
                <option value="">—</option>
                {(customers.ok ? customers.data : []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={`${field} sm:col-span-2`}>
              {t("common.notes")}
              <input name="note" maxLength={300} className={input} />
            </label>
            <div className="sm:col-span-2">
              <Button type="submit" variant="secondary">
                {t("revenue.attribution.record_touch")}
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <CardHeader title={t("revenue.marketing.title")} />
          <p className="mb-2 text-xs text-ink-muted">
            {providers.map((p) => (
              <span key={p.channel} className="me-3">
                {t(`revenue.provider.${p.channel}`)}:{" "}
                {p.configured ? t("common.enabled") : t("revenue.provider.disabled")}
              </span>
            ))}
          </p>
          <form method="get" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input type="hidden" name="preview" value="1" />
            <label className={field}>
              {t("revenue.tab.campaigns")}
              <select
                name="campaign"
                required
                defaultValue={one("campaign") ?? ""}
                className={input}
              >
                <option value="">—</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={field}>
              {t("revenue.consent.channel")}
              <select name="channel" defaultValue={one("channel") ?? "email"} className={input}>
                {(["email", "sms", "whatsapp"] as const).map((ch) => (
                  <option key={ch} value={ch}>
                    {t(`revenue.channel.${ch}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className={`${field} sm:col-span-2`}>
              {t("revenue.marketing.subject")}
              <input
                name="subject"
                required
                maxLength={200}
                defaultValue={one("subject") ?? ""}
                className={input}
              />
            </label>
            <label className={`${field} sm:col-span-2`}>
              {t("revenue.marketing.body")}
              <textarea
                name="body"
                required
                rows={3}
                maxLength={20000}
                defaultValue={one("body") ?? ""}
                className={input}
              />
            </label>
            <label className={`${field} sm:col-span-2`}>
              {t("revenue.marketing.recipients")}
              <select
                name="c"
                multiple
                size={6}
                className={`${input} h-auto`}
                defaultValue={previewRecipients}
              >
                {(customers.ok ? customers.data : []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-2">
              <Button type="submit" variant="secondary">
                {t("revenue.marketing.preview")}
              </Button>
            </div>
          </form>
          {preview ? (
            preview.ok ? (
              <div className="mt-3 rounded-md border border-line p-3 text-sm">
                <p className="text-ink">
                  {t("revenue.marketing.preview_result", {
                    allowed: preview.data.allowed,
                    blocked: preview.data.blocked.length,
                  })}
                </p>
                {preview.data.blocked.length > 0 ? (
                  <ul className="mt-1 text-xs text-ink-muted">
                    {preview.data.blocked.map((b) => (
                      <li key={b.index}>
                        #{b.index + 1}: {t(`revenue.consent.${b.reason}`)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {!preview.data.provider.configured ? (
                  <p className="mt-2 text-xs text-warning" dir="ltr">
                    {preview.data.provider.ownerAction}
                  </p>
                ) : null}
                <form action={sendMarketingAction.bind(null, orgId)} className="mt-2">
                  <input type="hidden" name="campaign_id" value={one("campaign") ?? ""} />
                  <input type="hidden" name="channel" value={one("channel") ?? "email"} />
                  <input type="hidden" name="subject" value={one("subject") ?? ""} />
                  <input type="hidden" name="body" value={one("body") ?? ""} />
                  {previewRecipients.map((c) => (
                    <input key={c} type="hidden" name="c" value={c} />
                  ))}
                  <Button
                    type="submit"
                    disabled={!preview.data.provider.configured || preview.data.allowed === 0}
                  >
                    {t("revenue.marketing.send", { n: preview.data.allowed })}
                  </Button>
                </form>
              </div>
            ) : (
              <p className="mt-2 text-sm text-danger">{t("common.error")}</p>
            )
          ) : null}
          <p className="mt-2 text-xs text-ink-muted">{t("revenue.marketing.law")}</p>
          <Link
            href={`/o/${orgId}/revenue/success`}
            className="mt-1 block text-xs text-brand hover:underline"
          >
            {t("revenue.marketing.consent_link")}
          </Link>
        </Card>
      </div>
    </div>
  );
}
