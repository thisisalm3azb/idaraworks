"use client";

import { Button } from "../Button";

/**
 * Dashboard error boundary body (U5 §3) — used by the org error.tsx: a plain
 * message + retry (Next's reset()). Client component by error-boundary law.
 */
export function ErrorState({
  title,
  description,
  retryLabel,
  onRetry,
}: {
  title: string;
  description?: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong bg-card px-6 py-12 text-center">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {description ? <p className="max-w-sm text-sm text-ink-secondary">{description}</p> : null}
      <Button variant="secondary" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}
