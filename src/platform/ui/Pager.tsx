/**
 * Previous/next paging for a bounded list.
 *
 * Every list in this product reads a bounded page, so every list needs a way
 * past the bound. Three surfaces had hand-rolled this identically before H22
 * added more, which is how a "silent cap" becomes normal: the read is bounded
 * correctly and the screen never admits there is more.
 *
 * Deliberately previous/next rather than numbered pages. The queries behind it
 * fetch one row beyond the page to learn whether more exist, which answers "is
 * there a next page" without the second COUNT(*) over a growing table that
 * numbered paging would need.
 *
 * Renders nothing on a single page, so a short list stays clean.
 */
import Link from "next/link";

export function Pager({
  page,
  hasMore,
  hrefFor,
  labels,
}: {
  /** 1-based. */
  page: number;
  hasMore: boolean;
  /** Builds the URL for a page, preserving whatever filters the caller holds. */
  hrefFor: (page: number) => string;
  labels: { previous: string; next: string; page: string };
}) {
  const hasPrevious = page > 1;
  if (!hasPrevious && !hasMore) return null;

  const link =
    "inline-flex min-h-11 items-center rounded-md border border-line px-3 text-sm text-ink hover:bg-sunken";
  const disabled =
    "inline-flex min-h-11 items-center rounded-md border border-line px-3 text-sm text-ink-muted opacity-50";

  return (
    <nav className="mt-3 flex items-center justify-between gap-2" aria-label={labels.page}>
      {hasPrevious ? (
        <Link href={hrefFor(page - 1)} className={link} rel="prev">
          {labels.previous}
        </Link>
      ) : (
        <span className={disabled} aria-disabled="true">
          {labels.previous}
        </span>
      )}
      <span className="text-xs text-ink-muted" aria-current="page">
        {labels.page} {page}
      </span>
      {hasMore ? (
        <Link href={hrefFor(page + 1)} className={link} rel="next">
          {labels.next}
        </Link>
      ) : (
        <span className={disabled} aria-disabled="true">
          {labels.next}
        </span>
      )}
    </nav>
  );
}
