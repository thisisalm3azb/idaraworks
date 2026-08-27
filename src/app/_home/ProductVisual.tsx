import { Icon, type IconName } from "@/platform/ui";

/**
 * Homepage hero visual — "A workspace that takes shape" (H3, blueprint §8).
 *
 * One coherent operating board built from real product objects, in two
 * conceptual states carried by the SAME markup:
 *
 *  - State A (`data-state="a"`): the simple flow every business starts with —
 *    customer → work → cash — connected by one information spine.
 *  - State B (`data-state="b"`): the same objects gaining useful structure —
 *    an accepted quote, a stage progression, team and approval feeding the
 *    central work object, an issued invoice, and a terminology treatment
 *    showing the work object called by the business's own word ("Order").
 *
 * Motion (desktop, motion-safe only, in globals.css): the B elements settle in
 * ONCE (transform/opacity, staggered, ~1.5s), then a single information pulse
 * crosses each connector ONCE and fades. Nothing loops; the final frame is the
 * complete, stable State B. Reduced-motion users, mobile widths and no-JS
 * visitors get the finished State B immediately — the component is fully
 * server-rendered and depends on no hydration.
 *
 * Depth is layered, not decorative: the central work object sits raised
 * (accent border, deeper shadow, slight lift) over quieter supporting
 * surfaces. Everything is tokens + inline SVG; every value is illustrative
 * and the board is badged as such, with a visible caption stating the concept.
 * No monetary amount is shown — cash is a qualitative "Received" outcome.
 */
