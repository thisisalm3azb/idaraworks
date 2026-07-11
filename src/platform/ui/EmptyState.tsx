import type { ReactNode } from "react";

/**
 * Every list's empty state is a call-to-action, never a blank (v2 §16, BUILD_BIBLE §9.7).
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong bg-card px-6 py-12 text-center">
      {icon ? (
        <div className="text-3xl" aria-hidden>
          {icon}
        </div>
      ) : null}
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {description ? <p className="max-w-sm text-sm text-ink-secondary">{description}</p> : null}
      {action}
    </div>
  );
}
