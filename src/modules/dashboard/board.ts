/**
 * The dashboard board: which widgets exist, who may have which, what the
 * default arrangement is, and how a stored layout is read back safely.
 *
 * Pure by design: no database, no request, no React. The loader (widgets.tsx)
 * fetches data for the widgets a layout actually shows, and the store
 * (board-store.ts) reads and writes the layout row. Everything that decides
 * is here, where a test can pin it exactly.
 *
 * ── The law ─────────────────────────────────────────────────────────────────
 * A layout is a PREFERENCE about order, size and visibility. It never grants
 * anything: `availableWidgets` intersects role permission, live entitlement,
 * the blueprint's disabled modules, release flags and price privilege, and a
 * stored key that fails any of those, or that no longer exists at all, is
 * dropped on read without comment. The loader checks again before fetching.
 */
import { z } from "zod";
import { can, type Action } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { WIDGET_SIZES, type WidgetSize } from "@/platform/ui/dashboard/board-layout";

export const WIDGET_KEYS = [
  // The whole pre-blueprint composition as one widget (legacy workspaces):
  // an existing company's dashboard is unchanged until its people edit it.
  "classic",
  // The adaptive composition, in its five layers (blueprint workspaces).
  "attention",
  "next",
  "pulse",
  "progress",
  "recent_activity",
  // Focused widgets over the same services the pages read from.
  "my_tasks",
  "approvals",
  "active_work",
  "quotes_awaiting",
  "receivables",
  "stock_alerts",
  "team_actions",
  "quick_actions",
] as const;
export type WidgetKey = (typeof WIDGET_KEYS)[number];
export function isWidgetKey(x: string): x is WidgetKey {
  return (WIDGET_KEYS as readonly string[]).includes(x);
}

export { SIZE_CLASS, WIDGET_SIZES, type WidgetSize } from "@/platform/ui/dashboard/board-layout";

/** The areas a founder can name as priorities during onboarding. */
export const PRIORITY_AREAS = ["work", "sales", "money", "people", "stock"] as const;
export type PriorityArea = (typeof PRIORITY_AREAS)[number];

export type WidgetSpec = {
  key: WidgetKey;
  /** The permission the widget's data needs. Re-checked by the loader. */
  action: Action;
  /** The capability that must be entitled AND not disabled by the blueprint. */
  feature?: string;
  /** A release gate: the surface is not finished until the flag is on. */
  flag?: "stock" | "hr";
  /** Needs the blueprint composition (never offered to a legacy workspace). */
  adaptiveOnly?: boolean;
  /** The pre-blueprint composition (never offered to a blueprint workspace). */
  legacyOnly?: boolean;
  /** Shows money: needs price privilege, never redacted-to-zero. */
  priceOnly?: boolean;
  defaultSize: WidgetSize;
  /** Which stated priorities pull this widget towards the top. */
  areas: readonly PriorityArea[];
};

export const WIDGETS: Record<WidgetKey, WidgetSpec> = {
  classic: { key: "classic", action: "today.view", legacyOnly: true, defaultSize: "l", areas: [] },
  attention: {
    key: "attention",
    action: "today.view",
    adaptiveOnly: true,
    defaultSize: "l",
    areas: [],
  },
  next: { key: "next", action: "today.view", adaptiveOnly: true, defaultSize: "m", areas: [] },
  pulse: {
    key: "pulse",
    action: "today.view",
    adaptiveOnly: true,
    defaultSize: "l",
    areas: ["money", "sales"],
  },
  progress: {
    key: "progress",
    action: "jobs.view",
    adaptiveOnly: true,
    defaultSize: "m",
    areas: ["work"],
  },
  recent_activity: { key: "recent_activity", action: "today.view", defaultSize: "m", areas: [] },
  my_tasks: {
    key: "my_tasks",
    action: "jobs.view",
    feature: "cap.jobs",
    defaultSize: "m",
    areas: ["work"],
  },
  approvals: {
    key: "approvals",
    action: "approvals.decide",
    feature: "cap.approvals",
    defaultSize: "m",
    areas: ["money", "work"],
  },
  active_work: {
    key: "active_work",
    action: "jobs.view",
    feature: "cap.jobs",
    defaultSize: "s",
    areas: ["work"],
  },
  quotes_awaiting: {
    key: "quotes_awaiting",
    action: "quotes.view",
    feature: "cap.quoting",
    defaultSize: "s",
    areas: ["sales"],
  },
  receivables: {
    key: "receivables",
    action: "ar.view",
    feature: "cap.invoicing",
    priceOnly: true,
    defaultSize: "s",
    areas: ["money"],
  },
  stock_alerts: {
    key: "stock_alerts",
    action: "inventory.view",
    feature: "cap.items",
    flag: "stock",
    defaultSize: "m",
    areas: ["stock"],
  },
  team_actions: {
    key: "team_actions",
    action: "employees.view",
    feature: "cap.people",
    flag: "hr",
    defaultSize: "m",
    areas: ["people"],
  },
  quick_actions: { key: "quick_actions", action: "today.view", defaultSize: "l", areas: [] },
};

