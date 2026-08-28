import { Icon, type IconName } from "@/platform/ui";

/**
 * H5: "One foundation, different shapes" (the Built-around-your-business
 * section body). Replaces the bullet-and-roadmap-box layout with a visual
 * demonstration of controlled adaptability.
 *
 * The demonstration is grounded in shipped behavior only:
 *  - Terminology: the onboarding intake and the terminology editor let a
 *    business rename what it calls its work (a closed registry of core terms,
 *    each in English and Arabic) - shown as Work becoming Order / Project /
 *    Job with one choice settled.
 *  - Workflow: stage templates are configuration (rename, order, and a stage
 *    can be left out via preset skip keys) - shown as a neutral starting
 *    shape becoming "your shape" with one stage renamed and one left out.
 *  - Capabilities: only supported capabilities can be included - shown as
 *    real module chips with one left out.
 *  - Review: guided setup is a structured questionnaire producing a proposed
 *    setup that is reviewed and confirmed before anything is created, and
 *    every configuration change is recorded and undoable.
 *
 * All of that shapes layers stacked over ONE stable foundation slab (the
 * connected operating record), followed by a compact availability ledger
 * (Available now vs Planned, planned clearly labelled and quieter) and a
 * closing statement. The safety law is presented as a calm trust line with
 * the detailed guardrail as small supporting text.
 *
 * Static server markup: no animation, no interactive or fake controls; the
 * chips and pills are plain text displays. Mirrors fully under RTL via
 * logical properties; the one directional arrow glyph flips explicitly.
 */

type TFn = (k: string) => string;

