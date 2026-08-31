/**
 * 003B.1 — the branded document shell (pure renderer) + the settings sample
 * preview: direction/language modes, watermarks, escaping, LTR isolation,
 * print CSS, logo fallback, advanced-styling gating and the sample labelling.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderDocumentShell, type DocumentShellIssuer } from "@/platform/documents";
import { DocumentPreview } from "@/app/(app)/o/[orgId]/settings/branding/DocumentPreview";
import type { DocumentProfile } from "@/modules/branding/service";

const ISSUER: DocumentShellIssuer = {
  tradingName: "Alpha Co",
  legalName: "Alpha Trading LLC",
  trn: "100000000000003",
  licenseNo: "CN-1234567",
  addressLineEn: "Warehouse 4, Sharjah, United Arab Emirates",
  addressLineAr: "مستودع ٤، الشارقة، الإمارات العربية المتحدة",
  phone: "+971 6 555 0000",
  email: "office@alpha.example",
  website: "www.alpha.example",
  footer: "PO Box 1 — Sharjah",
  signatoryName: "A. Owner",
  signatoryTitle: "General Manager",
  paymentInstructions: "Bank X — IBAN AE00 0000",
  logoDataUri: "data:image/png;base64,LOGO",
};

function shell(over: Partial<Parameters<typeof renderDocumentShell>[0]> = {}): string {
  return renderDocumentShell({
    issuer: ISSUER,
    titleAr: "عرض سعر",
    titleEn: "Quotation",
    reference: "QT-0007",
    dateText: "27 Aug 2026",
    statusText: "Draft",
    language: "bilingual",
    bodyHtml: "<p>BODY</p>",
    ...over,
  });
}

describe("direction and language modes", () => {
  it("bilingual → rtl root with BOTH titles; ar → rtl Arabic title; en → ltr English title", () => {
    const bi = shell();
    expect(bi).toContain('<html lang="ar" dir="rtl">');
    expect(bi).toContain("عرض سعر");
    expect(bi).toContain("Quotation");
    const ar = shell({ language: "ar" });
    expect(ar).toContain('dir="rtl"');
    expect(ar).toContain("عرض سعر");
    expect(ar).not.toContain("Quotation");
    const en = shell({ language: "en" });
    expect(en).toContain('<html lang="en" dir="ltr">');
    expect(en).toContain("Quotation");
    expect(en).not.toContain("عرض سعر");
  });
});

describe("issuer header truth", () => {
  it("renders logo, both names, TRN, licence, bilingual address and contacts", () => {
    const html = shell();
    expect(html).toContain('class="doc-logo"');
    expect(html).toContain("data:image/png;base64,LOGO");
    expect(html).toContain("Alpha Co");
    expect(html).toContain("Alpha Trading LLC");
    expect(html).toContain("100000000000003");
    expect(html).toContain("CN-1234567");
    expect(html).toContain("مستودع ٤");
    expect(html).toContain("Warehouse 4");
    expect(html).toContain("office@alpha.example");
  });

  it("no logo → legal-name text fallback, never a broken img or external URL", () => {
    const html = shell({ issuer: { ...ISSUER, logoDataUri: null } });
    expect(html).not.toContain('class="doc-logo"');
    expect(html).toContain('class="doc-logo-fallback"');
    expect(html).toContain("Alpha Trading LLC");
    expect(html).not.toMatch(/src="https?:/);
  });

  it("footer prefers the configured footer and falls back to the legal name", () => {
    expect(shell()).toContain("PO Box 1 — Sharjah");
    const noFooter = shell({ issuer: { ...ISSUER, footer: null } });
    expect(noFooter).toContain('class="doc-footer-text">Alpha Trading LLC');
  });
});

describe("watermarks", () => {
  it("renders each kind bilingually and nothing when absent", () => {
    expect(shell({ watermark: "draft" })).toContain("مسودة · DRAFT");
    expect(shell({ watermark: "void", language: "en" })).toContain(">VOID<");
    expect(shell({ watermark: "cancelled", language: "ar" })).toContain("ملغى");
    expect(shell({ watermark: "credit" })).toContain("إشعار دائن");
    expect(shell({ watermark: "sample" })).toContain("نموذج · SAMPLE");
    expect(shell()).not.toContain('class="doc-watermark"'); // CSS rule may exist; the element must not
  });
});

describe("escaping and bidi isolation", () => {
  it("escapes hostile issuer strings and a hostile logo data URI", () => {
    const hostile = shell({
      issuer: {
        ...ISSUER,
        legalName: `Evil <script>alert(1)</script>`,
        logoDataUri: `data:image/png;base64,x" onerror="alert(1)`,
      },
      titleEn: `<img src=x>`,
    });
    expect(hostile).not.toContain("<script>alert(1)</script>");
    expect(hostile).not.toContain('onerror="alert(1)"');
    expect(hostile).toContain("&lt;script&gt;");
  });

  it("references, dates and contact strings are LTR isolates", () => {
    const html = shell();
    expect(html).toContain('<bdi dir="ltr">QT-0007</bdi>');
    expect(html).toContain('<bdi dir="ltr">27 Aug 2026</bdi>');
    expect(html).toContain('<bdi dir="ltr">+971 6 555 0000</bdi>');
  });
});

describe("print behaviour and pagination hooks", () => {
  it("carries @page, @media print and the no-print hider", () => {
    const html = shell();
    expect(html).toContain("@page { size: A4;");
    expect(html).toContain("@media print");
    expect(html).toContain(".no-print { display: none !important; }");
  });

  /**
   * The shell used to carry an empty `.doc-page-number` element that its own
   * `:empty { display: none }` rule then hid, so no document ever printed a page
   * number. Nothing in the shell could have filled it: only the browser knows
   * the page count, and Chrome exposes that count solely through the PDF footer
   * template. The number is printed there now (renderPdf's `pageNumbers`), and
   * this asserts the element that never worked has not come back.
   */
  it("draws no page-number element the shell could never fill", () => {
    expect(shell()).not.toContain("doc-page-number");
  });
});

