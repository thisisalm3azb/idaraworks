/**
 * DEFECT 4 — the accessible <Menu> roving-focus math. This is the keyboard
 * navigation contract the Menu component delegates to; it is pure (no DOM), so
 * it is unit-tested here while the full open/close/outside-click/Escape
 * behaviour is exercised end-to-end in tests/e2e/quick-menu.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { nextFocusIndex } from "@/platform/ui/menu-nav";

describe("nextFocusIndex (menu roving focus)", () => {
  const COUNT = 4; // items 0..3

  it("ArrowDown advances and wraps at the end", () => {
    expect(nextFocusIndex(0, "ArrowDown", COUNT)).toBe(1);
    expect(nextFocusIndex(2, "ArrowDown", COUNT)).toBe(3);
    expect(nextFocusIndex(3, "ArrowDown", COUNT)).toBe(0); // wrap
  });

  it("ArrowUp retreats and wraps at the start", () => {
    expect(nextFocusIndex(3, "ArrowUp", COUNT)).toBe(2);
    expect(nextFocusIndex(1, "ArrowUp", COUNT)).toBe(0);
    expect(nextFocusIndex(0, "ArrowUp", COUNT)).toBe(3); // wrap
  });

  it("from 'no focus' (-1), ArrowDown enters at the first, ArrowUp at the last", () => {
    expect(nextFocusIndex(-1, "ArrowDown", COUNT)).toBe(0);
    expect(nextFocusIndex(-1, "ArrowUp", COUNT)).toBe(3);
  });

  it("Home/End jump to the first/last item", () => {
    expect(nextFocusIndex(2, "Home", COUNT)).toBe(0);
    expect(nextFocusIndex(1, "End", COUNT)).toBe(3);
  });

  it("returns -1 for an empty menu (never focuses a phantom item)", () => {
    expect(nextFocusIndex(-1, "ArrowDown", 0)).toBe(-1);
    expect(nextFocusIndex(0, "End", 0)).toBe(-1);
  });

  it("a single-item menu always resolves to index 0", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"] as const) {
      expect(nextFocusIndex(0, key, 1)).toBe(0);
    }
  });
});
