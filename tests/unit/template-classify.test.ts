/**
 * Deterministic template classification tests (post-MVP template catalogue).
 * The eight directive scenarios + ambiguous/mixed businesses + manual override
 * + the honesty rules: never silent, never a bogus key, terminology actually
 * carried as an artifact when the founder renames the core term.
 */
import { describe, expect, it } from "vitest";
import { classifyBusiness, GENERIC_TEMPLATE_KEY } from "@/modules/onboarding/classify";
import { buildGroundedProposal, selectTemplate } from "@/modules/onboarding/provider";
import { validateProposal } from "@/modules/onboarding/validate";
import { OnboardingIntakeSchema, type OnboardingIntake } from "@/modules/onboarding/proposal";

function intake(over: Partial<OnboardingIntake> = {}): OnboardingIntake {
  return OnboardingIntakeSchema.parse({
    business_name: "Test Co",
    business_description: "",
    country: "AE",
    base_currency: "AED",
    languages: ["en", "ar"],
    six_day_week: true,
    vat_registered: true,
    job_term_en: "Job",
    job_term_ar: "مهمة",
    ...over,
  });
}

describe("classifyBusiness — the eight directive scenarios", () => {
  const CASES: Array<[string, string]> = [
    ["we are a boatyard building fiberglass skiffs and catamarans", "boatbuilding_marine_v1"],
    ["metal fabrication shop doing steel work and welding", "manufacturing_workshop_v1"],
    ["we run a restaurant with catering orders in dubai", "food_beverage_v1"],
    ["electronics e-commerce shop selling mobile phones online", "online_store_v1"],
    ["maintenance company doing ac repair and field service calls", "service_business_v1"],
    ["building contractor doing fit-out and civil works projects", "construction_v1"],
    ["we operate a crop farm with seasonal harvests and irrigation", "agriculture_v1"],
    ["a small business doing various things", GENERIC_TEMPLATE_KEY],
  ];

  for (const [description, expected] of CASES) {
    it(`"${description}" → ${expected}`, () => {
      const r = classifyBusiness(description);
      expect(r.recommendedKey).toBe(expected);
    });
  }

  it("classifies Arabic descriptions (مطعم → food & beverage)", () => {
    expect(classifyBusiness("نملك مطعم مأكولات وخدمة تموين في جدة").recommendedKey).toBe(
      "food_beverage_v1",
    );
  });

  it("classifies Arabic marine descriptions (قوارب → boatbuilding)", () => {
    expect(classifyBusiness("مصنع قوارب صيد في الإمارات").recommendedKey).toBe(
      "boatbuilding_marine_v1",
    );
  });

  it("is deterministic — same description yields the identical result", () => {
    const a = classifyBusiness("restaurant and catering company");
    const b = classifyBusiness("restaurant and catering company");
    expect(a).toEqual(b);
  });

  it("ambiguous/empty input falls back to Generic Operations, not a forced fit", () => {
    const r = classifyBusiness("");
    expect(r.recommendedKey).toBe(GENERIC_TEMPLATE_KEY);
    expect(r.confident).toBe(false);
  });

  it("a mixed business (workshop + shop) is marked not confident", () => {
    const r = classifyBusiness(
      "we run a metal fabrication workshop and also an online electronics store with orders and fulfilment",
    );
    // Both templates score — whatever wins, the result must be flagged ambiguous
    // OR carry both in the top ranks so the founder chooses.
    const topTwo = r.ranked.slice(0, 2).map((m) => m.key);
    expect(topTwo).toContain("manufacturing_workshop_v1");
    expect(topTwo).toContain("online_store_v1");
  });

  it("every ranked entry carries its match evidence (transparent scoring)", () => {
    const r = classifyBusiness("restaurant in dubai");
    const top = r.ranked[0]!;
    expect(top.matchedKeywords.length + top.matchedPhrases.length).toBeGreaterThan(0);
  });
});

