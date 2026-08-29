/**
 * H15 Intelligent Clay journey engine — the ONE deterministic question and
 * recommendation engine (Part D). Pure: no DB, no ctx, no clock, no
 * randomness. The same answers at the same JOURNEY_VERSION always produce
 * the same journey, and every inclusion decision carries its reason.
 *
 * This engine SELECTS and EXPLAINS; it never compiles a workspace — the H14
 * blueprint contract (src/platform/workspace) stays the single compiler.
 * blueprint-map.ts turns the answers this engine gathered into H14 blueprint
 * input; nothing else interprets answers.
 *
 * Versioning and safety:
 *  - JOURNEY_VERSION stamps every draft; a draft from another version resumes
 *    at its first incomplete step with still-valid answers preserved.
 *  - Unknown question keys and unknown stored answers fail SAFE: they are
 *    reported as invalidated, never silently kept or crashed on.
 */
import {
  askCollectsPayments,
  askDepartments,
  askMaterialsStep,
  askReceivesDeliveries,
  askTracksCosts,
  askUsersBand,
  askWorkflowDescription,
  visibleSteps,
  JOURNEY_VERSION,
  type DraftAnswers,
  type FlowStep,
} from "./flow";

export { JOURNEY_VERSION };

export type QuestionKey =
  | "business_name"
  | "legal_name"
  | "industry"
  | "business_description"
  | "country"
  | "timezone"
  | "base_currency"
  | "preferred_language"
  | "customer_types"
  | "work_intake"
  | "customer_sharing"
  | "work_patterns"
  | "workflow_description"
  | "employees_band"
  | "users_band"
  | "locations_band"
  | "departments"
  | "buys_materials"
  | "holds_stock"
  | "receives_deliveries"
  | "revenue_models"
  | "sends_quotes"
  | "sends_invoices"
  | "collects_payments"
  | "records_expenses"
  | "tracks_costs"
  | "vat_registered_q"
  | "priority_focus"
  | "device"
  | "main_problem";

export type QuestionDef = {
  key: QuestionKey;
  step: FlowStep;
  /** i18n suffix under onboarding.journey.q.<key>.* (label/help/why). */
  required: boolean;
  /** Which H14 blueprint areas this answer shapes (documentation + tests). */
  shapes: readonly (
    | "profile"
    | "capabilities"
    | "terminology"
    | "workflows"
    | "roles"
    | "navigation"
    | "dashboards"
    | "international"
    | "agents"
    | "organization"
    | "branding_only"
  )[];
  /** Deterministic visibility in the answers gathered so far. */
  visible: (a: DraftAnswers) => boolean;
  /** i18n key suffix explaining WHY the question is asked when shown
   * conditionally (recorded per Part D "record why each question was
   * included"; always-on questions use "core"). */
  includedBecause: string;
};

const always = () => true;

