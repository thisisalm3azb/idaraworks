/**
 * U4 pre-org onboarding flow — the PURE half (no DB, no ctx, fully
 * unit-testable): the draft-data schema, the step registry, the question-level
 * skip rules, the answers→classifier mapping onto the EXISTING deterministic
 * classifier (classify.ts is not rebuilt — we only compose its input text), the
 * draft→OnboardingIntake mapping, the tier-selection recording shape, and the
 * review-summary builder.
 *
 * Laws carried through:
 *  - templates configure STRUCTURE only — the intake this produces never seeds
 *    customers/employees/suppliers/jobs/orders/inventory/invoices/payments;
 *  - typed-vs-blank job-term law (wave 1): blank terms are OMITTED from the
 *    intake so the template's own term stands (provider.ts never fabricates a
 *    naming choice the founder didn't make);
 *  - the tier selection is a RECORDED choice, never an entitlement change.
 */
import { z } from "zod";
import { getCatalogueEntry, TEMPLATES } from "@/platform/config";
import type { SelectionView, SelectionCurrency } from "@/platform/ui/subscription/types";
import { classifyBusiness, type TemplateMatch } from "./classify";
import { selectTemplate } from "./provider";
import { OnboardingIntakeSchema, SUPPORTED_COUNTRIES, type OnboardingIntake } from "./proposal";

// ── Closed answer vocabularies (draft-side; never rendered raw — i18n keys map them) ──
export const INDUSTRIES = [
  "construction",
  "marine",
  "manufacturing",
  "field_services",
  "food_beverage",
  "retail_online",
  "agriculture",
  "other",
] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const EMPLOYEE_BANDS = ["1-5", "6-20", "21-50", "51-200", "200+"] as const;
export const USER_BANDS = ["1-3", "4-10", "11-25", "26+"] as const;
export const LOCATION_BANDS = ["1", "2-3", "4-10", "10+"] as const;

export const DEPARTMENTS = [
  "management",
  "operations",
  "workshop",
  "field_teams",
  "sales",
  "purchasing",
  "warehouse",
  "finance",
  "quality",
  "hr",
] as const;

export const WORK_PATTERNS = [
  "project",
  "order",
  "service",
  "recurring",
  "retail",
  "production",
  "mixed",
] as const;
export type WorkPattern = (typeof WORK_PATTERNS)[number];

export const WORK_INTAKE = [
  "phone_whatsapp",
  "walk_in",
  "email",
  "referrals",
  "tenders",
  "contracts",
  "online",
  "social",
] as const;

export const CAPABILITY_CHIPS = [
  "assignments",
  "stages",
  "daily_reports",
  "inspections",
  "issues",
  "approvals",
  "purchasing",
  "inventory",
  "receiving",
  "costing",
  "quotes",
  "invoices",
  "payments",
  "customer_updates",
  "exports",
] as const;
export type CapabilityChip = (typeof CAPABILITY_CHIPS)[number];

export const DEVICES = ["desktop", "mobile", "both"] as const;

// ── Country-driven defaults (timezone / currency; the region step prefills) ──
export const COUNTRY_DEFAULTS: Record<
  (typeof SUPPORTED_COUNTRIES)[number],
  { timezone: string; currency: string }
> = {
  AE: { timezone: "Asia/Dubai", currency: "AED" },
  SA: { timezone: "Asia/Riyadh", currency: "SAR" },
  KW: { timezone: "Asia/Kuwait", currency: "KWD" },
  BH: { timezone: "Asia/Bahrain", currency: "BHD" },
  OM: { timezone: "Asia/Muscat", currency: "OMR" },
  QA: { timezone: "Asia/Qatar", currency: "QAR" },
};
/** org.base_currency check constraint (0001) — the offerable set. */
export const FLOW_CURRENCIES = ["AED", "SAR", "QAR", "KWD", "BHD", "OMR", "USD", "EUR"] as const;
export const FLOW_TIMEZONES = [
  "Asia/Dubai",
  "Asia/Riyadh",
  "Asia/Kuwait",
  "Asia/Bahrain",
  "Asia/Muscat",
  "Asia/Qatar",
] as const;

