"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { BottomNav, Icon, activeItemKey } from "@/platform/ui";
import type { BottomItemVM, NavGroupVM } from "./types";

/**
 * Mobile chrome (U5 §1): the top-bar burger, the full-nav drawer it opens
 * (start-side sheet, logical properties → flips under RTL), and the mounted
 * BottomNav (4 role-primary items + "More" opening the same drawer). One
 * client component so the burger and "More" share the drawer state.
 * 44px targets; the drawer closes on route change.
 */
export function MobileNav({
  groups,
  bottomItems,
  brand,
  openLabel,
  closeLabel,
  lockedHint,
  accountLabel,
  navLabel,
}: {
  groups: NavGroupVM[];
  bottomItems: BottomItemVM[];
  brand: ReactNode;
  openLabel: string;
  closeLabel: string;
  lockedHint: string;
  accountLabel: string;
  /** Translated landmark label (never hardcoded — ar renders Arabic). */
  navLabel: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Close the sheet whenever navigation lands somewhere new (render-time
  // derived-state adjustment — the React-sanctioned alternative to an effect).
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (open) setOpen(false);
  }

  const allItems = groups.flatMap((g) => g.items);
  const activeKey = activeItemKey(pathname, allItems);
  const bottomActive = activeItemKey(
    pathname,
    bottomItems.filter((i) => !i.isMore),
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={openLabel}
        aria-expanded={open}
        className="flex h-11 w-11 items-center justify-center rounded-md text-ink hover:bg-sunken md:hidden"
      >
        <Icon name="menu" size={22} />
      </button>

      {open ? (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label={closeLabel}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-inverse/40"
          />
          <div className="absolute inset-y-0 start-0 flex w-[85%] max-w-xs flex-col bg-card shadow-pop">
            <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
              <div className="min-w-0 flex-1">{brand}</div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={closeLabel}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink hover:bg-sunken"
              >
                <Icon name="close" size={20} />
              </button>
            </div>
            <nav aria-label={navLabel} className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
              {groups.map((group) => (
                <section key={group.key} className="mb-2">
                  {group.items.length === 1 && group.items[0]!.key === group.key ? null : (
                    <h2 className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      {group.label}
                    </h2>
                  )}
                  <ul className="flex flex-col gap-0.5">
                    {group.items.map((item) => {
                      const active = item.key === activeKey;
                      return (
                        <li key={item.key}>
                          <Link
                            href={item.href}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                              "flex min-h-11 items-center gap-3 rounded-md border-s-[3px] px-2.5 text-sm",
                              active
                                ? "border-accent bg-accent-soft font-medium text-ink"
                                : "border-transparent text-ink-secondary hover:bg-sunken",
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
                </section>
              ))}
              <section className="border-t border-line pt-2">
                <Link
                  href="/account"
                  className="flex min-h-11 items-center gap-3 rounded-md px-2.5 text-sm text-ink-secondary hover:bg-sunken"
                >
                  <span className="text-ink-muted" aria-hidden>
                    <Icon name="user" size={18} />
                  </span>
                  {accountLabel}
                </Link>
              </section>
            </nav>
          </div>
        </div>
      ) : null}

      <BottomNav
        ariaLabel={navLabel}
        items={bottomItems.map((item) => ({
          key: item.key,
          label: item.label,
          href: item.href,
          icon: <Icon name={item.icon} size={20} />,
          active: !item.isMore && item.key === bottomActive,
          onSelect: item.isMore ? () => setOpen(true) : undefined,
        }))}
      />
    </>
  );
}
