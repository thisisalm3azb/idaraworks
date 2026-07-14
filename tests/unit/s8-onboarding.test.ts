/**
 * S8 Layer-A pure-unit coverage: the grounded proposal builder (deterministic, the manual
 * fallback) and the ConfigProposal validator (F-28 cap, no out-of-preset grants, referential
 * closure, rejection-loop). No DB.
 */
import { describe, it, expect } from "vitest";
import { buildGroundedProposal } from "@/modules/onboarding/provider";
import { validateProposal } from "@/modules/onboarding/validate";
import {
  OnboardingIntakeSchema,
  ConfigProposalSchema,
  TEMPLATE_APPROVAL_DEFAULT_MINOR,
  F28_CAP_MULTIPLE,
} from "@/modules/onboarding/proposal";

const baseIntake = OnboardingIntakeSchema.parse({
  business_name: "Gulf Marine",
  country: "AE",
  base_currency: "AED",
  languages: ["ar", "en"],
  six_day_week: true,
  vat_registered: true,
  job_term_en: "Boat",
  job_term_ar: "قارب",
  approval_auto_approve_below: { purchase_order: 400_000, material_request: 200_000 },
  requested_features: ["feat.ai_narration", "feat.sso"],
});

describe("buildGroundedProposal (deterministic manual fallback)", () => {
  it("is deterministic — same intake yields an identical proposal", () => {
    expect(buildGroundedProposal(baseIntake)).toEqual(buildGroundedProposal(baseIntake));
  });

  it("grounds on template #1, installs it, and carries the intake approval defaults", () => {
    const p = buildGroundedProposal(baseIntake);
    expect(p.template_key).toBe("boatbuilding_marine_v1");
    expect(p.install_template).toBe(true);
    expect(p.approval_defaults).toEqual([
      { subject_type: "purchase_order", auto_approve_below_minor: 400_000 },
      { subject_type: "material_request", auto_approve_below_minor: 200_000 },
    ]);
  });

  it("surfaces an out-of-plan requested feature as requires_upgrade (never applied)", () => {
    const p = buildGroundedProposal(baseIntake);
    expect(p.requires_upgrade).toContain("feat.sso"); // not in the always-on set
    expect(p.requires_upgrade).not.toContain("feat.ai_narration"); // always-on
  });

  it("produces a structurally valid proposal that passes the validator", () => {
    const p = buildGroundedProposal(baseIntake);
    expect(ConfigProposalSchema.safeParse(p).success).toBe(true);
    expect(validateProposal(p).ok).toBe(true);
  });
});

describe("validateProposal — F-28 auto-approve cap (reject, never clamp)", () => {
  it("rejects a purchase_order auto-approve above 2× the template default", () => {
    const overCap = TEMPLATE_APPROVAL_DEFAULT_MINOR.purchase_order * F28_CAP_MULTIPLE + 1;
    const intake = OnboardingIntakeSchema.parse({
      ...baseIntake,
      approval_auto_approve_below: { purchase_order: overCap },
    });
    // The rejection-loop: the builder passes the intake value through; the validator rejects.
    const p = buildGroundedProposal(intake);
    const v = validateProposal(p);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/F-28 cap/);
  });

  it("accepts exactly at the cap (2×)", () => {
    const atCap = TEMPLATE_APPROVAL_DEFAULT_MINOR.material_request * F28_CAP_MULTIPLE;
    const p = buildGroundedProposal(
      OnboardingIntakeSchema.parse({
        ...baseIntake,
        approval_auto_approve_below: { material_request: atCap },
      }),
    );
    expect(validateProposal(p).ok).toBe(true);
  });
});

describe("validateProposal — proposal-level safety rules", () => {
  it("rejects a config.roles artifact that grants an action beyond the template presets", () => {
    const p = buildGroundedProposal(baseIntake);
    const bad = {
      ...p,
      artifacts: [
        {
          key: "config.roles",
          value: { roles: [{ key: "manager", actions: ["members.deactivate"] }] },
          rationale_en: "x",
          rationale_ar: "س",
        },
      ],
    };
    const v = validateProposal(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/beyond the template preset bounds/);
  });

  it("rejects a duplicate artifact key", () => {
    const p = buildGroundedProposal(baseIntake);
    const dup = {
      ...p,
      artifacts: [
        { key: "config.reference_patterns", value: {}, rationale_en: "a", rationale_ar: "ا" },
        { key: "config.reference_patterns", value: {}, rationale_en: "b", rationale_ar: "ب" },
      ],
    };
    expect(validateProposal(dup).ok).toBe(false);
  });

  it("rejects a malformed proposal object outright", () => {
    expect(validateProposal({ nonsense: true }).ok).toBe(false);
  });
});
