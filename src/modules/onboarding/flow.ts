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
import { SUPPORTED_LOCALES, type Locale } from "@/platform/registries";
import { BLUEPRINT_REQUIRED_LOCALES } from "@/platform/workspace/blueprint";
import type { SelectionView, SelectionCurrency } from "@/platform/ui/subscription/types";
import { classifyBusiness, type TemplateMatch } from "./classify";
import { selectTemplate } from "./provider";
import { OnboardingIntakeSchema, SUPPORTED_COUNTRIES, type OnboardingIntake } from "./proposal";

// ── Closed answer vocabularies (draft-side; never rendered raw — i18n keys map them) ──
/**
 * H15.1 primary-industry taxonomy: a user-friendly international set informed
 * by established classifications (no codes, no bureaucratic wording). The
 * OFFERED options are INDUSTRY_OPTIONS; the stored enum additionally accepts
 * the LEGACY H15 values so existing drafts parse unchanged and are never
 * silently reinterpreted — legacy keys resolve behavior through the explicit
 * canonicalIndustry mapping (tested).
 */
export const INDUSTRY_OPTIONS = [
  "construction",
  "professional_services",
  "retail_ecommerce",
  "wholesale_distribution",
  "manufacturing",
  "hospitality_food",
  "real_estate",
  "transport_logistics",
  "healthcare",
  "education",
  "technology",
  "financial_services",
  "media_creative",
  "field_services",
  "agriculture",
  "nonprofit",
  "other_mixed",
] as const;
export type IndustryOption = (typeof INDUSTRY_OPTIONS)[number];

/** H15 stored values no longer offered (kept valid for saved drafts). */
export const LEGACY_INDUSTRIES = ["marine", "food_beverage", "retail_online", "other"] as const;
export type LegacyIndustry = (typeof LEGACY_INDUSTRIES)[number];

export const INDUSTRIES = [...INDUSTRY_OPTIONS, ...LEGACY_INDUSTRIES] as const;
export type Industry = (typeof INDUSTRIES)[number];

/** The explicit legacy-to-current mapping (compatibility, never rewriting). */
export const LEGACY_INDUSTRY_MAP: Record<LegacyIndustry, IndustryOption> = {
  marine: "manufacturing",
  food_beverage: "hospitality_food",
  retail_online: "retail_ecommerce",
  other: "other_mixed",
};

export function canonicalIndustry(industry: Industry | undefined): IndustryOption | undefined {
  if (industry === undefined) return undefined;
  return (INDUSTRY_OPTIONS as readonly string[]).includes(industry)
    ? (industry as IndustryOption)
    : LEGACY_INDUSTRY_MAP[industry as LegacyIndustry];
}

/**
 * Behavior flags per CURRENT industry (legacy values resolve through the map):
 *  - physical: the business plausibly handles physical goods, so the
 *    materials questions are ASKED (asking is not inferring — the founder's
 *    answers still decide every module);
 *  - fieldService: "service" delivery counts as field work for this industry
 *    (a desk-based service business is never pushed into daily reports).
 * Industry alone never enables inventory, purchasing, payroll or projects.
 */
export const INDUSTRY_INFO: Record<
  IndustryOption,
  { physical: boolean; fieldService: boolean; token: string }
> = {
  construction: { physical: true, fieldService: true, token: "construction and contracting" },
  professional_services: { physical: false, fieldService: false, token: "professional services" },
  retail_ecommerce: { physical: true, fieldService: false, token: "retail and e-commerce" },
  wholesale_distribution: {
    physical: true,
    fieldService: false,
    token: "wholesale and distribution",
  },
  manufacturing: { physical: true, fieldService: true, token: "manufacturing" },
  hospitality_food: { physical: true, fieldService: false, token: "hospitality and food" },
  real_estate: { physical: true, fieldService: true, token: "real estate and property services" },
  transport_logistics: { physical: true, fieldService: true, token: "transport and logistics" },
  healthcare: { physical: true, fieldService: false, token: "healthcare and wellness" },
  education: { physical: false, fieldService: false, token: "education and training" },
  technology: { physical: false, fieldService: false, token: "technology and software" },
  financial_services: { physical: false, fieldService: false, token: "financial services" },
  media_creative: { physical: false, fieldService: false, token: "media and creative services" },
  field_services: { physical: true, fieldService: true, token: "maintenance and field services" },
  agriculture: { physical: true, fieldService: true, token: "agriculture and food production" },
  nonprofit: { physical: false, fieldService: false, token: "nonprofit organization" },
  other_mixed: { physical: false, fieldService: false, token: "general business" },
};

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

