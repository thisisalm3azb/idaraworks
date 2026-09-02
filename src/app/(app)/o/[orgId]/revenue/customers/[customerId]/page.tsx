import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState } from "@/platform/ui";
import { can } from "@/platform/authz";
import { formatDate } from "@/platform/format";
import { listMembers } from "@/platform/auth/identity";
import {
  ACTIVITY_KINDS,
  CONSENT_CHANNELS,
  gatherRevenue360,
  listActivities,
  listConsent,
  listMerges,
  listTerritories,
} from "@/modules/crm/service";
import { getCustomer } from "@/modules/masters/service";
import { localeText, resolveRevenue, section, tabLabels } from "../../shared";
import { RevenueTabs } from "../../RevenueTabs";
import {
  logCustomerActivityAction,
  recordConsentAction,
  recordSignalAction,
  suppressAddressAction,
  updateContactRoleAction,
  updateCustomerCrmAction,
} from "./actions";

const input = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-sm text-ink";
const field = "flex flex-col gap-1 text-xs text-ink-muted";
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

/**
 * H27 — Customer 360 for revenue work: ownership, territory, tags and
 * segment; contacts with buying roles and per-channel consent; documents,
 * obligations, issues and signals; a health score that shows its evidence
 * and admits what it does not know; the timeline; and the reviewed merge.
 * Money and finance stay on the H19 customer page (linked), never duplicated.
 */
