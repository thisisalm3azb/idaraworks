/**
 * U4 pre-org onboarding flow — pure-half unit tests: the draft zod shape, the
 * question-level skip-logic matrix (SKIP-1…4), step gating/resume, the
 * draft→intake mapping (typed-vs-blank job-term law), the tier-selection
 * recording shape, and the review-summary builder (incl. monthly totals from
 * the real selection view).
 */
import { describe, expect, it } from "vitest";
import { buildSelectionView } from "@/modules/subscription/selection";
import {
  applyStepAnswers,
  askCollectsPayments,
  askDepartments,
  askMaterialsStep,
  askReceivesDeliveries,
  askTracksCosts,
  askUsersBand,
  askWorkflowDescription,
  buildReviewSummary,
  DraftDataSchema,
  draftToIntake,
  DraftIncompleteError,
  effectiveCustomerSharing,
  effectiveUsersBand,
  firstIncompleteStep,
  FlowValidationError,
  FLOW_STEPS,
  nextStepAfter,
  resolveStep,
  reviewMonthlyMinor,
  stepComplete,
  stepProgressPct,
  TierSelectionSchema,
  tierSettingValue,
  TIER_SETTING_KEY,
  visibleSteps,
  type DraftAnswers,
  type DraftData,
} from "@/modules/onboarding/flow";