// ── H15 Intelligent Clay journey vocabularies ────────────────────────────────
/** Mirrors the workspace registry's CUSTOMER_TYPES (parity-tested). */
export const CUSTOMER_TYPE_CHOICES = ["businesses", "consumers", "government", "mixed"] as const;
/** Mirrors the workspace registry's REVENUE_MODELS (parity-tested). */
export const REVENUE_CHOICES = [
  "fixed_price",
  "time_and_materials",
  "product_sales",
  "recurring",
  "milestone_billing",
] as const;
/** Three-state answer: "not_sure" always resolves to a safe recommendation. */
export const TRI = ["yes", "no", "not_sure"] as const;
export type Tri = (typeof TRI)[number];
export const YESNO = ["yes", "no"] as const;
/** Management-priority focus (drives the owner dashboard emphasis). */
export const PRIORITY_FOCUS = ["delivery", "collections", "team", "customers", "costs"] as const;
export type PriorityFocus = (typeof PRIORITY_FOCUS)[number];

/** The version of the journey (question set + branching). Stored on every
 * draft; a draft from an older journey resumes at its first incomplete step
 * with every still-valid answer preserved (Part I: schema-change return). */
export const JOURNEY_VERSION = 2;

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
    preferred_language: z.enum(SUPPORTED_LOCALES).optional(),
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
    // H15 journey answers (all optional until their step completes).
    customer_types: z.array(z.enum(CUSTOMER_TYPE_CHOICES)).max(4).optional(),
    revenue_models: z.array(z.enum(REVENUE_CHOICES)).max(REVENUE_CHOICES.length).optional(),
    buys_materials: z.enum(TRI).optional(),
    holds_stock: z.enum(TRI).optional(),
    receives_deliveries: z.enum(TRI).optional(),
    sends_quotes: z.enum(YESNO).optional(),
    sends_invoices: z.enum(TRI).optional(),
    collects_payments: z.enum(YESNO).optional(),
    records_expenses: z.enum(YESNO).optional(),
    tracks_costs: z.enum(TRI).optional(),
    vat_registered_q: z.enum(TRI).optional(),
    priority_focus: z.enum(PRIORITY_FOCUS).optional(),
  })
  .strict();
export type DraftAnswers = z.infer<typeof DraftAnswersSchema>;

/** Review-step workspace edits (Part G): presentation and inclusion choices
 * only — nothing here can grant entitlements or permissions (the blueprint
 * builder re-derives, the H14 validator re-checks, the compiler intersects). */
