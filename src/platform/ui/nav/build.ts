/**
 * U5 navigation IA — ONE pure builder for the sidebar groups, the mobile
 * drawer (same groups) and the mobile bottom bar. Pure function of
 * (orgId, archetype, entitlement features) so the role × entitlement matrix is
 * unit-testable without rendering (tests/unit/nav-build.test.ts).
 *
 * Visibility law (unchanged semantics — U5 hard rule): `can()` remains THE
 * decider of whether an item exists for a role, and the entitlement feature
 * remains the decider of its entitled state. What changed is only how an
 * UN-entitled item presents:
 *
 *   LOCKED-vs-HIDDEN RULE (documented in docs/ux/DASHBOARD_REDESIGN.md):
 *   — MONEY-group items (quotes, invoices, payments, expenses, costing) whose
 *     capability is off are SHOWN with a lock glyph, linking to the
 *     subscription page (billing.view holders) or to the module's own
 *     read-only list (everyone else — reads are never blocked, freeze FR-9).
 *   — Every OTHER entitlement-gated item (attendance, MRs, POs, customer
 *     updates, imports) is HIDDEN when its capability is off, exactly as the
 *     pre-U5 nav behaved.
 *
 * Labels resolve in the layout (server) via i18n keys + terminology vars —
 * the builder never touches t()/term() so it stays pure and locale-free.
 */
import { can, type Action } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import type { IconName } from "../icons";

export type NavItem = {
  key: string;
  /** i18n key; domain nouns arrive as ICU vars ({jobs}, {daily_report}, …). */
  labelKey: string;
  href: string;
  icon: IconName;
  /** True when the role may see the item but the org lacks the capability. */
  locked: boolean;
};

export type NavGroup = {
  key: string;
  labelKey: string;
  icon: IconName;
  items: NavItem[];
};

type Features = Record<string, boolean>;

type ItemSpec = {
  key: string;
  labelKey: string;
  path: string; // under /o/[orgId]
  icon: IconName;
  /** Every listed action must pass can() (single actions in practice). */
  action: Action;
  /** Capability/feature gate; undefined = always entitled. */
  feature?: string;
  /** How an un-entitled item presents. Default "hide". */
  whenUnentitled?: "hide" | "lock";
  /**
   * A RELEASE gate, not a commercial one (see platform/flags.ts).
   *
   * `feature` answers "has this org paid for it"; this answers "is it finished".
   * They are different questions and conflating them is how an unverified screen
   * reaches a customer with a price attached. Absent by default, and the item is
   * hidden unless the caller passes the flag — a gate you have to remember to
   * apply is a gate that gets forgotten.
   */
  requiresStockSurfaces?: boolean;
  /** H23G release gate (platform/flags.ts hrSurfacesEnabled). */
  requiresHrSurfaces?: boolean;
  /** H24K release gate (platform/flags.ts financeSurfacesEnabled). */
  requiresFinanceSurfaces?: boolean;
  /** H25 release gate (platform/flags.ts managementStudioEnabled). */
  requiresStudioSurfaces?: boolean;
  /** H26 release gate (platform/flags.ts documentStudioEnabled). */
  requiresDocumentSurfaces?: boolean;
  /** H27 release gate (platform/flags.ts revenueStudioEnabled). */
  requiresRevenueSurfaces?: boolean;
  /** H29 release gate (platform/flags.ts countryPacksEnabled). */
  requiresCountrySurfaces?: boolean;
  /** H31 — hidden entirely until FEATURE_BRANDED_COMPANY_APPS is on. */
  requiresCompanyApp?: boolean;
};

type GroupSpec = { key: string; labelKey: string; icon: IconName; items: ItemSpec[] };

