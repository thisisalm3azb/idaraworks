/**
 * The laws the guided tour has to keep.
 *
 * Most of these exist because the mandate names them as promises to customers
 * rather than as implementation details: the tour is SHORT, it is RELEVANT to
 * the person seeing it, it asks for real taps and advances only on evidence,
 * it never traps anybody, and it never interrupts somebody who has been
 * working here for months. Each of those is a sentence in a document until a
 * test makes it a property of the code.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLE_ARCHETYPES, type RoleArchetype } from "@/platform/registries";
import { can, type Action } from "@/platform/authz";
import {
  AUTO_START_FROM,
  MAX_STEPS,
  TOUR_KEYS,
  TOUR_VERSION,
  allTours,
  resumeIndex,
  routeSatisfied,
  shouldAutoStart,
  stepsFor,
  tourKeyForRole,
} from "@/modules/guidedtour/tours";

const en = JSON.parse(readFileSync("src/platform/i18n/messages/en.json", "utf8")) as Record<
  string,
  string
>;
const ar = JSON.parse(readFileSync("src/platform/i18n/messages/ar.json", "utf8")) as Record<
  string,
  string
>;
const es = JSON.parse(readFileSync("src/platform/i18n/messages/es.json", "utf8")) as Record<
  string,
  string
>;

const clientSrc = readFileSync("src/app/(app)/o/[orgId]/onboarding-tour/GuidedTour.tsx", "utf8");

describe("the tour stays short", () => {
  it("no tour exceeds the cap", () => {
    for (const { key, steps } of allTours()) {
      expect(steps.length, `tour ${key}`).toBeLessThanOrEqual(MAX_STEPS);
    }
  });

  it("no tour is so short it is not worth showing", () => {
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

describe("the tour is action-driven", () => {
  it("every step says how it is confirmed done, and route steps name a real path", () => {
    for (const { key, steps } of allTours()) {
      for (const s of steps) {
        expect(["route", "click", "next"], `tour ${key} step ${s.key}`).toContain(s.advance.kind);
        if (s.advance.kind === "route") {
          expect(s.advance.path, `tour ${key} step ${s.key}`).toMatch(/^\/[a-z-]+(\/[a-z-]+)*$/);
        }
        // A step that asks for a tap must point at the control to tap.
        if (s.advance.kind !== "next") expect(s.target, `tour ${key} step ${s.key}`).not.toBeNull();
      }
    }
  });

  it("most steps ask for a real interaction; at most two per tour are read-and-Next", () => {
    for (const { key, steps } of allTours()) {
      const manual = steps.filter((s) => s.advance.kind === "next").length;
      expect(manual, `tour ${key}`).toBeLessThanOrEqual(2);
      expect(steps.length - manual, `tour ${key}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("leads to a first outcome without requiring a consequential action", () => {
    /*
     * A step may open a form (a route to /jobs, /invoices/new) or a menu, and
     * may point at a form; no step advances on a submit, a save or a send.
     * The only ways a step ends are a route match, a click on the highlighted
     * control, or Next, none of which writes anything.
     */
    for (const { steps } of allTours()) {
      for (const s of steps) {
        if (s.advance.kind === "route") {
          expect(s.advance.path).not.toMatch(/submit|save|send|delete|approve/);
        }
      }
    }
    expect(clientSrc).not.toMatch(/requestSubmit|\.submit\(\)/);
  });

  it("the silent skip is reserved for the mobile More tab", () => {
    for (const { steps } of allTours()) {
      for (const s of steps) {
        if (s.whenAbsent === "skip") expect(s.target).toBe("nav:more");
      }
    }
  });

  it("a route step is satisfied by the page and by pages beneath it, never by a look-alike", () => {
    expect(routeSatisfied("/o/abc/jobs", "/o/abc", "/jobs")).toBe(true);
    expect(routeSatisfied("/o/abc/jobs/", "/o/abc", "/jobs")).toBe(true);
    expect(routeSatisfied("/o/abc/jobs/123?tab=tasks", "/o/abc", "/jobs")).toBe(true);
    expect(routeSatisfied("/o/abc/jobsheets", "/o/abc", "/jobs")).toBe(false);
    expect(routeSatisfied("/o/other/jobs", "/o/abc", "/jobs")).toBe(false);
    expect(routeSatisfied("/o/abc", "/o/abc", "/jobs")).toBe(false);
  });
});