const fullAnswers: DraftAnswers = {
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
  // H15 journey answers.
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

function fullDraft(): DraftData {
  return DraftDataSchema.parse({
    answers: fullAnswers,
    template: { selected_key: "service_business_v1", recommended_key: "service_business_v1" },
    tier: { mode: "tier_medium" },
    branding: { accent_color: "#0f766e", display_name: "Gulf Cooling" },
  });
}

describe("draft zod shape", () => {
  it("empty parse yields the defaulted skeleton", () => {
    const d = DraftDataSchema.parse({});
    expect(d.answers).toEqual({});
    expect(d.template).toEqual({});
    expect(d.branding).toEqual({});
    expect(d.confirm).toEqual({});
    expect(d.tier).toBeUndefined();
  });

  it("accepts a fully-populated valid draft", () => {
    expect(() => fullDraft()).not.toThrow();
  });

  it("rejects out-of-vocabulary answers and unknown keys (strict)", () => {
    expect(DraftDataSchema.safeParse({ answers: { industry: "spacecraft" } }).success).toBe(false);
    expect(DraftDataSchema.safeParse({ answers: { employees_band: "7" } }).success).toBe(false);
    expect(DraftDataSchema.safeParse({ answers: { smuggled: true } }).success).toBe(false);
    expect(DraftDataSchema.safeParse({ smuggled: true }).success).toBe(false);
  });

  it("branding accent colour must be a 6-digit hex", () => {
    expect(DraftDataSchema.safeParse({ branding: { accent_color: "red" } }).success).toBe(false);
    expect(DraftDataSchema.safeParse({ branding: { accent_color: "#0F766E" } }).success).toBe(true);
  });
});

describe("skip-logic matrix (SKIP-1..SKIP-4)", () => {
  it("SKIP-1: users band asked only above the smallest team band", () => {
    expect(askUsersBand({ employees_band: "1-5" })).toBe(false);
    expect(askUsersBand({ employees_band: "6-20" })).toBe(true);
    expect(askUsersBand({})).toBe(true); // unanswered = still shown
    expect(effectiveUsersBand({ employees_band: "1-5" })).toBe("1-3"); // derived, never stored
  });

  it("SKIP-2: departments asked only above the smallest team band", () => {
    expect(askDepartments({ employees_band: "1-5" })).toBe(false);
    expect(askDepartments({ employees_band: "21-50" })).toBe(true);
    expect(askDepartments({})).toBe(false); // nothing known yet
  });

  it("SKIP-3: workflow question only for patterns with a start-to-finish flow", () => {
    expect(askWorkflowDescription({ work_patterns: ["retail"] })).toBe(false);
    expect(askWorkflowDescription({ work_patterns: ["retail", "recurring"] })).toBe(false);
    expect(askWorkflowDescription({ work_patterns: ["service"] })).toBe(true);
    expect(askWorkflowDescription({ work_patterns: ["retail", "project"] })).toBe(true);
    expect(askWorkflowDescription({ work_patterns: [] })).toBe(false);
  });

  it("SKIP-5/6/7 + BRANCH-1: the H15 conditional questions", () => {
    // SKIP-5: deliveries only when materials are bought.
    expect(askReceivesDeliveries({ buys_materials: "yes" })).toBe(true);
    expect(askReceivesDeliveries({ buys_materials: "no" })).toBe(false);
    expect(askReceivesDeliveries({ buys_materials: "not_sure" })).toBe(false);
    // SKIP-6: payments only when invoices are sent.
    expect(askCollectsPayments({ sends_invoices: "yes" })).toBe(true);
    expect(askCollectsPayments({ sends_invoices: "not_sure" })).toBe(false);
    // SKIP-7: cost tracking only for engagement-style work.
    expect(askTracksCosts({ work_patterns: ["project"] })).toBe(true);
    expect(askTracksCosts({ work_patterns: ["retail"] })).toBe(false);
    // BRANCH-1: the materials STEP disappears for a consulting-shaped business.
    expect(askMaterialsStep({ industry: "other", work_patterns: ["service", "recurring"] })).toBe(
      false,
    );
    expect(askMaterialsStep({ industry: "construction" })).toBe(true);
    expect(askMaterialsStep({ industry: "other", work_patterns: ["order"] })).toBe(true);
    expect(visibleSteps({ industry: "other", work_patterns: ["service"] })).not.toContain(
      "materials",
    );
    expect(visibleSteps(fullAnswers)).toContain("materials");
    // Sharing is always asked; its safe default is false.
    expect(effectiveCustomerSharing({})).toBe(false);
  });

  it("applyStepAnswers drops answers a skip rule made irrelevant", () => {
    const base = DraftDataSchema.parse({ answers: fullAnswers });
    // Team shrinks to 1-5: users band + departments dropped even if submitted.
    const scaled = applyStepAnswers(base, "scale", {
      employees_band: "1-5",
      locations_band: "1",
      users_band: "26+",
      departments: ["sales"],
    });
    expect(scaled.answers.employees_band).toBe("1-5");
    expect(scaled.answers.users_band).toBeUndefined();
    expect(scaled.answers.departments).toBeUndefined();
    // Patterns become retail-only: the workflow answer is dropped.
    const worked = applyStepAnswers(base, "work", {
      work_patterns: ["retail"],
      workflow_description: "stale text",
    });
    expect(worked.answers.workflow_description).toBeUndefined();
    // BRANCH-1 re-evaluation: an industry-other business whose patterns turn
    // non-physical loses the retired materials answers (never kept as stale).
    const consulting = DraftDataSchema.parse({
      answers: { ...fullAnswers, industry: "other" },
    });
    const rebranched = applyStepAnswers(consulting, "work", { work_patterns: ["service"] });
    expect(rebranched.answers.buys_materials).toBeUndefined();
    expect(rebranched.answers.holds_stock).toBeUndefined();
    expect(rebranched.answers.receives_deliveries).toBeUndefined();
    // SKIP-6 consistency inside the money step: invoices "no" drops payments.
    const money = applyStepAnswers(base, "money", {
      sends_quotes: "yes",
      sends_invoices: "no",
      collects_payments: "yes",
      records_expenses: "yes",
      tracks_costs: "yes",
      vat_registered_q: "no",
    });
    expect(money.answers.collects_payments).toBeUndefined();
  });

  it("applyStepAnswers enforces conditionally-required fields", () => {
    const base = DraftDataSchema.parse({ answers: fullAnswers });
    // 6-20 team: users band required.
    expect(() =>
      applyStepAnswers(base, "scale", { employees_band: "6-20", locations_band: "1" }),
    ).toThrow(FlowValidationError);
    // Invoices sent: the payments answer is required.
    expect(() =>
      applyStepAnswers(base, "money", {
        sends_quotes: "yes",
        sends_invoices: "yes",
        records_expenses: "yes",
        tracks_costs: "yes",
        vat_registered_q: "no",
      }),
    ).toThrow(FlowValidationError);
    // Customers step: at least one customer type + the sharing answer.
    expect(() => applyStepAnswers(base, "customers", { customer_types: ["businesses"] })).toThrow(
      FlowValidationError,
    );
    // Work needs at least one pattern.
    expect(() => applyStepAnswers(base, "work", {})).toThrow(FlowValidationError);
  });
});

describe("step gating + resume", () => {
  it("an empty draft gates at the first questionnaire screen", () => {
    const d = DraftDataSchema.parse({});
    expect(firstIncompleteStep(d)).toBe("business");
    expect(resolveStep("review", d)).toBe("business"); // deep link clamped
    expect(resolveStep("welcome", d)).toBe("welcome");
  });

  it("a finished questionnaire gates at template until one is chosen", () => {
    const d = DraftDataSchema.parse({ answers: fullAnswers });
    expect(firstIncompleteStep(d)).toBe("template");
    expect(resolveStep("plan", d)).toBe("template");
    expect(resolveStep("scale", d)).toBe("scale"); // earlier steps stay reachable
  });

  it("template chosen but no tier gates at plan; full draft opens review", () => {
    const noTier = DraftDataSchema.parse({
      answers: fullAnswers,
      template: { selected_key: "service_business_v1" },
    });
    expect(firstIncompleteStep(noTier)).toBe("plan");
    expect(firstIncompleteStep(fullDraft())).toBe("review");
    expect(resolveStep("review", fullDraft())).toBe("review");
  });

  it("stepComplete / progress helpers agree with the registry (answers-aware)", () => {
    expect(FLOW_STEPS[0]).toBe("welcome");
    expect(nextStepAfter("welcome", fullAnswers)).toBe("business");
    expect(nextStepAfter("review", fullAnswers)).toBe("review"); // clamped at the end
    expect(stepProgressPct("welcome", fullAnswers)).toBe(0);
    expect(stepProgressPct("review", fullAnswers)).toBe(100);
    expect(stepComplete("branding", DraftDataSchema.parse({}))).toBe(true); // skippable
    // Branched navigation skips the hidden materials step in both directions.
    const consulting: DraftAnswers = { industry: "other", work_patterns: ["service"] };
    expect(nextStepAfter("scale", consulting)).toBe("money");
    expect(nextStepAfter("materials", consulting)).toBe("money"); // step itself hidden
  });
});

describe("draft → intake mapping (confirm-time pipeline input)", () => {
  it("maps a complete draft to a valid OnboardingIntake", () => {
    const intake = draftToIntake(fullDraft());
    expect(intake.business_name).toBe("Gulf Cooling");
    expect(intake.template_key).toBe("service_business_v1");
    expect(intake.country).toBe("AE");
    expect(intake.base_currency).toBe("AED");
    expect(intake.languages).toEqual(["en", "ar"]);
    // Not asked in this flow — honest defaults, editable later in Settings.
    expect(intake.six_day_week).toBe(false);
    expect(intake.vat_registered).toBe(false);
    expect(intake.approval_auto_approve_below).toEqual({});
    expect(intake.requested_features).toEqual([]);
  });

  it("typed-vs-blank job-term law: blank terms are OMITTED (template's own word stands)", () => {
    const blank = draftToIntake(fullDraft());
    expect(blank.job_term_en).toBeUndefined();
    expect(blank.job_term_ar).toBeUndefined();
    const typed = draftToIntake({
      ...fullDraft(),
      terms: { job_term_en: "Callout", job_term_ar: "بلاغ" },
    });
    expect(typed.job_term_en).toBe("Callout");
    expect(typed.job_term_ar).toBe("بلاغ");
  });

  it("arabic preferred language leads the languages array", () => {
    const d = fullDraft();
    d.answers = { ...d.answers, preferred_language: "ar" };
    expect(draftToIntake(d).languages).toEqual(["ar", "en"]);
  });

  it("throws DraftIncompleteError naming the missing fields", () => {
    const d = DraftDataSchema.parse({ answers: { business_name: "X" } });
    try {
      draftToIntake(d);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DraftIncompleteError);
      const missing = (err as DraftIncompleteError).missing;
      expect(missing).toContain("country");
      expect(missing).toContain("template");
    }
  });
});

