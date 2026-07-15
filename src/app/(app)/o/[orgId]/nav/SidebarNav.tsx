"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon, activeItemKey } from "@/platform/ui";
import type { NavGroupVM } from "./types";

/**
 * Desktop sidebar (U5 §1): brand block on top, role-aware collapsible groups,
 * accent-driven active state (start-border bar + soft tint — ink text stays on
 * a light surface so any tenant accent remains WCAG AA). Client component only
 * for pathname-based active state + collapse toggles; all labels arrive
 * resolved from the server layout.
 */
export function SidebarNav({
  groups,
  brand,
  lockedHint,
  navLabel,
}: {
  groups: NavGroupVM[];
  brand: ReactNode;
  lockedHint: string;
  /** Translated landmark label (never hardcoded — ar renders Arabic). */
  navLabel: string;
}) {
  const pathname = usePathname();
  const allItems = groups.flatMap((g) => g.items);
  const activeKey = activeItemKey(pathname, allItems);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-e border-line bg-card md:flex lg:w-64">
      <div className="border-b border-line px-4 py-3">{brand}</div>
      <nav aria-label={navLabel} className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {groups.map((group) => {
          const isCollapsed = collapsed[group.key] ?? false;
          const single = group.items.length === 1 && group.items[0]!.key === group.key;
          return (
            <section key={group.key} className="mb-1">
              {single ? null : (
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
                      "transition-transform",
                      isCollapsed && "-rotate-90 rtl:rotate-90",
                    )}
                  />
                </button>
              )}
              {single || !isCollapsed ? (
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((item) => {
                    const active = item.key === activeKey;
                    return (
                      <li key={item.key}>
                        <Link
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          title={item.locked ? lockedHint : undefined}
                          className={cn(
                            "flex min-h-10 items-center gap-2.5 rounded-md border-s-[3px] px-2.5 text-sm",
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
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          {item.locked ? (
                            <span aria-label={lockedHint} className="text-ink-muted">
                              <Icon name="lock" size={14} />
                            </span>
                          ) : null}
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
    </aside>
  );
}