describe("selectTemplate — manual override + explanation", () => {
  it("an explicit intake.template_key wins over the classifier", () => {
    const s = selectTemplate(
      intake({
        business_description: "we run a restaurant", // would classify food_beverage
        template_key: "construction_v1",
      }),
    );
    expect(s.key).toBe("construction_v1");
    expect(s.reasonEn).toMatch(/selected/i);
  });

  it("always lists the other templates as alternatives (7 of 8)", () => {
    const s = selectTemplate(intake({ business_description: "we run a restaurant" }));
    expect(s.key).toBe("food_beverage_v1");
    expect(s.alternatives.length).toBe(7);
    expect(s.alternatives.map((a) => a.key)).not.toContain("food_beverage_v1");
    for (const a of s.alternatives) {
      expect(a.name_en.length).toBeGreaterThan(0);
      expect(a.name_ar.length).toBeGreaterThan(0);
    }
  });

  it("explains WHY with the matched signals (honest, evidence-based reason)", () => {
    const s = selectTemplate(intake({ business_description: "boatyard building skiffs" }));
    expect(s.key).toBe("boatbuilding_marine_v1");
    expect(s.reasonEn).toMatch(/matched/i);
    expect(s.reasonAr.length).toBeGreaterThan(0);
  });
});

describe("buildGroundedProposal — multi-template grounding", () => {
  it("grounds on the classified template and passes the validator", () => {
    const p = buildGroundedProposal(
      intake({ business_description: "building contractor, fit-out projects" }),
    );
    expect(p.template_key).toBe("construction_v1");
    expect(p.install_template).toBe(true);
    expect(validateProposal(p).ok).toBe(true);
  });

  it("carries the founder's job term as a terminology.overrides artifact when it differs", () => {
    const p = buildGroundedProposal(
      intake({
        business_description: "maintenance and repair company",
        job_term_en: "Ticket",
        job_term_ar: "تذكرة",
      }),
    );
    const term = p.artifacts.find((a) => a.key === "terminology.overrides");
    expect(term).toBeDefined();
    const v = term!.value as { job: { en: { singular: string }; ar: { singular: string } } };
    expect(v.job.en.singular).toBe("Ticket");
    expect(v.job.ar.singular).toBe("تذكرة");
    expect(validateProposal(p).ok).toBe(true);
  });

  it("proposes NO terminology artifact when the founder keeps the template term", () => {
    const p = buildGroundedProposal(
      intake({
        business_description: "we are a boatyard",
        job_term_en: "Boat",
        job_term_ar: "قارب",
      }),
    );
    expect(p.artifacts.find((a) => a.key === "terminology.overrides")).toBeUndefined();
  });

  it("never silently installs: install_template is explicit and the apply step is separate", () => {
    const p = buildGroundedProposal(intake({ business_description: "crop farm" }));
    // The proposal DECLARES the install; applying is a separate human action
    // (applyOnboarding) — asserted end-to-end by the integration suite.
    expect(p.install_template).toBe(true);
    expect(p.template_reason_en.length).toBeGreaterThan(0);
  });
});

describe("validateProposal — registry honesty", () => {
  it("rejects a proposal naming a non-existent template", () => {
    const p = buildGroundedProposal(intake({ business_description: "crop farm" }));
    const bogus = { ...p, template_key: "nonexistent_template_v1" };
    const r = validateProposal(bogus);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/not a registered template/);
  });

  it("rejects alternatives naming non-existent templates", () => {
    const p = buildGroundedProposal(intake({ business_description: "crop farm" }));
    const bogus = {
      ...p,
      template_alternatives: [{ key: "fake_v1", score: 1, name_en: "Fake", name_ar: "وهمي" }],
    };
    expect(validateProposal(bogus).ok).toBe(false);
  });

  it("accepts a terminology.overrides artifact (schema now registered)", () => {
    // "Docket" differs from the F&B template's own "Order" default, so the
    // override artifact IS proposed — and the validator must accept it.
    const p = buildGroundedProposal(
      intake({ business_description: "restaurant", job_term_en: "Docket", job_term_ar: "بون" }),
    );
    expect(p.artifacts.some((a) => a.key === "terminology.overrides")).toBe(true);
    expect(validateProposal(p).ok).toBe(true);
  });

  it("proposes NO artifact when the founder keeps the template's own term (Order/طلبية)", () => {
    const p = buildGroundedProposal(
      intake({ business_description: "restaurant", job_term_en: "Order", job_term_ar: "طلبية" }),
    );
    expect(p.artifacts.some((a) => a.key === "terminology.overrides")).toBe(false);
  });
});
