import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatMoney } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import { getInvoice } from "@/modules/invoices/service";
import {
  issueInvoiceAction,
  voidInvoiceAction,
  creditNoteAction,
  submitEInvoiceAction,
} from "../actions";

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; invoiceId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId, invoiceId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "invoices.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const currency = resolved.baseCurrency as CurrencyCode;
  const inv = await getInvoice(resolved.ctx, resolved.archetype, invoiceId);
  if (!inv) notFound();
  const manage = can(resolved.archetype, "invoices.manage");
  const money = (v: number | null) => (v === null ? "🔒" : formatMoney(v, currency));
  const row = (l: string, v: string) => (
    <div className="flex items-center justify-between gap-2 border-b border-line py-2 text-sm">
      <span className="text-ink-muted">{l}</span>
      <span className="font-mono text-ink" dir="ltr">
        {v}
      </span>
    </div>
  );

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{inv.reference}</h1>
        <Badge tone="info">{t(`invoices.status.${inv.status}`)}</Badge>
      </div>
      {sp.ok ? <Badge tone="success">{t("common.saved")}</Badge> : null}
      {sp.error ? <Badge tone="danger">{t("common.error")}</Badge> : null}
      <Card>
        <CardHeader
          title={inv.customerName ?? "—"}
          meta={
            inv.kind === "credit_note" ? (
              <Badge tone="warning">{t("invoices.credit_note")}</Badge>
            ) : inv.isExport ? (
              <Badge tone="neutral">{t("invoices.export")}</Badge>
            ) : null
          }
        />
        {row(t("invoices.detail.subtotal"), money(inv.subtotalMinor))}
        {row(t("invoices.detail.vat"), money(inv.vatAmountMinor))}
        {row(t("invoices.detail.total"), money(inv.totalMinor))}
        {inv.eInvoiceStatus
          ? row(t("invoices.detail.einvoice"), t(`invoices.einvoice.${inv.eInvoiceStatus}`))
          : null}
      </Card>
      {manage ? (
        <div className="flex flex-col gap-2">
          {inv.status === "draft" ? (
            <>
              <form action={issueInvoiceAction.bind(null, orgId)}>
                <input type="hidden" name="invoice_id" value={inv.id} />
                <Button type="submit" variant="primary">
                  {t("invoices.action.issue")}
                </Button>
              </form>
              <form action={voidInvoiceAction.bind(null, orgId)} className="flex gap-2">
                <input type="hidden" name="invoice_id" value={inv.id} />
                <input
                  name="reason"
                  required
                  placeholder={t("invoices.action.void_reason")}
                  className="min-h-11 flex-1 rounded-md border border-line bg-card px-3 text-sm"
                />
                <Button type="submit" variant="danger">
                  {t("invoices.action.void")}
                </Button>
              </form>
            </>
          ) : null}
          {inv.status !== "draft" && inv.kind === "invoice" ? (
            <>
              <form action={submitEInvoiceAction.bind(null, orgId)}>
                <input type="hidden" name="invoice_id" value={inv.id} />
                <Button type="submit">{t("invoices.action.einvoice")}</Button>
              </form>
              <form action={creditNoteAction.bind(null, orgId)} className="flex gap-2">
                <input type="hidden" name="invoice_id" value={inv.id} />
                <input
                  name="reason"
                  required
                  placeholder={t("invoices.action.credit_reason")}
                  className="min-h-11 flex-1 rounded-md border border-line bg-card px-3 text-sm"
                />
                <Button type="submit" variant="danger">
                  {t("invoices.action.credit_note")}
                </Button>
              </form>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