describe("tier-selection recording shape", () => {
  it("schema accepts exactly the four modes and rejects junk", () => {
    expect(TierSelectionSchema.safeParse({ mode: "free" }).success).toBe(true);
    expect(TierSelectionSchema.safeParse({ mode: "tier_medium" }).success).toBe(true);
    expect(TierSelectionSchema.safeParse({ mode: "tier_high" }).success).toBe(true);
    expect(
      TierSelectionSchema.safeParse({
        mode: "custom",
        customKeys: ["addon.quotes_invoices"],
        quantities: { "addon.quotes_invoices": 1 },
      }).success,
    ).toBe(true);
    expect(TierSelectionSchema.safeParse({ mode: "platinum" }).success).toBe(false);
    expect(
      TierSelectionSchema.safeParse({ mode: "custom", customKeys: ["not-an-addon"] }).success,
    ).toBe(false);
    expect(
      TierSelectionSchema.safeParse({
        mode: "custom",
        quantities: { "addon.members_10": 0 },
      }).success,
    ).toBe(false);
  });

  it("tierSettingValue records the honest choice-only shape", () => {
    expect(TIER_SETTING_KEY).toBe("subscription.selected_tier");
    const free = tierSettingValue({ mode: "free" }, "2026-07-15T00:00:00.000Z");
    expect(free).toEqual({
      mode: "free",
      custom_keys: [],
      quantities: {},
      source: "onboarding",
      recorded_at: "2026-07-15T00:00:00.000Z",
      recorded_choice_only: true,
    });
    const custom = tierSettingValue(
      { mode: "custom", quantities: { "addon.members_10": 2, "addon.quotes_invoices": 1 } },
      "2026-07-15T00:00:00.000Z",
    );
    expect(custom.custom_keys.sort()).toEqual(["addon.members_10", "addon.quotes_invoices"]);
    expect(custom.quantities["addon.members_10"]).toBe(2);
    expect(custom.recorded_choice_only).toBe(true);
    // Tier modes never carry custom keys.
    const medium = tierSettingValue({ mode: "tier_medium" }, "2026-07-15T00:00:00.000Z");
    expect(medium.custom_keys).toEqual([]);
    expect(medium.quantities).toEqual({});
  });
});

