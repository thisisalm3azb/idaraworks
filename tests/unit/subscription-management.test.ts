/**
 * PART D (unit) — the governed subscription-management surface, pure layers:
 *  • buildChangeReview (current→new deltas, totals, immediate vs scheduled);
 *  • planAddonChange (the shared change laws: quantity bounds, honesty, decrease
 *    refusal, removal computation, bundle expansion);
 *  • classifySubscriptionError (PART C taxonomy → safe codes);
 *  • currentPriceVersion (the stale-price fingerprint);
 *  • the tier member lists + savings recomputed straight from addons.ts;
 *  • every error code has an EN + AR i18n message.
 */
import { describe, expect, it } from "vitest";
import { buildChangeReview, type ReviewItem } from "@/platform/ui/subscription/review";
import {
  planAddonChange,
  classifySubscriptionError,
  currentPriceVersion,
  SubscriptionChangeError,
  AddonUnavailableError,
  type SubscriptionErrorCode,
} from "@/modules/subscription/service";
import { BillingReadOnlyError } from "@/platform/entitlements/resolve";
import { ForbiddenError } from "@/platform/authz";
import { getAddon, getTierBundle, bundleMemberTotalMinor } from "@/platform/entitlements";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";

const ITEMS: ReviewItem[] = [
  { key: "addon.quotes_invoices", name: "Quotes", priceMonthlyMinor: 500, stackable: false },
  { key: "addon.members_10", name: "Members", priceMonthlyMinor: 500, stackable: true },
  { key: "addon.expenses_cashbook", name: "Expenses", priceMonthlyMinor: 400, stackable: false },
];

describe("buildChangeReview", () => {
  it("classifies additions (immediate) and computes totals + diff", () => {
    const r = buildChangeReview(ITEMS, {}, { "addon.quotes_invoices": 1 });
    expect(r.added.map((d) => d.key)).toEqual(["addon.quotes_invoices"]);
    expect(r.removed).toHaveLength(0);
    expect(r.currentTotalMinor).toBe(0);
    expect(r.newTotalMinor).toBe(500);
    expect(r.diffMinor).toBe(500);
    expect(r.hasImmediate).toBe(true);
    expect(r.hasScheduled).toBe(false);
    expect(r.isNoop).toBe(false);
  });

  it("classifies a removal (scheduled) and a negative diff", () => {
    const r = buildChangeReview(ITEMS, { "addon.quotes_invoices": 1 }, {});
    expect(r.removed.map((d) => d.key)).toEqual(["addon.quotes_invoices"]);
    expect(r.hasScheduled).toBe(true);
    expect(r.hasImmediate).toBe(false);
    expect(r.diffMinor).toBe(-500);
  });

  it("classifies a stackable increase (immediate) and decrease (scheduled)", () => {
    const inc = buildChangeReview(ITEMS, { "addon.members_10": 1 }, { "addon.members_10": 3 });
    expect(inc.increased[0]).toMatchObject({ from: 1, to: 3 });
    expect(inc.hasImmediate).toBe(true);
    const dec = buildChangeReview(ITEMS, { "addon.members_10": 3 }, { "addon.members_10": 1 });
    expect(dec.decreased[0]).toMatchObject({ from: 3, to: 1 });
    expect(dec.hasScheduled).toBe(true);
  });

  it("an identical set is a no-op (idempotent submit)", () => {
    const r = buildChangeReview(
      ITEMS,
      { "addon.quotes_invoices": 1 },
      { "addon.quotes_invoices": 1 },
    );
    expect(r.isNoop).toBe(true);
    expect(r.diffMinor).toBe(0);
  });
});

describe("planAddonChange (shared change laws)", () => {
  const rows: Array<{ addon_key: string; quantity: number; status: string; source: string }> = [];

  it("expands a tier bundle to its members, one per key, tagged with the source", () => {
    const tier = getTierBundle("medium")!;
    const plan = planAddonChange({ additions: [], removals: [], bundleKey: tier.key }, rows, null);
    expect([...plan.byKey.keys()].sort()).toEqual([...tier.addonKeys].sort());
    for (const [, v] of plan.byKey) expect(v.source).toBe(tier.key);
  });

  it("pins a non-stackable add-on to quantity 1 and bounds stackables to 1..99", () => {
    const plan = planAddonChange(
      { additions: [{ addonKey: "addon.quotes_invoices", quantity: 5 }], removals: [] },
      rows,
      null,
    );
    expect(plan.byKey.get("addon.quotes_invoices")!.quantity).toBe(1); // non-stackable pinned
    expect(() =>
      planAddonChange(
        { additions: [{ addonKey: "addon.members_10", quantity: 100 }], removals: [] },
        rows,
        null,
      ),
    ).toThrow(/between 1 and 99/);
  });

  it("HONESTY: refuses a non-purchasable add-on with its availability class", () => {
    try {
      planAddonChange({ additions: [{ addonKey: "addon.ai_pack" }], removals: [] }, rows, null);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AddonUnavailableError);
      expect((err as AddonUnavailableError).availability).toBe("credential_gated");
    }
  });

  it("refuses a partial decrease of a held pack (period-end guidance — no immediate reduction)", () => {
    const held = [
      { addon_key: "addon.members_10", quantity: 3, status: "active", source: "individual" },
    ];
    expect(() =>
      planAddonChange(
        { additions: [{ addonKey: "addon.members_10", quantity: 1 }], removals: [] },
        held,
        null,
      ),
    ).toThrow(/decrease applies at period end/);
  });

  it("schedules removals to period end and captures the current quantity + source", () => {
    const held = [
      { addon_key: "addon.quotes_invoices", quantity: 1, status: "active", source: "individual" },
    ];
    const plan = planAddonChange(
      { additions: [], removals: ["addon.quotes_invoices"] },
      held,
      "2026-01-15T00:00:00.000Z",
    );
    expect(plan.removals).toHaveLength(1);
    expect(plan.removeAt).not.toBeNull();
  });
});

