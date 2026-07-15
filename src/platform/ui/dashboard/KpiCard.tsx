import Link from "next/link";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "../icons";
import type { Delta } from "./geometry";

/**
 * One KPI tile (U5 §3): value + label + optional delta chip and icon; the whole
 * tile links to its filtered view. Value renders dir="ltr" (numbers law).
 */
export function KpiCard({
  label,
  value,
  href,
  icon,
  delta,
  sub,
  tone = "neutral",
}: {
  label: string;
  /** Pre-formatted display value (count or money). */
  value: string;
  href?: string;
  icon?: IconName;
  delta?: Delta | null;
  /** Small secondary line under the value (e.g. "3 overdue"). */
  sub?: string | null;
  tone?: "neutral" | "warning" | "danger" | "success";
}) {
  const toneText =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : tone === "success"
          ? "text-success"
          : "text-ink";
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-ink-secondary">{label}</span>
        {icon ? (
          <span className="text-ink-muted" aria-hidden>
            <Icon name={icon} size={18} />
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex min-w-0 items-baseline gap-2">
        <span
          dir="ltr"
          title={value}
          className={cn(
            "min-w-0 truncate font-mono text-2xl font-semibold leading-tight tabular-nums",
            toneText,
          )}
        >
          {value}
        </span>
        {delta ? (
          <span
            dir="ltr"
            className={cn(
              "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[11px] font-medium",
              delta.direction === "up" && "bg-success-soft text-success",
              delta.direction === "down" && "bg-danger-soft text-danger",
              delta.direction === "flat" && "bg-sunken text-ink-muted",
            )}
          >
            {delta.label}
          </span>
        ) : null}
      </div>
      {sub ? <p className="mt-0.5 truncate text-xs text-ink-muted">{sub}</p> : null}
    </>
  );
  const frame = "block min-h-11 min-w-0 rounded-lg border border-line bg-card p-3 shadow-card";
  if (href) {
    return (
      <Link
        href={href}
        className={cn(frame, "transition-colors hover:border-accent-line hover:bg-accent-soft/40")}
      >
        {body}
      </Link>
    );
  }
  return <div className={frame}>{body}</div>;
}
