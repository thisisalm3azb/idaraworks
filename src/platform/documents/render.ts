/**
 * The canonical render model (H22.0).
 *
 * One typed description of a document that preview, print and PDF all read.
 * They cannot drift because there is nothing to drift between: the same model
 * produces the same HTML, and the PDF is that HTML printed by a browser.
 *
 * Financial fields are OPTIONAL by design. A weekly plan has no subtotal and
 * must not be forced to pretend it does, so `totals`, `currency` and the money
 * columns simply do not appear on documents that have no money in them.
 *
 * Pure: no database, no module imports, no I/O. The caller resolves identity,
 * lines and logo, then hands the finished model here.
 */
import { esc, ltr, renderDocumentShell, type DocumentShellIssuer } from "./shell";
import {
  formatIssuerAddress,
  type DocLanguage,
  type IssuerIdentity,
  type IssuerSnapshot,
} from "./issuer";

/** A single row in a document table. */
export type DocumentLine = {
  /** Free position label ("1", "1.1", "A") — rendered verbatim in an LTR isolate. */
  position?: string;
  description: string;
  /** Secondary line under the description (specification, note, owner). */
  detail?: string | null;
  quantity?: string | null;
  unit?: string | null;
  /** Pre-formatted money strings. Formatting is the caller's job, not the
   * renderer's: only the caller knows the currency and the viewer's locale. */
  unitPrice?: string | null;
  amount?: string | null;
  /** Status or state chip for operational documents (a plan's task state). */
  state?: string | null;
};

/** A titled block of rows. Documents with one table use a single section. */
export type DocumentSection = {
  title?: string | null;
  /** Column headings, already localized by the caller. */
  columns: readonly string[];
  lines: readonly DocumentLine[];
  /** Shown instead of the table when there are no rows. */
  emptyText?: string | null;
};

/** A label/value pair in the totals block. `strong` marks the payable line. */
export type DocumentTotal = { label: string; value: string; strong?: boolean };

/** A key/value pair in the metadata grid (dates, owner, references). */
export type DocumentField = { label: string; value: string; ltr?: boolean };

export type DocumentRenderModel = {
  /** Which document this is, for the audit trail and the catalogue. */
  kind: "quote" | "invoice" | "week_plan";
  language: DocLanguage;
  issuer: DocumentShellIssuer;
  /** The party the document is addressed to. Absent on internal documents. */
  recipient?: {
    name: string;
    lines?: readonly string[];
    trn?: string | null;
  } | null;
  titleEn?: string;
  titleAr?: string;
  reference: string;
  /** Pre-formatted, locale-aware. */
  dateText?: string;
  statusText?: string;
  revisionText?: string;
  watermark?: "draft" | "cancelled" | "void" | "credit" | "sample" | null;
  /** Metadata pairs rendered above the body (due date, week range, manager). */
  fields?: readonly DocumentField[];
  sections: readonly DocumentSection[];
  totals?: readonly DocumentTotal[];
  notesTitle?: string | null;
  notes?: string | null;
  termsTitle?: string | null;
  terms?: string | null;
  /** Approval / preparation attribution shown near the signature area. */
  attribution?: readonly DocumentField[];
  noticeText?: string;
  accentColor?: string | null;
  showSignatory?: boolean;
  showPaymentInstructions?: boolean;
};

/**
 * The bundled faces, injected as @font-face so a document carries its own
 * typography instead of borrowing the host machine's.
 *
 * Both scripts are bundled for the same reason. An unbundled family silently
 * resolves to whatever the machine happens to have: Segoe UI on a Windows
 * laptop, something else on the Linux container that renders the production
 * PDF, and for Arabic often nothing at all, which prints empty boxes. Serving
 * them from `/fonts` keeps them same-origin under `font-src 'self'` and makes
 * the browser preview and the printed PDF use identical faces.
 */
export type FontDelivery =
  /** Same-origin URLs. For a document SERVED from the app, where the browser
   *  caches the face across documents and the HTML stays small. */
  | "url"
  /** Base64 data URIs. For the PDF renderer, which loads the document through
   *  setContent() — there is no base URL there, so a relative font URL cannot
   *  resolve and the text silently falls back to whatever the host machine has.
   *  That is how Arabic turns into empty boxes on a Linux container. */
  | "embed";

/**
 * Latin and Arabic, regular and bold. Font matching is per-character, so listing
 * both families lets one document set English in Noto Sans and any Arabic in it
 * in Noto Naskh Arabic, with neither borrowed from the host.
 */
const FONT_FACES = [
  { family: "Noto Sans", weight: 400, file: "NotoSans-Regular.ttf" },
  { family: "Noto Sans", weight: 700, file: "NotoSans-Bold.ttf" },
  { family: "Noto Naskh Arabic", weight: 400, file: "NotoNaskhArabic-Regular.ttf" },
  { family: "Noto Naskh Arabic", weight: 700, file: "NotoNaskhArabic-Bold.ttf" },
] as const;

