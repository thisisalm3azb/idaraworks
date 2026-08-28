import { Icon, type IconName } from "@/platform/ui";

/**
 * Homepage hero visual — "The Living Business Surface" (H3.1).
 *
 * One spatial composition: a restrained perspective surface (the shared
 * operating environment) with the business's own operational signals settling
 * onto it. Two conceptual states carried by the SAME server-rendered markup:
 *
 *  - State A (separate): the signals are present but lightly scattered above
 *    the surface, and the connections are not yet drawn.
 *  - State B (connected): the same signals settle into one clear operating
 *    flow (customer / request -> quote -> work -> invoice -> payment), the
 *    central work object rises above the surface, the links fade in, and one
 *    information pulse crosses the flow once.
 *
 * Truthful by construction: no company or person names, no monetary values,
 * no counts, no percentages. Statuses are qualitative (Accepted, In progress,
 * Team assigned, Approval ready, Issued, Received) and the terminology
 * treatment is explicit: "Your term: Order". Exactly ONE payment outcome.
 *
 * Depth is layered, not decorative: the perspective plane is the base, signal
 * chips sit close to it, the quote/invoice objects stand on it, and the work
 * object is lifted above it with the strongest elevation. Faint dashed module
 * slots on the plane imply the surface can be arranged around the business.
 *
 * Motion (>=lg, motion-safe only, in globals.css): a run-once settle of every
 * object from its scattered State-A offset, then the links fade in, then one
 * pulse crosses each connector once. Everything ends stable. Reduced motion,
 * mobile and no-JS render the finished State B immediately; the component is
 * fully server-rendered with no hydration dependency.
 */

/** A quiet operational object standing on the surface. */
function Node({
  icon,
  label,
  value,
  tone = "neutral",
  className = "",
  fromX,
  fromY,
  delay,
}: {
  icon: IconName;
  label: string;
  value: string;
  tone?: "neutral" | "success";
  className?: string;
  fromX?: string;
  fromY?: string;
  delay?: string;
}) {
  return (
    <div
      data-state="b"
      className={
        "lbs-settle flex items-center gap-2.5 rounded-lg border border-line bg-card p-3 shadow-card " +
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
        <span className="block text-[10px] font-medium uppercase tracking-wide text-ink-muted">
          {label}
        </span>
        <span className="block truncate text-xs font-semibold text-ink">{value}</span>
      </span>
    </div>
  );
}

/** A light incoming-signal chip, sitting close to the surface. */
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
      className="lbs-settle inline-flex items-center gap-1.5 self-start rounded-full border border-line bg-card/90 px-3 py-1.5 text-xs font-medium text-ink-secondary shadow-card"
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

/** Horizontal spine connector (desktop): sits BEHIND the objects, fades in
 * with State B, and carries one information pulse that crosses once. */
function Connector({ dir, pulseDelay }: { dir: "ltr" | "rtl"; pulseDelay: string }) {
  return (
    <div
      className="lbs-link relative z-0 hidden h-6 w-12 items-center lg:flex"
      aria-hidden="true"
      data-state="b"
    >
      <span
        className="h-px w-full"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to right, color-mix(in srgb, var(--accent) 50%, transparent) 0 5px, transparent 5px 11px)",
        }}
      />
      <span
        className="lbs-pulse absolute start-0 size-1.5 rounded-full bg-accent"
        data-dir={dir}
        style={{ "--lbs-pulse-delay": pulseDelay } as React.CSSProperties}
      />
      <svg
        className="absolute end-0"
        width="7"
        height="10"
        viewBox="0 0 7 10"
        aria-hidden="true"
        style={dir === "rtl" ? { transform: "scaleX(-1)" } : undefined}
      >
        <path
          d="M1 1l4 4-4 4"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/** Vertical spine stub (mobile): keeps the flow reading connected when the
 * simplified static composition stacks. */
function VStub() {
  return (
    <div className="flex justify-center lg:hidden" aria-hidden="true" data-state="b">
      <span className="h-5 w-0 border-s-2 border-dotted border-accent-line" />
    </div>
  );
}

