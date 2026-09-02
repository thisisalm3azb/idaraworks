/**
 * H4 — the connected business journey ("#how" section body). Guarantees:
 *  - the six-equal-cards grid is retired; the section is one ordered journey,
 *  - every stage says what happens AND what carries forward,
 *  - the journey resolves into a final connected outcome + adaptable-use note,
 *  - truthful content only (no names, metrics, prices, dates, AI claims),
 *  - RTL-safe logical classes, mirrored converge glyphs, decorative internals
 *    hidden, no fake interactive controls, and no animation at all (static
 *    server markup renders the completed state for everyone, reduced motion
 *    included).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "@/platform/i18n";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { FlowJourney } from "@/app/_home/FlowJourney";

const tEn = (k: string) => t(k, undefined, "en");
const tAr = (k: string) => t(k, undefined, "ar");
const htmlEn = renderToStaticMarkup(h(FlowJourney, { t: tEn }));
const htmlAr = renderToStaticMarkup(h(FlowJourney, { t: tAr }));
const homeSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/_home/HomePage.tsx", import.meta.url)),
  "utf8",
);
const journeySrc = readFileSync(
  fileURLToPath(new URL("../../src/app/_home/FlowJourney.tsx", import.meta.url)),
  "utf8",
);

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l(?!g)|rounded-r|float-(left|right))\b/;

const STAGE_KEYS = ["win", "plan", "run", "cost", "paid", "understand"] as const;

describe("H4 journey — structure", () => {
  it("retires the six-equal-cards grid and its copy keys", () => {
    // The old grid markup and the old .desc/.thread keys are gone everywhere.
    expect(homeSrc).not.toMatch(/grid gap-4 sm:grid-cols-2 lg:grid-cols-3/);
    expect(homeSrc).not.toContain("home.flow.thread");
    for (const k of STAGE_KEYS) {
      expect(`home.flow.${k}.desc` in en).toBe(false);
      expect(`home.flow.${k}.desc` in ar).toBe(false);
    }
    expect("home.flow.thread" in en).toBe(false);
    // The journey is not itself a grid of six identical <li> cards: stages
    // alternate sides and the final stage resolves differently.
    expect(htmlEn).toContain("md:col-start-1 md:justify-self-end");
    expect(htmlEn).toContain("md:col-start-3 md:justify-self-start");
  });

  it("keeps the #how section shell, anchor and sticky-header offset", () => {
    expect(homeSrc).toMatch(/<section id="how" className="scroll-mt-16/);
    expect(homeSrc).toContain("<FlowJourney t={t} />");
  });

  it("renders one ordered list with all six stages present and in order", () => {
    for (const html of [htmlEn, htmlAr]) {
      expect((html.match(/<ol/g) ?? []).length).toBe(1);
      expect((html.match(/<li/g) ?? []).length).toBe(6);
    }
    const order = STAGE_KEYS.map((k) => htmlEn.indexOf(tEn(`home.flow.${k}.name`)));
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!, `stage ${STAGE_KEYS[i]} out of order`).toBeGreaterThan(order[i - 1]!);
    }
  });

  it("each stage explains what happens, as an h3 + text under the section h2", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      expect((html.match(/<h3/g) ?? []).length).toBe(6);
      expect(html).not.toMatch(/<h1|<h2|<h4/); // heading levels come from the page shell
      for (const k of STAGE_KEYS) {
        expect(html, `missing name ${k}`).toContain(tt(`home.flow.${k}.name`));
        expect(html, `missing what ${k}`).toContain(tt(`home.flow.${k}.what`));
      }
    }
  });

  it("stages 1-5 each state what is carried forward to the next stage", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      expect((html.match(new RegExp(tt("home.flow.carry"), "g")) ?? []).length).toBe(5);
      for (const k of ["win", "plan", "run", "cost", "paid"]) {
        expect(html, `missing fwd ${k}`).toContain(tt(`home.flow.${k}.fwd`));
      }
    }
  });

  it("resolves into a final connected outcome plus the adaptable-use note", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      expect(html).toContain(tt("home.flow.outcome"));
      expect(html).toContain(tt("home.flow.adapt"));
    }
    // The adaptable note reads as a designed capsule, not a footnote.
    expect(htmlEn).toMatch(/border-dashed[^"]*px-4 py-2/);
  });
});

describe("H4 journey — truthfulness", () => {
  const flowEn = Object.keys(en)
    .filter((k) => k.startsWith("home.flow."))
    .map((k) => String(en[k as keyof typeof en]))
    .join("  ");
  const flowAr = Object.keys(ar)
    .filter((k) => k.startsWith("home.flow."))
    .map((k) => String(ar[k as keyof typeof ar]))
    .join("  ");

  it("contains no invented names, metrics, prices, dates or digits", () => {
    for (const html of [htmlEn, htmlAr]) {
      const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ");
      // The only digits are the decorative aria-hidden stage numerals.
      const numerals = [...html.matchAll(/aria-hidden="true" dir="ltr"[^>]*>(\d+)</g)];
      expect(numerals.length).toBe(6);
      const semantic = text.replace(/\b0[1-6]\b/g, " ");
      expect(semantic).not.toMatch(/\d/);
      expect(html).not.toMatch(/\b(AED|USD|SAR|EUR|QAR|KWD|BHD|OMR)\b/);
    }
    expect(flowEn).not.toMatch(/\d/);
    expect(flowAr).not.toMatch(/[\d٠-٩]/);
  });

  it("makes no automation, AI or banned-language claim", () => {
    expect(flowEn).not.toMatch(/\bAI\b|automat|magical|revolutionary|effortless|smart|instant/i);
    expect(flowEn).not.toMatch(
      /all[- ]in[- ]one|everything you need|save[sd]? (you )?(time|hours)/i,
    );
    expect(flowEn).not.toContain("—");
    expect(flowAr).not.toContain("—");
  });

  it("Arabic journey copy is genuinely Arabic", () => {
    for (const k of Object.keys(ar).filter((x) => x.startsWith("home.flow."))) {
      expect(/[؀-ۿ]/.test(String(ar[k as keyof typeof ar])), `ar.${k} not Arabic`).toBe(true);
    }
  });
});

describe("H4 journey — accessibility, RTL and motion", () => {
  it("hides every mini-visual and decoration from assistive technology", () => {
    // Both mini-visual wrappers per stage-ish: minis, spine, glyphs, numerals.
    expect((htmlEn.match(/aria-hidden="true"/g) ?? []).length).toBeGreaterThanOrEqual(12);
    expect(htmlEn).not.toMatch(/<svg(?![^>]*aria-hidden)/); // every svg is decorative
  });

  it("contains no fake interactive control and nothing focusable", () => {
    for (const html of [htmlEn, htmlAr]) {
      expect(html).not.toMatch(/<button|<a |<input|tabindex|role="button"/i);
    }
  });

  it("uses only logical (RTL-safe) direction classes, mirroring the converge glyphs", () => {
    for (const html of [htmlEn, htmlAr]) {
      const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
      expect(PHYSICAL.test(classes), classes).toBe(false);
    }
    // The two converge glyphs flip under RTL; the down-glyphs are neutral.
    expect(htmlEn).toContain("rtl:-scale-x-100");
  });

  it("is fully static: no animation classes, so reduced motion needs no special path", () => {
    expect(journeySrc).not.toMatch(/animation[:-]|animate-|@keyframes|lcs-|lbs-/);
    for (const html of [htmlEn, htmlAr]) {
      expect(html).not.toMatch(/animation|animate-/);
      expect(html).not.toMatch(/style="[^"]*opacity:\s*0/); // nothing hidden at rest
    }
  });

  it("introduces no raster, canvas, video or new runtime dependency", () => {
    for (const bad of ["<img", "<canvas", "<video", "webgl", "three"]) {
      expect(journeySrc.toLowerCase()).not.toContain(bad);
    }
    // This surface imports none of these libraries. A SOURCE check on the
    // surface itself, not a name regex over package.json: the app's gated
    // Studio 3D route dynamically imports `three` (H25 ADR-4) and must not
    // be mistaken for a hero animation.
    expect(journeySrc).not.toMatch(
      /from\s+["'](framer|three|gsap|lottie|animejs|motion|swiper|carousel|@xyflow\/react)/,
    );
  });

  it("touches neither the hero nor any authenticated surface", () => {
    // The hero visual and its keys are untouched by H4.
    expect(journeySrc).not.toMatch(/home\.viz\.|ProductVisual|lcs-/);
    expect(homeSrc).toContain("<ProductVisual t={t} dir={dir} />");
  });
});
