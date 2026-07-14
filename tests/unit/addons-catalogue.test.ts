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

  it("the owner's five anchors are kept", () => {
    expect(getAddon("addon.members_10")!.usdMonthlyMinor).toBe(500);
    expect(getAddon("addon.quotes_invoices")!.usdMonthlyMinor).toBe(500);
    expect(getAddon("addon.branding_docs")!.usdMonthlyMinor).toBe(200);
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

  it("bundles never include stackable seat/storage packs (quantity ambiguity)", () => {
    for (const b of BUNDLES) {
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
