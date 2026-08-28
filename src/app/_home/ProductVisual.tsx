import { Icon, type IconName } from "@/platform/ui";

/**
 * Homepage hero visual — "The Living Business Surface" (H3.1, polished H3.2).
 *
 * One spatial composition: a warm perspective operating surface with an
 * embedded channel shaped around the active workflow. The business's own
 * operational signals settle onto the surface and connect into one operation,
 * while a quiet recessed dock ("Add what you need") and an unused branch
 * channel show the surface has room the business can shape later.
 *
 * Two conceptual states in the SAME server-rendered markup:
 *  - State A (separate): signals ghosted and lightly scattered, the channel
 *    not yet formed, the links not drawn, the dock quiet on the surface.
 *  - State B (connected): the channel forms in the surface, the signals seat
 *    into position along it, the central work object rises with the strongest
 *    elevation, the links draw the active path, and one pulse crosses it.
 *
 * Truthful by construction: no names, counts, amounts, dates or percentages.
 * Statuses are qualitative; terminology flexibility is stated as identity
 * ("Called Order in your workspace"); there is exactly ONE payment outcome.
 *
 * Depth communicates state: signal chips sit partially seated (soft, low
 * shadow), standing objects carry a card shadow, the work object is lifted
 * with a brand-tinted shadow, and the settled payment outcome rests back into
 * the surface with no elevation. Motion (>=lg, motion-safe): run-once settle,
 * channel + link fade, one pulse; everything ends stable in under ~3s.
 * Reduced motion, mobile and no-JS render the finished state immediately.
 */

/** An operational object standing on the surface. `settled` rests it back
 * into the surface (no elevation) for completed outcomes. */
function Node({
  icon,
  label,
  value,
  tone = "neutral",
  depth = "standing",
  className = "",
  fromX,
  fromY,
  delay,
}: {
  icon: IconName;
  label: string;
  value: string;
  tone?: "neutral" | "success";
  depth?: "standing" | "settled";
  className?: string;
  fromX?: string;
  fromY?: string;
  delay?: string;
}) {
  return (
    <div
      data-state="b"
      className={
        "lbs-settle flex items-center gap-2.5 rounded-lg border p-3 " +
        (depth === "settled"
          ? "border-line bg-card/85 "
          : "border-line-strong/70 bg-card shadow-card ") +
        className
      }
      style={
        {
          "--lbs-from-x": fromX,
          "--lbs-from-y": fromY,
          "--lbs-delay": delay,
        } as React.CSSProperties
      }
    >
      <span
        className={
          "flex size-8 shrink-0 items-center justify-center rounded-md " +
          (tone === "success" ? "bg-success-soft text-success" : "bg-brand-soft text-brand")
        }
      >
        <Icon name={icon} size={16} aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
          {label}
        </span>
        <span className="block truncate text-xs font-semibold text-ink">{value}</span>
      </span>
    </div>
  );
}

/** A light incoming-signal chip, partially seated into the surface. */
function SignalChip({
  icon,
  label,
  fromX,
  fromY,
  delay,
}: {
  icon: IconName;
  label: string;
  fromX?: string;
  fromY?: string;
  delay?: string;
}) {
  return (
    <span
      data-state="a"
      className="lbs-settle inline-flex items-center gap-1.5 self-start rounded-full border border-line bg-card/75 px-3 py-1.5 text-xs font-medium text-ink-secondary"
      style={
        {
          "--lbs-from-x": fromX,
          "--lbs-from-y": fromY,
          "--lbs-delay": delay,
        } as React.CSSProperties
      }
    >
      <Icon name={icon} size={13} aria-hidden />
      {label}
    </span>
  );
}

/** The active path between objects (desktop): a solid brand line with a
 * forward chevron, drawn behind the objects, carrying one pulse. */
