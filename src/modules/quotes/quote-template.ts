/**
 * The QUOTE print template (U2 branding) — mirrors the LPO template's
 * discipline exactly: a PURE function (quote data + org/branding → bilingual
 * Arabic-primary HTML), RTL-first, BIDI-correct (Latin serials/amounts
 * isolated via dir="ltr" spans). Rules (BUILD_BIBLE):
 *   §6.11 — no React auto-escaping here: every interpolated value passes esc().
 *   P5    — money is NEVER re-derived: the caller passes the already-computed
 *           subtotal/vat/total minors and we only FORMAT them.
 *   F-44  — numerals are Latin even under ar (formatMoney pins latn).
 * Branding (feat.branding_docs, gated by the caller via getDocBranding): the
 * logo arrives as a data URI embedded at render time from tenant-scoped
 * storage; when absent the org-name text header renders — the honest fallback.
 */
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";

export type QuoteTemplateLine = {
  description: string;
  qty: string;
  unit: string;
  unitPriceMinor: string;
  lineTotalMinor: string;
};
export type QuoteTemplateData = {
  reference: string;
  customerName: string | null;
  issueDate: string;
  validUntil: string | null;
  subtotalMinor: string;
  vatMinor: string;
  totalMinor: string;
  terms: string | null;
  lines: QuoteTemplateLine[];
};
export type QuoteTemplateOptions = {
  orgName: string;
  currency: CurrencyCode;
  /** U2 branding: logo data URI (render-time embed) — org-name text fallback. */
  logoDataUri?: string | null;
  /** U2 branding: printed footer details (address / tax reg / contact). */
  footerDetails?: string | null;
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

export function quoteHtml(data: QuoteTemplateData, opts: QuoteTemplateOptions): string {
  const rows = data.lines
    .map(
      (l, i) => `
      <tr>
        <td class="c">${ltr(String(i + 1))}</td>
        <td class="item">${esc(l.description)}</td>
        <td class="c">${ltr(l.qty)}</td>
        <td class="c">${esc(l.unit)}</td>
        <td class="e">${money(l.unitPriceMinor, opts.currency)}</td>
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
  .org img.logo { display: block; max-height: 64px; max-width: 180px;
                  width: auto; height: auto; object-fit: contain; margin-bottom: 6px; }
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
  .terms { margin-top: 16px; white-space: pre-line; }
  .foot-details { margin-top: 24px; color: #666; font-size: 11px;
                  text-align: center; white-space: pre-line; }
  .foot { margin-top: 32px; color: #888; font-size: 11px; text-align: center; }
</style>
</head>
<body>
  <div class="head">
    <div class="org">${
      opts.logoDataUri
        ? `<img class="logo" src="${esc(opts.logoDataUri)}" alt="${esc(opts.orgName)}" />`
        : ""
    }${esc(opts.orgName)}</div>
    <div class="title">
      <div>عرض سعر</div>
      <div class="en">Quotation</div>
      <div>${ltr(data.reference)}</div>
    </div>
  </div>
  <div class="meta">
    <div><div class="label">العميل / Customer</div>${esc(data.customerName)}</div>
    <div><div class="label">التاريخ / Date</div>${ltr(data.issueDate)}</div>
    ${
      data.validUntil
        ? `<div><div class="label">صالح حتى / Valid until</div>${ltr(data.validUntil)}</div>`
        : ""
    }
  </div>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>الوصف / Description</th>
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
    <tr><td>المجموع الفرعي / Subtotal</td><td class="e">${money(data.subtotalMinor, opts.currency)}</td></tr>
    <tr><td>ضريبة القيمة المضافة / VAT</td><td class="e">${money(data.vatMinor, opts.currency)}</td></tr>
    <tr class="grand"><td>الإجمالي / Grand total</td><td class="e">${money(data.totalMinor, opts.currency)}</td></tr>
  </table>
  ${data.terms ? `<div class="terms"><div class="label">الشروط / Terms</div>${esc(data.terms)}</div>` : ""}
  ${opts.footerDetails ? `<div class="foot-details">${esc(opts.footerDetails)}</div>` : ""}
  <div class="foot">${esc(opts.orgName)} — ${ltr(data.reference)}</div>
</body>
</html>`;
}