// ── The IA (U5 §1) ────────────────────────────────────────────────────────────
const GROUPS: GroupSpec[] = [
  {
    key: "work",
    labelKey: "nav.group.work",
    icon: "briefcase",
    items: [
      {
        key: "jobs",
        labelKey: "nav.item.jobs",
        path: "/jobs",
        icon: "briefcase",
        action: "jobs.view",
      },
      {
        key: "my_work",
        labelKey: "nav.my_work",
        path: "/my-work",
        icon: "check",
        action: "jobs.view",
      },
      { key: "week", labelKey: "nav.week", path: "/week", icon: "calendar", action: "week.view" },
      {
        key: "report_new",
        labelKey: "nav.item.report_new",
        path: "/reports/new",
        icon: "clipboard",
        action: "reports.create",
      },
      {
        key: "reports_review",
        labelKey: "nav.reports_review",
        path: "/reports/review",
        icon: "check",
        action: "reports.review",
      },
      {
        key: "issues",
        labelKey: "nav.issues",
        path: "/issues",
        icon: "alert",
        action: "issues.raise",
      },
      {
        key: "approvals",
        labelKey: "nav.approvals",
        path: "/approvals",
        icon: "inbox",
        action: "approvals.decide",
      },
      {
        key: "attendance",
        labelKey: "nav.attendance",
        path: "/attendance",
        icon: "clock",
        action: "attendance.view",
        feature: "cap.attendance",
      },
    ],
  },
  {
    key: "materials",
    labelKey: "nav.group.materials",
    icon: "package",
    items: [
      {
        key: "material_requests",
        labelKey: "nav.material_requests",
        path: "/material-requests",
        icon: "package",
        action: "mr.create",
        feature: "cap.material_requests",
      },
      {
        key: "purchase_orders",
        labelKey: "nav.purchase_orders",
        path: "/purchase-orders",
        icon: "cart",
        action: "po.view",
        feature: "cap.purchase_orders",
      },
      { key: "items", labelKey: "nav.items", path: "/items", icon: "box", action: "catalog.view" },
      /*
       * Stock and assets sit in the materials group rather than in a group of
       * their own: somebody asking "how much steel do we have" is already
       * looking under materials, and a second near-identical heading is how a
       * menu stops being navigable.
       */
      {
        key: "stock",
        labelKey: "nav.stock",
        path: "/stock",
        icon: "box",
        action: "inventory.view",
        requiresStockSurfaces: true,
      },
      {
        key: "assets",
        labelKey: "nav.assets",
        path: "/assets",
        icon: "wrench",
        action: "assets.view",
        requiresStockSurfaces: true,
      },
      {
        key: "suppliers",
        labelKey: "nav.suppliers",
        path: "/suppliers",
        icon: "truck",
        action: "catalog.view",
      },
    ],
  },
  {
    key: "money",
    labelKey: "nav.group.money",
    icon: "banknote",
    items: [
      {
        key: "quotes",
        labelKey: "nav.quotes",
        path: "/quotes",
        icon: "fileText",
        action: "quotes.view",
        feature: "cap.quoting",
        whenUnentitled: "lock",
      },
      {
        key: "invoices",
        labelKey: "nav.invoices",
        path: "/invoices",
        icon: "receipt",
        action: "invoices.view",
        feature: "cap.invoicing",
        whenUnentitled: "lock",
      },
      {
        key: "payments",
        labelKey: "nav.payments",
        path: "/payments",
        icon: "banknote",
        action: "payments.view",
        feature: "cap.payments",
        whenUnentitled: "lock",
      },
      {
        key: "expenses",
        labelKey: "nav.expenses",
        path: "/expenses",
        icon: "wallet",
        action: "expenses.view",
        feature: "cap.expenses",
        whenUnentitled: "lock",
      },
      {
        key: "costing",
        labelKey: "nav.costing",
        path: "/costing",
        icon: "calculator",
        action: "costing.view",
        feature: "cap.costing",
        whenUnentitled: "lock",
      },
      { key: "ar", labelKey: "nav.ar", path: "/ar", icon: "chart", action: "ar.view" },
    ],
  },
  {
    // H24K — the books. Behind BOTH the cap.finance entitlement and the
    // FEATURE_FINANCE_SURFACES release gate; hidden (never locked) while off.
    key: "finance",
    labelKey: "nav.group.finance",
    icon: "calculator",
    items: [
      {
        key: "finance",
        labelKey: "nav.finance",
        path: "/finance",
        icon: "chart",
        action: "finance.view",
        feature: "cap.finance",
        requiresFinanceSurfaces: true,
      },
      {
        key: "finance_journals",
        labelKey: "nav.finance_journals",
        path: "/finance/journals",
        icon: "fileText",
        action: "finance.view",
        feature: "cap.finance",
        requiresFinanceSurfaces: true,
      },
      {
        key: "finance_banking",
        labelKey: "nav.finance_banking",
        path: "/finance/banking",
        icon: "banknote",
        action: "finance.view",
        feature: "cap.finance",
        requiresFinanceSurfaces: true,
      },
      {
        key: "finance_receivables",
        labelKey: "nav.finance_receivables",
        path: "/finance/receivables",
        icon: "receipt",
        action: "finance.view",
        feature: "cap.finance",
        requiresFinanceSurfaces: true,
      },
      {
        key: "finance_payables",
        labelKey: "nav.finance_payables",
        path: "/finance/payables",
        icon: "wallet",
        action: "finance.view",
        feature: "cap.finance",
        requiresFinanceSurfaces: true,
      },
      {
        key: "finance_reports",
        labelKey: "nav.finance_reports",
        path: "/finance/reports",
        icon: "chart",
        action: "finance.view",
        feature: "cap.finance",
        requiresFinanceSurfaces: true,
      },
      {
        key: "finance_tax",
        labelKey: "nav.finance_tax",
        path: "/finance/tax",
        icon: "clipboard",
        action: "tax.prepare",
        feature: "cap.finance",
        requiresFinanceSurfaces: true,
      },
      {
        key: "finance_budgets",
        labelKey: "nav.finance_budgets",
        path: "/finance/budgets",
        icon: "calculator",
        action: "budget.manage",
        feature: "cap.finance",
        requiresFinanceSurfaces: true,
      },
    ],
  },
  {
    // H25 — the Management Studio: one destination, many projections inside.
    // Behind BOTH cap.studio and FEATURE_MANAGEMENT_STUDIO; hidden while off.
    key: "studio",
    labelKey: "nav.group.studio",
    icon: "chart",
    items: [
      {
        key: "studio",
        labelKey: "nav.studio",
        path: "/studio",
        icon: "chart",
        action: "studio.view",
        feature: "cap.studio",
        requiresStudioSurfaces: true,
      },
    ],
  },
  {
    // H26 — the Document Studio: the command centre plus its governed
    // libraries. Behind BOTH cap.documents and FEATURE_DOCUMENT_STUDIO.
    key: "documents",
    labelKey: "nav.group.documents",
    icon: "clipboard",
    items: [
      {
        key: "documents",
        labelKey: "nav.documents",
        path: "/documents",
        icon: "clipboard",
        action: "documents.view",
        feature: "cap.documents",
        requiresDocumentSurfaces: true,
      },
      {
        key: "documents_templates",
        labelKey: "nav.documents_templates",
        path: "/documents/templates",
        icon: "grid",
        action: "documents.templates.manage",
        feature: "cap.documents",
        requiresDocumentSurfaces: true,
      },
      {
        key: "documents_workflows",
        labelKey: "nav.documents_workflows",
        path: "/documents/workflows",
        icon: "check",
        action: "documents.workflows.manage",
        feature: "cap.documents",
        requiresDocumentSurfaces: true,
      },
      {
        key: "documents_obligations",
        labelKey: "nav.documents_obligations",
        path: "/documents/obligations",
        icon: "calendar",
        action: "documents.view",
        feature: "cap.documents",
        requiresDocumentSurfaces: true,
      },
      {
        key: "documents_forms",
        labelKey: "nav.documents_forms",
        path: "/documents/forms",
        icon: "inbox",
        action: "documents.forms.manage",
        feature: "cap.documents",
        requiresDocumentSurfaces: true,
      },
    ],
  },
  {
    // H27 — the Revenue Studio: pipeline, leads, forecast, campaigns,
    // targets, success, automation, reports. Behind BOTH cap.revenue_studio
    // and FEATURE_REVENUE_STUDIO.
    key: "revenue",
    labelKey: "nav.group.revenue",
    icon: "chart",
    items: [
      {
        key: "revenue",
        labelKey: "nav.revenue",
        path: "/revenue",
        icon: "chart",
        action: "opportunities.view",
        feature: "cap.revenue_studio",
        requiresRevenueSurfaces: true,
      },
      {
        key: "revenue_pipeline",
        labelKey: "nav.revenue_pipeline",
        path: "/revenue/pipeline",
        icon: "grid",
        action: "opportunities.view",
        feature: "cap.revenue_studio",
        requiresRevenueSurfaces: true,
      },
      {
        key: "revenue_leads",
        labelKey: "nav.revenue_leads",
        path: "/revenue/leads",
        icon: "inbox",
        action: "leads.view",
        feature: "cap.revenue_studio",
        requiresRevenueSurfaces: true,
      },
      {
        key: "revenue_forecast",
        labelKey: "nav.revenue_forecast",
        path: "/revenue/forecast",
        icon: "chart",
        action: "crm.forecast.view",
        feature: "cap.revenue_studio",
        requiresRevenueSurfaces: true,
      },
      {
        key: "revenue_campaigns",
        labelKey: "nav.revenue_campaigns",
        path: "/revenue/campaigns",
        icon: "calendar",
        action: "crm.campaigns.manage",
        feature: "cap.revenue_studio",
        requiresRevenueSurfaces: true,
      },
      {
        key: "revenue_targets",
        labelKey: "nav.revenue_targets",
        path: "/revenue/targets",
        icon: "check",
        action: "crm.targets.manage",
        feature: "cap.revenue_studio",
        requiresRevenueSurfaces: true,
      },
      {
        key: "revenue_success",
        labelKey: "nav.revenue_success",
        path: "/revenue/success",
        icon: "users",
        action: "customers.view",
        feature: "cap.revenue_studio",
        requiresRevenueSurfaces: true,
      },
      {
        key: "revenue_automations",
        labelKey: "nav.revenue_automations",
        path: "/revenue/automations",
        icon: "clipboard",
        action: "crm.automations.manage",
        feature: "cap.revenue_studio",
        requiresRevenueSurfaces: true,
      },
      {
        key: "revenue_reports",
        labelKey: "nav.revenue_reports",
        path: "/revenue/reports",
        icon: "chart",
        action: "crm.forecast.view",
        feature: "cap.revenue_studio",
        requiresRevenueSurfaces: true,
      },
    ],
  },
  {
    key: "customers",
    labelKey: "nav.group.customers",
    icon: "users",
    items: [
      {
        key: "customers",
        labelKey: "nav.customers",
        path: "/customers",
        icon: "users",
        action: "customers.view",
      },
      // H20 sales CRM — rides the customers module (no separate cap.* key).
      {
        key: "leads",
        labelKey: "nav.leads",
        path: "/leads",
        icon: "user",
        action: "leads.view",
      },
      {
        key: "opportunities",
        labelKey: "nav.opportunities",
        path: "/opportunities",
        icon: "trendUp",
        action: "opportunities.view",
      },
      {
        key: "sales",
        labelKey: "nav.sales",
        path: "/sales",
        icon: "chart",
        action: "opportunities.view",
      },
      {
        key: "customer_updates",
        labelKey: "nav.customer_updates",
        path: "/customer-updates",
        icon: "megaphone",
        action: "customer_updates.draft",
        feature: "cap.customer_updates",
      },
    ],
  },
  {
    key: "people",
    labelKey: "nav.group.people",
    icon: "user",
    items: [
      {
        key: "people",
        labelKey: "nav.people",
        path: "/people",
        icon: "user",
        action: "employees.view",
      },
      {
        key: "leave",
        labelKey: "nav.leave",
        path: "/leave",
        icon: "calendar",
        action: "hr.self",
        feature: "cap.leave",
        requiresHrSurfaces: true,
      },
      {
        key: "claims",
        labelKey: "nav.claims",
        path: "/claims",
        icon: "receipt",
        action: "hr.self",
        feature: "cap.expense_claims",
        requiresHrSurfaces: true,
      },
      {
        key: "my_pay",
        labelKey: "nav.my_pay",
        path: "/my-pay",
        icon: "wallet",
        action: "hr.self",
        feature: "cap.payroll",
        requiresHrSurfaces: true,
      },
      {
        key: "payroll",
        labelKey: "nav.payroll",
        path: "/payroll",
        icon: "banknote",
        action: "payroll.view",
        feature: "cap.payroll",
        requiresHrSurfaces: true,
      },
      {
        key: "members",
        labelKey: "members.title",
        path: "/settings/members",
        icon: "users",
        action: "members.view",
      },
    ],
  },
  {
    // Renamed from "insights" (adversarial review): the group holds imports +
    // exports — plain data plumbing. "Data" is the honest label.
    key: "data",
    labelKey: "nav.group.data",
    icon: "trendUp",
    items: [
      {
        key: "imports",
        labelKey: "nav.imports",
        path: "/imports",
        icon: "download",
        action: "imports.manage",
        feature: "feat.data_import",
      },
      {
        key: "exports",
        labelKey: "nav.item.exports",
        path: "/settings/export",
        icon: "download",
        action: "data.export",
      },
    ],
  },
  {
    key: "settings",
    labelKey: "nav.group.settings",
    icon: "settings",
    items: [
      {
        key: "onboarding",
        labelKey: "nav.onboarding",
        path: "/onboarding",
        icon: "sparkle",
        action: "onboarding.run",
      },
      {
        key: "workspace",
        labelKey: "nav.workspace",
        path: "/settings/workspace",
        icon: "sparkle",
        action: "config.view",
      },
      {
        key: "configuration",
        labelKey: "nav.configuration",
        path: "/settings/configuration",
        icon: "settings",
        action: "config.view",
      },
      {
        key: "branding",
        labelKey: "nav.branding",
        path: "/settings/branding",
        icon: "grid",
        action: "config.manage",
      },
      {
        key: "company_app",
        labelKey: "app.nav",
        path: "/settings/app",
        icon: "package",
        action: "config.view",
        requiresCompanyApp: true,
      },
      {
        key: "notifications",
        labelKey: "nav.notifications",
        path: "/settings/notifications",
        icon: "bell",
        action: "members.view",
      },
      {
        key: "countries",
        labelKey: "nav.countries",
        path: "/settings/countries",
        icon: "globe",
        action: "country.view",
        requiresCountrySurfaces: true,
      },
      {
        key: "subscription",
        labelKey: "nav.subscription",
        path: "/settings/subscription",
        icon: "receipt",
        action: "billing.view",
      },
    ],
  },
];

