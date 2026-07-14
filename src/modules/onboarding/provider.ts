/**
 * S8 grounded proposal builder + provider seam (doc 11 S8; mirrors S7 getNarrationProvider).
 *
 * The proposal's CONFIG is produced DETERMINISTICALLY from the structured intake grounded on
 * template #1 — this path needs no AI provider at all, so onboarding always works (the manual
 * fallback, doc 11 "a validator around templates, not an agent"). An optional AI provider may
 * only enrich the human-readable summary/rationale prose; it can never change the config, the
 * approval defaults, or requires_upgrade — those come from the deterministic grounding and are
 * re-checked by validateProposal. `disabled` (prod default, no creds) === the deterministic
 * build. This makes `feat.ai_onboarding` genuinely free + always-on.
 */
import { TEMPLATE_BOATBUILDING } from "@/platform/config";
import { type OnboardingIntake, type ConfigProposal, APPROVAL_SUBJECTS } from "./proposal";

// Features available on every tier at this stage (release-gated, not tier-gated) — anything
// an operator requests outside this set is surfaced as requires_upgrade, never applied.
const ALWAYS_ON_FEATURES = new Set([
  "feat.ai_onboarding",
  "feat.ai_narration",
  "feat.ai_drafts",
  "feat.custom_fields",
  "feat.org_terminology_overrides",
  "feat.audit_export",
]);

const COUNTRY_LABEL: Record<string, { en: string; ar: string }> = {
  AE: { en: "United Arab Emirates", ar: "الإمارات العربية المتحدة" },
  SA: { en: "Saudi Arabia", ar: "المملكة العربية السعودية" },
  KW: { en: "Kuwait", ar: "الكويت" },
  BH: { en: "Bahrain", ar: "البحرين" },
  OM: { en: "Oman", ar: "عُمان" },
  QA: { en: "Qatar", ar: "قطر" },
};

/** Deterministic grounding: structured intake → a ConfigProposal over template #1. Pure. */
export function buildGroundedProposal(intake: OnboardingIntake): ConfigProposal {
  const c = COUNTRY_LABEL[intake.country] ?? { en: intake.country, ar: intake.country };
  const vatEn = intake.vat_registered ? "VAT-registered" : "not VAT-registered";
  const vatAr = intake.vat_registered ? "مسجّلة ضريبياً" : "غير مسجّلة ضريبياً";
  const week = intake.six_day_week ? "6-day" : "5-day";
  const weekAr = intake.six_day_week ? "٦ أيام" : "٥ أيام";

  // Approval defaults come straight from intake — if a value exceeds the F-28 cap the
  // validator REJECTS the proposal (the rejection-loop), it is never clamped here.
  const approval_defaults = APPROVAL_SUBJECTS.flatMap((s) => {
    const v = intake.approval_auto_approve_below[s];
    return v === undefined ? [] : [{ subject_type: s, auto_approve_below_minor: v }];
  });

  const requires_upgrade = [...new Set(intake.requested_features)].filter(
    (f) => !ALWAYS_ON_FEATURES.has(f),
  );

  return {
    template_key: TEMPLATE_BOATBUILDING.key,
    install_template: true,
    // The marine template already carries the full artifact bundle grounded on the org's
    // country/currency at install; onboarding adds approval defaults + a first job + the
    // checklist. No config-artifact OVERRIDE is proposed for the on-template marine case
    // (an operator edit could add one; the validator bounds it).
    artifacts: [],
    approval_defaults,
    requires_upgrade,
    intake_summary_en: `${intake.business_name} — a ${c.en} ${vatEn} marine/fabrication workshop on a ${week} working week, base currency ${intake.base_currency}, work items called "${intake.job_term_en}". Grounded on the boat-building template.`,
    intake_summary_ar: `${intake.business_name} — ورشة بحرية/تصنيع في ${c.ar}، ${vatAr}، أسبوع عمل ${weekAr}، العملة ${intake.base_currency}، تُسمّى وحدات العمل "${intake.job_term_ar}". مبنية على قالب بناء القوارب.`,
  };
}

export interface OnboardingProvider {
  readonly kind: "deterministic" | "disabled";
  propose(intake: OnboardingIntake): Promise<{ proposal: ConfigProposal; provider: string }>;
}

/** Deterministic provider — always available, no AI creds. */
const deterministicProvider: OnboardingProvider = {
  kind: "deterministic",
  async propose(intake) {
    return { proposal: buildGroundedProposal(intake), provider: "deterministic" };
  },
};

/**
 * Provider selection mirrors the narration seam: in production, without an AI onboarding
 * provider configured, onboarding runs on the deterministic grounding (which is the shipped
 * product). AI_ONBOARDING_PROVIDER may name a future enrichment provider off-prod.
 */
export function getOnboardingProvider(): OnboardingProvider {
  // No real LLM provider is wired yet; the deterministic build is the shipped path either way.
  // Kept as a seam so a future provider can enrich prose without touching config generation.
  return deterministicProvider;
}