describe("classifySubscriptionError (PART C — safe codes)", () => {
  const cases: Array<[unknown, SubscriptionErrorCode]> = [
    [new ForbiddenError("billing.manage"), "authorization"],
    [new BillingReadOnlyError("suspended"), "read_only"],
    [new AddonUnavailableError("addon.ai_pack", "credential_gated"), "credential_gated"],
    [new AddonUnavailableError("addon.x", "d1_gated"), "d1_gated"],
    [new AddonUnavailableError("addon.x", "deferred"), "deferred"],
    [new AddonUnavailableError("addon.extra_org", "manual_process"), "unavailable_addon"],
    [new SubscriptionChangeError("stale_price_version", "sub_x", "moved"), "stale_price_version"],
    [new Error("could not serialize access due to concurrent update"), "network_retry"],
    [new Error("something unexpected"), "internal"],
  ];
  it("maps every known error onto its code and mints a correlation id", () => {
    for (const [err, code] of cases) {
      const c = classifySubscriptionError(err);
      expect(c.code, `${(err as Error).message}`).toBe(code);
      expect(c.correlationId).toMatch(/^sub_/);
    }
  });
  it("reuses the correlation id carried by an already-classified error", () => {
    const c = classifySubscriptionError(
      new SubscriptionChangeError("authorization", "sub_keepme", "x"),
    );
    expect(c.correlationId).toBe("sub_keepme");
  });
});

describe("currentPriceVersion (stale-price fingerprint)", () => {
  it("is deterministic and stable across calls", () => {
    expect(currentPriceVersion()).toBe(currentPriceVersion());
    expect(currentPriceVersion()).toMatch(/^pv_/);
  });
});

describe("tier member lists + savings recomputed from addons.ts", () => {
  it("Medium: 6 members summing $28 / AED 106, priced $15 / AED 55 (−46% / −48%)", () => {
    const tier = getTierBundle("medium")!;
    const usd = tier.addonKeys.reduce((s, k) => s + getAddon(k)!.usdMonthlyMinor, 0);
    const aed = tier.addonKeys.reduce((s, k) => s + getAddon(k)!.aedMonthlyMinor, 0);
    expect(tier.addonKeys.length).toBe(6);
    expect(usd).toBe(2800);
    expect(aed).toBe(10600);
    expect(tier.usdMonthlyMinor).toBe(1500);
    expect(Math.round((1 - tier.usdMonthlyMinor / usd) * 100)).toBe(46);
    expect(Math.round((1 - tier.aedMonthlyMinor / aed) * 100)).toBe(48);
    expect(bundleMemberTotalMinor(tier, "USD")).toBe(2800);
  });

  it("High: 19 members summing $75 / AED 282, priced $39 / AED 143 (−48% / −49%)", () => {
    const tier = getTierBundle("high")!;
    const usd = tier.addonKeys.reduce((s, k) => s + getAddon(k)!.usdMonthlyMinor, 0);
    const aed = tier.addonKeys.reduce((s, k) => s + getAddon(k)!.aedMonthlyMinor, 0);
    expect(tier.addonKeys.length).toBe(19);
    expect(usd).toBe(7500);
    expect(aed).toBe(28200);
    expect(tier.usdMonthlyMinor).toBe(3900);
    expect(Math.round((1 - tier.usdMonthlyMinor / usd) * 100)).toBe(48);
    expect(Math.round((1 - tier.aedMonthlyMinor / aed) * 100)).toBe(49);
  });

  it("High excludes manual/credential/d1/deferred add-ons (only operational members)", () => {
    const tier = getTierBundle("high")!;
    for (const k of tier.addonKeys) {
      expect(getAddon(k)!.availability).toBe("available");
    }
  });
});

describe("i18n: every governed error code + audit source has EN + AR copy", () => {
  const CODES: SubscriptionErrorCode[] = [
    "authorization",
    "read_only",
    "invalid_quantity",
    "unavailable_addon",
    "credential_gated",
    "d1_gated",
    "deferred",
    "unknown_addon",
    "not_active",
    "stale_price_version",
    "concurrent_change",
    "invalid_transition",
    "provider_unavailable",
    "network_retry",
    "internal",
  ];
  const enM = en as Record<string, string>;
  const arM = ar as Record<string, string>;
  it("error codes", () => {
    for (const c of CODES) {
      expect(enM[`subscription.error.${c}`], `EN ${c}`).toBeTruthy();
      expect(arM[`subscription.error.${c}`], `AR ${c}`).toBeTruthy();
    }
  });
  it("audit sources + statuses + the governed test notice", () => {
    for (const s of ["onboarding", "owner_action", "provider_event", "platform_override"]) {
      expect(enM[`subscription.audit.source.${s}`]).toBeTruthy();
      expect(arM[`subscription.audit.source.${s}`]).toBeTruthy();
    }
    expect(enM["subscription.governed_test_notice"]).toBeTruthy();
    expect(arM["subscription.governed_test_notice"]).toBeTruthy();
  });
});
