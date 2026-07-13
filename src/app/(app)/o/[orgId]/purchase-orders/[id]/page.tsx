import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { getPurchaseOrder } from "@/modules/supply/service";
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { submitPoAction, recordGrnAction } from "../actions";

function todayIso(): string {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-${String(
    n.getUTCDate(),
  ).padStart(2, "0")}`;
}

export default async function PoDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId, id } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const a = resolved.archetype;
  if (!can(a, "po.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const po = await getPurchaseOrder(resolved.ctx, a, id);
  if (!po) notFound();
  const currency = resolved.baseCurrency as CurrencyCode;
  const money = (m: string) => formatMoney(Number(m), currency, { locale: "en" });
  const submit = submitPoAction.bind(null, orgId);
  const receive = recordGrnAction.bind(null, orgId);
  const canSubmit = can(a, "po.manage") && po.status === "draft" && !po.pendingApprovalId;
  const canReceive =
    can(a, "grn.create") && ["approved", "sent", "partially_received"].includes(po.status);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{po.reference}</h1>
        <Badge tone={po.status === "received" ? "success" : "info"}>
          {po.pendingApprovalId ? t("po.awaiting_approval") : t(`po.status.${po.status}`)}
        </Badge>
      </div>
      {sp.ok === "received" ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {t("po.grn_recorded")}
        </p>
      ) : null}
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {t("common.error")}
        </p>
      ) : null}

      <Card>
        <p className="text-xs text-ink-muted">
          {po.supplierName ?? "—"}
          {po.jobReference ? ` · ${po.jobReference}` : ""}
        </p>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-ink-muted">
              <th className="py-1 text-start font-normal">{t("mr.item")}</th>
              <th className="py-1 text-end font-normal">{t("po.ordered")}</th>
              <th className="py-1 text-end font-normal">{t("po.received")}</th>
              <th className="py-1 text-end font-normal">{t("po.total")}</th>
            </tr>
          </thead>
          <tbody>
            {po.lines.map((l) => (
              <tr key={l.id} className="border-t border-line">
                <td className="py-1.5 text-ink">{l.itemName}</td>
                <td className="py-1.5 text-end text-ink">
                  {l.orderedQty} {l.unit}
                </td>
                <td className="py-1.5 text-end text-ink">{l.receivedQty}</td>
                <td className="py-1.5 text-end text-ink" dir="ltr">
                  {money(l.lineTotalMinor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 flex justify-between text-sm">
          <span className="text-ink-secondary">{t("po.vat")}</span>
          <span dir="ltr">{money(po.vatMinor)}</span>
        </div>
        <div className="flex justify-between text-sm font-semibold text-ink">
          <span>{t("po.total")}</span>
          <span dir="ltr">{money(po.totalMinor)}</span>
        </div>
        <p className="mt-3 text-sm">
          {po.pdfFileId ? (
            <span className="text-success">{t("po.download_pdf")}</span>
          ) : (
            <span className="text-ink-muted">{t("po.pdf_pending")}</span>
          )}
        </p>
      </Card>

      {canSubmit ? (
        <form action={submit}>
          <input type="hidden" name="po_id" value={po.id} />
          <Button type="submit" size="lg" className="w-full">
            {t("po.submit")}
          </Button>
        </form>
      ) : null}

      {canReceive ? (
        <Card>
          <CardHeader title={t("po.receive")} />
          <form action={receive} className="flex flex-col gap-2">
            <input type="hidden" name="po_id" value={po.id} />
            <input type="hidden" name="received_date" value={todayIso()} />
            {po.lines.map((l) => {
              const remaining = Number(l.orderedQty) - Number(l.receivedQty);
              return (
                <div key={l.id} className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-ink">{l.itemName}</span>
                  <span className="text-xs text-ink-muted">
                    {l.receivedQty}/{l.orderedQty}
                  </span>
                  <input
                    type="number"
                    name={`recv_${l.id}`}
                    min={0}
                    max={remaining}
                    defaultValue={0}
                    className="min-h-11 w-20 rounded-md border border-line-strong bg-card px-2 text-center text-base text-ink"
                  />
                </div>
              );
            })}
            <Button type="submit">{t("po.record_grn")}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
