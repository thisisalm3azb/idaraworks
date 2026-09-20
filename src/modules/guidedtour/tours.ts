/**
 * The guided tour — what it asks a person to do, and who sees which tour.
 *
 * Pure by design: no database, no request, no React. Everything here is a
 * decision about content and eligibility, and decisions that can be made from
 * plain values are decisions a test can pin down exactly.
 *
 * ── Version 2: action-driven ─────────────────────────────────────────────────
 * Version 1 was a slideshow: a card per menu item, advanced with Next. People
 * read it and then still did not know where to tap. Version 2 asks for one
 * real interaction per step ("Tap Work"), highlights the control the person
 * must use, and advances only when the product confirms that it happened: the
 * route changed, or a click landed on the highlighted control. Nothing in a
 * tour creates, changes or sends anything; every step that opens a form stops
 * there, and every action step can be skipped.
 */
import type { Action } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";

/**
 * Bumped only when the content changes materially.
 *
 * Stored alongside each person's progress, so a rewrite never resets anybody's
 * history: somebody who finished or declined version 1 is left alone, and
 * somebody who was mid-way through version 1 starts version 2 from its first
 * step, because version-1 step numbers mean nothing here.
 */
export const TOUR_VERSION = 2;

/**
 * The cap, and the reason it is a constant rather than a comment.
 *
 * Seven is roughly where a tour stops being a welcome and starts being a
 * manual. A test asserts every tour against this, so a step added in a hurry
 * fails the build instead of quietly making the tour longer.
 */
export const MAX_STEPS = 7;

export const TOUR_KEYS = ["owner", "finance", "supply", "field"] as const;
export type TourKey = (typeof TOUR_KEYS)[number];

/**
 * How a step is confirmed done.
 *
 *   route — the pathname now matches this path under the organisation. The
 *           person tapped the control (or reached the screen another way,
 *           which counts just the same).
 *   click — a click or keyboard activation landed inside the highlighted
 *           control. For controls that open something in place: a menu, the
 *           mobile drawer.
 *   next  — a "look" step: the person reads it and presses Next. Used for the
 *           form a step points at without asking anybody to fill it in, and
 *           for the closing step.
 */
export type Advance = { kind: "route"; path: string } | { kind: "click" } | { kind: "next" };

export type TourStep = {
  /**
   * Stable identity. It is the translation key suffix and part of what is
   * stored in progress, so it must never be renamed casually.
   */
  key: string;
  /**
   * The `data-tour` value to highlight, or null for a centred step.
   *
   * Never a CSS path and never translated text: a selector built from element
   * positions breaks the first time somebody reorders the menu, and matching
   * on a label breaks in Arabic. These are attributes placed deliberately for
   * this purpose and for nothing else.
   */
  target: string | null;
  /** Omitted means everyone in the tour sees it. */
  requires?: Action;
  advance: Advance;
  /**
   * What to do when the control is not on this screen.
   *
   *   explain (default) — say so, and offer Skip and Exit. A missing control
   *                       is something the person deserves to hear about.
   *   skip              — move on silently. Reserved for controls that are a
   *                       platform difference rather than a problem: the
   *                       mobile "More" tab does not exist on a laptop.
   */
  whenAbsent?: "explain" | "skip";
};

const route = (path: string): Advance => ({ kind: "route", path });
const CLICK: Advance = { kind: "click" };
const NEXT: Advance = { kind: "next" };

/**
 * "Tap More": on a phone the rest of the menu is behind the More tab, so a step
 * that points into the drawer is preceded by this one. On a laptop the tab
 * does not exist and the step is skipped without comment.
 */
const MORE: TourStep = { key: "more", target: "nav:more", advance: CLICK, whenAbsent: "skip" };
/** The closing step. Every tour ends here: how to find this again. */
const HELP: TourStep = { key: "help", target: "account", advance: NEXT };

/**
 * The tours. Each one walks somebody with a particular job to the first thing
 * they would actually do here, and ends in the same place: how to find this
 * again. Nothing is created along the way.
 */
const TOURS: Record<TourKey, TourStep[]> = {
  /** Whoever set the company up, and whoever runs it with them. */
  owner: [
    { key: "work", target: "nav:jobs", requires: "jobs.view", advance: route("/jobs") },
    { key: "new_job", target: "jobs:new", requires: "jobs.create", advance: NEXT },
    MORE,
    {
      key: "customers",
      target: "nav:customers",
      requires: "customers.view",
      advance: route("/customers"),
    },
    { key: "create", target: "create", requires: "jobs.create", advance: CLICK },
    HELP,
  ],
  /** Money in, money out. */
  finance: [
    {
      key: "invoices",
      target: "nav:invoices",
      requires: "invoices.view",
      advance: route("/invoices"),
    },
    {
      key: "new_invoice",
      target: "invoices:new",
      requires: "invoices.manage",
      advance: route("/invoices/new"),
    },
    {
      key: "payments",
      target: "nav:payments",
      requires: "payments.view",
      advance: route("/payments"),
    },
    { key: "create", target: "create", requires: "invoices.manage", advance: CLICK },
    HELP,
  ],
  /** Buying, receiving and what is on the shelf. */
  supply: [
    {
      key: "requests",
      target: "nav:material_requests",
      requires: "mr.create",
      advance: route("/material-requests"),
    },
    {
      key: "orders",
      target: "nav:purchase_orders",
      requires: "po.view",
      advance: route("/purchase-orders"),
    },
    {
      key: "suppliers",
      target: "nav:suppliers",
      requires: "catalog.view",
      advance: route("/suppliers"),
    },
    { key: "create", target: "create", requires: "mr.create", advance: CLICK },
    HELP,
  ],
  /** The people on site, who mostly arrive on a phone. */
  field: [
    { key: "work", target: "nav:jobs", requires: "jobs.view", advance: route("/jobs") },
    {
      key: "report",
      target: "nav:report_new",
      requires: "reports.create",
      advance: route("/reports/new"),
    },
    { key: "issues", target: "nav:issues", requires: "issues.raise", advance: route("/issues") },
    MORE,
    { key: "week", target: "nav:week", requires: "week.view", advance: route("/week") },
    HELP,
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
 * asking somebody to tap a control they would be refused is worse than no
 * step at all.
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
 * Where a person resumes, given what is stored for them.
 *
 * A position recorded against another version of the tour is meaningless
 * here (the steps are different), so it restarts at the beginning. A finished
 * or declined tour never resumes at all; see `shouldAutoStart`.
 */
export function resumeIndex(state: { stepIndex: number; tourVersion: number }): number {
  if (state.tourVersion !== TOUR_VERSION) return 0;
  return Math.max(0, Math.trunc(state.stepIndex));
}

/**
 * ── Who gets greeted automatically ──────────────────────────────────────────
 *
 * The rule: only somebody whose membership in this organisation began at or
 * after this instant is greeted without being asked. Everybody else can start
 * the tour whenever they like from the account menu, and is never interrupted.
 *
 * A fixed timestamp rather than "has no progress row", because on the day this
 * shipped nobody had a progress row — that rule would have greeted every
 * existing user at once, which is precisely the interruption the mandate
 * forbids. It is also not "joined within the last N days", because that
 * quietly changes who is eligible every time the flag is toggled.
 *
 * Version 2 deliberately keeps the version-1 date: a rewrite of the content is
 * not a reason to interrupt people who declined the first one.
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

export { routeSatisfied } from "@/lib/route-match";
