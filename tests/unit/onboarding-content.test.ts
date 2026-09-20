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
  askMaterialsStep,
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

  it("a physical industry keeps the materials questions in scope; an office industry does not", () => {
    expect(askMaterialsStep({ industry: "construction" })).toBe(true);
    expect(askMaterialsStep({ industry: "professional_services" })).toBe(false);
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
describe("short flow — single Step X of Y progress model over four screens", () => {
  const office: DraftAnswers = { business_name: "Desk Co", industry: "professional_services" };
  const yard: DraftAnswers = { ...office, industry: "construction" };

  it("counts exactly four screens whatever the answers", () => {
    for (const a of [office, yard]) {
      const steps = visibleSteps(a);
      expect(steps).toEqual(["business", "setup", "priorities", "ready"]);
      steps.forEach((s, i) => {
        expect(stepNumberOf(s, a)).toEqual({ current: i + 1, total: 4 });
      });
    }
  });

  it("the progress copy is Step X of Y with a bar label, and the vague remaining copy is gone", () => {
    expect(EN["onboarding.flow.progress"]).toBe("Step {current} of {total}");
    expect(EN["onboarding.flow.progress_label"]).toBe("Setup progress");
    expect(AR["onboarding.flow.progress_label"]).toBeTruthy();
    expect(EN["onboarding.flow.remaining"]).toBeUndefined();
    expect(EN["onboarding.flow.section_progress"]).toBeUndefined();
  });
});

// ── Part F/G: one heading per screen, honest copy ────────────────────────────
describe("short flow — layout and content standards", () => {
  const pageSrc = readFileSync("src/app/(auth)/onboarding/page.tsx", "utf8");
  const screensSrc = readFileSync("src/app/(auth)/onboarding/screens.tsx", "utf8");

  it("renders one page heading; the screens carry none of their own", () => {
    expect(pageSrc.match(/<h1/g)).toHaveLength(1);
    expect(screensSrc.match(/<h1/g)).toBeNull();
  });

  it("one primary action per screen, a working Back link and a bounded name field", () => {
    expect(screensSrc.match(/<form action=/g)).toHaveLength(4);
    expect(
      screensSrc.match(/prevStepBefore\(step, data\.answers\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(screensSrc).toMatch(/stepHref\(prevStepBefore\("ready", data\.answers\)\)/);
    expect(screensSrc).toMatch(/maxLength=\{120\}/);
    expect(screensSrc).not.toMatch(/textarea/);
  });

  it("asks nothing consequential up front: no tax, address, logo or invitation field", () => {
    expect(screensSrc).not.toMatch(/vat|tax_registration|address|logo|invite/i);
  });

  it("does not promise that everything is reversible, and carries no hype", () => {
    for (const [k, v] of Object.entries(EN)) {
      if (!k.startsWith("onboarding.flow.") && !k.startsWith("onb.")) continue;
      expect(v, k).not.toMatch(/everything (is|can be) (undone|reversed)/i);
      expect(v, k).not.toMatch(/revolutioni[sz]e|supercharge|unleash|magic/i);
      expect(v, k).not.toContain("—");
    }
    for (const [k, v] of Object.entries(AR)) {
      if (!k.startsWith("onboarding.flow.") && !k.startsWith("onb.")) continue;
      expect(v, k).not.toContain("—");
    }
  });

  it("keeps en/ar parity across the whole onboarding namespace", () => {
    for (const k of Object.keys(EN)) {
      if (k.startsWith("onboarding.") || k.startsWith("onb.")) {
        expect(AR[k], `ar missing ${k}`).toBeTruthy();
      }
    }
  });
});