export type BuildNavInput = {
  orgId: string;
  archetype: RoleArchetype;
  features: Features;
  /**
   * Whether the H22 stock and asset screens are released (platform/flags.ts).
   *
   * Passed IN rather than read here so this builder stays a pure function of
   * its arguments and the role x entitlement matrix stays unit-testable. Absent
   * means hidden: the default has to be the safe one, because every call site
   * that forgets this gets the safe one.
   */
  stockSurfaces?: boolean;
  /** Whether the H23 HR/leave/claims/payroll screens are released. Same
   *  pass-it-in law as stockSurfaces: absent means hidden. */
  hrSurfaces?: boolean;
  /** Whether the H24 finance/banking/tax screens are released. Same law. */
  financeSurfaces?: boolean;
  /** Whether the H25 Management Studio is released. Same law. */
  studioSurfaces?: boolean;
  /** Whether the H26 Document Studio is released. Same law. */
  documentSurfaces?: boolean;
  /** H27 release gate (platform/flags.ts revenueStudioEnabled). */
  revenueSurfaces?: boolean;
  /** Whether the H29 country-pack screens are released. Same law. */
  countrySurfaces?: boolean;
  /** H31 release gate for the company-app settings entry. */
  companyAppSurfaces?: boolean;
};

function resolveItem(spec: ItemSpec, input: BuildNavInput): NavItem | null {
  // Release gate first: an unfinished surface is not a permission question.
  if (spec.requiresStockSurfaces === true && input.stockSurfaces !== true) return null;
  if (spec.requiresHrSurfaces === true && input.hrSurfaces !== true) return null;
  if (spec.requiresFinanceSurfaces === true && input.financeSurfaces !== true) return null;
  if (spec.requiresStudioSurfaces === true && input.studioSurfaces !== true) return null;
  if (spec.requiresDocumentSurfaces === true && input.documentSurfaces !== true) return null;
  if (spec.requiresRevenueSurfaces === true && input.revenueSurfaces !== true) return null;
  if (spec.requiresCountrySurfaces === true && input.countrySurfaces !== true) return null;
  if (spec.requiresCompanyApp === true && input.companyAppSurfaces !== true) return null;
  if (!can(input.archetype, spec.action)) return null;
  const entitled = spec.feature === undefined || (input.features[spec.feature] ?? false);
  if (entitled) {
    return {
      key: spec.key,
      labelKey: spec.labelKey,
      href: `/o/${input.orgId}${spec.path}`,
      icon: spec.icon,
      locked: false,
    };
  }
  if ((spec.whenUnentitled ?? "hide") === "hide") return null;
  // Locked: billing viewers go straight to the unlock surface; everyone else
  // lands on the module's read-only list (reads are never blocked — FR-9).
  const href = can(input.archetype, "billing.view")
    ? `/o/${input.orgId}/settings/subscription`
    : `/o/${input.orgId}${spec.path}`;
  return { key: spec.key, labelKey: spec.labelKey, href, icon: spec.icon, locked: true };
}

