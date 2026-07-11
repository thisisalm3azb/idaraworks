import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

export type BottomNavItem = {
  key: string;
  label: string;
  icon: ReactNode;
  href: string;
  active?: boolean;
  badge?: number;
};

/**
 * Mobile bottom navigation — the field user's primary chrome (v2 §13).
 * Hidden on md+ where the AppShell header takes over. Items are role-scoped
 * by the caller; this component renders at most 5.
 * Touch targets ≥ 44px (BUILD_BIBLE §9.2).
 */
export function BottomNav({ items }: { items: BottomNavItem[] }) {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-card md:hidden"
    >
      <ul className="mx-auto flex max-w-md items-stretch justify-around">
        {items.slice(0, 5).map((item) => (
          <li key={item.key} className="flex-1">
            <a
              href={item.href}
              aria-current={item.active ? "page" : undefined}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-xs",
                item.active ? "font-semibold text-brand" : "text-ink-secondary",
              )}
            >
              <span aria-hidden className="relative text-lg leading-none">
                {item.icon}
                {item.badge ? (
                  <span className="absolute -end-2 -top-1 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold text-ink-inverse">
                    {item.badge > 99 ? "99+" : item.badge}
                  </span>
                ) : null}
              </span>
              <span>{item.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
