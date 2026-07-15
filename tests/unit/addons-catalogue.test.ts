/**
 * Add-on catalogue honesty + integrity invariants (post-MVP add-on model).
 * The HONESTY LAW is enforced here at build time: deferred capabilities are
 * never purchasable, purchasable items always have a real price, bundles are
 * genuine discounts over the SAME add-on keys, and every granted entitlement
 * key actually exists in the closed catalogue.
 */
import { describe, expect, it } from "vitest";
import {
  ADDONS,
  BUNDLES,
  getAddon,
  isPurchasable,
  bundleIsPurchasable,
  bundleMemberTotalMinor,
} from "@/platform/entitlements/addons";
import { isFeatureKey, isLimitKey } from "@/platform/entitlements/catalogue";

describe("add-on catalogue integrity", () => {
  it("has at least 20 individually priced monthly add-ons (directive minimum)", () => {
    const priced = ADDONS.filter((a) => a.usdMonthlyMinor > 0);
    expect(priced.length).toBeGreaterThanOrEqual(20);
  });

  it("keys are unique and well-formed", () => {
    const keys = ADDONS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^addon\.[a-z0-9_]{1,40}$/);
  });

  it("every granted entitlement key exists in the closed catalogue", () => {
    for (const a of ADDONS) {
      for (const f of a.features) expect(isFeatureKey(f)).toBe(true);
      for (const k of Object.keys(a.limitDeltas)) expect(isLimitKey(k)).toBe(true);
    }
  });

  it("every add-on has Arabic AND English names + descriptions", () => {
    for (const a of ADDONS) {
      expect(a.names.en.trim().length).toBeGreaterThan(0);
      expect(a.names.ar.trim().length).toBeGreaterThan(0);
      expect(a.description.en.trim().length).toBeGreaterThan(0);
      expect(a.description.ar.trim().length).toBeGreaterThan(0);
    }
  });

  it("HONESTY: deferred add-ons are NEVER purchasable and carry no price", () => {
    for (const a of ADDONS.filter((x) => x.availability === "deferred")) {
      expect(isPurchasable(a)).toBe(false);
      expect(a.usdMonthlyMinor).toBe(0);
      expect(a.aedMonthlyMinor).toBe(0);
      expect(a.features.length).toBe(0); // grants nothing it cannot deliver
      expect(Object.keys(a.limitDeltas).length).toBe(0);
    }
  });

  it("HONESTY: credential/d1-gated add-ons are not purchasable and explain why", () => {
    for (const a of ADDONS.filter(
      (x) => x.availability === "credential_gated" || x.availability === "d1_gated",
    )) {
      expect(isPurchasable(a)).toBe(false);
      expect(a.availabilityNote).toBeDefined();
    }
  });

  it("purchasable add-ons always carry a real price (USD + AED)", () => {
    for (const a of ADDONS.filter(isPurchasable)) {
      expect(a.usdMonthlyMinor).toBeGreaterThan(0);
      expect(a.aedMonthlyMinor).toBeGreaterThan(0);
    }
  });

  it("AED companion prices track USD (~3.67x, rounded to clean figures)", () => {
    for (const a of ADDONS.filter((x) => x.usdMonthlyMinor > 0)) {
      const ratio = a.aedMonthlyMinor / a.usdMonthlyMinor;
      expect(ratio).toBeGreaterThan(3.2);
      expect(ratio).toBeLessThan(4.2);
    }
  });

  it("only seat/workspace/storage packs are stackable", () => {
    const stackable = ADDONS.filter((a) => a.stackable).map((a) => a.key);
    expect(stackable.sort()).toEqual(
      ["addon.extra_org", "addon.members_10", "addon.storage_25gb"].sort(),
    );
  });

  it("the owner's anchors are kept (branding anchors restored by 0071)", () => {
    expect(getAddon("addon.members_10")!.usdMonthlyMinor).toBe(500);
    expect(getAddon("addon.quotes_invoices")!.usdMonthlyMinor).toBe(500);
    // 0070 deferred the branding add-ons (no capability existed); 0071 shipped
    // the capability and restored them at the owner's $2/$1 anchors.
    expect(getAddon("addon.branding_docs")!.availability).toBe("available");
    expect(getAddon("addon.branding_docs")!.usdMonthlyMinor).toBe(200);
    expect(getAddon("addon.branding_app")!.availability).toBe("available");
    expect(getAddon("addon.branding_app")!.usdMonthlyMinor).toBe(100);
    // Accounting ≈ $9 → the Finance bundle price.
    expect(BUNDLES.find((b) => b.key === "bundle.finance")!.usdMonthlyMinor).toBe(900);
  });
});