export type AvailabilityContext = {
  archetype: RoleArchetype;
  /** Live entitlement features (cap.* → boolean). */
  features: Record<string, boolean>;
  /** Modules the applied blueprint switched off. */
  disabledModules: ReadonlySet<string>;
  seesPrice: boolean;
  flags: { stock: boolean; hr: boolean };
  /** True for a blueprint workspace, whose composition the adaptive widgets need. */
  adaptive: boolean;
};

/** Every widget THIS person may have, in registry order. */
export function availableWidgets(cx: AvailabilityContext): WidgetSpec[] {
  return WIDGET_KEYS.map((k) => WIDGETS[k]).filter((w) => widgetAllowed(w, cx));
}

export function widgetAllowed(w: WidgetSpec, cx: AvailabilityContext): boolean {
  if (!can(cx.archetype, w.action)) return false;
  if (w.adaptiveOnly && !cx.adaptive) return false;
  if (w.legacyOnly && cx.adaptive) return false;
  if (w.priceOnly && !cx.seesPrice) return false;
  if (w.feature !== undefined) {
    if (cx.features[w.feature] !== true) return false;
    if (cx.disabledModules.has(w.feature)) return false;
  }
  if (w.flag === "stock" && !cx.flags.stock) return false;
  if (w.flag === "hr" && !cx.flags.hr) return false;
  return true;
}

// ── The stored layout ────────────────────────────────────────────────────────

const EntrySchema = z
  .object({
    key: z.string().min(1).max(40),
    size: z.enum(WIDGET_SIZES),
    hidden: z.boolean().optional(),
  })
  .strict();

export const LayoutSchema = z
  .object({
    v: z.literal(1),
    widgets: z.array(EntrySchema).max(40),
  })
  .strict();

export type DashboardLayout = z.infer<typeof LayoutSchema>;

/** Read a stored or submitted layout. Anything malformed is null: the role
 * default applies, and nothing else in the page notices. */