export default async function RevenueCustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; customerId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId, customerId } = await params;
  const sp = await searchParams;
  const { resolved, t, locale } = await resolveRevenue(orgId, "customers.view");
  const canManage = can(resolved.archetype, "customers.manage");
  const canConsent = can(resolved.archetype, "crm.consent.manage");
  const canMerge = can(resolved.archetype, "crm.merge");
  const customer = await getCustomer(resolved.ctx, resolved.archetype, customerId);
  if (!customer) notFound();
  const [x, activities, consent, merges, territories, members] = await Promise.all([
    gatherRevenue360(resolved.ctx, resolved.archetype, customerId),
    section(() => listActivities(resolved.ctx, resolved.archetype, { customerId, limit: 40 })),
    section(() => listConsent(resolved.ctx, resolved.archetype, { customerId })),
    section(() => listMerges(resolved.ctx, resolved.archetype, customerId)),
    section(() => listTerritories(resolved.ctx, resolved.archetype)),
    section(() =>
      can(resolved.archetype, "members.view")
        ? listMembers(resolved.ctx, resolved.archetype)
        : Promise.resolve([]),
    ),
  ]);
  const consentTone = (s: string) =>
    s === "granted"
      ? "success"
      : s === "suppressed"
        ? "danger"
        : s === "withdrawn"
          ? "warning"
          : "neutral";
  const healthTone =
    x.health.band === "healthy"
      ? "success"
      : x.health.band === "watch"
        ? "warning"
        : x.health.band === "at_risk"
          ? "danger"
          : "neutral";
  const back = `/o/${orgId}/revenue/customers/${customerId}`;
  const act = (a: (o: string, c: string, f: FormData) => Promise<void>) =>
    a.bind(null, orgId, customerId);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-ink">{customer.name}</h1>
            <p className="flex flex-wrap gap-x-3 text-sm text-ink-muted">
              {x.crm.ownerName ? <span>{x.crm.ownerName}</span> : null}
              {x.crm.territoryName ? <span>{localeText(x.crm.territoryName, locale)}</span> : null}
              {x.crm.segment ? <span>{x.crm.segment}</span> : null}
              {x.crm.tags.map((tag) => (
                <Badge key={tag} tone="neutral">
                  {tag}
                </Badge>
              ))}
              {!customer.active ? <Badge tone="danger">{t("common.inactive")}</Badge> : null}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/o/${orgId}/customers/${customerId}`}
              className="inline-flex min-h-10 items-center rounded-md border border-line px-3 text-sm text-ink hover:bg-sunken"
            >
              {t("revenue.customer.finance_page")}
            </Link>
            {canMerge && !x.crm.mergedIntoCustomerId ? (
              <Link
                href={`${back}/merge`}
                className="inline-flex min-h-10 items-center rounded-md border border-line px-3 text-sm text-ink hover:bg-sunken"
              >
                {t("revenue.merge.title")}
              </Link>
            ) : null}
          </div>
        </div>
        <RevenueTabs
          orgId={orgId}
          active="success"
          archetype={resolved.archetype}
          labels={tabLabels(t)}
        />
      </header>
      {x.crm.mergedIntoCustomerId ? (
        <p className="rounded-md border border-warning p-3 text-sm text-ink">
          {t("revenue.merge.merged_notice")}{" "}
          <Link
            href={`/o/${orgId}/revenue/customers/${x.crm.mergedIntoCustomerId}`}
            className="text-brand hover:underline"
          >
            {t("revenue.merge.open_survivor")}
          </Link>
        </p>
      ) : null}
      {sp.error ? (
        <Badge tone="danger">{t(`revenue.customer.error.${sp.error}`)}</Badge>
      ) : sp.ok ? (
        <Badge tone="success">{t(`revenue.customer.ok.${sp.ok}`)}</Badge>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card id="health">
          <CardHeader
            title={t("revenue.health.title")}
            meta={<Badge tone={healthTone}>{t(`revenue.health.band.${x.health.band}`)}</Badge>}
          />
          <p className="text-2xl font-semibold text-ink" dir="ltr">
            {x.health.score === null ? "—" : `${x.health.score}/100`}
          </p>
          <p className="text-xs text-ink-muted">
            {t("revenue.health.known", {
              n: x.health.knownSignals,
              total: x.health.signals.length,
            })}
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {x.health.signals.map((s) => (
              <li key={s.key} className="flex items-start justify-between gap-2">
                <span className="text-ink">{s.label}</span>
                <span
                  className={
                    s.value === null
                      ? "text-ink-muted"
                      : s.value < 0
                        ? "text-danger"
                        : "text-success"
                  }
                >
                  {s.value === null ? t("revenue.health.unknown") : s.evidence}
                </span>
              </li>
            ))}
          </ul>
          {canManage ? (
            <form
              action={act(recordSignalAction)}
              className="mt-3 flex flex-col gap-2 border-t border-line pt-3"
            >
              <h3 className="text-sm font-semibold text-ink">{t("revenue.signal.record")}</h3>
              <label className={field}>
                {t("revenue.signal.kind")}
                <select name="kind" defaultValue="note" className={input}>
                  {(
                    [
                      "satisfaction",
                      "onboarding",
                      "adoption",
                      "success_plan",
                      "churn_risk",
                      "note",
                    ] as const
                  ).map((k) => (
                    <option key={k} value={k}>
                      {t(`revenue.signal.${k}`)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className={field}>
                  {t("revenue.signal.score")}
                  <input name="score" inputMode="numeric" className={input} dir="ltr" />
                </label>
                <label className={field}>
                  {t("revenue.filter.status")}
                  <select name="status" defaultValue="" className={input}>
                    <option value="">—</option>
                    {(["open", "done", "at_risk", "healthy"] as const).map((s) => (
                      <option key={s} value={s}>
                        {t(`revenue.signal.status.${s}`)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className={field}>
                {t("common.title")}
                <input name="title" maxLength={200} className={input} />
              </label>
              <label className={field}>
                {t("revenue.signal.due")}
                <input name="due_on" type="date" className={input} dir="ltr" />
              </label>
              <Button type="submit" variant="secondary">
                {t("common.save")}
              </Button>
            </form>
          ) : null}
          {x.signals.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-xs">
              {x.signals.slice(0, 10).map((s) => (
                <li key={s.id} className="flex justify-between gap-2">
                  <span className="text-ink">
                    {t(`revenue.signal.${s.kind}`)}
                    {s.title ? ` · ${s.title}` : ""}
                  </span>
                  <span className="text-ink-muted" dir="ltr">
                    {s.score ?? ""} {s.status ?? ""}{" "}
                    {formatDate(s.recordedAt.slice(0, 10), { locale })}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title={t("revenue.customer.ownership")} />
          {canManage ? (
            <form
              action={act(updateCustomerCrmAction)}
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              <label className={field}>
                {t("revenue.filter.owner")}
                <select
                  name="owner_user_id"
                  defaultValue={x.crm.ownerUserId ?? ""}
                  className={input}
                >
                  <option value="">—</option>
                  {(members.ok ? members.data : [])
                    .filter((m) => !m.deactivatedAt)
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.fullName}
                      </option>
                    ))}
                </select>
              </label>
              <label className={field}>
                {t("revenue.territory.title")}
                <select
                  name="territory_id"
                  defaultValue={x.crm.territoryId ?? ""}
                  className={input}
                >
                  <option value="">—</option>
                  {(territories.ok ? territories.data : []).map((tr) => (
                    <option key={tr.id} value={tr.id}>
                      {localeText(tr.name, locale, tr.key)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={field}>
                {t("revenue.customer.tags")}
                <input name="tags" defaultValue={x.crm.tags.join(", ")} className={input} />
              </label>
              <label className={field}>
                {t("revenue.customer.segment")}
                <input
                  name="segment"
                  defaultValue={x.crm.segment ?? ""}
                  pattern="[a-z][a-z0-9_]{0,39}"
                  className={input}
                  dir="ltr"
                />
              </label>
              <div className="sm:col-span-2">
                <Button type="submit" variant="secondary">
                  {t("common.save")}
                </Button>
              </div>
            </form>
          ) : null}

          <h3 id="contacts" className="mt-4 text-sm font-semibold text-ink">
            {t("revenue.customer.contacts")}
          </h3>
          {x.contacts.length === 0 ? (
            <EmptyState title={t("revenue.customer.no_contacts")} />
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {x.contacts.map((c) => (
                <li key={c.id} className="rounded-md border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-ink">
                      {c.name}
                      {c.isPrimary ? (
                        <Badge tone="brand">{t("revenue.customer.primary")}</Badge>
                      ) : null}
                      {c.roleTitle ? (
                        <span className="text-ink-muted"> · {c.roleTitle}</span>
                      ) : null}
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {Object.entries(c.consent).map(([ch, s]) => (
                        <Badge key={ch} tone={consentTone(s)}>
                          {t(`revenue.channel.${ch}`)}: {t(`revenue.consent.${s}`)}
                        </Badge>
                      ))}
                    </span>
                  </div>
                  <p className="flex flex-wrap gap-x-3 text-xs text-ink-secondary">
                    <span>{t(`revenue.role.${c.roleKind}`)}</span>
                    {c.email ? <span dir="ltr">{c.email}</span> : null}
                    {c.phone ? <span dir="ltr">{c.phone}</span> : null}
                    {c.language ? <span>{c.language.toUpperCase()}</span> : null}
                  </p>
                  {canManage ? (
                    <form
                      action={act(updateContactRoleAction)}
                      className="mt-2 flex flex-wrap items-end gap-2"
                    >
                      <input type="hidden" name="contact_id" value={c.id} />
                      <label className={field}>
                        {t("revenue.customer.role")}
                        <select name="role_kind" defaultValue={c.roleKind} className={input}>
                          {ROLE_KINDS.map((r) => (
                            <option key={r} value={r}>
                              {t(`revenue.role.${r}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={field}>
                        {t("common.language")}
                        <select name="language" defaultValue={c.language ?? ""} className={input}>
                          <option value="">—</option>
                          <option value="en">EN</option>
                          <option value="ar">AR</option>
                        </select>
                      </label>
                      <Button type="submit" variant="secondary">
                        {t("common.save")}
                      </Button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card id="consent">
        <CardHeader
          title={t("revenue.consent.title")}
          meta={
            <span className="flex flex-wrap gap-1">
              {Object.entries(x.consent).map(([ch, s]) => (
                <Badge key={ch} tone={consentTone(s)}>
                  {t(`revenue.channel.${ch}`)}: {t(`revenue.consent.${s}`)}
                </Badge>
              ))}
            </span>
          }
        />
        <p className="text-xs text-ink-muted">{t("revenue.consent.law")}</p>
        {consent.ok && consent.data.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {consent.data.slice(0, 20).map((c) => (
              <li key={c.id} className="flex flex-wrap justify-between gap-2">
                <span className="text-ink">
                  {t(`revenue.channel.${c.channel}`)} · {t(`revenue.consent.${c.status}`)} ·{" "}
                  {c.source}
                  {c.evidence ? ` · ${c.evidence}` : ""}
                </span>
                <span className="text-ink-muted" dir="ltr">
                  {formatDate(c.effectiveAt.slice(0, 10), { locale })} {c.actorName ?? ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {canConsent ? (
          <div className="mt-3 grid grid-cols-1 gap-3 border-t border-line pt-3 lg:grid-cols-2">
            <form action={act(recordConsentAction)} className="flex flex-wrap items-end gap-2">
              <label className={field}>
                {t("revenue.customer.contact")}
                <select name="contact_id" defaultValue="" className={input}>
                  <option value="">{t("revenue.consent.whole_customer")}</option>
                  {x.contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={field}>
                {t("revenue.consent.channel")}
                <select name="channel" defaultValue="email" className={input}>
                  {CONSENT_CHANNELS.map((ch) => (
                    <option key={ch} value={ch}>
                      {t(`revenue.channel.${ch}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={field}>
                {t("revenue.filter.status")}
                <select name="status" defaultValue="granted" className={input}>
                  {(["granted", "withdrawn", "unknown"] as const).map((s) => (
                    <option key={s} value={s}>
                      {t(`revenue.consent.${s}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={field}>
                {t("revenue.consent.source")}
                <select name="source" defaultValue="written" className={input}>
                  {(["written", "verbal", "form", "customer_request", "unsubscribe"] as const).map(
                    (s) => (
                      <option key={s} value={s}>
                        {t(`revenue.consent.source.${s}`)}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className={`${field} min-w-40 flex-1`}>
                {t("revenue.consent.evidence")}
                <input name="evidence" maxLength={500} className={input} />
              </label>
              <Button type="submit" variant="secondary">
                {t("revenue.consent.record")}
              </Button>
            </form>
            <form action={act(suppressAddressAction)} className="flex flex-wrap items-end gap-2">
              <label className={field}>
                {t("revenue.consent.channel")}
                <select name="channel" defaultValue="email" className={input}>
                  {CONSENT_CHANNELS.map((ch) => (
                    <option key={ch} value={ch}>
                      {t(`revenue.channel.${ch}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={`${field} min-w-40 flex-1`}>
                {t("revenue.consent.address")}
                <input name="address" required maxLength={320} className={input} dir="ltr" />
              </label>
              <label className={field}>
                {t("revenue.leads.reason")}
                <select name="reason" defaultValue="manual" className={input}>
                  {(
                    ["objection", "unsubscribe", "bounce", "complaint", "legal", "manual"] as const
                  ).map((r) => (
                    <option key={r} value={r}>
                      {t(`revenue.suppress.${r}`)}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" variant="danger">
                {t("revenue.consent.suppress")}
              </Button>
            </form>
          </div>
        ) : null}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title={t("revenue.customer.documents")} />
          {x.documents.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("common.none")}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {x.documents.map((d) => (
                <li key={d.id} className="flex justify-between gap-2">
                  <Link
                    href={`/o/${orgId}/documents/${d.id}`}
                    className="truncate text-ink hover:underline"
                  >
                    {d.reference} · {d.title}
                  </Link>
                  <Badge tone="neutral">{d.status}</Badge>
                </li>
              ))}
            </ul>
          )}
          {x.obligations.length > 0 ? (
            <>
              <h3 className="mt-3 text-sm font-semibold text-ink">
                {t("revenue.customer.obligations")}
              </h3>
              <ul className="flex flex-col gap-1 text-sm">
                {x.obligations.map((o) => (
                  <li key={o.id} className="flex justify-between gap-2">
                    <span className="truncate text-ink">
                      {o.title} <span className="text-ink-muted">({o.documentReference})</span>
                    </span>
                    <span className="text-xs text-ink-muted" dir="ltr">
                      {formatDate(o.dueOn, { locale })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {x.renewals.length > 0 ? (
            <>
              <h3 className="mt-3 text-sm font-semibold text-ink">
                {t("revenue.customer.renewals")}
              </h3>
              <ul className="flex flex-col gap-1 text-sm">
                {x.renewals.map((o) => (
                  <li key={o.id} className="flex justify-between gap-2">
                    <span className="truncate text-ink">{o.title}</span>
                    <span className="text-xs text-warning" dir="ltr">
                      {formatDate(o.dueOn, { locale })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>
        <Card>
          <CardHeader title={t("revenue.customer.issues")} />
          {x.issues.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("common.none")}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {x.issues.map((i) => (
                <li key={i.id} className="flex justify-between gap-2">
                  <Link
                    href={`/o/${orgId}/issues/${i.id}`}
                    className="truncate text-ink hover:underline"
                  >
                    {i.title}
                  </Link>
                  <Badge tone={i.status === "open" ? "warning" : "neutral"}>{i.status}</Badge>
                </li>
              ))}
            </ul>
          )}
          {merges.ok && merges.data.length > 0 ? (
            <>
              <h3 className="mt-3 text-sm font-semibold text-ink">{t("revenue.merge.evidence")}</h3>
              <ul className="flex flex-col gap-1 text-xs">
                {merges.data.map((m) => (
                  <li key={m.id} className="text-ink">
                    {formatDate(m.appliedAt.slice(0, 10), { locale })} · {m.appliedBy ?? ""} ·{" "}
                    {m.reason} ·{" "}
                    {Object.entries(m.repointed)
                      .filter(([, n]) => n > 0)
                      .map(([k, n]) => `${k} ${n}`)
                      .join(", ")}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>
        <Card id="timeline">
          <CardHeader
            title={t("revenue.customer.timeline")}
            meta={
              <span className="text-xs text-ink-muted">
                {t("revenue.customer.open_activities", { n: x.activities.open })}
              </span>
            }
          />
          {canManage ? (
            <form action={act(logCustomerActivityAction)} className="mb-3 flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
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
          {activities.ok ? (
            activities.data.rows.length === 0 ? (
              <p className="text-sm text-ink-muted">{t("common.none")}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {activities.data.rows.map((a) => (
                  <li key={a.id} className="flex flex-col rounded-md border border-line px-3 py-2">
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
                      <span className="text-xs text-ink-secondary">{a.body.slice(0, 200)}</span>
                    ) : null}
                    <span className="text-xs text-ink-muted">
                      {a.actorName ?? ""}
                      {a.dueDate && !a.completedAt
                        ? ` · ${t("revenue.activity.due")} ${formatDate(a.dueDate, { locale })}`
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="text-sm text-danger">
              {t("revenue.section_failed", { section: t("revenue.customer.timeline") })}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
