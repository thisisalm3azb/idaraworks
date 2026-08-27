import { Icon, type IconName } from "@/platform/ui";

/**
 * Hero product visualization (005A) — a premium, interface-style depiction of
 * the connected operating flow (win → deliver → get paid), built entirely from
 * CSS + inline SVG on the dark `--hero-*` tokens. No stock imagery, no library.
 *
 * Depth is semantic: a dark operational panel, raised stage cards, one flowing
 * connector line. The ONE motion (a dot travelling the connector) runs only
 * under motion-safe; reduced-motion users get the identical static composition.
 * Every value is illustrative and the panel is badged as such — it is never
 * presented as a real customer or live data.
 */
type Stage = { icon: IconName; labelKey: string; valueKey: string; tone: string };

export function ProductVisual({ t, dir }: { t: (k: string) => string; dir: "ltr" | "rtl" }) {
  const stages: Stage[] = [
    {
      icon: "users",
      labelKey: "home.viz.customer",
      valueKey: "home.viz.customer_v",
      tone: "text-hero-dim",
    },
    {
      icon: "clipboard",
      labelKey: "home.viz.quote",
      valueKey: "home.viz.quote_v",
      tone: "text-hero-dim",
    },
    {
      icon: "briefcase",
      labelKey: "home.viz.work",
      valueKey: "home.viz.work_v",
      tone: "text-hero-dim",
    },
    {
      icon: "banknote",
      labelKey: "home.viz.invoice",
      valueKey: "home.viz.invoice_v",
      tone: "text-hero-dim",
    },
  ];

  return (
    <div
      className="relative w-full overflow-hidden rounded-lg border border-hero-line bg-hero p-5 shadow-pop sm:p-6"
      role="img"
      aria-label={t("home.viz.aria")}
    >
      {/* Illustrative marker — always visible, never implies live data. */}
      <span className="absolute end-4 top-4 z-10 inline-flex items-center rounded-full border border-hero-line px-2.5 py-1 text-[11px] font-medium text-hero-dim">
        {t("home.viz.illustrative")}
      </span>

      {/* Faint connector rail behind the cards. The travelling dot animates
          only under motion-safe (globals.css .home-flow-dot); reduced-motion
          users see the static dashed rail with no motion. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-4 top-1/2 -z-0 h-px -translate-y-1/2"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to right, color-mix(in srgb, var(--accent) 40%, transparent) 0 6px, transparent 6px 14px)",
        }}
      >
        <span
          className="home-flow-dot absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]"
          data-dir={dir}
        />
      </div>

      <div className="relative grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stages.map((s, i) => (
          <div
            key={s.labelKey}
            className="rounded-md border border-hero-line bg-hero-raised p-3 shadow-card"
            style={{ transform: `translateY(${i % 2 === 0 ? "0" : "10px"})` }}
          >
            <span className="flex size-8 items-center justify-center rounded-md bg-white/5 text-white/80">
              <Icon name={s.icon} size={16} aria-hidden />
            </span>
            <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-hero-dim">
              {t(s.labelKey)}
            </p>
            <p className="mt-0.5 text-sm font-semibold text-white/90">{t(s.valueKey)}</p>
          </div>
        ))}
      </div>

      {/* A settled summary strip — the "money" end of the flow. */}
      <div className="relative mt-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-hero-line bg-white/[0.04] px-3 py-2.5">
        <span className="inline-flex items-center gap-2 text-xs text-hero-dim">
          <span className="size-1.5 rounded-full bg-success" aria-hidden />
          {t("home.viz.status")}
        </span>
        <span dir="ltr" className="font-mono text-sm font-semibold tabular-nums text-white/90">
          {t("home.viz.total")}
        </span>
      </div>
    </div>
  );
}
