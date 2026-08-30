/**
 * H17 — the adaptive dashboard composer (blueprint organizations only).
 *
 * ONE pure, deterministic composition point: same inputs, same output, always.
 * No I/O, no clock, no randomness, no AI. The page gathers live data through
 * the existing permission-safe services (./service.ts) and this file decides
 * WHAT renders, WHERE, and in WHICH ORDER.
 *
 * The composition law (H17 Part B) for every card-keyed item:
 *
 *   effective = platform-supported (DASHBOARD_CARD_KEYS)
 *             ∩ approved blueprint (module not disabled by configuration —
 *               the blueprint's CAPABILITIES section is the composition
 *               layer, exactly as H16 nav filtering treats it)
 *             ∩ live plan entitlement (a plan change is honoured immediately)
 *             ∩ acting-user permission (can(), plus price privilege for money)
 *             ∩ role relevance (CARD_ROLES — the shipped role experiences)
 *
 * The blueprint's DASHBOARD section (compiled.dashboards[archetype]) is
 * emphasis, not composition: its card list is the role's configured top
 * priorities (onboarding authors at most a handful), so membership BOOSTS
 * priority and contributes the org's own "why" text; attentionSignals and
 * decisionsRequired boost further; timeHorizon bounds the "Next" window.
 * Treating that short priority list as a whitelist would permanently hide
 * real risk signals the organization never chose to exclude (blockers,
 * overdue receivables), which Part M forbids for mandatory critical signals.
 *
 * Live data then decides whether an allowed card actually appears (an empty
 * queue renders nothing), its severity, and its position via the deterministic
 * priority model below. Legacy organizations (no applied blueprint) NEVER
 * reach this composer — the page renders the pre-H17 screens unchanged.
 *
 * Priority (H17 Part D) is transparent and bounded: severity dominates,
 * category weights keep blocking/safety work ahead of purely financial
 * signals (money exposure can never outrank a blocker), the org's approved
 * blueprint nudges its declared attention/decision signals, and ties break
 * on the stable card key. The numeric score is internal — the UI shows the
 * reason ("why this is here"), never the number.
 */
import { can, type Action } from "@/platform/authz";
import {
  DASHBOARD_CARD_KEYS,
  DASHBOARD_CARD_MODULE,
  type BlueprintArchetype,
  type DashboardCardKey,
  type WorkspaceModuleKey,
} from "@/platform/workspace";
import type { ExceptionView } from "@/modules/exceptions/service";
import type { ARSummary } from "@/modules/invoices/service";
import type { InboxRow } from "@/modules/approvals/service";
import type { DashboardExtras } from "@/modules/today/service";
import {
  arHref,
  expensesHref,
  issuesHref,
  jobsHref,
  mrHref,
  opportunitiesHref,
  poHref,
  quotesHref,
  reviewHref,
  salesHref,
  workHref,
} from "./filters";

// ── The per-role compiled dashboard (shape.compiled.dashboards[archetype]) ──
export type CompiledRoleDashboard = {
  cards: Array<{ key: DashboardCardKey; why: Record<string, string> }>;
  attentionSignals: DashboardCardKey[];
  decisionsRequired: DashboardCardKey[];
  timeHorizon: string;
} | null;

/** The permission that must hold before a card's data may even be fetched. */
export const CARD_ACTION: Record<DashboardCardKey, Action> = {
  my_jobs_today: "jobs.view",
  submit_daily_report: "reports.create",
  waiting_on_me: "reports.create",
  missing_reports: "exceptions.view",
  overdue: "exceptions.view",
  blockers: "exceptions.view",
  reports_to_review: "reports.review",
  missing_today: "reports.review",
  invoices_to_issue: "invoices.view",
  overdue_receivables: "ar.view",
  ar_summary: "ar.view",
  payments_week: "payments.view",
  expenses_queue: "expenses.view",
  needs_decision: "approvals.decide",
  at_risk: "exceptions.view",
  collections: "ar.view",
  approved_mrs: "po.view",
  open_pos: "po.view",
  // H20 sales CRM.
  overdue_followups: "opportunities.view",
  opportunities_closing: "opportunities.view",
  quotes_expiring: "quotes.view",
  pipeline_value: "opportunities.view",
  // H21 adaptive work.
  work_at_risk: "jobs.view",
  overdue_tasks: "tasks.view",
  blocked_tasks: "tasks.view",
  work_due_soon: "jobs.view",
  unassigned_urgent: "jobs.edit",
};

