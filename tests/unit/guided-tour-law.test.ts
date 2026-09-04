/**
 * H32 — the laws the guided tour has to keep.
 *
 * Three of these exist because the mandate names them as promises to customers
 * rather than as implementation details: the tour is SHORT, it is RELEVANT to
 * the person seeing it, and it never interrupts somebody who has been working
 * here for months. Each of those is a sentence in a document until a test makes
 * it a property of the code.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLE_ARCHETYPES, type RoleArchetype } from "@/platform/registries";
import { can, type Action } from "@/platform/authz";
import {
  AUTO_START_FROM,
  MAX_STEPS,
  TOUR_KEYS,
  allTours,
  shouldAutoStart,
  stepsFor,
  tourKeyForRole,
} from "@/modules/guidedtour/tours";

const en = JSON.parse(readFileSync("src/platform/i18n/messages/en.json", "utf8")) as Record<
  string,
  string
>;

describe("the tour stays short", () => {
  it("no tour exceeds the cap", () => {
    for (const { key, steps } of allTours()) {
      expect(steps.length, `tour ${key}`).toBeLessThanOrEqual(MAX_STEPS);
    }
  });

  it("no tour is so short it is not worth showing", () => {
    // The mandate's range is five to seven. Fewer than four steps for a role
    // with full permissions means the tour has quietly been gutted.
    for (const { key, steps } of allTours()) {
      expect(steps.length, `tour ${key}`).toBeGreaterThanOrEqual(4);
    }
  });

  it("every step is distinct within its tour", () => {
    for (const { key, steps } of allTours()) {
      const keys = steps.map((s) => s.key);
      expect(new Set(keys).size, `tour ${key} has a duplicate step`).toBe(keys.length);
    }
  });
});

describe("the tour is relevant to the person seeing it", () => {
  it("every role archetype maps to a tour", () => {
    // Not a formality: a role with no mapping would land its holders in the
    // owner's tour, which is how a storekeeper ends up being shown the invoices.
    for (const a of ROLE_ARCHETYPES) {
      expect(TOUR_KEYS, `archetype ${a}`).toContain(tourKeyForRole(a as RoleArchetype));
    }
  });

  it("never shows a step the person would be refused", () => {
    for (const a of ROLE_ARCHETYPES) {
      const archetype = a as RoleArchetype;
      const { steps } = stepsFor(archetype, (act) => can(archetype, act));
      for (const s of steps) {
        if (s.requires) {
          expect(can(archetype, s.requires), `${a} shown ${s.key} without ${s.requires}`).toBe(
            true,
          );
        }
      }
    }
  });

  it("a viewer's tour is trimmed but still exists", () => {
    // The viewer is the sharpest case: read-only, so the permission filter bites
    // hardest. They must still get something rather than an empty overlay.
    const { steps } = stepsFor("viewer", (act) => can("viewer", act));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some((s) => s.key === "report")).toBe(false); // cannot file one
  });

  it("the last step of every tour explains how to find it again", () => {
    // A person who skips on day one and wants it on day three must not have to
    // ask a colleague. This is the step that makes the whole thing optional.
    for (const { key, steps } of allTours()) {
      expect(steps.at(-1)?.key, `tour ${key}`).toBe("help");
      expect(steps.at(-1)?.target, `tour ${key}`).toBe("account");
    }
  });

  it("permission filtering never reorders or invents steps", () => {
    const full = stepsFor("owner", () => true).steps.map((s) => s.key);
    const none = stepsFor("owner", (a) => !["customers.view", "jobs.view"].includes(a)).steps.map(
      (s) => s.key,
    );
    expect(none).toEqual(full.filter((k) => k !== "customers" && k !== "jobs"));
  });
});

describe("targets are stable identifiers, not guesses", () => {
  it("every anchored step points at a data-tour attribute that exists in the source", () => {
    /*
     * The failure this catches is silent by design: a step whose target no
     * longer exists still renders, centred, so nobody would notice from looking
     * at it. Reading the source is the only place the mismatch shows up.
     */
    const sources = [
      "src/app/(app)/o/[orgId]/layout.tsx",
      "src/app/(app)/o/[orgId]/nav/SidebarNav.tsx",
      "src/app/(app)/o/[orgId]/nav/MobileNav.tsx",
      "src/platform/ui/BottomNav.tsx",
    ]
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");

    for (const { key, steps } of allTours()) {
      for (const s of steps) {
        if (!s.target) continue;
        const ok = s.target.startsWith("nav:")
          ? // The nav items are tagged generically from the item's own key.
            sources.includes("data-tour={`nav:${item.key}`}")
          : sources.includes(`data-tour="${s.target}"`);
        expect(ok, `tour ${key} step ${s.key} targets ${s.target}, which nothing emits`).toBe(true);
      }
    }
  });

  it("no target is a CSS selector or a translated label", () => {
    // Both are the classic ways a tour rots: one breaks when the menu is
    // reordered, the other breaks the moment somebody switches to Arabic.
    for (const { steps } of allTours()) {
      for (const s of steps) {
        if (!s.target) continue;
        expect(s.target).toMatch(/^[a-z][a-z0-9_:]*$/);
      }
    }
  });
});

