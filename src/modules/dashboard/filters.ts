/**
 * H18 — canonical drill-down filter contracts.
 *
 * ONE vocabulary shared by the dashboard's link builders and the destination
 * pages' server-side parsers, so a signal's count and its destination's
 * records can never drift apart by construction:
 *
 *  - compose.ts builds every filtered href through the builders below;
 *  - each destination page parses its searchParams through the matching
 *    parser, which VALIDATES on the server and safely ignores unknown or
 *    malformed values (never an error page, never a trusting pass-through);
 *  - the inclusion predicates live here once and are reused by both sides
 *    where the data shape allows (status sets, date rules).
 *
 * URLs stay stable and shareable; no internal query names or capability
 * keys appear in them. Security filtering NEVER happens in the browser —
 * these filters narrow lists the caller was already authorized to read,
 * and scoped variants (scope=mine) narrow further via the same server-side
 * assignment resolver the aggregates use.
 */

// ── Customer parameter (H19 Part E — shared by every destination) ───────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server-side customer-id validation: a well-formed uuid or null. The
 * destination applies it inside its org-scoped query, so a foreign or
 * unknown id yields the SAME honest empty list as any random uuid — the
 * URL never reveals whether a customer exists. */
export function parseCustomerParam(sp: { customer?: string }): { customerId: string | null } {
  return { customerId: sp.customer && UUID_RE.test(sp.customer) ? sp.customer : null };
}

// ── Jobs (/jobs) ────────────────────────────────────────────────────────────
export const JOB_LIST_FILTERS = ["overdue", "due_soon"] as const;
export type JobListFilter = (typeof JOB_LIST_FILTERS)[number];

export type JobsSearch = {
  filter: JobListFilter | null;
  /** due_soon window in days (1..90); null unless filter=due_soon. */
  days: number | null;
  /** Current-stage key filter (validated shape only; unknown keys just
   * produce an honest empty list — stage keys are org data, not an enum). */
  stage: string | null;
  /** "mine" narrows to the caller's assigned scope (the same resolver the
   * dashboard aggregates use for managers). */
  scope: "mine" | null;
  /** H19: narrow the list to one customer's work (validated uuid). */
  customerId: string | null;
};

const STAGE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export function parseJobsSearch(sp: {
  filter?: string;
  days?: string;
  stage?: string;
  scope?: string;
  customer?: string;
}): JobsSearch {
  const filter = (JOB_LIST_FILTERS as readonly string[]).includes(sp.filter ?? "")
    ? (sp.filter as JobListFilter)
    : null;
  let days: number | null = null;
  if (filter === "due_soon") {
    const n = Number.parseInt(sp.days ?? "", 10);
    days = Number.isInteger(n) && n >= 1 && n <= 90 ? n : 7;
  }
  return {
    filter,
    days,
    stage: sp.stage && STAGE_KEY_RE.test(sp.stage) ? sp.stage : null,
    scope: sp.scope === "mine" ? "mine" : null,
    customerId: parseCustomerParam(sp).customerId,
  };
}

export function jobsHref(
  orgId: string,
  f: Partial<Pick<JobsSearch, "filter" | "days" | "stage" | "scope" | "customerId">> = {},
): string {
  const q = new URLSearchParams();
  if (f.filter) q.set("filter", f.filter);
  if (f.filter === "due_soon" && f.days) q.set("days", String(f.days));
  if (f.stage) q.set("stage", f.stage);
  if (f.scope) q.set("scope", f.scope);
  if (f.customerId) q.set("customer", f.customerId);
  const qs = q.toString();
  return `/o/${orgId}/jobs${qs ? `?${qs}` : ""}`;
}

/** The overdue-work rule (identical to the dashboard aggregate): active or
 * on-hold, not archived (the list never includes archived), due before the
 * ORG's current day. */
export function jobIsOverdue(
  j: { statusCategory: string; dueDate?: string | null },
  asOf: string,
): boolean {
  return (
    (j.statusCategory === "active" || j.statusCategory === "on_hold") &&
    !!j.dueDate &&
    j.dueDate < asOf
  );
}