/** The @font-face block for the bundled families, in the requested delivery. */
export function documentFontCss(delivery: FontDelivery, embedded?: Record<string, string>): string {
  return FONT_FACES.map(({ family, weight, file }) => {
    const src =
      delivery === "embed" && embedded?.[file]
        ? `url("data:font/ttf;base64,${embedded[file]}") format("truetype")`
        : `url("/fonts/${file}") format("truetype")`;
    return `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${weight}; font-display: block; src: ${src}; }`;
  }).join("\n");
}

/** The files the embed mode needs, so callers can read them once and cache. */
export const DOCUMENT_FONT_FILES = FONT_FACES.map((f) => f.file);

/** URL delivery, for documents served from the app. */
export const DOCUMENT_FONT_CSS = documentFontCss("url");

/** Structured identity to the shell's pre-formatted issuer block. */
export function shellIssuerFromIdentity(
  identity: IssuerIdentity,
  logoDataUri: string | null,
): DocumentShellIssuer {
  return {
    tradingName: identity.tradingName,
    legalName: identity.legalName,
    trn: identity.trn,
    licenseNo: identity.licenseNo,
    addressLineEn: formatIssuerAddress(identity, "en"),
    addressLineAr: formatIssuerAddress(identity, "ar"),
    phone: identity.phone,
    email: identity.email,
    website: identity.website,
    footer: identity.footer,
    signatoryName: identity.signatoryName,
    signatoryTitle: identity.signatoryTitle,
    paymentInstructions: identity.paymentInstructions,
    logoDataUri,
  };
}

/**
 * A STORED snapshot to the shell's issuer block.
 *
 * The snapshot holds structured address parts, the shell wants formatted lines,
 * and nothing bridged them — so an issued document could not be rendered from
 * its own snapshot. `formatIssuerAddress` takes the identity shape, and a
 * snapshot is that shape plus `version`/`capturedAt`, so it is reused rather
 * than reimplemented: one address format for issued and draft alike.
 */
export function shellIssuerFromSnapshot(
  snapshot: IssuerSnapshot,
  logoDataUri: string | null,
): DocumentShellIssuer {
  const asIdentity = {
    ...snapshot,
    tradingName: snapshot.tradingName ?? snapshot.legalName,
    accentColor: null,
    logoFileId: snapshot.logoFileId,
  } as unknown as IssuerIdentity;
  return {
    tradingName: snapshot.tradingName ?? snapshot.legalName,
    legalName: snapshot.legalName,
    trn: snapshot.trn,
    licenseNo: snapshot.licenseNo,
    addressLineEn: formatIssuerAddress(asIdentity, "en"),
    addressLineAr: formatIssuerAddress(asIdentity, "ar"),
    phone: snapshot.phone,
    email: snapshot.email,
    website: snapshot.website,
    footer: snapshot.footer,
    signatoryName: snapshot.signatoryName,
    signatoryTitle: snapshot.signatoryTitle,
    paymentInstructions: snapshot.paymentInstructions,
    logoDataUri,
  };
}

const cell = (v: string | null | undefined, isLtr = false) =>
  v == null || v === "" ? "" : isLtr ? ltr(v) : esc(v);