function Node({
  icon,
  label,
  value,
  tone = "neutral",
  state,
  className = "",
  delay,
}: {
  icon: IconName;
  label: string;
  value: string;
  tone?: "neutral" | "success";
  state: "a" | "b";
  className?: string;
  delay?: string;
}) {
  return (
    <div
      data-state={state}
      className={
        "flex items-center gap-2.5 rounded-lg border border-line bg-card p-2.5 shadow-card " +
        (state === "b" ? "icv-shape " : "") +
        className
      }
      style={delay ? ({ "--icv-delay": delay } as React.CSSProperties) : undefined}
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

/** Horizontal spine connector (desktop): dashed rail, forward chevron, and one
 * information pulse that crosses ONCE (motion-safe; static dot otherwise). */
function Connector({ dir, pulseDelay }: { dir: "ltr" | "rtl"; pulseDelay: string }) {
  return (
    <div
      className="relative hidden h-6 w-14 items-center lg:flex"
      aria-hidden="true"
      data-state="a"
    >
      <span
        className="h-px w-full"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to right, color-mix(in srgb, var(--accent) 45%, transparent) 0 5px, transparent 5px 11px)",
        }}
      />
      <span
        className="icv-pulse absolute start-0 size-1.5 rounded-full bg-accent"
        data-dir={dir}
        style={{ "--icv-pulse-delay": pulseDelay } as React.CSSProperties}
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

/** Vertical spine stub (mobile only): keeps the customer → work → cash path
 * reading as one connected flow when the board stacks. */
function VStub() {
  return (
    <div className="flex justify-center lg:hidden" aria-hidden="true" data-state="a">
      <span className="h-5 w-0 border-s-2 border-dotted border-accent-line" />
    </div>
  );
}

export function ProductVisual({ t, dir }: { t: (k: string) => string; dir: "ltr" | "rtl" }) {
  return (
    <div>
      <div className="relative w-full overflow-hidden rounded-xl border border-line bg-gradient-to-br from-sunken to-card p-5 shadow-card sm:p-6">
        <span className="absolute end-4 top-4 z-10 inline-flex items-center rounded-full border border-line bg-card/80 px-2.5 py-1 text-[11px] font-medium text-ink-muted backdrop-blur">
          {t("home.viz.illustrative")}
        </span>

        <div
          role="img"
          aria-label={t("home.viz.aria")}
          className="mt-6 grid grid-cols-1 items-stretch gap-3 lg:grid-cols-[1fr_auto_1.35fr_auto_1fr] lg:items-center"
        >
          {/* WIN side — where the operation begins. */}
          <div className="flex flex-col gap-2">
            <Node
              icon="users"
              label={t("home.viz.customer")}
              value={t("home.viz.customer_v")}
              state="a"
            />
            <Node
              icon="clipboard"
              label={t("home.viz.quote")}
              value={t("home.viz.quote_accepted")}
              state="b"
              delay="0.3s"
              className="hidden lg:flex"
            />
          </div>

          <VStub />
          <Connector dir={dir} pulseDelay="1.7s" />

          {/* CENTRAL work object — the focus, slightly raised above the board. */}
          <div className="rounded-xl border border-accent-line bg-card p-3.5 shadow-pop lg:-translate-y-1">
            <div className="flex items-start justify-between gap-2" data-state="a">
              <span className="flex min-w-0 flex-1 items-start gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-brand text-ink-inverse">
                  <Icon name="briefcase" size={15} aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                    {t("home.viz.term_generic")}
                  </span>
                  {/* Terminology shaping: the work object carries the
                      business's own word. */}
                  <span
                    data-state="b"
                    className="icv-shape mt-0.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5"
                    style={{ "--icv-delay": "0.5s" } as React.CSSProperties}
                  >
                    <span className="rounded bg-accent-soft px-1.5 py-0.5 text-xs font-semibold text-ink">
                      &ldquo;{t("home.viz.term_custom")}&rdquo;
                    </span>
                    <span className="whitespace-nowrap text-[10px] text-ink-muted">
                      {t("home.viz.term_hint")}
                    </span>
                  </span>
                </span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-medium text-brand">
                <span className="size-1.5 rounded-full bg-brand" aria-hidden />
                {t("home.viz.work_v")}
              </span>
            </div>

            {/* Stage progression — structure the operation gained. */}
            <div
              data-state="b"
              className="icv-shape mt-3"
              style={{ "--icv-delay": "0.65s" } as React.CSSProperties}
            >
              <div className="flex items-center gap-1" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className={
                      "h-1.5 flex-1 rounded-full " + (i <= 1 ? "bg-brand" : "bg-line-strong")
                    }
                  />
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-ink-muted">{t("home.viz.work_stage")}</p>
            </div>

            {/* Team + approval feeding the work object. */}
            <div
              data-state="b"
              className="icv-shape mt-3 flex flex-wrap gap-1.5"
              style={{ "--icv-delay": "0.8s" } as React.CSSProperties}
            >
              <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-line bg-sunken px-2 py-0.5 text-[10px] text-ink-secondary">
                <Icon name="users" size={11} aria-hidden />
                <span className="font-semibold">{t("home.viz.team")}</span>
                <span>{t("home.viz.team_v")}</span>
              </span>
              <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-line bg-sunken px-2 py-0.5 text-[10px] text-ink-secondary">
                <Icon name="check" size={11} aria-hidden />
                <span className="font-semibold">{t("home.viz.approval")}</span>
                <span>{t("home.viz.approval_v")}</span>
              </span>
            </div>
          </div>

          <VStub />
          <Connector dir={dir} pulseDelay="2.5s" />

          {/* OUTCOME side — what the work becomes. No amounts: qualitative. */}
          <div className="flex flex-col gap-2">
            <Node
              icon="receipt"
              label={t("home.viz.invoice")}
              value={t("home.viz.invoice_v")}
              state="b"
              delay="0.95s"
              className="hidden lg:flex"
            />
            <Node
              icon="banknote"
              label={t("home.viz.payment")}
              value={t("home.viz.payment_v")}
              tone="success"
              state="a"
            />
            <div
              data-state="b"
              className="icv-shape flex items-center gap-1.5 rounded-lg border border-success/40 bg-success-soft px-2.5 py-1.5"
              style={{ "--icv-delay": "1.1s" } as React.CSSProperties}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
              <span className="text-[10px] font-medium uppercase tracking-wide text-success">
                {t("home.viz.status")}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Visible caption: the concept in plain language, for everyone. */}
      <p className="mt-3 text-center text-sm text-ink-secondary">{t("home.viz.caption")}</p>
    </div>
  );
}
