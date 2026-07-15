/**
 * Subscription SELECTION view (U3 four-path model): Free / Medium / High /
 * Custom, assembled from the REAL catalogue (entitlements/{catalogue,addons}.ts
 * — the same code registries the migrations seed and the resolver enforces).
 *
 * PURE — no DB, no ctx: unit-testable and embeddable anywhere (the settings
 * page today; the wave-2 onboarding flow calls buildSelectionView() and records
 * the choice through the SAME changeAddons bundle path — see
 * docs/ux/SUBSCRIPTION_SELECTION_FLOW.md for the contract).
 *
 * HONESTY RULES carried through the view:
 *  - deferred add-ons are EXCLUDED entirely (never shown as an option);
 *  - credential_gated / d1_gated items appear flagged non-selectable WITH the
 *    honest reason (availabilityNote);
 *  - tier prices always ship next to the individual member total (the saving
 *    is shown, never asserted);
 *  - prices are indicative placeholders, tax-exclusive — no payment is
 *    collected while the provider is disabled (D1).
 */
import {
  ADDONS,
  BUNDLES,
  getAddon,
  getBundle,
  isPurchasable,
  bundleMemberTotalMinor,
  FREE_PLAN_LIMITS,
  type AddonDef,
  type BundleDef,
} from "@/platform/entitlements";
import type {
  SelectionCurrency,
  SelectionCustomGroup,
  SelectionTier,
  SelectionView,
} from "@/platform/ui/subscription/types";

export type {
  SelectionCurrency,
  SelectionCustomGroup,
  SelectionTier,
  SelectionView,
} from "@/platform/ui/subscription/types";

function toTier(bundle: BundleDef): SelectionTier {
  const members = bundle.addonKeys
    .map((k) => getAddon(k))
    .filter((a): a is AddonDef => a !== undefined);
  const memberTotal = {
    USD: bundleMemberTotalMinor(bundle, "USD"),
    AED: bundleMemberTotalMinor(bundle, "AED"),
  };
  const price = { USD: bundle.usdMonthlyMinor, AED: bundle.aedMonthlyMinor };
  const pct = (c: SelectionCurrency) =>
    memberTotal[c] > 0 ? Math.round((1 - price[c] / memberTotal[c]) * 100) : 0;
  return {
    bundleKey: bundle.key,
    tier: bundle.tier!,
    names: bundle.names,
    description: bundle.description,
    members,
    priceMonthlyMinor: price,
    memberTotalMinor: memberTotal,
    savingPct: { USD: pct("USD"), AED: pct("AED") },
  };
}

/** Same display grouping as the settings catalogue (sort bands + honesty class). */
function customGroupOf(a: AddonDef): SelectionCustomGroup["key"] {
  if (a.availability === "credential_gated" || a.availability === "d1_gated") return "gated";
  if (a.sort <= 30) return "seats";
  if (a.sort <= 60) return "money";
  if (a.sort <= 110) return "purchasing";
  if (a.sort <= 160) return "costing";
  if (a.sort <= 210) return "data";
  return "support";
}

const GROUP_ORDER: SelectionCustomGroup["key"][] = [
  "seats",
  "money",
  "purchasing",
  "costing",
  "data",
  "support",
  "gated",
];

/** Assemble the four paths from the code catalogue. Throws if a tier bundle is
 * missing — the catalogue and this view must never drift silently. */
export function buildSelectionView(): SelectionView {
  const medium = BUNDLES.find((b) => b.tier === "medium");
  const high = BUNDLES.find((b) => b.tier === "high");
  if (!medium || !high) throw new Error("tier bundles missing from the BUNDLES catalogue");

  const groups = new Map<SelectionCustomGroup["key"], SelectionCustomGroup["items"]>();
  for (const a of [...ADDONS].sort((x, y) => x.sort - y.sort)) {
    if (a.availability === "deferred") continue; // honesty: never shown as an option
    const g = customGroupOf(a);
    groups.set(g, [...(groups.get(g) ?? []), { addon: a, selectable: isPurchasable(a) }]);
  }

  return {
    free: {
      priceMonthlyMinor: { USD: 0, AED: 0 },
      limits: {
        officeSeats: FREE_PLAN_LIMITS["limit.full_users"] ?? 0,
        viewerSeats: FREE_PLAN_LIMITS["limit.viewer_users"] ?? 0,
        fieldSeats: FREE_PLAN_LIMITS["limit.field_users"],
        activeJobs: FREE_PLAN_LIMITS["limit.active_jobs"] ?? 0,
        storageGb: FREE_PLAN_LIMITS["limit.storage_gb"] ?? 0,
      },
    },
    medium: toTier(medium),
    high: toTier(high),
    custom: {
      groups: GROUP_ORDER.flatMap((key) => {
        const items = groups.get(key);
        return items && items.length > 0 ? [{ key, items }] : [];
      }),
    },
  };
}

export type OrgAddonStateRow = {
  addon_key: string;
  quantity: number;
  status: string;
  source: string;
};

/**
 * The org's CURRENT monthly total from its org_addon rows: bundle-sourced rows
 * charge the BUNDLE price ONCE (that is what the org pays — never the
 * undiscounted member sum; an individual row superseded by a bundle no longer
 * exists, so overlap counts once by construction); individual rows charge the
 * add-on price × quantity. Shared by the settings page and the selection tests.
 */
export function computeMonthlyTotalMinor(
  rows: readonly OrgAddonStateRow[],
  currency: SelectionCurrency,
): number {
  const countedBundles = new Set<string>();
  let total = 0;
  for (const row of rows) {
    const bundle = row.source !== "individual" ? getBundle(row.source) : undefined;
    if (bundle) {
      if (!countedBundles.has(bundle.key)) {
        countedBundles.add(bundle.key);
        total += currency === "USD" ? bundle.usdMonthlyMinor : bundle.aedMonthlyMinor;
      }
      continue;
    }
    const def = getAddon(row.addon_key);
    if (def) {
      const unit = currency === "USD" ? def.usdMonthlyMinor : def.aedMonthlyMinor;
      total += unit * Math.max(1, Number(row.quantity) || 1);
    }
  }
  return total;
}

/**
 * Display mapping ONLY (existing-org safety): which selection label describes
 * the org's current add-on state. Never converts anything — an org shows as a
 * tier exactly when tier-bundle-sourced rows are live; anything else with live
 * add-ons is "custom"; no add-ons = the plan base (Free for free-plan orgs).
 */
export function currentSelectionLabel(
  rows: readonly OrgAddonStateRow[],
): "medium" | "high" | "custom" | null {
  const live = rows.filter((r) => r.status === "active" || r.status === "removal_scheduled");
  if (live.some((r) => r.source === "bundle.tier_high")) return "high";
  if (live.some((r) => r.source === "bundle.tier_medium")) return "medium";
  return live.length > 0 ? "custom" : null;
}
