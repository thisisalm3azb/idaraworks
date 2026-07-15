/**
 * Subscription-selection UI (U3 four-path model). A SEPARATE barrel from
 * "@/platform/ui": LockedFeature is server-only (i18n/server, entitlement
 * resolution) and must never be pulled into a client bundle through the main
 * primitives barrel.
 */
export { TierCards, type TierCardsProps } from "./TierCards";
export {
  CustomBuilder,
  type CustomBuilderProps,
  type CustomBuilderGroup,
  type CustomBuilderItem,
} from "./CustomBuilder";
export { SubscriptionSelector, type SubscriptionSelectorProps } from "./SubscriptionSelector";
export { buildChangeReview, type ChangeReview, type ReviewItem, type ReviewDelta } from "./review";
export { LockedFeature, lockedFeatureGate, type LockedFeatureProps } from "./LockedFeature";
export type {
  SelectionCurrency,
  SelectionCustomGroup,
  SelectionTier,
  SelectionTranslator,
  SelectionView,
} from "./types";
