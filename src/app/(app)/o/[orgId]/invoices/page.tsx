import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, EmptyState, FilterBar } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatMoney } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import { listInvoices } from "@/modules/invoices/service";
import { getCustomer } from "@/modules/masters/service";
import { invoicesHref, parseInvoicesSearch } from "@/modules/dashboard/service";
import { loadOrgTerminology, term } from "@/platform/terminology";

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  draft: "neutral",
  issued: "info",
  partially_paid: "warning",
  paid: "success",
  cancelled: "danger",
};

export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ customer?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "invoices.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const currency = resolved.baseCurrency as CurrencyCode;
  // H19 drill-down contract: ?customer=<uuid> narrows SQL-side, org-scoped —
  // a foreign or unknown id yields the same honest empty list.
  const { customerId } = parseInvoicesSearch(sp);
  const rows = await listInvoices(resolved.ctx, resolved.archetype, {
    customerId: customerId ?? undefined,
  });
  const filterCustomer = customerId
    ? await getCustomer(resolved.ctx, resolved.archetype, customerId).catch(() => null)
    : null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("invoices.title")}</h1>
        {can(resolved.archetype, "invoices.manage") ? (
          <Link href={`/o/${orgId}/invoices/new`}>
            <Button>{t("invoices.new")}</Button>
          </Link>
        ) : null}
      </div>
      {customerId ? (
        <FilterBar
          summary={
            filterCustomer
              ? t("filters.customer", { name: filterCustomer.name })
              : t("filters.customer_generic", { customer: term("customer", terms, "singular") })
          }
          countLabel={t("filters.count", { count: rows.length })}
          clearHref={invoicesHref(orgId)}
          clearLabel={t("jobs.filter_clear")}
        />
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title={customerId ? t("filters.empty") : t("invoices.empty")}
          description={customerId ? t("filters.empty_hint") : undefined}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((i) => (
            <li key={i.id}>
              <Link
                href={`/o/${orgId}/invoices/${i.id}`}
                className="block rounded-md border border-line bg-card p-4 hover:bg-sunken"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">
                    {i.reference}
                    {i.kind === "credit_note" ? (
                      <span className="ms-2">
                        <Badge tone="warning">{t("invoices.credit_note")}</Badge>
                      </span>
                    ) : null}
                  </span>
                  <Badge tone={TONE[i.status] ?? "neutral"}>
                    {t(`invoices.status.${i.status}`)}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-ink-muted">
                  {i.customerName ?? "—"}
                  {i.totalMinor !== null ? ` · ${formatMoney(i.totalMinor, currency)}` : ""}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
