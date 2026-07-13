/**
 * The LPO (Local Purchase Order) PDF template — S4 "Arabic PDF pipeline v1"
 * (doc 11). A PURE function: PO data + org/locale → a bilingual (Arabic + English)
 * HTML document, RTL-first, BIDI-correct (Latin serials/amounts isolated inside
 * RTL text via dir="ltr" spans). Rules (BUILD_BIBLE):
 *   §6.11 — HTML templates do NOT get React's auto-escaping: every interpolated
 *           value passes through esc() to prevent injection.
 *   P5    — NEVER re-derive money here (no VAT recompute); the caller passes the
 *           already-computed vat_minor + total_minor and we only FORMAT them.
 *   P8    — "LPO" is the tenant's TERM for purchase_order (terminology layer); the
 *           heading uses the passed term label.
 *   F-44  — numerals are Latin even under ar (formatMoney pins latn).
 * The rendered PDF is snapshot-tested (bidi) + Arabic-native reviewed (owner AC).
 */
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";

export type LpoLine = {
  itemName: string;
  qty: string;
  unit: string;
  unitCostMinor: string;
  lineTotalMinor: string;
};
export type LpoData = {
  reference: string;
  supplierName: string | null;
  jobReference: string | null;
  issueDate: string;
  vatMinor: string;
  totalMinor: string;
  notes: string | null;
  lines: LpoLine[];
};
export type LpoOptions = {
  orgName: string;
  currency: CurrencyCode;
  /** The tenant's term for purchase_order (P8), e.g. "Local Purchase Order". */
  poTermEn: string;
  poTermAr: string;
};

/** Minimal, correct HTML escaping (§6.11 — no React here). */
function esc(v: string | null | undefined): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Isolate a Latin token (serial, number, amount) inside RTL text (bidi). */
function ltr(v: string): string {
  return `<span dir="ltr" style="unicode-bidi:isolate">${esc(v)}</span>`;
}

function money(minor: string, currency: CurrencyCode): string {
  return ltr(formatMoney(Number(minor), currency, { locale: "en" }));
}

export function lpoHtml(data: LpoData, opts: LpoOptions): string {
  const rows = data.lines
    .map(
      (l, i) => `
      <tr>
        <td class="c">${ltr(String(i + 1))}</td>
        <td class="item">${esc(l.itemName)}</td>
        <td class="c">${ltr(l.qty)}</td>
        <td class="c">${esc(l.unit)}</td>
        <td class="e">${money(l.unitCostMinor, opts.currency)}</td>
        <td class="e">${money(l.lineTotalMinor, opts.currency)}</td>
      </tr>`,
    )
    .join("");

  // Bilingual labels: Arabic (primary, RTL) then English.
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: "Noto Naskh Arabic", "Segoe UI", Tahoma, sans-serif; color: #1a1a1a;
         margin: 0; padding: 32px; font-size: 13px; line-height: 1.6; }
  .head { display: flex; justify-content: space-between; align-items: flex-start;
          border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 16px; }
  .org { font-size: 20px; font-weight: 700; }
  .title { text-align: end; }
  .title .en { color: #555; font-size: 12px; }
  .meta { display: flex; gap: 24px; margin-bottom: 16px; flex-wrap: wrap; }
  .meta div { min-width: 140px; }
  .label { color: #666; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; }
  th { background: #f3f3f0; font-size: 11px; }
  td.c { text-align: center; } td.e { text-align: end; } td.item { text-align: start; }
  .totals { margin-top: 12px; width: 260px; margin-inline-start: auto; }
  .totals td { border: none; padding: 3px 8px; }
  .totals .grand { font-weight: 700; border-top: 2px solid #1a1a1a; }
  .notes { margin-top: 16px; white-space: pre-line; }
  .foot { margin-top: 32px; color: #888; font-size: 11px; text-align: center; }
</style>
</head>
<body>
  <div class="head">
    <div class="org">${esc(opts.orgName)}</div>
    <div class="title">
      <div>${esc(opts.poTermAr)}</div>
      <div class="en">${esc(opts.poTermEn)}</div>
      <div>${ltr(data.reference)}</div>
    </div>
  </div>
  <div class="meta">
    <div><div class="label">المورد / Supplier</div>${esc(data.supplierName)}</div>
    <div><div class="label">التاريخ / Date</div>${ltr(data.issueDate)}</div>
    ${
      data.jobReference
        ? `<div><div class="label">المشروع / Job</div>${ltr(data.jobReference)}</div>`
        : ""
    }
  </div>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>الصنف / Item</th>
        <th>الكمية / Qty</th>
        <th>الوحدة / Unit</th>
        <th>سعر الوحدة / Unit price</th>
        <th>الإجمالي / Total</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>
  <table class="totals">
    <tr><td>ضريبة القيمة المضافة / VAT</td><td class="e">${money(data.vatMinor, opts.currency)}</td></tr>
    <tr class="grand"><td>الإجمالي / Grand total</td><td class="e">${money(data.totalMinor, opts.currency)}</td></tr>
  </table>
  ${data.notes ? `<div class="notes"><div class="label">ملاحظات / Notes</div>${esc(data.notes)}</div>` : ""}
  <div class="foot">${esc(opts.orgName)} — ${ltr(data.reference)}</div>
</body>
</html>`;
}