/** Due within the window, not yet overdue (the dashboard's "Next" rule). */
export function jobIsDueSoon(
  j: { statusCategory: string; dueDate?: string | null },
  asOf: string,
  days: number,
): boolean {
  if (!j.dueDate || (j.statusCategory !== "active" && j.statusCategory !== "on_hold")) return false;
  if (j.dueDate < asOf) return false;
  const due = Date.parse(`${j.dueDate}T00:00:00Z`);
  const from = Date.parse(`${asOf}T00:00:00Z`);
  return (due - from) / 86_400_000 <= days;
}

// ── Report review (/reports/review) ─────────────────────────────────────────
export const REVIEW_FOCUS = ["queue", "missing"] as const;
export type ReviewFocus = (typeof REVIEW_FOCUS)[number];

export function parseReviewSearch(sp: { focus?: string }): { focus: ReviewFocus } {
  return {
    focus: (REVIEW_FOCUS as readonly string[]).includes(sp.focus ?? "")
      ? (sp.focus as ReviewFocus)
      : "queue",
  };
}

export function reviewHref(orgId: string, focus: ReviewFocus = "queue"): string {
  return `/o/${orgId}/reports/review${focus === "missing" ? "?focus=missing" : ""}`;
}

// ── Receivables (/ar) ───────────────────────────────────────────────────────
export const AR_VIEWS = ["all", "overdue", "over90"] as const;
export type ArView = (typeof AR_VIEWS)[number];

export function parseArSearch(sp: { view?: string; customer?: string }): {
  view: ArView;
  customerId: string | null;
} {
  return {
    view: (AR_VIEWS as readonly string[]).includes(sp.view ?? "") ? (sp.view as ArView) : "all",
    customerId: parseCustomerParam(sp).customerId,
  };
}

export function arHref(orgId: string, view: ArView = "all", customerId?: string | null): string {
  const q = new URLSearchParams();
  if (view !== "all") q.set("view", view);
  if (customerId) q.set("customer", customerId);
  const qs = q.toString();
  return `/o/${orgId}/ar${qs ? `?${qs}` : ""}`;
}

// ── Invoices (/invoices) ────────────────────────────────────────────────────
export function parseInvoicesSearch(sp: { customer?: string }): { customerId: string | null } {
  return parseCustomerParam(sp);
}

export function invoicesHref(orgId: string, customerId?: string | null): string {
  return `/o/${orgId}/invoices${customerId ? `?customer=${customerId}` : ""}`;
}

// ── Issues (/issues) ────────────────────────────────────────────────────────
export function parseIssuesSearch(sp: { view?: string }): { blocking: boolean } {
  return { blocking: sp.view === "blocking" };
}

export function issuesHref(orgId: string, blocking = false): string {
  return `/o/${orgId}/issues${blocking ? "?view=blocking" : ""}`;
}

// ── Material requests (/material-requests) ──────────────────────────────────
/** The purchasing-decision statuses the dashboard counts. */
export const MR_FILTER_STATUSES = ["approved", "submitted"] as const;
export type MrFilterStatus = (typeof MR_FILTER_STATUSES)[number];

export function parseMrSearch(sp: { status?: string }): { status: MrFilterStatus | null } {
  return {
    status: (MR_FILTER_STATUSES as readonly string[]).includes(sp.status ?? "")
      ? (sp.status as MrFilterStatus)
      : null,
  };
}

export function mrHref(orgId: string, status?: MrFilterStatus): string {
  return `/o/${orgId}/material-requests${status ? `?status=${status}` : ""}`;
}

// ── Purchase orders (/purchase-orders) ──────────────────────────────────────
export const PO_FILTER_STATUSES = ["partially_received"] as const;
export type PoFilterStatus = (typeof PO_FILTER_STATUSES)[number];

export function parsePoSearch(sp: { status?: string }): { status: PoFilterStatus | null } {
  return {
    status: (PO_FILTER_STATUSES as readonly string[]).includes(sp.status ?? "")
      ? (sp.status as PoFilterStatus)
      : null,
  };
}

