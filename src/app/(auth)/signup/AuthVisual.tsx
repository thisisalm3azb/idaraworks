import { Icon, type IconName } from "@/platform/ui";

/**
 * Auth-gateway visual — "One business, one connected flow" (005B.1).
 *
 * A simpler expression of the Living Operations System: a central IdaraWorks
 * business core with a few clearly-related operational surfaces gathered around
 * it — customers & quotes, work, team & materials, money — all part of ONE
 * connected system rather than separate tools. Welcoming and calm, not a
 * technical diagram; it never competes with the form. Original CSS + inline
 * SVG on existing tokens; the one motion (a soft pulse ring on the core) runs
 * only under motion-safe, and reduced-motion users see the identical static
 * composition. Hidden on mobile so the form owns the priority.
 */
type Node = { icon: IconName; labelKey: string; pos: string };

export function AuthVisual({ t }: { t: (k: string) => string }) {
  const nodes: Node[] = [
    { icon: "users", labelKey: "auth.viz.n_customers", pos: "start-[6%] top-[14%]" },
    { icon: "briefcase", labelKey: "auth.viz.n_work", pos: "end-[6%] top-[14%]" },
    { icon: "package", labelKey: "auth.viz.n_team", pos: "start-[6%] bottom-[14%]" },
    { icon: "banknote", labelKey: "auth.viz.n_money", pos: "end-[6%] bottom-[14%]" },
  ];

  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden rounded-lg bg-gradient-to-br from-brand-soft via-card to-brand-soft p-8"
      role="img"
      aria-label={t("auth.viz.aria")}
    >
      <span className="absolute end-5 top-5 z-10 inline-flex items-center rounded-full border border-line bg-card/70 px-2.5 py-1 text-[11px] font-medium text-ink-muted backdrop-blur">
        {t("auth.viz.illustrative")}
      </span>

      <p className="max-w-[15rem] text-xl font-semibold leading-snug text-ink">
        {t("auth.viz.headline")}
      </p>

      <div className="relative mx-auto mt-6 aspect-square w-full max-w-sm flex-1">
        {/* Connectors from the core to each surface (decorative). */}
        <svg
          viewBox="0 0 100 100"
          className="absolute inset-0 h-full w-full"
          aria-hidden="true"
          preserveAspectRatio="none"
        >
          {[
            [20, 22],
            [80, 22],
            [20, 78],
            [80, 78],
          ].map(([x, y], i) => (
            <line
              key={i}
              x1="50"
              y1="50"
              x2={x}
              y2={y}
              stroke="var(--accent)"
              strokeOpacity="0.3"
              strokeWidth="0.6"
              strokeDasharray="2 2.5"
            />
          ))}
        </svg>

        {/* The four connected surfaces. */}
        {nodes.map((n) => (
          <div
            key={n.labelKey}
            className={`absolute ${n.pos} flex w-[38%] items-center gap-2 rounded-lg border border-line bg-card p-2 shadow-card`}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
              <Icon name={n.icon} size={15} aria-hidden />
            </span>
            <span className="min-w-0 text-[11px] font-medium leading-tight text-ink">
              {t(n.labelKey)}
            </span>
          </div>
        ))}

        {/* The business core — the focal point, raised above the surfaces. */}
        <div className="absolute inset-1/2 flex size-[34%] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-2xl border border-accent-line bg-card text-center shadow-pop">
          <span className="los-core absolute inset-0 rounded-2xl" aria-hidden />
          <span className="relative flex size-9 items-center justify-center rounded-xl bg-brand text-ink-inverse">
            <Icon name="grid" size={18} aria-hidden />
          </span>
          <span className="relative mt-1.5 px-1 text-[10px] font-semibold leading-tight text-ink">
            {t("auth.viz.core")}
          </span>
        </div>
      </div>
    </div>
  );
}
