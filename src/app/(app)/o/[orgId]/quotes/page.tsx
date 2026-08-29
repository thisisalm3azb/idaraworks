import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, EmptyState, FilterBar } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { parseQuotesSearch, quoteIsAwaiting, quotesHref } from "@/modules/dashboard/service";
import { formatMoney } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import { listQuotes } from "@/modules/quotes/service";
import { getCustomer } from "@/modules/masters/service";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { getServerLocale } from "@/platform/i18n/server";

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  draft: "neutral",
  pending_approval: "info",
  approved: "info",
  sent: "info",
  accepted: "success",
  converted: "success",
  rejected: "danger",
  expired: "neutral",
};

export default async function QuotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ status?: string; customer?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "quotes.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const currency = resolved.baseCurrency as CurrencyCode;
  // H18/H19 drill-down contract: ?status=awaiting (the dashboard rule) and
  // ?customer=<uuid> (SQL-side, org-scoped — a foreign or unknown id yields
  // the same honest empty list); unknown values are safely ignored.
  const { awaiting, customerId } = parseQuotesSearch(sp);
  const all = await listQuotes(resolved.ctx, resolved.archetype, {
    customerId: customerId ?? undefined,
  });
  const rows = awaiting ? all.filter((r) => quoteIsAwaiting(r)) : all;
  const filterCustomer = customerId
    ? await getCustomer(resolved.ctx, resolved.archetype, customerId).catch(() => null)
    : null;
  const filtered = awaiting || customerId !== null;
  const summary = [
    awaiting ? t("filters.quotes.awaiting") : null,
    customerId
      ? filterCustomer
        ? t("filters.customer", { name: filterCustomer.name })
        : t("filters.customer_generic", { customer: term("customer", terms, "singular") })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("quotes.title")}</h1>
        {can(resolved.archetype, "quotes.manage") ? (
          <Link href={`/o/${orgId}/quotes/new`}>
            <Button>{t("quotes.new")}</Button>
          </Link>
        ) : null}
      </div>
      {filtered ? (
        <FilterBar
          summary={summary}
          countLabel={t("filters.count", { count: rows.length })}
          clearHref={quotesHref(orgId)}
          clearLabel={t("jobs.filter_clear")}
        />
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title={filtered ? t("filters.empty") : t("quotes.empty")}
          description={filtered ? t("filters.empty_hint") : undefined}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((q) => (
            <li key={q.id}>
              <Link
                href={`/o/${orgId}/quotes/${q.id}`}
                className="block rounded-md border border-line bg-card p-4 hover:bg-sunken"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">{q.reference}</span>
                  <Badge tone={TONE[q.status] ?? "neutral"}>{t(`quotes.status.${q.status}`)}</Badge>
                </div>
                <p className="mt-1 text-xs text-ink-muted">
                  {q.customerName ?? "—"}
                  {q.totalMinor !== null ? ` · ${formatMoney(q.totalMinor, currency)}` : ""}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