export function poHref(orgId: string, status?: PoFilterStatus): string {
  return `/o/${orgId}/purchase-orders${status ? `?status=${status}` : ""}`;
}

// ── Expenses (/expenses) ────────────────────────────────────────────────────
export function parseExpensesSearch(sp: { status?: string }): { unpaid: boolean } {
  return { unpaid: sp.status === "unpaid" };
}

export function expensesHref(orgId: string, unpaid = false): string {
  return `/o/${orgId}/expenses${unpaid ? "?status=unpaid" : ""}`;
}

/** The dashboard's unpaid-expense rule (extras.unpaidExpenses). */
export function expenseIsUnpaid(e: { paymentStatus: string; voidedAt: string | null }): boolean {
  return e.voidedAt === null && e.paymentStatus === "unpaid";
}

// ── Quotes (/quotes) ────────────────────────────────────────────────────────
/** The dashboard's "awaiting action" quote statuses (extras.quotesAwaiting). */
export const QUOTE_AWAITING_STATUSES = ["draft", "pending_approval"] as const;

export function parseQuotesSearch(sp: { status?: string; customer?: string; expiring?: string }): {
  awaiting: boolean;
  customerId: string | null;
  /** H20: only sendable quotes (approved/sent) whose validity ends within N
   * days (1..90); null = no expiry narrowing. */
  expiringDays: number | null;
} {
  const n = Number.parseInt(sp.expiring ?? "", 10);
  return {
    awaiting: sp.status === "awaiting",
    customerId: parseCustomerParam(sp).customerId,
    expiringDays: Number.isInteger(n) && n >= 1 && n <= 90 ? n : null,
  };
}

export function quotesHref(
  orgId: string,
  awaiting = false,
  customerId?: string | null,
  expiringDays?: number | null,
): string {
  const q = new URLSearchParams();
  if (awaiting) q.set("status", "awaiting");
  if (customerId) q.set("customer", customerId);
  if (expiringDays) q.set("expiring", String(expiringDays));
  const qs = q.toString();
  return `/o/${orgId}/quotes${qs ? `?${qs}` : ""}`;
}

export function quoteIsAwaiting(q: { status: string }): boolean {
  return (QUOTE_AWAITING_STATUSES as readonly string[]).includes(q.status);
}

/** The dashboard's expiring-quote rule: still actionable (approved or sent),
 * has an expiry date, and that date falls inside [asOf, asOf + days]. */
export function quoteIsExpiring(
  q: { status: string; validUntil: string | null },
  asOf: string,
  days: number,
): boolean {
  if (q.status !== "approved" && q.status !== "sent") return false;
  if (!q.validUntil || q.validUntil < asOf) return false;
  const until = Date.parse(`${q.validUntil.slice(0, 10)}T00:00:00Z`);
  const from = Date.parse(`${asOf}T00:00:00Z`);
  return (until - from) / 86_400_000 <= days;
}

// ── Leads (/leads) — H20 ────────────────────────────────────────────────────
export const LEAD_FILTER_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "disqualified",
  "converted",
] as const;
export type LeadFilterStatus = (typeof LEAD_FILTER_STATUSES)[number];

export type LeadsSearch = {
  q: string | null;
  status: LeadFilterStatus | null;
  /** Owner user id (validated uuid). */
  owner: string | null;
  source: string | null;
  /** Only leads with an overdue, uncompleted follow-up. */
  overdue: boolean;
  archived: boolean;
};

export function parseLeadsSearch(sp: {
  q?: string;
  status?: string;
  owner?: string;
  source?: string;
  focus?: string;
  view?: string;
}): LeadsSearch {
  const q = (sp.q ?? "").trim().slice(0, 120);
  const source = (sp.source ?? "").trim().slice(0, 80);
  return {
    q: q.length > 0 ? q : null,
    status: (LEAD_FILTER_STATUSES as readonly string[]).includes(sp.status ?? "")
      ? (sp.status as LeadFilterStatus)
      : null,
    owner: sp.owner && UUID_RE.test(sp.owner) ? sp.owner : null,
    source: source.length > 0 ? source : null,
    overdue: sp.focus === "overdue",
    archived: sp.view === "archived",
  };
}

