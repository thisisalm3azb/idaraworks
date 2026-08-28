import { Icon, type IconName } from "@/platform/ui";

/**
 * Homepage hero visual: "The Living Control Surface" (H3.3B, the approved
 * Intelligent Clay direction: study Concept C combined with Concept A's single
 * continuous operational path).
 *
 * One compact molded business surface. Every operational zone is formed from
 * the same warm material, and depth communicates hierarchy:
 *  - Customer and Request are shallow debossed incoming signals,
 *  - Quote is a low formed decision point,
 *  - Work is the dominant raised plateau (team and approval live inside it,
 *    and the business's own word for work is part of its identity),
 *  - Invoice is a downstream formed zone,
 *  - Payment is a settled outcome embedded back into the surface, and
 *  - one labelled capability socket (plus a small unlabelled one on desktop)
 *    is a quiet recessed area showing available capacity.
 *
 * One continuous operational path is carved into the surface. It starts under
 * the incoming signals, dives beneath Quote, rises under the Work plateau,
 * continues down through Invoice and ends at Payment, so the visible groove
 * segments read as one flow passing beneath the formed stations rather than an
 * arrow diagram drawn on top.
 *
 * Desktop layout is a fixed 500x372 canvas with stepped scaling (0.9 at lg,
 * full size from xl), which keeps the carved path and the zones in exact
 * registration at every width >= lg. Mobile renders the same nodes as an
 * intentional vertical composition with short carved stubs (static, finished
 * state). RTL mirrors the zones via logical positions and the carved path via
 * one mirrored wrapper.
 *
 * Truthful by construction: no names, counts, amounts, dates or percentages;
 * statuses are qualitative; exactly ONE payment outcome. Motion (>= lg,
 * motion-safe only): zones settle once from a lightly unformed state, the
 * channel forms, the path draws itself once, one pulse crosses it, and
 * everything ends stable in under ~3s. Reduced motion, mobile and no-JS render
 * the finished connected state immediately; the pulse is motion-only.
 */

/* The single continuous operational path, in canvas coordinates (500x372).
 * Start: below the incoming signals. It passes beneath Quote, the Work
 * plateau and Invoice, ending at the Payment well. */
const CARVE_PATH =
  "M 46 140 C 64 184, 104 214, 150 222 C 196 230, 232 226, 268 200 " +
  "C 296 180, 308 172, 330 168 C 362 166, 388 176, 398 200 " +
  "C 406 224, 410 244, 412 262 C 413 274, 412 280, 410 290";

/* Warm material recipes shared by every formed zone. */
const warm = (token: string, pct: number) =>
  `color-mix(in srgb, var(${token}) ${pct}%, var(--warning-soft))`;
const EXTRUDE = "color-mix(in srgb, var(--border-strong) 85%, var(--warning-soft))";
const EXTRUDE_DEEP = "color-mix(in srgb, var(--border-strong) 90%, black)";
const INSET_SHADOW =
  "inset 0 2px 4px rgb(28 28 26 / 0.12), inset 0 -1px 0 color-mix(in srgb, white 70%, transparent)";

/** A shallow debossed incoming-signal pill, pressed into the surface. */
function Signal({
  icon,
  label,
  className = "",
  fromX,
  fromY,
  delay,
}: {
  icon: IconName;
  label: string;
  className?: string;
  fromX?: string;
  fromY?: string;
  delay?: string;
}) {
  return (
    <span
      data-lcs="signal"
      className={
        "lcs-settle inline-flex items-center gap-1.5 self-start rounded-full px-3 py-1.5 text-xs font-medium text-ink lg:absolute " +
        className
      }
      style={
        {
          background: warm("--surface-sunken", 88),
          boxShadow: INSET_SHADOW,
          "--lcs-from-x": fromX,
          "--lcs-from-y": fromY,
          "--lcs-delay": delay,
        } as React.CSSProperties
      }
    >
      <Icon name={icon} size={13} aria-hidden className="shrink-0 text-ink-secondary" />
      {label}
    </span>
  );
}

/** A formed zone raised from the surface material (Quote, Invoice). The
 * extrusion height expresses how much the zone stands up from the surface. */