/** Role relevance when the blueprint does not configure a role's dashboard.
 * Mirrors the shipped role experiences (H17 Part F) — permission still
 * intersects on top, so a card never widens what a role could see anyway. */
export const CARD_ROLES: Record<DashboardCardKey, readonly BlueprintArchetype[]> = {
  my_jobs_today: ["foreman"],
  submit_daily_report: ["foreman"],
  waiting_on_me: ["foreman"],
  missing_reports: ["owner", "admin", "manager"],
  overdue: ["owner", "admin", "manager"],
  blockers: ["owner", "admin", "manager", "foreman"],
  reports_to_review: ["owner", "admin", "manager"],
  missing_today: ["owner", "admin", "manager"],
  invoices_to_issue: ["owner", "admin", "accounts"],
  overdue_receivables: ["owner", "admin", "accounts"],
  ar_summary: ["owner", "admin", "accounts"],
  payments_week: ["owner", "admin", "accounts"],
  expenses_queue: ["owner", "admin", "accounts"],
  needs_decision: ["owner", "admin", "manager", "accounts"],
  at_risk: ["owner", "admin"],
  collections: ["owner", "admin", "accounts"],
  approved_mrs: ["owner", "admin", "procurement"],
  open_pos: ["owner", "admin", "manager", "procurement"],
  // H20 sales CRM: managers run the pipeline; the forecast total additionally
  // requires price privilege (pulse gate), so it never leaks through roles.
  overdue_followups: ["owner", "admin", "manager"],
  opportunities_closing: ["owner", "admin", "manager"],
  quotes_expiring: ["owner", "admin", "manager"],
  pipeline_value: ["owner", "admin"],
  // H21: delivery signals reach the people who run delivery, including the
  // foreman for their own assigned work.
  work_at_risk: ["owner", "admin", "manager"],
  overdue_tasks: ["owner", "admin", "manager", "foreman"],
  blocked_tasks: ["owner", "admin", "manager", "foreman"],
  work_due_soon: ["owner", "admin", "manager", "foreman"],
  unassigned_urgent: ["owner", "admin", "manager"],
};

/** H14 TIME_HORIZONS → the "Next" window in days. */
export const HORIZON_DAYS: Record<string, number> = {
  today: 2,
  this_week: 7,
  this_month: 30,
  this_quarter: 90,
};

export type ComposeContext = {
  orgId: string;
  archetype: BlueprintArchetype;
  /** ctx.pricePrivileged — every money figure additionally requires it. */
  seesPrice: boolean;
  /** LIVE resolveEntitlements(ctx).features — plan changes apply immediately. */
  features: Record<string, boolean>;
  /** Modules the approved blueprint switched off (disabledModulesOf). */
  disabledModules: ReadonlySet<WorkspaceModuleKey>;
  /** shape.compiled.dashboards[archetype] (null = role not configured). */
  compiledDashboard: CompiledRoleDashboard;
  /** Org-timezone calendar date (YYYY-MM-DD) — all boundaries use it. */
  asOf: string;
};

/** The H17 Part B effective-content equation for one card. */
export function cardAllowed(key: DashboardCardKey, cx: ComposeContext): boolean {
  const mod = DASHBOARD_CARD_MODULE[key];
  // Approved blueprint: configuration layer.
  if (mod !== null && cx.disabledModules.has(mod)) return false;
  // Live plan entitlement (module keys ARE feature keys).
  if (mod !== null && cx.features[mod] !== true) return false;
  // Acting-user permission.
  if (!can(cx.archetype, CARD_ACTION[key])) return false;
  // Role relevance (the shipped role experiences; permission already
  // intersected above, so this can only narrow, never widen).
  if (!CARD_ROLES[key].includes(cx.archetype)) return false;
  return true;
}

/** Every card the equation allows for this context, in registry order. */
export function allowedCards(cx: ComposeContext): DashboardCardKey[] {
  return DASHBOARD_CARD_KEYS.filter((k) => cardAllowed(k, cx));
}

