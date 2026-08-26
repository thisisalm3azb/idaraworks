/**
 * Branded document shell (003B.1) — the ONE server-rendered frame every formal
 * document uses. No document may invent its own issuer-header logic: templates
 * render their body (table/lines — keeping their own escaping, VAT and bidi
 * rules) and hand the pre-escaped HTML to this shell, which owns the header
 * (logo or legal-name fallback, trading/legal names, TRN/registration,
 * bilingual address, contacts), title/reference/date/status/revision block,
 * watermarks, footer, signatory/payment blocks, print CSS and pagination
 * hooks.
 *
 * Hard rules:
 *  - Pure string renderer — no React, no DB, no module imports, no external
 *    assets (the logo arrives as a data URI resolved by the caller through the
 *    tenant-scoped file path; a missing/failed logo degrades to the legal-name
 *    text header).
 *  - Every interpolated string is escaped here (`esc`); `bodyHtml` is the ONE
 *    trusted-prerendered input (documented contract: it comes from an existing
 *    template builder that escapes everything itself).
 *  - Document references and numbers render inside LTR isolates (`ltr`) so
 *    Arabic context never reorders them.
 *  - Advanced styling (accent colour, letterhead/cover mode) applies only
 *    when the caller passes it — the document-profile service supplies accent
 *    only when `feat.branding_docs` is on; basic issuer identity is NEVER
 *    gated (audit §12.1).
 */
import type { DocLanguage } from "./issuer";

