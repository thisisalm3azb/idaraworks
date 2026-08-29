import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, EmptyState, FilterBar } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatMoney } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import { listExpenses } from "@/modules/expenses/service";
import { expenseIsUnpaid, expensesHref, parseExpensesSearch } from "@/modules/dashboard/service";

export default async function ExpensesPage({
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
  if (!can(resolved.archetype, "expenses.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const currency = resolved.baseCurrency as CurrencyCode;
  // H18 drill-down contract: ?status=unpaid narrows to the dashboard rule
  // (recorded, not voided, not paid); unknown values are safely ignored.
  const { unpaid } = parseExpensesSearch(sp);
  const all = await listExpenses(resolved.ctx, resolved.archetype, { includeVoided: !unpaid });
  const rows = unpaid
    ? all.filter((e) =>
        expenseIsUnpaid({ paymentStatus: e.paymentStatus, voidedAt: e.voided ? "x" : null }),
      )
    : all;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("expenses.title")}</h1>
        {can(resolved.archetype, "expenses.create") ? (
          <Link href={`/o/${orgId}/expenses/new`}>
            <Button>{t("expenses.new")}</Button>
          </Link>
        ) : null}
      </div>
      {unpaid ? (
        <FilterBar
          summary={t("filters.expenses.unpaid")}
          countLabel={t("filters.count", { count: rows.length })}
          clearHref={expensesHref(orgId)}
          clearLabel={t("jobs.filter_clear")}
        />
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title={unpaid ? t("filters.empty") : t("expenses.empty")}
          description={unpaid ? t("filters.empty_hint") : undefined}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((e) => (
            <li key={e.id}>
              <Link
                href={`/o/${orgId}/expenses/${e.id}`}
                className="block rounded-md border border-line bg-card p-4 hover:bg-sunken"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">
                    {e.reference}
                    {e.voided ? (
                      <span className="ms-2 align-middle">
                        <Badge tone="danger">{t("expenses.voided")}</Badge>
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={`font-mono text-sm ${e.voided ? "text-ink-muted line-through" : "text-ink"}`}
                    dir="ltr"
                  >
                    {formatMoney(e.totalMinor, currency)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-muted">
                  {e.expenseDate} · {e.categoryKey}
                  {e.jobName ? ` · ${e.jobName}` : ` · ${t("expenses.overhead")}`}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
