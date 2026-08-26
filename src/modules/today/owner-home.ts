/**
 * Owner Home composer (microstep 002B — "Your business, alive").
 *
 * A PURE, deterministic function that converts the page's EXISTING safe
 * payloads (composeToday cards, getDashboardExtras, listInbox, entitlements,
 * the installed-config marker, branding presence, quick-create output) into
 * the OwnerHomeView. It queries nothing, invents nothing, and never sees
 * unredacted data: money arrives pre-redacted (null) from the services, and
 * this composer treats null as "absent", never as 0.
 *
 * Authorization and redaction stay with their current owners — this file only
 * recomposes what those owners already decided the caller may see.
 */
import type {
  AttentionRow,
  BriefChip,
  HomeAction,
  OwnerHomeState,
  OwnerHomeView,
  SetupStep,
} from "@/platform/ui/dashboard/owner-home-types";
import type { IconName } from "@/platform/ui/icons";

export type OwnerHomeInputs = {
  orgId: string;
  /** ctx.pricePrivileged — money chips/actions/sections require it. */
  seesPrice: boolean;
  /** can(a,'billing.view') — whether the capabilities row may link to subscription. */
  canBilling: boolean;
  /** No installed config marker yet (existing needsSetup logic). */
  needsSetup: boolean;
  /** org_branding has a logo (from the request-cached branding read). */
  hasLogo: boolean;
  counts: {
    activeJobs: number;
    doneThisWeek: number;
    overdueJobs: number;
    reportsThisWeek: number;
    reportsPrevWeek: number;
    approvalsPending: number;
    openIssues: number;
    quotesAwaiting: number | null;
    blockers: number;
    missingReports: number;
    reportsToReview: number;
    /** Pre-redacted: null unless price-privileged AND the service supplied it. */
    paymentsWeekMinor: number | null;
    outstandingMinor: number | null;
    over90Minor: number | null;
    /** office+viewer seats, null when the seats read was not permitted. */
    seatsTotal: number | null;
    mrSubmitted: number;
    poOpen: number;
  };
  /** at_risk card items (already composed + permission-safe). */
  atRisk: Array<{ id: string; ruleKey: string; severity: string; jobId: string | null }>;
  /** Age in whole days of the oldest waiting approval (from inbox rows). */
  approvalsOldestDays: number | null;
  /** Existing role/entitlement-aware quick-create items (labelKey + href + icon). */
  quick: Array<{ key: string; labelKey: string; href: string; icon: IconName }>;
  /** Count of enabled cap.* features (for the compact capabilities row). */
  capsOn: number;
  /** Meaningfulness of chart data (any non-zero point), computed by the caller. */
  hasReportTrendData: boolean;
  hasPaymentsTrendData: boolean;
  hasStageData: boolean;
  hasActivity: boolean;
  hasDeadlines: boolean;
  invoicingOn: boolean;
  paymentsOn: boolean;
};

const SEV: Record<string, AttentionRow["severity"]> = {
  info: "info",
  warning: "warning",
  critical: "critical",
};

