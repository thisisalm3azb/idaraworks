/**
 * S8 Layer-A ConfigProposal — the schemas (doc 09 #12; doc 11 S8).
 *
 * A ConfigProposal is the OUTPUT of the grounded proposal builder: a structured, fully
 * typed artifact that a human reviews on the preview screen, then applies as undoable config
 * revisions. It is deliberately a VALIDATOR AROUND TEMPLATES — every artifact it carries is a
 * config artifact the S1 pipeline already governs, so nothing here can grant a capability the
 * config layer didn't already enforce.
 *
 * Intake is a STRUCTURED questionnaire (not free-form): it works with no AI provider at all
 * (the manual fallback), and an optional AI provider may only rephrase/reorder — never widen.
 */
import { z } from "zod";
import { CONFIG_ARTIFACT_KEYS } from "@/platform/config";

// ── Structured intake ────────────────────────────────────────────────────────
export const SUPPORTED_COUNTRIES = ["AE", "SA", "KW", "BH", "OM", "QA"] as const;
export const APPROVAL_SUBJECTS = ["purchase_order", "material_request"] as const;

export const OnboardingIntakeSchema = z
  .object({
    business_name: z.string().trim().min(1).max(120),
    // Free-text business description — drives the deterministic template
    // classification (classify.ts). Optional: without it (and without an
    // explicit template_key) the recommendation falls back to Generic Operations.
    business_description: z.string().trim().max(600).default(""),
    // Explicit template selection (manual choice / override of a previous
    // recommendation). Must name a REAL registry template — validated by
    // validateProposal against TEMPLATES; when present it wins over the
    // classifier. Absent = classify business_description.
    template_key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,49}$/)
      .optional(),
    country: z.enum(SUPPORTED_COUNTRIES),
    base_currency: z.string().regex(/^[A-Z]{3}$/),
    languages: z.array(z.enum(["en", "ar"])).min(1),
    six_day_week: z.boolean(),
    vat_registered: z.boolean(),
    // The single most-visible terminology choice: what the org calls a `job` (EN + AR label).
    // OPTIONAL (review fix): left blank, the selected template's own term stands — the
    // proposal must not fabricate a "choice" the founder never made.
    job_term_en: z.string().trim().min(1).max(40).optional(),
    job_term_ar: z.string().trim().min(1).max(40).optional(),
    // Desired auto-approve thresholds (org-currency MINOR units); F-28-capped by the validator.
    approval_auto_approve_below: z
      .object({
        purchase_order: z.number().int().min(0).optional(),
        material_request: z.number().int().min(0).optional(),
      })
      .default({}),
    // Features the operator asked for (may be beyond their plan → requires_upgrade, never applied).
    requested_features: z.array(z.string().max(60)).default([]),
    // Non-config seeding hints (drive the first-run checklist only, never the config).
    team_size: z.number().int().min(0).max(100000).optional(),
  })
  .strict();
export type OnboardingIntake = z.infer<typeof OnboardingIntakeSchema>;

// ── The proposal ─────────────────────────────────────────────────────────────
const ARTIFACT_KEY = z.enum(CONFIG_ARTIFACT_KEYS as [string, ...string[]]);

export const ProposalArtifactSchema = z
  .object({
    key: ARTIFACT_KEY,
    // The full artifact document (validated against the key's own schema by the validator).
    value: z.unknown(),
    rationale_en: z.string().min(1).max(400),
    rationale_ar: z.string().min(1).max(400),
  })
  .strict();
export type ProposalArtifact = z.infer<typeof ProposalArtifactSchema>;

export const ApprovalDefaultSchema = z
  .object({
    subject_type: z.enum(APPROVAL_SUBJECTS),
    auto_approve_below_minor: z.number().int().min(0),
  })
  .strict();
export type ApprovalDefault = z.infer<typeof ApprovalDefaultSchema>;

/** A non-recommended template shown as an alternative (chooser row on preview). */
export const TemplateAlternativeSchema = z
  .object({
    key: z.string().min(1).max(80),
    score: z.number().min(0),
    name_en: z.string().min(1).max(80),
    name_ar: z.string().min(1).max(80),
  })
  .strict();
export type TemplateAlternative = z.infer<typeof TemplateAlternativeSchema>;

export const ConfigProposalSchema = z
  .object({
    intake_summary_en: z.string().min(1).max(1000),
    intake_summary_ar: z.string().min(1).max(1000),
    template_key: z.string().min(1).max(80),
    // WHY this template was recommended (matched signals or "you selected it") —
    // rendered verbatim on the preview screen. Honest by construction: built
    // from the classifier's matched keywords/phrases, never free-claims.
    template_reason_en: z.string().min(1).max(400),
    template_reason_ar: z.string().min(1).max(400),
    // Every OTHER catalogue template with its score — the founder can always
    // choose one of these instead (a new proposal is generated for the choice).
    template_alternatives: z.array(TemplateAlternativeSchema).default([]),
    /** false = ambiguous match or generic fallback — UI emphasises manual choice. */
    template_confident: z.boolean().default(true),
    install_template: z.boolean(),
    artifacts: z.array(ProposalArtifactSchema),
    approval_defaults: z.array(ApprovalDefaultSchema).default([]),
    // Feature keys the org needs but the plan does not grant — surfaced, NEVER auto-applied.
    requires_upgrade: z.array(z.string().max(60)).default([]),
  })
  .strict();
export type ConfigProposal = z.infer<typeof ConfigProposalSchema>;

/**
 * Template-grounding baselines for the F-28 auto-approve cap. These are the "template
 * default" auto-approve thresholds (org-currency MINOR units) against which an AI/operator
 * proposal is capped at 2×; a proposal above the cap is REJECTED, never clamped. PLACEHOLDER
 * numbers pending OP-2/D3 (documented, like the pricing tiers).
 */
export const TEMPLATE_APPROVAL_DEFAULT_MINOR: Record<(typeof APPROVAL_SUBJECTS)[number], number> = {
  purchase_order: 500_000,
  material_request: 300_000,
};
export const F28_CAP_MULTIPLE = 2;
