/**
 * The purchase order as a printable document.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A purchase order could not be printed at all. `purchase_order` was not a
 * document kind, so `/api/o/<org>/documents/purchase_order/<id>` answered 404,
 * and the purchase-order screen showed "PDF pending" for ever — because the only
 * thing that would ever have produced one was a worker that renders the HTML and
 * then stops at an unbuilt store step, behind an unprovisioned queue. A customer
 * could raise an order and never send it to their supplier.
 *
 * The fix is not another renderer. Quotes, invoices, payslips and the finance
 * papers already render on demand through one model → HTML → PDF pipeline; this
 * makes the purchase order the same kind of thing, so it gets the same branding,
 * the same Arabic handling and the same permission gate for free.
 *
 * ── The one difference from a quote ─────────────────────────────────────────
 * A quote freezes its issuer identity when it is sent, because it is a
 * customer-facing commercial document and must not change afterwards. A
 * purchase order has no `issuer_snapshot` column: it is addressed to a supplier
 * and is reprinted from live company details, which is what `resolveIssuer(…,
 * false)` returns.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { getPurchaseOrder } from "@/modules/supply/service";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { resolveIssuer } from "./issuer-resolve";
import type { DocLanguage, DocumentRenderModel } from "@/platform/documents";

/** Bilingual literal, chosen by the document's language. */
const t = (language: DocLanguage, en: string, ar: string) => (language === "ar" ? ar : en);
const dateLocale = (language: DocLanguage) => (language === "ar" ? "ar" : "en");

/**
 * Statuses at which an order is a real instruction to a supplier. A draft is
 * still being written and prints with a DRAFT watermark; a cancelled one prints
 * cancelled, because a supplier who was sent it needs to see that.
 */
export const PURCHASE_ORDER_ISSUED_STATUSES = [
  "approved",
  "sent",
  "partially_received",
  "received",
  "cancelled",
] as const;

// The only PO statuses are draft, approved, sent, partially_received,
// received and cancelled. A draft is watermarked by the "not issued" branch
// below; a cancelled order still prints, marked cancelled, because a supplier
// who was sent it needs to see that it no longer stands.
const WATERMARK: Record<string, "draft" | "cancelled" | null> = {
  cancelled: "cancelled",
};

type Extra = {
  currency: string | null;
  created_at: string | null;
  approved_at: string | null;
  supplier_tax_reg_no: string | null;
  supplier_phone: string | null;
  supplier_email: string | null;
  supplier_terms: string | null;
  job_reference: string | null;
  mr_reference: string | null;
};

export async function purchaseOrderModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  // The read goes through the supply service, so the permission and the tenant
  // scope are the product's own, not this file's idea of them.
  const po = await getPurchaseOrder(ctx, archetype, id);
  if (!po) {
    const { DocumentNotFoundError } = await import("./service");
    throw new DocumentNotFoundError("purchase_order", id);
  }

  // The fields the detail screen does not need but a printed order does.
  const [extra] = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select po.currency,
             po.created_at::text as created_at,
             po.approved_at::text as approved_at,
             s.tax_reg_no as supplier_tax_reg_no,
             s.phone as supplier_phone,
             s.email as supplier_email,
             s.terms_text as supplier_terms,
             j.reference as job_reference,
             mr.reference as mr_reference
      from public.purchase_order po
      left join public.supplier s on s.id = po.supplier_id
      left join public.job j on j.id = po.job_id
      left join public.material_request mr on mr.id = po.mr_id
      where po.id = ${id} and po.org_id = ${ctx.orgId}
    `),
  )) as unknown as Extra[];

  const currency = (extra?.currency ?? "AED") as CurrencyCode;
  const money = (minor: number | string | null) =>
    minor == null ? null : formatMoney(Number(minor), currency, { locale: "en" });

  const issued = (PURCHASE_ORDER_ISSUED_STATUSES as readonly string[]).includes(po.status);
  const { issuer, notice } = await resolveIssuer(ctx, null, false);

  const subtotalMinor = Number(po.totalMinor) - Number(po.vatMinor);

  /*
   * Quantities arrive from the database as fixed-scale numerics — "12.000".
   * A purchase order is read by a supplier's storeman, and "12.000 pcs" is not
   * how anyone writes twelve. Trim the trailing zeros, keep genuine decimals.
   */
  const qty = (v: string) => (v.includes(".") ? v.replace(/0+$/, "").replace(/.$/, "") : v);

  const fields: Array<{ label: string; value: string; ltr?: boolean }> = [];
  if (extra?.supplier_tax_reg_no) {
    fields.push({
      label: t(language, "Supplier TRN", "الرقم الضريبي للمورّد"),
      value: extra.supplier_tax_reg_no,
      ltr: true,
    });
  }
  if (extra?.approved_at) {
    fields.push({
      label: t(language, "Approved", "تم الاعتماد"),
      value: formatDate(extra.approved_at.slice(0, 10), { locale: dateLocale(language) }),
      ltr: true,
    });
  }
  if (po.jobReference ?? extra?.job_reference) {
    fields.push({
      label: t(language, "For job", "للعمل"),
      value: (po.jobReference ?? extra?.job_reference)!,
      ltr: true,
    });
  }
  if (extra?.mr_reference) {
    fields.push({
      label: t(language, "Against request", "مقابل الطلب"),
      value: extra.mr_reference,
      ltr: true,
    });
  }

  return {
    kind: "purchase_order",
    language,
    issuer,
    recipient: po.supplierName
      ? {
          name: po.supplierName,
          // A supplier's contact details belong on the order they are sent.
          lines: [extra?.supplier_phone, extra?.supplier_email].filter(
            (x): x is string => typeof x === "string" && x.length > 0,
          ),
        }
      : null,
    titleEn: "Purchase Order",
    titleAr: "أمر شراء",
    reference: po.reference,
    dateText: extra?.created_at
      ? formatDate(extra.created_at.slice(0, 10), { locale: dateLocale(language) })
      : undefined,
    statusText: po.status,
    watermark: issued ? (WATERMARK[po.status] ?? null) : "draft",
    noticeText: notice,
    fields,
    sections: [
      {
        columns: [
          "#",
          t(language, "Description", "الوصف"),
          t(language, "Qty", "الكمية"),
          t(language, "Unit cost", "تكلفة الوحدة"),
          t(language, "Amount", "المبلغ"),
        ],
        lines: po.lines.map((l, i) => ({
          position: String(i + 1),
          description: l.itemName,
          quantity: qty(String(l.qty)),
          unit: l.unit,
          unitPrice: money(l.unitCostMinor),
          amount: money(l.lineTotalMinor),
        })),
        emptyText: t(language, "No items.", "لا توجد بنود."),
      },
    ],
    totals: [
      { label: t(language, "Subtotal", "المجموع الفرعي"), value: money(subtotalMinor) ?? "" },
      ...(Number(po.vatMinor) > 0
        ? [{ label: t(language, "VAT", "ضريبة القيمة المضافة"), value: money(po.vatMinor)! }]
        : []),
      { label: t(language, "Total", "الإجمالي"), value: money(po.totalMinor) ?? "", strong: true },
    ],
    termsTitle: t(language, "Terms", "الشروط"),
    terms: po.notes ?? extra?.supplier_terms ?? null,
    showSignatory: true,
  };
}
