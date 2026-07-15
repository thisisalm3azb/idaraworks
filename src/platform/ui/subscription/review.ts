/**
 * PURE change-review maths for the subscription-selection surfaces (U3 / PART B).
 * Lives in the platform UI layer (no module import — the client CustomBuilder and
 * the settings page both use it; unit-tested in isolation) so the "current vs new"
 * review a user confirms is computed one way, everywhere.
 *
 * A review compares the org's CURRENT individually-selected add-on quantities to
 * the DESIRED set the builder produced, and classifies every delta:
 *   - added / increased  → applies IMMEDIATELY (an upgrade)
 *   - removed / decreased → SCHEDULED to period end (never deletes data)
 * plus the current vs new monthly total and the difference. All money is minor
 * units, tax-exclusive (the surface labels it).
 */
export type ReviewItem = {
  key: string;
  name: string;
  /** Monthly price in minor units for the display currency. */
  priceMonthlyMinor: number;
  stackable: boolean;
};

export type ReviewDelta = {
  key: string;
  name: string;
  from: number;
  to: number;
  /** Monthly minor-unit price impact of this line (to−from) × unit price. */
  deltaMinor: number;
};

export type ChangeReview = {
  added: ReviewDelta[]; // new keys (from 0)
  increased: ReviewDelta[]; // higher quantity on a held stackable pack
  removed: ReviewDelta[]; // dropped to 0
  decreased: ReviewDelta[]; // lower quantity on a held pack
  currentTotalMinor: number;
  newTotalMinor: number;
  diffMinor: number; // newTotal − currentTotal (can be negative)
  /** True when anything applies immediately (an addition or increase). */
  hasImmediate: boolean;
  /** True when anything is scheduled to period end (a removal or decrease). */
  hasScheduled: boolean;
  /** True when nothing actually changed (idempotent submit / no-op). */
  isNoop: boolean;
};

const qtyOf = (m: Record<string, number>, key: string): number => Math.max(0, m[key] ?? 0);

/**
 * Compute the review from `current` → `desired` over the given catalogue `items`.
 * Only keys present in `items` are considered (unknown keys are ignored — the
 * builder never emits them). Non-stackable items are 0/1.
 */
export function buildChangeReview(
  items: readonly ReviewItem[],
  current: Record<string, number>,
  desired: Record<string, number>,
): ChangeReview {
  const added: ReviewDelta[] = [];
  const increased: ReviewDelta[] = [];
  const removed: ReviewDelta[] = [];
  const decreased: ReviewDelta[] = [];
  let currentTotalMinor = 0;
  let newTotalMinor = 0;

  for (const item of items) {
    const from = item.stackable ? qtyOf(current, item.key) : qtyOf(current, item.key) > 0 ? 1 : 0;
    const to = item.stackable ? qtyOf(desired, item.key) : qtyOf(desired, item.key) > 0 ? 1 : 0;
    currentTotalMinor += item.priceMonthlyMinor * from;
    newTotalMinor += item.priceMonthlyMinor * to;
    if (to === from) continue;
    const delta: ReviewDelta = {
      key: item.key,
      name: item.name,
      from,
      to,
      deltaMinor: item.priceMonthlyMinor * (to - from),
    };
    if (from === 0) added.push(delta);
    else if (to === 0) removed.push(delta);
    else if (to > from) increased.push(delta);
    else decreased.push(delta);
  }

  const hasImmediate = added.length > 0 || increased.length > 0;
  const hasScheduled = removed.length > 0 || decreased.length > 0;
  return {
    added,
    increased,
    removed,
    decreased,
    currentTotalMinor,
    newTotalMinor,
    diffMinor: newTotalMinor - currentTotalMinor,
    hasImmediate,
    hasScheduled,
    isNoop: !hasImmediate && !hasScheduled,
  };
}
