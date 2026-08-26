/**
 * Microstep 002B — the deterministic Owner Home composer.
 *
 * The composer is PURE: given the page's existing payload shapes it must
 * derive the state, the factual brief, at most three prioritized actions,
 * contextual attention, grounded setup steps, and section visibility — and
 * must be unable to invent anything (it can only echo counts it received).
 */
import { describe, expect, it } from "vitest";
import { composeOwnerHome, type OwnerHomeInputs } from "@/modules/today/owner-home";

const ZERO_COUNTS: OwnerHomeInputs["counts"] = {
  activeJobs: 0,
  doneThisWeek: 0,
  overdueJobs: 0,
  reportsThisWeek: 0,
  reportsPrevWeek: 0,
  approvalsPending: 0,
  openIssues: 0,
  quotesAwaiting: 0,
  blockers: 0,
  missingReports: 0,
  reportsToReview: 0,
  paymentsWeekMinor: null,
  outstandingMinor: null,
  over90Minor: null,
  seatsTotal: 1,
  mrSubmitted: 0,
  poOpen: 0,
};

function base(overrides: Partial<OwnerHomeInputs> = {}): OwnerHomeInputs {
  return {
    orgId: "org1",
    seesPrice: true,
    canBilling: true,
    needsSetup: false,
    hasLogo: false,
    counts: { ...ZERO_COUNTS },
    atRisk: [],
    approvalsOldestDays: null,
    quick: [
      { key: "job", labelKey: "nav.create.job", href: "/o/org1/jobs", icon: "briefcase" },
      {
        key: "report",
        labelKey: "nav.create.report",
        href: "/o/org1/reports/new",
        icon: "clipboard",
      },
    ],
    capsOn: 5,
    hasReportTrendData: false,
    hasPaymentsTrendData: false,
    hasStageData: false,
    hasActivity: false,
    hasDeadlines: false,
    invoicingOn: true,
    paymentsOn: true,
    ...overrides,
  };
}

describe("state determination", () => {
  it("empty when no operational data exists (even with setup complete)", () => {
    const v = composeOwnerHome(base());
    expect(v.state).toBe("empty");
    expect(v.setup).not.toBeNull();
  });

  it("empty when setup is incomplete AND no operational evidence exists", () => {
    const v = composeOwnerHome(base({ needsSetup: true }));
    expect(v.state).toBe("empty");
  });

  it("active with normal work and nothing alarming", () => {
    const v = composeOwnerHome(
      base({ counts: { ...ZERO_COUNTS, activeJobs: 4, reportsThisWeek: 6 } }),
    );
    expect(v.state).toBe("active");
    expect(v.setup).toBeNull();
  });

  it("attention on overdue work, blockers, aged approvals, or over-90 receivables", () => {
    expect(
      composeOwnerHome(base({ counts: { ...ZERO_COUNTS, activeJobs: 2, overdueJobs: 1 } })).state,
    ).toBe("attention");
    expect(
      composeOwnerHome(base({ counts: { ...ZERO_COUNTS, activeJobs: 2, blockers: 1 } })).state,
    ).toBe("attention");
    expect(
      composeOwnerHome(
        base({
          counts: { ...ZERO_COUNTS, activeJobs: 2, approvalsPending: 1 },
          approvalsOldestDays: 3,
        }),
      ).state,
    ).toBe("attention");
    expect(
      composeOwnerHome(base({ counts: { ...ZERO_COUNTS, activeJobs: 2, over90Minor: 500000 } }))
        .state,
    ).toBe("attention");
  });

  it("fresh approvals alone do NOT force the attention takeover", () => {
    const v = composeOwnerHome(
      base({
        counts: { ...ZERO_COUNTS, activeJobs: 2, approvalsPending: 2 },
        approvalsOldestDays: 0,
      }),
    );
    expect(v.state).toBe("active");
  });
});

