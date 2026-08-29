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
  searchParams: Promise<{ status?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "quotes.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const currency = resolved.baseCurrency as CurrencyCode;
  // H18 drill-down contract: ?status=awaiting = the dashboard rule (draft or
  // pending approval); unknown values are safely ignored.
  const { awaiting } = parseQuotesSearch(sp);
  const all = await listQuotes(resolved.ctx, resolved.archetype);
  const rows = awaiting ? all.filter((r) => quoteIsAwaiting(r)) : all;
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
      {awaiting ? (
        <FilterBar
          summary={t("filters.quotes.awaiting")}
          countLabel={t("filters.count", { count: rows.length })}
          clearHref={quotesHref(orgId)}
          clearLabel={t("jobs.filter_clear")}
        />
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title={awaiting ? t("filters.empty") : t("quotes.empty")}
          description={awaiting ? t("filters.empty_hint") : undefined}
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
