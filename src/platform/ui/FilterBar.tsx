/**
 * H18 — the drill-down filter bar shown when a list is narrowed by a
 * canonical dashboard filter: a human-readable summary of WHAT is filtered,
 * a screen-reader-announced result count, and an accessible clear control
 * back to the unfiltered list. Presentation only — the narrowing itself
 * happened server-side under the caller's own authorization.
 */
import Link from "next/link";
import { Badge } from "./Badge";

export function FilterBar({
  summary,
  countLabel,
  clearHref,
  clearLabel,
}: {
  /** Human-readable description of the active filter (org terminology). */
  summary: string;
  /** Pre-translated result count ("3 results"). */
  countLabel: string;
  clearHref: string;
  clearLabel: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-sunken px-3 py-2"
    >
      <Badge tone="brand">{summary}</Badge>
      <span className="text-xs text-ink-secondary">{countLabel}</span>
      <Link
        href={clearHref}
        className="inline-flex min-h-11 items-center text-sm text-brand hover:underline"
      >
        {clearLabel}
      </Link>
    </div>
  );
}
