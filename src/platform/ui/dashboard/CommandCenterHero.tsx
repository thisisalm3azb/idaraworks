import Link from "next/link";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "../icons";

/**
 * Owner/Admin command-center hero (microstep 001).
 *
 * A purely presentational, server-rendered panel that replaces the plain Today
 * heading + KPI row on the Owner screen: layered graphite-navy surfaces (hero
 * tokens, derived from existing semantic tokens), a faint aria-hidden grid +
 * orbital SVG on the visual side, and the SAME four real KPI signals the old
 * row carried — values, tones and destinations are composed by the CALLER.
 *
 * Truthfulness law: this component renders exactly what it is given. It has no
 * health-score, percentage, trend or revenue props and can invent nothing.
 * Motion: one slow orbital drift, defined only under prefers-reduced-motion:
 * no-preference (globals.css .cch-orbit) — reduced-motion users get a static
 * hero. Decorative SVG is aria-hidden and non-interactive.
 */

export type HeroTone = "neutral" | "success" | "warning" | "danger";

export type HeroSignal = {
  key: string;
  label: string;
  /** Pre-formatted display value (a real count — never a computed score). */
  value: string;
  icon: IconName;
  tone?: HeroTone;
  /** Destination of the whole tile; omitted → static tile (tests, previews). */
  href?: string;
};

/** Tone → tile edge accent. Non-text decoration; values stay ink-inverse. */
const TONE_EDGE: Record<HeroTone, string> = {
  neutral: "border-t-hero-line",
  success: "border-t-success",
  warning: "border-t-warning",
  danger: "border-t-danger",
};

/**
 * Build the Owner hero's four signals from the REAL dashboard counts the page
 * already receives (active / done-this-week / approvals-pending / overdue).
 * Pure + unit-tested: destinations and tone rules mirror the old KPI row
 * exactly; nothing here computes, estimates, or invents a metric.
 */
export function buildOwnerSignals(args: {
  orgId: string;
  labels: { active: string; doneWeek: string; approvals: string; overdue: string };
  counts: {
    active: number;
    doneThisWeek: number;
    approvalsPending: number;
    overdue: number;
  };
}): HeroSignal[] {
  const { orgId, labels, counts } = args;
  return [
    {
      key: "active_jobs",
      label: labels.active,
      value: String(counts.active),
      icon: "briefcase",
      tone: "neutral",
      href: `/o/${orgId}/jobs`,
    },
    {
      key: "done_week",
      label: labels.doneWeek,
      value: String(counts.doneThisWeek),
      icon: "check",
      tone: counts.doneThisWeek > 0 ? "success" : "neutral",
      href: `/o/${orgId}/jobs`,
    },
    {
      key: "approvals_waiting",
      label: labels.approvals,
      value: String(counts.approvalsPending),
      icon: "inbox",
      tone: counts.approvalsPending > 0 ? "warning" : "neutral",
      href: `/o/${orgId}/approvals`,
    },
    {
      key: "overdue_jobs",
      label: labels.overdue,
      value: String(counts.overdue),
      icon: "alert",
      tone: counts.overdue > 0 ? "danger" : "neutral",
      href: `/o/${orgId}/jobs?filter=overdue`,
    },
  ];
}

/** The decorative operational visualization: faint grid + orbital geometry.
 * Pure inline SVG, aria-hidden, pointer-events-none; the orbit group carries
 * the motion-safe-only drift class. */
