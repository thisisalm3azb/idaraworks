import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "../icons";

/**
 * Owner Home zones (microstep 002B — "Your business, alive").
 *
 * Purely presentational, server-rendered. Every string arrives ALREADY
 * translated; every number/money value arrives already formatted and grounded
 * (the deterministic composer + the page own truthfulness). Nothing here can
 * invent a status, score or percentage — there are no props for one.
 *
 * Depth is semantic (blueprint §7): the Brief is the identity surface, the
 * action deck is the raised working surface, Attention is the prominent
 * surface. No decorative wallpaper. All decorative SVG is aria-hidden; the
 * only motion is the existing motion-safe hover lift.
 */

// ── Business Brief ────────────────────────────────────────────────────────────

export type BriefChipView = {
  key: string;
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
  href?: string;
};

const CHIP_TONE: Record<BriefChipView["tone"], string> = {
  neutral: "border-line bg-card text-ink",
  success: "border-success/40 bg-success-soft text-success",
  warning: "border-warning/40 bg-warning-soft text-warning",
  danger: "border-danger/40 bg-danger-soft text-danger",
};

export function BusinessBrief({
  orgName,
  logo,
  dateLine,
  sentence,
  chips,
}: {
  orgName: string;
  /** Already-resolved logo img (from the existing OrgLogo pattern) or null → initials. */
  logo: ReactNode | null;
  dateLine: string;
  sentence: string;
  chips: BriefChipView[];
}) {
  const initials = orgName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
  return (
    <section className="rounded-lg border border-line bg-card p-5 shadow-pop sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {logo ?? (
            <span
              aria-hidden
              className="flex size-11 shrink-0 items-center justify-center rounded-md bg-accent-soft font-semibold text-ink"
            >
              {initials}
            </span>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold leading-tight text-ink sm:text-3xl">
              {orgName}
            </h1>
            <p className="mt-0.5 text-xs text-ink-muted">{dateLine}</p>
          </div>
        </div>
      </div>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink">{sentence}</p>
      {chips.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((c) =>
            c.href ? (
              <Link
                key={c.key}
                href={c.href}
                className={cn(
                  "inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium",
                  CHIP_TONE[c.tone],
                )}
              >
                {c.label}
              </Link>
            ) : (
              <span
                key={c.key}
                className={cn(
                  "inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium",
                  CHIP_TONE[c.tone],
                )}
              >
                {c.label}
              </span>
            ),
          )}
        </div>
      ) : null}
    </section>
  );
}

// ── Next Best Actions ────────────────────────────────────────────────────────

export type HomeActionView = {
  key: string;
  title: string;
  reason?: string;
  href: string;
  icon: IconName;
  urgency: "decide" | "overdue" | "review" | "money" | "setup" | "create";
};

const URGENCY_EDGE: Record<HomeActionView["urgency"], string> = {
  decide: "border-s-warning",
  overdue: "border-s-danger",
  review: "border-s-info",
  money: "border-s-warning",
  setup: "border-s-accent-line",
  create: "border-s-line-strong",
};

