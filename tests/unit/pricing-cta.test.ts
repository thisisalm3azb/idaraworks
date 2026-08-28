/**
 * H9/H9.1 — pricing, closing section and footer. Guarantees:
 *  - internal tier IDs stay free/medium/high while PUBLIC labels are
 *    Free / Operations / Complete (mapping anchored to the real catalogue),
 *  - the approved launch targets render exactly ($0/$39/$89 monthly;
 *    $31/$71 annual equivalents billed $372/$852; 20% saving) and no other
 *    price, discount or promotion language exists,
 *  - placeholder-pricing language is retired; the early-access statement is
 *    truthful against the disabled payment provider,
 *  - included-user lines match the real entitlements (3 office users free;
 *    13 on paid tiers via the members pack; field users unlimited),
 *  - every plan outcome maps to the tier bundle's real add-on members,
 *  - CTAs continue into the real signup/login/workspace journey (no fake
 *    checkout), the dark CTA slab is gone, and the closing section renders
 *    with the three-step path in both locales,
 *  - the footer links only real destinations.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { pricingTiers, ANNUAL_SAVE_PERCENT } from "@/app/_home/pricing";
import { getTierBundle } from "@/platform/entitlements";
import { FREE_PLAN_LIMITS } from "@/platform/entitlements/catalogue";

const homeSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/_home/HomePage.tsx", import.meta.url)),
  "utf8",
);
const plansSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/_home/PricingPlans.tsx", import.meta.url)),
  "utf8",
);
const closingSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/_home/ClosingSection.tsx", import.meta.url)),
  "utf8",
);
const subscriptionSrc = readFileSync(
  fileURLToPath(new URL("../../src/modules/subscription/service.ts", import.meta.url)),
  "utf8",
);
const strategyDoc = readFileSync(
  fileURLToPath(new URL("../../docs/product/PRICING_STRATEGY_2026.md", import.meta.url)),
  "utf8",
);

const pricingEn = Object.keys(en)
  .filter((k) => k.startsWith("home.pricing.") || k.startsWith("home.close."))
  .map((k) => String(en[k as keyof typeof en]))
  .join("  ");

describe("H9.1 — plan identity and prices", () => {
  it("internal tier IDs are unchanged; public labels are Free/Operations/Complete", () => {
    const tiers = pricingTiers();
    expect(tiers.map((t) => t.key)).toEqual(["free", "medium", "high"]);
    expect(tiers.map((t) => t.names.en)).toEqual(["Free", "Operations", "Complete"]);
    expect(tiers.map((t) => t.names.ar)).toEqual(["مجاني", "العمليات", "المتكاملة"]);
    // The mapping stays anchored to the REAL catalogue tiers.
    expect(getTierBundle("medium")).toBeTruthy();
    expect(getTierBundle("high")).toBeTruthy();
    // No internal identifier leaks into public copy.
    expect(pricingEn).not.toMatch(/\b(medium|high|tier_medium|tier_high|addon\.)\b/);
  });

  it("renders exactly the approved launch targets with a coherent 20% annual", () => {
    const [free, ops, complete] = pricingTiers();
    expect(free!.price).toEqual({ monthlyUsd: 0, annualPerMonthUsd: 0, annualBilledUsd: 0 });
    expect(ops!.price).toEqual({ monthlyUsd: 39, annualPerMonthUsd: 31, annualBilledUsd: 372 });
    expect(complete!.price).toEqual({
      monthlyUsd: 89,
      annualPerMonthUsd: 71,
      annualBilledUsd: 852,
    });
    expect(ANNUAL_SAVE_PERCENT).toBe(20);
    for (const t of [ops!, complete!]) {
      // Billed total is exactly 12x the advertised per-month equivalent, and
      // the saving vs monthly is 20% within a rounding point.
      expect(t.price.annualBilledUsd).toBe(t.price.annualPerMonthUsd * 12);
      const save = 1 - t.price.annualBilledUsd / (t.price.monthlyUsd * 12);
      expect(Math.round(save * 100)).toBeGreaterThanOrEqual(20);
      expect(Math.round(save * 100)).toBeLessThanOrEqual(21);
    }
    expect(String(en["home.pricing.billing_save" as keyof typeof en])).toContain("20%");
  });

  it("retires placeholder-pricing language and states early access truthfully", () => {
    expect("home.pricing.finalizing" in en).toBe(false);
    expect(pricingEn).not.toMatch(/being finalized|prices are shown at sign[- ]up/i);
    // The provider is still gated off, so "early access is free" is literal.
    expect(subscriptionSrc).toMatch(/provider_unavailable|BillingProviderDisabled/);
    expect(String(en["home.pricing.early" as keyof typeof en])).toMatch(
      /early access is free while billing is being prepared/i,
    );
    expect(String(en["home.pricing.early" as keyof typeof en])).toMatch(/planned launch prices/i);
  });

  it("makes no discount, urgency, trial, unlimited-usage or card claim beyond the verified ones", () => {
    expect(pricingEn).not.toMatch(
      /free forever|cancel anytime|trial|% off|crossed|limited[- ]time|ends (soon|in)|only \d+ left|most popular|countdown/i,
    );
    expect(pricingEn).not.toContain("—");
    expect(pricingEn).not.toMatch(/\bAI\b/);
    // "unlimited" appears ONLY for field users (product law) — nowhere else.
    const unlimitedUses = pricingEn.match(/unlimited [a-z]+/gi) ?? [];
    for (const u of unlimitedUses) expect(u.toLowerCase()).toBe("unlimited field");
  });

  it("included-user lines match the real entitlements", () => {
    expect(FREE_PLAN_LIMITS["limit.full_users"]).toBe(3);
    expect(FREE_PLAN_LIMITS["limit.field_users"]).toBeNull(); // unlimited
    expect(String(en["home.pricing.free.users" as keyof typeof en])).toContain("3 office users");
    // Both paid tiers include the +10 members pack: 3 + 10 = 13.
    for (const tier of ["medium", "high"] as const) {
      expect(getTierBundle(tier)!.addonKeys).toContain("addon.members_10");
    }
    expect(String(en["home.pricing.paid.users" as keyof typeof en])).toContain("13 office users");
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
  });
});

describe("H9.1 — selector, CTAs and closing section", () => {
  it("the billing selector is two real pressed-state buttons in a labelled group", () => {
    expect(plansSrc).toMatch(/role="group"/);
    expect(plansSrc).toMatch(/aria-pressed=\{period === "monthly"\}/);
    expect(plansSrc).toMatch(/aria-pressed=\{period === "annual"\}/);
    expect((plansSrc.match(/<button\s/g) ?? []).length).toBe(2);
    expect(plansSrc).not.toMatch(/role="(switch|tab)"|<div[^>]*onClick/);
  });

  it("CTAs continue into the real journey; no fake checkout exists", () => {
    // No fake destination: the only links are the real primary journey.
    expect(plansSrc).not.toMatch(/href="\/(checkout|billing|pay|subscribe)/i);
    expect(plansSrc).not.toMatch(/<form|stripe|paddle/i);
    expect(homeSrc).toMatch(/cta: \{ href: primary\.href, label: primary\.label \}/);
    expect(closingSrc).not.toMatch(/checkout/i);
    // Signed-out closing primary is "Build my workspace" -> signup; signed-in
    // keeps the workspace action.
    expect(homeSrc).toMatch(
      /authed\s*\?\s*primary\s*:\s*\{ href: primary\.href, label: t\("home\.close\.cta"\) \}/,
    );
  });

  it("the dark CTA slab is gone and the closing section replaced it", () => {
    expect(homeSrc).not.toMatch(/bg-hero|hero-line|hero-dim/);
    expect("home.cta.title" in en).toBe(false);
    expect("home.cta.reassure" in en).toBe(false);
    expect(homeSrc).toContain("<ClosingSection");
    for (const k of [
      "eyebrow",
      "title",
      "body",
      "cta",
      "reassure",
      "s1",
      "s1d",
      "s2",
      "s2d",
      "s3",
      "s3d",
    ]) {
      expect(`home.close.${k}` in en, `missing home.close.${k}`).toBe(true);
      expect(
        /[؀-ۿ]/.test(String(ar[`home.close.${k}` as keyof typeof ar])),
        `ar home.close.${k}`,
      ).toBe(true);
    }
    expect(String(en["home.close.reassure" as keyof typeof en])).toMatch(/no card required/i);
  });

  it("the footer still links every section anchor plus only real routes", () => {
    const footer = homeSrc.slice(homeSrc.indexOf("<footer"));
    for (const a of ["#how", "#product", "#international", "#trust", "#pricing"]) {
      expect(footer, `footer missing ${a}`).toContain(`href="${a}"`);
    }
    expect(footer).toContain('href="/terms"');
    expect(footer).toContain('href="/privacy"');
    expect(footer).not.toMatch(/mailto:|href="https?:/);
  });

  it("the strategy document records official sources and the research date", () => {
    expect(strategyDoc).toContain("Research date: 2026-08-29");
    for (const url of [
      "https://monday.com/pricing",
      "https://clickup.com/pricing",
      "https://www.odoo.com/pricing",
      "https://www.getjobber.com/pricing/",
      "https://quickbooks.intuit.com/ae/online-compare/",
    ]) {
      expect(strategyDoc).toContain(url);
    }
    expect(strategyDoc).toMatch(/seat-limit decision/i);
  });

  it("all H9.1 copy exists in both catalogs with no em dash", () => {
    for (const k of Object.keys(en).filter(
      (x) => x.startsWith("home.pricing.") || x.startsWith("home.close."),
    )) {
      expect(k in ar, `ar missing ${k}`).toBe(true);
      expect(String(en[k as keyof typeof en])).not.toContain("—");
      expect(String(ar[k as keyof typeof ar])).not.toContain("—");
    }
  });
});
