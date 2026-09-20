/**
 * Plans on the homepage: the one typed pricing source still anchors the real
 * catalogue tiers, renders exactly the approved launch targets, states early
 * access truthfully, keeps included-user lines equal to the real entitlements,
 * maps every paid outcome to a real bundle member, and continues into the
 * real journey (no checkout, no fake discount or urgency).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { pricingTiers, ANNUAL_SAVE_PERCENT } from "@/app/_home/pricing";
import { getTierBundle } from "@/platform/entitlements";
import { FREE_PLAN_LIMITS } from "@/platform/entitlements/catalogue";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const plansSrc = read("../../src/app/_home/Plans.tsx");
const trialSrc = read("../../src/app/_home/FinalTrial.tsx");
const strategy = read("../../docs/product/PRICING_STRATEGY_2026.md");

const E = en as Record<string, string>;
const A = ar as Record<string, string>;

describe("tiers", () => {
  it("internal tier IDs are unchanged; public labels are Free/Operations/Complete", () => {
    const tiers = pricingTiers();
    expect(tiers.map((t) => t.key)).toEqual(["free", "medium", "high"]);
    expect(getTierBundle("medium")).toBeTruthy();
    expect(getTierBundle("high")).toBeTruthy();
    expect(tiers.map((t) => t.names.en)).toEqual(["Free", "Operations", "Complete"]);
  });

  it("renders exactly the approved launch targets with a coherent 20% annual", () => {
    const tiers = pricingTiers();
    expect(tiers.map((t) => t.price.monthlyUsd)).toEqual([0, 39, 89]);
    expect(tiers.map((t) => t.price.annualPerMonthUsd)).toEqual([0, 31, 71]);
    expect(tiers.map((t) => t.price.annualBilledUsd)).toEqual([0, 372, 852]);
    expect(ANNUAL_SAVE_PERCENT).toBe(20);
    for (const t of tiers.filter((x) => x.price.monthlyUsd > 0)) {
      const saved = 1 - t.price.annualBilledUsd / (t.price.monthlyUsd * 12);
      expect(Math.round(saved * 100)).toBeGreaterThanOrEqual(ANNUAL_SAVE_PERCENT);
    }
    // Prices come from the config, never from copy: the section renders
    // tier.price.* and the catalogue carries no price numerals.
    expect(plansSrc).toMatch(/tier\.price\.monthlyUsd/);
    for (const k of Object.keys(E).filter((x) => /^home\.(pricing|plans)\./.test(x))) {
      const stripped = E[k]!.replace(/\b(3|13|30)\b/g, "").replace(/20%/g, "");
      expect(/\d/.test(stripped), `${k} carries an unapproved number: "${E[k]}"`).toBe(false);
    }
  });

  it("states early access truthfully and makes no discount, urgency or card claim beyond the verified ones", () => {
    expect(E["home.pricing.early"]).toMatch(/free while billing is being prepared/);
    const BANNED =
      /(off\b|discount|limited time|only \d|hurry|unlimited (storage|everything)|money.?back|refund)/i;
    for (const k of Object.keys(E).filter((x) => /^home\.(pricing|plans|trial|faq)\./.test(x))) {
      expect(BANNED.test(E[k]!), `${k}: "${E[k]}"`).toBe(false);
    }
  });

  it("included-user lines match the real entitlements", () => {
    expect(FREE_PLAN_LIMITS["limit.full_users"]).toBe(3);
    expect(FREE_PLAN_LIMITS["limit.field_users"]).toBeNull(); // unlimited
    expect(E["home.pricing.free.users"]).toContain("3 office users");
    // Both paid tiers include the +10 members pack: 3 + 10 = 13.
    for (const tier of ["medium", "high"] as const) {
      expect(getTierBundle(tier)!.addonKeys).toContain("addon.members_10");
    }
    expect(E["home.pricing.paid.users"]).toContain("13 office users");
  });

  it("every paid outcome maps to the tier bundle's real members", () => {
    const medium = getTierBundle("medium")!.addonKeys;
    const high = getTierBundle("high")!.addonKeys;
    // Operations: quotes/invoices/payments + expenses/purchasing.
    for (const k of [
      "addon.quotes_invoices",
      "addon.payments_ar",
      "addon.expenses_cashbook",
      "addon.purchase_requests",
      "addon.purchase_orders",
    ]) {
      expect(medium).toContain(k);
    }
    // Complete: costing/timesheets/approvals, updates/import/audit, branding/storage.
    for (const k of [
      "addon.job_costing",
      "addon.labour_timesheets",
      "addon.approval_workflows",
      "addon.customer_updates",
      "addon.data_import",
      "addon.audit_history",
      "addon.branding_docs",
      "addon.storage_25gb",
    ]) {
      expect(high).toContain(k);
    }
    for (const tier of pricingTiers().filter((t) => t.key !== "free")) {
      for (const k of tier.outcomeKeys) {
        expect(E[k], `${k} en`).toBeTruthy();
        expect(A[k], `${k} ar`).toBeTruthy();
      }
    }
  });

  it("CTAs continue into the real journey; no checkout or billing selector exists", () => {
    expect(plansSrc).toMatch(/href=\{cta\.href\}/);
    expect(plansSrc).not.toMatch(/checkout|stripe|aria-pressed/i);
    expect(trialSrc).toMatch(/href=\{primaryHref\}/);
    expect(trialSrc).toMatch(/href="\/terms"/);
    expect(trialSrc).toMatch(/ANCHORS\.plans/);
  });

  it("the strategy document records official sources and the research date", () => {
    expect(strategy).toMatch(/2026/);
    expect(strategy.length).toBeGreaterThan(1000);
  });
});