function Connector({ dir, pulseDelay }: { dir: "ltr" | "rtl"; pulseDelay: string }) {
  return (
    <div
      className="lbs-link relative z-0 hidden h-6 w-14 items-center lg:flex"
      aria-hidden="true"
      data-state="b"
    >
      <span
        className="h-0.5 w-full rounded-full"
        style={{ background: "color-mix(in srgb, var(--accent) 55%, transparent)" }}
      />
      <span
        className="lbs-pulse absolute start-0 size-2 rounded-full bg-accent"
        data-dir={dir}
        style={{ "--lbs-pulse-delay": pulseDelay } as React.CSSProperties}
      />
      <svg
        className="absolute end-0"
        width="9"
        height="12"
        viewBox="0 0 9 12"
        aria-hidden="true"
        style={dir === "rtl" ? { transform: "scaleX(-1)" } : undefined}
      >
        <path
          d="M1.5 1.5l5 4.5-5 4.5"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/** Vertical spine stub (mobile). */
function VStub() {
  return (
    <div className="flex justify-center lg:hidden" aria-hidden="true" data-state="b">
      <span className="h-5 w-0 border-s-2 border-dotted border-accent-line" />
    </div>
  );
}

/** The quiet optional-module dock: recessed into the surface, clearly not a
 * control, showing the workspace has room the business can shape later. */
function Dock({ label, className = "" }: { label: string; className?: string }) {
  return (
    <div
      data-state="a"
      className={
        "items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong/80 px-3 py-2 text-[11px] font-medium text-ink-secondary " +
        className
      }
      style={{
        background: "color-mix(in srgb, var(--surface-sunken) 65%, transparent)",
        boxShadow: "inset 0 1px 2px rgb(28 28 26 / 0.07)",
      }}
    >
      <Icon name="plus" size={12} aria-hidden />
      {label}
    </div>
  );
}

export function ProductVisual({ t, dir }: { t: (k: string) => string; dir: "ltr" | "rtl" }) {
  return (
    <div>
      <div
        className="relative w-full overflow-hidden rounded-xl border border-line p-5 sm:p-6 lg:min-h-[370px] lg:p-7"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--surface-page) 94%, var(--warning-soft)) 0%, color-mix(in srgb, var(--surface-sunken) 86%, var(--warning-soft)) 100%)",
        }}
      >
        {/* Quiet truthfulness disclosure: visible, localized, out of the way. */}
        <span className="absolute end-4 top-3 z-20 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
          {t("home.viz.illustrative")}
        </span>

        <div role="img" aria-label={t("home.viz.aria")} className="relative lg:min-h-[312px]">
          {/* The operating surface: a warm perspective plane with an embedded
              channel shaped around the active workflow, plus an unused branch
              toward the optional-module dock (desktop only). */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 -top-14 -bottom-2 hidden lg:block"
            style={{ perspective: "1100px" }}
          >
            <div
              className="absolute inset-0 rounded-3xl border"
              style={{
                transform: "rotateX(48deg) scaleY(1.3)",
                transformOrigin: "50% 100%",
                borderColor: "color-mix(in srgb, var(--border-strong) 75%, transparent)",
                background:
                  "repeating-linear-gradient(to top, color-mix(in srgb, var(--border-strong) 26%, transparent) 0 1px, transparent 1px 44px), linear-gradient(to top, color-mix(in srgb, var(--surface-card) 76%, var(--warning-soft)) 0%, color-mix(in srgb, var(--surface-sunken) 68%, var(--warning-soft)) 100%)",
                boxShadow:
                  "inset 0 1px 0 color-mix(in srgb, white 70%, transparent), inset 0 -16px 26px -20px rgb(28 28 26 / 0.2), 0 22px 34px -22px rgb(28 28 26 / 0.3)",
              }}
            >
              <svg
                className="lbs-channel absolute inset-0 h-full w-full"
                viewBox="0 0 1000 520"
                preserveAspectRatio="none"
                aria-hidden="true"
                style={dir === "rtl" ? { transform: "scaleX(-1)" } : undefined}
              >
                {/* An unused branch: a prepared pathway toward the dock. */}
                <path
                  d="M 560 140 C 650 250 760 370 860 470"
                  fill="none"
                  strokeLinecap="round"
                  strokeWidth="26"
                  stroke="color-mix(in srgb, var(--border-strong) 55%, transparent)"
                />
                <path
                  d="M 560 140 C 650 250 760 370 860 470"
                  fill="none"
                  strokeLinecap="round"
                  strokeWidth="16"
                  stroke="color-mix(in srgb, var(--surface-card) 92%, transparent)"
                />
              </svg>
            </div>
          </div>

          <div className="relative z-10 grid grid-cols-1 items-start gap-3 lg:mt-24 lg:grid-cols-[1fr_auto_1.5fr_auto_1fr] lg:gap-2">
            {/* The formed channel: a recessed rail the operation runs along,
                drawn behind every object in the row. */}
            <div
              aria-hidden="true"
              data-state="b"
              className="lbs-channel absolute inset-x-0 top-9 z-0 hidden h-12 rounded-full border lg:block"
              style={{
                borderColor: "color-mix(in srgb, var(--border-strong) 55%, transparent)",
                background:
                  "linear-gradient(180deg, color-mix(in srgb, var(--surface-sunken) 80%, var(--warning-soft)) 0%, color-mix(in srgb, var(--surface-card) 88%, var(--warning-soft)) 100%)",
                boxShadow:
                  "inset 0 2px 4px rgb(28 28 26 / 0.09), inset 0 -1px 0 color-mix(in srgb, white 70%, transparent)",
              }}
            >
              <span
                className="absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 rounded-full"
                style={{ background: "color-mix(in srgb, var(--accent) 40%, transparent)" }}
              />
            </div>
            {/* Incoming: the business's own signals, then the accepted quote. */}
            <div className="relative z-10 flex flex-col gap-2 lg:pt-3">
              <SignalChip
                icon="users"
                label={t("home.viz.customer")}
                fromX="-16px"
                fromY="-14px"
                delay="0.1s"
              />
              <SignalChip
                icon="inbox"
                label={t("home.viz.request")}
                fromX="-10px"
                fromY="12px"
                delay="0.25s"
              />
              <Node
                icon="clipboard"
                label={t("home.viz.quote")}
                value={t("home.viz.quote_accepted")}
                className="hidden lg:flex"
                fromX="-12px"
                fromY="10px"
                delay="0.4s"
              />
            </div>

            <VStub />
            <div className="lg:pt-10">
              <Connector dir={dir} pulseDelay="1.8s" />
            </div>

            {/* The central work object: the strongest element on the surface,
                carrying the business's own word as part of its identity. */}
            <div
              data-state="b"
              className="lbs-settle relative z-10"
              style={{ "--lbs-from-y": "18px", "--lbs-delay": "0.55s" } as React.CSSProperties}
            >
              <div
                className="rounded-xl border border-accent-line bg-card p-4 lg:-translate-y-1"
                style={{
                  boxShadow:
                    "var(--elevation-2), 0 18px 30px -18px color-mix(in srgb, var(--accent) 35%, transparent)",
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand text-ink-inverse">
                      <Icon name="briefcase" size={16} aria-hidden />
                    </span>
                    <span className="text-sm font-semibold text-ink">
                      {t("home.viz.term_generic")}
                    </span>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-medium text-brand">
                    <span className="size-1.5 rounded-full bg-brand" aria-hidden />
                    {t("home.viz.work_v")}
                  </span>
                </div>

                {/* Terminology flexibility as identity, not a settings field. */}
                <p className="mt-1.5 text-[11px] leading-snug text-ink-secondary">
                  {t("home.viz.term_note")}
                </p>

                <ul className="mt-2.5 flex flex-col gap-1.5 border-t border-line pt-2.5">
                  <li className="flex items-center gap-2 text-[11px] text-ink-secondary">
                    <Icon name="users" size={12} aria-hidden className="shrink-0 text-brand" />
                    {t("home.viz.team_assigned")}
                  </li>
                  <li className="flex items-center gap-2 text-[11px] text-ink-secondary">
                    <Icon name="check" size={12} aria-hidden className="shrink-0 text-success" />
                    {t("home.viz.approval_ready")}
                  </li>
                </ul>
              </div>
            </div>

            <VStub />
            <div className="lg:pt-10">
              <Connector dir={dir} pulseDelay="2.3s" />
            </div>

            {/* Outcomes: the invoice stands connected; the single payment
                outcome settles back into the surface. */}
            <div className="relative z-10 flex flex-col gap-2 lg:pt-12">
              <Node
                icon="receipt"
                label={t("home.viz.invoice")}
                value={t("home.viz.invoice_v")}
                className="hidden lg:flex"
                fromX="14px"
                fromY="-12px"
                delay="0.7s"
              />
              <Node
                icon="banknote"
                label={t("home.viz.payment")}
                value={t("home.viz.payment_v")}
                tone="success"
                depth="settled"
                fromX="16px"
                fromY="12px"
                delay="0.85s"
              />
            </div>
          </div>

          {/* The optional-module dock, recessed at the end of the unused
              branch: the workspace keeps room the business can shape. */}
          <Dock
            label={t("home.viz.dock")}
            className="absolute bottom-1 end-10 z-10 hidden lg:flex"
          />
        </div>

        {/* Mobile keeps the adaptability cue as a quiet closing row. */}
        <Dock label={t("home.viz.dock")} className="mt-3 flex lg:hidden" />
      </div>

      {/* Visible caption: the concept in plain language, for everyone. */}
      <p className="mt-3 text-center text-sm text-ink-secondary">{t("home.viz.caption")}</p>
    </div>
  );
}
