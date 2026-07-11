import type { ReactNode } from "react";

/**
 * Application shell: top bar + content column.
 * Navigation philosophy (v2 §13): top-level items reflect user jobs
 * (Today / Work / Approvals / Materials / Money / People / Reports) — wired
 * per-role from slice S2 onward. Phase A ships the frame only.
 * RTL-first: logical properties throughout.
 */
export function AppShell({
  brand,
  actions,
  children,
}: {
  brand: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-card">
        <div className="mx-auto flex min-h-14 w-full max-w-5xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-2 font-semibold text-ink">{brand}</div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 pb-24 md:pb-6">{children}</main>
    </div>
  );
}
