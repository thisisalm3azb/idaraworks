import Link from "next/link";
import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

export type BottomNavItem = {
  key: string;
  label: string;
  icon: ReactNode;
  href: string;
  active?: boolean;
  badge?: number;
  /** Render as a button instead of a link (e.g. the "More" drawer trigger). */
  onSelect?: () => void;
};

/**
 * Mobile bottom navigation — the field user's primary chrome (v2 §13),
 * MOUNTED by the U5 org shell. Hidden on md+ where the sidebar takes over.
 * Items are role-scoped by the caller; this component renders at most 5.
 *
 * Every tab is ONE target: the link or button fills its cell, so the icon,
 * the label, the space between them and the padding around them all belong
 * to the same element (owner report, 2026-09-20: "it feels like only the
 * text is clickable"). Cells are at least 3.5rem (56px) tall and share the
 * width evenly, which keeps each one wider than 48px on any phone that can
 * run the app. The bar carries the device's bottom safe area itself, so the
 * tabs never sit under a home indicator.
 *
 * States: the selected tab is marked with `aria-current="page"`, an accent
 * bar at its top edge and accent text; a press tints the cell at once
 * (`active:`), before navigation completes.
 */
export function BottomNav({ items, ariaLabel }: { items: BottomNavItem[]; ariaLabel?: string }) {
  return (
    <nav
      aria-label={ariaLabel ?? "Primary"}
      className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="mx-auto flex max-w-md items-stretch">
        {items.slice(0, 5).map((item) => {
          const inner = (
            <>
              {item.active ? (
                <span
                  aria-hidden
                  className="absolute inset-x-3 top-0 h-0.5 rounded-b-full bg-accent"
                />
              ) : null}
              <span aria-hidden className="relative leading-none">
                {item.icon}
                {item.badge ? (
                  <span className="absolute -end-2.5 -top-1.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold text-ink-inverse">
                    {item.badge > 99 ? "99+" : item.badge}
                  </span>
                ) : null}
              </span>
              <span className="max-w-full truncate text-[11px] leading-tight">{item.label}</span>
            </>
          );
          const className = cn(
            "relative flex min-h-14 w-full touch-manipulation select-none flex-col items-center justify-center gap-1 px-1 pb-1 pt-1.5",
            "active:bg-sunken",
            item.active ? "font-semibold text-accent" : "text-ink-secondary",
          );
          return (
            <li key={item.key} data-tour={`nav:${item.key}`} className="min-w-0 flex-1">
              {item.onSelect ? (
                <button type="button" onClick={item.onSelect} className={className}>
                  {inner}
                </button>
              ) : (
                <Link
                  href={item.href}
                  aria-current={item.active ? "page" : undefined}
                  className={className}
                >
                  {inner}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
