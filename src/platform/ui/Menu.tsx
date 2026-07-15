"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "./icons";
import { nextFocusIndex, type MenuNavKey } from "./menu-nav";

/**
 * <Menu> — an accessible header popover menu (DEFECT 4 fix).
 *
 * Replaces the native `<details><summary>` header menus, whose `open` state only
 * toggles via the summary: they did NOT close on outside-click, Escape, item
 * selection or client navigation, so the panel lingered across routes and
 * overlapped page content (and, being a real element, kept intercepting clicks).
 *
 * Closure conditions this implements (see docs/ux/QUICK_CREATE_MENU_FIX.md):
 *  - trigger click toggles open;
 *  - outside pointerdown closes (listener ignores clicks inside trigger/panel);
 *  - Escape closes and RETURNS focus to the trigger;
 *  - selecting a link/button item closes (link closes THEN navigates);
 *  - route change closes (usePathname derived-state — the lingering-across-pages
 *    fix; org change and locale change both change the path / re-render);
 *  - Tab closes and lets focus continue in natural order (no focus trap).
 *
 * When closed the panel is NOT in the DOM, so nothing intercepts clicks and
 * there is no invisible full-screen overlay. Positioning is logical (`end-0`),
 * so it flips correctly under RTL. Items are ≥44px tall.
 */

export type MenuItem = {
  key: string;
  label: string;
  /** Optional leading icon (name from the design-system icon set). */
  icon?: IconName;
  /** Link item — renders next/link; closes the menu then navigates. */
  href?: string;
  /** Client button item — runs onSelect then closes. */
  onSelect?: () => void;
  /**
   * Server-action item (e.g. logout) — renders a <form> whose submit button is
   * the menu item. The ensuing navigation closes the menu via the route-change
   * handler, so we do NOT force-unmount mid-submit.
   */
  formAction?: (formData: FormData) => void | Promise<void>;
};

/** A visual group of items; sections after the first get a top separator, and
 *  an optional heading renders above the group (e.g. the "Workspace" switcher). */
export type MenuSection = {
  key: string;
  heading?: string;
  items: MenuItem[];
};

const NAV_KEYS: readonly MenuNavKey[] = ["ArrowDown", "ArrowUp", "Home", "End"];

export function Menu({
  trigger,
  triggerLabel,
  triggerClassName,
  sections,
  align = "end",
  panelClassName,
}: {
  /** Visual content inside the trigger button (icon, label, accent badge…). */
  trigger: ReactNode;
  /** Accessible name for the trigger AND (via aria-labelledby) the menu. */
  triggerLabel: string;
  triggerClassName?: string;
  sections: MenuSection[];
  /** Logical alignment of the panel edge (default: end — RTL-safe). */
  align?: "end" | "start";
  panelClassName?: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | HTMLButtonElement | null>>([]);
  const reactId = useId();
  const triggerId = `menu-trigger-${reactId}`;
  const panelId = `menu-panel-${reactId}`;

  const count = sections.reduce((n, s) => n + s.items.length, 0);

  // Close on route change — THE lingering-across-pages fix. Org change (path
  // /o/[orgId] changes) and locale change (path re-render) are both covered.
  // Render-time derived-state adjustment: React's sanctioned alternative to an
  // effect (mirrors MobileNav).
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (open) setOpen(false);
  }

  // Outside-pointerdown + Escape — only while open. No full-screen overlay: a
  // document listener does the outside detection and the panel simply unmounts.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return; // trigger toggles itself
      if (panelRef.current?.contains(target)) return; // clicks on items handled below
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus(); // return focus to the trigger
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Move focus to the first item when the menu opens (common menu pattern).
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  function onPanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if ((NAV_KEYS as readonly string[]).includes(event.key)) {
      event.preventDefault();
      const current = itemRefs.current.findIndex((el) => el === document.activeElement);
      const next = nextFocusIndex(current, event.key as MenuNavKey, count);
      itemRefs.current[next]?.focus();
    } else if (event.key === "Tab") {
      // Tab leaves the menu: close and let the browser move focus onward (no trap).
      setOpen(false);
    }
    // Escape is handled by the document listener so it also works from the panel.
  }

  const close = () => setOpen(false);

  // Shared item chrome — ≥44px target, logical padding, hover + focus states.
  const itemClass =
    "flex min-h-11 w-full items-center gap-2.5 rounded-sm px-3 text-start text-sm text-ink hover:bg-sunken focus:bg-sunken focus:outline-none";

  // Interactive-item count before each section — gives every item a stable
  // global index (drives roving tabindex + refs) without mutating a counter
  // during render.
  const sectionOffset = sections.map((_, si) =>
    sections.slice(0, si).reduce((n, s) => n + s.items.length, 0),
  );

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={triggerLabel}
        onClick={() => setOpen((v) => !v)}
        className={triggerClassName}
      >
        {trigger}
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          aria-labelledby={triggerId}
          aria-orientation="vertical"
          onKeyDown={onPanelKeyDown}
          className={cn(
            "absolute z-40 mt-1 w-56 rounded-md border border-line bg-card p-1 shadow-pop",
            align === "end" ? "end-0" : "start-0",
            panelClassName,
          )}
        >
          {sections.map((section, si) => (
            <div key={section.key} className={cn(si > 0 && "mt-1 border-t border-line pt-1")}>
              {section.heading ? (
                <p className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  {section.heading}
                </p>
              ) : null}
              {section.items.map((item, itemIndex) => {
                const i = (sectionOffset[si] ?? 0) + itemIndex;
                const tabIndex = i === 0 ? 0 : -1; // roving: only the first is Tab-reachable
                const inner = (
                  <>
                    {item.icon ? (
                      <span className="text-ink-muted" aria-hidden>
                        <Icon name={item.icon} size={18} />
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </>
                );

                if (item.href) {
                  return (
                    <Link
                      key={item.key}
                      ref={(el) => {
                        itemRefs.current[i] = el;
                      }}
                      href={item.href}
                      role="menuitem"
                      tabIndex={tabIndex}
                      onClick={close}
                      className={itemClass}
                    >
                      {inner}
                    </Link>
                  );
                }

                if (item.formAction) {
                  return (
                    <form key={item.key} action={item.formAction} className="block">
                      <button
                        ref={(el) => {
                          itemRefs.current[i] = el;
                        }}
                        type="submit"
                        role="menuitem"
                        tabIndex={tabIndex}
                        className={itemClass}
                      >
                        {inner}
                      </button>
                    </form>
                  );
                }

                return (
                  <button
                    key={item.key}
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    type="button"
                    role="menuitem"
                    tabIndex={tabIndex}
                    onClick={() => {
                      item.onSelect?.();
                      close();
                    }}
                    className={itemClass}
                  >
                    {inner}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