describe("review-summary builder", () => {
  const view = buildSelectionView();

  it("tier monthly totals come from the real selection view", () => {
    expect(reviewMonthlyMinor({ mode: "free" }, view)).toEqual({ USD: 0, AED: 0 });
    expect(reviewMonthlyMinor({ mode: "tier_medium" }, view)).toEqual(
      view.medium.priceMonthlyMinor,
    );
    expect(reviewMonthlyMinor({ mode: "tier_high" }, view)).toEqual(view.high.priceMonthlyMinor);
    // Custom sums addon price × quantity from the same catalogue-backed view.
    const item = view.custom.groups.flatMap((g) => g.items).find((i) => i.selectable)!;
    const total = reviewMonthlyMinor({ mode: "custom", quantities: { [item.addon.key]: 2 } }, view);
    expect(total.USD).toBe(item.addon.usdMonthlyMinor * 2);
    expect(total.AED).toBe(item.addon.aedMonthlyMinor * 2);
    // Unknown keys contribute nothing (never a fabricated price).
    expect(reviewMonthlyMinor({ mode: "custom", quantities: { "addon.ghost": 3 } }, view)).toEqual({
      USD: 0,
      AED: 0,
    });
  });

  it("summarises business, template, tier and branding honestly", () => {
    const s = buildReviewSummary(fullDraft(), view);
    expect(s.business.name).toBe("Gulf Cooling");
    expect(s.business.currency).toBe("AED");
    expect(s.template.key).toBe("service_business_v1");
    expect(s.template.stageCount).toBeGreaterThan(0);
    expect(s.template.jobTermEn).toBe("Service Job"); // the template's own word
    expect(s.template.renamed).toBe(false);
    expect(s.tier.mode).toBe("tier_medium");
    expect(s.tier.monthlyMinor).toEqual(view.medium.priceMonthlyMinor);
    expect(s.branding.accentColor).toBe("#0f766e");
    expect(s.branding.skipped).toBe(false);
  });

  it("reflects a typed job term as a rename", () => {
    const d = fullDraft();
    d.terms = { job_term_en: "Callout" };
    const s = buildReviewSummary(d, view);
    expect(s.template.jobTermEn).toBe("Callout");
    expect(s.template.renamed).toBe(true);
  });

  it("branding skipped only counts when nothing was actually set", () => {
    const skipped = DraftDataSchema.parse({
      answers: fullAnswers,
      template: { selected_key: "service_business_v1" },
      tier: { mode: "free" },
      branding: { skipped: true },
    });
    expect(buildReviewSummary(skipped, view).branding.skipped).toBe(true);
    const skippedButSet = DraftDataSchema.parse({
      ...skipped,
      branding: { skipped: true, accent_color: "#1d4ed8" },
    });
    expect(buildReviewSummary(skippedButSet, view).branding.skipped).toBe(false);
  });

  it("display name falls back to the business name", () => {
    const s = buildReviewSummary(fullDraft(), view);
    expect(s.branding.displayName).toBe("Gulf Cooling");
  });
});