describe("nobody who was already here is interrupted", () => {
  const base = { status: "new", tourKey: "owner" as const, storedTourKey: null };
  const before = new Date(AUTO_START_FROM.getTime() - 1000);
  const after = new Date(AUTO_START_FROM.getTime() + 1000);

  it("greets a person who joined after the feature shipped", () => {
    expect(shouldAutoStart({ ...base, memberSince: after })).toBe(true);
  });

  it("does NOT greet a person who was already working here", () => {
    // The whole point of a fixed cutoff. On the day this ships nobody has a
    // progress row, so "no row means new" would greet the entire customer base
    // at once — which is the interruption the mandate forbids.
    expect(shouldAutoStart({ ...base, memberSince: before })).toBe(false);
  });

  it("treats the cutoff instant itself as new", () => {
    expect(shouldAutoStart({ ...base, memberSince: AUTO_START_FROM })).toBe(true);
  });

  it("never greets somebody who finished or declined", () => {
    for (const status of ["completed", "skipped"]) {
      expect(
        shouldAutoStart({ ...base, status, storedTourKey: "owner", memberSince: after }),
      ).toBe(false);
    }
  });

  it("does offer a different tour to somebody whose job here changed", () => {
    expect(
      shouldAutoStart({
        memberSince: after,
        status: "completed",
        tourKey: "finance",
        storedTourKey: "owner",
      }),
    ).toBe(true);
  });

  it("resumes an unfinished tour regardless of when they joined", () => {
    // Cross-device resume: started on the laptop, opened on the phone.
    expect(
      shouldAutoStart({ ...base, status: "in_progress", memberSince: before }),
    ).toBe(true);
  });

  it("does not greet somebody whose join date is unknown", () => {
    expect(shouldAutoStart({ ...base, memberSince: null })).toBe(false);
  });
});

describe("every string the tour can show is translated", () => {
  it("has copy for every step of every tour", () => {
    for (const { key, steps } of allTours()) {
      for (const s of steps) {
        expect(en, `tour.${key}.${s.key}.title`).toHaveProperty(`tour.${key}.${s.key}.title`);
        expect(en, `tour.${key}.${s.key}.body`).toHaveProperty(`tour.${key}.${s.key}.body`);
      }
    }
  });

  it("has copy for the chrome and the checklist", () => {
    const required = [
      "tour.welcome.title",
      "tour.welcome.body",
      "tour.start",
      "tour.not_now",
      "tour.next",
      "tour.back",
      "tour.finish",
      "tour.skip",
      "tour.close",
      "tour.restart",
      "tour.progress",
      "checklist.title",
      "checklist.dismiss",
      "checklist.progress",
      "checklist.state.done",
      "checklist.state.todo",
      "checklist.item.customer",
      "checklist.item.job",
      "checklist.item.invoice",
    ];
    for (const k of required) expect(en, k).toHaveProperty(k);
  });
});

/**
 * The permission actions the tour names must be real.
 *
 * A typo in `requires` does not fail the build — `Action` is a union, so it
 * would, but a renamed action that still type-checks against a stale union
 * would not. This asserts the filter actually discriminates.
 */
describe("the permission filter is not a no-op", () => {
  it("a role without a permission loses exactly that step", () => {
    const withAll = stepsFor("owner", () => true).steps.length;
    const withoutMembers = stepsFor("owner", (a: Action) => a !== "members.view").steps.length;
    expect(withoutMembers).toBe(withAll - 1);
  });
});
