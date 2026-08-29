/**
 * Intelligent Clay workspace registries (H14).
 *
 * Closed vocabularies for the workspace blueprint. Everything here NAMES
 * existing platform truth — it never grants anything:
 *  - modules are the ENFORCED capability keys from the entitlement catalogue,
 *  - nav item keys mirror the U5 nav builder's IA (parity-tested against
 *    buildNavGroups, the shipped decider),
 *  - dashboard card keys mirror composeToday's real card keys (parity-tested
 *    against the module source),
 *  - country packs encode what the product actually does per market today
 *    (org country/timezone/currency, bilingual documents, tax registration
 *    identity) — packs are data, never a fork, and carry no security fields
 *    so they can add requirements but never weaken security (law 15).
 *
 * Same closed-registry discipline as src/platform/registries.ts: values are
 * added here deliberately, with tests, never invented at runtime.
 */
import type { FeatureKey } from "@/platform/entitlements";
import type { Action } from "@/platform/authz";
import type { RoleArchetype, TermKey, Locale, CurrencyCode } from "@/platform/registries";

// ── Business profile vocabulary ──────────────────────────────────────────────
export const BUSINESS_MODELS = [
  "services",
  "projects",
  "products",
  "retail",
  "manufacturing",
  "trading",
  "mixed",
] as const;
export type BusinessModel = (typeof BUSINESS_MODELS)[number];

export const WORK_DELIVERY_MODELS = [
  "site_work",
  "projects",
  "continuous_operations",
  "orders",
  "appointments",
] as const;
export type WorkDeliveryModel = (typeof WORK_DELIVERY_MODELS)[number];

export const REVENUE_MODELS = [
  "fixed_price",
  "time_and_materials",
  "product_sales",
  "recurring",
  "milestone_billing",
] as const;
export type RevenueModel = (typeof REVENUE_MODELS)[number];

export const CUSTOMER_TYPES = ["businesses", "consumers", "government", "mixed"] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const OPERATING_MODES = ["physical", "digital", "mixed"] as const;
export type OperatingMode = (typeof OPERATING_MODES)[number];

/** Mirrors the onboarding flow's EMPLOYEE_BANDS (parity-tested). */
export const ORG_SIZE_BANDS = ["1-5", "6-20", "21-50", "51-200", "200+"] as const;
export type OrgSizeBand = (typeof ORG_SIZE_BANDS)[number];

// ── Modules: the enforced capability keys ────────────────────────────────────
/**
 * The workspace-selectable modules. Exactly the ENFORCED cap.* keys from the
 * entitlement catalogue (the legacy coarse keys cap.procurement /
 * cap.expenses_costing stay seeded for compatibility but are not modules).
 * Presence here is naming, not granting: the entitlement system remains the
 * only authority on what a plan includes.
 */
export const WORKSPACE_MODULE_KEYS = [
  "cap.jobs",
  "cap.daily_reports",
  "cap.issues",
  "cap.approvals",
  "cap.quoting",
  "cap.invoicing",
  "cap.payments",
  "cap.expenses",
  "cap.costing",
  "cap.customers",
  "cap.people",
  "cap.customer_updates",
  "cap.attendance",
  "cap.material_requests",
  "cap.purchase_orders",
  "cap.goods_receipts",
  "cap.items",
] as const satisfies readonly FeatureKey[];
export type WorkspaceModuleKey = (typeof WORKSPACE_MODULE_KEYS)[number];
export function isWorkspaceModuleKey(x: string): x is WorkspaceModuleKey {
  return (WORKSPACE_MODULE_KEYS as readonly string[]).includes(x);
}

export type ModuleInfo = {
  /** Every module here gates a shipped production surface. */
  availability: "shipped";
  /** The entitlement key the plan must include — always the module key itself. */
  entitlement: FeatureKey;
  /** Hard dependencies: enabling this module requires these enabled too. */
  requires: readonly WorkspaceModuleKey[];
  /** Softer pairings surfaced as warnings, never errors. */
  recommends: readonly WorkspaceModuleKey[];
  /** Canonical terminology entities this module speaks about. */
  termKeys: readonly TermKey[];
};