export function leadsHref(
  orgId: string,
  f: Partial<Pick<LeadsSearch, "q" | "status" | "owner" | "source" | "overdue" | "archived">> = {},
): string {
  const q = new URLSearchParams();
  if (f.q) q.set("q", f.q);
  if (f.status) q.set("status", f.status);
  if (f.owner) q.set("owner", f.owner);
  if (f.source) q.set("source", f.source);
  if (f.overdue) q.set("focus", "overdue");
  if (f.archived) q.set("view", "archived");
  const qs = q.toString();
  return `/o/${orgId}/leads${qs ? `?${qs}` : ""}`;
}

// ── Opportunities (/opportunities) — H20 ────────────────────────────────────
export type OpportunitiesSearch = {
  /** Board (grouped by open stage) is the default; list is the alternative. */
  view: "board" | "list";
  /** Stage-key filter (shape-validated; unknown keys give an honest empty). */
  stage: string | null;
  owner: string | null;
  customerId: string | null;
  /** Open opportunities whose expected close falls within N days (1..365). */
  closing: number | null;
  /** Only opportunities with an overdue, uncompleted follow-up. */
  followup: boolean;
  status: "open" | "won" | "lost" | null;
  archived: boolean;
};

export function parseOpportunitiesSearch(sp: {
  view?: string;
  stage?: string;
  owner?: string;
  customer?: string;
  closing?: string;
  focus?: string;
  status?: string;
}): OpportunitiesSearch {
  const n = Number.parseInt(sp.closing ?? "", 10);
  return {
    view: sp.view === "list" ? "list" : "board",
    stage: sp.stage && STAGE_KEY_RE.test(sp.stage) ? sp.stage : null,
    owner: sp.owner && UUID_RE.test(sp.owner) ? sp.owner : null,
    customerId: parseCustomerParam(sp).customerId,
    closing: Number.isInteger(n) && n >= 1 && n <= 365 ? n : null,
    followup: sp.focus === "followup",
    status: sp.status === "open" || sp.status === "won" || sp.status === "lost" ? sp.status : null,
    archived: sp.view === "archived",
  };
}

export function opportunitiesHref(
  orgId: string,
  f: Partial<
    Pick<
      OpportunitiesSearch,
      "view" | "stage" | "owner" | "customerId" | "closing" | "followup" | "status"
    >
  > = {},
): string {
  const q = new URLSearchParams();
  if (f.view === "list") q.set("view", "list");
  if (f.stage) q.set("stage", f.stage);
  if (f.owner) q.set("owner", f.owner);
  if (f.customerId) q.set("customer", f.customerId);
  if (f.closing) q.set("closing", String(f.closing));
  if (f.followup) q.set("focus", "followup");
  if (f.status) q.set("status", f.status);
  const qs = q.toString();
  return `/o/${orgId}/opportunities${qs ? `?${qs}` : ""}`;
}

// ── Sales overview (/sales) — H20 ───────────────────────────────────────────
export const SALES_PERIODS = [7, 30, 90] as const;

export function parseSalesSearch(sp: { days?: string }): { days: number } {
  const n = Number.parseInt(sp.days ?? "", 10);
  return { days: (SALES_PERIODS as readonly number[]).includes(n) ? n : 30 };
}

export function salesHref(orgId: string, days?: number): string {
  return `/o/${orgId}/sales${days && days !== 30 ? `?days=${days}` : ""}`;
}

// ── Work hub (/jobs) — H21 ──────────────────────────────────────────────────
export const WORK_VIEWS = ["list", "board", "schedule"] as const;
export type WorkView = (typeof WORK_VIEWS)[number];

export const WORK_CATEGORY_FILTERS = ["draft", "active", "on_hold", "done", "cancelled"] as const;
export const WORK_PRIORITY_FILTERS = ["low", "normal", "high", "urgent"] as const;
export const WORK_ORIGIN_FILTERS = ["quotation", "opportunity", "direct"] as const;