/** The grouped nav: Today first, then only groups with at least one item. */
export function buildNavGroups(input: BuildNavInput): NavGroup[] {
  const today: NavGroup = {
    key: "today",
    labelKey: "today.title",
    icon: "home",
    items: [
      {
        key: "today",
        labelKey: "today.title",
        href: `/o/${input.orgId}`,
        icon: "home",
        locked: false,
      },
      /*
       * The inbox is UNCONDITIONAL, and deliberately not one of the specs above.
       *
       * It shows a person their own notifications, plus the concerns they are
       * already permitted to see — RLS scopes the first to the recipient and
       * the page checks a permission for the second. No role can hold a
       * membership and not have an inbox, so there is no action to gate it on;
       * inventing one would only be a way of hiding somebody's own messages
       * from them. Every notification this product writes was unreachable in
       * the UI until this item existed.
       */
      {
        key: "inbox",
        labelKey: "nav.inbox",
        href: `/o/${input.orgId}/inbox`,
        icon: "bell",
        locked: false,
      },
    ],
  };
  const groups = GROUPS.map((g) => ({
    key: g.key,
    labelKey: g.labelKey,
    icon: g.icon,
    items: g.items.map((s) => resolveItem(s, input)).filter((i): i is NavItem => i !== null),
  })).filter((g) => g.items.length > 0);
  return [today, ...groups];
}

