import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import { idaraEnabled, revenueStudioEnabled } from "@/platform/flags";
import { AskIdara } from "../../idara/AskIdara";
import { askDictFor } from "../../idara/dict";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { gatherCustomer360 } from "@/modules/crm/service";
import {
  arHref,
  invoicesHref,
  jobsHref,
  opportunitiesHref,
  orgToday,
  quotesHref,
} from "@/modules/dashboard/service";
import { setCustomerActiveAction } from "../actions";
import { addContactAction, removeContactAction } from "./actions";
import { CustomerLifecycle } from "./CustomerLifecycle";

/**
 * H19 — Customer 360: the relationship hub. Identity, real attention
 * conditions, commercial activity, work and delivery, money (the SAME
 * financial definitions as /ar via the shared CTE), contacts and the
 * lifecycle timeline — every number linking to its exact records through
 * the canonical H18/H19 filter contracts. Empty sections are not rendered;
 * failed sections are labelled honestly; restricted money renders as
 * restricted, never as zero.
 */
export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; customerId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId, customerId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const customerT = term("customer", terms, "singular");
  const jobsT = term("job", terms, "plural");
  const currency = resolved.baseCurrency as CurrencyCode;
  const asOf = orgToday(new Date(), resolved.timezone);

  const view = await gatherCustomer360(resolved.ctx, resolved.archetype, customerId, { asOf });
  if (!view) notFound();
  const c = view.customer;
  const a = resolved.archetype;
  const canManage = can(a, "customers.manage");
  const canQuote = can(a, "quotes.manage");
  const lifecycleAction = setCustomerActiveAction.bind(null, orgId, customerId);
  const addContact = addContactAction.bind(null, orgId, customerId);
  const removeContact = removeContactAction.bind(null, orgId, customerId);
  const money = view.money;
  const dash = "—";

  const attentionRows: Array<{ key: string; label: string; href: string }> = [];
  if (view.attention) {
    if (view.attention.over90) {
      attentionRows.push({
        key: "over90",
        label: t("crm.attention.over90"),
        href: arHref(orgId, "over90", c.id),
      });
    } else if (view.attention.overdueInvoices > 0) {
      attentionRows.push({
        key: "overdue_inv",
        label: t("crm.attention.overdue_invoices"),
        href: arHref(orgId, "overdue", c.id),
      });
    }
    if (view.attention.expiredQuotes > 0) {
      attentionRows.push({
        key: "expired_quotes",
        label: t("crm.attention.expired_quotes", { count: view.attention.expiredQuotes }),
        href: quotesHref(orgId, false, c.id),
      });
    }
    if (view.attention.blockedJobs > 0) {
      attentionRows.push({
        key: "on_hold",
        label: t("crm.attention.on_hold", { count: view.attention.blockedJobs, jobs: jobsT }),
        href: jobsHref(orgId, { customerId: c.id }),
      });
    }
  }

  const TIMELINE_LABEL: Record<string, string> = {
    customer_created: t("crm.timeline.customer_created", { customer: customerT }),
    quote_created: t("crm.timeline.quote_created"),
    quote_accepted: t("crm.timeline.quote_accepted"),
    quote_rejected: t("crm.timeline.quote_rejected"),
    job_created: t("crm.timeline.job_created", { job: term("job", terms, "singular") }),
    job_completed: t("crm.timeline.job_completed", { job: term("job", terms, "singular") }),
    invoice_issued: t("crm.timeline.invoice_issued"),
    payment_recorded: t("crm.timeline.payment_recorded"),
    update_sent: t("crm.timeline.update_sent"),
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Link href={`/o/${orgId}/customers`} className="text-sm text-accent hover:underline">
        ← {t("customers.back", { customers: term("customer", terms, "plural") })}
      </Link>

      {sp.ok === "contact_added" ? (
        <p role="status" className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {t("crm.contact.added")}
        </p>
      ) : null}
      {sp.error ? (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {t("common.error")}
        </p>
      ) : null}

      {/* 1 — Identity */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardHeader title={c.displayName} />
          <Badge tone={c.active ? "success" : "neutral"}>
            {c.active ? t("common.active") : t("customers.archived")}
          </Badge>
        </div>
        {!c.active ? (
          <p className="mb-3 rounded-md bg-sunken p-3 text-sm text-ink-secondary">
            {t("customers.archived_note", { customer: customerT })}
          </p>
        ) : null}
        <dl className="divide-y divide-line">
          {(
            [
              [
                t("crm.identity.primary_contact"),
                c.primaryContact
                  ? `${c.primaryContact.name}${c.primaryContact.roleTitle ? ` · ${c.primaryContact.roleTitle}` : ""}`
                  : null,
                false,
              ],
              [t("common.phone"), c.primaryContact?.phone ?? null, true],
              [t("common.email"), c.primaryContact?.email ?? null, true],
              [t("customers.tax_no"), c.taxRegNo, true],
              [t("customers.country"), c.country, false],
              [t("common.notes"), c.notes, false],
              [t("common.created"), formatDate(c.createdAt, { locale }), false],
            ] as Array<[string, string | null, boolean]>
          )
            .filter(([, v]) => v !== null && v !== "")
            .map(([label, value, ltr]) => (
              <div key={label} className="flex min-h-11 items-center justify-between gap-3 py-2">
                <dt className="text-sm text-ink-muted">{label}</dt>
                <dd
                  dir={ltr && value ? "ltr" : undefined}
                  className="max-w-[60%] truncate text-sm text-ink"
                >
                  {value ?? dash}
                </dd>
              </div>
            ))}
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          {canManage ? (
            <>
              <Link href={`/o/${orgId}/customers/${c.id}/edit`}>
                <Button type="button">{t("common.edit")}</Button>
              </Link>
              <CustomerLifecycle
                active={c.active}
                action={lifecycleAction}
                dict={{
                  archive: t("customers.lifecycle.archive", { customer: customerT }),
                  reactivate: t("customers.lifecycle.reactivate", { customer: customerT }),
                  confirm_title: t("customers.lifecycle.confirm_title", { name: c.displayName }),
                  confirm_body: t("customers.lifecycle.confirm_body"),
                  impact_selectors: t("customers.lifecycle.impact_selectors", {
                    customer: customerT,
                  }),
                  impact_history: t("customers.lifecycle.impact_history"),
                  impact_reversible: t("customers.lifecycle.impact_reversible"),
                  confirm: t("customers.lifecycle.confirm"),
                  cancel: t("common.cancel"),
                  close: t("common.close"),
                  failed: t("customers.lifecycle.failed"),
                }}
              />
            </>
          ) : null}
          {revenueStudioEnabled() ? (
            <Link href={`/o/${orgId}/revenue/customers/${c.id}`}>
              <Button type="button" variant="secondary">
                {t("customers.next.revenue")}
              </Button>
            </Link>
          ) : null}
          {idaraEnabled() ? (
            <AskIdara
              record={{ type: "customer", id: c.id, label: c.displayName }}
              dict={askDictFor(t)}
              agentId="sales_crm"
            />
          ) : null}
          {canQuote && c.active ? (
            <Link href={`/o/${orgId}/quotes/new?customer=${c.id}`}>
              <Button type="button" variant="secondary">
                {t("customers.next.quote")}
              </Button>
            </Link>
          ) : null}
        </div>
      </Card>

      {view.failed.length > 0 ? (
        <p role="status" className="rounded-md bg-warning-soft p-3 text-sm text-warning">
          {t("crm.partial_unavailable")}
        </p>
      ) : null}

      {/* 2 — Needs attention (only when real) */}
      {attentionRows.length > 0 ? (
        <section aria-labelledby="crm-attention-h" className="flex flex-col gap-2">
          <h2 id="crm-attention-h" className="text-sm font-semibold text-ink">
            {t("crm.attention.title")}
          </h2>
          <ul className="flex flex-col gap-2">
            {attentionRows.map((r) => (
              <li key={r.key}>
                <Link
                  href={r.href}
                  className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-line bg-card px-3 py-2.5 hover:bg-sunken"
                >
                  <span className="flex items-center gap-2 text-sm text-ink">
                    <span aria-hidden className="size-2 rounded-full bg-warning" />
                    {r.label}
                  </span>
                  <span aria-hidden className="text-ink-muted rtl:rotate-180">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 3 — Money (price-permission enforced; zero ≠ restricted ≠ failed) */}
      {view.moneyState !== "hidden" ? (
        <Card>
          <CardHeader
            title={t("crm.money.title")}
            meta={
              <span className="text-xs text-ink-muted">
                {t("crm.money.period")} · {currency}
              </span>
            }
          />
          {view.moneyState === "failed" ? (
            <p className="text-sm text-ink-muted">{t("crm.section_unavailable")}</p>
          ) : view.moneyState === "restricted" ? (
            <p className="text-sm text-ink-muted">{t("ar.redacted_hint")}</p>
          ) : money ? (
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {(
                [
                  [t("crm.money.invoiced"), money.invoicedMinor, invoicesHref(orgId, c.id)],
                  [t("crm.money.paid"), money.paidMinor, `/o/${orgId}/payments`],
                  [t("crm.money.outstanding"), money.outstandingMinor, arHref(orgId, "all", c.id)],
                  [t("crm.money.overdue"), money.overdueMinor, arHref(orgId, "overdue", c.id)],
                ] as Array<[string, number, string]>
              ).map(([label, v, href]) => (
                <Link
                  key={label}
                  href={href}
                  className="flex min-h-11 min-w-0 flex-col gap-0.5 rounded-lg border border-line bg-card p-3 hover:border-line-strong hover:bg-sunken"
                >
                  <span className="text-xs text-ink-muted">{label}</span>
                  <span
                    dir="ltr"
                    className="break-all font-mono text-sm font-semibold text-ink sm:text-base"
                  >
                    {formatMoney(v, currency, { locale })}
                  </span>
                </Link>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* 4 — Commercial activity (quotes) */}
      {view.quotes !== null || view.failed.includes("quotes") ? (
        <Card>
          <CardHeader
            title={t("crm.quotes.title")}
            meta={
              view.quotes && view.quotes.length > 0 ? (
                <Link
                  href={quotesHref(orgId, false, c.id)}
                  className="text-sm text-brand hover:underline"
                >
                  {t("dashboard.view_all")}
                </Link>
              ) : undefined
            }
          />
          {view.failed.includes("quotes") ? (
            <p className="text-sm text-ink-muted">{t("crm.section_unavailable")}</p>
          ) : view.quotes!.length === 0 ? (
            <p className="text-sm text-ink-muted">
              {t("crm.quotes.empty")}{" "}
              {canQuote && c.active ? (
                <Link
                  href={`/o/${orgId}/quotes/new?customer=${c.id}`}
                  className="text-brand hover:underline"
                >
                  {t("customers.next.quote")}
                </Link>
              ) : null}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {view.quotes!.slice(0, 6).map((q) => (
                <li key={q.id}>
                  <Link
                    href={`/o/${orgId}/quotes/${q.id}`}
                    className="flex min-h-11 items-center justify-between gap-3 py-2"
                  >
                    <span className="text-sm font-medium text-ink">{q.reference}</span>
                    <span className="flex items-center gap-2">
                      <Badge tone="neutral">{t(`quotes.status.${q.status}`)}</Badge>
                      {q.totalMinor !== null ? (
                        <span dir="ltr" className="font-mono text-sm text-ink">
                          {formatMoney(q.totalMinor, currency, { locale })}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {/* H21 — Delivery: what is being built for this customer right now. */}
      {view.work !== null || view.failed.includes("work") ? (
        <Card>
          <CardHeader
            title={t("crm.work.title")}
            meta={
              view.work && view.work.rows.length > 0 ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-ink-muted">
                    {t("crm.work.summary", {
                      active: view.work.activeCount,
                      completed: view.work.completedCount,
                    })}
                  </span>
                  <Link
                    href={jobsHref(orgId, { customerId: c.id })}
                    className="text-sm text-brand hover:underline"
                  >
                    {t("dashboard.view_all")}
                  </Link>
                </span>
              ) : undefined
            }
          />
          {view.failed.includes("work") ? (
            <p className="text-sm text-ink-muted">{t("crm.section_unavailable")}</p>
          ) : view.work!.rows.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("crm.work.empty")}</p>
          ) : (
            <ul className="divide-y divide-line">
              {view.work!.rows.slice(0, 6).map((w) => (
                <li key={w.id}>
                  <Link
                    href={`/o/${orgId}/jobs/${w.id}`}
                    className="flex min-h-11 flex-wrap items-center justify-between gap-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                      {w.reference} · {w.name}
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      {w.currentStageName ? (
                        <span className="text-xs text-ink-secondary">
                          {locale === "ar" ? w.currentStageName.ar : w.currentStageName.en}
                        </span>
                      ) : null}
                      {w.dueDate ? (
                        <span
                          className={
                            w.dueDate < asOf &&
                            ["draft", "active", "on_hold"].includes(w.statusCategory)
                              ? "text-xs font-medium text-danger"
                              : "text-xs text-ink-secondary"
                          }
                          dir="ltr"
                        >
                          {formatDate(w.dueDate, { locale })}
                        </span>
                      ) : null}
                      <Badge tone={w.statusCategory === "done" ? "success" : "info"}>
                        {t(`work.category.${w.statusCategory}`)}
                      </Badge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {/* H20 — Sales pipeline (opportunities for this customer) */}
      {view.opportunities !== null || view.failed.includes("opportunities") ? (
        <Card>
          <CardHeader
            title={t("crm.opps.title")}
            meta={
              view.opportunities && view.opportunities.length > 0 ? (
                <Link
                  href={opportunitiesHref(orgId, { customerId: c.id, view: "list" })}
                  className="text-sm text-brand hover:underline"
                >
                  {t("dashboard.view_all")}
                </Link>
              ) : undefined
            }
          />
          {view.failed.includes("opportunities") ? (
            <p className="text-sm text-ink-muted">{t("crm.section_unavailable")}</p>
          ) : view.opportunities!.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("crm.opps.empty")}</p>
          ) : (
            <ul className="divide-y divide-line">
              {view.opportunities!.slice(0, 6).map((o) => (
                <li key={o.id}>
                  <Link
                    href={`/o/${orgId}/opportunities/${o.id}`}
                    className="flex min-h-11 flex-wrap items-center justify-between gap-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                      {o.name}
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge
                        tone={
                          o.status === "won" ? "success" : o.status === "lost" ? "neutral" : "info"
                        }
                      >
                        {t(`opps.status.${o.status}`)}
                      </Badge>
                      {o.estimatedValueMinor !== null ? (
                        <span dir="ltr" className="font-mono text-sm text-ink">
                          {formatMoney(o.estimatedValueMinor, currency, { locale })}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {/* 5 — Work and delivery */}
      {view.jobs !== null || view.failed.includes("jobs") ? (
        <Card>
          <CardHeader
            title={t("crm.jobs.title", { jobs: jobsT })}
            meta={
              view.jobs && view.jobs.length > 0 ? (
                <Link
                  href={jobsHref(orgId, { customerId: c.id })}
                  className="text-sm text-brand hover:underline"
                >
                  {t("dashboard.view_all")}
                </Link>
              ) : undefined
            }
          />
          {view.failed.includes("jobs") ? (
            <p className="text-sm text-ink-muted">{t("crm.section_unavailable")}</p>
          ) : view.jobs!.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("crm.jobs.empty", { jobs: jobsT })}</p>
          ) : (
            <ul className="divide-y divide-line">
              {view.jobs!.slice(0, 6).map((j) => (
                <li key={j.id}>
                  <Link
                    href={`/o/${orgId}/jobs/${j.id}`}
                    className="flex min-h-11 items-center justify-between gap-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">
                        {j.reference} {j.name}
                      </span>
                      <span className="block text-xs text-ink-muted">
                        {j.currentStage
                          ? locale === "ar"
                            ? j.currentStage.ar || j.currentStage.en
                            : j.currentStage.en
                          : ""}
                        {j.dueDate
                          ? ` · ${t("jobs.due")} ${formatDate(j.dueDate, { locale })}`
                          : ""}
                      </span>
                    </span>
                    <Badge
                      tone={
                        j.statusCategory === "active"
                          ? "info"
                          : j.statusCategory === "done"
                            ? "success"
                            : j.statusCategory === "on_hold"
                              ? "warning"
                              : "neutral"
                      }
                    >
                      {t(`crm.jobs.status.${j.statusCategory}`)}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {/* 6 — Contacts */}
      <Card>
        <CardHeader title={t("crm.contact.title")} />
        {c.primaryContact === null && c.otherContacts.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("crm.contact.empty")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {[...(c.primaryContact ? [c.primaryContact] : []), ...c.otherContacts].map((ct) => (
              <li key={ct.id} className="flex min-h-11 items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">
                    {ct.name || dash}
                    {ct.isPrimary ? (
                      <span className="ms-2 align-middle">
                        <Badge tone="brand">{t("crm.contact.primary")}</Badge>
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-xs text-ink-muted" dir="ltr">
                    {[ct.phone, ct.email].filter(Boolean).join(" · ") || dash}
                  </span>
                </span>
                {canManage && !ct.legacy ? (
                  <form action={removeContact}>
                    <input type="hidden" name="contact_id" value={ct.id} />
                    <Button type="submit" variant="ghost">
                      {t("crm.contact.remove")}
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canManage && c.active ? (
          <form action={addContact} className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
            <p className="text-sm font-medium text-ink">{t("crm.contact.add_title")}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input
                name="name"
                required
                maxLength={120}
                placeholder={t("crm.contact.name")}
                className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              />
              <input
                name="role_title"
                maxLength={80}
                placeholder={t("crm.contact.role")}
                className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              />
              <input
                name="phone"
                maxLength={32}
                placeholder={t("common.phone")}
                className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              />
              <input
                name="email"
                type="email"
                maxLength={254}
                placeholder={t("common.email")}
                className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              />
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                name="is_primary"
                value="1"
                className="size-4 accent-current"
              />
              {t("crm.contact.make_primary")}
            </label>
            <div>
              <Button type="submit">{t("crm.contact.add_cta")}</Button>
            </div>
          </form>
        ) : null}
      </Card>

      {/* 7 — Timeline */}
      <Card>
        <CardHeader title={t("crm.timeline.title")} />
        {view.failed.includes("timeline") ? (
          <p className="text-sm text-ink-muted">{t("crm.section_unavailable")}</p>
        ) : (view.timeline?.length ?? 0) === 0 ? (
          <EmptyState title={t("crm.timeline.empty")} />
        ) : (
          <ol className="flex flex-col">
            {view.timeline!.map((ev) => (
              <li
                key={ev.key}
                className="flex min-h-11 items-center justify-between gap-3 border-b border-line py-2 last:border-0"
              >
                <span className="min-w-0 text-sm text-ink">
                  {TIMELINE_LABEL[ev.kind] ?? ev.kind}
                  {ev.reference ? (
                    ev.href ? (
                      <>
                        {" "}
                        <Link href={ev.href} className="text-brand hover:underline">
                          {ev.reference}
                        </Link>
                      </>
                    ) : (
                      ` ${ev.reference}`
                    )
                  ) : null}
                </span>
                <span className="shrink-0 text-xs text-ink-muted">
                  {formatDate(ev.at, { locale, timeZone: resolved.timezone ?? undefined })}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
