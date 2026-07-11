/**
 * The entitlement catalogue — the closed, code-owned source of truth for every
 * entitlement key (doc 09 §A; BUILD_BIBLE §3.6 registry discipline). The 0005
 * migration seeds entitlement_def from exactly these keys; an integration test
 * asserts DB ⇔ code parity so the two never drift.
 *
 * FEATURE keys gate capability/behaviour (boolean). LIMIT keys are numeric caps
 * (null = unlimited). PRICING NUMBERS are open (OP-2/D3) — plan *values* are
 * documented hypotheses (doc 09); the keys here are final.
 */

// ── Feature keys (capability gates + behaviour) ──────────────────────────────
export const FEATURE_KEYS = [
  // capabilities (MVP loop)
  "cap.jobs",
  "cap.daily_reports",
  "cap.issues",
  "cap.approvals",
  "cap.procurement",
  "cap.quoting",
  "cap.invoicing",
  "cap.expenses_costing",
  "cap.customers",
  "cap.people",
  "cap.customer_updates",
  // behaviour
  "feat.ai_onboarding",
  "feat.ai_narration",
  "feat.ai_drafts",
  "feat.custom_fields",
  "feat.org_terminology_overrides",
  "feat.audit_export",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

// ── Limit keys (numeric caps; null = unlimited) ──────────────────────────────
export const LIMIT_KEYS = [
  "limit.full_users",
  "limit.field_users",
  "limit.viewer_users",
  "limit.active_jobs",
  "limit.storage_gb",
  "limit.ai_credits_month",
  "limit.custom_fields_per_entity",
  "limit.presets",
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export type EntitlementKey = FeatureKey | LimitKey;

const FEATURE_SET = new Set<string>(FEATURE_KEYS);
const LIMIT_SET = new Set<string>(LIMIT_KEYS);

export function isFeatureKey(key: string): key is FeatureKey {
  return FEATURE_SET.has(key);
}
export function isLimitKey(key: string): key is LimitKey {
  return LIMIT_SET.has(key);
}

// ── Plans (doc 09 tier hypotheses — VALUES are placeholders pending OP-2/D3) ──
export type PlanKey = "starter" | "growth" | "business";
export const PLAN_KEYS: readonly PlanKey[] = ["starter", "growth", "business"];

/** New orgs default to a full-featured Growth trial (v1 §13 documented design). */
export const DEFAULT_PLAN: PlanKey = "growth";
