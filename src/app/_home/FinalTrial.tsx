import Link from "next/link";
import { Btn, Eyebrow, Glyph, TwoLine, type HomeT } from "./ui";
import { ANCHORS } from "./nav";

/** The closing invitation with the trial's real conditions and links to plans and terms. */
export function FinalTrial({ t, primaryHref }: { t: HomeT; primaryHref: string }) {
  return (
    <section
      id="trial"
      className="mx-auto w-full max-w-[1200px] scroll-mt-20 px-5 py-10 sm:px-6 lg:py-16"
      aria-labelledby="trial-title"
    >
      <div className="grid items-center gap-6 overflow-hidden rounded-md bg-mk-forest px-6 py-8 text-mk-forest-ink sm:px-10 sm:py-12 lg:grid-cols-[1.4fr_1fr] lg:gap-11">
        <div>
          <Eyebrow tone="lime">{t("home.trial.eyebrow")}</Eyebrow>
          <h2
            id="trial-title"
            className="mk-tight mt-4 text-balance text-[2.1rem] font-medium leading-[1.12] tracking-[-0.04em] text-white sm:text-[2.5rem]"
          >
            <TwoLine text={t("home.trial.title")} emClass="text-white" />
          </h2>
          <p className="mt-4 max-w-[24rem] text-xs leading-[1.8] text-mk-forest-dim sm:text-sm">
            {t("home.trial.body")}
          </p>
        </div>
        <div className="border-t border-white/10 pt-6 lg:border-s lg:border-t-0 lg:ps-10 lg:pt-0">
          <p className="mb-5 flex items-center gap-3">
            <strong className="mk-tight text-[3.4rem] font-medium leading-none tracking-[-0.05em] text-mk-lime">
              30
            </strong>
            <span className="text-xs leading-snug text-[#c6d9ba] sm:text-sm">
              {t("home.trial.days_label")}
            </span>
          </p>
          <Btn href={primaryHref} tone="lime" size="lg" className="w-full">
            {t("home.trial.cta")}
            <Glyph>↗</Glyph>
          </Btn>
          <p className="mt-3 text-center text-[0.7rem] leading-[1.8] text-[#afc39f]">
            {t("home.trial.after")}{" "}
            <a href={ANCHORS.plans} className="underline underline-offset-2 hover:text-white">
              {t("home.trial.plans_link")}
            </a>{" "}
            ·{" "}
            <Link href="/terms" className="underline underline-offset-2 hover:text-white">
              {t("home.trial.terms_link")}
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}
