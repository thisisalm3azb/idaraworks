/**
 * H7 — the Business Passport (the "#international" section body). Guarantees:
 *  - the four-card International grid is retired,
 *  - one identity passport feeds two genuinely mirrored outputs (EN ltr /
 *    AR rtl via real lang+dir attributes, not manual reversal),
 *  - English/Arabic/RTL are stated available now; Spanish is Planned only
 *    and never selectable,
 *  - identity, currency, tax and document claims match the audited
 *    implementation (IssuerIdentity fields, DOC_LANGUAGES, per-document
 *    currency and rate) with no compliance/translation/worldwide claims,
 *  - no invented company, address, registration, price or metric,
 *  - static markup, no fake controls, hero/H4/H5/H6/pricing untouched.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "@/platform/i18n";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { BusinessPassport } from "@/app/_home/BusinessPassport";
import { DOC_LANGUAGES } from "@/platform/documents";

const tEn = (k: string) => t(k, undefined, "en");
const tAr = (k: string) => t(k, undefined, "ar");
const htmlEn = renderToStaticMarkup(h(BusinessPassport, { t: tEn }));
const htmlAr = renderToStaticMarkup(h(BusinessPassport, { t: tAr }));
const homeSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/_home/HomePage.tsx", import.meta.url)),
  "utf8",
);
const src = readFileSync(
  fileURLToPath(new URL("../../src/app/_home/BusinessPassport.tsx", import.meta.url)),
  "utf8",
);
const issuerSrc = readFileSync(
  fileURLToPath(new URL("../../src/platform/documents/issuer.ts", import.meta.url)),
  "utf8",
);

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l(?!g)|rounded-r|float-(left|right))\b/;

const gccEn = Object.keys(en)
  .filter((k) => k.startsWith("home.gcc."))
  .map((k) => String(en[k as keyof typeof en]))
  .join("  ");

describe("H7 — structure", () => {
  it("retires the four-card grid and its copy keys", () => {
    for (const g of ["bilingual", "identity", "documents", "regional"]) {
      expect(`home.gcc.${g}.title` in en, `home.gcc.${g}.title must be retired`).toBe(false);
      expect(`home.gcc.${g}.desc` in ar).toBe(false);
    }
    expect(homeSrc).toContain("<BusinessPassport t={t} />");
    expect(homeSrc).not.toMatch(/home\.gcc\.\$\{k\}/);
  });

  it("keeps the #international anchor and sticky offset", () => {
    expect(homeSrc).toMatch(/<section id="international" className="[^"]*scroll-mt-16/);
  });

  it("shows the passport: identity fields matching the real issuer identity", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      expect(html).toContain(tt("home.gcc.passport_title"));
      expect(html).toContain(tt("home.gcc.passport_note"));
      for (const f of ["f_legal", "f_trade", "f_address", "f_tax", "f_currency", "f_terms"]) {
        expect(html, `missing ${f}`).toContain(tt(`home.gcc.${f}`));
      }
    }
    // Every displayed field exists on the audited IssuerIdentity / config:
    for (const impl of ["legalName", "tradingName", "addressEn", "addressAr", "trn"]) {
      expect(issuerSrc).toContain(impl);
    }
  });

  it("renders two genuinely mirrored outputs with real lang and dir attributes", () => {
    for (const html of [htmlEn, htmlAr]) {
      expect(html).toContain('lang="en" dir="ltr"');
      expect(html).toContain('lang="ar" dir="rtl"');
      // The Arabic surface carries real Arabic labels from the product's
      // established vocabulary, never reversed or invented text.
      expect(html).toContain("عرض سعر");
      expect(html).toContain("مقبول");
      expect(html).toContain("الإجمالي");
      expect(html).toContain("من اليمين إلى اليسار");
      // Same structure both ways: the mirrored pair is the same markup twice.
      expect((html.match(/dir="(ltr|rtl)"/g) ?? []).length).toBe(2);
    }
  });

  it("states document languages truthfully (en / ar / bilingual ships)", () => {
    expect([...DOC_LANGUAGES]).toEqual(["en", "ar", "bilingual"]);
    expect(tEn("home.gcc.docnote")).toMatch(/english, arabic or bilingual/i);
    for (const html of [htmlEn, htmlAr]) {
      expect(html).toContain(html === htmlEn ? tEn("home.gcc.docnote") : tAr("home.gcc.docnote"));
    }
  });

  it("keeps Available now louder than Planned, and Spanish never selectable", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      expect(html).toContain(tt("home.gcc.now_label"));
      expect(html).toContain(tt("home.gcc.planned_label"));
      for (const k of ["n1", "n2", "n3", "n4", "n5"]) {
        expect(html).toContain(tt(`home.gcc.${k}`));
      }
      expect(html).toContain(tt("home.gcc.pl1"));
      expect(html).toContain(tt("home.gcc.close"));
    }
    // Spanish appears only inside the dashed Planned panel, after its label.
    expect(htmlEn.indexOf(tEn("home.gcc.pl1"))).toBeGreaterThan(
      htmlEn.indexOf(tEn("home.gcc.planned_label")),
    );
    expect(htmlEn).toMatch(/border-dashed border-line-strong/);
    // English and Arabic availability is explicit text.
    expect(tEn("home.gcc.n1")).toMatch(/arabic and english[^.]*today/i);
    expect(tEn("home.gcc.n2")).toMatch(/right-to-left/i);
  });
});

describe("H7 — truthfulness", () => {
  it("currency wording matches real behavior (workspace currency + per-document rate)", () => {
    expect(tEn("home.gcc.n5")).toMatch(/workspace currency/i);
    expect(tEn("home.gcc.n5")).toMatch(/currency and rate on each quote and invoice/i);
    expect(gccEn).not.toMatch(/any currency|every currency|exchange[- ]rate conversion|convert/i);
  });

  it("tax wording claims storage and documents, never filing or compliance", () => {
    expect(gccEn).not.toMatch(
      /tax filing|files? (your )?tax|tax complian|validat|government|regulat|certif|ZATCA|FTA/i,
    );
    expect(tEn("home.gcc.f_tax")).toBe("Tax registration");
  });

  it("makes no translation, worldwide or compliance claim", () => {
    expect(gccEn).not.toMatch(
      /automatic translation|translates?|every country|worldwide|global compliance|fully localized/i,
    );
    expect(gccEn).not.toMatch(/magical|revolutionary|effortless|smart|AI[- ]powered/i);
    expect(gccEn).not.toContain("—");
  });

  it("invents no company, address, registration, price, metric or country list", () => {
    for (const html of [htmlEn, htmlAr]) {
      const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ");
      expect(text).not.toMatch(/\d/);
      expect(html).not.toMatch(/\b(AED|USD|SAR|EUR|QAR|KWD|BHD|OMR)\b/);
      expect(html).not.toMatch(/TRN[:\s]*\d|VAT[:\s]*\d/);
    }
    // No flag emoji or country list as support claims.
    expect(htmlEn).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u);
  });

  it("Arabic catalog copy is genuinely Arabic", () => {
    for (const k of Object.keys(ar).filter((x) => x.startsWith("home.gcc."))) {
      expect(/[؀-ۿ]/.test(String(ar[k as keyof typeof ar])), `ar.${k} not Arabic`).toBe(true);
    }
  });
});

describe("H7 — accessibility, RTL, motion, scope", () => {
  it("renders no fake interactive control and nothing focusable", () => {
    for (const html of [htmlEn, htmlAr]) {
      expect(html).not.toMatch(/<button|<a |<input|<select|tabindex|role="(button|tab|switch)"/i);
    }
  });

  it("uses only logical direction classes outside the dir-scoped surfaces", () => {
    for (const html of [htmlEn, htmlAr]) {
      const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
      expect(PHYSICAL.test(classes), classes).toBe(false);
    }
    expect((htmlEn.match(/aria-hidden="true"/g) ?? []).length).toBeGreaterThanOrEqual(10);
  });

  it("is fully static, so reduced motion needs no special path", () => {
    expect(src).not.toMatch(/animation[:-]|animate-|@keyframes|lcs-|lbs-/);
    for (const html of [htmlEn, htmlAr]) {
      expect(html).not.toMatch(/animation|animate-/);
      expect(html).not.toMatch(/style="[^"]*opacity:\s*0/);
    }
  });

  it("leaves the hero, H4, H5, H6 and pricing untouched", () => {
    expect(src).not.toMatch(/home\.viz\.|home\.flow\.|home\.built\.|home\.caps\.|home\.pricing\./);
    expect(homeSrc).toContain("<ProductVisual t={t} dir={dir} />");
    expect(homeSrc).toContain("<FlowJourney t={t} />");
    expect(homeSrc).toContain("<FoundationShapes t={t} />");
    expect(homeSrc).toContain("<CapabilityMap t={t} />");
    expect(homeSrc).toMatch(/<section id="pricing"/);
  });

  it("introduces no raster, canvas, video or new runtime dependency", () => {
    for (const bad of ["<img", "<canvas", "<video", "webgl", "three"]) {
      expect(src.toLowerCase()).not.toContain(bad);
    }
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      expect(dep).not.toMatch(/framer|three|gsap|lottie|animejs|motion/);
    }
  });
});