export const MODULE_INFO: Record<WorkspaceModuleKey, ModuleInfo> = {
  "cap.jobs": {
    availability: "shipped",
    entitlement: "cap.jobs",
    requires: [],
    recommends: ["cap.daily_reports"],
    termKeys: ["job", "job_stage", "task"],
  },
  "cap.daily_reports": {
    availability: "shipped",
    entitlement: "cap.daily_reports",
    requires: ["cap.jobs"],
    recommends: ["cap.issues"],
    termKeys: ["daily_report"],
  },
  "cap.issues": {
    availability: "shipped",
    entitlement: "cap.issues",
    requires: [],
    recommends: [],
    termKeys: ["issue"],
  },
  "cap.approvals": {
    availability: "shipped",
    entitlement: "cap.approvals",
    requires: [],
    recommends: [],
    termKeys: [],
  },
  "cap.quoting": {
    availability: "shipped",
    entitlement: "cap.quoting",
    requires: ["cap.customers"],
    recommends: ["cap.invoicing"],
    termKeys: ["quote"],
  },
  "cap.invoicing": {
    availability: "shipped",
    entitlement: "cap.invoicing",
    requires: ["cap.customers"],
    recommends: ["cap.payments"],
    termKeys: ["invoice"],
  },
  "cap.payments": {
    availability: "shipped",
    entitlement: "cap.payments",
    requires: ["cap.invoicing"],
    recommends: [],
    termKeys: ["payment"],
  },
  "cap.expenses": {
    availability: "shipped",
    entitlement: "cap.expenses",
    requires: [],
    recommends: ["cap.costing"],
    termKeys: ["expense"],
  },
  "cap.costing": {
    availability: "shipped",
    entitlement: "cap.costing",
    requires: ["cap.jobs"],
    recommends: ["cap.expenses"],
    termKeys: [],
  },
  "cap.customers": {
    availability: "shipped",
    entitlement: "cap.customers",
    requires: [],
    recommends: [],
    termKeys: ["customer"],
  },
  "cap.people": {
    availability: "shipped",
    entitlement: "cap.people",
    requires: [],
    recommends: ["cap.attendance"],
    termKeys: ["employee", "team"],
  },
  "cap.customer_updates": {
    availability: "shipped",
    entitlement: "cap.customer_updates",
    requires: ["cap.customers", "cap.jobs"],
    recommends: [],
    termKeys: [],
  },
  "cap.attendance": {
    availability: "shipped",
    entitlement: "cap.attendance",
    requires: ["cap.people"],
    recommends: [],
    termKeys: [],
  },
  "cap.material_requests": {
    availability: "shipped",
    entitlement: "cap.material_requests",
    requires: ["cap.jobs"],
    recommends: ["cap.purchase_orders"],
    termKeys: ["material_request"],
  },
  "cap.purchase_orders": {
    availability: "shipped",
    entitlement: "cap.purchase_orders",
    requires: [],
    recommends: ["cap.goods_receipts", "cap.items"],
    termKeys: ["purchase_order", "supplier"],
  },
  "cap.goods_receipts": {
    availability: "shipped",
    entitlement: "cap.goods_receipts",
    requires: ["cap.purchase_orders"],
    recommends: [],
    termKeys: ["goods_receipt"],
  },
  "cap.items": {
    availability: "shipped",
    entitlement: "cap.items",
    requires: [],
    recommends: [],
    termKeys: [],
  },
};

// ── Navigation item keys (parity-tested against the U5 nav builder) ─────────
/**
 * The stable nav vocabulary a blueprint may reference. The nav BUILDER
 * (src/platform/ui/nav/build.ts) remains the access decider: `can()` decides
 * whether an item exists for a role and the entitlement decides its entitled
 * state. Blueprint navigation is PRESENTATION over that law — ordering and
 * hiding only, never adding (law 6: preferences change presentation, never
 * authority). `action`/`feature`/`module` here mirror the builder for the
 * compiler's read-only model and are pinned by parity tests.
 */
export const NAV_ITEM_KEYS = [
  "today",
  "jobs",
  "week",
  "report_new",
  "reports_review",
  "issues",
  "approvals",
  "attendance",
  "material_requests",
  "purchase_orders",
  "items",
  "suppliers",
  "quotes",
  "invoices",
  "payments",
  "expenses",
  "costing",
  "ar",
  "customers",
  "customer_updates",
  "people",
  "members",
  "imports",
  "exports",
  "onboarding",
  "configuration",
  "branding",
  "notifications",
  "subscription",
] as const;
export type NavItemKey = (typeof NAV_ITEM_KEYS)[number];
export function isNavItemKey(x: string): x is NavItemKey {
  return (NAV_ITEM_KEYS as readonly string[]).includes(x);
}

export type NavItemInfo = {
  /** The authz action the builder gates the item on (null = always visible). */
  action: Action | null;
  /** The entitlement feature the builder gates the item on. */
  feature: FeatureKey | null;
  /** The module this item belongs to for configuration purposes. */
  module: WorkspaceModuleKey | null;
  /** Items a blueprint may never hide (the workspace's safety rails). */
  alwaysVisible: boolean;
};