export type WorkSearch = {
  view: WorkView;
  q: string | null;
  category: string | null;
  priority: string | null;
  origin: string | null;
  stage: string | null;
  owner: string | null;
  assignee: string | null;
  customerId: string | null;
  dueFrom: string | null;
  dueTo: string | null;
  overdue: boolean;
  archived: boolean;
  scope: "mine" | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseWorkSearch(sp: {
  view?: string;
  q?: string;
  category?: string;
  priority?: string;
  origin?: string;
  stage?: string;
  owner?: string;
  assignee?: string;
  customer?: string;
  from?: string;
  to?: string;
  focus?: string;
  scope?: string;
}): WorkSearch {
  const q = (sp.q ?? "").trim().slice(0, 120);
  const pick = (v: string | undefined, allowed: readonly string[]) =>
    v && allowed.includes(v) ? v : null;
  return {
    view: (WORK_VIEWS as readonly string[]).includes(sp.view ?? "")
      ? (sp.view as WorkView)
      : "list",
    q: q.length > 0 ? q : null,
    category: pick(sp.category, WORK_CATEGORY_FILTERS),
    priority: pick(sp.priority, WORK_PRIORITY_FILTERS),
    origin: pick(sp.origin, WORK_ORIGIN_FILTERS),
    stage: sp.stage && STAGE_KEY_RE.test(sp.stage) ? sp.stage : null,
    owner: sp.owner && UUID_RE.test(sp.owner) ? sp.owner : null,
    assignee: sp.assignee && UUID_RE.test(sp.assignee) ? sp.assignee : null,
    customerId: parseCustomerParam(sp).customerId,
    dueFrom: sp.from && DATE_RE.test(sp.from) ? sp.from : null,
    dueTo: sp.to && DATE_RE.test(sp.to) ? sp.to : null,
    overdue: sp.focus === "overdue",
    archived: sp.focus === "archived",
    scope: sp.scope === "mine" ? "mine" : null,
  };
}

export function workHref(
  orgId: string,
  f: Partial<Omit<WorkSearch, "view">> & { view?: WorkView } = {},
): string {
  const q = new URLSearchParams();
  if (f.view && f.view !== "list") q.set("view", f.view);
  if (f.q) q.set("q", f.q);
  if (f.category) q.set("category", f.category);
  if (f.priority) q.set("priority", f.priority);
  if (f.origin) q.set("origin", f.origin);
  if (f.stage) q.set("stage", f.stage);
  if (f.owner) q.set("owner", f.owner);
  if (f.assignee) q.set("assignee", f.assignee);
  if (f.customerId) q.set("customer", f.customerId);
  if (f.dueFrom) q.set("from", f.dueFrom);
  if (f.dueTo) q.set("to", f.dueTo);
  if (f.overdue) q.set("focus", "overdue");
  else if (f.archived) q.set("focus", "archived");
  if (f.scope) q.set("scope", f.scope);
  const qs = q.toString();
  return `/o/${orgId}/jobs${qs ? `?${qs}` : ""}`;
}

// ── My Work (/my-work) — H21 ────────────────────────────────────────────────
export const MY_WORK_FOCUS = ["now", "overdue", "today", "blocked", "approvals", "next"] as const;
export type MyWorkFocus = (typeof MY_WORK_FOCUS)[number];

export function parseMyWorkSearch(sp: { focus?: string }): { focus: MyWorkFocus } {
  return {
    focus: (MY_WORK_FOCUS as readonly string[]).includes(sp.focus ?? "")
      ? (sp.focus as MyWorkFocus)
      : "now",
  };
}

export function myWorkHref(orgId: string, focus: MyWorkFocus = "now"): string {
  return `/o/${orgId}/my-work${focus === "now" ? "" : `?focus=${focus}`}`;
}

/** The overdue rule for a task, shared by every surface that shows one. */
export function taskIsOverdue(
  t: { status: string; dueDate: string | null },
  asOf: string,
): boolean {
  if (t.dueDate === null || t.dueDate >= asOf) return false;
  return t.status !== "completed" && t.status !== "cancelled";
}