describe("the tour is relevant to the person seeing it", () => {
  it("every role archetype maps to a tour", () => {
    for (const a of ROLE_ARCHETYPES) {
      expect(TOUR_KEYS, `archetype ${a}`).toContain(tourKeyForRole(a as RoleArchetype));
    }
  });

  it("never asks for a tap on a control the person would be refused", () => {
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
    const { steps } = stepsFor("viewer", (act) => can("viewer", act));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some((s) => s.key === "report")).toBe(false); // cannot file one
  });

  it("the last step of every tour explains how to find it again", () => {
    for (const { key, steps } of allTours()) {
      expect(steps.at(-1)?.key, `tour ${key}`).toBe("help");
      expect(steps.at(-1)?.target, `tour ${key}`).toBe("account");
      expect(steps.at(-1)?.advance.kind, `tour ${key}`).toBe("next");
    }
  });

  it("permission filtering never reorders or invents steps", () => {
    const full = stepsFor("owner", () => true).steps.map((s) => s.key);
    const none = stepsFor("owner", (a) => !["customers.view", "jobs.create"].includes(a)).steps.map(
      (s) => s.key,
    );
    expect(none).toEqual(full.filter((k) => !["customers", "new_job", "create"].includes(k)));
  });
});

describe("targets are stable identifiers, not guesses", () => {
  it("every anchored step points at a data-tour attribute that exists in the source", () => {
    const sources = [
      "src/app/(app)/o/[orgId]/layout.tsx",
      "src/app/(app)/o/[orgId]/nav/SidebarNav.tsx",
      "src/app/(app)/o/[orgId]/nav/MobileNav.tsx",
      "src/app/(app)/o/[orgId]/jobs/page.tsx",
      "src/app/(app)/o/[orgId]/invoices/page.tsx",
      "src/platform/ui/BottomNav.tsx",
    ]
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");

    for (const { key, steps } of allTours()) {
      for (const s of steps) {
        if (!s.target) continue;
        const ok = s.target.startsWith("nav:")
          ? sources.includes("data-tour={`nav:${item.key}`}")
          : sources.includes(`data-tour="${s.target}"`);
        expect(ok, `tour ${key} step ${s.key} targets ${s.target}, which nothing emits`).toBe(true);
      }
    }
  });

  it("the More tab is a real nav item, so nav:more exists on phones", () => {
    const build = readFileSync("src/platform/ui/nav/build.ts", "utf8");
    expect(build).toMatch(/key: "more"/);
    const bottom = readFileSync("src/platform/ui/BottomNav.tsx", "utf8");
    // The whole cell carries the anchor, so a tap anywhere in it counts.
    expect(bottom).toMatch(/<li[^>]*data-tour=\{`nav:\$\{item\.key\}`\}/);
  });

  it("no target is a CSS selector or a translated label", () => {
    for (const { steps } of allTours()) {
      for (const s of steps) {
        if (!s.target) continue;
        expect(s.target).toMatch(/^[a-z][a-z0-9_:]*$/);
      }
    }
  });
});