describe("advanced styling stays advisory — identity is never styled away", () => {
  it("a valid accent colours the rule; an invalid accent is ignored", () => {
    expect(shell({ accentColor: "#0F766E" })).toContain("#0F766E");
    const bad = shell({ accentColor: 'red" onload="x' });
    expect(bad).not.toContain("onload");
    expect(bad).toContain("#1a1a1a");
  });

  it("signatory and payment blocks render only when asked", () => {
    const on = shell({ showSignatory: true, showPaymentInstructions: true });
    expect(on).toContain('class="doc-signatory"');
    expect(on).toContain("IBAN AE00");
    const off = shell();
    expect(off).not.toContain('class="doc-signatory"');
    expect(off).not.toContain("IBAN AE00");
  });
});

describe("settings sample preview (Brand & Documents)", () => {
  const profile: DocumentProfile = {
    identity: {
      tradingName: "Alpha Co",
      legalName: "Alpha Trading LLC",
      trn: "100000000000003",
      licenseNo: null,
      addressEn: "Warehouse 4",
      addressAr: "مستودع ٤",
      city: "Sharjah",
      region: null,
      postalCode: null,
      country: "United Arab Emirates",
      phone: "+971 6 555 0000",
      email: null,
      website: null,
      signatoryName: "A. Owner",
      signatoryTitle: null,
      paymentInstructions: null,
      footer: "PO Box 1",
      docLanguage: "bilingual",
      logoFileId: null,
    },
    logoDataUri: null,
    addressLineEn: "Warehouse 4, Sharjah, United Arab Emirates",
    addressLineAr: "مستودع ٤، الشارقة",
    advancedStyling: false,
    accentColor: null,
  };
  const dict = {
    title: "Document preview",
    sample_note: "This is a sample layout — not a real document.",
    frame_title: "Sample document preview",
    sample_title_ar: "نموذج مستند",
    sample_title_en: "Sample document",
    sample_body: "Body placeholder",
  };

  it("renders an explicitly-labelled SAMPLE inside a titled iframe (a11y), RTL-safe", () => {
    const html = renderToStaticMarkup(
      h(DocumentPreview, { profile, dateText: "27 Aug 2026", dict }),
    );
    expect(html).toContain("This is a sample layout");
    expect(html).toContain('title="Sample document preview"');
    expect(html.toLowerCase()).toContain("srcdoc=");
    // The embedded document carries the SAMPLE watermark + the identity.
    expect(html).toContain("نموذج · SAMPLE");
    expect(html).toContain("Alpha Trading LLC");
    expect(html).toContain("100000000000003");
    // No physical-direction classes on the wrapper.
    expect(html).not.toMatch(/\b(ml-|mr-|pl-|pr-|text-left|text-right)\b/);
  });

  it("follows the configured document language (Arabic-only sample)", () => {
    const html = renderToStaticMarkup(
      h(DocumentPreview, {
        profile: { ...profile, identity: { ...profile.identity, docLanguage: "ar" } },
        dateText: "27 Aug 2026",
        dict,
      }),
    );
    expect(html).toContain("نموذج مستند");
    expect(html).not.toContain("&gt;Sample document&lt;");
  });
});