describe("next best actions — deterministic priority, max three", () => {
  it("orders approvals > overdue > reports > collections and caps at three", () => {
    const v = composeOwnerHome(
      base({
        counts: {
          ...ZERO_COUNTS,
          activeJobs: 5,
          overdueJobs: 2,
          approvalsPending: 3,
          reportsToReview: 4,
          over90Minor: 100000,
        },
        approvalsOldestDays: 1,
      }),
    );
    expect(v.actions).toHaveLength(3);
    expect(v.actions.map((a) => a.key)).toEqual([
      "decide_approvals",
      "review_overdue",
      "review_reports",
    ]);
  });

  it("collections enters when a higher slot is free — and only when price-visible", () => {
    const priced = composeOwnerHome(
      base({
        counts: { ...ZERO_COUNTS, activeJobs: 5, approvalsPending: 1, over90Minor: 100000 },
      }),
    );
    expect(priced.actions.map((a) => a.key)).toContain("collections");

    const redacted = composeOwnerHome(
      base({
        seesPrice: false,
        counts: { ...ZERO_COUNTS, activeJobs: 5, approvalsPending: 1, over90Minor: 100000 },
      }),
    );
    expect(redacted.actions.map((a) => a.key)).not.toContain("collections");
    expect(redacted.attention.map((r) => r.key)).not.toContain("collections");
    expect(redacted.brief.chips.map((c) => c.key)).not.toContain("payments");
  });

  it("empty org gets grounded setup/getting-started actions, then contextual creates", () => {
    const v = composeOwnerHome(base());
    expect(v.actions.length).toBeGreaterThan(0);
    expect(v.actions.length).toBeLessThanOrEqual(3);
    expect(v.actions[0]!.key).toBe("create_job");
    for (const a of v.actions) {
      expect(["setup", "create"]).toContain(a.urgency);
    }
  });

  it("every action carries a real destination and never a fabricated reason", () => {
    const v = composeOwnerHome(
      base({ counts: { ...ZERO_COUNTS, activeJobs: 1, approvalsPending: 2 } }),
    );
    for (const a of v.actions) {
      expect(a.href.startsWith("/o/org1/")).toBe(true);
      // Reasons are either omitted or reference a grounded i18n key — the
      // composer has no field to carry free text.
      if (a.reasonKey) expect(a.reasonKey.startsWith("home.action.")).toBe(true);
    }
  });
});

describe("brief — factual only", () => {
  it("never claims calm/health; quiet active orgs get the no-flags sentence", () => {
    const v = composeOwnerHome(base({ counts: { ...ZERO_COUNTS, activeJobs: 3 } }));
    expect(v.brief.sentenceKey).toBe("home.brief.no_flags");
  });

  it("chips are capped at four and money chips require price visibility", () => {
    const priced = composeOwnerHome(
      base({
        counts: {
          ...ZERO_COUNTS,
          activeJobs: 3,
          overdueJobs: 1,
          approvalsPending: 2,
          reportsThisWeek: 5,
          doneThisWeek: 2,
          paymentsWeekMinor: 120000,
        },
      }),
    );
    expect(priced.brief.chips.length).toBeLessThanOrEqual(4);

    const redacted = composeOwnerHome(
      base({
        seesPrice: false,
        counts: { ...ZERO_COUNTS, activeJobs: 3, paymentsWeekMinor: 120000 },
      }),
    );
    expect(redacted.brief.chips.map((c) => c.key)).not.toContain("payments");
  });

  it("empty state gets the ready sentence and zero chips (no wall of zeros)", () => {
    const v = composeOwnerHome(base());
    expect(v.brief.sentenceKey).toBe("home.brief.empty");
    expect(v.brief.chips).toHaveLength(0);
  });
});

describe("attention zone", () => {
  it("is empty for quiet orgs (zone will not render)", () => {
    const v = composeOwnerHome(base({ counts: { ...ZERO_COUNTS, activeJobs: 2 } }));
    expect(v.attention).toHaveLength(0);
  });

  it("consolidates at-risk rules, overdue, approvals and collections in context", () => {
    const v = composeOwnerHome(
      base({
        counts: {
          ...ZERO_COUNTS,
          activeJobs: 4,
          overdueJobs: 2,
          approvalsPending: 1,
          over90Minor: 900000,
        },
        atRisk: [{ id: "e1", ruleKey: "blocking_issue", severity: "critical", jobId: "j1" }],
        approvalsOldestDays: 4,
      }),
    );
    const keys = v.attention.map((r) => r.key);
    expect(keys).toContain("risk_e1");
    expect(keys).toContain("overdue");
    expect(keys).toContain("approvals");
    expect(keys).toContain("collections");
    const risk = v.attention.find((r) => r.key === "risk_e1")!;
    expect(risk.href).toBe("/o/org1/jobs/j1");
  });

  it("never includes collections for price-redacted users", () => {
    const v = composeOwnerHome(
      base({
        seesPrice: false,
        counts: { ...ZERO_COUNTS, activeJobs: 4, over90Minor: 900000 },
      }),
    );
    expect(v.attention.map((r) => r.key)).not.toContain("collections");
  });
});

