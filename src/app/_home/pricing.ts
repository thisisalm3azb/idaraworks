/**
 * Homepage pricing — the ONE typed source of pricing content (005A).
 *
 * Numeric prices exist in the entitlements catalogue but are flagged
 * `is_placeholder` (owner-unratified — see migration 0071 / addons.ts), so
 * they are NOT public launch prices and must not be shown. This config takes
 * the REAL tier identities from the catalogue (getTierBundle) and presents
 * truthful non-numeric positioning; the price line reads "launch pricing is
 * being finalized". Every tier's only action is Get Started — there is no
 * contact/sales destination in the app, so no dead button is created.
 */
import { getTierBundle } from "@/platform/entitlements";

export type PricingTier = {
  key: "free" | "medium" | "high";
  /** Canonical names — the two paid tiers come straight from the catalogue. */
  names: { en: string; ar: string };
  /** i18n key for the one-line positioning under the name. */
  tagKey: string;
  /** i18n keys for the outcome bullets (outcomes, not an entitlement matrix). */
  outcomeKeys: string[];
  /** i18n key for a small truthful badge, or null. */
  badgeKey: string | null;
  featured: boolean;
};

/**
 * Build the tier list. `medium`/`high` names are read from the catalogue so
 * the homepage can never drift from the real product tiers; "Free" is the
 * base plan (PLAN_KEYS includes "free"). Throws if the catalogue tiers are
 * missing — a loud signal that the source of truth moved.
 */
export function pricingTiers(): PricingTier[] {
  const medium = getTierBundle("medium");
  const high = getTierBundle("high");
  if (!medium || !high) throw new Error("pricing: tier bundles missing from the catalogue");
  return [
    {
      key: "free",
      names: { en: "Free", ar: "مجاني" },
      tagKey: "home.pricing.free.tag",
      outcomeKeys: ["home.pricing.free.o1", "home.pricing.free.o2", "home.pricing.free.o3"],
      badgeKey: null,
      featured: false,
    },
    {
      key: "medium",
      names: medium.names,
      tagKey: "home.pricing.medium.tag",
      outcomeKeys: ["home.pricing.medium.o1", "home.pricing.medium.o2", "home.pricing.medium.o3"],
      badgeKey: "home.pricing.medium.badge",
      featured: true,
    },
    {
      key: "high",
      names: high.names,
      tagKey: "home.pricing.high.tag",
      outcomeKeys: ["home.pricing.high.o1", "home.pricing.high.o2", "home.pricing.high.o3"],
      badgeKey: null,
      featured: false,
    },
  ];
}