export function NextBestActions({ title, actions }: { title: string; actions: HomeActionView[] }) {
  if (actions.length === 0) return null;
  return (
    <section aria-label={title}>
      <h2 className="mb-2 text-base font-semibold text-ink">{title}</h2>
      <ol className="flex flex-col gap-2">
        {actions.map((a, idx) => (
          <li key={a.key}>
            <Link
              href={a.href}
              className={cn(
                "flex min-h-[56px] items-center gap-3 rounded-md border border-line border-s-4 bg-card p-3 shadow-pop",
                "motion-safe:transition-transform motion-safe:duration-150 motion-safe:hover:-translate-y-0.5",
                URGENCY_EDGE[a.urgency],
              )}
            >
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken text-ink-secondary"
              >
                <Icon name={a.icon} size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold leading-snug text-ink">{a.title}</span>
                {a.reason ? (
                  <span className="mt-0.5 block text-xs leading-snug text-ink-muted">
                    {a.reason}
                  </span>
                ) : null}
              </span>
              <span
                aria-hidden
                dir="ltr"
                className="shrink-0 font-mono text-xs font-medium text-ink-muted"
              >
                {idx + 1}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── Attention ────────────────────────────────────────────────────────────────

export type AttentionRowView = {
  key: string;
  label: string;
  severity: "info" | "warning" | "critical";
  severityLabel: string;
  href: string;
};

const SEV_DOT: Record<AttentionRowView["severity"], string> = {
  info: "bg-info",
  warning: "bg-warning",
  critical: "bg-danger",
};

export function AttentionZone({
  title,
  rows,
  viewAllLabel,
  viewAllHref,
}: {
  title: string;
  rows: AttentionRowView[];
  viewAllLabel: string;
  viewAllHref: string;
}) {
  if (rows.length === 0) return null;
  return (
    <section
      aria-label={title}
      className="rounded-lg border border-warning/50 bg-card p-4 shadow-pop"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <Link href={viewAllHref} className="text-xs font-medium text-accent hover:underline">
          {viewAllLabel}
        </Link>
      </div>
      <ul className="flex flex-col">
        {rows.map((r) => (
          <li key={r.key}>
            <Link
              href={r.href}
              className="flex min-h-11 items-center gap-2.5 rounded-md px-1.5 py-2 hover:bg-sunken"
            >
              <span
                aria-hidden
                className={cn("size-2 shrink-0 rounded-full", SEV_DOT[r.severity])}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{r.label}</span>
              <span className="shrink-0 text-xs text-ink-muted">{r.severityLabel}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Setup Progress (empty state) ─────────────────────────────────────────────

export type SetupStepView = {
  key: string;
  label: string;
  done: boolean;
  href?: string;
  unlocks?: string;
};

/** Small teaching diagram: how work will flow once it exists. Decorative
 * (aria-hidden) with the caption carrying the meaning as text. */
function FlowTeachingDiagram({ from, mid, to }: { from: string; mid: string; to: string }) {
  return (
    <div className="mt-3 rounded-md bg-sunken p-3">
      <svg aria-hidden="true" viewBox="0 0 300 44" className="h-11 w-full max-w-xs">
        {[24, 150, 276].map((cx, k) => (
          <circle
            key={k}
            cx={cx}
            cy="18"
            r="12"
            fill="none"
            stroke="var(--accent)"
            strokeOpacity={0.55}
            strokeWidth="1.5"
          />
        ))}
        <path
          d="M38 18 H 136 M164 18 H 262"
          stroke="var(--accent)"
          strokeOpacity="0.35"
          strokeWidth="1.5"
          strokeDasharray="3 5"
          strokeLinecap="round"
        />
      </svg>
      <p className="mt-1 text-xs leading-snug text-ink-muted">
        {from} ← → {mid} ← → {to}
      </p>
    </div>
  );
}

export function SetupProgress({
  title,
  steps,
  diagram,
}: {
  title: string;
  steps: SetupStepView[];
  /** Terminology-resolved captions for the teaching diagram (order: start → mid → end). */
  diagram: { from: string; mid: string; to: string; caption: string };
}) {
  const next = steps.find((s) => !s.done);
  return (
    <section aria-label={title} className="rounded-lg border border-line bg-card p-4 shadow-pop">
      <h2 className="mb-2 text-base font-semibold text-ink">{title}</h2>
      <ul className="flex flex-col gap-1.5">
        {steps.map((s) => {
          const isNext = next?.key === s.key;
          const inner = (
            <>
              <span
                aria-hidden
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px]",
                  s.done
                    ? "border-success bg-success-soft text-success"
                    : isNext
                      ? "border-accent-line bg-accent-soft text-ink"
                      : "border-line text-ink-muted",
                )}
              >
                {s.done ? <Icon name="check" size={12} /> : null}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 text-sm leading-snug",
                  s.done ? "text-ink-muted line-through decoration-line" : "text-ink",
                  isNext && "font-medium",
                )}
              >
                {s.label}
                {isNext && s.unlocks ? (
                  <span className="ms-2 text-xs font-normal text-ink-muted">({s.unlocks})</span>
                ) : null}
              </span>
            </>
          );
          return (
            <li key={s.key}>
              {!s.done && s.href ? (
                <Link
                  href={s.href}
                  className="flex min-h-11 items-center gap-2.5 rounded-md px-1.5 hover:bg-sunken"
                >
                  {inner}
                </Link>
              ) : (
                <div className="flex min-h-11 items-center gap-2.5 px-1.5">{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="sr-only">{diagram.caption}</p>
      <FlowTeachingDiagram from={diagram.from} mid={diagram.mid} to={diagram.to} />
    </section>
  );
}

// ── Compact capabilities row (replaces subscription strip on Owner Home) ─────

export function CapabilitiesRow({
  label,
  manageLabel,
  manageHref,
}: {
  label: string;
  manageLabel?: string;
  manageHref?: string;
}) {
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-sunken px-3 py-2">
      <span className="text-xs text-ink-secondary">{label}</span>
      {manageHref && manageLabel ? (
        <Link href={manageHref} className="text-xs font-medium text-accent hover:underline">
          {manageLabel}
        </Link>
      ) : null}
    </div>
  );
}
