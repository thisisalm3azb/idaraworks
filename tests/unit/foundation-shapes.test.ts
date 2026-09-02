/**
 * H5 — "One foundation, different shapes" (the Built-around-your-business
 * section body). Guarantees:
 *  - the bullet-and-roadmap-box layout is retired,
 *  - adaptability is DEMONSTRATED within verified shipped behavior only
 *    (terminology choice, stage shaping, supported capabilities, reviewed
 *    setup, undo with history) over one stable foundation,
 *  - the ledger lists only shipped capability (H13: no roadmap-status labels
 *    in customer-facing copy),
 *  - the configuration-safety law remains, in plain and detailed form,
 *  - no industry templates, invented data, AI/code-writing claims,
 *  - RTL-safe logical classes, static markup, no fake controls.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "@/platform/i18n";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { FoundationShapes } from "@/app/_home/FoundationShapes";

const tEn = (k: string) => t(k, undefined, "en");
const tAr = (k: string) => t(k, undefined, "ar");
const htmlEn = renderToStaticMarkup(h(FoundationShapes, { t: tEn }));
const htmlAr = renderToStaticMarkup(h(FoundationShapes, { t: tAr }));
const homeSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/_home/HomePage.tsx", import.meta.url)),
  "utf8",
);
const shapesSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/_home/FoundationShapes.tsx", import.meta.url)),
  "utf8",
);

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l(?!g)|rounded-r|float-(left|right))\b/;

const builtEn = Object.keys(en)
  .filter((k) => k.startsWith("home.built."))
  .map((k) => String(en[k as keyof typeof en]))
  .join("  ");

describe("H5 — structure", () => {
  it("retires the bullet list and the roadmap-box copy keys", () => {
    for (const k of [
      "home.built.p1",
      "home.built.p2",
      "home.built.p3",
      "home.built.now_body",
      "home.built.planned_body",
    ]) {
      expect(k in en, `${k} must be retired`).toBe(false);
      expect(k in ar, `${k} must be retired`).toBe(false);
    }
    expect(homeSrc).toContain("<FoundationShapes t={t} />");
    expect(homeSrc).not.toMatch(/home\.built\.p1|now_body|planned_body/);
  });

  it("shows one stable foundation carrying the connected record", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      expect(html).toContain(tt("home.built.foundation"));
      expect(html).toContain(tt("home.built.foundation_note"));
    }
  });

  it("demonstrates terminology truthfully: one foundation term, real choices", () => {
    // The demo mirrors the shipped intake: what the business calls its work.
    expect(htmlEn).toContain("Call the work what your business calls it.");
    for (const k of ["words_base", "words_o1", "words_o2", "words_o3", "words_note"]) {
      expect(htmlEn).toContain(tEn(`home.built.${k}`));
      expect(htmlAr).toContain(tAr(`home.built.${k}`));
    }
    // No unrestricted-renaming claim.
    expect(builtEn).not.toMatch(/rename (anything|everything)/i);
  });

  it("demonstrates workflow shaping within supported behavior (rename, order, leave out)", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      for (const k of ["stages_title", "shape_a", "shape_b", "stage_handover", "stages_note"]) {
        expect(html).toContain(tt(`home.built.${k}`));
      }
    }
    // The left-out stage is a struck ghost, not an interactive control; no
    // drag-and-drop is claimed anywhere.
    expect(htmlEn).toContain("line-through");
    expect(builtEn).not.toMatch(/drag|drop/i);
  });

  it("describes the reviewed configuration sequence accurately, with undo", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      for (const k of ["review_title", "review_s1", "review_s2", "review_s3", "review_undo"]) {
        expect(html).toContain(tt(`home.built.${k}`));
      }
    }
    expect(tEn("home.built.review_s3")).toMatch(/nothing is created until/i);
  });

  it("lists only shipped capability in the ledger, with no roadmap-status labels (H13)", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      for (const k of ["now_i1", "now_i2", "now_i3", "now_i4", "now_i5"]) {
        expect(html).toContain(tt(`home.built.${k}`));
      }
    }
    // The roadmap-label keys are retired outright; every listed item is
    // shipped, so nothing needs an availability chip.
    for (const k of [
      "home.built.now_label",
      "home.built.planned_label",
      "home.built.pl_i1",
      "home.built.pl_i2",
      "home.built.pl_i3",
      "home.built.pl_i4",
    ]) {
      expect(k in en, `${k} must be retired`).toBe(false);
      expect(k in ar, `${k} must be retired`).toBe(false);
    }
  });

  it("carries the safety law in plain language plus the detailed guardrail", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      expect(html).toContain(tt("home.built.law"));
      expect(html).toContain(tt("home.built.guardrail"));
    }
    expect(tEn("home.built.law")).toMatch(/cannot rewrite the product or its security/i);
  });

  it("closes with the shape statement", () => {
    expect(htmlEn).toContain(tEn("home.built.close"));
    expect(htmlAr).toContain(tAr("home.built.close"));
  });
});

describe("H5 — truthfulness", () => {
  it("shows no industry templates or presets", () => {
    const all = builtEn + " " + htmlEn;
    expect(all).not.toMatch(
      /coffee|cafe|construction|bakery|real[- ]estate|workshop|farm|salon|restaurant|boat/i,
    );
  });

  it("contains no invented names, metrics, prices, dates or customer data", () => {
    for (const html of [htmlEn, htmlAr]) {
      const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ");
      // Only the three decorative review-step numerals are allowed.
      const numerals = [...html.matchAll(/aria-hidden="true" dir="ltr"[^>]*>(\d)</g)];
      expect(numerals.length).toBe(3);
      expect(text.replace(/\b[123]\b/g, " ")).not.toMatch(/\d/);
      expect(html).not.toMatch(/\b(AED|USD|SAR|EUR|QAR|KWD|BHD|OMR)\b/);
    }
    expect(builtEn).not.toMatch(/\d/);
  });

  it("never claims setup generates code, changes security, or is AI", () => {
    expect(builtEn).not.toMatch(/\bAI\b/);
    // A positive claim of writing/generating code is banned; the guardrail's
    // own DENIAL ("will never write ... code") is the one permitted mention.
    expect(builtEn).not.toMatch(
      /\b(?<!never )(write|generate|create)s?\b[^.]{0,60}\b(code|sql|database|migration)/i,
    );
    const guard = String(en["home.built.guardrail" as keyof typeof en]);
    expect(guard).toMatch(/never (write|change)[^.]*(code|database|security)/i);
    expect(builtEn).not.toContain("—");
    expect(builtEn).not.toMatch(/magical|revolutionary|effortless|works for every business/i);
  });

  it("Arabic copy is genuinely Arabic across the section", () => {
    for (const k of Object.keys(ar).filter((x) => x.startsWith("home.built."))) {
      expect(/[؀-ۿ]/.test(String(ar[k as keyof typeof ar])), `ar.${k} not Arabic`).toBe(true);
    }
  });
});

describe("H5 — accessibility, RTL, motion, scope", () => {
  it("renders no fake interactive control and nothing focusable", () => {
    for (const html of [htmlEn, htmlAr]) {
      expect(html).not.toMatch(/<button|<a |<input|<select|tabindex|role="(button|switch)"/i);
    }
  });

  it("uses only logical direction classes and mirrors the forward glyph", () => {
    for (const html of [htmlEn, htmlAr]) {
      const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
      expect(PHYSICAL.test(classes), classes).toBe(false);
    }
    expect(htmlEn).toContain("rtl:-scale-x-100");
    expect(htmlEn).not.toMatch(/<svg(?![^>]*aria-hidden)/);
  });

  it("is fully static, so reduced motion needs no special path", () => {
    expect(shapesSrc).not.toMatch(/animation[:-]|animate-|@keyframes|lcs-|lbs-/);
    for (const html of [htmlEn, htmlAr]) {
      expect(html).not.toMatch(/animation|animate-/);
      expect(html).not.toMatch(/style="[^"]*opacity:\s*0/);
    }
  });

  it("keeps exactly one h2 and the h3-free layer hierarchy under it", () => {
    expect((htmlEn.match(/<h2/g) ?? []).length).toBe(1);
    expect(htmlEn).not.toMatch(/<h1|<h4/);
  });

  it("preserves the Product anchor and sticky offset; hero and H4 untouched", () => {
    expect(homeSrc).toMatch(/<section id="product" className="scroll-mt-16/);
    expect(homeSrc).toContain("<ProductVisual t={t} dir={dir} />");
    expect(homeSrc).toContain("<FlowJourney t={t} />");
    expect(shapesSrc).not.toMatch(/home\.viz\.|home\.flow\.|home\.caps\./);
  });

  it("introduces no raster, canvas, video or new runtime dependency", () => {
    for (const bad of ["<img", "<canvas", "<video", "webgl", "three"]) {
      expect(shapesSrc.toLowerCase()).not.toContain(bad);
    }
    // This surface imports none of these libraries. A SOURCE check on the
    // surface itself, not a name regex over package.json: the app's gated
    // Studio 3D route dynamically imports `three` (H25 ADR-4) and must not
    // be mistaken for a hero animation.
    expect(shapesSrc).not.toMatch(
      /from\s+["'](framer|three|gsap|lottie|animejs|motion|@xyflow\/react)/,
    );
  });
});