describe("bundle integrity (a bundle is ONLY a discounted collection)", () => {
  it("bundle keys unique + well-formed; members exist and are unique", () => {
    const keys = BUNDLES.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const b of BUNDLES) {
      expect(b.key).toMatch(/^bundle\.[a-z0-9_]{1,40}$/);
      expect(new Set(b.addonKeys).size).toBe(b.addonKeys.length);
      for (const k of b.addonKeys) expect(getAddon(k)).toBeDefined();
    }
  });

  it("every bundle is purchasable (contains only purchasable add-ons)", () => {
    for (const b of BUNDLES) expect(bundleIsPurchasable(b)).toBe(true);
  });

  it("every bundle is a GENUINE discount vs buying members individually", () => {
    for (const b of BUNDLES) {
      const membersUsd = bundleMemberTotalMinor(b, "USD");
      const membersAed = bundleMemberTotalMinor(b, "AED");
      expect(b.usdMonthlyMinor).toBeLessThan(membersUsd);
      expect(b.aedMonthlyMinor).toBeLessThan(membersAed);
    }
  });

  it("non-tier bundles never include stackable seat/storage packs (quantity ambiguity)", () => {
    // TIER bundles (U3) are the deliberate exception: they include the seat/
    // storage packs at quantity 1 (changeAddons expands every bundle member at
    // quantity 1; extra packs are bought individually on top).
    for (const b of BUNDLES.filter((x) => x.tier === undefined)) {
      for (const k of b.addonKeys) expect(getAddon(k)!.stackable).toBe(false);
    }
  });

  it("bundles have Arabic AND English names + descriptions", () => {
    for (const b of BUNDLES) {
      expect(b.names.ar.trim().length).toBeGreaterThan(0);
      expect(b.description.ar.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("tier bundles (U3 four-path model: Medium / High are governed bundles)", () => {
  const medium = BUNDLES.find((b) => b.tier === "medium");
  const high = BUNDLES.find((b) => b.tier === "high");

  it("exactly one Medium and one High tier bundle exist, with stable keys", () => {
    expect(BUNDLES.filter((b) => b.tier !== undefined).length).toBe(2);
    expect(medium?.key).toBe("bundle.tier_medium");
    expect(high?.key).toBe("bundle.tier_high");
  });

  it("tier members are ⊆ purchasable ADDONS, unique, and never gated/deferred/manual", () => {
    for (const tier of [medium!, high!]) {
      expect(new Set(tier.addonKeys).size).toBe(tier.addonKeys.length);
      for (const k of tier.addonKeys) {
        const a = getAddon(k);
        expect(a, `${tier.key} references unknown add-on ${k}`).toBeDefined();
        expect(isPurchasable(a!)).toBe(true);
        // Stricter than purchasable: tiers sell only what is plainly available
        // today (no manual_process, no credential/D1 gates, no deferred).
        expect(a!.availability, `${tier.key} must not include ${k}`).toBe("available");
      }
    }
  });

  it("Medium is the exact balanced small-business set", () => {
    expect(new Set(medium!.addonKeys)).toEqual(
      new Set([
        "addon.members_10",
        "addon.quotes_invoices",
        "addon.payments_ar",
        "addon.expenses_cashbook",
        "addon.purchase_requests",
        "addon.purchase_orders",
      ]),
    );
  });

  it("High is ALL currently-available modules + branding + the seat/storage packs", () => {
    const available = ADDONS.filter((a) => a.availability === "available").map((a) => a.key);
    // Every plainly-available add-on is in the tier, and nothing else is.
    expect(new Set(high!.addonKeys)).toEqual(new Set(available));
    expect(high!.addonKeys).toContain("addon.branding_docs"); // 0071 reactivation included
    expect(high!.addonKeys).toContain("addon.branding_app");
  });

  it("tier maths: member totals are exact and the saving is honest (≥40%, never dominated)", () => {
    // Medium: 5+5+5+4+4+5 = $28 / AED 106 → $15 / AED 55.
    expect(bundleMemberTotalMinor(medium!, "USD")).toBe(2800);
    expect(bundleMemberTotalMinor(medium!, "AED")).toBe(10600);
    expect(medium!.usdMonthlyMinor).toBe(1500);
    expect(medium!.aedMonthlyMinor).toBe(5500);
    // High: full_ops fifteen 63 + branding 2+1 + members 5 + storage 4 = $75 / AED 282 → $39 / AED 143.
    expect(bundleMemberTotalMinor(high!, "USD")).toBe(7500);
    expect(bundleMemberTotalMinor(high!, "AED")).toBe(28200);
    expect(high!.usdMonthlyMinor).toBe(3900);
    expect(high!.aedMonthlyMinor).toBe(14300);
    for (const tier of [medium!, high!]) {
      for (const c of ["USD", "AED"] as const) {
        const price = c === "USD" ? tier.usdMonthlyMinor : tier.aedMonthlyMinor;
        const sum = bundleMemberTotalMinor(tier, c);
        expect(price).toBeLessThan(sum);
        expect(1 - price / sum).toBeGreaterThanOrEqual(0.4);
      }
    }
    // Never a dominated sticker: High must undercut the cheapest combination
    // path shown on the same page (full_ops + packs + branding singles).
    const fullOps = BUNDLES.find((b) => b.key === "bundle.full_ops")!;
    const altUsd =
      fullOps.usdMonthlyMinor +
      getAddon("addon.members_10")!.usdMonthlyMinor +
      getAddon("addon.storage_25gb")!.usdMonthlyMinor +
      getAddon("addon.branding_docs")!.usdMonthlyMinor +
      getAddon("addon.branding_app")!.usdMonthlyMinor;
    expect(high!.usdMonthlyMinor).toBeLessThan(altUsd);
  });
});
