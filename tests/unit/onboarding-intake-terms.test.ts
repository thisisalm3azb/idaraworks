/**
 * Onboarding intake honesty (review fixes):
 *  - Job terms are OPTIONAL. Blank terms → the template's own term stands: NO
 *    terminology.overrides artifact, and no prose claiming the founder "chose" a name.
 *  - A TYPED term differing from the template's own → an artifact carrying exactly
 *    the typed values.
 *  - A typed term EQUAL to the template's own → no artifact (nothing to override).
 *  - ALWAYS_ON_FEATURES must be a subset of the FREE plan's enabled feature set
 *    (supabase/migrations/0065_addon_model.sql) so requires_upgrade never under-reports.
 */
import { describe, expect, it } from "vitest";
import { ALWAYS_ON_FEATURES, buildGroundedProposal } from "@/modules/onboarding/provider";
import { validateProposal } from "@/modules/onboarding/validate";
import { OnboardingIntakeSchema, type OnboardingIntake } from "@/modules/onboarding/proposal";

function intake(over: Partial<OnboardingIntake> = {}): OnboardingIntake {
  return OnboardingIntakeSchema.parse({
    business_name: "Test Co",
    business_description: "we are a boatyard building fiberglass skiffs",
    country: "AE",
    base_currency: "AED",
    languages: ["en", "ar"],
    six_day_week: true,
    vat_registered: true,
    ...over,
  });
}

const TERM_ARTIFACT = "terminology.overrides";

describe("blank job terms — the template's own term stands", () => {
  it("intake schema accepts absent job terms", () => {
    const i = intake(); // no job_term_en / job_term_ar at all
    expect(i.job_term_en).toBeUndefined();
    expect(i.job_term_ar).toBeUndefined();
  });

  it("emits NO terminology.overrides artifact", () => {
    const p = buildGroundedProposal(intake());
    expect(p.template_key).toBe("boatbuilding_marine_v1");
    expect(p.artifacts.some((a) => a.key === TERM_ARTIFACT)).toBe(false);
    expect(validateProposal(p).ok).toBe(true);
  });

  it("the prose never claims the founder chose a name", () => {
    const p = buildGroundedProposal(intake());
    expect(p.intake_summary_en).not.toMatch(/you chose|chose to call/i);
    expect(p.intake_summary_ar).not.toContain("اخترت");
    // It states the honest fact instead: the template's own term stands.
    expect(p.intake_summary_en).toContain("template's own term");
    for (const a of p.artifacts) {
      expect(a.rationale_en).not.toMatch(/you chose/i);
      expect(a.rationale_ar).not.toContain("اخترت");
    }
  });
});

describe("typed job terms — applied exactly, only when they differ", () => {
  it("a typed term differing from the template's own → artifact with exactly the typed values", () => {
    const p = buildGroundedProposal(intake({ job_term_en: "Vessel", job_term_ar: "سفينة" }));
    const art = p.artifacts.find((a) => a.key === TERM_ARTIFACT);
    expect(art).toBeDefined();
    const v = art!.value as {
      job: { en: { singular: string; plural: string }; ar: { singular: string } };
    };
    expect(v.job.en.singular).toBe("Vessel");
    expect(v.job.en.plural).toBe("Vessels");
    expect(v.job.ar.singular).toBe("سفينة");
    // The rationale MAY claim a choice here — the founder actually made one.
    expect(art!.rationale_en).toContain('"Vessel"');
    expect(p.intake_summary_en).toContain('"Vessel"');
    expect(validateProposal(p).ok).toBe(true);
  });

  it("a typed term EQUAL to the template's own → no artifact (boatbuilding: Boat/قارب)", () => {
    const p = buildGroundedProposal(intake({ job_term_en: "Boat", job_term_ar: "قارب" }));
    expect(p.template_key).toBe("boatbuilding_marine_v1");
    expect(p.artifacts.some((a) => a.key === TERM_ARTIFACT)).toBe(false);
  });
});

describe("ALWAYS_ON_FEATURES ⊆ the 0065 free-plan enabled set", () => {
  // Hardcoded from supabase/migrations/0065_addon_model.sql — the free-plan
  // plan_entitlement seed (§2 "Free FEATURES"): the entitlement keys inserted
  // with enabled=true for plan 'free'. If 0065's successor reseeds the free
  // plan, update BOTH this set and ALWAYS_ON_FEATURES in provider.ts.
  const FREE_PLAN_ENABLED = new Set([
    "cap.jobs",
    "cap.daily_reports",
    "cap.issues",
    "cap.customers",
    "cap.people",
    "feat.ai_onboarding",
    "feat.ai_drafts",
    "feat.custom_fields",
    "feat.org_terminology_overrides",
  ]);

  it("every always-on key is enabled on the free plan (no under-reported upgrades)", () => {
    for (const key of ALWAYS_ON_FEATURES) {
      expect(FREE_PLAN_ENABLED.has(key), `${key} is not free-plan-enabled per 0065`).toBe(true);
    }
  });

  it("a feature outside the free set is surfaced as requires_upgrade", () => {
    const p = buildGroundedProposal(
      intake({ requested_features: ["feat.ai_narration", "feat.audit_export", "feat.ai_drafts"] }),
    );
    expect(p.requires_upgrade).toContain("feat.ai_narration");
    expect(p.requires_upgrade).toContain("feat.audit_export");
    expect(p.requires_upgrade).not.toContain("feat.ai_drafts");
  });
});
