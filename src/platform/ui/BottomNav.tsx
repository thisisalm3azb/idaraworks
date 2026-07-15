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
 * Touch targets ≥ 44px (BUILD_BIBLE §9.2).
 */
export function BottomNav({ items, ariaLabel }: { items: BottomNavItem[]; ariaLabel?: string }) {
  return (
    <nav
      aria-label={ariaLabel ?? "Primary"}
      className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="mx-auto flex max-w-md items-stretch justify-around">
        {items.slice(0, 5).map((item) => {
          const inner = (
            <>
              <span aria-hidden className="relative text-lg leading-none">
                {item.icon}
                {item.badge ? (
                  <span className="absolute -end-2 -top-1 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold text-ink-inverse">
                    {item.badge > 99 ? "99+" : item.badge}
                  </span>
                ) : null}
              </span>
              <span className="max-w-full truncate">{item.label}</span>
            </>
          );
          const className = cn(
            "flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-1 text-xs",
            item.active ? "font-semibold text-accent" : "text-ink-secondary",
          );
          return (
            <li key={item.key} className="min-w-0 flex-1">
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