export const WorkspaceEditsSchema = z
  .object({
    /** Module slugs (without the internal prefix) the founder switched OFF. */
    modules_off: z
      .array(z.string().regex(/^[a-z_]{2,40}$/))
      .max(20)
      .optional(),
    /** Module slugs the founder switched ON beyond the recommendation. */
    modules_on: z
      .array(z.string().regex(/^[a-z_]{2,40}$/))
      .max(20)
      .optional(),
    /** Agents the founder marked not relevant. */
    agents_off: z
      .array(z.string().regex(/^[a-z_]{2,40}$/))
      .max(12)
      .optional(),
    /** Organization-facing role names (labels only; authority unchanged). */
    role_names: z
      .record(
        z.string().regex(/^[a-z_]{2,30}$/),
        z
          .object({
            en: z.string().trim().max(60).optional(),
            ar: z.string().trim().max(60).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type WorkspaceEdits = z.infer<typeof WorkspaceEditsSchema>;

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
    /** H15: the H14 workspace-blueprint revision created from the answers. */
    blueprint_revision_id: z.string().uuid().optional(),
    blueprint_applied: z.boolean().optional(),
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
    /** H15 review-step workspace edits (Part G). */
    workspace: WorkspaceEditsSchema.default({}),
    /** The journey version this draft was last saved under (Part E). */
    journey_version: z.number().int().min(1).max(99).default(JOURNEY_VERSION),
  })
  .strict();
export type DraftData = z.infer<typeof DraftDataSchema>;

export function emptyDraftData(): DraftData {
  return DraftDataSchema.parse({});
}

// ── Step registry (H15 journey order) ────────────────────────────────────────
export const FLOW_STEPS = [
  "welcome",
  "business",
  "region",
  "customers",
  "work",
  "scale",
  "materials",
  "money",
  "priorities",
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

/** The outcome-oriented journey sections (Part B) — each groups flow steps.
 * The confirm moment lives on the review screen. */
export const JOURNEY_SECTIONS = [
  { key: "about", steps: ["business", "region"] },
  { key: "customers", steps: ["customers"] },
  { key: "delivery", steps: ["work"] },
  { key: "team", steps: ["scale"] },
  { key: "materials", steps: ["materials"] },
  { key: "money", steps: ["money"] },
  { key: "priorities", steps: ["priorities"] },
  { key: "language", steps: ["template", "proposal"] },
  { key: "review", steps: ["plan", "branding", "review"] },
] as const satisfies ReadonlyArray<{ key: string; steps: readonly FlowStep[] }>;
export type JourneySectionKey = (typeof JOURNEY_SECTIONS)[number]["key"];

export function sectionForStep(step: FlowStep): JourneySectionKey | null {
  for (const s of JOURNEY_SECTIONS) {
    if ((s.steps as readonly FlowStep[]).includes(step)) return s.key;
  }
  return null; // welcome
}

// ── Step-level branching (Part D: adaptive, deterministic) ───────────────────
/** BRANCH-1: the materials/purchasing step is asked only when the business
 * plausibly handles physical goods (a physical industry, or physical work
 * patterns). A consulting-style business is never asked warehouse questions.
 * Asking is not inferring: the founder's answers decide every module.
 * Deterministic in (answers, JOURNEY_VERSION). */
export function askMaterialsStep(a: DraftAnswers): boolean {
  const ind = canonicalIndustry(a.industry);
  if (ind !== undefined && ind !== "other_mixed" && INDUSTRY_INFO[ind].physical) return true;
  const p = a.work_patterns ?? [];
  return p.some((x) => x === "project" || x === "order" || x === "production" || x === "retail");
}

/** The steps this draft's answers actually produce, in order (branching). */
export function visibleSteps(a: DraftAnswers): FlowStep[] {
  return FLOW_STEPS.filter((s) => (s === "materials" ? askMaterialsStep(a) : true));
}

export function nextStepAfter(step: FlowStep, a: DraftAnswers): FlowStep {
  const steps = visibleSteps(a);
  const i = steps.indexOf(step);
  if (i === -1) {
    // The step itself is branched away — continue at the next visible one.
    const gi = FLOW_STEPS.indexOf(step);
    return steps.find((s) => FLOW_STEPS.indexOf(s) > gi) ?? steps[steps.length - 1]!;
  }
  return steps[Math.min(i + 1, steps.length - 1)]!;
}

export function prevStepBefore(step: FlowStep, a: DraftAnswers): FlowStep {
  const steps = visibleSteps(a);
  const i = steps.indexOf(step);
  if (i === -1) return "welcome";
  return steps[Math.max(i - 1, 0)]!;
}

export function stepProgressPct(step: FlowStep, a: DraftAnswers): number {
  const steps = visibleSteps(a);
  const i = Math.max(0, steps.indexOf(step));
  return Math.round((i / (steps.length - 1)) * 100);
}

/**
 * H15.1: ONE consistent progress model — "Step X of Y" over the currently
 * VISIBLE journey (welcome is the doorway, not a step; hidden branched steps
 * are never counted; review, where confirmation happens, is the last step).
 * Branch changes re-derive the total automatically.
 */
export function stepNumberOf(step: FlowStep, a: DraftAnswers): { current: number; total: number } {
  const steps: FlowStep[] = visibleSteps(a).filter((s) => s !== "welcome");
  const i = steps.indexOf(step);
  return { current: Math.max(1, i + 1), total: steps.length };
}

// ── Question-level skip rules (documented in docs/ux/ONBOARDING_FLOW.md) ─────
/** SKIP-1: a 1–5-person business is not asked how many sign-ins it needs — the
 * whole team fits the smallest band; '1-3' is derived at intake time. */
export function askUsersBand(a: DraftAnswers): boolean {
  return a.employees_band !== "1-5";
}

/** SKIP-2: a 1–5-person business is not asked to name departments (a solo
 * operator is never forced through department design). */
export function askDepartments(a: DraftAnswers): boolean {
  return a.employees_band !== undefined && a.employees_band !== "1-5";
}

/** SKIP-3: the start-to-finish workflow question only makes sense when at least
 * one chosen work pattern has a per-engagement flow (retail/recurring don't). */
export function askWorkflowDescription(a: DraftAnswers): boolean {
  const p = a.work_patterns ?? [];
  return p.length > 0 && p.some((x) => x !== "retail" && x !== "recurring");
}

/** SKIP-5: deliveries are only asked about when the business buys materials. */
export function askReceivesDeliveries(a: DraftAnswers): boolean {
  return a.buys_materials === "yes";
}

/** SKIP-6: payment collection is only asked when invoices are sent. */
export function askCollectsPayments(a: DraftAnswers): boolean {
  return a.sends_invoices === "yes";
}

/** SKIP-7: per-work cost tracking only fits engagement-style work. */
export function askTracksCosts(a: DraftAnswers): boolean {
  const p = a.work_patterns ?? [];
  return p.some((x) => x === "project" || x === "order" || x === "service" || x === "production");
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
    case "customers": {
      const types = arr(form.customer_types) as DraftAnswers["customer_types"];
      if (!types || types.length === 0) missing.push("customer_types");
      answers.customer_types = types;
      answers.work_intake = arr(form.work_intake) as DraftAnswers["work_intake"];
      const sharing = str(form.customer_sharing);
      if (sharing === undefined) missing.push("customer_sharing");
      answers.customer_sharing = sharing === "yes";
      break;
    }
    case "work": {
      const patterns = arr(form.work_patterns) as WorkPattern[];
      if (patterns.length === 0) missing.push("work_patterns");
      answers.work_patterns = patterns;
      if (askWorkflowDescription(answers)) {
        answers.workflow_description = str(form.workflow_description);
      } else {
        delete answers.workflow_description; // SKIP-3
      }
      // BRANCH-1 re-evaluation: if the changed patterns hide the materials
      // step, its answers are dropped (recorded as invalidated by the journey
      // engine and shown to the founder — never silently kept as stale truth).
      if (!askMaterialsStep(answers)) {
        delete answers.buys_materials;
        delete answers.holds_stock;
        delete answers.receives_deliveries;
      }
      break;
    }
    case "materials": {
      answers.buys_materials = need("buys_materials", str(form.buys_materials) as Tri | undefined);
      answers.holds_stock = need("holds_stock", str(form.holds_stock) as Tri | undefined);
      if (askReceivesDeliveries(answers)) {
        answers.receives_deliveries = need(
          "receives_deliveries",
          str(form.receives_deliveries) as Tri | undefined,
        );
      } else {
        delete answers.receives_deliveries; // SKIP-5
      }
      break;
    }
    case "money": {
      answers.revenue_models = arr(form.revenue_models) as DraftAnswers["revenue_models"];
      const q = str(form.sends_quotes);
      if (q === undefined) missing.push("sends_quotes");
      answers.sends_quotes = q as DraftAnswers["sends_quotes"];
      answers.sends_invoices = need("sends_invoices", str(form.sends_invoices) as Tri | undefined);
      if (askCollectsPayments(answers)) {
        const p = str(form.collects_payments);
        if (p === undefined) missing.push("collects_payments");
        answers.collects_payments = p as DraftAnswers["collects_payments"];
      } else {
        delete answers.collects_payments; // SKIP-6
      }
      const e = str(form.records_expenses);
      if (e === undefined) missing.push("records_expenses");
      answers.records_expenses = e as DraftAnswers["records_expenses"];
      if (askTracksCosts(answers)) {
        answers.tracks_costs = need("tracks_costs", str(form.tracks_costs) as Tri | undefined);
      } else {
        delete answers.tracks_costs; // SKIP-7
      }
      answers.vat_registered_q = need(
        "vat_registered_q",
        str(form.vat_registered_q) as Tri | undefined,
      );
      break;
    }
    case "priorities": {
      answers.priority_focus = need(
        "priority_focus",
        str(form.priority_focus) as PriorityFocus | undefined,
      );
      answers.device = need("device", str(form.device) as DraftAnswers["device"]);
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
    case "customers":
      return (a.customer_types ?? []).length > 0 && a.customer_sharing !== undefined;
    case "work":
      return (a.work_patterns ?? []).length > 0;
    case "scale":
      return !!a.employees_band && !!a.locations_band && (!askUsersBand(a) || !!a.users_band);
    case "materials":
      return (
        !askMaterialsStep(a) ||
        (!!a.buys_materials &&
          !!a.holds_stock &&
          (!askReceivesDeliveries(a) || !!a.receives_deliveries))
      );
    case "money":
      return (
        !!a.sends_quotes &&
        !!a.sends_invoices &&
        (!askCollectsPayments(a) || !!a.collects_payments) &&
        !!a.records_expenses &&
        (!askTracksCosts(a) || !!a.tracks_costs) &&
        !!a.vat_registered_q
      );
    case "priorities":
      return !!a.priority_focus && !!a.device;
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

/** The furthest step the founder may open: every VISIBLE screen BEFORE it
 * must be complete. Deep-linking further redirects here (resume lands here). */
export function firstIncompleteStep(data: DraftData): FlowStep {
  const steps = visibleSteps(data.answers);
  for (const step of steps) {
    if (step === "welcome") continue;
    const idx = steps.indexOf(step);
    const prior = steps.slice(1, idx); // welcome never gates
    if (!prior.every((s) => stepComplete(s, data))) return step;
    if (!stepComplete(step, data) && step !== "review") return step;
  }
  return "review";
}

/** Clamp a requested step to what the draft's data actually allows. A step
 * branched away by the answers resolves to the gate (fail safe). */
export function resolveStep(requested: string | undefined, data: DraftData): FlowStep {
  const target = isFlowStep(requested) ? requested : "welcome";
  if (target === "welcome") return "welcome";
  const steps = visibleSteps(data.answers);
  const gate = firstIncompleteStep(data);
  if (!steps.includes(target)) return gate;
  return steps.indexOf(target) <= steps.indexOf(gate) ? target : gate;
}

// ── Answers → classifier input (the EXISTING classifier; input composition only) ──
/** Honest hint words aligned with the catalogue's own classificationKeywords —
 * the industry answer is a strong signal, patterns/capabilities are light ones. */
export const INDUSTRY_HINTS: Record<Industry, string> = {
  construction: "construction contracting",
  professional_services: "consulting professional services office",
  retail_ecommerce: "online store e-commerce retail",
  wholesale_distribution: "wholesale distribution supply trading",
  manufacturing: "manufacturing fabrication workshop",
  hospitality_food: "catering food production kitchen restaurant",
  real_estate: "property real estate maintenance",
  transport_logistics: "logistics transport fleet delivery",
  healthcare: "clinic healthcare wellness",
  education: "training education courses",
  technology: "software technology digital",
  financial_services: "financial services accounting office",
  media_creative: "creative media studio design",
  field_services: "maintenance repair field service",
  agriculture: "farm agriculture crops",
  nonprofit: "organization nonprofit community",
  other_mixed: "",
  // Legacy stored values (H15 drafts) keep their original classifier hints.
  marine: "marine boatyard",
  food_beverage: "catering food production kitchen",
  retail_online: "online store e-commerce fulfilment",
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
    // H15 journey signals (same honest, catalogue-aligned hint words).
    a.buys_materials === "yes" ? "purchasing suppliers" : "",
    a.holds_stock === "yes" ? "inventory stock" : "",
    a.receives_deliveries === "yes" ? "goods receiving" : "",
    a.tracks_costs === "yes" ? "costing" : "",
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
    // The chosen language leads; the blueprint-required pair always follows, so
    // an organisation founded in Spanish can still author its own labels in the
    // two languages every stored blueprint must carry (workspace law 17).
    languages: [
      ...new Set([
        ...(a.preferred_language ? [a.preferred_language] : []),
        ...BLUEPRINT_REQUIRED_LOCALES,
      ]),
    ],
    six_day_week: false,
    // H15: asked on the money step; "not sure" resolves to the safe default.
    vat_registered: a.vat_registered_q === "yes",
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

/** The sharing answer with its safe default (asked on the customers step). */
export function effectiveCustomerSharing(a: DraftAnswers): boolean {
  return a.customer_sharing ?? false;
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
    language: Locale;
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
