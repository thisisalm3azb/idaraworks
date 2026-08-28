import Link from "next/link";
import { Icon, type IconName } from "@/platform/ui";

/**
 * H9.1: the homepage ending — "from setup to a living workspace". Replaces
 * the dark full-width CTA slab with a light, architectural two-column close:
 * editorial copy and real actions on one side, and a compact three-step
 * workspace path on the other (tell us how you work, review your setup,
 * start with real work — the real onboarding shape, no invented data).
 *
 * The path reuses the homepage's material language (warm surfaces, shallow
 * extrusion, one carved rail) so the hero's system feels matured by the end
 * of the page. Static server markup: no motion, no fake controls; the rail
 * and step numerals are decorative and hidden from assistive technology.
 * Signed-out primary is "Build my workspace" (-> /signup); a signed-in
 * visitor keeps their "Open workspace" action instead.
 */

type TFn = (k: string) => string;

const STEPS: { key: string; icon: IconName }[] = [
  { key: "s1", icon: "inbox" },
  { key: "s2", icon: "check" },
  { key: "s3", icon: "briefcase" },
];

export function ClosingSection({
  t,
  primary,
  secondary,
}: {
  t: TFn;
  primary: { href: string; label: string };
  secondary: { href: string; label: string } | null;
}) {
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-center">
      {/* ── The ask, in the page's own editorial voice ───────────────────── */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-brand">
          {t("home.close.eyebrow")}
        </p>
        <h2 className="mt-2 text-balance text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
          {t("home.close.title")}
        </h2>
        <p className="mt-4 max-w-xl text-pretty text-base leading-relaxed text-ink-secondary">
          {t("home.close.body")}
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link
            href={primary.href}
            className="inline-flex min-h-12 items-center rounded-md bg-brand px-6 text-base font-semibold text-ink-inverse shadow-card hover:bg-brand-strong"
          >
            {primary.label}
          </Link>
          {secondary ? (
            <Link
              href={secondary.href}
              className="inline-flex min-h-12 items-center rounded-md border border-line-strong bg-card px-5 text-base font-medium text-ink hover:bg-sunken"
            >
              {secondary.label}
            </Link>
          ) : null}
        </div>
        <p className="mt-4 text-sm text-ink-muted">{t("home.close.reassure")}</p>
      </div>

      {/* ── The workspace path: three connected steps on one rail ────────── */}
      <div className="relative" aria-hidden="false">
        {/* The rail: one carved thread through the three steps. */}
        <span
          aria-hidden="true"
          className="absolute bottom-8 top-8 hidden w-0.5 rounded-full sm:block"
          style={{
            insetInlineStart: "27px",
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--accent) 50%, var(--border-strong)) 0%, color-mix(in srgb, var(--accent) 25%, var(--border-strong)) 100%)",
          }}
        />
        <ol className="flex flex-col gap-3">
          {STEPS.map(({ key, icon }, i) => (
            <li
              key={key}
              className="relative flex items-center gap-4 rounded-xl border px-4 py-3.5 sm:ps-3"
              style={{
                borderColor: "color-mix(in srgb, var(--border-strong) 65%, transparent)",
                background:
                  "linear-gradient(178deg, color-mix(in srgb, var(--surface-card) 78%, var(--warning-soft)) 0%, color-mix(in srgb, var(--surface-sunken) 72%, var(--warning-soft)) 100%)",
                boxShadow:
                  "inset 0 1px 0 color-mix(in srgb, white 70%, transparent), 0 4px 0 -1px color-mix(in srgb, var(--border-strong) 80%, var(--warning-soft)), 0 12px 18px -14px rgb(28 28 26 / 0.25)",
              }}
            >
              <span
                className={
                  "relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full border " +
                  (i === 2
                    ? "border-brand bg-brand text-ink-inverse"
                    : "border-line-strong/70 bg-card text-brand")
                }
              >
                <Icon name={icon} size={15} aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    dir="ltr"
                    className="font-mono text-[10px] text-ink-muted"
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-sm font-semibold text-ink">{t(`home.close.${key}`)}</span>
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-secondary">
                  {t(`home.close.${key}d`)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