export function esc(v: string): string {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** LTR isolate for references, numbers and phone/URL strings in RTL context. */
export function ltr(v: string): string {
  return `<bdi dir="ltr">${esc(v)}</bdi>`;
}

export type DocumentWatermark = "draft" | "cancelled" | "void" | "credit" | "sample";

const WATERMARK_TEXT: Record<DocumentWatermark, { ar: string; en: string }> = {
  draft: { ar: "مسودة", en: "DRAFT" },
  cancelled: { ar: "ملغى", en: "CANCELLED" },
  void: { ar: "لاغٍ", en: "VOID" },
  credit: { ar: "إشعار دائن", en: "CREDIT" },
  sample: { ar: "نموذج", en: "SAMPLE" },
};

/** Fixed bilingual field labels (documents are bilingual-first, like the
 * existing quote/LPO templates which hardcode their own label pairs). */
const L = {
  trn: { ar: "الرقم الضريبي", en: "TRN" },
  license: { ar: "رقم الرخصة", en: "License No." },
  reference: { ar: "المرجع", en: "Ref" },
  date: { ar: "التاريخ", en: "Date" },
  status: { ar: "الحالة", en: "Status" },
  revision: { ar: "مراجعة", en: "Revision" },
  signatory: { ar: "التوقيع المعتمد", en: "Authorized signatory" },
  payment: { ar: "تعليمات الدفع", en: "Payment instructions" },
  page: { ar: "صفحة", en: "Page" },
};

function label(key: keyof typeof L, language: DocLanguage): string {
  const pair = L[key];
  if (language === "en") return pair.en;
  if (language === "ar") return pair.ar;
  return `${pair.ar} / ${pair.en}`;
}

export type DocumentShellIssuer = {
  tradingName: string;
  legalName: string;
  trn: string | null;
  licenseNo: string | null;
  /** Pre-formatted address lines (formatIssuerAddress). */
  addressLineEn: string | null;
  addressLineAr: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  footer: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  paymentInstructions: string | null;
  /** Tenant-scoped embed; null → legal-name text header (never a URL). */
  logoDataUri: string | null;
};

export type DocumentShellProps = {
  issuer: DocumentShellIssuer;
  /** Document title, both languages (one may be omitted for single-language docs). */
  titleAr?: string;
  titleEn?: string;
  /** Document reference (e.g. QT-0004) — rendered as an LTR isolate. */
  reference?: string;
  /** Pre-formatted issue/generated date string. */
  dateText?: string;
  statusText?: string;
  revisionText?: string;
  watermark?: DocumentWatermark | null;
  /** en | ar | bilingual — controls dir, lang and label rendering. */
  language: DocLanguage;
  /** TRUSTED pre-escaped body from an existing template builder. */
  bodyHtml: string;
  /** Optional short notice line under the meta block (e.g. legacy-issuer note). */
  noticeText?: string;
  /** Advanced styling (feat.branding_docs) — never affects issuer identity. */
  accentColor?: string | null;
  /** Letterhead/cover mode (advanced): larger header, no body table required. */
  coverMode?: boolean;
  /** Render the signatory block (caller decides per document type). */
  showSignatory?: boolean;
  /** Render payment instructions (invoices/receipts — caller decides). */
  showPaymentInstructions?: boolean;
};

const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

export function renderDocumentShell(p: DocumentShellProps): string {
  const rtl = p.language !== "en";
  const dir = rtl ? "rtl" : "ltr";
  const lang = p.language === "en" ? "en" : "ar";
  // Accent is advanced styling; an invalid value is ignored, never interpolated raw.
  const accent = p.accentColor && ACCENT_RE.test(p.accentColor) ? p.accentColor : "#1a1a1a";

  const i = p.issuer;
  const contact = [
    i.phone ? ltr(i.phone) : null,
    i.email ? ltr(i.email) : null,
    i.website ? ltr(i.website) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const addressLines = [
    p.language !== "en" && i.addressLineAr ? esc(i.addressLineAr) : null,
    p.language !== "ar" && i.addressLineEn ? esc(i.addressLineEn) : null,
  ].filter(Boolean);

  const regLine = [
    i.trn ? `${esc(label("trn", p.language))}: ${ltr(i.trn)}` : null,
    i.licenseNo ? `${esc(label("license", p.language))}: ${ltr(i.licenseNo)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const meta = [
    p.reference ? `<span>${esc(label("reference", p.language))}: ${ltr(p.reference)}</span>` : null,
    p.dateText ? `<span>${esc(label("date", p.language))}: ${ltr(p.dateText)}</span>` : null,
    p.statusText ? `<span>${esc(label("status", p.language))}: ${esc(p.statusText)}</span>` : null,
    p.revisionText
      ? `<span>${esc(label("revision", p.language))}: ${esc(p.revisionText)}</span>`
      : null,
  ]
    .filter(Boolean)
    .join("\n      ");

  const titles = [
    p.language !== "en" && p.titleAr ? `<div class="doc-title-ar">${esc(p.titleAr)}</div>` : null,
    p.language !== "ar" && p.titleEn ? `<div class="doc-title-en">${esc(p.titleEn)}</div>` : null,
  ]
    .filter(Boolean)
    .join("");

  const watermark = p.watermark
    ? `<div class="doc-watermark" aria-hidden="true">${esc(
        p.language === "en"
          ? WATERMARK_TEXT[p.watermark].en
          : p.language === "ar"
            ? WATERMARK_TEXT[p.watermark].ar
            : `${WATERMARK_TEXT[p.watermark].ar} · ${WATERMARK_TEXT[p.watermark].en}`,
      )}</div>`
    : "";

  const signatory =
    p.showSignatory && (i.signatoryName || i.signatoryTitle)
      ? `<div class="doc-signatory">
      <div class="doc-signatory-line"></div>
      <div>${esc(label("signatory", p.language))}</div>
      ${i.signatoryName ? `<div class="doc-signatory-name">${esc(i.signatoryName)}</div>` : ""}
      ${i.signatoryTitle ? `<div class="doc-signatory-title">${esc(i.signatoryTitle)}</div>` : ""}
    </div>`
      : "";

  const payment =
    p.showPaymentInstructions && i.paymentInstructions
      ? `<div class="doc-payment"><div class="doc-payment-label">${esc(
          label("payment", p.language),
        )}</div><div>${esc(i.paymentInstructions)}</div></div>`
      : "";

  const header = `<header class="doc-header${p.coverMode ? " doc-cover" : ""}">
    <div class="doc-issuer">
      ${
        i.logoDataUri
          ? `<img class="doc-logo" src="${esc(i.logoDataUri)}" alt="${esc(i.tradingName)}" />`
          : `<div class="doc-logo-fallback">${esc(i.legalName)}</div>`
      }
      <div class="doc-issuer-names">
        <div class="doc-trading">${esc(i.tradingName)}</div>
        ${i.legalName !== i.tradingName ? `<div class="doc-legal">${esc(i.legalName)}</div>` : ""}
        ${regLine ? `<div class="doc-reg">${regLine}</div>` : ""}
        ${addressLines.map((a) => `<div class="doc-address">${a}</div>`).join("")}
        ${contact ? `<div class="doc-contact">${contact}</div>` : ""}
      </div>
    </div>
    <div class="doc-titleblock">
      ${titles}
      ${meta ? `<div class="doc-meta">${meta}</div>` : ""}
      ${p.noticeText ? `<div class="doc-notice">${esc(p.noticeText)}</div>` : ""}
    </div>
  </header>`;

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { box-sizing: border-box; }
  @page { size: A4; margin: 14mm 12mm 18mm; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "Noto Naskh Arabic", "Segoe UI", Tahoma, sans-serif;
         color: #1a1a1a; font-size: 13px; line-height: 1.55; background: #fff; }
  .doc-page { position: relative; max-width: 800px; margin: 0 auto; padding: 24px 20px 84px; }
  .doc-header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 16px;
                border-block-end: 2px solid ${accent}; padding-block-end: 12px; }
  .doc-cover { min-height: 200px; align-items: center; }
  .doc-issuer { display: flex; gap: 12px; align-items: flex-start; min-width: 0; }
  .doc-logo { max-height: 64px; max-width: 160px; object-fit: contain; }
  .doc-logo-fallback { font-size: 18px; font-weight: 700; }
  .doc-trading { font-size: 16px; font-weight: 700; }
  .doc-legal, .doc-reg, .doc-address, .doc-contact { font-size: 11.5px; color: #444; }
  .doc-titleblock { text-align: end; }
  .doc-title-ar { font-size: 20px; font-weight: 700; }
  .doc-title-en { font-size: 13px; color: #555; letter-spacing: .04em; }
  .doc-meta { margin-block-start: 6px; font-size: 11.5px; color: #333;
              display: flex; flex-direction: column; gap: 2px; }
  .doc-notice { margin-block-start: 6px; font-size: 10.5px; color: #8a5a00; }
  main.doc-body { padding-block-start: 16px; }
  .doc-payment { margin-block-start: 18px; font-size: 12px; border: 1px solid #ddd;
                 border-radius: 4px; padding: 10px 12px; }
  .doc-payment-label { font-weight: 700; margin-block-end: 4px; }
  .doc-signatory { margin-block-start: 36px; inline-size: 220px; font-size: 12px; }
  .doc-signatory-line { border-block-end: 1px solid #999; block-size: 34px;
                        margin-block-end: 6px; }
  .doc-signatory-name { font-weight: 600; }
  .doc-signatory-title { color: #555; }
  footer.doc-footer { position: absolute; inset-inline: 20px; inset-block-end: 16px;
                      border-block-start: 1px solid #ddd; padding-block-start: 6px;
                      font-size: 10.5px; color: #555; display: flex;
                      justify-content: space-between; gap: 12px; }
  .doc-page-number:empty { display: none; }
  .doc-watermark { position: absolute; inset: 0; display: flex; align-items: center;
                   justify-content: center; pointer-events: none; z-index: 1;
                   font-size: 64px; font-weight: 800; color: rgba(150, 30, 30, 0.12);
                   transform: rotate(-24deg); text-transform: uppercase;
                   letter-spacing: 0.1em; white-space: nowrap; }
  bdi { unicode-bidi: isolate; }
  @media print {
    .no-print { display: none !important; }
    .doc-page { max-width: none; padding-block-end: 0; }
    footer.doc-footer { position: fixed; inset-block-end: 0; }
    .doc-watermark { position: fixed; }
  }
</style>
</head>
<body>
<div class="doc-page">
  ${watermark}
  ${header}
  <main class="doc-body">
${p.bodyHtml}
  </main>
  ${payment}
  ${signatory}
  <footer class="doc-footer">
    <div class="doc-footer-text">${i.footer ? esc(i.footer) : esc(i.legalName)}</div>
    <div class="doc-page-number" data-label="${esc(label("page", p.language))}"></div>
  </footer>
</div>
</body>
</html>`;
}