// ── Draft data schema (progressive: everything optional until review) ────────
export const DraftAnswersSchema = z
  .object({
    business_name: z.string().trim().min(1).max(120).optional(),
    legal_name: z.string().trim().min(1).max(200).optional(),
    industry: z.enum(INDUSTRIES).optional(),
    business_description: z.string().trim().max(600).optional(),
    country: z.enum(SUPPORTED_COUNTRIES).optional(),
    timezone: z.enum(FLOW_TIMEZONES).optional(),
    base_currency: z.enum(FLOW_CURRENCIES).optional(),
    preferred_language: z.enum(["en", "ar"]).optional(),
    employees_band: z.enum(EMPLOYEE_BANDS).optional(),
    users_band: z.enum(USER_BANDS).optional(),
    locations_band: z.enum(LOCATION_BANDS).optional(),
    departments: z.array(z.enum(DEPARTMENTS)).max(DEPARTMENTS.length).optional(),
    work_patterns: z.array(z.enum(WORK_PATTERNS)).max(WORK_PATTERNS.length).optional(),
    work_intake: z.array(z.enum(WORK_INTAKE)).max(WORK_INTAKE.length).optional(),
    workflow_description: z.string().trim().max(600).optional(),
    capabilities: z.array(z.enum(CAPABILITY_CHIPS)).max(CAPABILITY_CHIPS.length).optional(),
    device: z.enum(DEVICES).optional(),
    customer_sharing: z.boolean().optional(),
    main_problem: z.string().trim().max(600).optional(),
  })
  .strict();
export type DraftAnswers = z.infer<typeof DraftAnswersSchema>;

export const TierSelectionSchema = z
  .object({
    mode: z.enum(["free", "tier_medium", "tier_high", "custom"]),
    /** Custom path only: the chosen addon keys (mirror of quantities' keys). */
    customKeys: z
      .array(z.string().regex(/^addon\.[a-z0-9_]+$/))
      .max(64)
      .optional(),
    /** Custom path only: addon key → quantity (stackable packs > 1). */
    quantities: z.record(z.string(), z.number().int().min(1).max(99)).optional(),
  })
  .strict();
export type TierSelection = z.infer<typeof TierSelectionSchema>;

/** Mirror of branding/validation.ts ACCENT_COLOR_RE (kept local so this module
 * stays pure — the branding SERVICE re-validates authoritatively at apply time). */
