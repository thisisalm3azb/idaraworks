import { Icon, type IconName } from "@/platform/ui";

/**
 * Auth-gateway operational illustration (005B) — an original IdaraWorks visual
 * (no copied assets, no stock avatars, no fake logos or metrics). Built from
 * CSS + inline SVG on the dark `--hero-*` tokens, it communicates the connected
 * flow Customer → Quote → Work → Team → Invoice → Payment as a vertical
 * sequence of raised surfaces linked by one flowing rail. The single motion (a
 * travelling dot) runs only under motion-safe; reduced-motion users get the
 * identical static composition. Every value is illustrative and badged as such.
 */
type Stage = { icon: IconName; labelKey: string; valueKey: string };

export function AuthVisual({ t }: { t: (k: string) => string }) {
  const stages: Stage[] = [
    { icon: "users", labelKey: "auth.viz.customer", valueKey: "auth.viz.customer_v" },
    { icon: "clipboard", labelKey: "auth.viz.quote", valueKey: "auth.viz.quote_v" },
    { icon: "briefcase", labelKey: "auth.viz.work", valueKey: "auth.viz.work_v" },
    { icon: "banknote", labelKey: "auth.viz.invoice", valueKey: "auth.viz.invoice_v" },
  ];

  return (
    <div
      className="relative flex h-full w-full flex-col justify-center overflow-hidden rounded-lg bg-hero p-8"
      role="img"
      aria-label={t("auth.viz.aria")}
    >
      <span className="absolute end-5 top-5 inline-flex items-center rounded-full border border-hero-line px-2.5 py-1 text-[11px] font-medium text-hero-dim">
        {t("auth.viz.illustrative")}
      </span>

      <p className="mb-6 max-w-xs text-lg font-medium leading-snug text-white/90">
        {t("auth.viz.headline")}
      </p>

      <div className="relative">
        {/* Vertical connector rail with a single travelling dot (motion-safe). */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-4 start-4 w-px"
          style={{
            backgroundImage:
              "repeating-linear-gradient(to bottom, color-mix(in srgb, var(--accent) 45%, transparent) 0 6px, transparent 6px 14px)",
          }}
        >
          <span
            className="auth-flow-dot absolute start-1/2 size-1.5 -translate-x-1/2 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]"
            aria-hidden
          />
        </div>

        <ol className="relative flex flex-col gap-3">
          {stages.map((s) => (
            <li
              key={s.labelKey}
              className="ms-1 flex items-center gap-3 rounded-md border border-hero-line bg-hero-raised p-3 shadow-card"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-white/5 text-white/80">
                <Icon name={s.icon} size={18} aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-[11px] font-medium uppercase tracking-wide text-hero-dim">
                  {t(s.labelKey)}
                </span>
                <span className="block text-sm font-semibold text-white/90">{t(s.valueKey)}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-5 flex items-center justify-between rounded-md border border-hero-line bg-white/[0.04] px-3 py-2.5">
        <span className="inline-flex items-center gap-2 text-xs text-hero-dim">
          <span className="size-1.5 rounded-full bg-success" aria-hidden />
          {t("auth.viz.status")}
        </span>
        <span dir="ltr" className="font-mono text-sm font-semibold tabular-nums text-white/90">
          {t("auth.viz.total")}
        </span>
      </div>
    </div>
  );
}
