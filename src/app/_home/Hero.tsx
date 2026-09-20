import { Btn, Glyph, TwoLine, type HomeT } from "./ui";
import { ANCHORS } from "./nav";

/**
 * The hero: the owner's outcome in one line, the trial as the first action, the
 * demo as the second, and a dimensional illustration of an owner's day (a
 * workspace window, a recorded payment, the company's own app on a phone).
 * The illustration is HTML and CSS, server-rendered, with its space reserved
 * so nothing shifts when the page paints. Sample company and figures are
 * fictional and labelled as such.
 */
export function Hero({
  t,
  primaryHref,
  languagesOr,
  languageTile,
}: {
  t: HomeT;
  primaryHref: string;
  languagesOr: string;
  /** Short labels of the offered languages, e.g. "EN / ع". */
  languageTile: string;
}) {
  return (
    <section className="mx-auto w-full max-w-[1440px] px-5 pb-10 pt-10 sm:px-[5.5%] sm:pt-14 lg:pb-11 lg:pt-16">
      <div className="grid items-center gap-8 lg:grid-cols-[0.95fr_1.2fr] lg:gap-10">
        <div className="relative z-10 mx-auto max-w-2xl text-center lg:mx-0 lg:max-w-none lg:text-start">
          <p className="flex items-center justify-center gap-2.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-brand lg:justify-start">
            <span
              aria-hidden
              className="size-1.5 rounded-full bg-mk-green ring-4 ring-brand-soft"
            />
            {t("home.hero.kicker")}
          </p>
          <h1 className="mk-tight mx-auto mt-5 text-balance text-[3.1rem] font-medium leading-[1.04] tracking-[-0.05em] text-ink sm:text-[4rem] lg:mx-0 lg:text-[clamp(3.4rem,5.4vw,4.9rem)]">
            <TwoLine text={t("home.hero.title")} />
          </h1>
          <p className="mx-auto mt-6 max-w-[27rem] text-pretty text-base leading-[1.8] text-ink-secondary lg:mx-0">
            {t("home.hero.body")}
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
            <Btn href={primaryHref} size="lg">
              {t("home.hero.cta")}
              <Glyph>↗</Glyph>
            </Btn>
            <a
              href={ANCHORS.demo}
              className="inline-flex min-h-12 items-center gap-2.5 px-1 text-xs font-medium text-brand-strong hover:underline"
            >
              <span
                aria-hidden
                className="grid size-6 place-items-center rounded-full border border-line-strong text-[0.55rem]"
              >
                ▶
              </span>
              {t("home.hero.demo")}
            </a>
          </div>
          <ul className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[0.7rem] text-ink-secondary lg:justify-start">
            {(["a1", "a2", "a3"] as const).map((k) => (
              <li key={k} className="flex items-center gap-1.5">
                <span aria-hidden className="text-mk-green">
                  ✓
                </span>
                {t(`home.hero.${k}`)}
              </li>
            ))}
          </ul>
          <div className="mx-auto mt-7 flex max-w-sm items-center gap-3 border-t border-line pt-5 text-start text-xs leading-relaxed text-ink-secondary lg:mx-0">
            <span
              aria-hidden
              className="grid h-9 w-11 shrink-0 place-items-center rounded-sm border border-brand-soft bg-brand-soft text-[0.7rem] font-medium text-brand-strong"
            >
              {languageTile}
            </span>
            <span>{t("home.hero.languages", { languages_or: languagesOr })}</span>
          </div>
        </div>

        <Scene t={t} />
      </div>
    </section>
  );
}