function renderSection(s: DocumentSection): string {
  if (s.lines.length === 0) {
    return s.emptyText ? `<p class="doc-empty">${esc(s.emptyText)}</p>` : "";
  }
  const head = s.columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const rows = s.lines
    .map((l) => {
      const cells = [
        l.position !== undefined ? `<td class="num">${cell(l.position, true)}</td>` : null,
        `<td>${esc(l.description)}${
          l.detail ? `<div class="doc-line-detail">${esc(l.detail)}</div>` : ""
        }</td>`,
        l.state !== undefined ? `<td>${cell(l.state)}</td>` : null,
        l.quantity !== undefined
          ? `<td class="num">${cell(l.quantity, true)}${l.unit ? ` ${esc(l.unit)}` : ""}</td>`
          : null,
        l.unitPrice !== undefined ? `<td class="num">${cell(l.unitPrice, true)}</td>` : null,
        l.amount !== undefined ? `<td class="num">${cell(l.amount, true)}</td>` : null,
      ]
        .filter(Boolean)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  // thead repeats on every printed page; tbody rows never split mid-row.
  return `${s.title ? `<h2 class="doc-section-title">${esc(s.title)}</h2>` : ""}
<table class="doc-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

/** The model to a complete, standalone HTML document. */
export function renderDocument(
  model: DocumentRenderModel,
  /** How the font travels. Default is URL delivery; the PDF renderer passes
   *  "embed" with the font bytes because setContent() has no base URL. */
  fonts: { delivery: FontDelivery; embedded?: Record<string, string> } = { delivery: "url" },
): string {
  const fields = (model.fields ?? [])
    .map(
      (f) =>
        `<div class="doc-field"><span class="doc-field-label">${esc(f.label)}</span><span class="doc-field-value">${
          f.ltr ? ltr(f.value) : esc(f.value)
        }</span></div>`,
    )
    .join("");

  const recipient = model.recipient
    ? `<section class="doc-recipient">
<div class="doc-recipient-name">${esc(model.recipient.name)}</div>
${(model.recipient.lines ?? []).map((l) => `<div>${esc(l)}</div>`).join("")}
${model.recipient.trn ? `<div>${ltr(model.recipient.trn)}</div>` : ""}
</section>`
    : "";

  const totals = (model.totals ?? []).length
    ? `<table class="doc-totals">${(model.totals ?? [])
        .map(
          (t) =>
            `<tr class="${t.strong ? "doc-total-strong" : ""}"><td>${esc(t.label)}</td><td class="num">${ltr(
              t.value,
            )}</td></tr>`,
        )
        .join("")}</table>`
    : "";

  const block = (title: string | null | undefined, text: string | null | undefined) =>
    text
      ? `<section class="doc-block"><h3>${esc(title ?? "")}</h3><p>${esc(text)}</p></section>`
      : "";

  const attribution = (model.attribution ?? []).length
    ? `<section class="doc-attribution">${(model.attribution ?? [])
        .map((a) => `<div><span>${esc(a.label)}</span> <strong>${esc(a.value)}</strong></div>`)
        .join("")}</section>`
    : "";

  const bodyHtml = [
    fields ? `<section class="doc-fields">${fields}</section>` : "",
    recipient,
    model.sections.map(renderSection).join("\n"),
    totals,
    block(model.notesTitle, model.notes),
    block(model.termsTitle, model.terms),
    attribution,
  ]
    .filter(Boolean)
    .join("\n");

  const html = renderDocumentShell({
    issuer: model.issuer,
    titleAr: model.titleAr,
    titleEn: model.titleEn,
    reference: model.reference,
    dateText: model.dateText,
    statusText: model.statusText,
    revisionText: model.revisionText,
    watermark: model.watermark ?? null,
    language: model.language,
    bodyHtml,
    noticeText: model.noticeText,
    accentColor: model.accentColor ?? null,
    showSignatory: model.showSignatory,
    showPaymentInstructions: model.showPaymentInstructions,
  });

  // The shell owns the document's CSS; the font and the body styles this model
  // introduces are appended to it rather than duplicating a second stylesheet.
  return html.replace(
    "</head>",
    `<style>${documentFontCss(fonts.delivery, fonts.embedded)}\n${BODY_CSS}</style></head>`,
  );
}

const BODY_CSS = `
.doc-fields { display: flex; flex-wrap: wrap; gap: 6px 28px; margin-block: 14px 6px; font-size: 12px; }
.doc-field { display: flex; gap: 6px; }
.doc-field-label { color: #666; }
.doc-field-value { font-weight: 600; }
.doc-recipient { margin-block: 10px 16px; font-size: 12.5px; }
.doc-recipient-name { font-weight: 700; font-size: 14px; }
.doc-section-title { font-size: 13px; margin-block: 18px 6px; font-weight: 700; }
.doc-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.doc-table th { text-align: start; font-weight: 700; border-block-end: 1px solid #cfcfcf;
                padding: 7px 6px; background: #f6f6f6; }
.doc-table td { padding: 7px 6px; border-block-end: 1px solid #eee; vertical-align: top; }
.doc-table td.num, .doc-table th.num { text-align: end; white-space: nowrap; }
.doc-line-detail { color: #666; font-size: 11px; margin-block-start: 2px; }
.doc-empty { color: #666; font-size: 12px; font-style: italic; }
.doc-totals { margin-inline-start: auto; margin-block-start: 12px; font-size: 12.5px;
              min-width: 240px; border-collapse: collapse; }
.doc-totals td { padding: 5px 6px; }
.doc-total-strong td { font-weight: 700; font-size: 14px; border-block-start: 2px solid #333; }
.doc-block { margin-block-start: 16px; font-size: 12px; }
.doc-block h3 { font-size: 12px; margin: 0 0 3px; color: #444; }
.doc-block p { margin: 0; white-space: pre-wrap; }
.doc-attribution { margin-block-start: 18px; display: flex; flex-wrap: wrap; gap: 6px 32px;
                   font-size: 12px; }
@media print {
  /* A long table repeats its head on every page and never splits a row. */
  .doc-table thead { display: table-header-group; }
  .doc-table tr { break-inside: avoid; }
  .doc-block, .doc-totals, .doc-attribution { break-inside: avoid; }
  /* Monochrome output: the header tint would print as flat grey mush. */
  .doc-table th { background: transparent; border-block-end: 1.5px solid #000; }
}
`.trim();