export function composeOwnerHome(i: OwnerHomeInputs): OwnerHomeView {
  const c = i.counts;
  const over90 = i.seesPrice ? (c.over90Minor ?? 0) : 0;
  const agedApprovals = c.approvalsPending > 0 && (i.approvalsOldestDays ?? 0) >= 2;

  // ── State (deterministic; corrected precedence — 002B.1) ──────────────────
  // 1) Real attention signals always win. 2) Any other real operational
  // evidence produces "active". 3) Only the absence of operational evidence
  // may produce the quiet/setup experience. needsSetup can ADD a setup action
  // (below) but can never hide operational attention or activity.
  // At-risk rows are the exception engine's genuine warnings; info-severity
  // rows stay visible in the zone without forcing the attention takeover.
  const atRiskAlarm = i.atRisk.some((r) => r.severity !== "info");
  const hasAttention =
    c.overdueJobs > 0 || c.blockers > 0 || over90 > 0 || agedApprovals || atRiskAlarm;
  // Every already-supplied trace of real operations counts as evidence — money
  // only when price-visible (redaction: null is "absent", never 0).
  const hasOperationalEvidence =
    hasAttention ||
    c.activeJobs + c.doneThisWeek + c.overdueJobs > 0 ||
    c.approvalsPending > 0 ||
    c.reportsThisWeek + c.reportsPrevWeek > 0 ||
    c.missingReports + c.reportsToReview > 0 ||
    c.openIssues > 0 ||
    (c.quotesAwaiting ?? 0) > 0 ||
    i.atRisk.length > 0 ||
    c.mrSubmitted + c.poOpen > 0 ||
    i.hasStageData ||
    i.hasReportTrendData ||
    i.hasDeadlines ||
    i.hasActivity ||
    (i.seesPrice &&
      ((c.paymentsWeekMinor ?? 0) > 0 || (c.outstandingMinor ?? 0) > 0 || i.hasPaymentsTrendData));
  const state: OwnerHomeState = hasAttention
    ? "attention"
    : hasOperationalEvidence
      ? "active"
      : "empty";

  // ── Attention rows (only real items; zone hidden when empty) ───────────────
  const attention: AttentionRow[] = [];
  if (state !== "empty") {
    for (const r of i.atRisk.slice(0, 4)) {
      attention.push({
        key: `risk_${r.id}`,
        ruleKey: r.ruleKey,
        severity: SEV[r.severity] ?? "warning",
        href: r.jobId ? `/o/${i.orgId}/jobs/${r.jobId}` : `/o/${i.orgId}/week`,
      });
    }
    if (c.overdueJobs > 0 && !i.atRisk.some((r) => r.ruleKey === "overdue")) {
      attention.push({
        key: "overdue",
        labelKey: "home.attention.overdue",
        vars: { count: c.overdueJobs },
        severity: "critical",
        href: `/o/${i.orgId}/jobs?filter=overdue`,
      });
    }
    if (c.blockers > 0 && !i.atRisk.some((r) => r.ruleKey === "blocking_issue")) {
      attention.push({
        key: "blockers",
        labelKey: "home.attention.blockers",
        vars: { count: c.blockers },
        severity: "critical",
        href: `/o/${i.orgId}/week`,
      });
    }
    if (c.approvalsPending > 0) {
      attention.push({
        key: "approvals",
        labelKey: "home.attention.approvals",
        vars: {
          count: c.approvalsPending,
          days: i.approvalsOldestDays ?? 0,
        },
        severity: agedApprovals ? "warning" : "info",
        href: `/o/${i.orgId}/approvals`,
      });
    }
    if (over90 > 0) {
      attention.push({
        key: "collections",
        labelKey: "home.attention.collections",
        severity: "warning",
        href: `/o/${i.orgId}/ar`,
      });
    }
  }

  // ── Brief ──────────────────────────────────────────────────────────────────
  const chips: BriefChip[] = [];
  if (state !== "empty") {
    if (c.overdueJobs > 0) {
      chips.push({
        key: "overdue",
        labelKey: "home.chip.overdue",
        vars: { count: c.overdueJobs },
        tone: "danger",
        href: `/o/${i.orgId}/jobs?filter=overdue`,
      });
    }
    if (c.approvalsPending > 0) {
      chips.push({
        key: "approvals",
        labelKey: "home.chip.approvals",
        vars: { count: c.approvalsPending },
        tone: "warning",
        href: `/o/${i.orgId}/approvals`,
      });
    }
    if (c.reportsThisWeek > 0) {
      chips.push({
        key: "reports",
        labelKey: "home.chip.reports_week",
        vars: { count: c.reportsThisWeek },
        tone: "neutral",
        href: `/o/${i.orgId}/reports/review`,
      });
    }
    if (c.doneThisWeek > 0) {
      chips.push({
        key: "done",
        labelKey: "home.chip.done_week",
        vars: { count: c.doneThisWeek },
        tone: "success",
        href: `/o/${i.orgId}/jobs`,
      });
    }
    if (i.seesPrice && (c.paymentsWeekMinor ?? 0) > 0) {
      // Money is formatted by the PAGE (locale + currency); the composer only flags it.
      chips.push({
        key: "payments",
        labelKey: "home.chip.payments_week",
        tone: "neutral",
        href: `/o/${i.orgId}/payments`,
      });
    }
  }
  const briefSentence: { key: string; vars?: Record<string, string | number> } =
    state === "empty"
      ? { key: "home.brief.empty" }
      : state === "attention"
        ? { key: "home.brief.attention", vars: { count: attention.length } }
        : c.reportsThisWeek > 0
          ? { key: "home.brief.reports_week", vars: { count: c.reportsThisWeek } }
          : c.doneThisWeek > 0
            ? { key: "home.brief.done_week", vars: { count: c.doneThisWeek } }
            : { key: "home.brief.no_flags" };

  // ── Next best actions (deterministic priority, max 3) ─────────────────────
  const actions: HomeAction[] = [];
  const push = (a: HomeAction) => {
    if (actions.length < 3 && !actions.some((x) => x.key === a.key)) actions.push(a);
  };
  // 1. decisions waiting
  if (c.approvalsPending > 0) {
    push({
      key: "decide_approvals",
      titleKey: "home.action.decide_approvals",
      reasonKey:
        (i.approvalsOldestDays ?? 0) >= 1
          ? "home.action.decide_approvals_reason_aged"
          : "home.action.decide_approvals_reason",
      vars: { count: c.approvalsPending, days: i.approvalsOldestDays ?? 0 },
      href: `/o/${i.orgId}/approvals`,
      icon: "inbox",
      urgency: "decide",
    });
  }
  // 2. overdue / blocked work
  if (c.overdueJobs > 0) {
    push({
      key: "review_overdue",
      titleKey: "home.action.review_overdue",
      reasonKey: "home.action.review_overdue_reason",
      vars: { count: c.overdueJobs },
      href: `/o/${i.orgId}/jobs?filter=overdue`,
      icon: "alert",
      urgency: "overdue",
    });
  } else if (c.blockers > 0) {
    push({
      key: "review_blockers",
      titleKey: "home.action.review_blockers",
      reasonKey: "home.action.review_blockers_reason",
      vars: { count: c.blockers },
      href: `/o/${i.orgId}/week`,
      icon: "alert",
      urgency: "overdue",
    });
  }
  // 3. reports needing review/correction
  if (c.reportsToReview > 0 || c.missingReports > 0) {
    push({
      key: "review_reports",
      titleKey: "home.action.review_reports",
      reasonKey:
        c.reportsToReview > 0
          ? "home.action.review_reports_reason"
          : "home.action.missing_reports_reason",
      vars: { count: c.reportsToReview > 0 ? c.reportsToReview : c.missingReports },
      href: `/o/${i.orgId}/reports/review`,
      icon: "clipboard",
      urgency: "review",
    });
  }
  // 4. serious collections — price-visible only
  if (i.seesPrice && over90 > 0) {
    push({
      key: "collections",
      titleKey: "home.action.collections",
      reasonKey: "home.action.collections_reason",
      href: `/o/${i.orgId}/ar`,
      icon: "banknote",
      urgency: "money",
    });
  }
  // 5. unfinished workspace setup on a WORKING org — a lower-priority action
  //    after genuine operational decisions and risks, never a takeover.
  if (i.needsSetup && state !== "empty") {
    push({
      key: "finish_setup",
      titleKey: "home.action.finish_setup",
      reasonKey: "home.action.finish_setup_reason",
      href: `/o/${i.orgId}/onboarding`,
      icon: "settings",
      urgency: "setup",
    });
  }
  // 6. quiet-org setup / getting-started (grounded suggestions only — no
  //    "first ever" claims: recent windows cannot prove all-time history).
  if (state === "empty") {
    const jobQuick = i.quick.find((q) => q.key === "job");
    if (jobQuick) {
      push({
        key: "create_job",
        titleKey: "home.action.create_job",
        reasonKey: "home.action.create_job_reason",
        href: jobQuick.href,
        icon: "briefcase",
        urgency: "setup",
      });
    }
    if (i.counts.seatsTotal !== null && i.counts.seatsTotal <= 1) {
      push({
        key: "invite_team",
        titleKey: "home.action.invite_team",
        reasonKey: "home.action.invite_team_reason",
        href: `/o/${i.orgId}/settings/members`,
        icon: "users",
        urgency: "setup",
      });
    }
    if (!i.hasLogo) {
      push({
        key: "add_logo",
        titleKey: "home.action.add_logo",
        reasonKey: "home.action.add_logo_reason",
        href: `/o/${i.orgId}/settings/branding`,
        icon: "sparkle",
        urgency: "setup",
      });
    }
  }
  // 7. contextual create (fill remaining slots with the role's top quick-creates)
  for (const q of i.quick) {
    if (actions.length >= 3) break;
    if (actions.some((a) => a.href === q.href)) continue;
    push({
      key: `create_${q.key}`,
      titleKey: q.labelKey,
      href: q.href,
      icon: q.icon,
      urgency: "create",
    });
  }

  // ── Setup steps (quiet state only; every `done` is grounded) ───────────────
  // No "first {job} / first {report}" steps: the composer only receives
  // recent-window aggregates, which cannot prove all-time firsts (002B.1).
  const setup: SetupStep[] | null =
    state === "empty"
      ? [
          { key: "workspace", labelKey: "home.setup.workspace", done: true },
          {
            key: "config",
            labelKey: "home.setup.config",
            done: !i.needsSetup,
            href: i.needsSetup ? `/o/${i.orgId}/onboarding` : undefined,
            unlocksKey: "home.setup.config_unlocks",
          },
          {
            key: "logo",
            labelKey: "home.setup.logo",
            done: i.hasLogo,
            href: `/o/${i.orgId}/settings/branding`,
            unlocksKey: "home.setup.logo_unlocks",
          },
          ...(c.seatsTotal !== null
            ? [
                {
                  key: "team",
                  labelKey: "home.setup.team",
                  done: c.seatsTotal > 1,
                  href: `/o/${i.orgId}/settings/members`,
                  unlocksKey: "home.setup.team_unlocks",
                },
              ]
            : []),
        ]
      : null;

  // ── Lower-detail sections: render only with meaningful content ─────────────
  const sections = {
    stages: state !== "empty" && i.hasStageData,
    reportTrend: state !== "empty" && i.hasReportTrendData,
    collections:
      state !== "empty" &&
      i.invoicingOn &&
      i.seesPrice &&
      ((c.outstandingMinor ?? 0) > 0 || over90 > 0),
    payments:
      state !== "empty" &&
      i.paymentsOn &&
      i.seesPrice &&
      (i.hasPaymentsTrendData || (c.paymentsWeekMinor ?? 0) > 0),
    purchasing: state !== "empty" && (c.mrSubmitted > 0 || c.poOpen > 0),
    activity: i.hasActivity,
    deadlines: state !== "empty" && i.hasDeadlines,
  };

  return {
    state,
    brief: {
      sentenceKey: briefSentence.key,
      sentenceVars: briefSentence.vars,
      chips: chips.slice(0, 4),
    },
    actions,
    attention,
    setup,
    sections,
    map: { capsOn: i.capsOn, showManage: i.canBilling },
  };
}
