/**
 * The short onboarding flow, pure half: the draft zod shape (strict, and still
 * accepting every answer the long journey stored), the four-screen registry
 * and its progress model, what each screen writes, what a setup card implies
 * (and never overwrites), the priorities mapping, gating and resume for new
 * and older drafts, the draft→intake mapping (typed-vs-blank job-term law),
 * the tier-recording shape, and the review-summary builder.
 */
import { describe, expect, it } from "vitest";
import { buildSelectionView } from "@/modules/subscription/selection";
import {
  applyPriorities,
  applySetupChoice,
  applyStepAnswers,
  askCollectsPayments,
  askMaterialsStep,
  askTracksCosts,
  buildReviewSummary,
  DraftDataSchema,
  draftToIntake,
  DraftIncompleteError,
  effectiveCustomerSharing,
  effectiveUsersBand,
  firstIncompleteStep,
  FlowValidationError,
  FLOW_STEPS,
  impliedAnswersFor,
  nextStepAfter,
  prevStepBefore,
  PRIORITY_AREAS,
  PRIORITY_AREA_FOCUS,
  resolveStep,
  reviewMonthlyMinor,
  stepComplete,
  stepNumberOf,
  stepProgressPct,
  TEMPLATE_INDUSTRY,
  TierSelectionSchema,
  tierSettingValue,
  TIER_SETTING_KEY,
  visibleSteps,
  type DraftAnswers,
  type DraftData,
} from "@/modules/onboarding/flow";
import { getCatalogueEntry, TEMPLATES } from "@/platform/config";

/** Every answer the long journey (versions 1 and 2) could store. */
const legacyAnswers: DraftAnswers = {
  business_name: "Gulf Cooling",
  legal_name: "Gulf Cooling Technical Services LLC",
  industry: "field_services",
  business_description: "AC maintenance and repair callouts for villas",
  country: "AE",
  timezone: "Asia/Dubai",
  base_currency: "AED",
  preferred_language: "en",
  employees_band: "6-20",
  users_band: "4-10",
  locations_band: "1",
  departments: ["operations", "field_teams"],
  work_patterns: ["service"],
  work_intake: ["phone_whatsapp", "referrals"],
  workflow_description: "customer calls, we visit, quote, fix, invoice",
  capabilities: ["quotes", "invoices", "daily_reports"],
  device: "both",
  customer_sharing: true,
  main_problem: "updates scattered across chats",
  customer_types: ["businesses", "consumers"],
  revenue_models: ["fixed_price"],
  buys_materials: "yes",
  holds_stock: "no",
  receives_deliveries: "yes",
  sends_quotes: "yes",
  sends_invoices: "yes",
  collects_payments: "yes",
  records_expenses: "yes",
  tracks_costs: "yes",
  vat_registered_q: "no",
  priority_focus: "delivery",
};

function legacyDraft(): DraftData {
  return DraftDataSchema.parse({
    answers: legacyAnswers,
    template: { selected_key: "service_business_v1", recommended_key: "service_business_v1" },
    tier: { mode: "tier_medium" },
    branding: { accent_color: "#0f766e", display_name: "Gulf Cooling" },
  });
}

/** A draft produced by the short flow only. */
function shortDraft(): DraftData {
  let d = DraftDataSchema.parse({});
  d = applyStepAnswers(d, "business", {
    business_name: "Sidra Farms",
    country: "SA",
    preferred_language: "ar",
  });
  d = applySetupChoice(d, "agriculture_v1");
  d = applyStepAnswers(d, "priorities", { priorities: ["work", "money"], employees_band: "6-20" });
  return d;
}

describe("draft zod shape", () => {
  it("empty parse yields the defaulted skeleton", () => {
    const d = DraftDataSchema.parse({});
    expect(d.answers).toEqual({});
    expect(d.template).toEqual({});
    expect(d.tier).toBeUndefined();
    expect(d.branding).toEqual({});
    expect(d.confirm).toEqual({});
  });

  it("accepts a fully-populated legacy draft unchanged (older founders keep their answers)", () => {
    expect(() => legacyDraft()).not.toThrow();
    expect(legacyDraft().answers.customer_types).toEqual(["businesses", "consumers"]);
  });

  it("rejects out-of-vocabulary answers and unknown keys (strict)", () => {
    expect(() => DraftDataSchema.parse({ answers: { priorities: ["fame"] } })).toThrow();
    expect(() => DraftDataSchema.parse({ answers: { role: "owner" } })).toThrow();
    expect(() => DraftDataSchema.parse({ answers: { country: "US" } })).toThrow();
  });

  it("branding accent colour must be a 6-digit hex", () => {
    expect(() => DraftDataSchema.parse({ branding: { accent_color: "red" } })).toThrow();
    expect(
      DraftDataSchema.parse({ branding: { accent_color: "#0f766e" } }).branding.accent_color,
    ).toBe("#0f766e");
  });
});

