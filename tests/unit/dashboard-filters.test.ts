/**
 * H18 — canonical drill-down filter contracts: server-side parsing with
 * unknown values safely ignored, builder/parser round-trips, dashboard link
 * generation through the SAME builders, inclusion predicates on the org
 * calendar day, shared status definitions, and copy integrity (en/ar
 * parity, no em dash, no internal keys in filter copy).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import {
  arHref,
  composeAdaptiveDashboard,
  expensesHref,
  expenseIsUnpaid,
  issuesHref,
  jobIsDueSoon,
  jobIsOverdue,
  jobsHref,
  mrHref,
  parseArSearch,
  parseExpensesSearch,
  parseIssuesSearch,
  parseJobsSearch,
  parseMrSearch,
  parsePoSearch,
  parseQuotesSearch,
  parseReviewSearch,
  poHref,
  quoteIsAwaiting,
  quotesHref,
  reviewHref,
  QUOTE_AWAITING_STATUSES,
  type ComposeContext,
  type DashboardData,
} from "@/modules/dashboard/service";
import { WORKSPACE_MODULE_KEYS, type WorkspaceModuleKey } from "@/platform/workspace";

const EN = en as Record<string, string>;
const AR = ar as Record<string, string>;

describe("H18 — filter parsing (server-validated, unknown safely ignored)", () => {
  it("jobs: valid values parse, junk is dropped", () => {
    expect(parseJobsSearch({ filter: "overdue" })).toEqual({
      filter: "overdue",
      days: null,
      stage: null,
      scope: null,
      customerId: null,
    });
    expect(parseJobsSearch({ filter: "due_soon", days: "3", scope: "mine" })).toEqual({
      filter: "due_soon",
      days: 3,
      stage: null,
      scope: "mine",
      customerId: null,
    });
    // Unknown/malformed → ignored, never an error.
    expect(parseJobsSearch({ filter: "DROP TABLE", days: "-4", scope: "yours" })).toEqual({
      filter: null,
      days: null,
      stage: null,
      scope: null,
      customerId: null,
    });
    expect(parseJobsSearch({ filter: "due_soon", days: "9999" }).days).toBe(7); // clamped default
    expect(parseJobsSearch({ stage: "Mould Prep!" }).stage).toBeNull(); // shape-invalid
    expect(parseJobsSearch({ stage: "mould_prep" }).stage).toBe("mould_prep");
  });

  it("review / ar / issues / mr / po / expenses / quotes parse defensively", () => {
    expect(parseReviewSearch({ focus: "missing" }).focus).toBe("missing");
    expect(parseReviewSearch({ focus: "everything" }).focus).toBe("queue");
    expect(parseArSearch({ view: "over90" }).view).toBe("over90");
    expect(parseArSearch({ view: "secret" }).view).toBe("all");
    expect(parseIssuesSearch({ view: "blocking" }).blocking).toBe(true);
    expect(parseIssuesSearch({ view: "all" }).blocking).toBe(false);
    expect(parseMrSearch({ status: "approved" }).status).toBe("approved");
    expect(parseMrSearch({ status: "cancelled" }).status).toBeNull();
    expect(parsePoSearch({ status: "partially_received" }).status).toBe("partially_received");
    expect(parsePoSearch({ status: "draft" }).status).toBeNull();
    expect(parseExpensesSearch({ status: "unpaid" }).unpaid).toBe(true);
    expect(parseExpensesSearch({ status: "paid" }).unpaid).toBe(false);
    expect(parseQuotesSearch({ status: "awaiting" }).awaiting).toBe(true);
  });

  it("builders round-trip through their parsers", () => {
    const url = jobsHref("org1", { filter: "due_soon", days: 5, scope: "mine" });
    const qs = Object.fromEntries(new URL(`http://x${url}`).searchParams);
    expect(parseJobsSearch(qs)).toEqual({
      filter: "due_soon",
      days: 5,
      stage: null,
      scope: "mine",
      customerId: null,
    });
    expect(
      parseArSearch({
        view: new URL(`http://x${arHref("o", "overdue")}`).searchParams.get("view") ?? undefined,
      }).view,
    ).toBe("overdue");
    expect(reviewHref("o", "missing")).toContain("focus=missing");
    expect(issuesHref("o", true)).toContain("view=blocking");
    expect(mrHref("o", "approved")).toContain("status=approved");
    expect(poHref("o", "partially_received")).toContain("status=partially_received");
    expect(expensesHref("o", true)).toContain("status=unpaid");
    expect(quotesHref("o", true)).toContain("status=awaiting");
  });
});

describe("H18 — inclusion predicates (org calendar day)", () => {
  const asOf = "2026-08-29";
  it("overdue: active/on-hold with a due date strictly before the org day", () => {
    expect(jobIsOverdue({ statusCategory: "active", dueDate: "2026-08-28" }, asOf)).toBe(true);
    expect(jobIsOverdue({ statusCategory: "on_hold", dueDate: "2026-08-28" }, asOf)).toBe(true);
    expect(jobIsOverdue({ statusCategory: "active", dueDate: "2026-08-29" }, asOf)).toBe(false); // boundary
    expect(jobIsOverdue({ statusCategory: "done", dueDate: "2026-08-01" }, asOf)).toBe(false);
    expect(jobIsOverdue({ statusCategory: "active", dueDate: null }, asOf)).toBe(false);
  });

  it("due soon: within the window, never overdue, boundary inclusive", () => {
    expect(jobIsDueSoon({ statusCategory: "active", dueDate: "2026-08-31" }, asOf, 2)).toBe(true);
    expect(jobIsDueSoon({ statusCategory: "active", dueDate: "2026-09-01" }, asOf, 2)).toBe(false);
    expect(jobIsDueSoon({ statusCategory: "active", dueDate: "2026-08-28" }, asOf, 2)).toBe(false); // overdue
    expect(jobIsDueSoon({ statusCategory: "active", dueDate: "2026-08-29" }, asOf, 2)).toBe(true); // today
  });

  it("expense and quote rules match the dashboard definitions", () => {
    expect(expenseIsUnpaid({ paymentStatus: "unpaid", voidedAt: null })).toBe(true);
    expect(expenseIsUnpaid({ paymentStatus: "unpaid", voidedAt: "2026-01-01" })).toBe(false);
    expect(expenseIsUnpaid({ paymentStatus: "paid", voidedAt: null })).toBe(false);
    expect(QUOTE_AWAITING_STATUSES).toEqual(["draft", "pending_approval"]);
    expect(quoteIsAwaiting({ status: "draft" })).toBe(true);
    expect(quoteIsAwaiting({ status: "sent" })).toBe(false);
  });
});

describe("H18 — dashboard link generation uses the contracts", () => {
  const allFeatures = Object.fromEntries(WORKSPACE_MODULE_KEYS.map((k) => [k, true]));
  const cx = (over: Partial<ComposeContext> = {}): ComposeContext => ({
    orgId: "org1",
    archetype: "owner",
    seesPrice: true,
    features: { ...allFeatures },
    disabledModules: new Set<WorkspaceModuleKey>(),
    compiledDashboard: null,
    asOf: "2026-08-29",
    ...over,
  });
  const data = (over: Partial<DashboardData> = {}): DashboardData => ({
    exceptions: [],
    extras: {
      computedAt: "x",
      jobs: { active: 1, doneThisWeek: 0, overdue: 2 },
      stageDist: [],
      reportTrend: null,
      reportsThisWeek: 0,
      reportsPrevWeek: 0,
      deadlines: [{ id: "d1", reference: "J-1", name: "A", dueDate: "2026-08-30", overdue: false }],
      activity: [],
      approvalsPending: 0,
      openIssues: 0,
      paymentsTrend: null,
      paymentsWeekMinor: null,
      quotesAwaiting: 2,
      unpaidExpenses: 3,
      poStatus: { approved: 0, sent: 0, partial: 1 },
      mrOpen: { submitted: 0, approved: 2 },
      seats: null,
    },
    inbox: [],
    ar: { outstandingMinor: 100, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 100 },
    myJobs: null,
    returnedReports: null,
    reviewQueue: { toReview: 1, missingToday: 1 },
    sales: null,
    failed: [],
    ...over,
  });

  it("every filtered signal links to its canonical URL", () => {
    const view = composeAdaptiveDashboard(cx(), data());
    const href = (key: string) =>
      [...view.attention, ...view.next].find((i) => i.key === key)?.href;
    expect(href("overdue_jobs")).toBe("/o/org1/jobs?filter=overdue");
    expect(href("over90")).toBe("/o/org1/ar?view=over90");
    expect(href("approved_mrs")).toBe("/o/org1/material-requests?status=approved");
    expect(href("reports_to_review")).toBe("/o/org1/reports/review");
    expect(href("missing_today")).toBe("/o/org1/reports/review?focus=missing");
    expect(href("due_soon")).toBe("/o/org1/jobs?filter=due_soon&days=7");
    expect(href("quotes_awaiting")).toBe("/o/org1/quotes?status=awaiting");
    expect(href("po_partial")).toBe("/o/org1/purchase-orders?status=partially_received");
    expect(href("expenses_unpaid")).toBe("/o/org1/expenses?status=unpaid");
    expect(view.pulse.find((m) => m.key === "outstanding")?.href).toBe("/o/org1/ar");
  });

  it("a manager's job drill-downs carry the assigned scope", () => {
    const view = composeAdaptiveDashboard(
      cx({ archetype: "manager", seesPrice: false }),
      data({ ar: null }),
    );
    const overdue = view.attention.find((i) => i.key === "overdue_jobs");
    expect(overdue?.href).toBe("/o/org1/jobs?filter=overdue&scope=mine");
    const dueSoon = view.next.find((i) => i.key === "due_soon");
    expect(dueSoon?.href).toContain("scope=mine");
  });

  it("blocking exceptions link to the blocking issues view", () => {
    const view = composeAdaptiveDashboard(
      cx(),
      data({
        exceptions: [
          {
            id: "e1",
            ruleKey: "blocking_issue",
            severity: "critical",
            jobId: null,
            subjectType: null,
            subjectId: null,
            raisedAt: "2026-08-28T00:00:00Z",
            evidenceRefs: null,
          },
        ],
      }),
    );
    expect(view.attention.find((i) => i.cardKey === "blockers")?.href).toBe(
      "/o/org1/issues?view=blocking",
    );
  });
});

describe("H18 — filter copy integrity", () => {
  it("all filter keys exist in both languages, no em dash, no internal keys", () => {
    const keys = Object.keys(EN).filter((k) => k.startsWith("filters.") || k.startsWith("ar."));
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) {
      expect(AR[k], `ar missing ${k}`).toBeTruthy();
      expect(EN[k], k).not.toContain("—");
      expect(AR[k], k).not.toContain("—");
      expect(EN[k], k).not.toMatch(/cap\.[a-z_]|_v1|filter=|status=/);
    }
  });

  it("destination pages parse via the module surface, not ad-hoc reads", () => {
    for (const [page, fn] of [
      ["jobs", "parseJobsSearch"],
      ["reports/review", "parseReviewSearch"],
      ["ar", "parseArSearch"],
      ["issues", "parseIssuesSearch"],
      ["material-requests", "parseMrSearch"],
      ["purchase-orders", "parsePoSearch"],
      ["expenses", "parseExpensesSearch"],
      ["quotes", "parseQuotesSearch"],
    ]) {
      const src = readFileSync(`src/app/(app)/o/[orgId]/${page}/page.tsx`, "utf8");
      expect(src, page).toContain(fn!);
    }
  });
});
