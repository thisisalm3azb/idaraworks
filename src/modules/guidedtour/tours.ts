/**
 * H32 — what the tour actually says, and who sees which one.
 *
 * Pure by design: no database, no request, no React. Everything here is a
 * decision about content and eligibility, and decisions that can be made from
 * plain values are decisions a test can pin down exactly.
 *
 * ── The shape of the promise ────────────────────────────────────────────────
 * Short, optional and relevant. A tour that runs long is closed; a tour that
 * shows a warehouse foreman the tax settings teaches them that this product
 * does not know who they are. So the steps are chosen per role, filtered again
 * by what the person may actually do, and hard-capped.
 */
import type { Action } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";

/**
 * Bumped only when the content changes materially.
 *
 * Stored alongside each person's progress, so a future rewrite can be offered
 * to people who finished version 1 without resetting anybody's history — and so
 * "completed" always answers "completed what".
 */
export const TOUR_VERSION = 1;

/**
 * The cap, and the reason it is a constant rather than a comment.
 *
 * Seven is the mandate's ceiling and roughly where a tour stops being a welcome
 * and starts being a manual. A test asserts every tour against this, so a step
 * added in a hurry fails the build instead of quietly making the tour longer.
 */
export const MAX_STEPS = 7;

export const TOUR_KEYS = ["owner", "finance", "supply", "field"] as const;
export type TourKey = (typeof TOUR_KEYS)[number];

export type TourStep = {
  /**
   * Stable identity. It is the translation key suffix and the value stored in
   * progress, so it must never be renamed casually — and it is deliberately not
   * derived from the target, because where a step points may change while what
   * it says does not.
   */
  key: string;
  /**
   * The `data-tour` value to anchor to, or null for a centred step.
   *
   * Never a CSS path and never translated text: a selector built from element
   * positions breaks the first time somebody reorders the menu, and matching on
   * a label breaks in Arabic. These are attributes placed deliberately for this
   * purpose and for nothing else.
   */
  target: string | null;
  /** Omitted means everyone in the tour sees it. */
  requires?: Action;
};

/**
 * The tours.
 *
 * Each one is a path through the product for somebody with a particular job,
 * ending in the same place: how to find this again. That last step matters more
 * than any of the others — a person who skips the tour on day one and wants it
 * on day three should not have to ask anybody.
 */
const TOURS: Record<TourKey, TourStep[]> = {
  /** Whoever set the company up, and whoever runs it with them. */
  owner: [
    { key: "home", target: "brand" },
    { key: "create", target: "create" },
    { key: "customers", target: "nav:customers", requires: "customers.view" },
    { key: "jobs", target: "nav:jobs", requires: "jobs.view" },
    { key: "invoices", target: "nav:invoices", requires: "invoices.view" },
    { key: "team", target: "nav:members", requires: "members.view" },
    { key: "help", target: "account" },
  ],
  /** Money in, money out. */
  finance: [
    { key: "home", target: "brand" },
    { key: "quotes", target: "nav:quotes", requires: "quotes.view" },
    { key: "invoices", target: "nav:invoices", requires: "invoices.view" },
    { key: "payments", target: "nav:payments", requires: "invoices.view" },
    { key: "expenses", target: "nav:expenses", requires: "expenses.view" },
    { key: "help", target: "account" },
  ],
  /** Buying, receiving and what is on the shelf. */
  supply: [
    { key: "home", target: "brand" },
    { key: "requests", target: "nav:material_requests" },
    { key: "orders", target: "nav:purchase_orders" },
    { key: "items", target: "nav:items" },
    { key: "suppliers", target: "nav:suppliers" },
    { key: "help", target: "account" },
  ],
  /** The people on site, who mostly arrive on a phone. */
  field: [
    { key: "home", target: "brand" },
    { key: "work", target: "nav:my_work" },
    { key: "report", target: "nav:report_new", requires: "reports.create" },
    { key: "attendance", target: "nav:attendance" },
    { key: "issues", target: "nav:issues" },
    { key: "help", target: "account" },
  ],
};

/**
 * Which tour a role gets.
 *
 * Exhaustive over the archetypes rather than a lookup with a default, so adding
 * a role to the platform forces a decision here instead of silently landing
 * everybody in the owner's tour.
 */
const TOUR_FOR_ROLE: Record<RoleArchetype, TourKey> = {
  owner: "owner",
  admin: "owner",
  manager: "owner",
  accounts: "finance",
  procurement: "supply",
  foreman: "field",
  // Reserved for a future individual-worker role. It gets the field tour rather
  // than no tour, so that whenever the role is switched on its holders are
  // greeted like everybody else instead of silently receiving nothing.
  worker_reserved_p3: "field",
  // A viewer can look but not act. The field tour is the closest fit and its
  // steps are permission-filtered below, so they are shown only what they can
  // actually open.
  viewer: "field",
};

export function tourKeyForRole(archetype: RoleArchetype): TourKey {
  return TOUR_FOR_ROLE[archetype];
}

/**
 * The steps one particular person should see.
 *
 * `can` is passed in rather than imported so this stays pure and a test can
 * drive it directly. The filter is the second gate: the role picks a tour, and
 * permission decides which of its steps are real for this person. A step
 * pointing at a screen they would be refused is worse than no step at all.
 */
export function stepsFor(
  archetype: RoleArchetype,
  can: (action: Action) => boolean,
): { tourKey: TourKey; steps: TourStep[] } {
  const tourKey = tourKeyForRole(archetype);
  const steps = TOURS[tourKey].filter((s) => s.requires === undefined || can(s.requires));
  return { tourKey, steps: steps.slice(0, MAX_STEPS) };
}

/** Every tour, for the tests and the translation-parity check. */
export function allTours(): Array<{ key: TourKey; steps: TourStep[] }> {
  return TOUR_KEYS.map((key) => ({ key, steps: TOURS[key] }));
}

/**
 * ── Who gets greeted automatically ──────────────────────────────────────────
 *
 * The rule: only somebody whose membership in this organisation began at or
 * after this instant is greeted without being asked. Everybody else can start
 * the tour whenever they like from the account menu, and is never interrupted.
 *
 * A fixed timestamp rather than "has no progress row", because on the day this
 * ships nobody has a progress row — that rule would greet every existing user
 * at once, which is precisely the interruption the mandate forbids. It is also
 * not "joined within the last N days", because that quietly changes who is
 * eligible every time the flag is toggled.
 *
 * This is the H32 release date: a membership created before it predates the
 * feature, and its owner is by definition not a first-time user.
 */
export const AUTO_START_FROM = new Date("2026-09-05T00:00:00Z");

export type AutoStartInput = {
  memberSince: Date | null;
  status: string;
  tourKey: TourKey;
  storedTourKey: string | null;
};

/**
 * Should this person be greeted on arrival?
 *
 * Note what is NOT here: no check on how much data the organisation holds, and
 * no guess at whether they look like they need help. Inferring competence is
 * how a welcome becomes patronising.
 */
export function shouldAutoStart(input: AutoStartInput): boolean {
  if (input.status === "completed" || input.status === "skipped") {
    // Settled — with one exception. Somebody who has changed job here and would
    // now get a different tour has not seen the one that is relevant to them.
    return input.storedTourKey !== null && input.storedTourKey !== input.tourKey;
  }
  // Started and not finished: pick up where they left off, on any device.
  if (input.status === "in_progress" || input.status === "welcomed") return true;
  if (input.memberSince === null) return false;
  return input.memberSince.getTime() >= AUTO_START_FROM.getTime();
}
