/**
 * The homepage's interactive demonstration: pure rules (name cleaning and
 * initials, industry scenarios, step advance and reset) and the resolved copy
 * (every industry and step renders real sentences with the sample values
 * substituted, in every shipped language). The client component only indexes
 * what these functions return, so this is where its behaviour is pinned.
 */
import { describe, expect, it } from "vitest";
import { t } from "@/platform/i18n";
import { term } from "@/platform/terminology";
import {
  INDUSTRIES,
  STEPS,
  STEP_COUNT,
  SWATCHES,
  MAX_NAME_LENGTH,
  cleanName,
  clampStep,
  displayName,
  initialsFor,
  isLastStep,
  nextStep,
  stepView,
} from "@/app/_home/demoRules";
import { buildDemoCopy, buildDemoLabels } from "@/app/_home/demoCopy";

const tEn = (k: string, v?: Record<string, string | number>) => t(k, v, "en");

describe("company name handling", () => {
  it("collapses whitespace, strips control characters and bounds the length", () => {
    expect(cleanName("  Sidra   Farms  ")).toBe("Sidra Farms");
    expect(
      cleanName(`A${String.fromCharCode(0)}B${String.fromCodePoint(0x200b)}C
D`),
    ).toBe("ABC D");
    const long = "x".repeat(MAX_NAME_LENGTH + 20);
    expect(cleanName(long).length).toBe(MAX_NAME_LENGTH);
  });

  it("cuts on grapheme boundaries, never inside an emoji or a combined letter", () => {
    const farmer = "👩‍🌾"; // woman + joiner + ear of rice: one grapheme, three code points
    const cut = cleanName(farmer.repeat(60));
    const count = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(cut)]
      .length;
    expect(count).toBe(MAX_NAME_LENGTH);
    expect(cut.endsWith(farmer)).toBe(true);
    expect(cut.endsWith(String.fromCodePoint(0x200d))).toBe(false);
    expect(cleanName("مرحبًا بكم")).toBe("مرحبًا بكم");
  });

  it("falls back to the placeholder company when nothing usable was typed", () => {
    expect(displayName("   ", "Your company")).toBe("Your company");
    expect(displayName(String.fromCodePoint(0x200b), "Your company")).toBe("Your company");
    expect(displayName("Dune Ridge Trading", "Your company")).toBe("Dune Ridge Trading");
  });

  it("initials come from the first two words, grapheme-aware", () => {
    expect(initialsFor("Sidra Farms")).toBe("SF");
    expect(initialsFor("Atlas")).toBe("A");
    expect(initialsFor("مزارع سدرة")).toBe("مس");
    expect(initialsFor("🌾 Harvest Co")).toBe("🌾H");
    expect(initialsFor("Al-Noor & Sons")).toBe("AS");
    expect(initialsFor("& - ")).toBe("");
  });

  it("renders any typed text as plain text (markup is inert data)", () => {
    // The component prints the name through React text nodes; the pure layer
    // must therefore never strip or interpret angle brackets, only bound them.
    const typed = "<img src=x onerror=alert(1)> & co";
    expect(cleanName(typed)).toBe(typed);
  });
});

describe("journey steps", () => {
  it("has five steps, advances in order and wraps back to the first", () => {
    expect(STEP_COUNT).toBe(5);
    expect(STEPS).toEqual(["quote", "work", "resources", "invoice", "paid"]);
    let s = 0;
    const seen = [s];
    for (let i = 0; i < 5; i++) {
      s = nextStep(s);
      seen.push(s);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 0]);
    expect(isLastStep(4)).toBe(true);
    expect(isLastStep(3)).toBe(false);
  });

  it("clamps out-of-range and non-integer steps", () => {
    expect(clampStep(-1)).toBe(0);
    expect(clampStep(99)).toBe(4);
    expect(clampStep(Number.NaN)).toBe(0);
  });

  it("offers four industries and four AA-safe swatches", () => {
    expect(INDUSTRIES).toEqual(["trading", "construction", "services", "manufacturing"]);
    expect(SWATCHES.map((s) => s.key)).toEqual(["forest", "indigo", "copper", "ocean"]);
    for (const s of SWATCHES) expect(s.hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("resolved demo copy", () => {
  const job = term("job", { locale: "en" }).toLocaleLowerCase("en");
  const copy = buildDemoCopy(tEn, job);

  it("every industry and step carries a full, substituted sentence set", () => {
    for (const industry of INDUSTRIES) {
      expect(copy.scenarios[industry].item.length).toBeGreaterThan(0);
      for (let step = 0; step < STEP_COUNT; step++) {
        const v = stepView(copy, industry, step);
        for (const [field, value] of Object.entries(v)) {
          expect(value, `${industry}/${STEPS[step]}.${field}`).not.toMatch(/\{[a-z_]+\}|⟦/);
          expect(value.length, `${industry}/${STEPS[step]}.${field}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("industry selection changes the sample content, not just the label", () => {
    const first = INDUSTRIES.map((i) => stepView(copy, i, 0).text);
    expect(new Set(first).size).toBe(INDUSTRIES.length);
    const items = INDUSTRIES.map((i) => copy.scenarios[i].item);
    expect(new Set(items).size).toBe(INDUSTRIES.length);
    // Services speak of people; the others connect materials and stock.
    expect(stepView(copy, "services", 2).text).toMatch(/owns each activity/);
    expect(stepView(copy, "trading", 2).text).toMatch(/materials and stock/);
  });

  it("each step visibly changes the document state and the phone event", () => {
    for (const industry of INDUSTRIES) {
      const states = STEPS.map((_, i) => stepView(copy, industry, i).state);
      const phones = STEPS.map((_, i) => stepView(copy, industry, i).phoneTitle);
      expect(new Set(states).size).toBe(STEP_COUNT);
      expect(new Set(phones).size).toBe(STEP_COUNT);
    }
  });

  it("the quote amount reappears on the invoice and is settled to zero when paid", () => {
    for (const industry of INDUSTRIES) {
      const amount = stepView(copy, industry, 0).totalValue;
      expect(stepView(copy, industry, 3).totalValue).toBe(amount);
      expect(stepView(copy, industry, 4).totalValue).toBe("0.00");
      expect(stepView(copy, industry, 4).detailValue).toContain(amount);
    }
  });

  it("says plainly that recording a payment is not payment processing", () => {
    expect(stepView(copy, "trading", 4).text).toMatch(/not payment processing/);
    expect(stepView(copy, "trading", 4).trace).toMatch(/No actual money moved/);
    const labels = buildDemoLabels(tEn);
    expect(labels.footerNote).toMatch(/no real actions or payments/i);
    expect(labels.ctaLocal).toMatch(/stays in this browser tab/);
  });

  it("the demo's action leads into registration, never to a form of its own", () => {
    expect(buildDemoLabels(tEn).ctaHref).toBe("/signup");
  });

  it("resolves in Arabic and Spanish with the same shape", () => {
    for (const locale of ["ar", "es"] as const) {
      const tl = (k: string, v?: Record<string, string | number>) => t(k, v, locale);
      const c = buildDemoCopy(tl, term("job", { locale }));
      for (const industry of INDUSTRIES) {
        for (let step = 0; step < STEP_COUNT; step++) {
          const v = stepView(c, industry, step);
          expect(v.heading, `${locale} ${industry} ${step}`).not.toMatch(/\{[a-z_]+\}|⟦/);
        }
      }
      if (locale === "ar") expect(/[؀-ۿ]/.test(stepView(c, "trading", 0).text)).toBe(true);
    }
  });
});
