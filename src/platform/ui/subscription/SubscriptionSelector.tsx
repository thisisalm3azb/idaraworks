"use client";
/**
 * <SubscriptionSelector> — the single client orchestrator for the four-path
 * selection (U3 V2), used by BOTH the onboarding plan step and the settings
 * subscription page. It shows the tier comparison (<TierCards>) and, when the
 * Custom card is chosen, REPLACES the comparison in-page with the <CustomBuilder>
 * panel — no page navigation, no long list dumped below the grid. A "back to
 * comparison" action returns. The transient compare↔custom panel is client state;
 * the actual SELECTION persists server-side (the onboarding draft; the org's real
 * state), so back/forward/refresh restore it.
 *
 * Everything it needs is serializable (the SelectionView data + bound server
 * actions); it imports the client-usable t() and builds a request-locale
 * translator, so no labels bag is threaded from the server.
 */
import { useState } from "react";
import { t as translate } from "@/platform/i18n/t";
import { TierCards } from "./TierCards";
import { CustomBuilder, type CustomBuilderGroup } from "./CustomBuilder";
import type { Locale } from "@/platform/registries";
import type { SelectionCurrency, SelectionView } from "./types";

export type SubscriptionSelectorProps = {
  view: SelectionView;
  locale: Locale;
  currency: SelectionCurrency;
  jobsNoun: string;
  current: "free" | "medium" | "high" | "custom" | null;
  canManage: boolean;
  providerEnabled: boolean;
  selectTierAction?: (formData: FormData) => Promise<void>;
  selectFreeAction?: (formData: FormData) => Promise<void>;
  customAction?: (formData: FormData) => Promise<void>;
  /** Two-step inline confirm before posting a tier (settings). */
  confirmSelect?: boolean;
  /** Show the change-review step before the custom submit (settings management). */
  reviewBeforeSubmit?: boolean;
  /** Pre-selected custom quantities (draft, or the org's individual add-ons). */
  initialCustomQuantities?: Record<string, number>;
  /** Add-on keys already provided by an active bundle — shown "included, no extra charge". */
  bundleIncludedKeys?: string[];
  /** Extra hidden fields posted with the custom form (e.g. priceVersion). */
  hiddenFields?: Record<string, string>;
  /** Override the custom submit label. */
  customSubmitLabel?: string;
  /** Open straight into the builder (LockedFeature deep link / current=custom). */
  initialPanel?: "compare" | "custom";
  /** Focus this add-on when the builder opens (deep link). */
  highlightKey?: string;
};

export function SubscriptionSelector({
  view,
  locale,
  currency,
  jobsNoun,
  current,
  canManage,
  providerEnabled,
  selectTierAction,
  selectFreeAction,
  customAction,
  confirmSelect,
  reviewBeforeSubmit,
  initialCustomQuantities,
  bundleIncludedKeys,
  hiddenFields,
  customSubmitLabel,
  initialPanel,
  highlightKey,
}: SubscriptionSelectorProps) {
  const [panel, setPanel] = useState<"compare" | "custom">(initialPanel ?? "compare");

  const included = new Set(bundleIncludedKeys ?? []);
  const groups: CustomBuilderGroup[] = view.custom.groups.map((g) => ({
    key: g.key,
    label: translateGroup(g.key, locale),
    items: g.items.map((i) => ({
      key: i.addon.key,
      name: i.addon.names[locale],
      description: i.addon.description[locale],
      priceMonthlyMinor: currency === "AED" ? i.addon.aedMonthlyMinor : i.addon.usdMonthlyMinor,
      stackable: i.addon.stackable,
      selectable: i.selectable && !included.has(i.addon.key),
      availabilityClass: i.addon.availability as
        "available" | "manual_process" | "credential_gated" | "d1_gated",
      bundleIncluded: included.has(i.addon.key),
      ...(i.addon.availabilityNote ? { note: i.addon.availabilityNote[locale] } : {}),
    })),
  }));

  if (panel === "custom") {
    return (
      <CustomBuilder
        groups={groups}
        currency={currency}
        locale={locale}
        initial={initialCustomQuantities}
        action={customAction}
        onBack={() => setPanel("compare")}
        reviewBeforeSubmit={reviewBeforeSubmit}
        hiddenFields={hiddenFields}
        submitLabel={customSubmitLabel}
        highlightKey={highlightKey}
      />
    );
  }

  return (
    <TierCards
      view={view}
      locale={locale}
      currency={currency}
      jobsNoun={jobsNoun}
      current={current}
      selectTierAction={selectTierAction}
      selectFreeAction={selectFreeAction}
      confirmSelect={confirmSelect}
      priceVersion={hiddenFields?.priceVersion}
      onOpenCustom={customAction ? () => setPanel("custom") : undefined}
      canManage={canManage}
      providerEnabled={providerEnabled}
    />
  );
}

/** i18n group labels resolved client-side (the pure t() is client-usable). */
function translateGroup(key: string, locale: Locale): string {
  return translate(`subscription.group.${key}`, undefined, locale);
}