// ── Live inputs (each already permission-redacted by its owning service) ────
export type DashboardData = {
  /** listOpenExceptions — audience-scoped; null = source failed/not permitted. */
  exceptions: ExceptionView[] | null;
  /** getDashboardExtras — internally can()-gated per block. */
  extras: DashboardExtras | null;
  /** listInbox — approvals.decide holders only. */
  inbox: InboxRow[] | null;
  /** computeAR — self-redacting (null money for non-price-privileged). */
  ar: ARSummary | null;
  /** Foreman-only rows (composeToday foreman cards). */
  myJobs: Array<{ id: string; reference: string; name: string; lastReport: string | null }> | null;
  returnedReports: Array<{ id: string; reference: string; reportDate: string }> | null;
  /** Manager review queue (reports.review holders): submitted reports waiting
   * for review + active jobs with no report yet today (scoped like today). */
  reviewQueue: { toReview: number; missingToday: number } | null;
  /** H20 salesDashboardCounts — opportunities.view holders; forecast value
   * self-redacts to null without price privilege. */
  sales: {
    overdueFollowUps: number;
    closingSoon: number;
    quotesExpiring: number;
    openPipelineMinor: number | null;
    openPipelineCount: number;
  } | null;
  /** H21 workDashboardCounts — jobs.view holders; foreman narrowed to assigned. */
  work: {
    activeWork: number;
    overdueWork: number;
    workDueSoon: number;
    overdueTasks: number;
    blockedTasks: number;
    unassignedUrgentWork: number;
  } | null;
  /** Source keys that FAILED (threw) — rendered as honest unavailability. */
  failed: readonly string[];
};

export type Severity = "critical" | "warning" | "info";

export type DashboardItem = {
  /** Stable unique key (also the tie-break anchor). */
  key: string;
  cardKey: DashboardCardKey;
  kind: "attention" | "decision" | "next";
  severity: Severity;
  /** i18n key + vars for the one-line statement of WHAT happened. */
  titleKey: string;
  vars?: Record<string, string | number>;
  /** i18n key + vars for the restrained "why this is here" line. */
  whyKey: string;
  whyVars?: Record<string, string | number>;
  /** Where the supporting records live (filtered destination). */
  href: string;
  count: number;
  /** True when the acting user holds the authority to act (not just view). */
  canAct: boolean;
  /** The org's own configured reason for prioritizing this card ({en, ar}),
   * from the approved blueprint's dashboard section — shown when present. */
  blueprintWhy?: Record<string, string>;
  /** Internal ordering score — never rendered (H17 Part D). */
  score: number;
};

export type PulseMetric = {
  key: string;
  labelKey: string;
  /** Pre-formatted by the page (money) or a plain count. */
  value: number | null;
  money: boolean;
  /** i18n key describing period + inclusion rule (H17 Part G). */
  periodKey: string;
  href: string;
  /** null value + unavailable=true → "not available", never 0. */
  unavailable: boolean;
  /** Optional secondary line (e.g. week-over-week delta). */
  deltaPrev?: number;
};

export type AdaptiveDashboardView = {
  attention: DashboardItem[];
  next: DashboardItem[];
  pulse: PulseMetric[];
  /** In-progress: stage distribution (management) / my jobs (field). */
  showStages: boolean;
  showMyJobs: boolean;
  showActivity: boolean;
  /** Days ahead the "Next" section looks (from the blueprint's horizon). */
  horizonDays: number;
  /** Honest labels for failed sources (H17 Part L). */
  unavailable: readonly string[];
  /** True when nothing needs attention AND nothing is next — all clear. */
  allClear: boolean;
};

// ── The deterministic priority model (H17 Part D) ───────────────────────────
// Two structural guarantees, both pinned by tests:
//  1. SEVERITY STRICTLY DOMINATES. The smallest severity gap (40) exceeds the
//     largest possible non-severity contribution (category 12 + count band 4
//     + age 6 + blueprint emphasis 12 = 34), so a warning can never outrank a
//     critical no matter how large, old, or emphasized it is.
//  2. MONEY NEVER OUTRANKS BLOCKING WORK at equal severity. Financial cards
//     carry category weight 8 and their auxiliary boosts are clamped to 3,
//     so their ceiling (severity + 11) sits below a blocking card's floor
//     (severity + 12).
const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 100, warning: 60, info: 20 };
/** Category weights: blocking/safety (12) > decisions (10) > operational
 * gaps (8) ≥ financial exposure (8) > purchasing flow (6) > the rest (4). */
