import { getT, getServerLocale } from "@/platform/i18n/server";
import { languageVars, offeredLocales } from "@/platform/i18n/offered";
import { directionFor } from "@/platform/i18n";
import { term } from "@/platform/terminology";
import "./home.css";
import { notoSansArabic, spaceGrotesk } from "./fonts";
import { CompanyApp } from "./CompanyApp";
import { Faq } from "./Faq";
import { FinalTrial } from "./FinalTrial";
import { SiteFooter, SiteHeader } from "./Frame";
import { Hero } from "./Hero";
import { JsonLd } from "./JsonLd";
import { LanguageSwitch } from "./LanguageSwitch";
import { PlatformDepth } from "./PlatformDepth";
import { Plans } from "./Plans";
import { IndustryStrip, OwnerQuestions } from "./Questions";
import { GettingStarted } from "./Start";
import { TryIt } from "./TryIt";
import { buildDemoCopy, buildDemoLabels } from "./demoCopy";
import { homeNav } from "./nav";
import { pricingTiers } from "./pricing";
import { SectionHead, TwoLine } from "./ui";

export const CANONICAL = "https://www.idaraworks.com";

/** Short tile labels for the offered languages, e.g. "EN / ع". */
const SHORT: Record<string, string> = { en: "EN", ar: "ع", es: "ES" };

/**
 * The public IdaraWorks homepage. Server-rendered end to end; the interactive
 * demonstration and the mobile menu are the only client islands. Bilingual via
 * getT() and the root layout's lang/dir; logical properties throughout, so the
 * page mirrors under RTL. A signed-in visitor gets "Open workspace" instead of
 * being sent back through registration.
 */
export async function HomePage({ workspaceHref }: { workspaceHref: string | null }) {
  const t = await getT();
  const locale = await getServerLocale();
  const dir = directionFor(locale);
  const { languages, languages_or: languagesOr } = languageVars(locale);
  const offered = offeredLocales();
  const { primary, secondary, sections } = homeNav(t, workspaceHref);
  // The platform's default noun for a piece of work, lower-cased mid-sentence
  // in English ("that job"); Arabic and Spanish nouns keep their form.
  const jobTerm = term("job", { locale });
  const job = locale === "en" ? jobTerm.toLocaleLowerCase("en") : jobTerm;
  const languageSlot = <LanguageSwitch ariaLabel={t("home.nav.switch_language")} />;

  return (
    <div
      dir={dir}
      className={`iw-home ${spaceGrotesk.variable} ${notoSansArabic.variable} flex min-h-dvh flex-col bg-page text-ink`}
    >
      <JsonLd
        canonical={CANONICAL}
        languages={offered}
        freePriceUsd={pricingTiers()[0]!.price.monthlyUsd}
      />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:flex focus:min-h-11 focus:items-center focus:rounded-md focus:border focus:border-line-strong focus:bg-card focus:px-4 focus:text-sm focus:font-semibold focus:text-ink focus:shadow-pop"
      >
        {t("home.nav.skip")}
      </a>

      <SiteHeader
        t={t}
        sections={sections}
        primary={primary}
        secondary={secondary}
        languageSlot={languageSlot}
      />

      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        <Hero
          t={t}
          primaryHref={primary.href}
          languagesOr={languagesOr}
          languageTile={offered.map((l) => SHORT[l] ?? l.toUpperCase()).join(" / ")}
        />
        <IndustryStrip t={t} />
        <OwnerQuestions t={t} job={job} />

        <section
          id="try-it"
          className="mx-auto w-full max-w-[1200px] scroll-mt-20 px-5 pb-14 sm:px-6 lg:pb-20"
          aria-labelledby="try-it-title"
        >
          <div className="border-t border-line pt-10 lg:pt-12">
            <SectionHead
              id="try-it-title"
              eyebrow={t("home.demo.eyebrow")}
              title={<TwoLine text={t("home.demo.title")} emClass="text-ink" />}
              body={t("home.demo.body", { job })}
            />
          </div>
          <TryIt copy={buildDemoCopy(t, job)} labels={buildDemoLabels(t, primary.href)} />
          <p className="mx-auto mt-7 max-w-[55rem] text-center text-sm leading-[1.8] text-ink-secondary">
            <strong className="font-semibold text-ink">{t("home.demo.connected_a")}</strong>
            <br />
            {t("home.demo.connected_b")}
          </p>
        </section>

        <PlatformDepth t={t} />
        <CompanyApp t={t} />
        <GettingStarted t={t} job={job} />
        <Plans
          t={t}
          locale={locale}
          languages={languages}
          languagesOr={languagesOr}
          cta={primary}
        />
        <Faq t={t} />
        <FinalTrial t={t} primaryHref={primary.href} />
      </main>

      <SiteFooter
        t={t}
        primary={primary}
        languageSlot={languageSlot}
        year={String(new Date().getFullYear())}
      />
    </div>
  );
}