export function parseLayout(raw: unknown): DashboardLayout | null {
  const r = LayoutSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export type ResolvedEntry = { key: WidgetKey; size: WidgetSize; hidden: boolean };

export type ResolvedLayout = {
  entries: ResolvedEntry[];
  /** Where it came from: the person's saved row, or the role default. */
  source: "saved" | "default";
  /** Keys the saved layout named that were dropped: unknown, retired, or not
   * this person's to see. Reported so the UI can say so, never silently. */
  dropped: string[];
};

/**
 * The default order for each role. Attention is always first; the rest is
 * the order somebody with that job would look for things.
 */
const DEFAULT_ORDER: Record<RoleArchetype, WidgetKey[]> = {
  owner: [
    "classic",
    "attention",
    "next",
    "pulse",
    "approvals",
    "active_work",
    "quotes_awaiting",
    "receivables",
    "my_tasks",
    "progress",
    "stock_alerts",
    "team_actions",
    "recent_activity",
    "quick_actions",
  ],
  admin: [
    "classic",
    "attention",
    "next",
    "pulse",
    "approvals",
    "active_work",
    "quotes_awaiting",
    "receivables",
    "my_tasks",
    "progress",
    "stock_alerts",
    "team_actions",
    "recent_activity",
    "quick_actions",
  ],
  manager: [
    "classic",
    "attention",
    "next",
    "approvals",
    "active_work",
    "my_tasks",
    "progress",
    "pulse",
    "quotes_awaiting",
    "stock_alerts",
    "team_actions",
    "recent_activity",
    "quick_actions",
  ],
  accounts: [
    "classic",
    "attention",
    "next",
    "receivables",
    "approvals",
    "quotes_awaiting",
    "pulse",
    "team_actions",
    "recent_activity",
    "quick_actions",
  ],
  procurement: [
    "classic",
    "attention",
    "next",
    "stock_alerts",
    "pulse",
    "progress",
    "recent_activity",
    "quick_actions",
  ],
  foreman: [
    "classic",
    "attention",
    "my_tasks",
    "progress",
    "active_work",
    "next",
    "stock_alerts",
    "recent_activity",
    "quick_actions",
  ],
  viewer: ["classic", "attention", "next", "pulse", "progress", "active_work", "recent_activity"],
  worker_reserved_p3: ["classic", "attention", "my_tasks", "recent_activity"],
};

/**
 * The default layout: the role's order, with the widgets that serve the
 * company's stated priorities pulled forward (stable, so ties keep the role
 * order), and attention kept first regardless. Only available widgets appear,
 * so a default is never blank for the role and never names a widget the
 * person cannot see.
 */
export function defaultLayoutFor(
  archetype: RoleArchetype,
  priorities: readonly PriorityArea[],
  available: readonly WidgetSpec[],
): ResolvedEntry[] {
  const allowed = new Set(available.map((w) => w.key));
  const order = DEFAULT_ORDER[archetype].filter((k) => allowed.has(k));
  const wanted = new Set(priorities);
  const serves = (k: WidgetKey) => WIDGETS[k].areas.some((a) => wanted.has(a));
  // Pinned first, in this order: the classic overview (legacy) and attention.
  // A workspace without a blueprint keeps exactly the dashboard it has today:
  // the classic overview alone. Every other widget is one Add away, but none
  // is imposed on a company that never asked for it.
  if (allowed.has("classic"))
    return [{ key: "classic", size: WIDGETS.classic.defaultSize, hidden: false }];
  const head = order.filter((k) => k === "attention");
  const rest = order.filter((k) => k !== "attention");
  const ordered = [...head, ...rest.filter(serves), ...rest.filter((k) => !serves(k))];
  return ordered.map((k) => ({ key: k, size: WIDGETS[k].defaultSize, hidden: false }));
}

/**
 * Apply a saved layout to what this person may see today.
 *
 * Unknown keys (a widget retired since the row was written), duplicates and
 * keys the person may not see are dropped. A saved layout that names nothing
 * usable falls back to the default rather than rendering an empty page; a
 * saved layout that deliberately hides everything is honoured as an empty
 * board, because that was a choice.
 */
export function resolveLayout(
  saved: DashboardLayout | null,
  archetype: RoleArchetype,
  priorities: readonly PriorityArea[],
  available: readonly WidgetSpec[],
): ResolvedLayout {
  const allowed = new Set(available.map((w) => w.key));
  if (saved === null) {
    return {
      entries: defaultLayoutFor(archetype, priorities, available),
      source: "default",
      dropped: [],
    };
  }
  const seen = new Set<string>();
  const dropped: string[] = [];
  const entries: ResolvedEntry[] = [];
  for (const e of saved.widgets) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    if (!isWidgetKey(e.key) || !allowed.has(e.key)) {
      dropped.push(e.key);
      continue;
    }
    entries.push({ key: e.key, size: e.size, hidden: e.hidden === true });
  }
  if (entries.length === 0 && dropped.length > 0) {
    return {
      entries: defaultLayoutFor(archetype, priorities, available),
      source: "default",
      dropped,
    };
  }
  return { entries, source: "saved", dropped };
}

/** The layout a client submits, reduced to what this person may keep. */
export function sanitiseSubmitted(
  raw: unknown,
  available: readonly WidgetSpec[],
): DashboardLayout | null {
  const parsed = parseLayout(raw);
  if (!parsed) return null;
  const allowed = new Set(available.map((w) => w.key));
  const seen = new Set<string>();
  const widgets = parsed.widgets.filter((e) => {
    if (seen.has(e.key) || !allowed.has(e.key as WidgetKey)) return false;
    seen.add(e.key);
    return true;
  });
  return {
    v: 1,
    widgets: widgets.map((e) => ({ key: e.key, size: e.size, hidden: e.hidden === true })),
  };
}