const CATEGORY_WEIGHT: Record<DashboardCardKey, number> = {
  blockers: 12,
  overdue: 12,
  missing_today: 8,
  missing_reports: 8,
  waiting_on_me: 10,
  submit_daily_report: 10,
  my_jobs_today: 4,
  reports_to_review: 10,
  needs_decision: 10,
  invoices_to_issue: 8,
  overdue_receivables: 8,
  collections: 8,
  ar_summary: 4,
  payments_week: 4,
  expenses_queue: 6,
  at_risk: 8,
  approved_mrs: 6,
  open_pos: 4,
  // H20: a stalled promise to a person (8) outranks calendar proximity (6/6);
  // the pipeline total is pulse-grade context (4).
  overdue_followups: 8,
  opportunities_closing: 6,
  quotes_expiring: 6,
  pipeline_value: 4,
  // Delivery at risk is blocking-grade; a blocked task stops a person working.
  work_at_risk: 12,
  blocked_tasks: 12,
  overdue_tasks: 8,
  unassigned_urgent: 10,
  work_due_soon: 6,
};

function band(n: number, max: number): number {
  if (n <= 0) return 0;
  return Math.min(max, Math.ceil(Math.log2(n + 1)));
}

/** Cards whose weight represents financial exposure — their auxiliary boosts
 * are clamped so money can never outrank blocking work (guarantee 2). */
const MONEY_CARDS: ReadonlySet<DashboardCardKey> = new Set([
  "invoices_to_issue",
  "overdue_receivables",
  "collections",
  "ar_summary",
  "payments_week",
  "expenses_queue",
  // H20: forecast value is money-adjacent — same clamp, never outranks blockers.
  "pipeline_value",
]);

export function priorityOf(input: {
  cardKey: DashboardCardKey;
  severity: Severity;
  count: number;
  /** Age in whole days of the oldest underlying record (0 = today). */
  oldestDays?: number;
  compiledDashboard: CompiledRoleDashboard;
}): number {
  let aux = band(input.count, 4);
  aux += Math.min(6, Math.max(0, input.oldestDays ?? 0));
  if (input.compiledDashboard) {
    // The org's approved emphasis (never composition — see the header law).
    if (input.compiledDashboard.cards.some((c) => c.key === input.cardKey)) aux += 3;
    if (input.compiledDashboard.attentionSignals.includes(input.cardKey)) aux += 5;
    if (input.compiledDashboard.decisionsRequired.includes(input.cardKey)) aux += 4;
  }
  if (MONEY_CARDS.has(input.cardKey)) aux = Math.min(aux, 3);
  return SEVERITY_WEIGHT[input.severity] + CATEGORY_WEIGHT[input.cardKey] + aux;
}

/** Stable ordering: score desc, then card key asc, then item key asc. */
export function sortItems(items: DashboardItem[]): DashboardItem[] {
  return [...items].sort(
    (a, b) => b.score - a.score || a.cardKey.localeCompare(b.cardKey) || a.key.localeCompare(b.key),
  );
}

// Exceptions grouped under a card share ONE item (no duplicate attention rows
// for the same underlying problem); the raw exception list stays one click away.
const EXCEPTION_CARD: Partial<Record<string, DashboardCardKey>> = {
  missing_report: "missing_reports",
  overdue_stage: "overdue",
  blocking_issue: "blockers",
  overdue_invoice: "overdue_receivables",
  billing_point_uninvoiced: "invoices_to_issue",
};

/** The authority that lets the user ACT on an exception-backed signal (the
 * view permission already passed — this is honesty about the action button). */
const EXCEPTION_ACT_ACTION: Partial<Record<string, Action>> = {
  missing_report: "reports.review",
  overdue_stage: "stages.update",
  blocking_issue: "issues.resolve",
  overdue_invoice: "invoices.manage",
  billing_point_uninvoiced: "invoices.manage",
};

function worstSeverity(rows: ExceptionView[]): Severity {
  if (rows.some((r) => r.severity === "critical")) return "critical";
  if (rows.some((r) => r.severity === "warning")) return "warning";
  return "info";
}

function daysBetween(fromISO: string, toDate: string): number {
  const from = Date.parse(fromISO.slice(0, 10) + "T00:00:00Z");
  const to = Date.parse(toDate + "T00:00:00Z");
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}

