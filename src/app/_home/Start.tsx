import { Btn, Eyebrow, Glyph, TwoLine, type HomeT } from "./ui";
import { ANCHORS } from "./nav";

/**
 * A manageable first step: one workflow, the right people, then more. The
 * three steps describe the shipped onboarding (language and starting setup,
 * editable terminology and stages; invitations with roles; a first quote or
 * piece of work) and promise no automatic migration.
 */
export function GettingStarted({ t, job }: { t: HomeT; job: string }) {
  return (
    <section
      id="getting-started"
      className="scroll-mt-20 border-t border-line"
      aria-labelledby="getting-started-title"
    >
      <div className="mx-auto grid w-full max-w-[1200px] gap-8 px-5 py-14 sm:px-6 lg:grid-cols-2 lg:gap-16 lg:py-20">
        <div>
          <Eyebrow>{t("home.start.eyebrow")}</Eyebrow>
          <h2
            id="getting-started-title"
            className="mk-tight mt-4 text-balance text-[2.1rem] font-medium leading-[1.15] tracking-[-0.04em] text-ink sm:text-[2.6rem]"
          >
            <TwoLine text={t("home.start.title")} emClass="text-ink" />
          </h2>
          <p className="mt-4 max-w-[24rem] text-sm leading-[1.9] text-ink-secondary">
            {t("home.start.body", { job })}
          </p>
          <Btn href={ANCHORS.demo} tone="outline" className="mt-5">
            {t("home.start.cta")}
            <Glyph>↑</Glyph>
          </Btn>
        </div>
        <ol className="m-0 grid list-none p-0">
          {([1, 2, 3] as const).map((n) => (
            <li
              key={n}
              className="grid grid-cols-[2rem_1fr] gap-4 border-b border-line py-6 first:pt-0"
            >
              <span
                aria-hidden
                className="grid size-[1.9rem] place-items-center rounded-full border border-line-strong text-[0.7rem] text-brand"
              >
                {String(n).padStart(2, "0")}
              </span>
              <div>
                <h3 className="mk-tight text-lg font-medium tracking-[-0.02em] text-ink">
                  {t(`home.start.s${n}_title`)}
                </h3>
                <p className="mt-2 text-xs leading-[1.8] text-ink-secondary">
                  {t(`home.start.s${n}_text`, { job })}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
