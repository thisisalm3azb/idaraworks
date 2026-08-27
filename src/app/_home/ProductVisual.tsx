import { Icon, type IconName } from "@/platform/ui";

/**
 * Homepage hero visual — "The Living Operations System" (005B.1).
 *
 * A single, coherent operating environment (not a wall of cards): the work you
 * WON on the left, the active WORK object at the centre, and the MONEY it turns
 * into on the right — with team + materials feeding the work, and one
 * highlighted next action. The story reads without words: information moves
 * forward along the spine, entered once, used at every stage.
 *
 * Pure CSS + inline SVG on existing tokens. Layered elevation communicates
 * hierarchy (the work object is raised above its context); the one motion — a
 * pulse travelling each connector — communicates flow and runs ONLY under
 * motion-safe. Reduced-motion users see the identical, fully legible static
 * composition. Every value is illustrative and the panel is badged as such.
 */
function Node({
  icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: IconName;
  label: string;
  value: string;
  tone?: "neutral" | "success";
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-card p-2.5 shadow-card">
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

/** A connector with a forward chevron and a travelling pulse (motion-safe). */
function Connector({ dir }: { dir: "ltr" | "rtl" }) {
  return (
    <div className="relative flex h-6 items-center justify-center" aria-hidden="true">
      <span
        className="h-px w-full"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to right, color-mix(in srgb, var(--accent) 45%, transparent) 0 5px, transparent 5px 11px)",
        }}
      />
      <span
        className="los-pulse absolute size-1.5 rounded-full bg-accent shadow-[0_0_7px_var(--accent)]"
        data-dir={dir}
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

export function ProductVisual({ t, dir }: { t: (k: string) => string; dir: "ltr" | "rtl" }) {
  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-line bg-gradient-to-br from-sunken to-card p-5 shadow-pop sm:p-6">
      <span className="absolute end-4 top-4 z-10 inline-flex items-center rounded-full border border-line bg-card/80 px-2.5 py-1 text-[11px] font-medium text-ink-muted backdrop-blur">
        {t("home.viz.illustrative")}
      </span>

      <div
        role="img"
        aria-label={t("home.viz.aria")}
        className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-[1fr_auto_1.35fr_auto_1fr] sm:items-center"
      >
        {/* WIN — the work you secured. */}
        <div className="flex flex-col gap-2">
          <Node icon="users" label={t("home.viz.customer")} value={t("home.viz.customer_v")} />
          <Node icon="clipboard" label={t("home.viz.quote")} value={t("home.viz.quote_accepted")} />
        </div>

        <div className="hidden sm:block">
          <Connector dir={dir} />
        </div>

        {/* WORK — the active object at the heart of the system (raised). */}
        <div className="rounded-xl border border-accent-line bg-card p-3.5 shadow-pop">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2 text-xs font-semibold text-ink">
              <span className="flex size-7 items-center justify-center rounded-md bg-brand text-ink-inverse">
                <Icon name="briefcase" size={15} aria-hidden />
              </span>
              {t("home.viz.work_title")}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-medium text-brand">
              <span className="size-1.5 rounded-full bg-brand" aria-hidden />
              {t("home.viz.work_v")}
            </span>
          </div>

          {/* Stage tracker — a real product surface, not a decorative chart. */}
          <div className="mt-3">
            <div className="flex items-center gap-1" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className="h-1.5 flex-1 rounded-full bg-brand" />
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-ink-muted">{t("home.viz.work_stage")}</p>
          </div>

          {/* Team + materials feed the work. */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full border border-line bg-sunken px-2 py-0.5 text-[10px] font-medium text-ink-secondary">
              <Icon name="users" size={11} aria-hidden />
              {t("home.viz.team_v")}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-line bg-sunken px-2 py-0.5 text-[10px] font-medium text-ink-secondary">
              <Icon name="package" size={11} aria-hidden />
              {t("home.viz.materials_v")}
            </span>
          </div>

          {/* One highlighted next action. */}
          <div className="los-cta mt-3 flex items-center justify-between rounded-md border border-brand bg-brand-soft px-2.5 py-1.5">
            <span className="text-[11px] font-semibold text-brand">
              {t("home.viz.next_action")}
            </span>
            <span className="text-brand">
              <Icon name="plus" size={14} aria-hidden />
            </span>
          </div>
        </div>

        <div className="hidden sm:block">
          <Connector dir={dir} />
        </div>

        {/* MONEY — what the work becomes. */}
        <div className="flex flex-col gap-2">
          <Node icon="receipt" label={t("home.viz.invoice")} value={t("home.viz.invoice_v")} />
          <Node
            icon="banknote"
            label={t("home.viz.payment")}
            value={t("home.viz.payment_v")}
            tone="success"
          />
          <div className="flex items-center justify-between rounded-lg border border-success/40 bg-success-soft px-2.5 py-1.5">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-success">
              <span className="size-1.5 rounded-full bg-success" aria-hidden />
              {t("home.viz.status")}
            </span>
            <span dir="ltr" className="font-mono text-xs font-semibold tabular-nums text-ink">
              {t("home.viz.total")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
