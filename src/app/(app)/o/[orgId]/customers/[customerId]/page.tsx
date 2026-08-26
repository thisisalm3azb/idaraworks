import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import { formatDate } from "@/platform/format";
import { getCustomer } from "@/modules/masters/service";
import { setCustomerActiveAction } from "../actions";
import { CustomerLifecycle } from "./CustomerLifecycle";

/**
 * Customer detail (003C): the record's home. Everything about it, its
 * lifecycle state, Edit / Archive / Reactivate where permitted, and the
 * continuity actions the audit demanded (create a quotation / work record for
 * this customer). Archived customers stay fully viewable — history is never
 * hidden.
 */
export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; customerId: string }>;
}) {
  const { orgId, customerId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const customerT = term("customer", terms, "singular");
  const jobT = term("job", terms, "singular");

  const c = await getCustomer(resolved.ctx, resolved.archetype, customerId);
  if (!c) notFound();
  const canManage = can(resolved.archetype, "customers.manage");
  const canQuote = can(resolved.archetype, "quotes.manage");
  const canJob = can(resolved.archetype, "jobs.create");

  const lifecycleAction = setCustomerActiveAction.bind(null, orgId, customerId);

  const rows: Array<[string, string | null, boolean?]> = [
    [t("customers.contact_name"), c.contactName],
    [t("common.phone"), c.phone, true],
    [t("common.email"), c.email, true],
    [t("customers.tax_no"), c.taxRegNo, true],
    [t("customers.country"), c.country],
    [t("common.notes"), c.notes],
    [t("common.created"), formatDate(c.createdAt, { locale })],
    [t("common.updated"), formatDate(c.updatedAt, { locale })],
  ];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Link href={`/o/${orgId}/customers`} className="text-sm text-accent hover:underline">
        ← {t("customers.back", { customers: term("customer", terms, "plural") })}
      </Link>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardHeader title={c.name} />
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
          {rows.map(([label, value, ltr]) => (
            <div key={label} className="flex min-h-11 items-center justify-between gap-3 py-2">
              <dt className="text-sm text-ink-muted">{label}</dt>
              <dd
                dir={ltr && value ? "ltr" : undefined}
                className="max-w-[60%] truncate text-sm text-ink"
              >
                {value ?? "—"}
              </dd>
            </div>
          ))}
        </dl>
        {canManage ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href={`/o/${orgId}/customers/${c.id}/edit`}>
              <Button type="button">{t("common.edit")}</Button>
            </Link>
            <CustomerLifecycle
              active={c.active}
              action={lifecycleAction}
              dict={{
                archive: t("customers.lifecycle.archive", { customer: customerT }),
                reactivate: t("customers.lifecycle.reactivate", { customer: customerT }),
                confirm_title: t("customers.lifecycle.confirm_title", { name: c.name }),
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
          </div>
        ) : null}
      </Card>

      {c.active && (canQuote || canJob) ? (
        <Card>
          <CardHeader title={t("customers.next.title")} />
          <div className="flex flex-wrap gap-2">
            {canQuote ? (
              <Link href={`/o/${orgId}/quotes/new?customer=${c.id}`}>
                <Button type="button" variant="secondary">
                  {t("customers.next.quote")}
                </Button>
              </Link>
            ) : null}
            {canJob ? (
              <Link href={`/o/${orgId}/jobs?customer=${c.id}`}>
                <Button type="button" variant="secondary">
                  {t("customers.next.job", { job: jobT })}
                </Button>
              </Link>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