/** Small forward arrow between the foundation term and the chosen words. */
function ForwardGlyph() {
  return (
    <svg
      width="14"
      height="10"
      viewBox="0 0 14 10"
      aria-hidden="true"
      className="shrink-0 text-ink-muted rtl:-scale-x-100"
    >
      <path
        d="M1 5h10.5M8 1.5 12 5l-4 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One shaping layer: a labelled panel formed over the foundation. */
function Layer({
  title,
  children,
  caption,
}: {
  title: string;
  children: React.ReactNode;
  caption?: string;
}) {
  return (
    <div
      className="rounded-lg border border-line bg-card p-3.5"
      style={{
        boxShadow:
          "0 3px 0 color-mix(in srgb, var(--border-strong) 70%, var(--warning-soft)), var(--elevation-1)",
      }}
    >
      <p className="text-xs font-semibold text-ink">{title}</p>
      <div className="mt-2.5">{children}</div>
      {caption ? <p className="mt-2 text-[11px] leading-snug text-ink-muted">{caption}</p> : null}
    </div>
  );
}

/** A small neutral pill for stage / term / capability displays. */
function Pill({
  label,
  tone = "plain",
  icon,
}: {
  label: string;
  tone?: "plain" | "chosen" | "ghost" | "base";
  icon?: IconName;
}) {
  const toneClass =
    tone === "chosen"
      ? "border-accent-line bg-brand-soft font-medium text-ink"
      : tone === "ghost"
        ? "border-dashed border-line-strong text-ink-muted line-through"
        : tone === "base"
          ? "border-line-strong/70 bg-sunken font-medium text-ink"
          : "border-line bg-page text-ink-secondary";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] leading-none ${toneClass}`}
    >
      {icon ? <Icon name={icon} size={11} aria-hidden className="shrink-0" /> : null}
      {label}
      {tone === "chosen" ? (
        <Icon name="check" size={10} aria-hidden className="shrink-0 text-brand" />
      ) : null}
    </span>
  );
}

export function FoundationShapes({ t }: { t: TFn }) {
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-center">
      {/* ── Copy, then the safety guarantee as a calm trust line ─────────── */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-brand">
          {t("home.built.eyebrow")}
        </p>
        <h2 className="mt-2 text-balance text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-[2.1rem]">
          {t("home.built.title")}
        </h2>
        <p className="mt-3 max-w-xl text-pretty text-base leading-relaxed text-ink-secondary">
          {t("home.built.body")}
        </p>

        <div className="mt-8 flex items-start gap-3 rounded-lg border border-line bg-card p-4">
          <Icon name="lock" size={17} aria-hidden className="mt-0.5 shrink-0 text-brand" />
          <div className="min-w-0">
            <p className="text-sm font-medium leading-relaxed text-ink">{t("home.built.law")}</p>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
              {t("home.built.guardrail")}
            </p>
          </div>
        </div>
      </div>

      {/* ── The demonstration: shaping layers over one stable foundation ── */}
      <div className="flex flex-col gap-2.5">
        {/* Words: rename what the business calls its work. */}
        <Layer title={t("home.built.words_title")} caption={t("home.built.words_note")}>
          <div className="flex flex-wrap items-center gap-2">
            <Pill label={t("home.built.words_base")} tone="base" />
            <ForwardGlyph />
            <Pill label={t("home.built.words_o1")} tone="chosen" />
            <Pill label={t("home.built.words_o2")} />
            <Pill label={t("home.built.words_o3")} />
          </div>
        </Layer>

        {/* Stages: the workflow changes shape, the record stays connected. */}
        <Layer title={t("home.built.stages_title")} caption={t("home.built.stages_note")}>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className="w-20 shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                {t("home.built.shape_a")}
              </span>
              <Pill label={t("home.built.stage_new")} />
              <Pill label={t("home.built.stage_planned")} />
              <Pill label={t("home.built.stage_progress")} />
              <Pill label={t("home.built.stage_ready")} />
              <Pill label={t("home.built.stage_done")} />
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className="w-20 shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                {t("home.built.shape_b")}
              </span>
              <Pill label={t("home.built.stage_new")} />
              <Pill label={t("home.built.stage_planned")} tone="ghost" />
              <Pill label={t("home.built.stage_progress")} />
              <Pill label={t("home.built.stage_handover")} tone="chosen" />
              <Pill label={t("home.built.stage_done")} />
            </div>
          </div>
        </Layer>

        {/* Capabilities: include what you need, from the supported set. */}
        <Layer title={t("home.built.caps_title")} caption={t("home.built.caps_note")}>
          <div className="flex flex-wrap items-center gap-2">
            <Pill label={t("home.built.cap_quotes")} tone="chosen" icon="clipboard" />
            <Pill label={t("home.built.cap_reports")} tone="chosen" icon="calendar" />
            <Pill label={t("home.built.cap_approvals")} tone="chosen" icon="check" />
            <Pill label={t("home.built.cap_purchasing")} icon="cart" />
          </div>
        </Layer>

        {/* Review: the controlled sequence, then undo with history. */}
        <Layer title={t("home.built.review_title")} caption={t("home.built.review_undo")}>
          <ol className="flex flex-col gap-x-4 gap-y-1.5 text-xs text-ink-secondary sm:flex-row sm:flex-wrap sm:items-center">
            {(["review_s1", "review_s2", "review_s3"] as const).map((k, i) => (
              <li key={k} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  dir="ltr"
                  className="flex size-4 shrink-0 items-center justify-center rounded-full bg-brand-soft font-mono text-[9px] font-semibold text-brand"
                >
                  {i + 1}
                </span>
                {t(`home.built.${k}`)}
              </li>
            ))}
          </ol>
        </Layer>

        {/* The stable foundation everything is shaped onto. */}
        <div
          className="rounded-xl border px-4 py-3.5"
          style={{
            borderColor: "color-mix(in srgb, var(--border-strong) 70%, transparent)",
            background:
              "linear-gradient(178deg, color-mix(in srgb, var(--surface-card) 72%, var(--warning-soft)) 0%, color-mix(in srgb, var(--surface-sunken) 78%, var(--warning-soft)) 100%)",
            boxShadow:
              "inset 0 1px 0 color-mix(in srgb, white 75%, transparent), 0 7px 0 -2px color-mix(in srgb, var(--border-strong) 85%, var(--warning-soft)), 0 18px 26px -20px rgb(28 28 26 / 0.28)",
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-ink">{t("home.built.foundation")}</p>
            <span className="flex items-center gap-1.5" aria-hidden="true">
              {(["users", "briefcase", "clipboard", "receipt", "banknote"] as IconName[]).map(
                (n) => (
                  <span
                    key={n}
                    className="flex size-6 items-center justify-center rounded-full text-ink-secondary"
                    style={{
                      background:
                        "color-mix(in srgb, var(--surface-sunken) 88%, var(--warning-soft))",
                      boxShadow:
                        "inset 0 1.5px 3px rgb(28 28 26 / 0.12), inset 0 -1px 0 color-mix(in srgb, white 70%, transparent)",
                    }}
                  >
                    <Icon name={n} size={12} aria-hidden />
                  </span>
                ),
              )}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
            {t("home.built.foundation_note")}
          </p>
        </div>
      </div>

      {/* ── Availability ledger: now is louder than planned ──────────────── */}
      <div className="grid gap-3 sm:grid-cols-[1.15fr_1fr] lg:col-span-2">
        <div className="rounded-lg border border-line bg-card p-4 shadow-card">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-xs font-medium text-success">
            <span className="size-1.5 rounded-full bg-success" aria-hidden />
            {t("home.built.now_label")}
          </span>
          <ul className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5">
            {(["now_i1", "now_i2", "now_i3", "now_i4", "now_i5"] as const).map((k) => (
              <li key={k} className="flex items-center gap-1.5 text-sm text-ink">
                <Icon name="check" size={13} aria-hidden className="shrink-0 text-brand" />
                {t(`home.built.${k}`)}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-dashed border-line-strong bg-page p-4">
          <span className="inline-flex items-center rounded-full border border-line px-2.5 py-1 text-xs font-medium text-ink-secondary">
            {t("home.built.planned_label")}
          </span>
          <ul className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5">
            {(["pl_i1", "pl_i2", "pl_i3", "pl_i4"] as const).map((k) => (
              <li key={k} className="text-sm text-ink-secondary">
                {t(`home.built.${k}`)}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* ── Closing statement ────────────────────────────────────────────── */}
      <p className="mx-auto max-w-2xl text-balance text-center text-lg font-medium leading-relaxed text-ink lg:col-span-2">
        {t("home.built.close")}
      </p>
    </div>
  );
}
