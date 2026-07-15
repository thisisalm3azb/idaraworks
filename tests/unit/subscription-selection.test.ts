/**
 * U3 subscription-selection surface (unit): buildSelectionView shape honesty
 * (Free shows $0 + the real free-plan limits; deferred items are absent;
 * credential-gated items are flagged non-selectable with their reason), the
 * shared monthly-total math (bundle counted ONCE — overlap never double-
 * charges), the display-only current-selection mapping, and the LockedFeature
 * resolution map (every capability a money page gates resolves to at least one
 * purchasable add-on and a tier).
 */
import { describe, expect, it } from "vitest";
import {
  buildSelectionView,
  computeMonthlyTotalMinor,
  currentSelectionLabel,
} from "@/modules/subscription/selection";
import {
  ADDONS,
  getAddon,
  getTierBundle,
  isPurchasable,
  purchasableUnlocksFor,
  FREE_PLAN_LIMITS,
  type FeatureKey,
} from "@/platform/entitlements";

/** The page-gated capabilities wired to <LockedFeature> (U3 step 4). */
const PAGE_GATED: FeatureKey[] = [
  "cap.quoting",
  "cap.invoicing",
  "cap.payments",
  "cap.expenses",
  "cap.material_requests",
  "cap.purchase_orders",
  "cap.costing",
];

describe("buildSelectionView (the four paths, from the real catalogue)", () => {
  const view = buildSelectionView();

  it("Free shows $0 and the REAL free-plan limits (3/3 seats, unlimited field, 10 active, 1 GB)", () => {
    expect(view.free.priceMonthlyMinor.USD).toBe(0);
    expect(view.free.priceMonthlyMinor.AED).toBe(0);
    expect(view.free.limits.officeSeats).toBe(3);
    expect(view.free.limits.viewerSeats).toBe(3);
    expect(view.free.limits.fieldSeats).toBeNull(); // unlimited by product law
    expect(view.free.limits.activeJobs).toBe(10);
    expect(view.free.limits.storageGb).toBe(1);
    // The constants mirror the 0065 seeds — pin the source too.
    expect(FREE_PLAN_LIMITS["limit.full_users"]).toBe(3);
  });

  it("Medium and High are the tier bundles, with member totals and honest savings", () => {
    expect(view.medium.bundleKey).toBe("bundle.tier_medium");
    expect(view.high.bundleKey).toBe("bundle.tier_high");
    expect(view.medium.priceMonthlyMinor.USD).toBe(1500);
    expect(view.medium.memberTotalMinor.USD).toBe(2800);
    expect(view.high.priceMonthlyMinor.USD).toBe(3900);
    expect(view.high.memberTotalMinor.USD).toBe(7500);
    for (const tier of [view.medium, view.high]) {
      expect(tier.members.length).toBe(getTierBundle(tier.tier)!.addonKeys.length);
      expect(tier.savingPct.USD).toBeGreaterThanOrEqual(40);
      expect(tier.savingPct.AED).toBeGreaterThanOrEqual(40);
    }
  });

  it("HONESTY: deferred add-ons are ABSENT from the Custom path entirely", () => {
    const shown = view.custom.groups.flatMap((g) => g.items.map((i) => i.addon.key));
    for (const a of ADDONS.filter((x) => x.availability === "deferred")) {
      expect(shown, `${a.key} is deferred and must not appear`).not.toContain(a.key);
    }
  });

  it("HONESTY: credential/D1-gated add-ons appear flagged non-selectable WITH a reason", () => {
    const gatedGroup = view.custom.groups.find((g) => g.key === "gated");
    expect(gatedGroup).toBeDefined();
    const gatedInCatalogue = ADDONS.filter(
      (a) => a.availability === "credential_gated" || a.availability === "d1_gated",
    );
    expect(gatedGroup!.items.length).toBe(gatedInCatalogue.length);
    for (const item of gatedGroup!.items) {
      expect(item.selectable).toBe(false);
      expect(item.addon.availabilityNote, `${item.addon.key} needs an honest reason`).toBeDefined();
    }
    // And the gated group renders LAST (honesty groups after purchasable ones).
    expect(view.custom.groups[view.custom.groups.length - 1]!.key).toBe("gated");
  });

  it("every selectable Custom item is genuinely purchasable", () => {
    for (const g of view.custom.groups) {
      for (const item of g.items.filter((i) => i.selectable)) {
        expect(isPurchasable(item.addon)).toBe(true);
      }
    }
  });
});

