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
  "task_completion", // H21 — a task marked requires_approval finishes through the inbox
  "asset_disposal", // H22E — taking an owned thing off the books needs a second person
  // H23 — HR and payroll route through the same engine as everything else.
  "leave_request",
  "overtime_request",
  "expense_claim",
  "pay_run",
  "journal_entry", // H24 — optional approval before posting (engine never touches its status)
  "scenario_apply", // H25 — applying a scenario to live records (studio checks the state itself)
  "document_step",
  "crm_discount", // H27 — a commercial exception (discount) needs a second person // H26 — one step of a document workflow run; the run advances in afterDecide
  "ai_action", // H28 — a material action proposed by an agent needs a second person before it may execute
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
  "asset", // H22E — photographs, manuals, warranty certificates, disposal evidence
  "leave_request", // H23 — medical certificates and supporting documents
  "expense_claim", // H23 — receipts on claim lines
  "overtime_request", // H23 — activity-feed identity; no file surface shipped
  "pay_run", // H23 — activity-feed identity; no file surface shipped
  "journal_entry", // H24 — supporting evidence attaches to journals
  "studio_plan", // H25 — reference documents attach to a plan
  "studio_node", // H25 — evidence and documents attach to canvas nodes
  "studio_scenario", // H25G — decision evidence attaches to a scenario; its lifecycle shows in activity
  "document", // H26 — supporting papers and signed scans attach to an authored document
  "ai_conversation", // H28 — files a person chose to share with the Idara Dock (existing file rows only)
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
  "agent", // H12: agent-run audit records (correlation id as entity id)
  "attendance", // S3 — the manual grid mark is an audited HR mutation (no files)
  "approval", // S4 — the decision record (submit/decide/withdraw are audited)
  "approval_rule", // S4 — rule edits are config-audited
  "exception", // S5 — user dismiss/resolve is an audited mutation (engine raise/auto-clear is a materialized derivation, not audited)
  "customer_update", // S7 — draft/edit/send are audited customer-facing mutations
  "share_token", // S7 — mint/revoke of a public share link are audited
  "onboarding_session", // S8 — propose/apply/undo of a guided onboarding are audited config mutations
  "payslip", // H23 — issuance is audited; the slip itself is immutable
  "import_batch", // S8 — guided CSV imports (customers/employees/items) are audited
  "workspace_blueprint", // H14 — blueprint lifecycle (draft/validate/approve/reject/apply/undo)
  "lead", // H20 — pre-customer sales records (create/update/status/convert/archive)
  "opportunity", // H20 — pipeline records (create/update/stage/won/lost/quote-link)
  "sales_activity", // H20 — follow-up completion is an audited mutation
  "document_share", // H22.0 — minting and revoking a document link (never the token itself)
  "week_plan", // H22.0 — the weekly plan record (issue / revise / cancel)
  "stock_movement", // H22B — every posting to the stock ledger, and its reversals
  "warehouse", // H22A — warehouses and the locations inside them
  "unit_of_measure", // H22A — units and their conversion factors
  "asset", // H22E — the register, its custody history, maintenance and disposal
  "mileage_rate", // H23E — org mileage-rate config edits are audited money config
  "cash_advance", // H23E — record/settle of a cash advance is an audited money mutation
  "employee_loan", // H23D/E — loan creation and status flips are audited money mutations
  "gl_account", // H24 — chart edits are audited financial config
  "fiscal_year", // H24 — fiscal calendar mutations are audited
  "fiscal_period", // H24 — close/lock/reopen are audited control events
  "cost_centre", // H24 — dimension master edits are audited
  "bank_account", // H24E — bank/cash account config is audited money config
  "bank_statement", // H24E — statement import/void is audited
  "bank_reconciliation", // H24E — reconciliation lifecycle is audited
  "tax_code", // H24H — tax configuration is audited
  "tax_return", // H24H — working-paper lifecycle is audited
  "budget", // H24G — budget lifecycle is audited
  "currency_rate", // H24G — rate book entries are audited money config
  "asset_depreciation_run", // H24F — depreciation runs are audited
  "tally_import", // H24J — migration batches are audited
  // H25 — every studio record's lifecycle is audited.
  "studio_edge",
  "studio_view",
  "studio_scenario",
  "studio_baseline",
  "studio_version",
  // H25H — skills and task allocations are audited like any master/work row.
  "skill",
  "employee_skill",
  "task_allocation",
  // H26 — the Document Studio: every governed record's lifecycle is audited.
  "document_template",
  "document_workflow",
  "document_folder",
  "document_view",
  "document_comment",
  "document_signature",
  "document_form",
  // H27 — CRM satellites (audit identity only)
  "crm_pipeline",
  "crm_campaign",
  "crm_territory",
  "crm_target",
  "crm_consent",
  "crm_merge",
  "crm_automation",
  "crm_scenario",
  "crm_forecast_snapshot",
  "crm_discount",
  "crm_deal_canvas",
  "customer_contact",
  "document_obligation",
  // H28 — Idara Intelligence
  "ai_conversation",
  "ai_run",
  "ai_action",
  "ai_agent",
  "ai_memory",
  "ai_schedule",
  "ai_entitlement",
  "ai_privacy_register",
  "ai_byok_key",
  "ai_saved_output",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

// ── File access classes (doc 01 Appendix A, audit F-23) ─────────────────────
export const FILE_ACCESS_CLASSES = [
  "job_media", // job-visibility roles; thumbnails on list surfaces
  "financial_doc", // requires finance.viewPrices; originals retained
  "hr_doc", // privileged bucket; originals retained
  "customer_share", // watermarked derivative behind the share-token surface
  "document_file", // H26 — papers on an authored document; read = documents.view, write = documents.edit
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
  "payslip_issued", // H23H — pushed to the employee's linked login on finalize (no amounts, F-23)
  // H26 — document lifecycle pushes (titles and references only; never body text or amounts).
  "document_review_requested",
  "document_signature_requested",
  "document_signed",
  "document_obligation_due",
  // H27 — CRM pushes (titles and references only; never amounts).
  "crm_lead_assigned",
  "crm_follow_up_due",
  "crm_opportunity_stalled",
  "crm_discount_requested",
  "crm_customer_at_risk",
  "crm_renewal_due",
  // H28 — Idara pushes (titles and references only; never amounts or model text).
  "idara_alert",
  "idara_action_waiting",
  "idara_run_finished",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
