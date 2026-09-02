/**
 * H26 — blocks to HTML. ONE renderer for the builder preview, the print page
 * and the PDF, so what a person reads on screen is what the counterparty
 * receives. Text is escaped here; the shell receives a trusted body.
 *
 * Bilingual documents render each block in Arabic then English, stacked, so
 * both readers follow the same clause numbering.
 */
import {
  esc,
  ltr,
  renderDocumentShell,
  type DocumentShellIssuer,
  type DocumentWatermark,
} from "@/platform/documents";
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { evaluateConditions } from "./conditions";
import type { Block, DocBody, DocLanguage, DocSettings, DocVariables, LocaleText } from "./types";

export type ResolvedValues = {
  /** Binding path → display value (null = not available / not permitted). */
  bindings: Record<string, string | null>;
  /** line_items block id → resolved rows (for quote/invoice sources). */
  lineItems: Record<
    string,
    Array<{
      description: LocaleText;
      qty: number;
      unit?: string;
      unitPriceMinor: number;
      vatRate: number;
    }>
  >;
  /** Field key → value (variables plus computed results). */
  variables: DocVariables;
};

export type SignatureRender = {
  party: string;
  signerName: string | null;
  signedAt: string | null;
  signatureKind: "typed" | "drawn" | null;
  /** Typed text or an SVG path (bounded, escaped/validated by the service). */
  signatureData: string | null;
  title: string | null;
};

export type RenderInput = {
  language: DocLanguage;
  body: DocBody;
  settings: DocSettings;
  values: ResolvedValues;
  issuer: DocumentShellIssuer;
  reference: string;
  title: string;
  dateText: string;
  statusText: string;
  revisionText?: string;
  watermark?: DocumentWatermark | null;
  accentColor?: string | null;
  noticeText?: string;
  signatures?: SignatureRender[];
  /** The evidence page appended to an issued/signed document. */
  evidence?: { contentHash: string; lines: string[] } | null;
};

const L = {
  qty: { en: "Qty", ar: "الكمية" },
  unit: { en: "Unit", ar: "الوحدة" },
  price: { en: "Unit price", ar: "سعر الوحدة" },
  vat: { en: "VAT", ar: "الضريبة" },
  amount: { en: "Amount", ar: "المبلغ" },
  subtotal: { en: "Subtotal", ar: "المجموع الفرعي" },
  total: { en: "Total", ar: "الإجمالي" },
  description: { en: "Description", ar: "الوصف" },
  signature: { en: "Signature", ar: "التوقيع" },
  name: { en: "Name", ar: "الاسم" },
  title: { en: "Title", ar: "المسمى" },
  date: { en: "Date", ar: "التاريخ" },
  initials: { en: "Initials", ar: "الأحرف الأولى" },
  notSigned: { en: "Not yet signed", ar: "لم يُوقَّع بعد" },
  signedElectronically: { en: "Signed electronically", ar: "وُقِّع إلكترونياً" },
  evidence: { en: "Evidence record", ar: "سجل الإثبات" },
  contentHash: { en: "Content hash (SHA-256)", ar: "بصمة المحتوى (SHA-256)" },
  notAvailable: { en: "not available", ar: "غير متاح" },
  yes: { en: "Yes", ar: "نعم" },
  no: { en: "No", ar: "لا" },
} as const;

type Lang = "en" | "ar";

function label(key: keyof typeof L, lang: Lang): string {
  return L[key][lang];
}

/** The languages a document renders, in order. */
export function renderLanguages(language: DocLanguage): Lang[] {
  return language === "bilingual" ? ["ar", "en"] : [language];
}

function pick(t: LocaleText | undefined, lang: Lang): string {
  if (!t) return "";
  return (lang === "ar" ? (t.ar ?? t.en) : (t.en ?? t.ar)) ?? "";
}

/** Escape, then interpolate `{{key}}` from variables/bindings and keep line breaks. */
function text(raw: string, values: ResolvedValues, lang: Lang): string {
  const interpolated = raw.replace(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/gi, (_m, key: string) => {
    const v = lookup(key, values);
    return v === null ? `[${label("notAvailable", lang)}]` : v;
  });
  return esc(interpolated)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br />");
}