describe("setup steps — grounded completion only, no percentage anywhere", () => {
  it("marks done ONLY what existing data proves", () => {
    const v = composeOwnerHome(base({ hasLogo: true, counts: { ...ZERO_COUNTS, seatsTotal: 1 } }));
    const byKey = new Map(v.setup!.map((s) => [s.key, s.done]));
    expect(byKey.get("workspace")).toBe(true);
    expect(byKey.get("config")).toBe(true); // needsSetup=false
    expect(byKey.get("logo")).toBe(true);
    expect(byKey.get("team")).toBe(false); // one seat
    // 002B.1: no first-{job}/first-{report} steps — recent-window aggregates
    // cannot prove all-time firsts, so the checklist may not claim them.
    expect(byKey.has("first_job")).toBe(false);
    expect(byKey.has("first_report")).toBe(false);
  });

  it("omits the team step entirely when seat data was not available", () => {
    const v = composeOwnerHome(base({ counts: { ...ZERO_COUNTS, seatsTotal: null } }));
    expect(v.setup!.some((s) => s.key === "team")).toBe(false);
  });

  it("the view model has no percentage/score field (truthfulness by construction)", () => {
    const v = composeOwnerHome(base());
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/percent|score|health/i);
  });
});

describe("lower-detail sections render only with meaningful data", () => {
  it("all chart sections stay hidden for a data-less org", () => {
    const v = composeOwnerHome(base());
    expect(Object.values(v.sections).every((on) => on === false)).toBe(true);
  });

  it("collections/payments sections require price visibility AND real values", () => {
    const off = composeOwnerHome(
      base({
        seesPrice: false,
        counts: { ...ZERO_COUNTS, activeJobs: 2, outstandingMinor: 100, paymentsWeekMinor: 100 },
        hasPaymentsTrendData: true,
      }),
    );
    expect(off.sections.collections).toBe(false);
    expect(off.sections.payments).toBe(false);

    const on = composeOwnerHome(
      base({
        counts: { ...ZERO_COUNTS, activeJobs: 2, outstandingMinor: 100, paymentsWeekMinor: 100 },
        hasPaymentsTrendData: true,
      }),
    );
    expect(on.sections.collections).toBe(true);
    expect(on.sections.payments).toBe(true);
  });

  it("a zero-valued trend array does not light the trend section", () => {
    const v = composeOwnerHome(
      base({ counts: { ...ZERO_COUNTS, activeJobs: 2 }, hasReportTrendData: false }),
    );
    expect(v.sections.reportTrend).toBe(false);
  });
});