function Scene({ t }: { t: HomeT }) {
  const stats = [
    { k: "s1", tone: "lime" as const },
    { k: "s2", tone: "plain" as const },
    { k: "s3", tone: "plain" as const },
  ];
  const rows = ["r1", "r2", "r3"] as const;
  const navItems = ["n1", "n2", "n3", "n4", "n5", "n6"] as const;
  return (
    <div className="relative mx-auto w-full max-w-[40rem] px-1 pb-16 pt-8 sm:px-8 sm:pb-16 lg:max-w-none lg:px-0 lg:pb-[4.5rem] lg:pt-9">
      {/* Soft field behind the scene */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-[radial-gradient(ellipse_at_center,#dcebc5_0%,rgba(231,239,221,0.5)_50%,transparent_72%)]"
      />
      <span className="absolute end-2 top-1 text-[0.55rem] font-medium uppercase tracking-[0.1em] text-brand sm:end-10 lg:end-2">
        {t("home.hero.caption")}
      </span>

      {/* The owner's workspace window */}
      <div
        className="mk-window-3d relative overflow-hidden rounded-md border border-[#2c443c] bg-mk-forest text-mk-forest-ink shadow-pop"
        role="img"
        aria-label={t("home.hero.window_aria")}
      >
        <div className="flex h-10 items-center justify-between border-b border-mk-forest-line bg-mk-forest-raised px-4 text-[0.55rem] text-mk-forest-dim">
          <span aria-hidden className="flex gap-1">
            <i className="size-1.5 rounded-full bg-[#557060]" />
            <i className="size-1.5 rounded-full bg-[#557060]" />
            <i className="size-1.5 rounded-full bg-[#557060]" />
          </span>
          <span className="flex items-center gap-2 text-[#e1ead7]">
            <b className="grid size-4 place-items-center rounded-[3px] bg-mk-lime text-[0.55rem] text-[#20402b]">
              S
            </b>
            {t("home.hero.company")}{" "}
            <span className="text-mk-forest-dim">{t("home.hero.workspace")}</span>
          </span>
          <span>{t("home.hero.today")}</span>
        </div>
        <div className="grid min-h-[19rem] sm:grid-cols-[6rem_1fr]">
          <div className="hidden flex-col gap-1.5 border-e border-mk-forest-line p-2.5 pt-5 sm:flex">
            {navItems.map((n, i) => (
              <span
                key={n}
                className={`rounded-[4px] px-2 py-2 text-[0.55rem] ${
                  i === 0 ? "bg-white/[0.07] text-mk-lime" : "text-mk-forest-dim"
                }`}
              >
                {t(`home.hero.${n}`)}
              </span>
            ))}
          </div>
          <div className="min-w-0 p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-base font-medium leading-snug text-white sm:text-lg">
                  {t("home.hero.win_title")}
                </p>
                <p className="mt-1.5 text-[0.6rem] text-mk-forest-dim">{t("home.hero.win_sub")}</p>
              </div>
              <span
                aria-hidden
                className="grid size-6 shrink-0 place-items-center rounded-full bg-[#39513e] text-[0.55rem] text-[#d3e5c5]"
              >
                AM
              </span>
            </div>
            <div className="my-4 grid grid-cols-3 gap-2">
              {stats.map(({ k, tone }) => (
                <div
                  key={k}
                  className={`min-w-0 rounded-[6px] border px-2.5 py-3 ${
                    tone === "lime"
                      ? "border-mk-lime bg-mk-lime text-[#29422e]"
                      : "border-[#355040]"
                  }`}
                >
                  <span
                    className={`block text-[0.5rem] ${tone === "lime" ? "text-[#4d683c]" : "text-[#a0b798]"}`}
                  >
                    {t(`home.hero.${k}_label`)}
                  </span>
                  <strong className="mk-tight my-1.5 block text-xl font-medium tabular-nums tracking-[-0.03em] sm:text-2xl">
                    {t(`home.hero.${k}_value`)}
                  </strong>
                  <small
                    className={`block text-[0.5rem] ${tone === "lime" ? "text-[#52733c]" : "text-[#8eb184]"}`}
                  >
                    {t(`home.hero.${k}_note`)}
                  </small>
                </div>
              ))}
            </div>
            <div className="mb-2 flex items-center justify-between text-[0.6rem]">
              <span>{t("home.hero.next_moves")}</span>
              <small className="text-[0.5rem] text-[#9db894]">{t("home.hero.one_place")}</small>
            </div>
            {rows.map((r) => (
              <div
                key={r}
                className="flex items-center gap-2.5 border-t border-mk-forest-line py-2.5 text-[0.6rem] text-[#c1d1bc]"
              >
                <i
                  aria-hidden
                  className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-mk-lime/10 not-italic text-[0.65rem] text-[#bad69c]"
                >
                  {r === "r1" ? "✓" : r === "r2" ? "▱" : "↗"}
                </i>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-[0.6rem] font-medium">
                    {t(`home.hero.${r}_title`)}
                  </strong>
                  <small className="mt-0.5 block truncate text-[0.5rem] text-mk-forest-dim">
                    {t(`home.hero.${r}_sub`)}
                  </small>
                </span>
                <span className="shrink-0 rounded-[4px] border border-[#547149] px-1.5 py-1 text-[0.5rem] text-[#c8e4a9]">
                  {t(`home.hero.${r}_action`)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* The recorded payment */}
      <div className="absolute bottom-9 start-0 z-10 flex -rotate-3 items-center gap-2.5 rounded-md border border-line bg-card px-3.5 py-3 shadow-pop sm:start-2 lg:-start-5 lg:bottom-[3.3rem]">
        <span
          aria-hidden
          className="grid size-7 place-items-center rounded-full bg-brand-soft text-xs text-brand"
        >
          ✓
        </span>
        <span>
          <b className="block text-[0.65rem] font-semibold text-ink">{t("home.hero.receipt")}</b>
          <small className="mt-1 block text-[0.55rem] text-ink-muted">
            {t("home.hero.receipt_sub")}
          </small>
        </span>
      </div>

      {/* The company's own app */}
      <div
        className="absolute bottom-2 end-1 z-10 h-[13rem] w-[7.4rem] rotate-[8deg] rounded-[1.4rem] border-[5px] border-[#243d31] bg-[#f5f7ef] px-2.5 pb-2.5 pt-6 shadow-pop sm:end-6 sm:h-[15rem] sm:w-[8.6rem] lg:-end-2"
        role="img"
        aria-label={t("home.hero.phone_aria")}
      >
        <span
          aria-hidden
          className="absolute start-1/2 top-2 h-1.5 w-8 -translate-x-1/2 rounded-full bg-[#243d31] rtl:translate-x-1/2"
        />
        <span
          aria-hidden
          className="mb-2 grid size-8 place-items-center rounded-[10px] bg-[#315b4e] text-lg text-mk-lime"
        >
          ✦
        </span>
        <b className="block text-[0.7rem] font-semibold text-ink">{t("home.hero.company")}</b>
        <small className="block text-[0.5rem] text-ink-muted">{t("home.hero.powered")}</small>
        <div className="mt-2.5 rounded-[6px] border border-line bg-card p-2">
          <b className="block text-[0.55rem] font-semibold text-ink">
            {t("home.hero.phone_title")}
          </b>
          <strong className="my-1 block text-lg font-medium text-mk-green">
            {t("home.hero.phone_value")}
          </strong>
          <small className="block text-[0.5rem] text-ink-muted">{t("home.hero.phone_note")}</small>
        </div>
        <div className="mt-1.5 flex justify-between rounded-[6px] border border-line bg-card p-1.5 text-[0.5rem] text-ink">
          <span>{t("home.hero.phone_work")}</span>
          <span>12 →</span>
        </div>
      </div>
      <span className="absolute bottom-2 start-3 text-[0.6rem] text-brand lg:start-[40%] lg:bottom-5">
        {t("home.hero.pocket")}
      </span>
    </div>
  );
}
