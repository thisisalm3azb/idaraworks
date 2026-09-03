import Link from "next/link";
import { Icon, type IconName } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { languageVars } from "@/platform/i18n/offered";
import { directionFor } from "@/platform/i18n";
import { SHOWCASE_AGENT_IDS, type ShowcaseAgentId } from "@/platform/agents/registry";
import { AgentShowcase, type AgentVM } from "./AgentShowcase";
import { BusinessOS } from "./BusinessOS";
import { BusinessPassport } from "./BusinessPassport";
import { ClosingSection } from "./ClosingSection";
import { FlowJourney } from "./FlowJourney";
import { FoundationShapes } from "./FoundationShapes";
import { LanguageSwitch } from "./LanguageSwitch";
import { MobileMenu } from "./MobileMenu";
import { PricingPlans } from "./PricingPlans";
import { ProductVisual } from "./ProductVisual";
import { TrustBoundary } from "./TrustBoundary";
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

/**
 * H13: the interim visual identity for each canonical agent — one coherent
 * editorial palette (deep mineral greens and warm earth tones), a monogram
 * and a domain icon per agent. This backs the designed monogram tiles until
 * the commissioned portraits specified in docs/design/AGENT_PORTRAIT_SYSTEM.md
 * are produced (see PORTRAIT_ASSETS in AgentShowcase.tsx for the swap point).
 */
const AGENT_INK = "#EFECE2";
const AGENT_VISUALS: Record<ShowcaseAgentId, { monogram: string; icon: IconName; bg: string }> = {
  manager: { monogram: "M", icon: "grid", bg: "#0B5348" },
  executive: { monogram: "EX", icon: "building", bg: "#2E3B36" },
  operations: { monogram: "OP", icon: "briefcase", bg: "#145C50" },
  project: { monogram: "PR", icon: "calendar", bg: "#4A5340" },
  sales_crm: { monogram: "SC", icon: "megaphone", bg: "#6B4A2A" },
  accounting: { monogram: "AC", icon: "receipt", bg: "#37474B" },
  finance: { monogram: "FI", icon: "banknote", bg: "#27473F" },
  people_payroll: { monogram: "PP", icon: "users", bg: "#5A4632" },
  inventory_purchasing: { monogram: "IN", icon: "truck", bg: "#565C4C" },
  planning_analytics: { monogram: "PL", icon: "trendUp", bg: "#1F4D5A" },
};

function agentVM(id: ShowcaseAgentId, t: (k: string) => string): AgentVM {
  const v = AGENT_VISUALS[id];
  return {
    id,
    name: t(`home.agents.${id}.name`),
    role: t(`home.agents.${id}.role`),
    outcome: t(`home.agents.${id}.outcome`),
    question: t(`home.agents.${id}.q`),
    monogram: v.monogram,
    icon: v.icon,
    tone: { bg: v.bg, ink: AGENT_INK },
  };
}

