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
};

const STAGE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export function parseJobsSearch(sp: {
  filter?: string;
  days?: string;
  stage?: string;
  scope?: string;
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
  };
}

export function jobsHref(
  orgId: string,
  f: Partial<Pick<JobsSearch, "filter" | "days" | "stage" | "scope">> = {},
): string {
  const q = new URLSearchParams();
  if (f.filter) q.set("filter", f.filter);
  if (f.filter === "due_soon" && f.days) q.set("days", String(f.days));
  if (f.stage) q.set("stage", f.stage);
  if (f.scope) q.set("scope", f.scope);
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

export function parseArSearch(sp: { view?: string }): { view: ArView } {
  return {
    view: (AR_VIEWS as readonly string[]).includes(sp.view ?? "") ? (sp.view as ArView) : "all",
  };
}

export function arHref(orgId: string, view: ArView = "all"): string {
  return `/o/${orgId}/ar${view === "all" ? "" : `?view=${view}`}`;
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

export function parseQuotesSearch(sp: { status?: string }): { awaiting: boolean } {
  return { awaiting: sp.status === "awaiting" };
}

export function quotesHref(orgId: string, awaiting = false): string {
  return `/o/${orgId}/quotes${awaiting ? "?status=awaiting" : ""}`;
}

export function quoteIsAwaiting(q: { status: string }): boolean {
  return (QUOTE_AWAITING_STATUSES as readonly string[]).includes(q.status);
}
