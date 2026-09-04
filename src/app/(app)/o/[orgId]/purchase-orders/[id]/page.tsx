import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { stockSurfacesEnabled } from "@/platform/flags";
import { getPurchaseOrder } from "@/modules/supply/service";
import { receivingReadiness, unpostedReceipts } from "@/modules/inventory/service";
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { submitPoAction, recordGrnAction, postReceiptToStockAction } from "../actions";

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
  searchParams: Promise<{ ok?: string; error?: string; warn?: string }>;
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

  /*
   * H30 LB-3: what the stock ledger actually holds for this order's receipts.
   * Read only when the stock system is released, so a deployment with it off
   * behaves exactly as before and pays for no extra queries.
   */
  const stockOn = stockSurfacesEnabled() && can(a, "inventory.view");
  const [unposted, readiness] = stockOn
    ? await Promise.all([
        unpostedReceipts(resolved.ctx, a, { poId: id }),
        receivingReadiness(resolved.ctx),
      ])
    : [[], { ok: true, warehouses: 0, locations: 0, missingKey: null as string | null }];
  const canReplay = stockOn && can(a, "inventory.receive");
  const canSetUpStock = stockOn && can(a, "inventory.adjust");

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
      {sp.ok === "stocked" ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success" role="status">
          {t("po.unposted.posted_ok")}
        </p>
      ) : null}
      {sp.warn === "still_not_stocked" ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning" role="alert">
          {t("po.unposted.still_blocked")}
        </p>
      ) : null}

      {/*
       * H30 LB-3 — the guided remedy.
       *
       * This replaces a one-line banner reading "check the warehouse setup and
       * receive again". Both halves of that advice were wrong: there was no
       * warehouse setup screen to check, and receiving again creates a SECOND
       * receipt rather than replaying the failed one, which counts the goods
       * twice. Najolatech followed it and ended with two receipts and no stock.
       *
       * What replaces it: the specific thing that is missing, a link to the
       * screen that fixes it, and a button that replays THIS receipt — with the
       * duplication warning stated rather than implied. It is driven by the
       * ledger's own state, so it appears whenever a receipt is genuinely
       * unposted, not only on the redirect that first reported it.
       */}
      {unposted.length > 0 ? (
        <Card>
          <CardHeader title={t("po.unposted.title")} />
          <p className="text-sm text-ink-secondary">{t("po.unposted.body")}</p>
          <p className="mt-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
            {t("po.unposted.do_not_receive_again")}
          </p>
          {!readiness.ok ? (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-sm text-ink">{t(readiness.missingKey!)}</p>
              {canSetUpStock ? (
                <Link
                  href={`/o/${orgId}/stock/warehouses`}
                  className="inline-flex min-h-11 w-fit items-center rounded-md bg-brand px-4 text-sm font-medium text-on-brand"
                >
                  {t("po.unposted.fix_setup")}
                </Link>
              ) : null}
            </div>
          ) : null}
          <ul className="mt-3 flex flex-col gap-2">
            {unposted.map((r) => (
              <li key={r.receiptId} className="rounded-md border border-line px-3 py-2">
                <p className="text-sm text-ink">
                  {t("po.unposted.receipt", { reference: r.reference, date: r.receivedDate })}
                </p>
                <p className="text-xs text-ink-muted">
                  {t("po.unposted.progress", { posted: r.postedLines, total: r.stockableLines })}
                </p>
                {/*
                  H30 LB-7: a line whose item has no base unit can never post,
                  and the poster skips it silently as "not an inventory item".
                  Saying so is the difference between a remedy and a button that
                  appears to do nothing.
                */}
                {r.blockedLines > 0 ? (
                  <p className="text-xs text-warning">
                    {t("po.unposted.blocked_no_unit", { count: r.blockedLines })}
                  </p>
                ) : null}
                {canReplay ? (
                  <form
                    action={postReceiptToStockAction.bind(null, orgId, id, r.receiptId)}
                    className="mt-2"
                  >
                    <Button type="submit" variant="secondary" className="min-h-11">
                      {t("po.unposted.post_now")}
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-muted">{t("po.unposted.post_hint")}</p>
        </Card>
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