export async function HomePage({ workspaceHref }: { workspaceHref: string | null }) {
  const t = await getT();
  const locale = await getServerLocale();
  // H29: the shipped interface languages, named in the reader's own language.
  // Every sentence on this page that lists them takes this as a variable.
  const { languages, languages_or: languagesOr } = languageVars(locale);
  const dir = directionFor(locale);
  const { authed, primary, secondary, sections } = homeNav(t, workspaceHref);

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
            <span className="hidden items-center gap-2 lg:flex" aria-hidden="true">
              <span className="h-4 w-px bg-line-strong" />
              <span className="text-xs font-medium tracking-wide text-ink-muted">
                {t("home.nav.clay")}
              </span>
            </span>
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
            <p className="mt-3 max-w-xl text-pretty text-sm leading-relaxed text-ink-muted">
              {t("home.hero.support")}
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
            <p className="mt-4 text-sm text-ink-muted">
              {t("home.hero.reassure", { languages_or: languagesOr })}
            </p>
          </div>
          <div className="lg:ps-2">
            <ProductVisual t={t} dir={dir} />
          </div>
        </section>

        {/* ── 2. The agent command room (H13) ──────────────────────────────── */}
        <section id="agents" className="mx-auto w-full max-w-6xl scroll-mt-16 px-4 pb-16 pt-2">
          <SectionHead
            eyebrow={t("home.agents.eyebrow")}
            title={t("home.agents.title")}
            body={t("home.agents.intro")}
          />
          <AgentShowcase
            manager={agentVM("manager", t)}
            specialists={SHOWCASE_AGENT_IDS.filter((id) => id !== "manager").map((id) =>
              agentVM(id, t),
            )}
            labels={{
              evidence: t("home.agents.evidence"),
              approval: t("home.agents.approval"),
              record: t("home.agents.record"),
              ask: t("home.agents.ask"),
            }}
          />
        </section>

        {/* ── 3. The business journey (H4) ─────────────────────────────────── */}
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
          <FoundationShapes t={t} languages={languages} />
        </section>

        {/* ── 4. The Business OS (H11) ─────────────────────────────────────── */}
        <section id="product" className="scroll-mt-16 border-y border-line bg-card">
          <div className="mx-auto w-full max-w-6xl px-4 py-16">
            <SectionHead
              eyebrow={t("home.os.eyebrow")}
              title={t("home.os.title")}
              body={t("home.os.body")}
            />
            <BusinessOS t={t} />
          </div>
        </section>

        {/* ── 5. The business passport (H7) ────────────────────────────────── */}
        <section id="international" className="mx-auto w-full max-w-6xl scroll-mt-16 px-4 py-16">
          <SectionHead
            eyebrow={t("home.gcc.eyebrow")}
            title={t("home.gcc.title")}
            body={t("home.gcc.subtitle", { languages })}
          />
          <BusinessPassport t={t} languages={languages} />
        </section>

        {/* ── 6. Trust and privacy (H8) ────────────────────────────────────── */}
        <section id="trust" className="scroll-mt-16 border-t border-line">
          <div className="mx-auto w-full max-w-6xl px-4 py-14">
            <TrustBoundary t={t} />
          </div>
        </section>

        {/* ── 7. Pricing ───────────────────────────────────────────────────── */}
        <section id="pricing" className="scroll-mt-16 border-y border-line bg-card">
          <div className="mx-auto w-full max-w-6xl px-4 py-16">
            <SectionHead
              eyebrow={t("home.pricing.eyebrow")}
              title={t("home.pricing.title")}
              body={t("home.pricing.subtitle")}
            />
            {/* The comparison spine: what every plan shares (H9). */}
            <div className="mx-auto mt-8 max-w-3xl rounded-lg border border-line bg-page px-4 py-3">
              <p className="text-center text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
                {t("home.pricing.spine_label")}
              </p>
              <ul className="mt-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5">
                {(["s1", "s2", "s3", "s4"] as const).map((k) => (
                  <li key={k} className="flex items-center gap-1.5 text-xs text-ink">
                    <Icon name="check" size={12} aria-hidden className="shrink-0 text-brand" />
                    {t(`home.pricing.${k}`, { languages })}
                  </li>
                ))}
              </ul>
            </div>

            {/* The plans (H9.1): approved launch targets with an accessible
                Monthly/Annual selector; strings resolve here on the server. */}
            <PricingPlans
              labels={{
                group: t("home.pricing.billing_label"),
                monthly: t("home.pricing.billing_monthly"),
                annual: t("home.pricing.billing_annual"),
                save: t("home.pricing.billing_save"),
              }}
              plans={pricingTiers().map((tier, i) => ({
                key: tier.key,
                name: locale === "ar" ? tier.names.ar : tier.names.en,
                tag: t(tier.tagKey),
                users: t(tier.usersKey),
                outcomes: tier.outcomeKeys.map((o) =>
                  t(o, { languages, languages_or: languagesOr }),
                ),
                micro: t(tier.microKey),
                badge: tier.badgeKey ? t(tier.badgeKey) : null,
                featured: tier.featured,
                depth: i + 1,
                monthly: {
                  amount: `$${tier.price.monthlyUsd}`,
                  suffix: t(
                    tier.price.monthlyUsd === 0
                      ? "home.pricing.suffix_free"
                      : "home.pricing.suffix_monthly",
                  ),
                },
                annual: {
                  amount: `$${tier.price.annualPerMonthUsd}`,
                  suffix: t(
                    tier.price.annualPerMonthUsd === 0
                      ? "home.pricing.suffix_free"
                      : "home.pricing.suffix_annual",
                  ),
                  billed:
                    tier.price.annualBilledUsd > 0
                      ? t("home.pricing.billed_annually", {
                          amount: `$${tier.price.annualBilledUsd}`,
                        })
                      : "",
                },
                cta: { href: primary.href, label: primary.label },
              }))}
            />
            <p className="mt-6 text-center text-sm text-ink-secondary">{t("home.pricing.early")}</p>
            <p className="mt-2 text-center text-sm text-ink-secondary">
              {t("home.pricing.existing")}{" "}
              <Link href={LOGIN} className="font-medium text-brand hover:underline">
                {t("home.nav.login")}
              </Link>
            </p>
          </div>
        </section>

        {/* ── 8. Closing: from setup to a living workspace (H9.1) ──────────── */}
        <section className="mx-auto w-full max-w-6xl px-4 py-20">
          <ClosingSection
            t={t}
            primary={authed ? primary : { href: primary.href, label: t("home.close.cta") }}
            secondary={secondary}
          />
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
            <a href="#how" className="text-ink-secondary hover:text-ink">
              {t("home.nav.how")}
            </a>
            <a href="#product" className="text-ink-secondary hover:text-ink">
              {t("home.nav.product")}
            </a>
            <a href="#international" className="text-ink-secondary hover:text-ink">
              {t("home.nav.international")}
            </a>
            <a href="#trust" className="text-ink-secondary hover:text-ink">
              {t("home.nav.trust")}
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
