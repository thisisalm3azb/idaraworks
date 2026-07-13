/**
 * Closed, code-owned registries — the ONLY place enum-like domain vocabularies live.
 * BUILD_BIBLE §3.6: one file, one owner. Tenants and templates map onto these;
 * nothing tenant-authored extends them (phase2/02 "Registry, not strings").
 *
 * Every list here traces to a frozen spec section (cited inline). Adding a value
 * is a reviewed change; removing one is a migration.
 */

// ── Operational object (phase2/02, freeze FR-3) ─────────────────────────────
export const CONTAINER_KINDS = ["job"] as const; // P4+: union grows via the §8.3 rule only
export type ContainerKind = (typeof CONTAINER_KINDS)[number];

// ── Semantic anchors (phase2/02, v2 §8 E4) ──────────────────────────────────
export const STATUS_CATEGORIES = ["draft", "active", "on_hold", "done", "cancelled"] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export const PHASE_SEMANTICS = [
  "preparation",
  "production",
  "finishing",
  "verification",
  "handover",
] as const;
export type PhaseSemantic = (typeof PHASE_SEMANTICS)[number];

/**
 * Audit F-19: engines may consume ONLY these two predicates, never the raw
 * PhaseSemantic enum — so the phase vocabulary can be re-cut at template #2/#3
 * authoring without touching engine code.
 */
export function isReportable(phase: PhaseSemantic | null): boolean {
  return phase === "production" || phase === "finishing" || phase === "verification";
}
export function isPreFinal(phase: PhaseSemantic | null): boolean {
  return phase === "preparation" || phase === "production";
}

// ── Approvals (phase2/05 D-5.3, OP-7 closure) ───────────────────────────────
export const APPROVABLE_TYPES = [
  "material_request",
  "expense",
  "quote_send",
  "purchase_order", // MR-less or over-threshold only (audit F-3)
  "payment", // org-configurable modes: none / always / amount_gte (OP-7)
  // P3 (with QC): "stage_signoff", "qc_delivery_override"
] as const;
export type ApprovableType = (typeof APPROVABLE_TYPES)[number];

// ── Attachment engines (phase2/02 D-2.1) ────────────────────────────────────
export const ATTACHABLE_TYPES = [
  "job",
  "job_stage",
  "task",
  "daily_report",
  "issue",
  "material_request",
  "purchase_order",
  "goods_receipt",
  "expense",
  "quote",
  "invoice",
  "payment",
  "customer",
  "supplier",
  "employee",
] as const;
export type AttachableType = (typeof ATTACHABLE_TYPES)[number];

/**
 * Entity types that may appear on an audit_log row (doc 01 D-1.8). A superset of
 * ATTACHABLE_TYPES with the platform-audit-only entities that carry no file
 * attachments but are still security/config-audited (org lifecycle, membership).
 * The audit_log.entity_type column is registry-typed in app against THIS list.
 */
export const AUDIT_ENTITY_TYPES = [
  ...ATTACHABLE_TYPES,
  "org",
  "membership",
  "membership_invite",
  "file", // Phase E: void / legal-hold are audited file mutations (D-1.7)
  "config", // Phase F: config-artifact revisions are audited (D-1.8)
  "team", // S1 masters — no file attachments in MVP, but audited
  "item", // S1 catalog — audited (costs are financial config)
  "attendance", // S3 — the manual grid mark is an audited HR mutation (no files)
  "approval", // S4 — the decision record (submit/decide/withdraw are audited)
  "approval_rule", // S4 — rule edits are config-audited
  "exception", // S5 — user dismiss/resolve is an audited mutation (engine raise/auto-clear is a materialized derivation, not audited)
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

// ── File access classes (doc 01 Appendix A, audit F-23) ─────────────────────
export const FILE_ACCESS_CLASSES = [
  "job_media", // job-visibility roles; thumbnails on list surfaces
  "financial_doc", // requires finance.viewPrices; originals retained
  "hr_doc", // privileged bucket; originals retained
  "customer_share", // watermarked derivative behind the share-token surface
] as const;
export type FileAccessClass = (typeof FILE_ACCESS_CLASSES)[number];

// ── Role archetypes (phase2/06; Worker reserved for P3 per audit F-17) ──────
export const ROLE_ARCHETYPES = [
  "owner",
  "admin",
  "manager",
  "foreman",
  "procurement",
  "accounts",
  "viewer",
  "worker_reserved_p3",
] as const;
export type RoleArchetype = (typeof ROLE_ARCHETYPES)[number];

export const MVP_GRANTABLE_ARCHETYPES = [
  "owner",
  "admin",
  "manager",
  "foreman",
  "procurement",
  "accounts",
  "viewer",
] as const satisfies readonly RoleArchetype[];

// ── Currencies (freeze OP-8 closure, 2026-07-11) ────────────────────────────
/** Minor-unit exponents: KWD/BHD/OMR are 3-decimal currencies (doc 01 D-1.3). */
export const CURRENCIES = {
  AED: { exponent: 2 },
  SAR: { exponent: 2 },
  QAR: { exponent: 2 },
  KWD: { exponent: 3 },
  BHD: { exponent: 3 },
  OMR: { exponent: 3 },
  USD: { exponent: 2 },
  EUR: { exponent: 2 },
} as const;
export type CurrencyCode = keyof typeof CURRENCIES;
export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];
export function minorUnitExponent(code: CurrencyCode): number {
  return CURRENCIES[code].exponent;
}

// ── Issues (phase2/01; audit C-8: "blocking" is the flag, not a severity) ───
export const ISSUE_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

// ── Exceptions (phase2/04) ──────────────────────────────────────────────────
export const EXCEPTION_SEVERITIES = ["info", "warning", "critical"] as const;
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITIES)[number];

// ── Terminology key catalogue (phase2/07, audit C-9) ────────────────────────
export const TERM_KEYS = [
  "job",
  "job_stage",
  "daily_report",
  "material_request",
  "purchase_order",
  "goods_receipt",
  "expense",
  "payment",
  "task",
  "issue",
  "customer",
  "supplier",
  "employee",
  "team",
  "quote",
  "invoice",
] as const;
export type TermKey = (typeof TERM_KEYS)[number];
const TERM_KEY_SET: ReadonlySet<string> = new Set(TERM_KEYS);
export function isTermKey(key: string): key is TermKey {
  return TERM_KEY_SET.has(key);
}

// ── Languages ────────────────────────────────────────────────────────────────
export const SUPPORTED_LOCALES = ["en", "ar"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

// ── Notification kinds (doc 01 F-12; Phase F substrate) ─────────────────────
// Closed registry; later slices add their kinds (e.g. 'approval.requested',
// 'report.returned') with the surfaces that emit them — one file, one owner.
export const NOTIFICATION_KINDS = [
  "system",
  "approval_requested", // S4 — pushed to the assigned role's members on submission
  "approval_decided", // S4 — pushed to the requester on approve/reject
  "exception_raised", // S5 — pushed to a raised exception's audience (redacted body, F-23)
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
