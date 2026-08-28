import { Icon, type IconName } from "@/platform/ui";

/**
 * H4: the connected business journey ("#how" section body).
 *
 * Replaces the six-equal-cards grid with one continuous journey: a vertical
 * operational spine carries six moments (win, plan, run, cost, paid,
 * understand), and between stages a small "carried forward" line states
 * exactly what information moves to the next stage, so continuity is the
 * story, not six separate features.
 *
 * Editorial rhythm on desktop: content and a small code-native mini-visual
 * alternate around the centered spine; Run the work (the operational center)
 * gets slightly stronger emphasis; the final stage resolves into one calm
 * management panel followed by the outcome statement and a quiet
 * adaptable-use note. Mobile keeps the same order on a start-side spine.
 *
 * Truthful by construction: no names, numbers, dates, amounts or metrics;
 * mini-visuals are abstract shapes with equal weights (never fake charts) and
 * are aria-hidden; all meaning is carried by real localized text. Static
 * server markup, no animation, mirrors fully under RTL (grid columns and
 * logical properties flip; the two converge glyphs mirror explicitly).
 */

type TFn = (k: string) => string;

const CONVERGE = "M2 5 C12 5 14 21 26 21 M2 21 L26 21 M2 37 C12 37 14 21 26 21";

/** Small down-chevron marking information moving to the next stage. */
function DownGlyph() {
  return (
    <svg width="12" height="8" viewBox="0 0 12 8" aria-hidden="true" className="text-ink-muted">
      <path
        d="M1.5 1.5 6 6l4.5-4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Win: a compact scope document carrying an accepted seal. */
function QuoteMini() {
  return (
    <div className="w-44 rounded-lg border border-line bg-page p-3 shadow-card">
      <div className="h-1.5 w-16 rounded bg-line-strong" />
      <div className="mt-2.5 h-1.5 w-full rounded bg-line" />
      <div className="mt-1.5 h-1.5 w-3/4 rounded bg-line" />
      <div className="mt-1.5 h-1.5 w-5/6 rounded bg-line" />
      <div className="mt-3 flex items-center justify-between border-t border-line pt-2.5">
        <div className="h-1.5 w-12 rounded bg-line-strong" />
        <span className="flex size-5 items-center justify-center rounded-full bg-success-soft text-success">
          <Icon name="check" size={12} aria-hidden />
        </span>
      </div>
    </div>
  );
}

/** Plan: stages arranging along a schedule rail. */
function PlanMini() {
  return (
    <div className="w-44">
      <div className="flex items-center gap-1">
        <span className="h-2.5 flex-[3] rounded-full bg-brand/70" />
        <span className="h-2.5 flex-[4] rounded-full bg-brand/40" />
        <span className="h-2.5 flex-[2] rounded-full bg-line-strong" />
        <span className="h-2.5 flex-[3] rounded-full bg-line-strong" />
      </div>
      <div className="mt-2.5 flex items-center justify-between px-1">
        <span className="size-1.5 rounded-full bg-brand" />
        <span className="size-1.5 rounded-full bg-line-strong" />
        <span className="size-1.5 rounded-full bg-line-strong" />
        <span className="size-1.5 rounded-full bg-line-strong" />
        <span className="flex items-center text-ink-muted">
          <Icon name="calendar" size={13} aria-hidden />
        </span>
      </div>
    </div>
  );
}

/** Run: daily activity (reports, hours, approvals) attaching to the work. */
function RunMini() {
  return (
    <div className="flex w-44 items-center gap-1.5">
      <div className="flex flex-col gap-1.5">
        {(["clipboard", "clock", "check"] as IconName[]).map((n) => (
          <span
            key={n}
            className="flex size-6 items-center justify-center rounded-md border border-line bg-page text-ink-secondary"
          >
            <Icon name={n} size={12} aria-hidden />
          </span>
        ))}
      </div>
      <svg
        width="28"
        height="42"
        viewBox="0 0 28 42"
        aria-hidden="true"
        className="shrink-0 text-line-strong rtl:-scale-x-100"
      >
        <path d={CONVERGE} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <div className="flex h-12 flex-1 items-center justify-center gap-2 rounded-lg border border-accent-line bg-brand-soft text-brand shadow-card">
        <Icon name="briefcase" size={18} aria-hidden />
        <span className="h-1.5 w-10 rounded bg-brand/40" />
      </div>
    </div>
  );
}

/** Cost: material, purchasing and labour streams joining one cost line. */
function CostMini() {
  return (
    <div className="w-44">
      <div className="flex flex-col gap-1.5">
        {(["package", "truck", "users"] as IconName[]).map((n) => (
          <div key={n} className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center text-ink-muted">
              <Icon name={n} size={13} aria-hidden />
            </span>
            <span className="h-2 flex-1 rounded-full bg-line" />
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
        <span className="flex size-5 items-center justify-center text-brand">
          <Icon name="calculator" size={13} aria-hidden />
        </span>
        <span className="h-2.5 flex-1 rounded-full bg-brand/60" />
      </div>
    </div>
  );
}

/** Paid: the invoice becoming a recorded payment (vertical, RTL-neutral). */
function PaidMini() {
  return (
    <div className="flex w-44 flex-col items-center gap-1.5">
      <span className="inline-flex items-center gap-2 rounded-md border border-line bg-page px-3 py-1.5 text-ink-secondary">
        <Icon name="receipt" size={13} aria-hidden />
        <span className="h-1.5 w-12 rounded bg-line-strong" />
      </span>
      <DownGlyph />
      <span className="inline-flex items-center gap-2 rounded-md border border-success/30 bg-success-soft px-3 py-1.5 text-success">
        <Icon name="check" size={13} aria-hidden />
        <span className="h-1.5 w-12 rounded bg-success/40" />
      </span>
    </div>
  );
}

/** Understand: connected signals resolved into one aligned, calm view. */
function UnderstandMini() {
  return (
    <div className="w-44 shrink-0 rounded-lg border border-line bg-card p-3 shadow-card">
      {(["bg-brand", "bg-success", "bg-brand"] as const).map((tone, i) => (
        <div key={i} className={"flex items-center gap-2 " + (i > 0 ? "mt-2" : "")}>
          <span className={`size-1.5 rounded-full ${tone}`} />
          <span className="h-1.5 flex-1 rounded bg-line" />
          <span className="text-success">
            <Icon name="check" size={10} aria-hidden />
          </span>
        </div>
      ))}
    </div>
  );
}

const STAGES: { key: string; icon: IconName; mini: () => React.ReactNode; emphasis?: boolean }[] = [
  { key: "win", icon: "users", mini: QuoteMini },
  { key: "plan", icon: "clipboard", mini: PlanMini },
  { key: "run", icon: "briefcase", mini: RunMini, emphasis: true },
  { key: "cost", icon: "calculator", mini: CostMini },
  { key: "paid", icon: "banknote", mini: PaidMini },
];

/** The node marker sitting on the spine. */
function StageNode({ icon, emphasis }: { icon: IconName; emphasis?: boolean }) {
  return (
    <span
      className={
        "relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full border shadow-card " +
        (emphasis
          ? "border-brand bg-brand text-ink-inverse ring-4 ring-brand/15"
          : "border-line-strong/70 bg-card text-brand")
      }
    >
      <Icon name={icon} size={17} aria-hidden />
    </span>
  );
}

/** The "carried forward" line between two stages, sitting on the spine. */
function Carry({ t, k }: { t: TFn; k: string }) {
  return (
    <div className="col-span-2 grid grid-cols-[40px_minmax(0,1fr)] items-center gap-x-4 py-4 md:col-span-3 md:flex md:flex-col md:items-center md:gap-1 md:py-5">
      <span className="relative z-10 justify-self-center rounded-full bg-card p-1" aria-hidden>
        <DownGlyph />
      </span>
      <p className="relative z-10 text-xs leading-relaxed md:rounded-full md:bg-card md:px-3 md:py-0.5 md:text-center">
        <span className="me-2 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
          {t("home.flow.carry")}
        </span>
        <span className="font-medium text-ink-secondary">{t(`home.flow.${k}.fwd`)}</span>
      </p>
    </div>
  );
}

export function FlowJourney({ t }: { t: TFn }) {
  return (
    <div className="mx-auto mt-12 max-w-4xl">
      <div className="relative">
        {/* The operational spine: one continuous thread from the first moment
            to the resolved view. Start-side on mobile, centered on desktop. */}
        <div
          aria-hidden="true"
          className="absolute bottom-6 top-2 start-[19px] w-0.5 rounded-full md:start-1/2 md:-ms-px"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--accent) 55%, transparent) 0%, color-mix(in srgb, var(--accent) 30%, var(--border-strong)) 100%)",
          }}
        />
        <ol className="relative flex flex-col">
          {STAGES.map(({ key, icon, mini: Mini, emphasis }, i) => {
            const startSide = i % 2 === 0; // content on the inline-start side
            return (
              <li
                key={key}
                className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-4 md:grid-cols-[minmax(0,1fr)_72px_minmax(0,1fr)] md:gap-x-0"
              >
                <span className="col-start-1 row-start-1 justify-self-center md:col-start-2">
                  <StageNode icon={icon} emphasis={emphasis} />
                </span>

                {/* What happens at this stage. */}
                <div
                  className={
                    "col-start-2 row-start-1 md:max-w-sm " +
                    (startSide
                      ? "md:col-start-1 md:justify-self-end md:text-end"
                      : "md:col-start-3 md:justify-self-start") +
                    (emphasis
                      ? " rounded-lg border border-accent-line bg-page p-4 shadow-card md:mt-[-4px]"
                      : "")
                  }
                >
                  <div
                    className={
                      "flex items-center gap-2 " + (startSide ? "md:flex-row-reverse" : "")
                    }
                  >
                    <span aria-hidden dir="ltr" className="font-mono text-[11px] text-ink-muted">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <h3 className="text-lg font-semibold text-ink">{t(`home.flow.${key}.name`)}</h3>
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">
                    {t(`home.flow.${key}.what`)}
                  </p>
                </div>

                {/* The stage's mini-visual, opposite the text on desktop. */}
                <div
                  aria-hidden="true"
                  className={
                    "col-start-2 row-start-2 mt-4 md:row-start-1 md:mt-1 " +
                    (startSide
                      ? "md:col-start-3 md:justify-self-start md:ps-2"
                      : "md:col-start-1 md:justify-self-end md:pe-2")
                  }
                >
                  <Mini />
                </div>

                <Carry t={t} k={key} />
              </li>
            );
          })}

          {/* 6. Understand: the journey resolves into one clear picture. */}
          <li className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-4 md:block">
            <span className="col-start-1 justify-self-center md:flex md:justify-center">
              <StageNode icon="chart" />
            </span>
            <div className="col-start-2 md:mx-auto md:mt-5 md:max-w-2xl">
              <div
                className="rounded-xl border border-accent-line p-5 shadow-card sm:p-6"
                style={{
                  background: "color-mix(in srgb, var(--accent) 5%, var(--surface-card))",
                }}
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span aria-hidden dir="ltr" className="font-mono text-[11px] text-ink-muted">
                        06
                      </span>
                      <h3 className="text-lg font-semibold text-ink">
                        {t("home.flow.understand.name")}
                      </h3>
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">
                      {t("home.flow.understand.what")}
                    </p>
                  </div>
                  <div aria-hidden="true">
                    <UnderstandMini />
                  </div>
                </div>
              </div>
            </div>
          </li>
        </ol>
      </div>

      {/* The resolved outcome, then the quiet adaptable-use note. */}
      <p className="mx-auto mt-8 max-w-xl text-balance text-center text-lg font-medium leading-relaxed text-ink">
        {t("home.flow.outcome")}
      </p>
      <p className="mx-auto mt-5 flex w-fit items-center gap-2 rounded-full border border-dashed border-line-strong bg-page px-4 py-2 text-sm text-ink-secondary">
        <Icon name="grid" size={14} aria-hidden className="shrink-0 text-brand" />
        {t("home.flow.adapt")}
      </p>
    </div>
  );
}