describe("the card never traps or misleads", () => {
  it("is a non-modal dialog with no focus trap, and Escape exits", () => {
    expect(clientSrc).toMatch(/aria-modal="false"/);
    expect(clientSrc).not.toMatch(/aria-modal="true"/);
    expect(clientSrc).not.toMatch(/e\.key === "Tab"/);
    expect(clientSrc).toMatch(/e\.key === "Escape"/);
  });

  it("dismissing records skipped, never completed", () => {
    // The × control and Escape both go through close("skipped"); only the
    // final step's own button reaches close("completed").
    expect(clientSrc.match(/close\("skipped"\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(clientSrc.match(/close\("completed"\)/g)?.length ?? 0).toBe(1);
  });

  it("advances on evidence, not on a timer", () => {
    // The only timers are the grace periods for "cannot find it" and the
    // silent skip; no step advances because time passed.
    expect(clientSrc).not.toMatch(/setTimeout\(/);
    expect(clientSrc).not.toMatch(/setInterval\(/);
  });

  it("the spotlight never intercepts the tap it asks for", () => {
    expect(clientSrc).toMatch(/pointer-events-none fixed z-\[99\]/);
    // No full-screen click-catching backdrop remains anywhere in the tour.
    expect(clientSrc).not.toMatch(/fixed inset-0 z-\[100\]/);
  });

  it("sits above the mobile bottom bar rather than on it", () => {
    expect(clientSrc).toMatch(/calc\(3\.5rem \+ env\(safe-area-inset-bottom\) \+ 12px\)/);
  });

  it("offers a way on when a control is missing, and a way out always", () => {
    expect(clientSrc).toMatch(/labels\.notFound/);
    expect(clientSrc).toMatch(/labels\.skipStep/);
    expect(clientSrc).toMatch(/labels\.exit/);
  });

  it("writes nothing but its own progress", () => {
    expect(clientSrc.match(/import .* from "\.\/actions"/)?.[0]).toBe(
      'import { saveTourProgressAction } from "./actions"',
    );
    expect(clientSrc).not.toMatch(/fetch\(/);
  });
});

describe("older progress is handled safely", () => {
  it("this is version 2", () => {
    expect(TOUR_VERSION).toBe(2);
  });

  it("a position from version 1 restarts at the first step; this version resumes in place", () => {
    expect(resumeIndex({ stepIndex: 5, tourVersion: 1 })).toBe(0);
    expect(resumeIndex({ stepIndex: 3, tourVersion: TOUR_VERSION })).toBe(3);
    expect(resumeIndex({ stepIndex: -2, tourVersion: TOUR_VERSION })).toBe(0);
  });

  it("finishing or declining version 1 is respected: nobody is re-greeted by the rewrite", () => {
    const base = { tourKey: "owner" as const, storedTourKey: "owner", memberSince: new Date() };
    expect(shouldAutoStart({ ...base, status: "completed" })).toBe(false);
    expect(shouldAutoStart({ ...base, status: "skipped" })).toBe(false);
  });

  it("the auto-start cutoff did not move with the rewrite", () => {
    expect(AUTO_START_FROM.toISOString()).toBe("2026-09-05T00:00:00.000Z");
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
    expect(shouldAutoStart({ ...base, memberSince: before })).toBe(false);
  });

  it("treats the cutoff instant itself as new", () => {
    expect(shouldAutoStart({ ...base, memberSince: AUTO_START_FROM })).toBe(true);
  });

  it("never greets somebody who finished or declined", () => {
    for (const status of ["completed", "skipped"]) {
      expect(shouldAutoStart({ ...base, status, storedTourKey: "owner", memberSince: after })).toBe(
        false,
      );
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
    expect(shouldAutoStart({ ...base, status: "in_progress", memberSince: before })).toBe(true);
  });

  it("does not greet somebody whose join date is unknown", () => {
    expect(shouldAutoStart({ ...base, memberSince: null })).toBe(false);
  });
});

describe("every string the tour can show is translated", () => {
  it("has copy for every step of every tour, in all three languages, one instruction each", () => {
    for (const { key, steps } of allTours()) {
      for (const s of steps) {
        for (const part of ["title", "body"]) {
          const k = `tour.${key}.${s.key}.${part}`;
          expect(en, k).toHaveProperty(k);
          expect(ar, k).toHaveProperty(k);
          expect(es, k).toHaveProperty(k);
          expect(en[k]!.length, k).toBeLessThan(140);
          expect(en[k], k).not.toContain("—");
        }
        // An action step's title is the instruction itself.
        if (s.advance.kind !== "next") expect(en[`tour.${key}.${s.key}.title`]).toMatch(/^Tap /);
      }
    }
  });

  it("has copy for the chrome", () => {
    const required = [
      "tour.welcome.title",
      "tour.welcome.body",
      "tour.start",
      "tour.not_now",
      "tour.next",
      "tour.finish",
      "tour.skip_step",
      "tour.exit",
      "tour.close",
      "tour.restart",
      "tour.progress",
      "tour.not_found",
      "tour.not_found_hint",
      "checklist.title",
      "checklist.dismiss",
      "checklist.progress",
      "checklist.state.done",
      "checklist.state.todo",
      "checklist.item.customer",
      "checklist.item.job",
      "checklist.item.invoice",
    ];
    for (const k of required) {
      expect(en, k).toHaveProperty(k);
      expect(ar, k).toHaveProperty(k);
      expect(es, k).toHaveProperty(k);
    }
  });

  it("carries no version-1 slideshow strings", () => {
    for (const k of Object.keys(en)) {
      expect(k).not.toMatch(/^tour\.(owner|finance|supply|field)\.home\./);
    }
    expect(en).not.toHaveProperty("tour.back");
  });
});

describe("the permission filter is not a no-op", () => {
  it("a role without a permission loses exactly that step", () => {
    const withAll = stepsFor("owner", () => true).steps.length;
    const withoutCustomers = stepsFor("owner", (a: Action) => a !== "customers.view").steps.length;
    expect(withoutCustomers).toBe(withAll - 1);
  });
});