describe("four screens, one progress model", () => {
  it("the registry is business → setup → priorities → ready, never branching", () => {
    expect(FLOW_STEPS).toEqual(["business", "setup", "priorities", "ready"]);
    expect(visibleSteps({})).toEqual([...FLOW_STEPS]);
    expect(visibleSteps(legacyAnswers)).toEqual([...FLOW_STEPS]);
    expect(nextStepAfter("business", {})).toBe("setup");
    expect(nextStepAfter("ready", {})).toBe("ready");
    expect(prevStepBefore("business", {})).toBe("business");
    expect(prevStepBefore("ready", {})).toBe("priorities");
  });

  it("Step X of 4 and a bar that reaches 100% on the last screen", () => {
    expect(stepNumberOf("business", {})).toEqual({ current: 1, total: 4 });
    expect(stepNumberOf("ready", {})).toEqual({ current: 4, total: 4 });
    expect([stepProgressPct("business", {}), stepProgressPct("ready", {})]).toEqual([25, 100]);
  });
});

describe("screen 1 — your business", () => {
  it("stores name, country and language, and derives timezone and currency from the country", () => {
    const d = applyStepAnswers(DraftDataSchema.parse({}), "business", {
      business_name: "  Sidra Farms ",
      country: "QA",
      preferred_language: "en",
    });
    expect(d.answers.business_name).toBe("Sidra Farms");
    expect(d.answers.country).toBe("QA");
    expect(d.answers.timezone).toBe("Asia/Qatar");
    expect(d.answers.base_currency).toBe("QAR");
  });

  it("a country change re-derives the defaults; a typed value for the same country stays", () => {
    const typed = DraftDataSchema.parse({
      answers: { country: "AE", timezone: "Asia/Dubai", base_currency: "USD" },
    });
    const same = applyStepAnswers(typed, "business", {
      business_name: "X",
      country: "AE",
      preferred_language: "en",
    });
    expect(same.answers.base_currency).toBe("USD");
    const moved = applyStepAnswers(typed, "business", {
      business_name: "X",
      country: "OM",
      preferred_language: "en",
    });
    expect(moved.answers.base_currency).toBe("OMR");
    expect(moved.answers.timezone).toBe("Asia/Muscat");
  });

  it("names every missing required field", () => {
    try {
      applyStepAnswers(DraftDataSchema.parse({}), "business", { business_name: "X" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FlowValidationError);
      expect((e as FlowValidationError).fields).toEqual(["country", "preferred_language"]);
    }
  });

  it("the ready screen takes no answers", () => {
    expect(() => applyStepAnswers(DraftDataSchema.parse({}), "ready", {})).toThrow(
      FlowValidationError,
    );
  });
});

describe("screen 2 — how you work (a template implies the usual answers)", () => {
  it("every template has an industry and implies a coherent answer set", () => {
    for (const key of Object.keys(TEMPLATES)) {
      expect(TEMPLATE_INDUSTRY[key], `${key} needs an industry`).toBeTruthy();
      const implied = impliedAnswersFor(key);
      expect(implied.industry).toBe(TEMPLATE_INDUSTRY[key]);
      expect(implied.work_patterns!.length).toBeGreaterThan(0);
      // Nothing consequential is invented.
      expect(implied.vat_registered_q).toBe("not_sure");
      expect(implied.customer_sharing).toBe(false);
    }
    expect(impliedAnswersFor("no_such_template")).toEqual({});
  });

  it("quoting and invoicing follow each card's own enabled modules; absent ones stay unsure", () => {
    for (const key of Object.keys(TEMPLATES)) {
      const enabled = new Set(getCatalogueEntry(key)!.enabledModules as readonly string[]);
      const implied = impliedAnswersFor(key);
      expect(implied.sends_quotes).toBe(enabled.has("cap.quoting") ? "yes" : "no");
      expect(implied.sends_invoices).toBe(enabled.has("cap.invoicing") ? "yes" : "not_sure");
      if (!enabled.has("cap.invoicing")) expect(implied.collects_payments).toBeUndefined();
    }
  });

  it("applies the template and the implied answers, and rejects an unknown card", () => {
    const d = applySetupChoice(DraftDataSchema.parse({}), "construction_v1");
    expect(d.template.selected_key).toBe("construction_v1");
    expect(d.template.manual).toBe(true);
    expect(d.answers.industry).toBe("construction");
    expect(d.answers.work_patterns).toEqual(["project"]);
    expect(askMaterialsStep(d.answers)).toBe(true);
    expect(() => applySetupChoice(DraftDataSchema.parse({}), "ghost_v9")).toThrow(
      FlowValidationError,
    );
  });

  it("never overwrites an answer an older draft already gave", () => {
    const d = applySetupChoice(legacyDraft(), "service_business_v1");
    expect(d.answers.vat_registered_q).toBe("no");
    expect(d.answers.holds_stock).toBe("no");
    expect(d.answers.customer_types).toEqual(["businesses", "consumers"]);
    expect(d.answers.employees_band).toBe("6-20");
  });

  it("choosing a different card re-derives only the card-owned answers", () => {
    const first = applySetupChoice(DraftDataSchema.parse({}), "construction_v1");
    const second = applySetupChoice(first, "online_store_v1");
    expect(second.answers.industry).toBe("retail_ecommerce");
    expect(second.answers.work_patterns).toEqual(["order", "retail"]);
    expect(second.answers.vat_registered_q).toBe("not_sure");
  });
});

describe("screen 3 — what matters now", () => {
  it("maps the chips onto the dashboard focus and the capability answers", () => {
    const a = applyPriorities({}, ["money", "stock"]);
    expect(a.priorities).toEqual(["money", "stock"]);
    expect(a.priority_focus).toBe(PRIORITY_AREA_FOCUS.money);
    expect(a.sends_invoices).toBe("yes");
    expect(a.collects_payments).toBe("yes");
    expect(a.records_expenses).toBe("yes");
    expect(a.holds_stock).toBe("yes");
    for (const area of PRIORITY_AREAS) expect(PRIORITY_AREA_FOCUS[area]).toBeTruthy();
  });

  it("an empty choice keeps an existing focus or falls back to delivery", () => {
    expect(applyPriorities({}, []).priority_focus).toBe("delivery");
    expect(applyPriorities({ priority_focus: "team" }, []).priority_focus).toBe("team");
  });

  it("the screen submit stores the chips and a team size, defaulting to the smallest", () => {
    const d = applyStepAnswers(DraftDataSchema.parse({}), "priorities", { priorities: ["work"] });
    expect(d.answers.priorities).toEqual(["work"]);
    expect(d.answers.employees_band).toBe("1-5");
    const sized = applyStepAnswers(d, "priorities", { priorities: [], employees_band: "21-50" });
    expect(sized.answers.employees_band).toBe("21-50");
    expect(sized.answers.priorities).toEqual([]);
    expect(() =>
      applyStepAnswers(DraftDataSchema.parse({}), "priorities", { employees_band: "lots" }),
    ).toThrow();
  });
});

describe("gating + resume", () => {
  it("an empty draft gates at the first screen; each screen unlocks the next", () => {
    const empty = DraftDataSchema.parse({});
    expect(firstIncompleteStep(empty)).toBe("business");
    expect(resolveStep("ready", empty)).toBe("business");
    const named = applyStepAnswers(empty, "business", {
      business_name: "X",
      country: "AE",
      preferred_language: "en",
    });
    expect(firstIncompleteStep(named)).toBe("setup");
    expect(resolveStep("priorities", named)).toBe("setup");
    const chosen = applySetupChoice(named, "generic_operations_v1");
    // Priorities are optional: the ready screen is reachable straight away.
    expect(firstIncompleteStep(chosen)).toBe("ready");
    expect(resolveStep("priorities", chosen)).toBe("priorities");
    expect(resolveStep("ready", chosen)).toBe("ready");
    expect(stepComplete("priorities", chosen)).toBe(true);
  });

  it("an older draft resumes at the first screen it still lacks, keeping its answers", () => {
    const old = legacyDraft();
    expect(firstIncompleteStep(old)).toBe("ready");
    // Unknown step names from the long journey (region, money, review…) clamp.
    expect(resolveStep("review", old)).toBe("ready");
    expect(resolveStep("money", old)).toBe("ready");
    const partial = DraftDataSchema.parse({
      answers: { business_name: "Old", industry: "marine" },
    });
    expect(resolveStep("region", partial)).toBe("business");
  });

  it("the legacy skip helpers still answer for the engine and the configuration screens", () => {
    expect(askCollectsPayments({ sends_invoices: "yes" })).toBe(true);
    expect(askTracksCosts({ work_patterns: ["retail"] })).toBe(false);
    expect(effectiveUsersBand({ employees_band: "1-5" })).toBe("1-3");
    expect(effectiveCustomerSharing({})).toBe(false);
  });
});

describe("draft → intake mapping (confirm-time pipeline input)", () => {
  it("maps a short-flow draft to a valid OnboardingIntake with derived currency", () => {
    const intake = draftToIntake(shortDraft());
    expect(intake.business_name).toBe("Sidra Farms");
    expect(intake.template_key).toBe("agriculture_v1");
    expect(intake.country).toBe("SA");
    expect(intake.base_currency).toBe("SAR");
    expect(intake.languages[0]).toBe("ar");
    expect(intake.vat_registered).toBe(false);
    expect(intake.job_term_en).toBeUndefined();
  });

  it("typed-vs-blank job-term law: blank terms are OMITTED (template's own word stands)", () => {
    const d = shortDraft();
    d.terms = { job_term_en: "  ", job_term_ar: "" };
    expect(draftToIntake(d).job_term_en).toBeUndefined();
    d.terms = { job_term_en: "Season" };
    expect(draftToIntake(d).job_term_en).toBe("Season");
  });

  it("throws DraftIncompleteError naming the missing fields", () => {
    try {
      draftToIntake(DraftDataSchema.parse({ answers: { business_name: "X" } }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DraftIncompleteError);
      expect((e as DraftIncompleteError).missing).toEqual([
        "country",
        "base_currency",
        "preferred_language",
        "template",
      ]);
    }
  });
});

describe("tier-selection recording shape", () => {
  it("schema accepts exactly the four modes and rejects junk", () => {
    for (const mode of ["free", "tier_medium", "tier_high"]) {
      expect(TierSelectionSchema.safeParse({ mode }).success).toBe(true);
    }
    expect(
      TierSelectionSchema.safeParse({ mode: "custom", quantities: { "addon.x": 1 } }).success,
    ).toBe(true);
    expect(TierSelectionSchema.safeParse({ mode: "enterprise" }).success).toBe(false);
  });

  it("tierSettingValue records the honest choice-only shape", () => {
    const v = tierSettingValue({ mode: "free" }, "2026-09-20T00:00:00Z");
    expect(v).toEqual({
      mode: "free",
      custom_keys: [],
      quantities: {},
      source: "onboarding",
      recorded_at: "2026-09-20T00:00:00Z",
      recorded_choice_only: true,
    });
    expect(TIER_SETTING_KEY).toBe("subscription.selected_tier");
  });
});

describe("review-summary builder", () => {
  const view = buildSelectionView();

  it("tier monthly totals come from the real selection view", () => {
    expect(reviewMonthlyMinor({ mode: "free" }, view)).toEqual({ USD: 0, AED: 0 });
    expect(reviewMonthlyMinor({ mode: "tier_medium" }, view)).toEqual(
      view.medium.priceMonthlyMinor,
    );
    expect(reviewMonthlyMinor({ mode: "custom", quantities: { "addon.ghost": 3 } }, view)).toEqual({
      USD: 0,
      AED: 0,
    });
  });

  it("summarises business, template, tier and branding honestly", () => {
    const s = buildReviewSummary(legacyDraft(), view);
    expect(s.business.name).toBe("Gulf Cooling");
    expect(s.business.currency).toBe("AED");
    expect(s.template.key).toBe("service_business_v1");
    expect(s.template.stageCount).toBeGreaterThan(0);
    expect(s.template.jobTermEn).toBe("Service Job");
    expect(s.template.renamed).toBe(false);
    expect(s.tier.mode).toBe("tier_medium");
    expect(s.branding.skipped).toBe(false);
  });

  it("a short-flow draft summarises with the free tier and no branding", () => {
    const s = buildReviewSummary({ ...shortDraft(), tier: { mode: "free" } }, view);
    expect(s.business.name).toBe("Sidra Farms");
    expect(s.template.key).toBe("agriculture_v1");
    expect(s.tier.mode).toBe("free");
    expect(s.branding.displayName).toBe("Sidra Farms");
  });
});