// ── Quick-create (+ New) menu ─────────────────────────────────────────────────
export type QuickCreateItem = { key: string; labelKey: string; href: string; icon: IconName };

const QUICK_CREATE: Array<ItemSpec> = [
  {
    key: "job",
    labelKey: "nav.create.job",
    path: "/jobs",
    icon: "briefcase",
    action: "jobs.create",
  },
  {
    key: "report",
    labelKey: "nav.create.report",
    path: "/reports/new",
    icon: "clipboard",
    action: "reports.create",
  },
  {
    key: "mr",
    labelKey: "nav.create.mr",
    path: "/material-requests",
    icon: "package",
    action: "mr.create",
    feature: "cap.material_requests",
  },
  {
    key: "quote",
    labelKey: "nav.create.quote",
    path: "/quotes",
    icon: "fileText",
    action: "quotes.manage",
    feature: "cap.quoting",
  },
  {
    key: "invoice",
    labelKey: "nav.create.invoice",
    path: "/invoices",
    icon: "receipt",
    action: "invoices.manage",
    feature: "cap.invoicing",
  },
  {
    key: "payment",
    labelKey: "nav.create.payment",
    path: "/payments",
    icon: "banknote",
    action: "payments.manage",
    feature: "cap.payments",
  },
  {
    key: "expense",
    labelKey: "nav.create.expense",
    path: "/expenses",
    icon: "wallet",
    action: "expenses.create",
    feature: "cap.expenses",
  },
];

