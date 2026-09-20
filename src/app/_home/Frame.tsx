import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/platform/ui";
import { MobileMenu } from "./MobileMenu";
import { Btn, type HomeT } from "./ui";
import { ANCHORS, LOGIN_HREF, type HomeCta } from "./nav";

/** The IdaraWorks mark: a four-point star, forest with a lime core. */
export function Brand({ label }: { label: string }) {
  return (
    <Link
      href="/"
      aria-label={label}
      className="mk-tight flex min-h-11 items-center gap-2.5 text-[1.35rem] font-semibold tracking-[-0.04em] text-ink"
    >
      <svg viewBox="0 0 36 40" width="26" height="29" aria-hidden className="shrink-0">
        <path d="M18 1 22 14 35 20 22 24 18 39 13 26 1 20 13 15Z" fill="#315b4e" />
        <path d="m18 9 2 10 9 1-10 3-1 9-3-11-7-1 9-3Z" fill="#d9f5a3" />
      </svg>
      IdaraWorks<span className="text-brand">.</span>
    </Link>
  );
}

export function SiteHeader({
  t,
  sections,
  primary,
  secondary,
  languageSlot,
}: {
  t: HomeT;
  sections: HomeCta[];
  primary: HomeCta;
  secondary: HomeCta | null;
  languageSlot: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-page/90 backdrop-blur">
      {/* 3.5rem on phones: the mobile menu sheet opens below that exact height. */}
      <div className="mx-auto flex min-h-14 w-full max-w-[1440px] items-center justify-between gap-3 px-5 sm:px-[4%] md:grid lg:px-[5.5%] md:min-h-[4.25rem] md:grid-cols-[1fr_auto_1fr]">
        <div className="md:justify-self-start">
          <Brand label={t("home.nav.brand_home")} />
        </div>
        <nav
          className="hidden items-center gap-1 md:flex md:justify-self-center"
          aria-label={t("home.nav.primary")}
        >
          {sections.map((s) => (
            <a
              key={s.href}
              href={s.href}
              className="flex min-h-11 items-center rounded-sm px-2 text-xs font-medium text-ink-secondary hover:bg-brand-soft hover:text-ink lg:px-3"
            >
              {s.label}
            </a>
          ))}
        </nav>
        <div className="hidden items-center gap-0.5 md:flex md:justify-self-end lg:gap-2">
          {languageSlot}
          {secondary ? (
            <Link
              href={secondary.href}
              className="flex min-h-11 items-center rounded-sm px-2 text-xs font-medium text-ink hover:bg-brand-soft lg:px-3"
            >
              {secondary.label}
            </Link>
          ) : null}
          <Btn href={primary.href} size="sm">
            {primary.label}
            <span aria-hidden>↗</span>
          </Btn>
        </div>
        <MobileMenu
          links={sections.map((s) => ({ href: s.href, label: s.label, section: true }))}
          primary={primary}
          secondary={secondary}
          openLabel={t("home.nav.open_menu")}
          closeLabel={t("home.nav.close_menu")}
          navLabel={t("home.nav.primary")}
          languageSlot={languageSlot}
        />
      </div>
    </header>
  );
}

export function SiteFooter({
  t,
  primary,
  languageSlot,
  year,
}: {
  t: HomeT;
  primary: HomeCta;
  languageSlot: ReactNode;
  year: string;
}) {
  const links: HomeCta[] = [
    { href: ANCHORS.platform, label: t("home.nav.platform") },
    { href: ANCHORS.demo, label: t("home.footer.demo") },
    { href: ANCHORS.plans, label: t("home.plans.eyebrow") },
    { href: ANCHORS.questions, label: t("home.footer.questions") },
    { href: LOGIN_HREF, label: t("home.nav.login") },
    { href: "/terms", label: t("auth.gateway.terms") },
    { href: "/privacy", label: t("auth.gateway.privacy") },
  ];
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-5 py-8 sm:flex-row sm:items-start sm:justify-between sm:px-[5.5%]">
        <div>
          <Brand label={t("home.nav.brand_home")} />
          <p className="mt-1 max-w-[22rem] text-[0.7rem] leading-[1.8] text-ink-muted">
            {t("home.footer.tagline")}
            <br />
            {t("home.footer.samples")}
          </p>
        </div>
        <nav
          className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[0.7rem] sm:justify-end"
          aria-label={t("home.footer.nav")}
        >
          {links.map((l) =>
            l.href.startsWith("#") ? (
              <a key={l.href} href={l.href} className="text-ink-secondary hover:text-ink">
                {l.label}
              </a>
            ) : (
              <Link key={l.href} href={l.href} className="text-ink-secondary hover:text-ink">
                {l.label}
              </Link>
            ),
          )}
          <Link href={primary.href} className="font-semibold text-brand-strong hover:underline">
            {primary.label}
          </Link>
          {languageSlot}
        </nav>
      </div>
      <div className="mx-auto flex w-full max-w-[1440px] items-center gap-2 px-5 pb-6 text-[0.65rem] text-ink-muted sm:px-[5.5%]">
        <Icon name="grid" size={12} aria-hidden />
        {t("home.footer.rights", { year })}
      </div>
    </footer>
  );
}
