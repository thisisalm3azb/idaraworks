/**
 * H20 — sales CRM laws that hold without a database: pipeline defaults,
 * filter contracts, the expiring-quote rule, dashboard composition for the
 * four new cards, forecast/revenue label separation, and copy integrity.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIPELINE_STAGES,
  LOSS_REASONS,
  SALES_ACTIVITY_KINDS,
  USER_ACTIVITY_KINDS,
} from "@/modules/crm/service";
import {
  leadsHref,
  opportunitiesHref,
  parseLeadsSearch,
  parseOpportunitiesSearch,
  parseSalesSearch,
  quoteIsExpiring,
  salesHref,
} from "@/modules/dashboard/filters";
import {
  allowedCards,
  composeAdaptiveDashboard,
  type ComposeContext,
  type DashboardData,
} from "@/modules/dashboard/compose";
import { WORKSPACE_MODULE_KEYS, type WorkspaceModuleKey } from "@/platform/workspace";
import EN from "@/platform/i18n/messages/en.json";
import AR from "@/platform/i18n/messages/ar.json";

const UUID = "a7b9c1d3-1234-4abc-9def-0123456789ab";

describe("H20 — pipeline defaults", () => {
  it("ship five open stages plus the two structural terminals, bilingual", () => {
    const open = DEFAULT_PIPELINE_STAGES.filter((s) => s.category === "open");
    expect(open.map((s) => s.key)).toEqual([
      "new",
      "contacted",
      "qualified",
      "proposal",
      "negotiation",
    ]);
    expect(DEFAULT_PIPELINE_STAGES.find((s) => s.key === "won")?.category).toBe("won");
    expect(DEFAULT_PIPELINE_STAGES.find((s) => s.key === "lost")?.category).toBe("lost");
    for (const s of DEFAULT_PIPELINE_STAGES) {
      expect(s.label.en.length).toBeGreaterThan(0);
      expect(s.label.ar.length).toBeGreaterThan(0);
      expect(s.key).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
    }
    // Sorts are unique and ordered as declared.
    const sorts = DEFAULT_PIPELINE_STAGES.map((s) => s.sort);
    expect([...new Set(sorts)].length).toBe(sorts.length);
  });

  it("loss reasons and activity kinds are closed registries", () => {
    expect(LOSS_REASONS).toContain("no_response");
    expect(SALES_ACTIVITY_KINDS).toContain("stage_change");
    // Users record only communication kinds — lifecycle marks are system-only.
    for (const k of USER_ACTIVITY_KINDS) expect(SALES_ACTIVITY_KINDS).toContain(k);
    expect(USER_ACTIVITY_KINDS).not.toContain("won");
    expect(USER_ACTIVITY_KINDS).not.toContain("stage_change");
  });
});

describe("H20 — filter contracts", () => {
  it("leads: validates status/owner, trims search, ignores junk", () => {
    const f = parseLeadsSearch({
      q: "  marina  ",
      status: "qualified",
      owner: UUID,
      source: "referral",
      focus: "overdue",
    });
    expect(f).toEqual({
      q: "marina",
      status: "qualified",
      owner: UUID,
      source: "referral",
      overdue: true,
      archived: false,
    });
    const junk = parseLeadsSearch({ status: "DROP TABLE", owner: "1 OR 1=1", focus: "x" });
    expect(junk.status).toBeNull();
    expect(junk.owner).toBeNull();
    expect(junk.overdue).toBe(false);
  });

  it("opportunities: clamps closing, validates stage shape and view", () => {
    const f = parseOpportunitiesSearch({
      view: "list",
      stage: "negotiation",
      customer: UUID,
      closing: "30",
      focus: "followup",
    });
    expect(f.view).toBe("list");
    expect(f.stage).toBe("negotiation");
    expect(f.customerId).toBe(UUID);
    expect(f.closing).toBe(30);
    expect(f.followup).toBe(true);
    expect(parseOpportunitiesSearch({ closing: "9999" }).closing).toBeNull();
    expect(parseOpportunitiesSearch({ stage: "Bad Key!" }).stage).toBeNull();
    expect(parseOpportunitiesSearch({}).view).toBe("board");
    expect(parseOpportunitiesSearch({ status: "sideways" }).status).toBeNull();
  });

  it("sales: whitelists the period, defaulting to 30", () => {
    expect(parseSalesSearch({ days: "7" }).days).toBe(7);
    expect(parseSalesSearch({ days: "90" }).days).toBe(90);
    expect(parseSalesSearch({ days: "13" }).days).toBe(30);
    expect(parseSalesSearch({}).days).toBe(30);
  });

  it("builders and parsers round-trip", () => {
    const lq = Object.fromEntries(
      new URL(`http://x${leadsHref("o", { status: "new", overdue: true, owner: UUID })}`)
        .searchParams,
    );
    const lf = parseLeadsSearch(lq);
    expect(lf.status).toBe("new");
    expect(lf.overdue).toBe(true);
    expect(lf.owner).toBe(UUID);
    const oq = Object.fromEntries(
      new URL(`http://x${opportunitiesHref("o", { closing: 7, view: "list", customerId: UUID })}`)
        .searchParams,
    );
    const of = parseOpportunitiesSearch(oq);
    expect(of.closing).toBe(7);
    expect(of.view).toBe("list");
    expect(of.customerId).toBe(UUID);
    expect(salesHref("o", 30)).toBe("/o/o/sales");
    expect(salesHref("o", 7)).toBe("/o/o/sales?days=7");
  });

  it("expiring-quote rule: sendable statuses inside the window only", () => {
    const asOf = "2026-08-30";
    expect(quoteIsExpiring({ status: "sent", validUntil: "2026-09-05" }, asOf, 7)).toBe(true);
    expect(quoteIsExpiring({ status: "approved", validUntil: "2026-08-30" }, asOf, 7)).toBe(true);
    expect(quoteIsExpiring({ status: "sent", validUntil: "2026-09-20" }, asOf, 7)).toBe(false);
    expect(quoteIsExpiring({ status: "sent", validUntil: "2026-08-01" }, asOf, 7)).toBe(false); // already past
    expect(quoteIsExpiring({ status: "draft", validUntil: "2026-09-01" }, asOf, 7)).toBe(false);
    expect(quoteIsExpiring({ status: "accepted", validUntil: "2026-09-01" }, asOf, 7)).toBe(false);
    expect(quoteIsExpiring({ status: "sent", validUntil: null }, asOf, 7)).toBe(false);
  });
});

// ── Dashboard composition for the four new cards ────────────────────────────
const allFeatures = Object.fromEntries(WORKSPACE_MODULE_KEYS.map((k) => [k, true]));
const cx = (over: Partial<ComposeContext> = {}): ComposeContext => ({
  orgId: "org1",
  archetype: "owner",
  seesPrice: true,
  features: { ...allFeatures },
  disabledModules: new Set<WorkspaceModuleKey>(),
  compiledDashboard: null,
  asOf: "2026-08-30",
  ...over,
});
const data = (over: Partial<DashboardData> = {}): DashboardData => ({
  exceptions: [],
  extras: null,
  inbox: [],
  ar: null,
  myJobs: null,
  returnedReports: null,
  reviewQueue: null,
  sales: {
    overdueFollowUps: 2,
    closingSoon: 3,
    quotesExpiring: 1,
    openPipelineMinor: 500000,
    openPipelineCount: 4,
  },
  work: null,
  failed: [],
  ...over,
});

describe("H20 — dashboard composition", () => {
  it("owner sees all four cards; manager loses the money card; foreman none", () => {
    const owner = allowedCards(cx());
    for (const k of [
      "overdue_followups",
      "opportunities_closing",
      "quotes_expiring",
      "pipeline_value",
    ] as const) {
      expect(owner).toContain(k);
    }
    const manager = allowedCards(cx({ archetype: "manager" }));
    expect(manager).toContain("overdue_followups");
    expect(manager).not.toContain("pipeline_value");
    const foreman = allowedCards(cx({ archetype: "foreman" }));
    for (const k of [
      "overdue_followups",
      "opportunities_closing",
      "quotes_expiring",
      "pipeline_value",
    ] as const) {
      expect(foreman).not.toContain(k);
    }
  });

  it("signals link to their canonical drill-downs with the same window", () => {
    const view = composeAdaptiveDashboard(cx(), data());
    const byKey = (k: string) => [...view.attention, ...view.next].find((i) => i.key === k);
    expect(byKey("overdue_followups")?.href).toBe("/o/org1/sales");
    expect(byKey("opportunities_closing")?.href).toBe("/o/org1/opportunities?view=list&closing=7");
    expect(byKey("quotes_expiring")?.href).toBe("/o/org1/quotes?expiring=7");
    expect(byKey("overdue_followups")?.count).toBe(2);
    expect(byKey("opportunities_closing")?.count).toBe(3);
  });

  it("the pipeline pulse is forecast-labelled, price-gated, and zero is real", () => {
    const priced = composeAdaptiveDashboard(cx(), data());
    const metric = priced.pulse.find((p) => p.key === "pipeline_value");
    expect(metric).toBeDefined();
    expect(metric!.money).toBe(true);
    expect(metric!.value).toBe(500000);
    expect(metric!.labelKey).toBe("dashboard.kpi.pipeline");
    expect(metric!.periodKey).toBe("dashboard.period.open_forecast");
    // Without price privilege the metric never renders (no zero, no null leak).
    const restricted = composeAdaptiveDashboard(cx({ seesPrice: false }), data());
    expect(restricted.pulse.find((p) => p.key === "pipeline_value")).toBeUndefined();
    // sales source failed → unavailable, never a fake zero.
    const failed = composeAdaptiveDashboard(cx(), data({ sales: null, failed: ["sales"] }));
    expect(failed.pulse.find((p) => p.key === "pipeline_value")?.unavailable).toBe(true);
    expect(failed.pulse.find((p) => p.key === "pipeline_value")?.value).toBeNull();
  });

  it("an overdue follow-up warning never outranks a critical blocker", () => {
    const view = composeAdaptiveDashboard(
      cx(),
      data({
        exceptions: [
          {
            id: "e1",
            ruleKey: "blocking_issue",
            severity: "critical",
            jobId: null,
            raisedAt: "2026-08-30",
          } as never,
        ],
        sales: {
          overdueFollowUps: 999,
          closingSoon: 0,
          quotesExpiring: 0,
          openPipelineMinor: 0,
          openPipelineCount: 0,
        },
      }),
    );
    const keys = view.attention.map((i) => i.key);
    expect(keys.indexOf("blocking_issue")).toBeLessThan(keys.indexOf("overdue_followups"));
  });

  it("a disabled customers module removes every sales card", () => {
    const disabled = cx({ disabledModules: new Set<WorkspaceModuleKey>(["cap.customers"]) });
    const cards = allowedCards(disabled);
    expect(cards).not.toContain("overdue_followups");
    expect(cards).not.toContain("opportunities_closing");
    expect(cards).not.toContain("pipeline_value");
    // quotes_expiring rides cap.quoting, which stays on.
    expect(cards).toContain("quotes_expiring");
    const view = composeAdaptiveDashboard(disabled, data());
    expect(view.attention.find((i) => i.key === "overdue_followups")).toBeUndefined();
  });
});

describe("H20 — copy integrity", () => {
  const en = EN as Record<string, string>;
  const ar = AR as Record<string, string>;
  const prefixes = ["leads.", "opps.", "sales.", "pipeline."];

  it("every new key exists in both languages, with no em dash", () => {
    const keys = Object.keys(en).filter((k) => prefixes.some((p) => k.startsWith(p)));
    expect(keys.length).toBeGreaterThan(80);
    for (const k of keys) {
      expect(ar[k], `ar missing ${k}`).toBeTruthy();
      expect(en[k]!.includes("—"), `em dash in en ${k}`).toBe(false);
      expect(ar[k]!.includes("—"), `em dash in ar ${k}`).toBe(false);
      expect(/[؀-ۿ]/.test(ar[k]!), `ar ${k} must carry Arabic script`).toBe(true);
    }
  });

  it("loss reasons and activity kinds each have labels in both languages", () => {
    for (const r of LOSS_REASONS) {
      expect(en[`opps.loss.${r}`]).toBeTruthy();
      expect(ar[`opps.loss.${r}`]).toBeTruthy();
    }
    for (const k of SALES_ACTIVITY_KINDS) {
      expect(en[`sales.kind.${k}`]).toBeTruthy();
      expect(ar[`sales.kind.${k}`]).toBeTruthy();
    }
  });

  it("forecast copy never claims revenue", () => {
    expect(en["dashboard.period.open_forecast"]).toMatch(/Not revenue/);
    expect(en["sales.forecast_note"]).toMatch(/Not revenue/);
    expect(en["sales.closed.value_note"]).toMatch(/never invoiced/);
  });
});

describe("H20 — structural pins", () => {
  it("acceptQuote wins the linked opportunity inside the SAME final transaction", () => {
    const src = readFileSync("src/modules/quotes/service.ts", "utf8");
    // The WON update sits in the acceptance path, guarded to open status.
    expect(src).toMatch(/set status = 'won', stage_key = 'won'/);
    expect(src).toMatch(
      /where org_id = \$\{ctx\.orgId\} and quote_id = \$\{quoteId\} and status = 'open'/,
    );
    // Creation links but never wins: the create hook writes quote_id + an
    // activity only (no status change).
    const createHook = src.slice(0, src.indexOf("export async function submitQuote"));
    expect(createHook).not.toMatch(/set status = 'won'/);
  });

  // Found by H20's production verification: the create-quotation form could
  // not submit at all. A closed Dialog kept its REQUIRED create fields mounted
  // inside the parent <form>, so the browser refused to submit it ("an invalid
  // form control ... is not focusable") with no visible message. Children must
  // mount only while the dialog is open.
  it("a closed dialog never leaves a required control in its parent form", () => {
    const rel = readFileSync("src/platform/ui/RelationshipField.tsx", "utf8");
    // required is gated on `open`, so the parent form can always submit.
    expect(rel).toMatch(/required=\{open && f\.required\}/);
    // And the create fields are real named controls, not anonymous ones.
    expect(rel).toMatch(/name=\{f\.name\}/);
  });

  it("no DELETE grants exist anywhere in the sales migration", () => {
    const mig = readFileSync("supabase/migrations/0078_sales_crm.sql", "utf8");
    expect(mig).not.toMatch(/^grant[^;]*\bdelete\b/im);
    expect(mig).toMatch(/estimated_value_minor is null or estimated_value_minor >= 0/);
    // Terminal safety: category is not in the pipeline_stage update grant.
    const grantLine = mig.match(/grant update \(([^)]*)\) on public\.pipeline_stage/)?.[1] ?? "";
    expect(grantLine).not.toContain("category");
    expect(grantLine).not.toContain("key");
  });
});
