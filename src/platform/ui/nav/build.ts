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
        key: "notifications",
        labelKey: "nav.notifications",
        path: "/settings/notifications",
        icon: "bell",
        action: "members.view",
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
};

function resolveItem(spec: ItemSpec, input: BuildNavInput): NavItem | null {
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
