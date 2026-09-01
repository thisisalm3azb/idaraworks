import { notFound, redirect } from "next/navigation";
import { Button, Card, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { financeSurfacesEnabled } from "@/platform/flags";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { apOpenItems, listMoneyTransactions } from "@/modules/finance/service";
import { allocateSupplierPaymentAction } from "../actions";

/** H24K — payables: goods-receipt open items and supplier settlement. */
export default async function PayablesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  if (!financeSurfacesEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "finance.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const currency = resolved.baseCurrency as CurrencyCode;
  const money = (minor: number) => formatMoney(minor, currency, { locale });
  const reconciles = can(resolved.archetype, "finance.reconcile");
  const [open, txns] = await Promise.all([
    apOpenItems(resolved.ctx, resolved.archetype),
    listMoneyTransactions(resolved.ctx, resolved.archetype, { limit: 100 }),
  ]);
  const supplierPayments = txns.filter((m) => m.kind === "payment" && m.status !== "void");
  const allocate = allocateSupplierPaymentAction.bind(null, orgId);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("nav.finance_payables")}</h1>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}

      {reconciles && supplierPayments.length > 0 && open.length > 0 ? (
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-ink">
            {t("finance.receivables.allocate")}
          </h2>
          <p className="mb-2 text-xs text-ink-muted">{t("finance.payables.allocate_hint")}</p>
          <form action={allocate} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs text-ink-muted">
              {t("finance.payables.payment")}
              <select name="money_transaction_id" className={input} dir="ltr">
                {supplierPayments.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.reference} · {p.partyName ?? "—"} · {money(p.amountMinor)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.payables.receipt")}
              <select name="goods_receipt_id" className={input} dir="ltr">
                {open.map((o) => (
                  <option key={o.goodsReceiptId} value={o.goodsReceiptId}>
                    {o.reference} · {money(o.outstandingMinor)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.banking.amount")}
              <input
                name="amount"
                type="number"
                step="0.01"
                min="0.01"
                required
                className={input}
                dir="ltr"
              />
            </label>
            <div className="sm:col-span-3">
              <Button type="submit">{t("finance.receivables.allocate")}</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {open.length === 0 ? (
        <EmptyState title={t("finance.payables.clear")} />
      ) : (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("finance.payables.open")}</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[26rem] text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-ink-muted">
                  <th className="py-2 text-start">{t("finance.payables.receipt")}</th>
                  <th className="py-2 text-start">{t("finance.payables.received")}</th>
                  <th className="py-2 text-end">{t("finance.payables.value")}</th>
                  <th className="py-2 text-end">{t("finance.payables.settled")}</th>
                  <th className="py-2 text-end">{t("finance.receivables.outstanding")}</th>
                </tr>
              </thead>
              <tbody>
                {open.map((o) => (
                  <tr key={o.goodsReceiptId} className="border-b border-line last:border-0">
                    <td className="py-2" dir="ltr">
                      {o.reference}
                    </td>
                    <td className="py-2 text-ink-muted" dir="ltr">
                      {formatDate(o.receivedOn, { locale })}
                    </td>
                    <td className="py-2 text-end" dir="ltr">
                      {money(o.valueMinor)}
                    </td>
                    <td className="py-2 text-end" dir="ltr">
                      {money(o.settledMinor)}
                    </td>
                    <td className="py-2 text-end font-medium text-ink" dir="ltr">
                      {money(o.outstandingMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
