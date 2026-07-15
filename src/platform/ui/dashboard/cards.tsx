import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Badge } from "../Badge";
import { Card, CardHeader } from "../Card";
import { Icon, type IconName } from "../icons";

/**
 * The dumb dashboard cards (U5 §3). Presentational only: pages resolve data,
 * i18n and hrefs; these render. Platform layer — no module imports.
 */

// ── Section card: a titled card with a "view all" link ───────────────────────
export function SectionCard({
  title,
  meta,
  viewAllHref,
  viewAllLabel,
  children,
  className,
  id,
}: {
  title: string;
  meta?: ReactNode;
  viewAllHref?: string;
  viewAllLabel?: string;
  children: ReactNode;
  className?: string;
  /** In-page anchor target (e.g. a KPI linking to its own list below). */
  id?: string;
}) {
  return (
    <Card id={id} className={cn("flex flex-col", className)}>
      <CardHeader
        title={title}
        meta={
          viewAllHref && viewAllLabel ? (
            <Link href={viewAllHref} className="text-xs font-medium text-accent hover:underline">
              {viewAllLabel}
            </Link>
          ) : (
            meta
          )
        }
      />
      {children}
    </Card>
  );
}

// ── List rows (attention queues, approvals, deadlines) ───────────────────────
export type ListRow = {
  key: string;
  title: string;
  href?: string;
  /** Small end-aligned text (a date, an amount — pass pre-formatted). */
  meta?: string;
  /** Meta is a number/money/code → render dir="ltr" mono. */
  metaLtr?: boolean;
  badge?: { label: string; tone: "neutral" | "info" | "warning" | "danger" | "success" | "brand" };
};

export function RowList({ rows, emptyLabel }: { rows: ListRow[]; emptyLabel: string }) {
  if (rows.length === 0) return <p className="py-2 text-sm text-ink-muted">{emptyLabel}</p>;
  return (
    <ul className="flex flex-col">
      {rows.map((r) => {
        const inner = (
          <span className="flex min-h-11 items-center justify-between gap-3 py-1.5">
            <span className="flex min-w-0 items-center gap-2">
              {r.badge ? <Badge tone={r.badge.tone}>{r.badge.label}</Badge> : null}
              <span className="truncate text-sm text-ink">{r.title}</span>
            </span>
            {r.meta ? (
              <span
                dir={r.metaLtr ? "ltr" : undefined}
                className={cn("shrink-0 text-xs text-ink-muted", r.metaLtr && "font-mono")}
              >
                {r.meta}
              </span>
            ) : null}
          </span>
        );
        return (
          <li key={r.key} className="border-b border-line last:border-0">
            {r.href ? (
              <Link href={r.href} className="block hover:bg-sunken">
                {inner}
              </Link>
            ) : (
              inner
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ── Activity timeline ─────────────────────────────────────────────────────────
export type ActivityEntry = {
  key: string;
  summary: string;
  /** Pre-formatted timestamp (server formats per locale). */
  when: string;
  actor?: string | null;
};

export function ActivityTimeline({
  entries,
  emptyLabel,
}: {
  entries: ActivityEntry[];
  emptyLabel: string;
}) {
  if (entries.length === 0) return <p className="py-2 text-sm text-ink-muted">{emptyLabel}</p>;
  return (
    <ol className="flex flex-col">
      {entries.map((e) => (
        <li key={e.key} className="relative border-s-2 border-line ps-4 pb-4 last:pb-0">
          <span
            aria-hidden
            className="absolute -start-[5px] top-1.5 h-2 w-2 rounded-full bg-accent"
          />
          <p className="text-sm leading-snug text-ink">{e.summary}</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            {e.actor ? `${e.actor} · ` : ""}
            {e.when}
          </p>
        </li>
      ))}
    </ol>
  );
}

// ── Quick actions ─────────────────────────────────────────────────────────────
export type QuickAction = { key: string; label: string; href: string; icon: IconName };

export function QuickActions({ actions }: { actions: QuickAction[] }) {
  if (actions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((a) => (
        <Link
          key={a.key}
          href={a.href}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line bg-card px-3 text-sm font-medium text-ink shadow-card transition-colors hover:border-accent-line hover:bg-accent-soft/40"
        >
          <span className="text-accent" aria-hidden>
            <Icon name={a.icon} size={18} />
          </span>
          {a.label}
        </Link>
      ))}
    </div>
  );
}

// ── Locked (un-entitled) card ─────────────────────────────────────────────────
/**
 * Compact locked-state card for dashboard slots whose capability is off —
 * honest absent state with the unlock path (mirrors <LockedFeature>, which
 * stays the full-page treatment).
 */
export function LockedCard({
  title,
  description,
  href,
  ctaLabel,
}: {
  title: string;
  description: string;
  /** Subscription page for billing viewers; omit to render without a CTA. */
  href?: string;
  ctaLabel?: string;
}) {
  return (
    <Card className="border-dashed">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-ink-muted" aria-hidden>
          <Icon name="lock" size={18} />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <p className="mt-1 text-xs text-ink-muted">{description}</p>
          {href && ctaLabel ? (
            <Link
              href={href}
              className="mt-2 inline-flex min-h-9 items-center text-sm font-medium text-accent hover:underline"
            >
              {ctaLabel}
            </Link>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

// ── Skeletons (loading.tsx) ───────────────────────────────────────────────────
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-sunken", className)} />;
}

export function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <Skeleton className="h-7 w-40" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    </div>
  );
}
