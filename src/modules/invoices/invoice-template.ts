/**
 * The Arabic-PRIMARY bilingual tax-invoice HTML (F-42/F-43; BUILD_BIBLE §19 — Arabic
 * is not a follow-up). RTL document, Latin serials/amounts bidi-isolated (ltr()),
 * Latin numerals under ar (F-44), every interpolation HTML-escaped (§6.11). A QR slot
 * carries the partner-supplied clearance QR (ZATCA TLV/base64) when present. Pure — no
 * VAT re-derivation (the recorded document amounts are trusted, P5).
 */
import { formatMoney } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";

export type InvoiceTemplateLine = {
  description: string;
  qty: number;
  unit: string;
  unitPriceMinor: number;
  vatRate: number;
  lineTotalMinor: number;
};
export type InvoiceTemplateData = {
  reference: string;
  kind: "invoice" | "credit_note";
  correctsReference: string | null;
  orgName: string;
  customerName: string | null;
  customerTaxRegNo: string | null;
  issuedAt: string | null;
  dueDate: string | null;
  isExport: boolean;
  currency: CurrencyCode;
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  qr: string | null;
  lines: InvoiceTemplateLine[];
  /** U2 branding (feat.branding_docs): logo embedded as a data URI at render
   * time from tenant-scoped storage; org-name text renders when absent. */
  logoDataUri?: string | null;
  /** U2 branding: printed footer details (address / tax reg / contact). */
  footerDetails?: string | null;
};

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
/** Isolate a Latin token (serial, amount) inside RTL text so bidi doesn't reorder it. */
function ltr(v: unknown): string {
  return `<span dir="ltr" style="unicode-bidi:isolate">${esc(v)}</span>`;
}
function money(minor: number, currency: CurrencyCode): string {
  return ltr(formatMoney(minor, currency, { locale: "ar" }));
}

export function invoiceHtml(data: InvoiceTemplateData): string {
  const titleAr = data.kind === "credit_note" ? "إشعار دائن" : "فاتورة ضريبية";
  const titleEn = data.kind === "credit_note" ? "Credit note" : "Tax invoice";
  const rows = data.lines
    .map(
      (l) => `<tr>
      <td>${esc(l.description)}</td>
      <td class="n">${ltr(l.qty)} ${esc(l.unit)}</td>
      <td class="n">${money(l.unitPriceMinor, data.currency)}</td>
      <td class="n">${ltr(l.vatRate)}%</td>
      <td class="n">${money(l.lineTotalMinor, data.currency)}</td>
    </tr>`,
    )
    .join("");
  return `<div dir="rtl" lang="ar" style="font-family:'Noto Naskh Arabic',Arial,sans-serif;max-width:800px;margin:0 auto;padding:24px;color:#111">
  <style>
    table{width:100%;border-collapse:collapse;margin:12px 0}
    th,td{border:1px solid #ccc;padding:6px 8px;text-align:right;font-size:13px}
    .n{text-align:left}
    .en{color:#666;font-size:11px}
    .grand{font-weight:700;background:#f5f5f5}
    .hd{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
    .qr{width:96px;height:96px;border:1px solid #ccc;display:flex;align-items:center;justify-content:center;font-size:9px;word-break:break-all;padding:2px}
  </style>
  <div class="hd">
    <div>
      ${
        data.logoDataUri
          ? `<img class="logo" src="${esc(data.logoDataUri)}" alt="${esc(data.orgName)}" style="display:block;max-height:64px;max-width:180px;width:auto;height:auto;object-fit:contain;margin-bottom:6px" />`
          : ""
      }
      <div style="font-size:20px;font-weight:700">${esc(data.orgName)}</div>
      <div>${titleAr} <span class="en">/ ${titleEn}</span></div>
      <div>الرقم / No.: ${ltr(data.reference)}</div>
      ${data.correctsReference ? `<div>تصحيح للفاتورة / Corrects: ${ltr(data.correctsReference)}</div>` : ""}
      <div>التاريخ / Date: ${ltr((data.issuedAt ?? "").slice(0, 10))}</div>
      ${data.dueDate ? `<div>تاريخ الاستحقاق / Due: ${ltr(data.dueDate)}</div>` : ""}
      ${data.isExport ? `<div>توريد تصدير (صفري) / Export supply (zero-rated)</div>` : ""}
    </div>
    <div class="qr">${data.qr ? esc(data.qr.slice(0, 120)) : "QR"}</div>
  </div>
  <div>
    <div>العميل / Customer: ${esc(data.customerName ?? "—")}</div>
    ${data.customerTaxRegNo ? `<div>الرقم الضريبي / Tax reg.: ${ltr(data.customerTaxRegNo)}</div>` : ""}
  </div>
  <table>
    <thead><tr>
      <th>الوصف <span class="en">/ Description</span></th>
      <th class="n">الكمية <span class="en">/ Qty</span></th>
      <th class="n">السعر <span class="en">/ Price</span></th>
      <th class="n">الضريبة <span class="en">/ VAT</span></th>
      <th class="n">الإجمالي <span class="en">/ Total</span></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <table>
    <tr><td>المجموع الفرعي / Subtotal</td><td class="n">${money(data.subtotalMinor, data.currency)}</td></tr>
    <tr><td>ضريبة القيمة المضافة / VAT</td><td class="n">${money(data.vatMinor, data.currency)}</td></tr>
    <tr class="grand"><td>الإجمالي المستحق / Total due</td><td class="n">${money(data.totalMinor, data.currency)}</td></tr>
  </table>
  ${
    data.footerDetails
      ? `<div dir="auto" style="margin-top:24px;color:#666;font-size:11px;text-align:center;white-space:pre-line">${esc(data.footerDetails)}</div>`
      : ""
  }
  <div class="en" style="margin-top:16px">${esc(data.orgName)} — ${ltr(data.reference)}</div>
</div>`;
}