/** Role-aware "+ New" entries (entitled items only — a locked create is noise). */
export function buildQuickCreate(input: BuildNavInput): QuickCreateItem[] {
  return QUICK_CREATE.map((s) => resolveItem(s, input))
    .filter((i): i is NavItem => i !== null && !i.locked)
    .map(({ key, labelKey, href, icon }) => ({ key, labelKey, href, icon }));
}

// ── Mobile bottom bar (5 slots: 4 role-primary + More) ───────────────────────
// Candidates per archetype, most-important first; the same visibility law
// filters them, the first four win, "More" opens the full drawer.
const BOTTOM_CANDIDATES: Record<RoleArchetype, string[]> = {
  owner: ["today", "jobs", "reports_review", "approvals", "money_ar", "week"],
  admin: ["today", "jobs", "reports_review", "approvals", "money_ar", "week"],
  manager: ["today", "jobs", "reports_review", "approvals", "week"],
  // Field-first: the foreman's day is jobs → report → issues.
  foreman: ["today", "jobs", "report_new", "issues", "week"],
  accounts: ["today", "money_invoices", "money_payments", "money_ar", "approvals"],
  procurement: ["today", "material_requests", "purchase_orders", "suppliers", "jobs"],
  viewer: ["today", "jobs", "week", "attendance"],
  worker_reserved_p3: ["today"],
};