/** The complete H15 question registry — canonical keys, one decision each. */
export const QUESTIONS: readonly QuestionDef[] = [
  {
    key: "business_name",
    step: "business",
    required: true,
    shapes: ["organization", "profile"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "legal_name",
    step: "business",
    required: false,
    shapes: ["branding_only"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "industry",
    step: "business",
    required: true,
    shapes: ["profile", "capabilities", "workflows"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "business_description",
    step: "business",
    required: false,
    shapes: ["profile", "workflows"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "country",
    step: "region",
    required: true,
    shapes: ["international", "organization"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "timezone",
    step: "region",
    required: true,
    shapes: ["international", "organization"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "base_currency",
    step: "region",
    required: true,
    shapes: ["international", "organization"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "preferred_language",
    step: "region",
    required: true,
    shapes: ["international", "terminology"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "customer_types",
    step: "customers",
    required: true,
    shapes: ["profile"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "work_intake",
    step: "customers",
    required: false,
    shapes: ["profile"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "customer_sharing",
    step: "customers",
    required: true,
    shapes: ["capabilities"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "work_patterns",
    step: "work",
    required: true,
    shapes: ["profile", "capabilities", "workflows"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "workflow_description",
    step: "work",
    required: false,
    shapes: ["workflows"],
    visible: askWorkflowDescription,
    includedBecause: "engagement_flow",
  },
  {
    key: "employees_band",
    step: "scale",
    required: true,
    shapes: ["profile", "roles"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "users_band",
    step: "scale",
    required: true,
    shapes: ["roles"],
    visible: askUsersBand,
    includedBecause: "team_size",
  },
  {
    key: "locations_band",
    step: "scale",
    required: true,
    shapes: ["profile"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "departments",
    step: "scale",
    required: false,
    shapes: ["roles"],
    visible: askDepartments,
    includedBecause: "team_size",
  },
  {
    key: "buys_materials",
    step: "materials",
    required: true,
    shapes: ["capabilities", "roles"],
    visible: askMaterialsStep,
    includedBecause: "physical_work",
  },
  {
    key: "holds_stock",
    step: "materials",
    required: true,
    shapes: ["capabilities"],
    visible: askMaterialsStep,
    includedBecause: "physical_work",
  },
  {
    key: "receives_deliveries",
    step: "materials",
    required: true,
    shapes: ["capabilities"],
    visible: (a) => askMaterialsStep(a) && askReceivesDeliveries(a),
    includedBecause: "buys_materials",
  },
  {
    key: "revenue_models",
    step: "money",
    required: false,
    shapes: ["profile"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "sends_quotes",
    step: "money",
    required: true,
    shapes: ["capabilities"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "sends_invoices",
    step: "money",
    required: true,
    shapes: ["capabilities", "roles"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "collects_payments",
    step: "money",
    required: true,
    shapes: ["capabilities"],
    visible: askCollectsPayments,
    includedBecause: "sends_invoices",
  },
  {
    key: "records_expenses",
    step: "money",
    required: true,
    shapes: ["capabilities"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "tracks_costs",
    step: "money",
    required: true,
    shapes: ["capabilities"],
    visible: askTracksCosts,
    includedBecause: "engagement_flow",
  },
  {
    key: "vat_registered_q",
    step: "money",
    required: true,
    shapes: ["international"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "priority_focus",
    step: "priorities",
    required: true,
    shapes: ["dashboards"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "device",
    step: "priorities",
    required: true,
    shapes: ["navigation"],
    visible: always,
    includedBecause: "core",
  },
  {
    key: "main_problem",
    step: "priorities",
    required: false,
    shapes: ["dashboards"],
    visible: always,
    includedBecause: "core",
  },
] as const;

export function questionsForStep(step: FlowStep, a: DraftAnswers): QuestionDef[] {
  return QUESTIONS.filter((q) => q.step === step && q.visible(a));
}

/** The whole visible journey for these answers, in step order. Deterministic:
 * a pure fold over the registry (tested for input-identity determinism). */
export function visibleQuestions(a: DraftAnswers): QuestionDef[] {
  const steps = visibleSteps(a);
  return QUESTIONS.filter((q) => steps.includes(q.step) && q.visible(a));
}

/**
 * Answers invalidated by a branch change (Part D): keys that HAVE a stored
 * value but are no longer part of the visible journey after `next` replaced
 * `prev`. The flow drops them from storage; callers surface the list so the
 * founder sees exactly what a changed earlier answer retired — user input is
 * never silently discarded.
 */
export function invalidatedAnswers(prev: DraftAnswers, next: DraftAnswers): QuestionKey[] {
  const nowVisible = new Set(visibleQuestions(next).map((q) => q.key));
  const out: QuestionKey[] = [];
  for (const q of QUESTIONS) {
    const had = (prev as Record<string, unknown>)[q.key] !== undefined;
    if (had && !nowVisible.has(q.key)) out.push(q.key);
  }
  return out;
}

/** Fail-safe check for stored answers from an unknown/newer journey: any
 * stored key outside the registry is reported (and ignored by the mappers). */
export function unknownAnswerKeys(stored: Record<string, unknown>): string[] {
  const known = new Set<string>(QUESTIONS.map((q) => q.key));
  return Object.keys(stored).filter((k) => !known.has(k) && k !== "capabilities");
}