function Formed({
  icon,
  label,
  value,
  lift,
  className = "",
  fromX,
  fromY,
  delay,
}: {
  icon: IconName;
  label: string;
  value: string;
  lift: number;
  className?: string;
  fromX?: string;
  fromY?: string;
  delay?: string;
}) {
  return (
    <div
      data-lcs="formed"
      className={
        "lcs-settle flex items-center gap-2.5 rounded-lg border border-line-strong/50 p-3 lg:absolute lg:px-3 lg:py-2 " +
        className
      }
      style={
        {
          background: warm("--surface-card", 88),
          boxShadow: `0 ${lift}px 0 ${EXTRUDE}, var(--elevation-1)`,
          "--lcs-from-x": fromX,
          "--lcs-from-y": fromY,
          "--lcs-delay": delay,
        } as React.CSSProperties
      }
    >
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand lg:hidden"
        aria-hidden="true"
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

/** A quiet recessed capability socket: available capacity, not a control. */
function Socket({
  label,
  className = "",
  delay,
}: {
  label?: string;
  className?: string;
  delay?: string;
}) {
  return (
    <div
      data-lcs="socket"
      className={
        "lcs-settle flex items-center justify-center rounded-lg border border-dashed border-line-strong/80 px-3 py-2.5 text-center text-[11px] font-medium text-ink-secondary " +
        className
      }
      style={
        {
          background: "rgb(28 28 26 / 0.04)",
          boxShadow: "inset 0 2px 5px rgb(28 28 26 / 0.08)",
          "--lcs-from-y": "6px",
          "--lcs-delay": delay,
        } as React.CSSProperties
      }
    >
      {label}
    </div>
  );
}

/** A short carved stub linking stages in the mobile vertical composition. */
function Stub() {
  return (
    <span className="flex justify-center lg:hidden" aria-hidden="true">
      <span
        className="h-5 w-[3px] rounded-full"
        style={{
          background: "color-mix(in srgb, var(--accent) 40%, var(--surface-sunken))",
          boxShadow: "inset 0 1px 2px rgb(28 28 26 / 0.25)",
        }}
      />
    </span>
  );
}

export function ProductVisual({ t, dir }: { t: (k: string) => string; dir: "ltr" | "rtl" }) {
  return (
    <div>
      <div role="img" aria-label={t("home.viz.aria")}>
        {/* Scale frame: the fixed 500x372 desktop canvas renders at 0.9 scale
            in the narrower lg columns and full size from xl up, so the carved
            path and the zones stay in exact registration at every width. */}
        <div className="relative mx-auto w-full max-w-xl lg:aspect-[500/372] lg:max-w-[450px] xl:max-w-[500px]">
          {/* The molded business surface: one coherent warm object with subtle
              layered thickness. Mobile: a compact vertical composition on the
              same material. Desktop: the fixed canvas, scaled to fit. */}
          <div
            data-lcs="surface"
            className="relative flex flex-col gap-2.5 rounded-2xl border p-4 lg:absolute lg:start-0 lg:top-0 lg:block lg:h-[372px] lg:w-[500px] lg:origin-top-left lg:rounded-3xl lg:p-0 lg:[transform:scale(0.9)] xl:[transform:scale(1)] rtl:lg:origin-top-right"
            style={{
              borderColor: "color-mix(in srgb, var(--border-strong) 70%, transparent)",
              background: `linear-gradient(178deg, ${warm("--surface-card", 72)} 0%, ${warm("--surface-sunken", 78)} 100%)`,
              boxShadow: `inset 0 1px 0 color-mix(in srgb, white 75%, transparent), inset 0 -14px 24px -22px rgb(28 28 26 / 0.16), 0 10px 0 -3px ${EXTRUDE}, 0 26px 38px -26px rgb(28 28 26 / 0.3)`,
            }}
          >
            {/* Gentle material variation: fine layer lines in the surface. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 hidden rounded-3xl lg:block"
              style={{
                background:
                  "repeating-linear-gradient(180deg, transparent 0 30px, rgb(28 28 26 / 0.03) 30px 31px)",
              }}
            />

            {/* The carved operational path plus its one motion-only pulse,
                behind every formed zone; mirrored as a whole under RTL. */}
            <div
              aria-hidden="true"
              className="lcs-form pointer-events-none absolute inset-0 hidden lg:block"
              style={dir === "rtl" ? { transform: "scaleX(-1)" } : undefined}
            >
              <svg className="absolute inset-0 h-full w-full" viewBox="0 0 500 372" fill="none">
                <path
                  d={CARVE_PATH}
                  stroke="color-mix(in srgb, var(--border-strong) 90%, transparent)"
                  strokeWidth="7"
                  strokeLinecap="round"
                />
                <path
                  d={CARVE_PATH}
                  stroke="color-mix(in srgb, white 70%, transparent)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  transform="translate(0 2)"
                />
                <path
                  data-lcs="carve"
                  className="lcs-carve-line"
                  d={CARVE_PATH}
                  pathLength={1}
                  stroke="var(--accent)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  opacity="0.85"
                />
              </svg>
              <span
                className="lcs-pulse absolute size-2 rounded-full bg-accent opacity-0"
                style={{ offsetPath: `path("${CARVE_PATH}")` } as React.CSSProperties}
              />
            </div>

            {/* Quiet truthfulness disclosure: visible, localized, out of the way. */}
            <span className="self-end text-[10px] font-medium uppercase tracking-wide text-ink-secondary lg:absolute lg:end-4 lg:top-3 lg:self-auto">
              {t("home.viz.illustrative")}
            </span>

            {/* Incoming signals: shallow, debossed, first in the flow. */}
            <div className="flex flex-wrap gap-2 lg:contents">
              <Signal
                icon="users"
                label={t("home.viz.customer")}
                className="lg:start-[24px] lg:top-[46px]"
                fromX="-12px"
                fromY="-10px"
                delay="0.05s"
              />
              <Signal
                icon="inbox"
                label={t("home.viz.request")}
                className="lg:start-[24px] lg:top-[98px]"
                fromX="-8px"
                fromY="8px"
                delay="0.15s"
              />
            </div>

            <Stub />

            {/* Quote: the formed decision point on the path. */}
            <Formed
              icon="clipboard"
              label={t("home.viz.quote")}
              value={t("home.viz.quote_accepted")}
              lift={4}
              className="lg:start-[132px] lg:top-[196px] lg:w-[124px]"
              fromX="-8px"
              fromY="10px"
              delay="0.3s"
            />

            <Stub />

            {/* Work: the dominant raised plateau, carrying the business's own
                word as part of its identity, with team and approval inside. */}
            <div
              data-lcs="work"
              className="lcs-settle rounded-xl border border-line-strong/60 bg-card p-4 lg:absolute lg:start-[216px] lg:top-[28px] lg:w-[196px] lg:p-3.5"
              style={
                {
                  background: warm("--surface-card", 94),
                  borderInlineStart: "3px solid color-mix(in srgb, var(--accent) 65%, transparent)",
                  boxShadow: `0 10px 0 ${EXTRUDE_DEEP}, var(--elevation-2), 0 18px 28px -16px color-mix(in srgb, var(--accent) 30%, transparent)`,
                  "--lcs-from-y": "14px",
                  "--lcs-delay": "0.5s",
                } as React.CSSProperties
              }
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

            <Stub />

            {/* Invoice: the downstream formed zone. */}
            <Formed
              icon="receipt"
              label={t("home.viz.invoice")}
              value={t("home.viz.invoice_v")}
              lift={3}
              className="lg:start-[352px] lg:top-[208px] lg:w-[128px]"
              fromX="10px"
              fromY="-8px"
              delay="0.65s"
            />

            <Stub />

            {/* Payment: the single settled outcome, embedded in the surface. */}
            <div
              data-lcs="payment"
              className="lcs-settle flex items-center gap-2.5 rounded-lg p-3 lg:absolute lg:start-[336px] lg:top-[290px] lg:w-[140px] lg:px-3 lg:py-2"
              style={
                {
                  background: "color-mix(in srgb, var(--success-soft) 82%, var(--surface-sunken))",
                  boxShadow: INSET_SHADOW,
                  "--lcs-from-x": "10px",
                  "--lcs-from-y": "8px",
                  "--lcs-delay": "0.8s",
                } as React.CSSProperties
              }
            >
              <span
                className="flex size-8 shrink-0 items-center justify-center rounded-md bg-success-soft text-success lg:hidden"
                aria-hidden="true"
              >
                <Icon name="banknote" size={16} aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-success">
                  {t("home.viz.payment")}
                </span>
                <span className="block truncate text-xs font-semibold text-success">
                  {t("home.viz.payment_v")}
                </span>
              </span>
            </div>

            {/* Available capacity: one labelled recessed socket (both layouts)
                and one small unlabelled recess (desktop only). */}
            <Socket
              label={t("home.viz.dock")}
              className="mt-1 lg:mt-0 lg:start-[36px] lg:top-[286px] lg:absolute lg:h-[48px] lg:w-[170px]"
              delay="1.5s"
            />
            <Socket
              className="hidden lg:absolute lg:start-[224px] lg:top-[298px] lg:flex lg:h-[42px] lg:w-[72px]"
              delay="1.6s"
            />
          </div>
        </div>
      </div>

      {/* Visible caption: the concept in plain language, for everyone. */}
      <p className="mt-4 text-center text-sm text-ink-secondary">{t("home.viz.caption")}</p>
    </div>
  );
}
