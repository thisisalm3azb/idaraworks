/**
 * Homepage pricing — the ONE typed source of pricing content (005A, H9.1).
 *
 * MARKETING-SAFE by construction: this module is consumed only by the public
 * homepage and its tests. Live billing math reads the entitlement price book
 * (platform/entitlements/addons.ts, still is_placeholder and owner-ratified
 * separately); nothing here feeds subscription creation, and the payment
 * provider remains disabled (D1). The prices below are the APPROVED PUBLIC
 * LAUNCH TARGETS from docs/product/PRICING_STRATEGY_2026.md, presented with
 * the honest early-access framing ("free while billing is being prepared").
 *
 * Identity mapping (documented, deliberate): internal tier identifiers stay
 * `free` / `medium` / `high` everywhere (database, entitlements, history).
 * The PUBLIC labels are Free / Operations / Complete. getTierBundle still
 * anchors the mapping so the homepage can never drift from real tiers.
 *
 * Seat truth: the real entitlements are 3 office users on Free
 * (FREE_PLAN_LIMITS) and 3 + 10 = 13 office users on both paid tiers (each
 * tier bundle includes addon.members_10); field-app users are unlimited on
 * every plan by product law. The interface shows those real numbers; the
 * originally requested 1/5/10 packaging was superseded (see the strategy
 * document's seat-limit decision).
 */
import { getTierBundle } from "@/platform/entitlements";

export type PlanPrice = {
  /** Whole-dollar USD amounts (0 for the free plan). */
  monthlyUsd: number;
  annualPerMonthUsd: number;
  annualBilledUsd: number;
};

export type PricingTier = {
  key: "free" | "medium" | "high";
  /** PUBLIC plan labels (H9.1): Free / Operations / Complete. */
  names: { en: string; ar: string; es: string };
  price: PlanPrice;
  /** i18n key for the one-line intended-customer positioning. */
  tagKey: string;
  /** i18n key for the included-users line (real entitlement numbers). */
  usersKey: string;
  /** i18n keys for the outcome bullets (verified against entitlements). */
  outcomeKeys: string[];
  /** i18n key for the small under-CTA microcopy. */
  microKey: string;
  /** i18n key for a small truthful badge, or null. */
  badgeKey: string | null;
  featured: boolean;
};

/** Annual saving communicated publicly: 20% (372/468 and 852/1068). */
export const ANNUAL_SAVE_PERCENT = 20;

/**
 * Build the tier list. The two paid tiers must still exist in the real
 * entitlement catalogue (getTierBundle) — the internal identity check; the
 * public display labels are the H9.1 launch names.
 */
export function pricingTiers(): PricingTier[] {
  if (!getTierBundle("medium") || !getTierBundle("high")) {
    throw new Error("pricing: tier bundles missing from the catalogue");
  }
  return [
    {
      key: "free",
      names: { en: "Free", ar: "مجاني", es: "Gratuito" },
      price: { monthlyUsd: 0, annualPerMonthUsd: 0, annualBilledUsd: 0 },
      tagKey: "home.pricing.free.tag",
      usersKey: "home.pricing.free.users",
      outcomeKeys: ["home.pricing.free.o1", "home.pricing.free.o2", "home.pricing.free.o3"],
      microKey: "home.pricing.free.micro",
      badgeKey: null,
      featured: false,
    },
    {
      key: "medium",
      names: { en: "Operations", ar: "العمليات", es: "Operaciones" },
      price: { monthlyUsd: 39, annualPerMonthUsd: 31, annualBilledUsd: 372 },
      tagKey: "home.pricing.medium.tag",
      usersKey: "home.pricing.paid.users",
      outcomeKeys: ["home.pricing.medium.o1", "home.pricing.medium.o2", "home.pricing.medium.o3"],
      microKey: "home.pricing.paid.micro",
      badgeKey: "home.pricing.medium.badge",
      featured: true,
    },
    {
      key: "high",
      names: { en: "Complete", ar: "المتكاملة", es: "Completa" },
      price: { monthlyUsd: 89, annualPerMonthUsd: 71, annualBilledUsd: 852 },
      tagKey: "home.pricing.high.tag",
      usersKey: "home.pricing.paid.users",
      outcomeKeys: [
        "home.pricing.high.o1",
        "home.pricing.high.o2",
        "home.pricing.high.o3",
        "home.pricing.high.o4",
      ],
      microKey: "home.pricing.paid.micro",
      badgeKey: null,
      featured: false,
    },
  ];
}
