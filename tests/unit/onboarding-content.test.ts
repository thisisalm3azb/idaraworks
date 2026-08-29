/**
 * H15.1 — professional onboarding language, taxonomy and progress model.
 * Pins the Part B wording, the 17-area international industry taxonomy with
 * its legacy compatibility mapping, the industry-never-forces-modules rule,
 * the single "Step X of Y" progress model, and the one-heading-per-screen
 * layout. Every pin here is a customer-facing promise — change the copy or
 * the taxonomy deliberately, then update the pin.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import {
  DraftAnswersSchema,
  DraftDataSchema,
  INDUSTRIES,
  INDUSTRY_INFO,
  INDUSTRY_OPTIONS,
  LEGACY_INDUSTRIES,
  LEGACY_INDUSTRY_MAP,
  canonicalIndustry,
  stepNumberOf,
  visibleSteps,
  type DraftAnswers,
} from "@/modules/onboarding/flow";
import { recommendModules } from "@/modules/onboarding/blueprint-map";

const EN = en as Record<string, string>;
const AR = ar as Record<string, string>;

// ── Part B: the exact customer-facing wording ────────────────────────────────
describe("H15.1 — business step wording", () => {
  it("pins the Primary industry field copy", () => {
    expect(EN["onboarding.flow.business.industry"]).toBe("Primary industry");
    expect(EN["onboarding.flow.business.industry_prompt"]).toBe(
      "Which industry best describes your business?",
    );
    expect(EN["onboarding.flow.business.industry_pick"]).toBe("Select your primary industry");
    expect(EN["onboarding.flow.business.industry_help"]).toBe(
      "Choose the closest match to your main business activity. You can refine your setup later.",
    );
  });

  it("pins the Business activity summary copy", () => {
    expect(EN["onboarding.flow.business.description"]).toBe("Business activity summary");
    expect(EN["onboarding.flow.business.description_prompt"]).toBe(
      "Briefly describe your main products or services.",
    );
    expect(EN["onboarding.flow.business.description_help"]).toBe(
      "One or two sentences is enough. Include what you provide and who you serve.",
    );
  });

  it("keeps the business name and marks the legal name as a concise optional field", () => {
    expect(EN["onboarding.flow.business.name"]).toBe("Business name");
    expect(EN["onboarding.flow.business.legal_name"]).toBe("Registered legal name");
    // One concise sentence of distinction, nothing country-specific.
    expect(EN["onboarding.flow.business.legal_name_help"]).toMatch(/^Optional\./);
  });

  it("uses the approved Arabic candidates for the industry field", () => {
    expect(AR["onboarding.flow.business.industry"]).toBe("القطاع الرئيسي");
    expect(AR["onboarding.flow.business.description"]).toBe("ملخص نشاط الشركة");
    expect(AR["onboarding.flow.business.industry_pick"]).toBe("اختر القطاع الرئيسي لشركتك");
  });

  it("has no country- or industry-specific example anywhere in the business step copy", () => {
    for (const [k, v] of Object.entries(EN)) {
      if (!k.startsWith("onboarding.flow.business.")) continue;
      expect(v, k).not.toMatch(/aluminium|steel|gate|noor|dubai|gulf|construction/i);
      expect(v, k).not.toMatch(/e\.g\.|for example/i);
    }
  });
});

// ── Part C: the taxonomy and its compatibility mapping ───────────────────────
describe("H15.1 — industry taxonomy", () => {
  it("offers exactly the 17 international areas, ending in other/mixed", () => {
    expect(INDUSTRY_OPTIONS).toHaveLength(17);
    expect(INDUSTRY_OPTIONS[INDUSTRY_OPTIONS.length - 1]).toBe("other_mixed");
    expect(new Set(INDUSTRY_OPTIONS).size).toBe(INDUSTRY_OPTIONS.length);
    expect(new Set(INDUSTRIES).size).toBe(INDUSTRIES.length);
  });

  it("labels every selectable and legacy value in both languages, without internal keys", () => {
    for (const k of INDUSTRIES) {
      const enLabel = EN[`onboarding.flow.industry.${k}`] ?? "";
      const arLabel = AR[`onboarding.flow.industry.${k}`] ?? "";
      expect(enLabel, k).toBeTruthy();
      expect(arLabel, k).toBeTruthy();
      expect(enLabel).not.toMatch(/cap\.|_v1|[a-z]_[a-z]/);
      expect(enLabel[0]).toBe(enLabel[0]?.toUpperCase()); // sentence case, no shouting
      expect(enLabel).not.toMatch(/—/);
      expect(arLabel).not.toMatch(/—/);
    }
  });

  it("maps every legacy value onto exactly one current area", () => {
    for (const legacy of LEGACY_INDUSTRIES) {
      const mapped = LEGACY_INDUSTRY_MAP[legacy];
      expect(INDUSTRY_OPTIONS, legacy).toContain(mapped);
      expect(canonicalIndustry(legacy)).toBe(mapped);
    }
    for (const current of INDUSTRY_OPTIONS) {
      expect(canonicalIndustry(current)).toBe(current);
    }
    expect(canonicalIndustry(undefined)).toBeUndefined();
  });

  it("still parses an old draft without changing its stored answer", () => {
    const parsed = DraftAnswersSchema.parse({ business_name: "Old Co", industry: "marine" });
    expect(parsed.industry).toBe("marine"); // preserved, never rewritten
    const draft = DraftDataSchema.parse({
      answers: { business_name: "Old Co", industry: "food_beverage" },
    });
    expect(draft.answers.industry).toBe("food_beverage");
  });

  it("behaves identically for a legacy value and its canonical area", () => {
    const base: DraftAnswers = {
      business_name: "Same Co",
      country: "AE",
      work_patterns: ["order"],
      sends_invoices: "yes",
      collects_payments: "no",
      records_expenses: "no",
      tracks_costs: "no",
    };
    for (const legacy of LEGACY_INDUSTRIES) {
      const a = { ...base, industry: legacy };
      const b = { ...base, industry: LEGACY_INDUSTRY_MAP[legacy] };
      expect(recommendModules(a), legacy).toEqual(recommendModules(b));
      expect(visibleSteps(a), legacy).toEqual(visibleSteps(b));
    }
  });
});

// ── Part D: industry informs, answers decide ─────────────────────────────────
describe("H15.1 — industry alone never forces modules", () => {
  const allNo: DraftAnswers = {
    business_name: "Quiet Office",
    industry: "construction", // the most operations-heavy area there is
    work_patterns: ["order"],
    buys_materials: "no",
    holds_stock: "no",
    receives_deliveries: "no",
    sends_quotes: "no",
    sends_invoices: "no",
    collects_payments: "no",
    records_expenses: "no",
    tracks_costs: "no",
  };

  it("a construction business that answers no gets no forced operations modules", () => {
    const byKey = new Map(recommendModules(allNo).map((m) => [m.key, m]));
    for (const key of [
      "cap.daily_reports",
      "cap.material_requests",
      "cap.goods_receipts",
      "cap.items",
      "cap.quoting",
      "cap.invoicing",
      "cap.payments",
    ]) {
      expect(byKey.get(key as never)?.enabled, key).toBe(false);
    }
  });

  it("a physical industry is asked the materials questions; an office industry is not", () => {
    expect(visibleSteps({ ...allNo, industry: "construction" })).toContain("materials");
    expect(
      visibleSteps({ ...allNo, industry: "professional_services", work_patterns: ["service"] }),
    ).not.toContain("materials");
  });

  it("every area carries an explicit physical/field classification", () => {
    for (const k of INDUSTRY_OPTIONS) {
      const info = INDUSTRY_INFO[k];
      expect(typeof info.physical, k).toBe("boolean");
      expect(typeof info.fieldService, k).toBe("boolean");
      expect(info.token.length, k).toBeGreaterThan(0);
    }
  });
});

// ── Part E: one progress model ───────────────────────────────────────────────
describe("H15.1 — single Step X of Y progress model", () => {
  const office: DraftAnswers = {
    business_name: "Desk Co",
    industry: "professional_services",
    work_patterns: ["service"],
  };
  const yard: DraftAnswers = { ...office, industry: "construction" };

  it("counts exactly the currently visible journey, excluding the welcome screen", () => {
    for (const a of [office, yard]) {
      const steps = visibleSteps(a).filter((s) => s !== "welcome");
      const no = stepNumberOf("business", a);
      expect(no.current).toBe(1);
      expect(no.total).toBe(steps.length);
      // Every visible step gets a consistent, monotonically increasing number.
      steps.forEach((s, i) => {
        expect(stepNumberOf(s, a)).toEqual({ current: i + 1, total: steps.length });
      });
    }
  });

  it("hidden branch steps are not counted in the total", () => {
    expect(stepNumberOf("business", office).total).toBe(
      stepNumberOf("business", yard).total - 1, // yard adds only the materials step
    );
  });

  it("the progress copy is Step X of Y with a bar label, and the vague remaining copy is gone", () => {
    expect(EN["onboarding.flow.progress"]).toBe("Step {current} of {total}");
    expect(EN["onboarding.flow.progress_label"]).toBe("Setup progress");
    expect(AR["onboarding.flow.progress_label"]).toBeTruthy();
    expect(EN["onboarding.flow.remaining"]).toBeUndefined();
    expect(EN["onboarding.flow.section_progress"]).toBeUndefined();
    expect(AR["onboarding.flow.remaining"]).toBeUndefined();
    expect(AR["onboarding.flow.section_progress"]).toBeUndefined();
  });
});

// ── Part F/G: one heading per screen, honest copy ────────────────────────────
describe("H15.1 — layout and content standards", () => {
  const pageSrc = readFileSync("src/app/(auth)/onboarding/page.tsx", "utf8");
  const stepsSrc = readFileSync("src/app/(auth)/onboarding/steps.tsx", "utf8");

  it("renders one page heading; step cards no longer repeat the section title", () => {
    expect(pageSrc.match(/<h1/g)).toHaveLength(1);
    // The only h1 left in the step screens belongs to the welcome screen,
    // which renders without the page heading block.
    expect(stepsSrc.match(/<h1/g)).toHaveLength(1);
    for (const dup of ["business.title", "customers.title", "money.title", "priorities.title"]) {
      expect(stepsSrc).not.toContain(`onboarding.flow.${dup}`);
    }
  });

  it("no approximate remaining copy is referenced anywhere in the flow UI", () => {
    for (const src of [pageSrc, stepsSrc]) {
      expect(src).not.toContain("flow.remaining");
      expect(src).not.toContain("section_progress");
    }
  });

  it("does not promise that everything is reversible", () => {
    expect(EN["onboarding.flow.review.promise_later"]).toBe(
      "Your setup choices can be revised later in Settings. Changes are recorded and reversible.",
    );
    for (const [k, v] of Object.entries(EN)) {
      if (!k.startsWith("onboarding.flow.")) continue;
      expect(v, k).not.toMatch(/everything (is|can be) (undone|reversed)/i);
      expect(v, k).not.toMatch(/revolutioni[sz]e|supercharge|unleash|magic/i);
      expect(v, k).not.toContain("—");
    }
    for (const [k, v] of Object.entries(AR)) {
      if (!k.startsWith("onboarding.flow.")) continue;
      expect(v, k).not.toContain("—");
    }
  });

  it("keeps en/ar parity across the whole onboarding namespace", () => {
    const enKeys = Object.keys(EN).filter((k) => k.startsWith("onboarding."));
    const arKeys = Object.keys(AR).filter((k) => k.startsWith("onboarding."));
    expect(arKeys.sort()).toEqual(enKeys.sort());
  });
});