/** The whole adaptive dashboard, deterministically, from gathered facts. */
export function composeAdaptiveDashboard(
  cx: ComposeContext,
  data: DashboardData,
): AdaptiveDashboardView {
  const allowed = new Set(allowedCards(cx));
  const o = `/o/${cx.orgId}`;
  // Managers' job aggregates are assigned-scoped; their drill-downs carry the
  // same scope so count and destination agree (H18 filter contract).
  const jobScope = cx.archetype === "manager" ? ("mine" as const) : null;
  const items: DashboardItem[] = [];
  const nextItems: DashboardItem[] = [];
  const exceptions = data.exceptions ?? [];
  const byRule = (rule: string) => exceptions.filter((e) => e.ruleKey === rule);
  const horizonDays = HORIZON_DAYS[cx.compiledDashboard?.timeHorizon ?? ""] ?? 7;

  const add = (
    cardKey: DashboardCardKey,
    kind: DashboardItem["kind"],
    severity: Severity,
    count: number,
    titleKey: string,
    whyKey: string,
    href: string,
    opts: {
      vars?: Record<string, string | number>;
      whyVars?: Record<string, string | number>;
      oldestDays?: number;
      canAct?: boolean;
      key?: string;
    } = {},
  ) => {
    if (!allowed.has(cardKey) || count <= 0) return;
    const configured = cx.compiledDashboard?.cards.find((c) => c.key === cardKey);
    const item: DashboardItem = {
      key: opts.key ?? cardKey,
      cardKey,
      kind,
      severity,
      titleKey,
      vars: { count, ...opts.vars },
      whyKey,
      whyVars: { count, ...opts.whyVars },
      href,
      count,
      canAct: opts.canAct ?? true,
      blueprintWhy: configured?.why,
      score: priorityOf({
        cardKey,
        severity,
        count,
        oldestDays: opts.oldestDays,
        compiledDashboard: cx.compiledDashboard,
      }),
    };
    (kind === "next" ? nextItems : items).push(item);
  };

  // ── Needs your attention ──────────────────────────────────────────────────
  // Exception-backed signals (one row per rule — duplicates collapsed).
  for (const [rule, cardKey] of Object.entries(EXCEPTION_CARD) as Array<
    [string, DashboardCardKey]
  >) {
    const rows = byRule(rule);
    if (rows.length === 0) continue;
    const oldest = rows.reduce((acc, r) => Math.max(acc, daysBetween(r.raisedAt, cx.asOf)), 0);
    const jobHref = rows.length === 1 && rows[0]!.jobId ? `${o}/jobs/${rows[0]!.jobId}` : null;
    add(
      cardKey,
      cardKey === "invoices_to_issue" ? "decision" : "attention",
      worstSeverity(rows),
      rows.length,
      `dashboard.signal.${rule}`,
      `dashboard.why.${rule}`,
      jobHref ??
        (cardKey === "overdue_receivables"
          ? arHref(cx.orgId, "overdue")
          : cardKey === "invoices_to_issue"
            ? `${o}/invoices`
            : cardKey === "blockers"
              ? issuesHref(cx.orgId, true)
              : cardKey === "missing_reports"
                ? reviewHref(cx.orgId, "missing")
                : jobsHref(cx.orgId, { filter: "overdue", scope: jobScope })),
      {
        oldestDays: oldest,
        canAct: can(cx.archetype, EXCEPTION_ACT_ACTION[rule] ?? "exceptions.dismiss"),
      },
    );
  }

  // Overdue jobs from live records — only when no overdue_stage exception
  // already represents the same problem (duplicate-signal prevention).
  const overdueJobs = data.extras?.jobs?.overdue ?? 0;
  if (overdueJobs > 0 && byRule("overdue_stage").length === 0) {
    add(
      "overdue",
      "attention",
      "critical",
      overdueJobs,
      "dashboard.signal.overdue_jobs",
      "dashboard.why.overdue_jobs",
      jobsHref(cx.orgId, { filter: "overdue", scope: jobScope }),
      { key: "overdue_jobs" },
    );
  }

  // Approvals waiting on this user's authority — a decision, not noise.
  const inbox = data.inbox ?? [];
  if (inbox.length > 0) {
    const oldest = inbox.reduce((acc, r) => Math.max(acc, daysBetween(r.createdAt, cx.asOf)), 0);
    add(
      "needs_decision",
      "decision",
      oldest >= 2 ? "warning" : "info",
      inbox.length,
      "dashboard.signal.approvals",
      oldest >= 1 ? "dashboard.why.approvals_aged" : "dashboard.why.approvals",
      `${o}/approvals`,
      { oldestDays: oldest, whyVars: { days: oldest } },
    );
  }

  // Reports submitted and waiting for review (management decision work), and
  // jobs with no report yet TODAY (distinct from the nightly missing_report
  // exceptions, which cover earlier days — different problems, both real).
  const queue = data.reviewQueue;
  if (queue && queue.toReview > 0) {
    add(
      "reports_to_review",
      "decision",
      "info",
      queue.toReview,
      "dashboard.signal.reports_to_review",
      "dashboard.why.reports_to_review",
      reviewHref(cx.orgId),
    );
  }
  if (queue && queue.missingToday > 0) {
    add(
      "missing_today",
      "attention",
      "info",
      queue.missingToday,
      "dashboard.signal.missing_today",
      "dashboard.why.missing_today",
      reviewHref(cx.orgId, "missing"),
    );
  }

  // The field user's own day: jobs still needing today's report.
  const myJobs = data.myJobs ?? [];
  const toSubmit = myJobs.filter((j) => (j.lastReport ?? "") < cx.asOf);
  if (toSubmit.length > 0) {
    add(
      "submit_daily_report",
      "attention",
      "warning",
      toSubmit.length,
      "dashboard.signal.submit_report",
      "dashboard.why.submit_report",
      `${o}/reports/new`,
      { key: "submit_report" },
    );
  }

  // Returned reports waiting on the field user (their own correction queue).
  const returned = data.returnedReports ?? [];
  if (returned.length > 0) {
    add(
      "waiting_on_me",
      "attention",
      "warning",
      returned.length,
      "dashboard.signal.returned_reports",
      "dashboard.why.returned_reports",
      `${o}#returned`,
      { key: "returned_reports" },
    );
  }

  // Receivables over 90 days (price-privileged only; computeAR self-redacts).
  const over90 = cx.seesPrice ? (data.ar?.over90 ?? null) : null;
  if (over90 !== null && over90 > 0 && byRule("overdue_invoice").length === 0) {
    add(
      "collections",
      "attention",
      "warning",
      1,
      "dashboard.signal.over90",
      "dashboard.why.over90",
      arHref(cx.orgId, "over90"),
      { key: "over90" },
    );
  }

  // H21: delivery signals. Work past its target date and blocked tasks are
  // blocking-grade; every count drills to the exact records behind it.
  const work = data.work;
  if (work && work.overdueWork > 0) {
    add(
      "work_at_risk",
      "attention",
      "critical",
      work.overdueWork,
      "dashboard.signal.work_at_risk",
      "dashboard.why.work_at_risk",
      // No jobScope: workDashboardCounts narrows for a foreman only, and so does
      // the work hub. Carrying the manager's "mine" scope sent them from an
      // org-wide count to a list of only their own work.
      workHref(cx.orgId, { overdue: true }),
      { canAct: can(cx.archetype, "jobs.edit") },
    );
  }
  if (work && work.blockedTasks > 0) {
    add(
      "blocked_tasks",
      "attention",
      "warning",
      work.blockedTasks,
      "dashboard.signal.blocked_tasks",
      "dashboard.why.blocked_tasks",
      `${o}/my-work?focus=blocked`,
      { canAct: can(cx.archetype, "tasks.update_status") },
    );
  }
  if (work && work.overdueTasks > 0) {
    add(
      "overdue_tasks",
      "attention",
      "warning",
      work.overdueTasks,
      "dashboard.signal.overdue_tasks",
      "dashboard.why.overdue_tasks",
      `${o}/my-work?focus=overdue`,
      { canAct: can(cx.archetype, "tasks.update_status") },
    );
  }
  if (work && work.unassignedUrgentWork > 0) {
    add(
      "unassigned_urgent",
      "decision",
      "warning",
      work.unassignedUrgentWork,
      "dashboard.signal.unassigned_urgent",
      "dashboard.why.unassigned_urgent",
      // The count is "high or urgent, open, no owner". All three predicates have
      // to survive into the URL or the list shows a different set than the number
      // counted: priority carries both values, unowned carries the rest.
      workHref(cx.orgId, { priority: "high,urgent", unowned: true, open: true }),
      { canAct: can(cx.archetype, "jobs.edit") },
    );
  }

  // H20: overdue sales follow-ups — a promise to a person that has slipped.
  const salesCounts = data.sales;
  if (salesCounts && salesCounts.overdueFollowUps > 0) {
    add(
      "overdue_followups",
      "attention",
      "warning",
      salesCounts.overdueFollowUps,
      "dashboard.signal.overdue_followups",
      "dashboard.why.overdue_followups",
      salesHref(cx.orgId),
      { canAct: can(cx.archetype, "opportunities.manage") },
    );
  }

  // Purchasing exceptions: approved requests waiting to become orders.
  const mrApproved = data.extras?.mrOpen?.approved ?? 0;
  if (mrApproved > 0) {
    add(
      "approved_mrs",
      cx.archetype === "procurement" ? "decision" : "attention",
      "info",
      mrApproved,
      "dashboard.signal.mr_approved",
      "dashboard.why.mr_approved",
      mrHref(cx.orgId, "approved"),
      { canAct: can(cx.archetype, "mr.convert") },
    );
  }

  // ── Next (approaching, not yet critical — bounded by the horizon) ─────────
  const deadlines = (data.extras?.deadlines ?? []).filter((d) => !d.overdue);
  const withinHorizon = deadlines.filter((d) => daysBetween(cx.asOf, d.dueDate) <= horizonDays);
  if (withinHorizon.length > 0) {
    add(
      "overdue",
      "next",
      "info",
      withinHorizon.length,
      "dashboard.signal.due_soon",
      "dashboard.why.due_soon",
      jobsHref(cx.orgId, { filter: "due_soon", days: horizonDays, scope: jobScope }),
      { key: "due_soon", whyVars: { days: horizonDays } },
    );
  }
  const quotesAwaiting = data.extras?.quotesAwaiting ?? 0;
  if (quotesAwaiting > 0 && can(cx.archetype, "quotes.view") && quoteModuleOn(cx)) {
    add(
      "needs_decision",
      "next",
      "info",
      quotesAwaiting,
      "dashboard.signal.quotes_awaiting",
      "dashboard.why.quotes_awaiting",
      quotesHref(cx.orgId, true),
      { key: "quotes_awaiting", canAct: can(cx.archetype, "quotes.manage") },
    );
  }
  const poPartial = data.extras?.poStatus?.partial ?? 0;
  if (poPartial > 0) {
    add(
      "open_pos",
      "next",
      "info",
      poPartial,
      "dashboard.signal.po_partial",
      "dashboard.why.po_partial",
      poHref(cx.orgId, "partially_received"),
      { key: "po_partial", canAct: can(cx.archetype, "grn.create") },
    );
  }
  // H21: work approaching its target date — not late yet, and bounded by the
  // organization's own horizon so the window and the destination agree.
  if (work && work.workDueSoon > 0) {
    add(
      "work_due_soon",
      "next",
      "info",
      work.workDueSoon,
      "dashboard.signal.work_due_soon",
      "dashboard.why.work_due_soon",
      // No jobScope, for the same reason as work_at_risk above.
      workHref(cx.orgId, { dueFrom: cx.asOf }),
      { whyVars: { days: horizonDays }, canAct: can(cx.archetype, "jobs.edit") },
    );
  }

  // H20: opportunities expecting to close inside the horizon, and quotes whose
  // validity runs out — both drill to the exact records via the same window.
  if (salesCounts && salesCounts.closingSoon > 0) {
    add(
      "opportunities_closing",
      "next",
      "info",
      salesCounts.closingSoon,
      "dashboard.signal.opps_closing",
      "dashboard.why.opps_closing",
      opportunitiesHref(cx.orgId, { closing: horizonDays, view: "list" }),
      { whyVars: { days: horizonDays }, canAct: can(cx.archetype, "opportunities.manage") },
    );
  }
  if (salesCounts && salesCounts.quotesExpiring > 0) {
    add(
      "quotes_expiring",
      "next",
      "info",
      salesCounts.quotesExpiring,
      "dashboard.signal.quotes_expiring",
      "dashboard.why.quotes_expiring",
      quotesHref(cx.orgId, false, null, horizonDays),
      { whyVars: { days: horizonDays }, canAct: can(cx.archetype, "quotes.manage") },
    );
  }
  const unpaidExpenses = data.extras?.unpaidExpenses ?? 0;
  if (unpaidExpenses > 0) {
    add(
      "expenses_queue",
      "next",
      "info",
      unpaidExpenses,
      "dashboard.signal.expenses_unpaid",
      "dashboard.why.expenses_unpaid",
      expensesHref(cx.orgId, true),
      { key: "expenses_unpaid" },
    );
  }
  // ── Business pulse (real totals only; zero ≠ unavailable) ─────────────────
  const pulse: PulseMetric[] = [];
  const jobsOn = cx.features["cap.jobs"] === true && !cx.disabledModules.has("cap.jobs");
  const extras = data.extras;
  if (jobsOn && can(cx.archetype, "jobs.view")) {
    pulse.push({
      key: "active_jobs",
      labelKey: "dashboard.kpi.active_jobs",
      value: extras?.jobs?.active ?? null,
      money: false,
      periodKey: "dashboard.period.now",
      href: `${o}/jobs`,
      unavailable: extras?.jobs == null,
    });
    pulse.push({
      key: "done_week",
      labelKey: "dashboard.kpi.done_week",
      value: extras?.jobs?.doneThisWeek ?? null,
      money: false,
      periodKey: "dashboard.period.7d",
      href: `${o}/jobs`,
      unavailable: extras?.jobs == null,
    });
  }
  const reportsOn =
    cx.features["cap.daily_reports"] === true && !cx.disabledModules.has("cap.daily_reports");
  if (reportsOn && (can(cx.archetype, "reports.review") || can(cx.archetype, "reports.create"))) {
    pulse.push({
      key: "reports_week",
      labelKey: "dashboard.kpi.reports_week",
      value: extras?.reportTrend ? extras.reportsThisWeek : null,
      money: false,
      periodKey: "dashboard.period.7d",
      href: `${o}/reports/review`,
      unavailable: extras?.reportTrend == null,
      deltaPrev: extras?.reportTrend ? extras.reportsPrevWeek : undefined,
    });
  }
  const issuesOn = cx.features["cap.issues"] === true && !cx.disabledModules.has("cap.issues");
  if (issuesOn && can(cx.archetype, "issues.raise")) {
    pulse.push({
      key: "open_issues",
      labelKey: "dashboard.kpi.open_issues",
      value: extras?.openIssues ?? null,
      money: false,
      periodKey: "dashboard.period.now",
      href: `${o}/issues`,
      unavailable: extras?.openIssues == null,
    });
  }
  if (allowed.has("ar_summary") && cx.seesPrice) {
    pulse.push({
      key: "outstanding",
      labelKey: "dashboard.kpi.outstanding",
      value: data.ar?.outstandingMinor ?? null,
      money: true,
      periodKey: "dashboard.period.invoiced_unpaid",
      href: arHref(cx.orgId),
      unavailable: data.ar == null || data.ar.outstandingMinor == null,
    });
  }
  if (allowed.has("pipeline_value") && cx.seesPrice) {
    // FORECAST value of open opportunities — never revenue, cash, or AR.
    pulse.push({
      key: "pipeline_value",
      labelKey: "dashboard.kpi.pipeline",
      value: data.sales?.openPipelineMinor ?? null,
      money: true,
      periodKey: "dashboard.period.open_forecast",
      href: opportunitiesHref(cx.orgId),
      unavailable: data.sales == null || data.sales.openPipelineMinor == null,
    });
  }
  if (allowed.has("payments_week") && cx.seesPrice) {
    pulse.push({
      key: "payments_week",
      labelKey: "dashboard.kpi.payments_week",
      value: extras?.paymentsWeekMinor ?? null,
      money: true,
      periodKey: "dashboard.period.7d",
      href: `${o}/payments`,
      unavailable: extras == null || extras.paymentsWeekMinor == null,
    });
  }

  const attention = sortItems(items);
  const next = sortItems(nextItems);

  return {
    attention,
    next,
    pulse,
    showStages:
      jobsOn &&
      can(cx.archetype, "jobs.view") &&
      cx.archetype !== "foreman" &&
      (extras?.stageDist ?? []).some((s) => s.count > 0),
    showMyJobs: cx.archetype === "foreman" && (data.myJobs?.length ?? 0) > 0,
    showActivity: (extras?.activity?.length ?? 0) > 0,
    horizonDays,
    unavailable: data.failed,
    allClear: attention.length === 0 && next.length === 0 && data.failed.length === 0,
  };
}

function quoteModuleOn(cx: ComposeContext): boolean {
  return cx.features["cap.quoting"] === true && !cx.disabledModules.has("cap.quoting");
}
