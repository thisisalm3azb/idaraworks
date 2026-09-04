"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon, activeItemKey } from "@/platform/ui";
import type { NavGroupVM } from "./types";

/**
 * Desktop sidebar (U5 §1 + H16): brand block on top, role-aware collapsible
 * groups, accent-driven active state (start-border bar + soft tint — ink text
 * stays on a light surface so any tenant accent remains WCAG AA).
 *
 * H16 adds a WHOLE-SIDEBAR collapse to an icon rail: every item keeps an
 * accessible name (aria-label) and a tooltip (title), the active indicator
 * stays visible, and the choice persists in a cookie so the server renders
 * the right width on the next request (no flicker, no layout shift).
 * Client component only for pathname-based active state + collapse toggles;
 * all labels arrive resolved from the server layout.
 */
export function SidebarNav({
  groups,
  brand,
  lockedHint,
  navLabel,
  initialCollapsed = false,
  collapseLabel,
  expandLabel,
}: {
  groups: NavGroupVM[];
  brand: ReactNode;
  lockedHint: string;
  /** Translated landmark label (never hardcoded — ar renders Arabic). */
  navLabel: string;
  initialCollapsed?: boolean;
  collapseLabel: string;
  expandLabel: string;
}) {
  const pathname = usePathname();
  const allItems = groups.flatMap((g) => g.items);
  const activeKey = activeItemKey(pathname, allItems);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [rail, setRail] = useState(initialCollapsed);

  const toggleRail = () => {
    const next = !rail;
    setRail(next);
    // Persist for SSR (one year; the layout reads it before rendering).
    document.cookie = `iw_sidebar=${next ? "rail" : "open"}; path=/; max-age=31536000; samesite=lax`;
  };

  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 flex-col border-e border-line bg-card md:flex",
        rail ? "w-16" : "w-60 lg:w-64",
      )}
    >
      <div className={cn("border-b border-line py-3", rail ? "px-2" : "px-4")}>
        {rail ? (
          <Link
            href={allItems[0]?.href ?? "#"}
            aria-label={navLabel}
            className="flex h-9 w-full items-center justify-center rounded-md text-ink hover:bg-sunken"
          >
            <Icon name="home" size={20} aria-hidden />
          </Link>
        ) : (
          brand
        )}
      </div>
      <nav aria-label={navLabel} className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {groups.map((group) => {
          const isCollapsed = collapsed[group.key] ?? false;
          const single = group.items.length === 1 && group.items[0]!.key === group.key;
          return (
            <section
              key={group.key}
              className={cn("mb-1", rail && "mb-2 border-b border-line/60 pb-2 last:border-b-0")}
            >
              {single || rail ? null : (
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [group.key]: !isCollapsed }))}
                  aria-expanded={!isCollapsed}
                  className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted hover:text-ink"
                >
                  {group.label}
                  <Icon
                    name="chevronDown"
                    size={14}
                    className={cn(
                      "motion-safe:transition-transform",
                      isCollapsed && "-rotate-90 rtl:rotate-90",
                    )}
                  />
                </button>
              )}
              {single || rail || !isCollapsed ? (
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((item) => {
                    const active = item.key === activeKey;
                    return (
                      <li key={item.key}>
                        <Link
                          href={item.href}
                          data-tour={`nav:${item.key}`}
                          aria-current={active ? "page" : undefined}
                          aria-label={rail ? item.label : undefined}
                          title={rail ? item.label : item.locked ? lockedHint : undefined}
                          className={cn(
                            "flex min-h-10 items-center rounded-md border-s-[3px] text-sm",
                            rail ? "justify-center px-0" : "gap-2.5 px-2.5",
                            active
                              ? "border-accent bg-accent-soft font-medium text-ink"
                              : "border-transparent text-ink-secondary hover:bg-sunken hover:text-ink",
                            item.locked && "text-ink-muted",
                          )}
                        >
                          <span
                            className={cn(active ? "text-accent" : "text-ink-muted")}
                            aria-hidden
                          >
                            <Icon name={item.icon} size={18} />
                          </span>
                          {rail ? null : (
                            <>
                              <span className="min-w-0 flex-1 truncate">{item.label}</span>
                              {item.locked ? (
                                <span aria-label={lockedHint} className="text-ink-muted">
                                  <Icon name="lock" size={14} />
                                </span>
                              ) : null}
                            </>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          );
        })}
      </nav>
      <div className="border-t border-line p-2">
        <button
          type="button"
          onClick={toggleRail}
          aria-label={rail ? expandLabel : collapseLabel}
          title={rail ? expandLabel : collapseLabel}
          aria-expanded={!rail}
          className={cn(
            "flex min-h-10 w-full items-center rounded-md text-sm text-ink-secondary hover:bg-sunken hover:text-ink",
            rail ? "justify-center" : "gap-2.5 px-2.5",
          )}
        >
          <span aria-hidden className={cn(rail && "rtl:-scale-x-100", !rail && "rtl:-scale-x-100")}>
            <Icon name="chevronEnd" size={18} className={cn(!rail && "rotate-180")} />
          </span>
          {rail ? null : <span>{collapseLabel}</span>}
        </button>
      </div>
    </aside>
  );
}