export const NAV_ITEM_INFO: Record<NavItemKey, NavItemInfo> = {
  today: { action: null, feature: null, module: null, alwaysVisible: true },
  jobs: { action: "jobs.view", feature: null, module: "cap.jobs", alwaysVisible: false },
  week: { action: "week.view", feature: null, module: "cap.jobs", alwaysVisible: false },
  report_new: {
    action: "reports.create",
    feature: null,
    module: "cap.daily_reports",
    alwaysVisible: false,
  },
  reports_review: {
    action: "reports.review",
    feature: null,
    module: "cap.daily_reports",
    alwaysVisible: false,
  },
  issues: { action: "issues.raise", feature: null, module: "cap.issues", alwaysVisible: false },
  approvals: {
    action: "approvals.decide",
    feature: null,
    module: "cap.approvals",
    alwaysVisible: false,
  },
  attendance: {
    action: "attendance.view",
    feature: "cap.attendance",
    module: "cap.attendance",
    alwaysVisible: false,
  },
  material_requests: {
    action: "mr.create",
    feature: "cap.material_requests",
    module: "cap.material_requests",
    alwaysVisible: false,
  },
  purchase_orders: {
    action: "po.view",
    feature: "cap.purchase_orders",
    module: "cap.purchase_orders",
    alwaysVisible: false,
  },
  items: { action: "catalog.view", feature: null, module: "cap.items", alwaysVisible: false },
  suppliers: {
    action: "catalog.view",
    feature: null,
    module: "cap.purchase_orders",
    alwaysVisible: false,
  },
  quotes: {
    action: "quotes.view",
    feature: "cap.quoting",
    module: "cap.quoting",
    alwaysVisible: false,
  },
  invoices: {
    action: "invoices.view",
    feature: "cap.invoicing",
    module: "cap.invoicing",
    alwaysVisible: false,
  },
  payments: {
    action: "payments.view",
    feature: "cap.payments",
    module: "cap.payments",
    alwaysVisible: false,
  },
  expenses: {
    action: "expenses.view",
    feature: "cap.expenses",
    module: "cap.expenses",
    alwaysVisible: false,
  },
  costing: {
    action: "costing.view",
    feature: "cap.costing",
    module: "cap.costing",
    alwaysVisible: false,
  },
  ar: { action: "ar.view", feature: null, module: "cap.invoicing", alwaysVisible: false },
  customers: {
    action: "customers.view",
    feature: null,
    module: "cap.customers",
    alwaysVisible: false,
  },
  customer_updates: {
    action: "customer_updates.draft",
    feature: "cap.customer_updates",
    module: "cap.customer_updates",
    alwaysVisible: false,
  },
  people: { action: "employees.view", feature: null, module: "cap.people", alwaysVisible: false },
  members: { action: "members.view", feature: null, module: null, alwaysVisible: true },
  imports: {
    action: "imports.manage",
    feature: "feat.data_import",
    module: null,
    alwaysVisible: false,
  },
  exports: { action: "data.export", feature: null, module: null, alwaysVisible: false },
  onboarding: { action: "onboarding.run", feature: null, module: null, alwaysVisible: true },
  configuration: { action: "config.view", feature: null, module: null, alwaysVisible: true },
  branding: { action: "config.manage", feature: null, module: null, alwaysVisible: false },
  notifications: { action: "members.view", feature: null, module: null, alwaysVisible: false },
  subscription: { action: "billing.view", feature: null, module: null, alwaysVisible: true },
};

// ── Dashboard card keys (parity-tested against composeToday) ────────────────
export const DASHBOARD_CARD_KEYS = [
  "my_jobs_today",
  "submit_daily_report",
  "waiting_on_me",
  "missing_reports",
  "overdue",
  "blockers",
  "reports_to_review",
  "missing_today",
  "invoices_to_issue",
  "overdue_receivables",
  "ar_summary",
  "payments_week",
  "expenses_queue",
  "needs_decision",
  "at_risk",
  "collections",
  "approved_mrs",
  "open_pos",
] as const;
export type DashboardCardKey = (typeof DASHBOARD_CARD_KEYS)[number];
export function isDashboardCardKey(x: string): x is DashboardCardKey {
  return (DASHBOARD_CARD_KEYS as readonly string[]).includes(x);
}

