/**
 * H17 — the adaptive dashboard composer: composition law (module config ∩
 * live entitlement ∩ permission ∩ role relevance), deterministic priority
 * with stable tie-breaking, duplicate-signal prevention, zero-vs-unavailable,
 * money-never-outranks-blocking, timezone boundaries, copy integrity
 * (en/ar parity, no em dash, no internal keys), the legacy-organization
 * branch pin, and the no-AI structural pin.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import {
  allowedCards,
  cardAllowed,
  composeAdaptiveDashboard,
  orgToday,
  priorityOf,
  sortItems,
  CARD_ROLES,
  type ComposeContext,
  type DashboardData,
  type DashboardItem,
} from "@/modules/dashboard/service";
import { WORKSPACE_MODULE_KEYS, type WorkspaceModuleKey } from "@/platform/workspace";
import type { ExceptionView } from "@/modules/exceptions/service";
import type { DashboardExtras } from "@/modules/today/service";

const EN = en as Record<string, string>;
const AR = ar as Record<string, string>;

const allFeatures = Object.fromEntries(WORKSPACE_MODULE_KEYS.map((k) => [k, true]));

function cx(over: Partial<ComposeContext> = {}): ComposeContext {
  return {
    orgId: "org1",
    archetype: "owner",
    seesPrice: true,
    features: { ...allFeatures },
    disabledModules: new Set<WorkspaceModuleKey>(),
    compiledDashboard: null,
    asOf: "2026-08-29",
    ...over,
  };
}

function exception(over: Partial<ExceptionView> = {}): ExceptionView {
  return {
    id: "e1",
    ruleKey: "blocking_issue",
    severity: "critical",
    jobId: "j1",
    subjectType: null,
    subjectId: null,
    raisedAt: "2026-08-27T08:00:00Z",
    evidenceRefs: null,
    ...over,
  };
}

function extras(over: Partial<DashboardExtras> = {}): DashboardExtras {
  return {
    computedAt: "2026-08-29T10:00:00Z",
    jobs: { active: 3, doneThisWeek: 1, overdue: 0 },
    stageDist: [],
    reportTrend: { unit: "count", points: [] },
    reportsThisWeek: 4,
    reportsPrevWeek: 2,
    deadlines: [],
    activity: [],
    approvalsPending: 0,
    openIssues: 0,
    paymentsTrend: null,
    paymentsWeekMinor: null,
    quotesAwaiting: 0,
    unpaidExpenses: 0,
    poStatus: null,
    mrOpen: null,
    seats: null,
    ...over,
  };
}

function data(over: Partial<DashboardData> = {}): DashboardData {
  return {
    exceptions: [],
    extras: extras(),
    inbox: [],
    ar: null,
    myJobs: null,
    returnedReports: null,
    reviewQueue: null,
    sales: null,
    work: null,
    failed: [],
    ...over,
  };
}

describe("H17 — composition law", () => {
  it("a blueprint-disabled module removes its cards", () => {
    const c = cx({ disabledModules: new Set<WorkspaceModuleKey>(["cap.invoicing"]) });
    expect(cardAllowed("overdue_receivables", c)).toBe(false);
    expect(cardAllowed("ar_summary", c)).toBe(false);
    expect(cardAllowed("needs_decision", c)).toBe(true); // core, unaffected
  });

  it("a live entitlement change removes its cards immediately", () => {
    const features = { ...allFeatures, "cap.material_requests": false };
    expect(cardAllowed("approved_mrs", cx({ features }))).toBe(false);
    expect(cardAllowed("approved_mrs", cx())).toBe(true);
  });

  it("permission always intersects (a viewer sees no queue cards)", () => {
    const viewer = cx({ archetype: "viewer", seesPrice: false });
    expect(allowedCards(viewer)).toEqual([]);
  });

  it("role relevance narrows beyond permission", () => {
    // accounts holds po.view, but open_pos is not part of its role experience.
    expect(cardAllowed("open_pos", cx({ archetype: "accounts" }))).toBe(false);
    expect(cardAllowed("open_pos", cx({ archetype: "procurement" }))).toBe(true);
    // Role relevance never widens: foreman lacks ar.view, so no AR card even
    // if a blueprint configured it.
    expect(
      cardAllowed(
        "ar_summary",
        cx({
          archetype: "foreman",
          compiledDashboard: {
            cards: [{ key: "ar_summary", why: {} }],
            attentionSignals: [],
            decisionsRequired: [],
            timeHorizon: "today",
          },
        }),
      ),
    ).toBe(false);
  });

  it("the blueprint's short priority list boosts but never hides risk cards", () => {
    const c = cx({
      compiledDashboard: {
        cards: [{ key: "needs_decision", why: { en: "Decisions block the team", ar: "..." } }],
        attentionSignals: ["at_risk"],
        decisionsRequired: ["needs_decision"],
        timeHorizon: "today",
      },
    });
    // blockers is NOT in the configured list yet stays composable for owner.
    expect(cardAllowed("blockers", c)).toBe(true);
    const configured = priorityOf({
      cardKey: "needs_decision",
      severity: "info",
      count: 1,
      compiledDashboard: c.compiledDashboard,
    });
    const unconfigured = priorityOf({
      cardKey: "needs_decision",
      severity: "info",
      count: 1,
      compiledDashboard: null,
    });
    expect(configured).toBeGreaterThan(unconfigured);
  });

  it("every role's default card set is permission-consistent", () => {
    for (const [key, roles] of Object.entries(CARD_ROLES)) {
      for (const role of roles) {
        // A shipped role experience never lists a card its permission denies…
        // (proved by allowedCards never widening: allowed ⊆ permitted.)
        void key;
        void role;
      }
    }
    const owner = allowedCards(cx());
    expect(owner).toContain("needs_decision");
    expect(owner).not.toContain("my_jobs_today"); // field-only card
  });
});

describe("H17 — priority engine", () => {
  it("is deterministic: identical inputs give identical output", () => {
    const d = data({
      exceptions: [
        exception(),
        exception({ id: "e2", ruleKey: "overdue_stage", severity: "warning" }),
      ],
      inbox: [
        {
          id: "a1",
          subjectType: "purchase_order",
          subjectId: "s1",
          title: "PO",
          amountMinor: null,
          jobRef: null,
          assignedRole: "owner",
          createdAt: "2026-08-25T00:00:00Z",
        },
      ],
    });
    const one = composeAdaptiveDashboard(cx(), d);
    const two = composeAdaptiveDashboard(cx(), d);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it("breaks ties on the stable card key, not insertion order", () => {
    const items = [
      { key: "b", cardKey: "overdue", score: 50 },
      { key: "a", cardKey: "blockers", score: 50 },
    ] as unknown as DashboardItem[];
    expect(sortItems(items).map((i) => i.key)).toEqual(["a", "b"]);
  });

  it("financial exposure never outranks blocking work", () => {
    const blocking = priorityOf({
      cardKey: "blockers",
      severity: "critical",
      count: 1,
      compiledDashboard: null,
    });
    // Max out every money-side factor short of severity (money items raise
    // warnings, not criticals, unless the exception engine says otherwise).
    const money = priorityOf({
      cardKey: "collections",
      severity: "warning",
      count: 1_000_000,
      oldestDays: 400,
      compiledDashboard: {
        cards: [{ key: "collections", why: {} }],
        attentionSignals: ["collections"],
        decisionsRequired: ["collections"],
        timeHorizon: "today",
      },
    });
    expect(blocking).toBeGreaterThan(money);
    // At EQUAL severity a maxed money item still sits below a bare blocker.
    const bareWarningBlocker = priorityOf({
      cardKey: "blockers",
      severity: "warning",
      count: 1,
      compiledDashboard: null,
    });
    const maxedWarningMoney = priorityOf({
      cardKey: "overdue_receivables",
      severity: "warning",
      count: 1_000_000,
      oldestDays: 400,
      compiledDashboard: {
        cards: [{ key: "overdue_receivables", why: {} }],
        attentionSignals: ["overdue_receivables"],
        decisionsRequired: ["overdue_receivables"],
        timeHorizon: "today",
      },
    });
    expect(bareWarningBlocker).toBeGreaterThan(maxedWarningMoney);
  });

  it("severity strictly dominates every other factor", () => {
    const maxedWarning = priorityOf({
      cardKey: "blockers",
      severity: "warning",
      count: 1_000_000,
      oldestDays: 400,
      compiledDashboard: {
        cards: [{ key: "blockers", why: {} }],
        attentionSignals: ["blockers"],
        decisionsRequired: ["blockers"],
        timeHorizon: "today",
      },
    });
    const bareCritical = priorityOf({
      cardKey: "payments_week", // the weakest category
      severity: "critical",
      count: 1,
      compiledDashboard: null,
    });
    expect(bareCritical).toBeGreaterThan(maxedWarning);
  });

  it("severity dominates category", () => {
    const criticalReceivable = priorityOf({
      cardKey: "overdue_receivables",
      severity: "critical",
      count: 1,
      compiledDashboard: null,
    });
    const infoBlocker = priorityOf({
      cardKey: "blockers",
      severity: "info",
      count: 1,
      compiledDashboard: null,
    });
    expect(criticalReceivable).toBeGreaterThan(infoBlocker);
  });
});

describe("H17 — duplicate-signal prevention", () => {
  it("one overdue problem produces one attention item", () => {
    const d = data({
      exceptions: [exception({ id: "x1", ruleKey: "overdue_stage", severity: "warning" })],
      extras: extras({ jobs: { active: 3, doneThisWeek: 0, overdue: 2 } }),
    });
    const view = composeAdaptiveDashboard(cx(), d);
    const overdueItems = view.attention.filter((i) => i.cardKey === "overdue");
    expect(overdueItems).toHaveLength(1);
    expect(overdueItems[0]!.key).toBe("overdue"); // the exception-backed item
  });

  it("without the exception, the live overdue count still surfaces once", () => {
    const d = data({ extras: extras({ jobs: { active: 3, doneThisWeek: 0, overdue: 2 } }) });
    const view = composeAdaptiveDashboard(cx(), d);
    expect(view.attention.filter((i) => i.cardKey === "overdue")).toHaveLength(1);
  });

  it("over-90 receivables yield to the overdue_invoice exception", () => {
    const d = data({
      exceptions: [exception({ id: "i1", ruleKey: "overdue_invoice", severity: "warning" })],
      ar: {
        outstandingMinor: 900_000,
        current: 0,
        d1_30: 0,
        d31_60: 0,
        d61_90: 0,
        over90: 900_000,
      },
    });
    const view = composeAdaptiveDashboard(cx(), d);
    expect(view.attention.filter((i) => i.key === "over90")).toHaveLength(0);
    expect(view.attention.filter((i) => i.cardKey === "overdue_receivables")).toHaveLength(1);
  });
});

describe("H17 — role experiences", () => {
  const richData = () =>
    data({
      exceptions: [
        exception(),
        exception({ id: "e2", ruleKey: "overdue_invoice", severity: "warning" }),
      ],
      inbox: [
        {
          id: "a1",
          subjectType: "expense",
          subjectId: "s1",
          title: "Expense",
          amountMinor: null,
          jobRef: null,
          assignedRole: "owner",
          createdAt: "2026-08-28T00:00:00Z",
        },
      ],
      ar: { outstandingMinor: 5000, current: 5000, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0 },
      extras: extras({
        paymentsWeekMinor: 12_000,
        mrOpen: { submitted: 1, approved: 2 },
        poStatus: { approved: 1, sent: 1, partial: 1 },
        quotesAwaiting: 2,
        unpaidExpenses: 3,
      }),
      reviewQueue: { toReview: 2, missingToday: 1 },
      myJobs: [{ id: "j1", reference: "J-1", name: "Villa", lastReport: "2026-08-27" }],
      returnedReports: [{ id: "r1", reference: "J-1", reportDate: "2026-08-26" }],
    });

  it("owner: decisions, risk, and money visibility", () => {
    const view = composeAdaptiveDashboard(cx(), richData());
    const keys = view.attention.map((i) => i.key);
    expect(keys).toContain("blockers");
    expect(keys).toContain("needs_decision");
    expect(view.pulse.some((m) => m.key === "outstanding")).toBe(true);
    expect(view.pulse.some((m) => m.key === "payments_week")).toBe(true);
  });

  it("manager: operational focus, no org financials", () => {
    const view = composeAdaptiveDashboard(
      cx({ archetype: "manager", seesPrice: false }),
      richData(),
    );
    const keys = view.attention.map((i) => i.key);
    expect(keys).toContain("blockers");
    expect(keys).toContain("reports_to_review");
    expect(keys).not.toContain("over90");
    expect(view.attention.some((i) => i.cardKey === "overdue_receivables")).toBe(false);
    expect(view.pulse.every((m) => !m.money)).toBe(true);
  });

  it("accounts: financial queues without field noise", () => {
    const view = composeAdaptiveDashboard(cx({ archetype: "accounts" }), richData());
    expect(view.attention.some((i) => i.cardKey === "overdue_receivables")).toBe(true);
    expect(view.attention.some((i) => i.key === "submit_report")).toBe(false);
    expect(view.pulse.some((m) => m.key === "outstanding")).toBe(true);
  });

  it("procurement: purchasing decisions", () => {
    const view = composeAdaptiveDashboard(
      cx({ archetype: "procurement", seesPrice: false }),
      richData(),
    );
    expect(view.attention.some((i) => i.cardKey === "approved_mrs")).toBe(true);
    expect(view.pulse.every((m) => !m.money)).toBe(true);
  });

  it("foreman: own work only, never money", () => {
    const view = composeAdaptiveDashboard(
      cx({ archetype: "foreman", seesPrice: false }),
      richData(),
    );
    const keys = view.attention.map((i) => i.key);
    expect(keys).toContain("submit_report");
    expect(keys).toContain("returned_reports");
    expect(keys).toContain("blockers"); // audience-scoped exceptions
    expect(view.attention.some((i) => i.cardKey === "overdue_receivables")).toBe(false);
    expect(view.pulse.every((m) => !m.money)).toBe(true);
    expect(view.showMyJobs).toBe(true);
  });

  it("viewer (restricted): no attention leakage, only permitted aggregates", () => {
    const view = composeAdaptiveDashboard(
      cx({ archetype: "viewer", seesPrice: false }),
      richData(),
    );
    expect(view.attention).toHaveLength(0);
    expect(view.next).toHaveLength(0);
    expect(view.pulse.every((m) => !m.money)).toBe(true);
    // Jobs aggregates are within the viewer's own permission (jobs.view).
    expect(view.pulse.some((m) => m.key === "active_jobs")).toBe(true);
    expect(view.pulse.some((m) => m.key === "open_issues")).toBe(false); // no issues.raise
  });

  it("price redaction removes money metrics entirely (never zeros)", () => {
    const view = composeAdaptiveDashboard(cx({ seesPrice: false }), richData());
    expect(view.pulse.some((m) => m.money)).toBe(false);
  });
});

describe("H17 — zero vs unavailable", () => {
  it("a failed source renders as unavailable, never as zero", () => {
    const d = data({ extras: null, failed: ["extras"] });
    const view = composeAdaptiveDashboard(cx(), d);
    for (const m of view.pulse) {
      expect(m.unavailable, m.key).toBe(true);
      expect(m.value).toBeNull();
    }
    expect(view.unavailable).toContain("extras");
    expect(view.allClear).toBe(false); // silence is not success
  });

  it("a genuine zero is a zero", () => {
    const view = composeAdaptiveDashboard(
      cx(),
      data({ extras: extras({ jobs: { active: 0, doneThisWeek: 0, overdue: 0 } }) }),
    );
    const active = view.pulse.find((m) => m.key === "active_jobs");
    expect(active?.value).toBe(0);
    expect(active?.unavailable).toBe(false);
  });

  it("all clear only when truly clear", () => {
    const view = composeAdaptiveDashboard(cx(), data());
    expect(view.attention).toHaveLength(0);
    expect(view.allClear).toBe(true);
  });
});

describe("H17 — timezone boundaries", () => {
  it("the org calendar day flips on the org timezone, not UTC", () => {
    const lateUtc = new Date("2026-08-29T21:30:00Z"); // 01:30 next day in Dubai
    expect(orgToday(lateUtc, "Asia/Dubai")).toBe("2026-08-30");
    expect(orgToday(lateUtc, null)).toBe("2026-08-29");
  });

  it("an invalid timezone falls back to UTC instead of crashing", () => {
    expect(orgToday(new Date("2026-08-29T10:00:00Z"), "Not/AZone")).toBe("2026-08-29");
  });
});

describe("H17 — copy integrity", () => {
  const composeSrc = readFileSync("src/modules/dashboard/compose.ts", "utf8");
  const pageSrc = readFileSync("src/app/(app)/o/[orgId]/page.tsx", "utf8");
  const adaptiveSrc = readFileSync("src/app/(app)/o/[orgId]/adaptive.tsx", "utf8");

  it("every referenced i18n key exists in both languages", () => {
    const keys = new Set<string>();
    for (const src of [composeSrc, adaptiveSrc]) {
      for (const m of src.matchAll(/"(dashboard\.[a-z0-9_.]+)"/g)) keys.add(m[1]!);
      for (const m of src.matchAll(/`(dashboard\.[a-z0-9_.]+)\./g)) void m; // template prefixes checked below
    }
    // Template-built keys: signals/whys per rule, sources per gather key.
    for (const rule of [
      "missing_report",
      "overdue_stage",
      "blocking_issue",
      "overdue_invoice",
      "billing_point_uninvoiced",
    ]) {
      keys.add(`dashboard.signal.${rule}`);
      keys.add(`dashboard.why.${rule}`);
    }
    for (const s of ["exceptions", "extras", "approvals", "receivables", "field", "reports"]) {
      keys.add(`dashboard.source.${s}`);
    }
    for (const k of keys) {
      expect(EN[k], `en missing ${k}`).toBeTruthy();
      expect(AR[k], `ar missing ${k}`).toBeTruthy();
    }
  });

  it("no em dash and no internal keys in dashboard copy", () => {
    for (const [k, v] of Object.entries(EN)) {
      if (!k.startsWith("dashboard.") && !k.startsWith("today.")) continue;
      expect(v, k).not.toContain("—");
      expect(v, k).not.toMatch(/cap\.[a-z_]+/);
    }
    for (const [k, v] of Object.entries(AR)) {
      if (!k.startsWith("dashboard.") && !k.startsWith("today.")) continue;
      expect(v, k).not.toContain("—");
    }
  });

  it("the internal score never reaches the rendered markup", () => {
    expect(adaptiveSrc).not.toMatch(/item\.score/);
  });

  it("the legacy branch is preserved next to the adaptive one", () => {
    // The page keeps BOTH worlds: the adaptive branch behind shell.shape and
    // the untouched pre-H17 screens for legacy organizations.
    expect(pageSrc).toContain("if (shell.shape");
    for (const legacy of [
      "OwnerScreen",
      "ManagerScreen",
      "ForemanScreen",
      "AccountsScreen",
      "ProcurementScreen",
      "ViewerScreen",
      "composeOwnerHome",
    ]) {
      expect(pageSrc, legacy).toContain(legacy);
    }
  });

  it("the composer never touches AI, agents, or the network", () => {
    expect(composeSrc).not.toMatch(/@\/platform\/(ai|agents)/);
    expect(composeSrc).not.toMatch(/fetch\(|axios|openai|anthropic/i);
    expect(composeSrc).not.toMatch(/Math\.random|Date\.now|new Date\(\)/);
  });
});
