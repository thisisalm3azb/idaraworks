/**
 * Safety-focused unit tests for the simulation factory: cross-tenant id isolation,
 * no external-send surfaces / no deliverable contacts, dashboard-aggregation
 * reconciliation, the demo-marker cleanup guard, and the Arabic/RTL config. All
 * pure — no database.
 */
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../../tooling/simulation/scenarios";
import { buildPlan } from "../../tooling/simulation/plan";
import { check } from "../../tooling/simulation/invariants";
import { isDemoMarker } from "../../tooling/simulation/marker";
import type { Plan } from "../../tooling/simulation/types";

const ASOF = "2026-08-27";
const plans = new Map<string, Plan>(SCENARIOS.map((s) => [s.key, buildPlan(s, ASOF)]));

function allIds(plan: Plan): string[] {
  const ids: string[] = [];
  const collect = (rows: Array<{ id?: string }>) => rows.forEach((r) => r.id && ids.push(r.id));
  collect(plan.customers);
  collect(plan.suppliers);
  collect(plan.items);
  collect(plan.employees);
  collect(plan.jobs);
  collect(plan.quotes);
  collect(plan.invoices);
  collect(plan.payments);
  collect(plan.reports);
  collect(plan.issues);
  collect(plan.expenses);
  collect(plan.materialRequests);
  collect(plan.purchaseOrders);
  collect(plan.goodsReceipts);
  return ids;
}

describe("cross-tenant isolation (deterministic ids never collide across orgs)", () => {
  it("no entity id is shared between any two scenarios", () => {
    const seen = new Map<string, string>();
    for (const [key, plan] of plans) {
      for (const id of allIds(plan)) {
        const prev = seen.get(id);
        expect(prev, `id ${id} appears in both ${prev} and ${key}`).toBeUndefined();
        seen.set(id, key);
      }
    }
  });
});

describe("no external-send surfaces / no deliverable contacts", () => {
  it("owner login emails are the reserved non-deliverable example.com domain", () => {
    for (const s of SCENARIOS) {
      expect(s.contact.email).toMatch(/^sim-[a-z-]+@example\.com$/);
    }
    // Distinct per business.
    expect(new Set(SCENARIOS.map((s) => s.contact.email)).size).toBe(5);
  });
  it("no seeded customer/supplier carries an email or TRN (nothing to notify)", () => {
    for (const plan of plans.values()) {
      for (const c of [...plan.customers, ...plan.suppliers]) {
        expect(c.email).toBeNull();
        expect((c as { taxRegNo?: string | null }).taxRegNo).toBeNull();
      }
    }
  });
  it("phone numbers are the obviously-fake +971 50 000 0x block", () => {
    for (const s of SCENARIOS) expect(s.contact.phone).toMatch(/^\+971 50 000 0\d{3}$/);
  });
});

describe("dashboard-aggregation reconciliation", () => {
  it("computed metrics match an independent recount for every scenario", () => {
    for (const s of SCENARIOS) {
      const plan = plans.get(s.key)!;
      const res = check(plan, s);
      const openBlockers = plan.issues.filter(
        (i) => i.isBlocker && i.status !== "resolved" && i.status !== "closed",
      ).length;
      const pending = plan.approvals.filter((a) => a.state === "pending").length;
      const unpaidExp = plan.expenses.filter((e) => e.paymentStatus === "unpaid").length;
      expect(res.metrics.openBlockers).toBe(openBlockers);
      expect(res.metrics.pendingApprovals).toBe(pending);
      expect(res.metrics.unpaidExpenses).toBe(unpaidExp);
    }
  });
});

describe("demo-marker cleanup guard", () => {
  it("recognises only genuine demo markers (real orgs are never selected)", () => {
    const rows = [
      { org_id: "demo-1", value: { is_demo: true, scenario: "coffee_catering" } },
      { org_id: "real-1", value: { some: "other-setting" } }, // a real org's app_settings
      { org_id: "real-2", value: { is_demo: false, scenario: "x" } },
      { org_id: "real-3", value: null },
    ];
    const selected = rows.filter((r) => isDemoMarker(r.value)).map((r) => r.org_id);
    expect(selected).toEqual(["demo-1"]);
  });
});

describe("Arabic / RTL scenario", () => {
  it("only the palm farm defaults to Arabic and requests Arabic documents", () => {
    const arabic = SCENARIOS.filter((s) => s.locale === "ar");
    expect(arabic.map((s) => s.key)).toEqual(["palm_farm"]);
    expect(arabic[0]!.docLanguage).toBe("ar");
    // The other four stay English UI.
    for (const s of SCENARIOS.filter((s) => s.key !== "palm_farm")) expect(s.locale).toBe("en");
  });
});

describe("history is lighter in the past, richest recently", () => {
  it("most daily reports fall inside the recent rich window", () => {
    for (const s of SCENARIOS) {
      const plan = plans.get(s.key)!;
      const recent = plan.reports.filter((r) => r.reportDate >= addDays(ASOF, -s.richDays)).length;
      // The vast majority of operational reporting detail is in the recent window.
      expect(recent).toBeGreaterThanOrEqual(Math.floor(plan.reports.length * 0.8));
    }
  });
});

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
