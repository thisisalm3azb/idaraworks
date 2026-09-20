import { Icon, type IconName } from "@/platform/ui";
import { Eyebrow, Glyph, SectionHead, TwoLine, type HomeT } from "./ui";
import { ANCHORS } from "./nav";

/**
 * Platform depth: the two large cards (Management Studio's plan view, the
 * quote-to-paid money flow) and three smaller ones (people, stock, Document
 * Studio). Every capability named here ships today; nothing disabled or
 * unsupported is promised.
 */
export function PlatformDepth({ t }: { t: HomeT }) {
  const small: Array<{ k: string; icon: IconName }> = [
    { k: "people", icon: "users" },
    { k: "stock", icon: "package" },
    { k: "docs", icon: "fileText" },
  ];
  return (
    <section
      id="platform"
      className="scroll-mt-20 border-t border-line"
      aria-labelledby="platform-title"
    >
      <div className="mx-auto w-full max-w-[1200px] px-5 py-14 sm:px-6 lg:py-20">
        <SectionHead
          id="platform-title"
          eyebrow={t("home.platform.eyebrow")}
          title={<TwoLine text={t("home.platform.title")} emClass="text-ink" />}
          body={t("home.platform.body")}
        />
        <div className="mt-8 grid min-w-0 gap-4 lg:grid-cols-[1.22fr_1fr]">
          {/* Management Studio */}
          <article className="mk-plan relative min-w-0 overflow-hidden rounded-md border border-line bg-card p-6 sm:p-8">
            <Eyebrow>{t("home.platform.studio_no")}</Eyebrow>
            <h3 className="mk-tight mt-3 text-2xl font-medium tracking-[-0.03em] text-ink">
              {t("home.platform.studio_title")}
            </h3>
            <p className="mt-2 max-w-[22rem] text-sm leading-[1.75] text-ink-secondary">
              {t("home.platform.studio_text")}
            </p>
            <a
              href={ANCHORS.demo}
              className="mt-3 inline-flex min-h-9 items-center gap-3 text-xs font-semibold text-ink hover:underline"
            >
              {t("home.platform.studio_link")}
              <Glyph>↗</Glyph>
            </a>
            <div
              className="mk-plan-grid relative -mx-6 -mb-6 mt-6 h-52 overflow-hidden bg-[#f3f6ec] sm:-mx-8 sm:-mb-8"
              role="img"
              aria-label={t("home.platform.studio_aria")}
            >
              <div className="mk-plan-base absolute start-[calc(50%-150px)] top-5 h-[190px] w-[300px] rounded-[10px] border border-[#d5dfcb] bg-[#e6eddc] shadow-[15px_15px_0_#e9eee3]">
                <PlanBlock className="h-[70px] start-7 top-7 bg-[#9caf85]" />
                <PlanBlock className="h-[115px] start-[100px] top-5 bg-mk-lime" />
                <PlanBlock className="h-12 start-[176px] top-[103px] bg-[#9caf85]" />
                <PlanBlock className="h-[85px] start-[221px] top-3 bg-[#b7cba0]" />
              </div>
              <span className="absolute end-6 top-5 rounded-[5px] bg-card px-3 py-2.5 text-[0.6rem] text-[#4a6347] shadow-pop">
                ◇ {t("home.platform.studio_badge")}
              </span>
            </div>
          </article>

          {/* Money flow */}
          <article className="min-w-0 rounded-md border border-mk-forest bg-mk-forest p-6 text-mk-forest-ink sm:p-8">
            <Eyebrow tone="lime">{t("home.platform.money_no")}</Eyebrow>
            <h3 className="mk-tight mt-3 text-2xl font-medium tracking-[-0.03em] text-white">
              {t("home.platform.money_title")}
            </h3>
            <p className="mt-2 max-w-[22rem] text-sm leading-[1.75] text-mk-forest-dim">
              {t("home.platform.money_text")}
            </p>
            <a
              href={ANCHORS.demo}
              className="mt-3 inline-flex min-h-9 items-center gap-3 text-xs font-semibold text-white hover:underline"
            >
              {t("home.platform.money_link")}
              <Glyph>↗</Glyph>
            </a>
            <div
              className="mt-6 flex h-40 items-center justify-center gap-2 sm:gap-3"
              role="img"
              aria-label={t("home.platform.money_aria")}
            >
              {(["quote", "invoice", "paid"] as const).map((k, i) => (
                <div key={k} className="contents">
                  {i > 0 ? (
                    <span aria-hidden className="h-px w-3 shrink-0 bg-[#62825a] sm:w-5" />
                  ) : null}
                  <div
                    className={`w-[4.6rem] min-w-0 rounded-[8px] border px-1.5 py-4 text-center text-[0.65rem] sm:w-24 sm:px-2 ${
                      k === "paid"
                        ? "border-[#819a61] bg-mk-lime/10"
                        : "border-[#45603f] bg-[#1b362d]"
                    }`}
                  >
                    <strong className="mb-2.5 block text-xl text-mk-lime">
                      {k === "quote" ? "≡" : k === "invoice" ? "↗" : "✓"}
                    </strong>
                    {t(`home.platform.flow_${k}`)}
                  </div>
                </div>
              ))}
            </div>
          </article>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {small.map(({ k, icon }) => (
            <article key={k} className="rounded-md border border-line bg-card p-6">
              <span
                aria-hidden
                className="grid size-8 place-items-center rounded-[8px] bg-brand-soft text-brand-strong"
              >
                <Icon name={icon} size={16} />
              </span>
              <h3 className="mk-tight mt-4 text-xl font-medium tracking-[-0.02em] text-ink">
                {t(`home.platform.${k}_title`)}
              </h3>
              <p className="mt-2 text-xs leading-[1.75] text-ink-secondary">
                {t(`home.platform.${k}_text`)}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function PlanBlock({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={`mk-plan-block absolute block w-[51px] border border-[#879e6c] shadow-[7px_7px_0_#829b68] ${className}`}
    />
  );
}