const BOTTOM_SPECS: Record<string, ItemSpec> = {
  jobs: {
    key: "jobs",
    labelKey: "nav.item.jobs",
    path: "/jobs",
    icon: "briefcase",
    action: "jobs.view",
  },
  week: { key: "week", labelKey: "nav.week", path: "/week", icon: "calendar", action: "week.view" },
  report_new: {
    key: "report_new",
    labelKey: "nav.item.report_short",
    path: "/reports/new",
    icon: "clipboard",
    action: "reports.create",
  },
  reports_review: {
    key: "reports_review",
    labelKey: "nav.reports_review",
    path: "/reports/review",
    icon: "check",
    action: "reports.review",
  },
  issues: {
    key: "issues",
    labelKey: "nav.issues",
    path: "/issues",
    icon: "alert",
    action: "issues.raise",
  },
  approvals: {
    key: "approvals",
    labelKey: "nav.approvals",
    path: "/approvals",
    icon: "inbox",
    action: "approvals.decide",
  },
  attendance: {
    key: "attendance",
    labelKey: "nav.attendance",
    path: "/attendance",
    icon: "clock",
    action: "attendance.view",
    feature: "cap.attendance",
  },
  material_requests: {
    key: "material_requests",
    labelKey: "nav.material_requests",
    path: "/material-requests",
    icon: "package",
    action: "mr.create",
    feature: "cap.material_requests",
  },
  purchase_orders: {
    key: "purchase_orders",
    labelKey: "nav.purchase_orders",
    path: "/purchase-orders",
    icon: "cart",
    action: "po.view",
    feature: "cap.purchase_orders",
  },
  suppliers: {
    key: "suppliers",
    labelKey: "nav.suppliers",
    path: "/suppliers",
    icon: "truck",
    action: "catalog.view",
  },
  money_invoices: {
    key: "invoices",
    labelKey: "nav.invoices",
    path: "/invoices",
    icon: "receipt",
    action: "invoices.view",
    feature: "cap.invoicing",
    whenUnentitled: "lock",
  },
  money_payments: {
    key: "payments",
    labelKey: "nav.payments",
    path: "/payments",
    icon: "banknote",
    action: "payments.view",
    feature: "cap.payments",
    whenUnentitled: "lock",
  },
  money_ar: { key: "ar", labelKey: "nav.ar", path: "/ar", icon: "chart", action: "ar.view" },
};

export type BottomNavSpec = NavItem & { isMore?: boolean };

export function buildBottomNav(input: BuildNavInput): BottomNavSpec[] {
  const out: BottomNavSpec[] = [];
  for (const key of BOTTOM_CANDIDATES[input.archetype] ?? ["today"]) {
    if (out.length >= 4) break;
    if (key === "today") {
      out.push({
        key: "today",
        labelKey: "today.title",
        href: `/o/${input.orgId}`,
        icon: "home",
        locked: false,
      });
      continue;
    }
    const spec = BOTTOM_SPECS[key];
    if (!spec) continue;
    const item = resolveItem(spec, input);
    if (item) out.push(item);
  }
  out.push({
    key: "more",
    labelKey: "nav.more",
    href: "#nav",
    icon: "menu",
    locked: false,
    isMore: true,
  });
  return out;
}

// ── Active-state resolution ───────────────────────────────────────────────────
/**
 * The active item is the LONGEST href that prefixes the pathname on a segment
 * boundary; the org home matches only exactly (else it would win everywhere).
 */
export function activeItemKey(
  pathname: string,
  items: Array<{ key: string; href: string }>,
): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  let best: { key: string; len: number } | null = null;
  for (const item of items) {
    const href = item.href.replace(/\/+$/, "");
    if (!href || href.startsWith("#")) continue;
    const isOrgHome = /^\/o\/[^/]+$/.test(href);
    const matches = isOrgHome ? path === href : path === href || path.startsWith(`${href}/`);
    if (matches && (!best || href.length > best.len)) {
      best = { key: item.key, len: href.length };
    }
  }
  return best?.key ?? null;
}
