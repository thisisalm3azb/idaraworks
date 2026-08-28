import Link from "next/link";
import { Icon, type IconName } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { directionFor } from "@/platform/i18n";
import { FlowJourney } from "./FlowJourney";
import { FoundationShapes } from "./FoundationShapes";
import { LanguageSwitch } from "./LanguageSwitch";
import { MobileMenu } from "./MobileMenu";
import { ProductVisual } from "./ProductVisual";
import { pricingTiers } from "./pricing";
import { homeNav, LOGIN_HREF } from "./nav";

/**
 * The public IdaraWorks homepage (005A). Server-rendered; the only client
 * island is the mobile menu. Fully bilingual via getT() + the root layout's
 * lang/dir. Logical properties throughout so the whole page mirrors under RTL.
 *
 * Signed-out visitors get Get Started / Log in; an authenticated visitor gets
 * an "Open workspace" action instead of being forced through registration.
 */
const LOGIN = LOGIN_HREF;

export async function HomePage({ workspaceHref }: { workspaceHref: string | null }) {
  const t = await getT();
  const locale = await getServerLocale();
  const dir = directionFor(locale);
  const { primary, secondary, sections } = homeNav(t, workspaceHref);

  return (
    <div className="flex min-h-dvh flex-col bg-page text-ink">
      {/* Skip link (H2): invisible until keyboard focus, then a fixed, high-z
          card above the sticky header. Targets the focusable <main id="main">. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:flex focus:min-h-11 focus:items-center focus:rounded-md focus:border focus:border-line-strong focus:bg-card focus:px-4 focus:text-sm focus:font-semibold focus:text-ink focus:shadow-pop"
      >
        {t("home.nav.skip")}
      </a>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-line bg-page/85 backdrop-blur">
        {/* Desktop hierarchy (H2): brand at the start edge, section nav truly
            centered, language/login/primary at the end edge. Mobile keeps the
            flex row (brand + burger); the hidden desktop groups leave the grid. */}
        <div className="mx-auto flex min-h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 md:grid md:grid-cols-[1fr_auto_1fr]">
          <Link
            href="/"
            aria-label={t("home.nav.brand_home")}
            className="flex min-h-11 items-center gap-2 font-semibold text-ink md:justify-self-start"
          >
            <span
              aria-hidden
              className="flex size-7 items-center justify-center rounded-md bg-brand text-ink-inverse"
            >
              <Icon name="grid" size={16} />
            </span>
            <span>IdaraWorks</span>
          </Link>

          <nav
            className="hidden items-center gap-1 md:flex md:justify-self-center"
            aria-label={t("home.nav.primary")}
          >
            {sections.map((s) => (
              <a
                key={s.href}
                href={s.href}
                className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-ink-secondary hover:bg-sunken hover:text-ink"
              >
                {s.label}
              </a>
            ))}
          </nav>

          <div className="hidden items-center gap-2 md:flex md:justify-self-end">
            <LanguageSwitch ariaLabel={t("home.nav.switch_language")} />
            {secondary ? (
              <Link
                href={secondary.href}
                className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-ink hover:bg-sunken"
              >
                {secondary.label}
              </Link>
            ) : null}
            <Link
              href={primary.href}
              className="inline-flex min-h-11 items-center rounded-md bg-brand px-4 text-sm font-semibold text-ink-inverse hover:bg-brand-strong"
            >
              {primary.label}
            </Link>
          </div>

          <MobileMenu
            links={sections.map((s) => ({ href: s.href, label: s.label, section: true }))}
            primary={primary}
            secondary={secondary}
            openLabel={t("home.nav.open_menu")}
            closeLabel={t("home.nav.close_menu")}
            navLabel={t("home.nav.primary")}
            languageSlot={<LanguageSwitch ariaLabel={t("home.nav.switch_language")} />}
          />
        </div>
      </header>

      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        {/* ── 1. Hero ──────────────────────────────────────────────────────── */}
        <section className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-14 sm:py-20 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-xs font-medium text-ink-secondary">
              <span className="size-1.5 rounded-full bg-brand" aria-hidden />
              {t("home.hero.eyebrow")}
            </p>
            <h1 className="mt-4 text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl lg:text-[3.4rem]">
              {t("home.hero.title")}
            </h1>
            <p className="mt-5 max-w-xl text-pretty text-lg leading-relaxed text-ink-secondary">
              {t("home.hero.subtitle")}
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Link
                href={primary.href}
                className="inline-flex min-h-12 items-center rounded-md bg-brand px-6 text-base font-semibold text-ink-inverse shadow-card hover:bg-brand-strong"
              >
                {primary.label}
              </Link>
              <a
                href="#how"
                className="inline-flex min-h-12 items-center gap-2 rounded-md border border-line-strong bg-card px-5 text-base font-medium text-ink hover:bg-sunken"
              >
                {t("home.hero.secondary")}
                <Icon name="chart" size={16} aria-hidden />
              </a>
            </div>
            <p className="mt-4 text-sm text-ink-muted">{t("home.hero.reassure")}</p>
          </div>
          <div className="lg:ps-2">
            <ProductVisual t={t} dir={dir} />
          </div>
        </section>

        {/* ── 2. The business journey (H4) ─────────────────────────────────── */}
        <section id="how" className="scroll-mt-16 border-y border-line bg-card">
          <div className="mx-auto w-full max-w-6xl px-4 py-16">
            <SectionHead
              eyebrow={t("home.flow.eyebrow")}
              title={t("home.flow.title")}
              body={t("home.flow.subtitle")}
            />
            <FlowJourney t={t} />
          </div>
        </section>

        {/* ── 3. One foundation, different shapes (H5) ─────────────────────── */}
        <section className="mx-auto w-full max-w-6xl px-4 py-16">
          <FoundationShapes t={t} />
        </section>

        {/* ── 4. Core capabilities (organized by outcome) ──────────────────── */}
        <section id="product" className="scroll-mt-16 border-y border-line bg-card">
          <div className="mx-auto w-full max-w-6xl px-4 py-16">
            <SectionHead
              eyebrow={t("home.caps.eyebrow")}
              title={t("home.caps.title")}
              body={t("home.caps.subtitle")}
            />
            <div className="mt-10 grid gap-4 md:grid-cols-2">
              {(
                [
                  ["banknote", "win"],
                  ["briefcase", "run"],
                  ["truck", "supply"],
                  ["chart", "see"],
                ] as [IconName, string][]
              ).map(([icon, k]) => (
                <div key={k} className="rounded-lg border border-line bg-page p-6 shadow-card">
                  <div className="flex items-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded-md bg-brand-soft text-brand">
                      <Icon name={icon} size={20} aria-hidden />
                    </span>
                    <h3 className="text-lg font-semibold text-ink">{t(`home.caps.${k}.title`)}</h3>
                  </div>
                  <p className="mt-2 text-sm text-ink-secondary">{t(`home.caps.${k}.desc`)}</p>
                  <ul className="mt-4 flex flex-wrap gap-2">
                    {["i1", "i2", "i3"].map((i) => (
                      <li
                        key={i}
                        className="inline-flex items-center rounded-full border border-line bg-card px-3 py-1 text-xs font-medium text-ink-secondary"
                      >
                        {t(`home.caps.${k}.${i}`)}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── 5. International and regional fit ────────────────────────────── */}
        <section id="international" className="mx-auto w-full max-w-6xl scroll-mt-16 px-4 py-16">
          <SectionHead
            eyebrow={t("home.gcc.eyebrow")}
            title={t("home.gcc.title")}
            body={t("home.gcc.subtitle")}
          />
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ["globe", "bilingual"],
                ["building", "identity"],
                ["receipt", "documents"],
                ["calculator", "regional"],
              ] as [IconName, string][]
            ).map(([icon, k]) => (
              <div key={k} className="rounded-lg border border-line bg-card p-5 shadow-card">
                <span className="flex size-9 items-center justify-center rounded-md bg-brand-soft text-brand">
                  <Icon name={icon} size={18} aria-hidden />
                </span>
                <h3 className="mt-3 text-base font-semibold text-ink">
                  {t(`home.gcc.${k}.title`)}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">
                  {t(`home.gcc.${k}.desc`)}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── 6. Pricing ───────────────────────────────────────────────────── */}
        <section id="pricing" className="scroll-mt-16 border-y border-line bg-card">
          <div className="mx-auto w-full max-w-6xl px-4 py-16">
            <SectionHead
              eyebrow={t("home.pricing.eyebrow")}
              title={t("home.pricing.title")}
              body={t("home.pricing.subtitle")}
            />
            <div className="mt-10 grid gap-4 lg:grid-cols-3">
              {pricingTiers().map((tier) => (
                <div
                  key={tier.key}
                  className={
                    "flex flex-col rounded-lg border bg-page p-6 " +
                    (tier.featured
                      ? "border-brand shadow-pop ring-1 ring-brand/20"
                      : "border-line shadow-card")
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-lg font-semibold text-ink">
                      {locale === "ar" ? tier.names.ar : tier.names.en}
                    </h3>
                    {tier.badgeKey ? (
                      <span className="inline-flex items-center rounded-full bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand">
                        {t(tier.badgeKey)}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-ink-secondary">{t(tier.tagKey)}</p>
                  <p className="mt-4 text-sm font-medium text-ink">
                    {t("home.pricing.finalizing")}
                  </p>
                  <ul className="mt-4 flex flex-1 flex-col gap-2.5">
                    {tier.outcomeKeys.map((o) => (
                      <li key={o} className="flex items-start gap-2.5 text-sm text-ink-secondary">
                        <Icon
                          name="check"
                          size={16}
                          aria-hidden
                          className="mt-0.5 shrink-0 text-brand"
                        />
                        <span>{t(o)}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href={primary.href}
                    className={
                      "mt-6 inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-semibold " +
                      (tier.featured
                        ? "bg-brand text-ink-inverse hover:bg-brand-strong"
                        : "border border-line-strong bg-card text-ink hover:bg-sunken")
                    }
                  >
                    {primary.label}
                  </Link>
                </div>
              ))}
            </div>
            <p className="mt-6 text-center text-xs text-ink-muted">{t("home.pricing.note")}</p>
          </div>
        </section>

        {/* ── 7. Final call to action ──────────────────────────────────────── */}
        <section className="mx-auto w-full max-w-6xl px-4 py-20">
          <div className="overflow-hidden rounded-xl border border-hero-line bg-hero px-6 py-14 text-center shadow-pop sm:px-10">
            <h2 className="mx-auto max-w-2xl text-balance text-3xl font-semibold leading-tight text-white sm:text-4xl">
              {t("home.cta.title")}
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-pretty text-base leading-relaxed text-hero-dim">
              {t("home.cta.body")}
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                href={primary.href}
                className="inline-flex min-h-12 items-center rounded-md bg-white px-6 text-base font-semibold text-ink hover:bg-white/90"
              >
                {primary.label}
              </Link>
              {secondary ? (
                <Link
                  href={secondary.href}
                  className="inline-flex min-h-12 items-center rounded-md border border-hero-line px-5 text-base font-medium text-white hover:bg-white/10"
                >
                  {secondary.label}
                </Link>
              ) : null}
            </div>
          </div>
        </section>
      </main>

      {/* ── 8. Footer ──────────────────────────────────────────────────────── */}
      <footer className="border-t border-line bg-page">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 font-semibold text-ink">
            <span
              aria-hidden
              className="flex size-7 items-center justify-center rounded-md bg-brand text-ink-inverse"
            >
              <Icon name="grid" size={16} />
            </span>
            <span>IdaraWorks</span>
          </div>
          <nav
            className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm"
            aria-label={t("home.footer.nav")}
          >
            <a href="#product" className="text-ink-secondary hover:text-ink">
              {t("home.nav.product")}
            </a>
            <a href="#pricing" className="text-ink-secondary hover:text-ink">
              {t("home.nav.pricing")}
            </a>
            <Link href={LOGIN} className="text-ink-secondary hover:text-ink">
              {t("home.nav.login")}
            </Link>
            <Link href="/terms" className="text-ink-secondary hover:text-ink">
              {t("auth.gateway.terms")}
            </Link>
            <Link href="/privacy" className="text-ink-secondary hover:text-ink">
              {t("auth.gateway.privacy")}
            </Link>
            <Link href={primary.href} className="font-medium text-brand hover:underline">
              {primary.label}
            </Link>
            <LanguageSwitch ariaLabel={t("home.nav.switch_language")} />
          </nav>
        </div>
        <div className="mx-auto w-full max-w-6xl px-4 pb-8">
          <p className="text-xs text-ink-muted">
            {t("home.footer.rights", { year: String(new Date().getFullYear()) })}
          </p>
        </div>
      </footer>
    </div>
  );
}

function SectionHead({
  eyebrow,
  title,
  body,
  align = "center",
}: {
  eyebrow: string;
  title: string;
  body: string;
  align?: "center" | "start";
}) {
  return (
    <div className={align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-xl"}>
      <p className="text-xs font-semibold uppercase tracking-wide text-brand">{eyebrow}</p>
      <h2 className="mt-2 text-balance text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-[2.1rem]">
        {title}
      </h2>
      <p className="mt-3 text-pretty text-base leading-relaxed text-ink-secondary">{body}</p>
    </div>
  );
}
