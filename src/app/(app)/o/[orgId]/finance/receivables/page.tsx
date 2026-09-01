import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { financeSurfacesEnabled } from "@/platform/flags";
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { arOpenItems, arAgeing, arUnappliedPayments } from "@/modules/finance/service";
import { allocatePaymentAction } from "../actions";

/** H24K — receivables: open items with ageing, unapplied money, allocation. */
export default async function ReceivablesPage({
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
  const [open, ageing, unapplied] = await Promise.all([
    arOpenItems(resolved.ctx, resolved.archetype),
    arAgeing(resolved.ctx, resolved.archetype),
    arUnappliedPayments(resolved.ctx, resolved.archetype),
  ]);
  const allocate = allocatePaymentAction.bind(null, orgId);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("nav.finance_receivables")}</h1>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {ageing.buckets.map((b) => (
          <Card key={b.label}>
            <p className="text-xs text-ink-muted" dir="ltr">
              {b.label}
            </p>
            <p className="text-sm font-semibold text-ink" dir="ltr">
              {money(b.totalMinor)}
            </p>
          </Card>
        ))}
      </div>

      {reconciles && unapplied.length > 0 && open.length > 0 ? (
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-ink">
            {t("finance.receivables.allocate")}
          </h2>
          <p className="mb-2 text-xs text-ink-muted">{t("finance.receivables.allocate_hint")}</p>
          <form action={allocate} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs text-ink-muted">
              {t("finance.receivables.payment")}
              <select name="payment_id" className={input} dir="ltr">
                {unapplied.map((p) => (
                  <option key={p.paymentId} value={p.paymentId}>
                    {p.reference} · {p.customerName ?? "—"} · {money(p.unappliedMinor)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.receivables.invoice")}
              <select name="invoice_id" className={input} dir="ltr">
                {open.map((i) => (
                  <option key={i.invoiceId} value={i.invoiceId}>
                    {i.reference} · {i.customerName ?? "—"} · {money(i.outstandingMinor)}
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
        <EmptyState title={t("finance.receivables.clear")} />
      ) : (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("finance.receivables.open")}</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-ink-muted">
                  <th className="py-2 text-start">{t("finance.receivables.invoice")}</th>
                  <th className="py-2 text-start">{t("finance.banking.customer")}</th>
                  <th className="py-2 text-end">{t("finance.receivables.outstanding")}</th>
                  <th className="py-2 text-end">{t("finance.receivables.overdue")}</th>
                  <th className="py-2 text-end">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {open.map((i) => (
                  <tr key={i.invoiceId} className="border-b border-line last:border-0">
                    <td className="py-2" dir="ltr">
                      {i.reference}
                    </td>
                    <td className="py-2 text-ink">{i.customerName ?? "—"}</td>
                    <td className="py-2 text-end" dir="ltr">
                      {money(i.outstandingMinor)}
                    </td>
                    <td className="py-2 text-end">
                      {i.daysOverdue > 0 ? (
                        <Badge tone={i.daysOverdue > 60 ? "danger" : "warning"}>
                          {i.daysOverdue}
                        </Badge>
                      ) : (
                        <span className="text-xs text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="py-2 text-end">
                      {i.customerId ? (
                        <a
                          className="text-xs text-accent underline"
                          target="_blank"
                          href={`/api/o/${orgId}/documents/customer_statement/${i.customerId}?print=1&lang=${locale}`}
                        >
                          {t("finance.receivables.statement")}
                        </a>
                      ) : null}
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