const FLOW_ACCENT_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Base64 expansion of the branding byte cap (2 MB × 4/3, review fix: the zod cap
 * must never admit a stash that uploadLogo's byte cap would reject at confirm). */
const LOGO_BASE64_MAX = Math.ceil((2 * 1024 * 1024 * 4) / 3);

export const DraftBrandingSchema = z
  .object({
    /** The RE-ENCODED 512px PNG (processLogo main variant), base64 — never raw upload bytes. */
    logo_base64: z.string().max(LOGO_BASE64_MAX).optional(),
    accent_color: z.string().regex(FLOW_ACCENT_COLOR_RE).optional(),
    display_name: z.string().trim().min(1).max(120).optional(),
    legal_name: z.string().trim().min(1).max(200).optional(),
    footer_details: z.string().trim().min(1).max(500).optional(),
    skipped: z.boolean().optional(),
  })
  .strict();
export type DraftBranding = z.infer<typeof DraftBrandingSchema>;

/** Confirm-chain progress (idempotent resume): each completed link is stashed so
 * a failed/retried confirm continues instead of duplicating work. */
export const ConfirmStateSchema = z
  .object({
    claimed_at: z.string().optional(),
    org_id: z.string().uuid().optional(),
    session_id: z.string().uuid().optional(),
    applied: z.boolean().optional(),
    tier_recorded: z.boolean().optional(),
    branding_saved: z.boolean().optional(),
  })
  .strict();
export type ConfirmState = z.infer<typeof ConfirmStateSchema>;

export const DraftDataSchema = z
  .object({
    answers: DraftAnswersSchema.default({}),
    template: z
      .object({
        selected_key: z.string().max(80).optional(),
        recommended_key: z.string().max(80).optional(),
        confident: z.boolean().optional(),
        manual: z.boolean().optional(),
      })
      .strict()
      .default({}),
    terms: z
      .object({
        job_term_en: z.string().trim().max(40).optional(),
        job_term_ar: z.string().trim().max(40).optional(),
      })
      .strict()
      .default({}),
    tier: TierSelectionSchema.optional(),
    branding: DraftBrandingSchema.default({}),
    confirm: ConfirmStateSchema.default({}),
  })
  .strict();
export type DraftData = z.infer<typeof DraftDataSchema>;

export function emptyDraftData(): DraftData {
  return DraftDataSchema.parse({});
}

// ── Step registry ─────────────────────────────────────────────────────────────
export const FLOW_STEPS = [
  "welcome",
  "business",
  "region",
  "scale",
  "work",
  "needs",
  "template",
  "proposal",
  "plan",
  "branding",
  "review",
] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

export function isFlowStep(v: unknown): v is FlowStep {
  return typeof v === "string" && (FLOW_STEPS as readonly string[]).includes(v);
}

export function nextStepAfter(step: FlowStep): FlowStep {
  const i = FLOW_STEPS.indexOf(step);
  return FLOW_STEPS[Math.min(i + 1, FLOW_STEPS.length - 1)]!;
}

export function prevStepBefore(step: FlowStep): FlowStep {
  const i = FLOW_STEPS.indexOf(step);
  return FLOW_STEPS[Math.max(i - 1, 0)]!;
}

export function stepProgressPct(step: FlowStep): number {
  return Math.round((FLOW_STEPS.indexOf(step) / (FLOW_STEPS.length - 1)) * 100);
}

export function stepsRemaining(step: FlowStep): number {
  return FLOW_STEPS.length - 1 - FLOW_STEPS.indexOf(step);
}

// ── Question-level skip rules (documented in docs/ux/ONBOARDING_FLOW.md) ─────
/** SKIP-1: a 1–5-person business is not asked how many sign-ins it needs — the
 * whole team fits the smallest band; '1-3' is derived at intake time. */
export function askUsersBand(a: DraftAnswers): boolean {
  return a.employees_band !== "1-5";
}

/** SKIP-2: a 1–5-person business is not asked to name departments. */
export function askDepartments(a: DraftAnswers): boolean {
  return a.employees_band !== undefined && a.employees_band !== "1-5";
}

/** SKIP-3: the start-to-finish workflow question only makes sense when at least
 * one chosen work pattern has a per-engagement flow (retail/recurring don't). */
export function askWorkflowDescription(a: DraftAnswers): boolean {
  const p = a.work_patterns ?? [];
  return p.length > 0 && p.some((x) => x !== "retail" && x !== "recurring");
}

/** SKIP-4: external customer sharing is only asked when a customer-facing
 * capability (quotes / invoices / customer updates) was requested. */
export function askCustomerSharing(a: DraftAnswers): boolean {
  const c = a.capabilities ?? [];
  return (["quotes", "invoices", "customer_updates"] as const).some((k) => c.includes(k));
}

// ── Per-step form application (validation + skip-consistency) ────────────────
export class FlowValidationError extends Error {
  constructor(public readonly fields: string[]) {
    super(`invalid or missing answers: ${fields.join(", ")}`);
    this.name = "FlowValidationError";
  }
}

/** Raw values as the actions extract them from FormData (strings / string[]). */
export type StepFormValues = Record<string, string | string[] | undefined>;

const str = (v: string | string[] | undefined): string | undefined => {
  const s = Array.isArray(v) ? v[0] : v;
  const trimmed = (s ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
};
const arr = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((s) => s.trim() !== "");

/**
 * Merge one questionnaire screen's submission into the draft data. Validates
 * with the zod vocabularies, enforces required-per-screen fields, and keeps the
 * stored answers CONSISTENT with the skip rules (a skipped question's stale
 * answer is dropped, so review never shows an answer the founder no longer gave).
 */
export function applyStepAnswers(data: DraftData, step: FlowStep, form: StepFormValues): DraftData {
  const answers: DraftAnswers = { ...data.answers };
  const missing: string[] = [];
  const need = <T>(field: string, v: T | undefined): T | undefined => {
    if (v === undefined) missing.push(field);
    return v;
  };

  switch (step) {
    case "business": {
      answers.business_name = need("business_name", str(form.business_name));
      answers.legal_name = str(form.legal_name);
      answers.industry = need("industry", str(form.industry) as Industry | undefined);
      answers.business_description = str(form.business_description);
      break;
    }
    case "region": {
      answers.country = need("country", str(form.country) as DraftAnswers["country"]);
      answers.timezone = need("timezone", str(form.timezone) as DraftAnswers["timezone"]);
      answers.base_currency = need(
        "base_currency",
        str(form.base_currency) as DraftAnswers["base_currency"],
      );
      answers.preferred_language = need(
        "preferred_language",
        str(form.preferred_language) as DraftAnswers["preferred_language"],
      );
      break;
    }
    case "scale": {
      answers.employees_band = need(
        "employees_band",
        str(form.employees_band) as DraftAnswers["employees_band"],
      );
      answers.locations_band = need(
        "locations_band",
        str(form.locations_band) as DraftAnswers["locations_band"],
      );
      if (askUsersBand(answers)) {
        answers.users_band = need("users_band", str(form.users_band) as DraftAnswers["users_band"]);
      } else {
        delete answers.users_band; // SKIP-1: derived, never stored
      }
      if (askDepartments(answers)) {
        answers.departments = arr(form.departments) as DraftAnswers["departments"];
      } else {
        delete answers.departments; // SKIP-2
      }
      break;
    }
    case "work": {
      const patterns = arr(form.work_patterns) as WorkPattern[];
      if (patterns.length === 0) missing.push("work_patterns");
      answers.work_patterns = patterns;
      answers.work_intake = arr(form.work_intake) as DraftAnswers["work_intake"];
      if (askWorkflowDescription(answers)) {
        answers.workflow_description = str(form.workflow_description);
      } else {
        delete answers.workflow_description; // SKIP-3
      }
      break;
    }
    case "needs": {
      answers.capabilities = arr(form.capabilities) as CapabilityChip[];
      answers.device = need("device", str(form.device) as DraftAnswers["device"]);
      if (askCustomerSharing(answers)) {
        const v = str(form.customer_sharing);
        if (v === undefined) missing.push("customer_sharing");
        answers.customer_sharing = v === "yes";
      } else {
        delete answers.customer_sharing; // SKIP-4: derived false
      }
      answers.main_problem = str(form.main_problem);
      break;
    }
    default:
      throw new FlowValidationError([`step ${step} takes no questionnaire answers`]);
  }

  if (missing.length > 0) throw new FlowValidationError(missing);
  // Full-schema re-parse: enum membership + length limits enforced here.
  return DraftDataSchema.parse({ ...data, answers });
}

// ── Step completeness (resume + deep-link gating) ─────────────────────────────
export function stepComplete(step: FlowStep, data: DraftData): boolean {
  const a = data.answers;
  switch (step) {
    case "welcome":
      return true;
    case "business":
      return !!a.business_name && !!a.industry;
    case "region":
      return !!a.country && !!a.timezone && !!a.base_currency && !!a.preferred_language;
    case "scale":
      return !!a.employees_band && !!a.locations_band && (!askUsersBand(a) || !!a.users_band);
    case "work":
      return (a.work_patterns ?? []).length > 0;
    case "needs":
      return !!a.device && (!askCustomerSharing(a) || a.customer_sharing !== undefined);
    case "template":
      return !!data.template.selected_key && data.template.selected_key in TEMPLATES;
    case "proposal":
      return stepComplete("template", data); // view-only screen; terms are optional
    case "plan":
      return data.tier !== undefined;
    case "branding":
      return true; // skippable
    case "review":
      return true;
  }
}

/** The furthest step the founder may open: every screen BEFORE it must be
 * complete. Deep-linking further redirects here (resume lands here too). */
export function firstIncompleteStep(data: DraftData): FlowStep {
  for (const step of FLOW_STEPS) {
    if (step === "welcome") continue;
    const idx = FLOW_STEPS.indexOf(step);
    const prior = FLOW_STEPS.slice(1, idx); // welcome never gates
    if (!prior.every((s) => stepComplete(s, data))) return step;
    if (!stepComplete(step, data) && step !== "review") return step;
  }
  return "review";
}

/** Clamp a requested step to what the draft's data actually allows. */
export function resolveStep(requested: string | undefined, data: DraftData): FlowStep {
  const target = isFlowStep(requested) ? requested : "welcome";
  if (target === "welcome") return "welcome";
  const gate = firstIncompleteStep(data);
  return FLOW_STEPS.indexOf(target) <= FLOW_STEPS.indexOf(gate) ? target : gate;
}

// ── Answers → classifier input (the EXISTING classifier; input composition only) ──
/** Honest hint words aligned with the catalogue's own classificationKeywords —
 * the industry answer is a strong signal, patterns/capabilities are light ones. */
export const INDUSTRY_HINTS: Record<Industry, string> = {
  construction: "construction contracting",
  marine: "marine boatyard",
  manufacturing: "manufacturing fabrication workshop",
  field_services: "maintenance repair field service",
  food_beverage: "catering food production kitchen",
  retail_online: "online store e-commerce fulfilment",
  agriculture: "farm agriculture crops",
  other: "",
};

export const PATTERN_HINTS: Record<WorkPattern, string> = {
  project: "client projects",
  order: "made to order",
  service: "service calls",
  recurring: "recurring contracts",
  retail: "retail online orders",
  production: "production runs",
  mixed: "",
};

const CAPABILITY_HINTS: Partial<Record<CapabilityChip, string>> = {
  purchasing: "purchasing suppliers",
  inventory: "inventory stock",
  receiving: "goods receiving",
  costing: "costing",
};

/** Compose the classifier text: the founder's own words FIRST (they dominate),
 * then the structured hints. Capped to the intake schema's 600-char bound. */
export function buildClassifierText(a: DraftAnswers): string {
  const parts = [
    a.business_description ?? "",
    a.workflow_description ?? "",
    a.industry ? INDUSTRY_HINTS[a.industry] : "",
    ...(a.work_patterns ?? []).map((p) => PATTERN_HINTS[p]),
    ...(a.capabilities ?? []).map((c) => CAPABILITY_HINTS[c] ?? ""),
  ];
  return parts
    .filter((s) => s !== "")
    .join(" ")
    .slice(0, 600)
    .trim();
}

export type FlowRecommendation = {
  recommendedKey: string;
  confident: boolean;
  reasonEn: string;
  reasonAr: string;
  /** Every catalogue template with its score, best first (incl. the recommended). */
  ranked: TemplateMatch[];
};

/** The recommendation as shown on the template step — always the PURE
 * classification (a previous manual choice never colours the recommendation). */
export function recommendationForDraft(data: DraftData): FlowRecommendation {
  const text = buildClassifierText(data.answers);
  const name = data.answers.business_name ?? "";
  const result = classifyBusiness(`${text} ${name}`.trim());
  const sel = selectTemplate({
    ...minimalIntakeForClassify(data),
    template_key: undefined,
  });
  return {
    recommendedKey: result.recommendedKey,
    confident: result.confident,
    reasonEn: sel.reasonEn,
    reasonAr: sel.reasonAr,
    ranked: result.ranked,
  };
}

/** A syntactically valid intake for the pure classify/selectTemplate helpers —
 * used before region answers matter (classification only reads text fields). */
function minimalIntakeForClassify(data: DraftData): OnboardingIntake {
  return OnboardingIntakeSchema.parse({
    business_name: data.answers.business_name ?? "-",
    business_description: buildClassifierText(data.answers),
    country: data.answers.country ?? "AE",
    base_currency: data.answers.base_currency ?? "AED",
    languages: ["en"],
    six_day_week: false,
    vat_registered: false,
  });
}

// ── Draft → OnboardingIntake (the confirm-time pipeline input) ────────────────
export class DraftIncompleteError extends Error {
  constructor(public readonly missing: string[]) {
    super(`draft incomplete: ${missing.join(", ")}`);
    this.name = "DraftIncompleteError";
  }
}

/**
 * Build the EXACT OnboardingIntake the existing S8 pipeline consumes. Job terms
 * follow the typed-vs-blank law (blank = omitted = the template's own term).
 * Working week and VAT registration are NOT asked in this flow — they default
 * (5-day week, not VAT-registered) and remain editable in Settings; documented
 * in docs/ux/ONBOARDING_FLOW.md.
 */
export function draftToIntake(data: DraftData): OnboardingIntake {
  const a = data.answers;
  const missing: string[] = [];
  if (!a.business_name) missing.push("business_name");
  if (!a.country) missing.push("country");
  if (!a.base_currency) missing.push("base_currency");
  if (!a.preferred_language) missing.push("preferred_language");
  const templateKey = data.template.selected_key;
  if (!templateKey || !(templateKey in TEMPLATES)) missing.push("template");
  if (missing.length > 0) throw new DraftIncompleteError(missing);

  const jobEn = data.terms.job_term_en?.trim();
  const jobAr = data.terms.job_term_ar?.trim();
  return OnboardingIntakeSchema.parse({
    business_name: a.business_name!,
    business_description: buildClassifierText(a),
    template_key: templateKey!,
    country: a.country!,
    base_currency: a.base_currency!,
    languages: a.preferred_language === "ar" ? ["ar", "en"] : ["en", "ar"],
    six_day_week: false,
    vat_registered: false,
    ...(jobEn ? { job_term_en: jobEn } : {}),
    ...(jobAr ? { job_term_ar: jobAr } : {}),
    approval_auto_approve_below: {},
    requested_features: [],
  });
}

/** Derived (never stored) users band when SKIP-1 applied. */
export function effectiveUsersBand(a: DraftAnswers): (typeof USER_BANDS)[number] | undefined {
  return askUsersBand(a) ? a.users_band : "1-3";
}

/** Derived (never stored) customer-sharing answer when SKIP-4 applied. */
export function effectiveCustomerSharing(a: DraftAnswers): boolean {
  return askCustomerSharing(a) ? (a.customer_sharing ?? false) : false;
}

// ── Tier-selection recording shape (app_settings 'subscription.selected_tier') ──
export const TIER_SETTING_KEY = "subscription.selected_tier";

export type TierSettingValue = {
  mode: TierSelection["mode"];
  custom_keys: string[];
  quantities: Record<string, number>;
  source: "onboarding";
  recorded_at: string;
  /** Honesty marker: this is a recorded choice — entitlements are untouched. */
  recorded_choice_only: true;
};

export function tierSettingValue(tier: TierSelection, recordedAt: string): TierSettingValue {
  const quantities = tier.mode === "custom" ? (tier.quantities ?? {}) : {};
  return {
    mode: tier.mode,
    custom_keys: tier.mode === "custom" ? (tier.customKeys ?? Object.keys(quantities)) : [],
    quantities,
    source: "onboarding",
    recorded_at: recordedAt,
    recorded_choice_only: true,
  };
}

// ── Review summary (pure; the review screen + unit tests share it) ────────────
export type ReviewSummary = {
  business: {
    name: string;
    legalName: string | null;
    industry: Industry | null;
    country: string;
    timezone: string;
    currency: string;
    language: "en" | "ar";
  };
  template: {
    key: string;
    nameEn: string;
    nameAr: string;
    stageCount: number;
    jobTermEn: string;
    jobTermAr: string;
    renamed: boolean;
  };
  tier: {
    mode: TierSelection["mode"];
    monthlyMinor: Record<SelectionCurrency, number>;
    customCount: number;
  };
  branding: {
    hasLogo: boolean;
    accentColor: string | null;
    displayName: string | null;
    skipped: boolean;
  };
};

/** The recorded monthly total for the review screen: Free 0; tiers the bundle
 * price; custom the sum of addon price × quantity (from the selection view). */
export function reviewMonthlyMinor(
  tier: TierSelection,
  view: SelectionView,
): Record<SelectionCurrency, number> {
  if (tier.mode === "free") return { USD: 0, AED: 0 };
  if (tier.mode === "tier_medium") return view.medium.priceMonthlyMinor;
  if (tier.mode === "tier_high") return view.high.priceMonthlyMinor;
  const prices = new Map(
    view.custom.groups.flatMap((g) =>
      g.items.map(
        (i) =>
          [i.addon.key, { USD: i.addon.usdMonthlyMinor, AED: i.addon.aedMonthlyMinor }] as const,
      ),
    ),
  );
  const out: Record<SelectionCurrency, number> = { USD: 0, AED: 0 };
  for (const [key, qty] of Object.entries(tier.quantities ?? {})) {
    const p = prices.get(key);
    if (!p) continue;
    out.USD += p.USD * qty;
    out.AED += p.AED * qty;
  }
  return out;
}

export function buildReviewSummary(data: DraftData, view: SelectionView): ReviewSummary {
  const a = data.answers;
  const key = data.template.selected_key ?? "";
  const entry = getCatalogueEntry(key);
  const manifest = TEMPLATES[key];
  const templateJobEn = manifest?.terminology?.job?.en?.singular ?? "";
  const templateJobAr = manifest?.terminology?.job?.ar?.singular ?? "";
  const typedEn = data.terms.job_term_en?.trim() || undefined;
  const typedAr = data.terms.job_term_ar?.trim() || undefined;
  const tier = data.tier ?? { mode: "free" as const };
  const b = data.branding;
  return {
    business: {
      name: a.business_name ?? "",
      legalName: a.legal_name ?? null,
      industry: a.industry ?? null,
      country: a.country ?? "",
      timezone: a.timezone ?? "",
      currency: a.base_currency ?? "",
      language: a.preferred_language ?? "en",
    },
    template: {
      key,
      nameEn: entry?.names.en ?? key,
      nameAr: entry?.names.ar ?? key,
      stageCount: manifest?.stage_template?.stages?.length ?? 0,
      jobTermEn: typedEn ?? templateJobEn,
      jobTermAr: typedAr ?? templateJobAr,
      renamed: Boolean(
        (typedEn && typedEn !== templateJobEn) || (typedAr && typedAr !== templateJobAr),
      ),
    },
    tier: {
      mode: tier.mode,
      monthlyMinor: reviewMonthlyMinor(tier, view),
      customCount: tier.mode === "custom" ? Object.keys(tier.quantities ?? {}).length : 0,
    },
    branding: {
      hasLogo: !!b.logo_base64,
      accentColor: b.accent_color ?? null,
      displayName: b.display_name ?? a.business_name ?? null,
      skipped: b.skipped === true && !b.logo_base64 && !b.accent_color && !b.display_name,
    },
  };
}