describe("002B.1 — state truthfulness corrections", () => {
  it("1. needsSetup plus overdue work classifies as attention, never empty", () => {
    const v = composeOwnerHome(
      base({ needsSetup: true, counts: { ...ZERO_COUNTS, activeJobs: 2, overdueJobs: 1 } }),
    );
    expect(v.state).toBe("attention");
    expect(v.setup).toBeNull(); // no full setup experience above urgent work
    expect(v.attention.map((r) => r.key)).toContain("overdue");
  });

  it("2. needsSetup plus active work classifies as active, never empty", () => {
    const v = composeOwnerHome(
      base({ needsSetup: true, counts: { ...ZERO_COUNTS, activeJobs: 3, reportsThisWeek: 2 } }),
    );
    expect(v.state).toBe("active");
    expect(v.setup).toBeNull();
  });

  it("3. an atRisk row by itself can never produce empty", () => {
    const warn = composeOwnerHome(
      base({ atRisk: [{ id: "e1", ruleKey: "stale_job", severity: "warning", jobId: null }] }),
    );
    expect(warn.state).toBe("attention");
    const info = composeOwnerHome(
      base({ atRisk: [{ id: "e2", ruleKey: "note", severity: "info", jobId: null }] }),
    );
    // info-severity risk is visible evidence but does not force the takeover
    expect(info.state).toBe("active");
    expect(info.attention.map((r) => r.key)).toContain("risk_e2");
  });

  it("4. open issues cannot disappear into the empty state", () => {
    const v = composeOwnerHome(base({ counts: { ...ZERO_COUNTS, openIssues: 2 } }));
    expect(v.state).toBe("active");
    expect(v.setup).toBeNull();
  });

  it("5. missing reports and review work count as operational evidence", () => {
    expect(composeOwnerHome(base({ counts: { ...ZERO_COUNTS, missingReports: 3 } })).state).toBe(
      "active",
    );
    expect(composeOwnerHome(base({ counts: { ...ZERO_COUNTS, reportsToReview: 1 } })).state).toBe(
      "active",
    );
  });

  it("6. a dormant configured org (historical traces only) is never treated as brand-new", () => {
    // All recent-window counts are zero — only all-time traces remain.
    for (const dormant of [
      base({ hasActivity: true }),
      base({ hasStageData: true }),
      base({ hasDeadlines: true }),
    ]) {
      const v = composeOwnerHome(dormant);
      expect(v.state).toBe("active");
      expect(v.setup).toBeNull();
      expect(JSON.stringify(v)).not.toMatch(/first_job|first_report/);
    }
  });

  it("7. no first-{job}/{report} completion claim is derived from weekly aggregates", () => {
    const quiet = composeOwnerHome(base());
    expect(quiet.setup!.map((s) => s.key)).not.toEqual(
      expect.arrayContaining(["first_job", "first_report"]),
    );
    expect(JSON.stringify(quiet.setup)).not.toMatch(/first/);
    // The create action makes no "first ever" claim either.
    const create = quiet.actions.find((a) => a.key === "create_job");
    expect(create?.titleKey).toBe("home.action.create_job");
  });

  it("8. finish-setup stays below genuine operational priorities and can be squeezed out", () => {
    const withRoom = composeOwnerHome(
      base({
        needsSetup: true,
        counts: { ...ZERO_COUNTS, activeJobs: 2, overdueJobs: 1, approvalsPending: 1 },
      }),
    );
    expect(withRoom.actions.map((a) => a.key)).toEqual([
      "decide_approvals",
      "review_overdue",
      "finish_setup",
    ]);
    const full = composeOwnerHome(
      base({
        needsSetup: true,
        counts: {
          ...ZERO_COUNTS,
          activeJobs: 2,
          overdueJobs: 1,
          approvalsPending: 1,
          reportsToReview: 2,
        },
      }),
    );
    expect(full.actions.map((a) => a.key)).toEqual([
      "decide_approvals",
      "review_overdue",
      "review_reports",
    ]);
  });

  it("9. price redaction is unchanged — invisible money can never classify the org", () => {
    const redacted = composeOwnerHome(
      base({
        seesPrice: false,
        counts: {
          ...ZERO_COUNTS,
          over90Minor: 900000,
          outstandingMinor: 100000,
          paymentsWeekMinor: 100000,
        },
        hasPaymentsTrendData: true,
      }),
    );
    expect(redacted.state).toBe("empty");
    expect(redacted.attention).toHaveLength(0);
    // The same signals, price-visible, are attention-worthy (over-90).
    const priced = composeOwnerHome(base({ counts: { ...ZERO_COUNTS, over90Minor: 900000 } }));
    expect(priced.state).toBe("attention");
  });

  it("10. the three-action maximum holds in every corrected path", () => {
    const v = composeOwnerHome(
      base({
        needsSetup: true,
        counts: {
          ...ZERO_COUNTS,
          activeJobs: 5,
          overdueJobs: 2,
          approvalsPending: 3,
          reportsToReview: 4,
          over90Minor: 100000,
        },
        approvalsOldestDays: 3,
      }),
    );
    expect(v.actions.length).toBeLessThanOrEqual(3);
  });

  it("blockers alone produce a visible attention row (the takeover is never unexplained)", () => {
    const v = composeOwnerHome(base({ counts: { ...ZERO_COUNTS, blockers: 2 } }));
    expect(v.state).toBe("attention");
    expect(v.attention.map((r) => r.key)).toContain("blockers");
    expect(v.brief.sentenceKey).toBe("home.brief.attention");
    // …and dedupes against an exception-engine blocking_issue row.
    const deduped = composeOwnerHome(
      base({
        counts: { ...ZERO_COUNTS, blockers: 1 },
        atRisk: [{ id: "e9", ruleKey: "blocking_issue", severity: "critical", jobId: "j9" }],
      }),
    );
    expect(deduped.attention.map((r) => r.key)).not.toContain("blockers");
    expect(deduped.attention.map((r) => r.key)).toContain("risk_e9");
  });
});