function OperationalOrbit() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 420 260"
      className="pointer-events-none absolute inset-y-0 end-0 hidden h-full w-auto opacity-70 sm:block"
      preserveAspectRatio="xMaxYMid slice"
    >
      {/* faint engineering grid */}
      <defs>
        <pattern id="cch-grid" width="28" height="28" patternUnits="userSpaceOnUse">
          <path
            d="M28 0H0v28"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.07"
            strokeWidth="1"
          />
        </pattern>
        <radialGradient id="cch-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="420" height="260" fill="url(#cch-grid)" className="text-ink-inverse" />
      {/* soft accent core */}
      <circle cx="290" cy="130" r="86" fill="url(#cch-glow)" />
      {/* orbital geometry — drifts slowly (motion-safe only) */}
      <g className="cch-orbit" style={{ transformBox: "fill-box" }}>
        <ellipse
          cx="290"
          cy="130"
          rx="118"
          ry="52"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="1"
          className="text-ink-inverse"
          transform="rotate(-16 290 130)"
        />
        <ellipse
          cx="290"
          cy="130"
          rx="78"
          ry="110"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.14"
          strokeWidth="1"
          className="text-ink-inverse"
          transform="rotate(-16 290 130)"
        />
        {/* signal nodes on the orbits */}
        <circle cx="172" cy="146" r="3" fill="var(--accent)" fillOpacity="0.9" />
        <circle
          cx="352"
          cy="74"
          r="2.5"
          fill="currentColor"
          className="text-ink-inverse"
          fillOpacity="0.55"
        />
        <circle
          cx="368"
          cy="196"
          r="2"
          fill="currentColor"
          className="text-ink-inverse"
          fillOpacity="0.4"
        />
      </g>
      {/* static signal paths toward the core */}
      <path
        d="M40 210 C 130 200, 190 168, 260 142"
        fill="none"
        stroke="var(--accent)"
        strokeOpacity="0.35"
        strokeWidth="1.5"
        strokeDasharray="2 6"
        strokeLinecap="round"
      />
      <path
        d="M60 52 C 140 74, 200 100, 262 120"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.16"
        strokeWidth="1"
        strokeDasharray="2 6"
        strokeLinecap="round"
        className="text-ink-inverse"
      />
    </svg>
  );
}

function SignalTile({ signal }: { signal: HeroSignal }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 whitespace-normal break-words text-xs font-medium leading-snug text-hero-dim">
          {signal.label}
        </span>
        <span className="shrink-0 text-hero-dim" aria-hidden>
          <Icon name={signal.icon} size={16} />
        </span>
      </div>
      <span
        dir="ltr"
        className="mt-1 block font-mono text-2xl font-semibold leading-tight tabular-nums text-ink-inverse"
      >
        {signal.value}
      </span>
    </>
  );
  const cls = cn(
    "flex min-h-[64px] flex-col justify-between rounded-md border border-hero-line border-t-2 bg-hero-raised p-3 shadow-pop",
    TONE_EDGE[signal.tone ?? "neutral"],
  );
  return signal.href ? (
    <Link
      href={signal.href}
      className={cn(
        cls,
        "motion-safe:transition-transform motion-safe:duration-200 motion-safe:hover:-translate-y-0.5",
      )}
    >
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function CommandCenterHero({
  eyebrow,
  heading,
  asOf,
  roleChip,
  signals,
  action,
}: {
  /** e.g. "Operations command center" (translated by the caller). */
  eyebrow: string;
  /** e.g. "Your operation, at a glance" (translated by the caller). */
  heading: string;
  /** The already-formatted "as of" line (label + real date), composed by the caller. */
  asOf: string;
  /** Optional small role chip (e.g. the translated screen name). */
  roleChip?: string;
  /** The four REAL KPI signals (see buildOwnerSignals). */
  signals: HeroSignal[];
  /** One existing navigation action (e.g. the weekly view), permission-gated by the caller. */
  action?: { label: string; href: string };
}) {
  return (
    <section className="relative overflow-hidden rounded-lg bg-hero text-ink-inverse shadow-pop">
      <OperationalOrbit />
      {/* content sits above the decorative layer */}
      <div className="relative flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-widest text-accent-line">
              {eyebrow}
            </p>
            <h1 className="mt-1 text-2xl font-semibold leading-tight sm:text-3xl">{heading}</h1>
            <p className="mt-1 text-xs text-hero-dim">{asOf}</p>
          </div>
          {roleChip ? (
            <span className="shrink-0 rounded-sm border border-hero-line px-2 py-0.5 text-xs font-medium text-hero-dim">
              {roleChip}
            </span>
          ) : null}
        </div>

        {/* signal deck — restrained perspective on wide screens only */}
        <div className="lg:[perspective:1600px]">
          <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4 lg:[transform:rotateX(2deg)] lg:[transform-style:preserve-3d]">
            {signals.map((sig) => (
              <SignalTile key={sig.key} signal={sig} />
            ))}
          </div>
        </div>

        {action ? (
          <div>
            <Link
              href={action.href}
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-hero-line px-4 text-sm font-medium text-ink-inverse transition-colors hover:bg-hero-raised"
            >
              {action.label}
              <span aria-hidden>
                <Icon name="calendar" size={16} />
              </span>
            </Link>
          </div>
        ) : null}
      </div>
    </section>
  );
}
