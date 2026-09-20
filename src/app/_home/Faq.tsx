import { Eyebrow, TwoLine, type HomeT } from "./ui";

/**
 * Six questions an owner asks before trying a system, answered from the
 * shipped product: the trial, what follows it, starting small and imports,
 * editable templates, the branded app, and who sees what. Native disclosure
 * elements: keyboard and screen-reader behaviour come from the browser.
 */
export function Faq({ t }: { t: HomeT }) {
  return (
    <section
      id="questions"
      className="scroll-mt-20 border-y border-line bg-mk-strip"
      aria-labelledby="questions-title"
    >
      <div className="mx-auto grid w-full max-w-[1152px] gap-6 px-5 py-14 sm:px-6 lg:grid-cols-[0.85fr_1.2fr] lg:gap-20 lg:py-16">
        <div>
          <Eyebrow>{t("home.faq.eyebrow")}</Eyebrow>
          <h2
            id="questions-title"
            className="mk-tight mt-4 text-balance text-[2rem] font-medium leading-[1.2] tracking-[-0.04em] text-ink sm:text-[2.25rem]"
          >
            <TwoLine text={t("home.faq.title")} emClass="text-ink" />
          </h2>
          <p className="mt-4 max-w-[17rem] text-xs leading-[1.8] text-ink-secondary">
            {t("home.faq.body")}
          </p>
        </div>
        <div className="mk-faq">
          {([1, 2, 3, 4, 5, 6] as const).map((n) => (
            <details key={n} className="border-b border-line-strong">
              <summary className="relative cursor-pointer py-5 pe-8 text-sm leading-normal text-ink">
                {t(`home.faq.q${n}`)}
              </summary>
              <p className="m-0 pb-5 pe-6 text-xs leading-[1.85] text-ink-secondary">
                {t(`home.faq.a${n}`)}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