export function lookup(key: string, values: ResolvedValues): string | null {
  if (key in values.variables) {
    const v = values.variables[key];
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v);
  }
  if (key in values.bindings) return values.bindings[key] ?? null;
  return null;
}

function money(minor: number, currency: string): string {
  try {
    return formatMoney(minor, currency as CurrencyCode);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/** Blocks whose conditions hold, in order, with clause numbers assigned. */
export function visibleBlocks(body: DocBody, values: ResolvedValues): Block[] {
  const out: Block[] = [];
  for (const b of body.blocks) {
    if (b.condition && !evaluateConditions(b.condition, values)) continue;
    if (b.type === "section") {
      out.push({
        ...b,
        blocks: b.blocks.filter((c) => !c.condition || evaluateConditions(c.condition, values)),
      });
    } else out.push(b);
  }
  return out;
}

export function renderBody(input: RenderInput): string {
  const langs = renderLanguages(input.language);
  const blocks = visibleBlocks(input.body, input.values);
  let clause = 0;
  const parts: string[] = [];
  const renderBlock = (b: Block): string => {
    switch (b.type) {
      case "heading": {
        const tag = b.level === 1 ? "h2" : b.level === 2 ? "h3" : "h4";
        return langs
          .map(
            (l) =>
              `<${tag} class="ds-h" lang="${l}">${text(pick(b.text, l), input.values, l)}</${tag}>`,
          )
          .join("");
      }
      case "paragraph":
        return langs
          .map((l) => `<p class="ds-p" lang="${l}">${text(pick(b.text, l), input.values, l)}</p>`)
          .join("");
      case "note":
        return langs
          .map(
            (l) =>
              `<p class="ds-note ds-note-${b.tone}" lang="${l}">${text(pick(b.text, l), input.values, l)}</p>`,
          )
          .join("");
      case "clause": {
        clause += 1;
        const num = input.settings.numberClauses
          ? `<span class="ds-clause-no">${ltr(String(clause))}</span> `
          : "";
        return langs
          .map((l) => {
            const title =
              b.title && pick(b.title, l)
                ? `<strong>${text(pick(b.title, l), input.values, l)}</strong> `
                : "";
            return `<p class="ds-clause" lang="${l}">${num}${title}${text(pick(b.text, l), input.values, l)}</p>`;
          })
          .join("");
      }
      case "list": {
        const tag = b.style === "number" ? "ol" : "ul";
        return langs
          .map(
            (l) =>
              `<${tag} class="ds-list" lang="${l}">${b.items.map((i) => `<li>${text(pick(i, l), input.values, l)}</li>`).join("")}</${tag}>`,
          )
          .join("");
      }
      case "table":
        return langs
          .map(
            (l) =>
              `<table class="ds-table" lang="${l}"><thead><tr>${b.columns
                .map((c) => `<th>${text(pick(c, l), input.values, l)}</th>`)
                .join("")}</tr></thead><tbody>${b.rows
                .map(
                  (r) =>
                    `<tr>${r.map((c) => `<td>${text(pick(c, l), input.values, l)}</td>`).join("")}</tr>`,
                )
                .join("")}</tbody></table>`,
          )
          .join("");
      case "line_items": {
        const items = b.source === "manual" ? b.items : (input.values.lineItems[b.id] ?? []);
        let subtotal = 0;
        let vat = 0;
        const rows = items.map((it, i) => {
          const line = Math.round(it.qty * it.unitPriceMinor);
          const lineVat = Math.round((line * (it.vatRate ?? 0)) / 100);
          subtotal += line;
          vat += lineVat;
          return { i: i + 1, it, line, lineVat };
        });
        return langs
          .map((l) => {
            const head =
              `<th class="ds-num">#</th><th>${label("description", l)}</th><th class="ds-num">${label("qty", l)}</th>` +
              `<th>${label("unit", l)}</th><th class="ds-num">${label("price", l)}</th>` +
              (b.showVat ? `<th class="ds-num">${label("vat", l)}</th>` : "") +
              `<th class="ds-num">${label("amount", l)}</th>`;
            const body = rows
              .map(
                (r) =>
                  `<tr><td class="ds-num">${ltr(String(r.i))}</td><td>${text(pick(r.it.description, l), input.values, l)}</td>` +
                  `<td class="ds-num">${ltr(String(r.it.qty))}</td><td>${esc(r.it.unit ?? "")}</td>` +
                  `<td class="ds-num">${ltr(money(r.it.unitPriceMinor, b.currency))}</td>` +
                  (b.showVat ? `<td class="ds-num">${ltr(`${r.it.vatRate ?? 0}%`)}</td>` : "") +
                  `<td class="ds-num">${ltr(money(r.line, b.currency))}</td></tr>`,
              )
              .join("");
            const cols = b.showVat ? 6 : 5;
            const totals = b.showTotals
              ? `<tfoot><tr><td colspan="${cols}" class="ds-total-label">${label("subtotal", l)}</td><td class="ds-num">${ltr(money(subtotal, b.currency))}</td></tr>` +
                (b.showVat
                  ? `<tr><td colspan="${cols}" class="ds-total-label">${label("vat", l)}</td><td class="ds-num">${ltr(money(vat, b.currency))}</td></tr>`
                  : "") +
                `<tr class="ds-grand"><td colspan="${cols}" class="ds-total-label">${label("total", l)}</td><td class="ds-num">${ltr(money(subtotal + vat, b.currency))}</td></tr></tfoot>`
              : "";
            return `<table class="ds-table ds-lines" lang="${l}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${totals}</table>`;
          })
          .join("");
      }
      case "field": {
        const v = input.values.variables[b.key];
        let shown: string;
        if (v === null || v === undefined || v === "") shown = "";
        else if (b.kind === "checkbox") shown = v ? "☑" : "☐";
        else if (b.kind === "money" && typeof v === "number") shown = money(v, b.currency ?? "AED");
        else if (b.kind === "choice" && typeof v === "number" && b.options?.[v]) shown = "";
        else shown = String(v);
        return langs
          .map((l) => {
            const opt =
              b.kind === "choice" && typeof v === "number" && b.options?.[v]
                ? pick(b.options[v], l)
                : shown;
            const value = opt
              ? `<span class="ds-field-value">${b.kind === "number" || b.kind === "money" || b.kind === "date" ? ltr(esc(opt)) : esc(opt)}</span>`
              : `<span class="ds-field-blank"></span>`;
            return `<p class="ds-field" lang="${l}"><span class="ds-field-label">${esc(pick(b.label, l))}${b.required ? " *" : ""}</span> ${value}</p>`;
          })
          .join("");
      }
      case "binding": {
        const v = input.values.bindings[b.path];
        return langs
          .map((l) => {
            const lab =
              b.label && pick(b.label, l)
                ? `<span class="ds-field-label">${esc(pick(b.label, l))}</span> `
                : "";
            const val =
              v === null || v === undefined
                ? `<span class="ds-field-blank">[${label("notAvailable", l)}]</span>`
                : `<span class="ds-field-value">${b.format === "text" ? esc(v) : ltr(esc(v))}</span>`;
            return `<p class="ds-field" lang="${l}">${lab}${val}</p>`;
          })
          .join("");
      }
      case "signature": {
        const sig = input.signatures?.find((s) => s.party === b.party) ?? null;
        return langs
          .map((l) => {
            const parts = b.parts
              .map((p) => {
                if (p === "signature") {
                  const mark = sig?.signatureData
                    ? sig.signatureKind === "drawn"
                      ? `<svg class="ds-sig-svg" viewBox="0 0 400 120" preserveAspectRatio="xMinYMid meet"><path d="${esc(sig.signatureData)}" fill="none" stroke="#111" stroke-width="2" stroke-linecap="round"/></svg>`
                      : `<span class="ds-sig-typed">${esc(sig.signatureData)}</span>`
                    : `<span class="ds-sig-line"></span>`;
                  return `<div class="ds-sig-part"><span class="ds-sig-label">${label("signature", l)}</span>${mark}</div>`;
                }
                if (p === "name")
                  return `<div class="ds-sig-part"><span class="ds-sig-label">${label("name", l)}</span><span class="ds-sig-value">${sig?.signerName ? esc(sig.signerName) : ""}</span></div>`;
                if (p === "title")
                  return `<div class="ds-sig-part"><span class="ds-sig-label">${label("title", l)}</span><span class="ds-sig-value">${sig?.title ? esc(sig.title) : ""}</span></div>`;
                if (p === "date")
                  return `<div class="ds-sig-part"><span class="ds-sig-label">${label("date", l)}</span><span class="ds-sig-value">${sig?.signedAt ? ltr(esc(sig.signedAt.slice(0, 10))) : ""}</span></div>`;
                return `<div class="ds-sig-part"><span class="ds-sig-label">${label("initials", l)}</span><span class="ds-sig-value"></span></div>`;
              })
              .join("");
            const status = sig?.signedAt
              ? `<div class="ds-sig-status">${label("signedElectronically", l)} · ${ltr(esc(sig.signedAt.replace("T", " ").slice(0, 16)))} UTC</div>`
              : `<div class="ds-sig-status ds-muted">${label("notSigned", l)}</div>`;
            return `<div class="ds-sig" lang="${l}"><div class="ds-sig-party">${esc(pick(b.label, l))}</div>${parts}${status}</div>`;
          })
          .join("");
      }
      case "image": {
        const src =
          b.source === "logo"
            ? input.issuer.logoDataUri
            : (input.values.bindings[`image:${b.source}`] ?? null);
        if (!src) return "";
        const cap = b.caption
          ? langs
              .map((l) =>
                pick(b.caption, l)
                  ? `<figcaption lang="${l}">${esc(pick(b.caption, l))}</figcaption>`
                  : "",
              )
              .join("")
          : "";
        return `<figure class="ds-img ds-align-${b.align}" style="width:${b.widthPct}%"><img src="${esc(src)}" alt="" />${cap}</figure>`;
      }
      case "page_break":
        return `<div class="ds-break"></div>`;
      case "section": {
        const title = b.title
          ? langs
              .map((l) =>
                pick(b.title, l)
                  ? `<h3 class="ds-h" lang="${l}">${text(pick(b.title, l), input.values, l)}</h3>`
                  : "",
              )
              .join("")
          : "";
        return `<section class="ds-section">${title}${b.blocks.map(renderBlock).join("")}</section>`;
      }
      default:
        return "";
    }
  };
  for (const b of blocks) parts.push(renderBlock(b));

  if (input.evidence) {
    const lang: Lang = input.language === "en" ? "en" : "ar";
    parts.push(
      `<div class="ds-break"></div><section class="ds-evidence" lang="${lang}"><h3 class="ds-h">${label("evidence", lang)}</h3>` +
        `<p class="ds-p"><span class="ds-field-label">${label("contentHash", lang)}</span> ${ltr(`<code>${esc(input.evidence.contentHash)}</code>`)}</p>` +
        `<ul class="ds-list">${input.evidence.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></section>`,
    );
  }
  return parts.join("\n");
}

const BODY_CSS = `
.ds-h{margin:14px 0 6px;font-weight:700}
h2.ds-h{font-size:15pt}h3.ds-h{font-size:12.5pt}h4.ds-h{font-size:11pt}
.ds-p,.ds-clause,.ds-field{margin:0 0 8px;line-height:1.55}
.ds-clause-no{font-weight:700;margin-inline-end:4px}
.ds-note{padding:8px 10px;border-inline-start:3px solid #888;background:#f5f5f5;margin:0 0 10px}
.ds-note-warning{border-color:#b45309;background:#fff7ed}
.ds-list{margin:0 0 10px;padding-inline-start:22px}
.ds-table{width:100%;border-collapse:collapse;margin:6px 0 12px;font-size:10pt}
.ds-table th,.ds-table td{border:1px solid #d6d6d6;padding:5px 7px;text-align:start;vertical-align:top}
.ds-table thead{display:table-header-group}.ds-table tr{page-break-inside:avoid}
.ds-table th{background:#f2f2f2;font-weight:600}
.ds-num{text-align:end;white-space:nowrap}
.ds-total-label{text-align:end;font-weight:600}
.ds-grand td{font-weight:700;border-top:2px solid #333}
.ds-field-label{color:#555;font-size:9.5pt}
.ds-field-value{font-weight:600}
.ds-field-blank{display:inline-block;min-width:160px;border-bottom:1px solid #999}
.ds-sig{display:inline-block;vertical-align:top;width:47%;margin:16px 1% 8px;padding:10px;border:1px solid #ddd;page-break-inside:avoid}
.ds-sig-party{font-weight:700;margin-bottom:6px}
.ds-sig-part{margin:6px 0}
.ds-sig-label{display:block;font-size:8.5pt;color:#666}
.ds-sig-line{display:block;height:34px;border-bottom:1px solid #333}
.ds-sig-svg{display:block;height:44px;max-width:100%}
.ds-sig-typed{display:block;font-family:"Noto Naskh Arabic","Noto Sans",serif;font-size:18pt;font-style:italic;border-bottom:1px solid #333;padding-bottom:2px}
.ds-sig-value{display:block;min-height:16px;border-bottom:1px solid #ccc}
.ds-sig-status{font-size:8.5pt;margin-top:6px}
.ds-muted{color:#888}
.ds-img{margin:8px 0}.ds-img img{max-width:100%;height:auto}
.ds-align-center{margin-inline:auto}.ds-align-end{margin-inline-start:auto}
.ds-break{page-break-after:always;break-after:page}
.ds-section{margin:4px 0}
.ds-evidence code{font-size:8.5pt;word-break:break-all}
[lang="ar"]{font-family:"Noto Naskh Arabic","Noto Sans",sans-serif}
`;

const WATERMARK: Record<DocSettings["watermark"], DocumentWatermark | null> = {
  none: null,
  draft: "draft",
  sample: "sample",
  confidential: null,
};

/** The full document page (shell + body + CSS). */
export function renderDocumentHtml(
  input: RenderInput,
  fonts?: { delivery: "url" | "embed"; embedded?: Record<string, string> },
): string {
  const bodyHtml = renderBody(input);
  const html = renderDocumentShell({
    issuer: input.issuer,
    titleEn: input.language === "ar" ? undefined : input.title,
    titleAr: input.language === "en" ? undefined : input.title,
    reference: input.reference,
    dateText: input.dateText,
    statusText: input.statusText,
    revisionText: input.revisionText,
    watermark:
      input.watermark === undefined ? WATERMARK[input.settings.watermark] : input.watermark,
    language: input.language,
    bodyHtml,
    noticeText: input.noticeText,
    accentColor: input.accentColor ?? input.settings.accentColor,
    showSignatory: false,
    showPaymentInstructions: false,
  });
  const fontCss = fonts ? fontCssFor(fonts) : "";
  return html.replace("</head>", `<style>${BODY_CSS}</style>${fontCss}</head>`);
}

function fontCssFor(fonts: {
  delivery: "url" | "embed";
  embedded?: Record<string, string>;
}): string {
  // The shell already declares the faces for url delivery; the PDF path needs
  // them embedded because setContent() has no base URL.
  if (fonts.delivery !== "embed" || !fonts.embedded) return "";
  const faces = Object.entries(fonts.embedded)
    .map(([file, b64]) => {
      const family = file.startsWith("NotoNaskhArabic") ? "Noto Naskh Arabic" : "Noto Sans";
      const weight = file.includes("Bold") ? 700 : 400;
      return `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;src:url(data:font/ttf;base64,${b64}) format("truetype")}`;
    })
    .join("");
  return `<style>${faces}</style>`;
}