describe("computeMonthlyTotalMinor (what the org actually pays)", () => {
  const tierMedium = getTierBundle("medium")!;

  it("a tier's member rows charge the BUNDLE price once — never the member sum", () => {
    const rows = tierMedium.addonKeys.map((k) => ({
      addon_key: k,
      quantity: 1,
      status: "active",
      source: "bundle.tier_medium",
    }));
    expect(computeMonthlyTotalMinor(rows, "USD")).toBe(1500);
    expect(computeMonthlyTotalMinor(rows, "AED")).toBe(5500);
  });

  it("individual rows add price × quantity on top of a bundle", () => {
    const rows = [
      ...tierMedium.addonKeys.map((k) => ({
        addon_key: k,
        quantity: 1,
        status: "active",
        source: "bundle.tier_medium",
      })),
      { addon_key: "addon.storage_25gb", quantity: 2, status: "active", source: "individual" },
    ];
    expect(computeMonthlyTotalMinor(rows, "USD")).toBe(
      1500 + 2 * getAddon("addon.storage_25gb")!.usdMonthlyMinor,
    );
  });
});

describe("currentSelectionLabel (display mapping only — never converts)", () => {
  it("maps tier-sourced rows to the tier, other live add-ons to custom, none to null", () => {
    expect(
      currentSelectionLabel([
        {
          addon_key: "addon.quotes_invoices",
          quantity: 1,
          status: "active",
          source: "bundle.tier_medium",
        },
      ]),
    ).toBe("medium");
    expect(
      currentSelectionLabel([
        {
          addon_key: "addon.quotes_invoices",
          quantity: 1,
          status: "active",
          source: "bundle.tier_high",
        },
      ]),
    ).toBe("high");
    expect(
      currentSelectionLabel([
        { addon_key: "addon.quotes_invoices", quantity: 1, status: "active", source: "individual" },
        { addon_key: "addon.payments_ar", quantity: 1, status: "active", source: "bundle.finance" },
      ]),
    ).toBe("custom");
    expect(
      currentSelectionLabel([
        {
          addon_key: "addon.quotes_invoices",
          quantity: 1,
          status: "removed",
          source: "individual",
        },
      ]),
    ).toBeNull();
    expect(currentSelectionLabel([])).toBeNull();
  });
});

describe("LockedFeature resolution map (purchasableUnlocksFor)", () => {
  it("every page-gated capability resolves to ≥1 purchasable add-on AND ≥1 tier", () => {
    for (const key of PAGE_GATED) {
      const { addons, bundles } = purchasableUnlocksFor(key);
      expect(addons.length, `${key} has no purchasable unlock`).toBeGreaterThan(0);
      const tiers = bundles.filter((b) => b.tier !== undefined);
      expect(tiers.length, `${key} is in no tier`).toBeGreaterThan(0);
      // High is "everything available" — it must always be one of them.
      expect(tiers.map((b) => b.key)).toContain("bundle.tier_high");
    }
  });

  it("every feature key sold by a purchasable add-on resolves back to a purchasable unlock", () => {
    for (const addon of ADDONS.filter(isPurchasable)) {
      for (const key of addon.features) {
        const { addons } = purchasableUnlocksFor(key);
        expect(
          addons.map((a) => a.key),
          `${key} must resolve`,
        ).toContain(addon.key);
      }
    }
  });
});
