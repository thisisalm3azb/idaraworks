"use client";
/**
 * H17 Part M — a collapsible dashboard section (presentation only).
 *
 * Collapse state is a per-browser convenience persisted in the `iw_dash`
 * cookie (comma-separated section keys, same pattern as the sidebar's
 * `iw_sidebar`); the server reads it so the first paint is already correct
 * (no layout shift). Preferences NEVER grant or hide access — the section's
 * content was composed server-side under the full permission law, and the
 * attention section is not collapsible at all (mandatory signals stay).
 * A future account-level preference store can replace the cookie without
 * touching the composer (documented integration point, Part M).
 */
import { useState, type ReactNode } from "react";

function writeCookie(orgId: string, key: string, collapsed: boolean) {
  try {
    const name = "iw_dash";
    const current = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${name}=`))
      ?.slice(name.length + 1);
    const set = new Set(
      decodeURIComponent(current ?? "")
        .split(",")
        .filter(Boolean),
    );
    const token = `${orgId}:${key}`;
    if (collapsed) set.add(token);
    else set.delete(token);
    document.cookie = `${name}=${encodeURIComponent([...set].join(","))}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    // Cookie writes are a convenience; the section still toggles in-page.
  }
}

export function AdaptiveSection({
  orgId,
  sectionKey,
  title,
  meta,
  initiallyCollapsed,
  collapseLabel,
  expandLabel,
  children,
}: {
  orgId: string;
  sectionKey: string;
  title: string;
  meta?: ReactNode;
  initiallyCollapsed: boolean;
  collapseLabel: string;
  expandLabel: string;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const bodyId = `dash-${sectionKey}`;
  return (
    <section aria-labelledby={`${bodyId}-h`} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`${bodyId}-h`} className="text-sm font-semibold tracking-wide text-ink">
          {title}
        </h2>
        <span className="flex items-center gap-2">
          {meta}
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            aria-label={collapsed ? expandLabel : collapseLabel}
            onClick={() => {
              const next = !collapsed;
              setCollapsed(next);
              writeCookie(orgId, sectionKey, next);
            }}
            className="flex size-11 items-center justify-center rounded-md text-ink-muted hover:bg-sunken hover:text-ink"
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className={`size-4 motion-safe:transition-transform ${collapsed ? "" : "rotate-180"}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </span>
      </div>
      <div id={bodyId} hidden={collapsed} className="flex flex-col gap-3">
        {children}
      </div>
    </section>
  );
}
