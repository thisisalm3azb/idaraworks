/**
 * Grounded proposal builder + provider seam (S8, extended by the post-MVP
 * template catalogue; mirrors S7 getNarrationProvider).
 *
 * The proposal's CONFIG is produced DETERMINISTICALLY: the founder's free-text
 * business description is scored by the transparent classifier (classify.ts)
 * against the template catalogue — or an explicit intake.template_key wins —
 * and the proposal grounds on THAT template, carrying the recommendation
 * reason, the scored alternatives, and (when the founder renamed the core job
 * term) a terminology.overrides artifact so the chosen words are actually
 * APPLIED, not just echoed. This path needs no AI provider at all (the manual
 * fallback IS the shipped path). An optional AI provider may only enrich the
 * human-readable prose; it can never change the config, the approval defaults,
 * or requires_upgrade — everything is re-checked by validateProposal.
 */
import { TEMPLATES, getCatalogueEntry } from "@/platform/config";
import { classifyBusiness, GENERIC_TEMPLATE_KEY } from "./classify";
import {
  type OnboardingIntake,
  type ConfigProposal,
  type ProposalArtifact,
  APPROVAL_SUBJECTS,
} from "./proposal";

// Features enabled on EVERY plan — i.e. exactly the FREE plan's enabled feature set,
// mirroring the free-plan plan_entitlement seed in supabase/migrations/0065_addon_model.sql
// (0065 seeds every entitlement_def of kind 'feature' for 'free', enabled only for this
// list). Anything an operator requests outside this set is surfaced as requires_upgrade,
// never applied — so this set must NEVER over-claim (an extra key here under-reports
// requires_upgrade). Keep in sync with 0065 / later plan reseeds; guarded by
// tests/unit/onboarding-intake-terms.test.ts.
export const ALWAYS_ON_FEATURES = new Set([
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

const COUNTRY_LABEL: Record<string, { en: string; ar: string }> = {
  AE: { en: "United Arab Emirates", ar: "الإمارات العربية المتحدة" },
  SA: { en: "Saudi Arabia", ar: "المملكة العربية السعودية" },
  KW: { en: "Kuwait", ar: "الكويت" },
  BH: { en: "Bahrain", ar: "البحرين" },
  OM: { en: "Oman", ar: "عُمان" },
  QA: { en: "قطر" === "قطر" ? "Qatar" : "Qatar", ar: "قطر" },
};

/** Naive english pluralisation for a founder-typed job term (editable later in Settings). */
function pluralizeEn(term: string): string {
  if (/(s|x|z|ch|sh)$/i.test(term)) return `${term}es`;
  if (/[^aeiou]y$/i.test(term)) return `${term.slice(0, -1)}ies`;
  return `${term}s`;
}

/**
 * Template selection: explicit intake.template_key wins (manual choice);
 * otherwise the deterministic classifier over business_description (+ name).
 */
export function selectTemplate(intake: OnboardingIntake): {
  key: string;
  reasonEn: string;
  reasonAr: string;
  alternatives: ConfigProposal["template_alternatives"];
  confident: boolean;
} {
  const text = `${intake.business_description} ${intake.business_name}`.trim();
  const result = classifyBusiness(text);

  const manual = intake.template_key && intake.template_key in TEMPLATES;
  const key = manual ? intake.template_key! : result.recommendedKey;

  const alternatives = result.ranked
    .filter((m) => m.key !== key)
    .map((m) => {
      const e = getCatalogueEntry(m.key);
      return {
        key: m.key,
        score: m.score,
        name_en: e?.names.en ?? m.key,
        name_ar: e?.names.ar ?? m.key,
      };
    });

  if (manual) {
    return {
      key,
      reasonEn: "You selected this template yourself.",
      reasonAr: "اخترت هذا القالب بنفسك.",
      alternatives,
      confident: true,
    };
  }

  const top = result.ranked.find((m) => m.key === key);
  const signals = [...(top?.matchedKeywords ?? []), ...(top?.matchedPhrases ?? [])].slice(0, 5);
  if (key === GENERIC_TEMPLATE_KEY || !top || signals.length === 0) {
    return {
      key: GENERIC_TEMPLATE_KEY,
      reasonEn:
        "No specific industry template clearly matched your description, so the neutral Generic Operations template is recommended. You can pick any template below.",
      reasonAr:
        "لم يتطابق وصف نشاطك بوضوح مع قالب صناعي محدد، لذلك نُرشّح قالب العمليات العامة المحايد. يمكنك اختيار أي قالب آخر أدناه.",
      alternatives,
      confident: false,
    };
  }
  return {
    key,
    reasonEn: `Your description matched this template's signals: ${signals.join(", ")}.`,
    reasonAr: `تطابق وصف نشاطك مع مؤشرات هذا القالب: ${signals.join("، ")}.`,
    alternatives,
    confident: result.confident,
  };
}

/** Deterministic grounding: structured intake → a ConfigProposal over the selected template. Pure. */
export function buildGroundedProposal(intake: OnboardingIntake): ConfigProposal {
  const c = COUNTRY_LABEL[intake.country] ?? { en: intake.country, ar: intake.country };
  const vatEn = intake.vat_registered ? "VAT-registered" : "not VAT-registered";
  const vatAr = intake.vat_registered ? "مسجّلة ضريبياً" : "غير مسجّلة ضريبياً";
  const week = intake.six_day_week ? "6-day" : "5-day";
  const weekAr = intake.six_day_week ? "٦ أيام" : "٥ أيام";

  const selected = selectTemplate(intake);
  const manifest = TEMPLATES[selected.key];
  const entry = getCatalogueEntry(selected.key);
  const templateNameEn = entry?.names.en ?? selected.key;
  const templateNameAr = entry?.names.ar ?? selected.key;

  // Approval defaults come straight from intake — if a value exceeds the F-28 cap the
  // validator REJECTS the proposal (the rejection-loop), it is never clamped here.
  const approval_defaults = APPROVAL_SUBJECTS.flatMap((s) => {
    const v = intake.approval_auto_approve_below[s];
    return v === undefined ? [] : [{ subject_type: s, auto_approve_below_minor: v }];
  });

  const requires_upgrade = [...new Set(intake.requested_features)].filter(
    (f) => !ALWAYS_ON_FEATURES.has(f),
  );

  // Terminology: ONLY when the founder actually TYPED a job term that differs from the
  // template's own do we propose a terminology.overrides artifact (so the chosen words are
  // APPLIED, not just echoed). Blank intake terms mean the template's own term stands —
  // no artifact, and no prose claiming the founder "chose" anything (review fix: the intake
  // form previously defaulted to a domain word and installed it into every org).
  const artifacts: ProposalArtifact[] = [];
  const templateJobEn = manifest?.terminology?.job?.en?.singular ?? "Job";
  const templateJobAr = manifest?.terminology?.job?.ar?.singular ?? "مهمة";
  const typedEn = intake.job_term_en?.trim() || undefined;
  const typedAr = intake.job_term_ar?.trim() || undefined;
  const founderRenamed = Boolean(
    (typedEn && typedEn !== templateJobEn) || (typedAr && typedAr !== templateJobAr),
  );
  const effJobEn = typedEn ?? templateJobEn;
  const effJobAr = typedAr ?? templateJobAr;
  if (manifest && founderRenamed) {
    artifacts.push({
      key: "terminology.overrides",
      value: {
        job: {
          en: { singular: effJobEn, plural: pluralizeEn(effJobEn) },
          // Arabic plurals are irregular — reuse the founder's term and let them
          // refine the plural in Settings → Configuration (editable any time).
          ar: { singular: effJobAr, plural: effJobAr, gender: "m" as const },
        },
      },
      rationale_en: `You chose to call your work items "${effJobEn}" — this applies that name across the app (plural forms are editable in Settings).`,
      rationale_ar: `اخترت تسمية وحدات العمل "${effJobAr}" — يعتمد هذا الاسم في التطبيق كاملاً (يمكن تعديل صيغة الجمع من الإعدادات).`,
    });
  }
  // Honest prose: a typed term is the founder's naming; a blank one keeps the template's.
  const termClauseEn = founderRenamed
    ? `work items called "${effJobEn}"`
    : `work items keep the template's own term "${templateJobEn}"`;
  const termClauseAr = founderRenamed
    ? `تُسمّى وحدات العمل "${effJobAr}"`
    : `تبقى تسمية وحدات العمل كما في القالب "${templateJobAr}"`;

  return {
    template_key: selected.key,
    template_reason_en: selected.reasonEn,
    template_reason_ar: selected.reasonAr,
    template_alternatives: selected.alternatives,
    template_confident: selected.confident,
    install_template: true,
    artifacts,
    approval_defaults,
    requires_upgrade,
    intake_summary_en: `${intake.business_name} — a ${c.en} ${vatEn} business on a ${week} working week, base currency ${intake.base_currency}, ${termClauseEn}. Grounded on the ${templateNameEn} template.`,
    intake_summary_ar: `${intake.business_name} — منشأة في ${c.ar}، ${vatAr}، أسبوع عمل ${weekAr}، العملة ${intake.base_currency}، ${termClauseAr}. مبنية على قالب ${templateNameAr}.`,
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
 * product). A future AI provider may enrich prose/questions but must return the SAME
 * validated ConfigProposal shape — it can never emit arbitrary configuration.
 */
export function getOnboardingProvider(): OnboardingProvider {
  // No real LLM provider is wired yet; the deterministic build is the shipped path either way.
  return deterministicProvider;
}