/** The module a card depends on (null = part of the always-on core loop). */
export const DASHBOARD_CARD_MODULE: Record<DashboardCardKey, WorkspaceModuleKey | null> = {
  my_jobs_today: null,
  submit_daily_report: null,
  waiting_on_me: null,
  missing_reports: null,
  overdue: null,
  blockers: null,
  reports_to_review: null,
  missing_today: null,
  invoices_to_issue: "cap.invoicing",
  overdue_receivables: "cap.invoicing",
  ar_summary: "cap.invoicing",
  payments_week: "cap.payments",
  expenses_queue: "cap.expenses",
  needs_decision: null,
  at_risk: null,
  collections: "cap.invoicing",
  approved_mrs: "cap.material_requests",
  open_pos: "cap.purchase_orders",
};

export const TIME_HORIZONS = ["today", "this_week", "this_month", "this_quarter"] as const;
export type TimeHorizon = (typeof TIME_HORIZONS)[number];

// ── Provenance ──────────────────────────────────────────────────────────────
export const PROVENANCE_SOURCES = [
  "recommended_default",
  "onboarding_answer",
  "imported_configuration",
  "user_change",
  "system_requirement",
  "country_pack",
  "undo",
] as const;
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

// ── Country packs ───────────────────────────────────────────────────────────
/** Mirrors the onboarding SUPPORTED_COUNTRIES set (parity-tested). */
export const WORKSPACE_COUNTRIES = ["AE", "SA", "KW", "BH", "OM", "QA"] as const;
export type WorkspaceCountry = (typeof WORKSPACE_COUNTRIES)[number];
export function isWorkspaceCountry(x: string): x is WorkspaceCountry {
  return (WORKSPACE_COUNTRIES as readonly string[]).includes(x);
}

export type CountryPack = {
  country: WorkspaceCountry;
  /** Defaults only — the organization's own settings stay authoritative. */
  defaultTimezone: string;
  defaultCurrency: CurrencyCode;
  /** Shipped configuration languages (law 17). */
  locales: readonly Locale[];
  direction: Readonly<Record<Locale, "ltr" | "rtl">>;
  /** Latin numerals policy holds across the product. */
  numberFormat: "latin";
  dateFormat: "dd/mm/yyyy";
  /** Identity FIELDS documents carry — configuration, never stored values. */
  taxIdentityFields: readonly { key: string; en: string; ar: string }[];
  documentIdentityFields: readonly string[];
  /**
   * Regulatory extensions a pack may add (e-invoicing schemes, payroll file
   * formats, …). Empty until each ships — a pack may add REQUIREMENTS but
   * never weaken security, so this list carries no permission or security
   * fields by construction (law 15).
   */
  regulatoryExtensions: readonly string[];
  /** What this pack explicitly does NOT assume or provide today. */
  unsupportedAssumptions: readonly string[];
};

const GCC_UNSUPPORTED = [
  "no tax filing or government submission is performed",
  "no statutory payroll pack ships yet",
  "no chart-of-accounts pack ships yet",
] as const;

const packDefaults = {
  locales: ["en", "ar"] as const,
  direction: { en: "ltr", ar: "rtl" } as const,
  numberFormat: "latin" as const,
  dateFormat: "dd/mm/yyyy" as const,
  taxIdentityFields: [
    { key: "tax_registration_number", en: "Tax registration", ar: "التسجيل الضريبي" },
  ] as const,
  documentIdentityFields: [
    "legal_name",
    "trading_name",
    "address",
    "tax_registration_number",
  ] as const,
  regulatoryExtensions: [] as const,
  unsupportedAssumptions: GCC_UNSUPPORTED,
};

export const COUNTRY_PACKS: Record<WorkspaceCountry, CountryPack> = {
  AE: { country: "AE", defaultTimezone: "Asia/Dubai", defaultCurrency: "AED", ...packDefaults },
  SA: { country: "SA", defaultTimezone: "Asia/Riyadh", defaultCurrency: "SAR", ...packDefaults },
  KW: { country: "KW", defaultTimezone: "Asia/Kuwait", defaultCurrency: "KWD", ...packDefaults },
  BH: { country: "BH", defaultTimezone: "Asia/Bahrain", defaultCurrency: "BHD", ...packDefaults },
  OM: { country: "OM", defaultTimezone: "Asia/Muscat", defaultCurrency: "OMR", ...packDefaults },
  QA: { country: "QA", defaultTimezone: "Asia/Qatar", defaultCurrency: "QAR", ...packDefaults },
};

// ── Role archetypes a blueprint may configure ───────────────────────────────
/** worker_reserved_p3 is reserved and never configurable. */
export const BLUEPRINT_ARCHETYPES = [
  "owner",
  "admin",
  "manager",
  "foreman",
  "procurement",
  "accounts",
  "viewer",
] as const satisfies readonly RoleArchetype[];
export type BlueprintArchetype = (typeof BLUEPRINT_ARCHETYPES)[number];
