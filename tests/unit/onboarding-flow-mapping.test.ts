/**
 * U4 answers→classifier mapping — the questionnaire feeds the EXISTING
 * deterministic classifier (classify.ts is untouched; flow.ts only composes its
 * input text from the founder's own words + honest industry/pattern/capability
 * hints). Scenarios: the 8 canonical templates + mixed retail/service + mixed
 * manufacturing/service.
 */
import { describe, expect, it } from "vitest";
import {
  buildClassifierText,
  recommendationForDraft,
  DraftDataSchema,
  type DraftAnswers,
} from "@/modules/onboarding/flow";

function draftOf(answers: DraftAnswers) {
  return DraftDataSchema.parse({ answers });
}

function recommend(answers: DraftAnswers) {
  return recommendationForDraft(draftOf(answers));
}

const CANONICAL: Array<{ name: string; expected: string; answers: DraftAnswers }> = [
  {
    name: "marine / boatbuilding",
    expected: "boatbuilding_marine_v1",
    answers: {
      business_name: "Najola Marine",
      industry: "marine",
      business_description: "We build fibreglass boats and do hull repairs at our boatyard",
      work_patterns: ["project", "order"],
    },
  },
  {
    name: "manufacturing workshop",
    expected: "manufacturing_workshop_v1",
    answers: {
      business_name: "Steelcraft",
      industry: "manufacturing",
      business_description: "Steel fabrication and welding workshop, gates and railings",
      work_patterns: ["order"],
    },
  },
  {
    name: "field service business",
    expected: "service_business_v1",
    answers: {
      business_name: "Gulf Cooling",
      industry: "field_services",
      business_description: "AC maintenance and repair callouts, technician visits",
      work_patterns: ["service", "recurring"],
    },
  },
  {
    name: "construction contracting",
    expected: "construction_v1",
    answers: {
      business_name: "Bina Contracting",
      industry: "construction",
      business_description: "Villa construction and fit-out contracting, site works",
      work_patterns: ["project"],
    },
  },
  {
    name: "food & beverage",
    expected: "food_beverage_v1",
    answers: {
      business_name: "Zaad Kitchen",
      industry: "food_beverage",
      business_description: "Catering company preparing meals and running a cloud kitchen",
      work_patterns: ["order", "production"],
    },
  },
  {
    name: "online store",
    expected: "online_store_v1",
    answers: {
      business_name: "TechBay",
      industry: "retail_online",
      business_description: "Online store selling electronics and accessories with delivery",
      work_patterns: ["retail"],
    },
  },
  {
    name: "agriculture",
    expected: "agriculture_v1",
    answers: {
      business_name: "Green Oasis",
      industry: "agriculture",
      business_description: "Farm growing crops with irrigation and a small poultry unit",
      work_patterns: ["production"],
    },
  },
];

describe("canonical scenarios → the expected template", () => {
  for (const s of CANONICAL) {
    it(s.name, () => {
      const rec = recommend(s.answers);
      expect(rec.recommendedKey).toBe(s.expected);
      // The ranked list always carries every catalogue template (all reachable).
      expect(rec.ranked.map((m) => m.key)).toContain("generic_operations_v1");
      expect(rec.ranked.length).toBe(8);
    });
  }

  it("vague description with no industry signal falls back to Generic Operations", () => {
    const rec = recommend({
      business_name: "Al Amal",
      industry: "other",
      business_description: "We help local clients with various day to day needs",
    });
    expect(rec.recommendedKey).toBe("generic_operations_v1");
    expect(rec.confident).toBe(false); // the UI emphasises manual choice
  });

  it("industry answer alone (empty description) still yields a sensible match", () => {
    const rec = recommend({ business_name: "NoDesc", industry: "construction" });
    expect(rec.recommendedKey).toBe("construction_v1");
  });
});

describe("mixed scenarios", () => {
  it("mixed retail/service ranks both candidates at the top", () => {
    const rec = recommend({
      business_name: "PartsPro",
      industry: "other",
      business_description:
        "We sell spare parts from our online store and also do repair callouts and maintenance visits",
      work_patterns: ["retail", "service"],
    });
    const top3 = rec.ranked.slice(0, 3).map((m) => m.key);
    expect(top3).toContain("online_store_v1");
    expect(top3).toContain("service_business_v1");
    expect(["online_store_v1", "service_business_v1"]).toContain(rec.recommendedKey);
  });

  it("mixed manufacturing/service ranks both candidates at the top", () => {
    const rec = recommend({
      business_name: "FabriFix",
      industry: "other",
      business_description:
        "We fabricate steel structures in our workshop and also provide installation and maintenance service calls",
      work_patterns: ["order", "service"],
    });
    const top3 = rec.ranked.slice(0, 3).map((m) => m.key);
    expect(top3).toContain("manufacturing_workshop_v1");
    expect(top3).toContain("service_business_v1");
    expect(["manufacturing_workshop_v1", "service_business_v1"]).toContain(rec.recommendedKey);
  });
});

describe("classifier text composition", () => {
  it("the founder's own words come first; hints follow; capped at 600 chars", () => {
    const text = buildClassifierText({
      business_description: "we make custom furniture",
      workflow_description: "order comes in, we cut and assemble",
      industry: "manufacturing",
      work_patterns: ["order"],
      capabilities: ["inventory", "costing"],
    });
    expect(text.startsWith("we make custom furniture")).toBe(true);
    expect(text).toContain("manufacturing fabrication workshop"); // industry hint
    expect(text).toContain("made to order"); // pattern hint
    expect(text).toContain("inventory stock"); // capability hint
    expect(text.length).toBeLessThanOrEqual(600);
    const long = buildClassifierText({ business_description: "x".repeat(1000) as string });
    expect(long.length).toBeLessThanOrEqual(600);
  });

  it("empty answers compose to an empty text (generic fallback downstream)", () => {
    expect(buildClassifierText({})).toBe("");
  });
});