export function ProductVisual({ t, dir }: { t: (k: string) => string; dir: "ltr" | "rtl" }) {
  return (
    <div>
      <div className="relative w-full overflow-hidden rounded-xl border border-line bg-gradient-to-b from-page to-sunken p-5 sm:p-6 lg:min-h-[430px] lg:p-8">
        <span className="absolute end-4 top-4 z-20 inline-flex items-center rounded-full border border-line bg-card/80 px-2.5 py-1 text-[11px] font-medium text-ink-muted backdrop-blur">
          {t("home.viz.illustrative")}
        </span>

        {/* The shared operating surface: a restrained perspective plane with a
            faint structural grid and two empty module slots, implying the
            environment is arranged around the business (desktop only). */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-4 bottom-4 top-10 hidden lg:block"
          style={{ perspective: "1100px" }}
        >
          <div
            className="absolute inset-0 rounded-3xl border border-line-strong/60"
            style={{
              transform: "rotateX(52deg) scaleY(1.25)",
              transformOrigin: "50% 100%",
              background:
                "linear-gradient(to top, color-mix(in srgb, var(--surface-card) 88%, var(--accent)) 0%, var(--surface-sunken) 100%)," +
                "repeating-linear-gradient(to right, color-mix(in srgb, var(--accent) 7%, transparent) 0 1px, transparent 1px 56px)," +
                "repeating-linear-gradient(to top, color-mix(in srgb, var(--accent) 7%, transparent) 0 1px, transparent 1px 44px)",
              backgroundBlendMode: "multiply",
              boxShadow:
                "inset 0 1px 0 color-mix(in srgb, white 65%, transparent), 0 18px 30px -18px rgb(28 28 26 / 0.25)",
            }}
          >
            {/* Empty module slots: the surface has room shaped for more. */}
            <span className="absolute bottom-8 start-10 h-10 w-24 rounded-lg border border-dashed border-line-strong/70" />
            <span className="absolute bottom-10 end-12 h-10 w-20 rounded-lg border border-dashed border-line-strong/70" />
          </div>
        </div>

        <div
          role="img"
          aria-label={t("home.viz.aria")}
          className="relative z-10 mt-8 grid grid-cols-1 items-stretch gap-3 lg:mt-24 lg:grid-cols-[1fr_auto_1.5fr_auto_1fr] lg:items-center lg:gap-2"
        >
          {/* Incoming side: the business's own signals, then the accepted quote. */}
          <div className="relative z-10 flex flex-col gap-2">
            <SignalChip
              icon="users"
              label={t("home.viz.customer")}
              fromX="-14px"
              fromY="-18px"
              delay="0.15s"
            />
            <SignalChip
              icon="inbox"
              label={t("home.viz.request")}
              fromX="-8px"
              fromY="14px"
              delay="0.3s"
            />
            <Node
              icon="clipboard"
              label={t("home.viz.quote")}
              value={t("home.viz.quote_accepted")}
              className="hidden lg:flex"
              fromX="-12px"
              fromY="10px"
              delay="0.45s"
            />
          </div>

          <VStub />
          <Connector dir={dir} pulseDelay="2s" />

          {/* The central work object: the strongest element, lifted above the
              surface, carrying the business's own word for its work. */}
          <div
            data-state="b"
            className="lbs-settle relative z-10"
            style={{ "--lbs-from-y": "16px", "--lbs-delay": "0.6s" } as React.CSSProperties}
          >
            <div className="rounded-xl border border-accent-line bg-card p-4 shadow-pop lg:-translate-y-2">
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

              {/* Terminology shaping, stated explicitly. */}
              <p className="mt-2.5 rounded-md bg-accent-soft px-2.5 py-1.5 text-[11px] font-medium text-ink">
                {t("home.viz.term_label")}: {t("home.viz.term_custom")}
              </p>

              {/* The operating state, qualitative only. */}
              <ul className="mt-2.5 flex flex-col gap-1.5">
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
          <Connector dir={dir} pulseDelay="2.6s" />

          {/* Outcome side: the document the work becomes, and ONE payment
              outcome settling back into the connected surface. */}
          <div className="relative z-10 flex flex-col gap-2 lg:pt-6">
            <Node
              icon="receipt"
              label={t("home.viz.invoice")}
              value={t("home.viz.invoice_v")}
              className="hidden lg:flex"
              fromX="12px"
              fromY="-14px"
              delay="0.75s"
            />
            <Node
              icon="banknote"
              label={t("home.viz.payment")}
              value={t("home.viz.payment_v")}
              tone="success"
              fromX="14px"
              fromY="12px"
              delay="0.9s"
            />
          </div>
        </div>
      </div>

      {/* Visible caption: the concept in plain language, for everyone. */}
      <p className="mt-3 text-center text-sm text-ink-secondary">{t("home.viz.caption")}</p>
    </div>
  );
}
