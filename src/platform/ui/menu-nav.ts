/**
 * Pure roving-focus index math for the accessible <Menu> (menu-nav has NO React
 * or DOM dependency so it is unit-testable in the node vitest env). Given the
 * index of the currently focused item (`current`, or -1 when focus is not yet on
 * an item) and the arrow/Home/End key pressed, it returns the index to focus
 * next. Movement WRAPS at both ends (WAI-ARIA menu pattern). Returns -1 when the
 * menu has no items.
 */
export type MenuNavKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

export function nextFocusIndex(current: number, key: MenuNavKey, count: number): number {
  if (count <= 0) return -1;
  switch (key) {
    case "ArrowDown":
      // From "no focus" or the last item, wrap to the first.
      return current < 0 || current >= count - 1 ? 0 : current + 1;
    case "ArrowUp":
      // From "no focus" or the first item, wrap to the last.
      return current <= 0 ? count - 1 : current - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
  }
}
