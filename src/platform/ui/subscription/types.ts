/**
 * View-model types for the subscription-selection components (U3 four-path
 * model). The shapes are assembled by src/modules/subscription/selection.ts
 * (buildSelectionView) from the code catalogue; they live HERE so the
 * pure-presentational components never import a module (BUILD_BIBLE §3.3 —
 * platform never imports modules; the module imports these types instead).
 */
import type { AddonDef } from "@/platform/entitlements";

export type SelectionCurrency = "USD" | "AED";

export type SelectionTier = {
  bundleKey: string;
  tier: "medium" | "high";
  names: { en: string; ar: string };
  description: { en: string; ar: string };
  members: AddonDef[];
  priceMonthlyMinor: Record<SelectionCurrency, number>;
  memberTotalMinor: Record<SelectionCurrency, number>;
  /** Rounded % saved vs buying the members individually (per currency). */
  savingPct: Record<SelectionCurrency, number>;
};

export type SelectionCustomGroup = {
  /** i18n suffix — rendered as t(`subscription.group.${key}`). */
  key: "seats" | "money" | "purchasing" | "costing" | "data" | "support" | "gated";
  items: Array<{
    addon: AddonDef;
    /** available | manual_process — gated items are shown but never selectable. */
    selectable: boolean;
  }>;
};

export type SelectionView = {
  free: {
    priceMonthlyMinor: Record<SelectionCurrency, 0>;
    limits: {
      officeSeats: number;
      viewerSeats: number;
      /** null = unlimited (field seats are free by product law). */
      fieldSeats: number | null;
      activeJobs: number;
      storageGb: number;
    };
  };
  medium: SelectionTier;
  high: SelectionTier;
  custom: { groups: SelectionCustomGroup[] };
};

/** A translator already bound to the request locale (getT()). */
export type SelectionTranslator = (key: string, vars?: Record<string, string | number>) => string;
