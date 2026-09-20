import Link from "next/link";
import { Icon } from "@/platform/ui";
import type { Locale } from "@/platform/i18n";
import { pricingTiers } from "./pricing";
import { Eyebrow, SectionHead, type HomeT } from "./ui";

/**
 * Plans, compactly: the three public tiers from the one typed pricing source
 * (approved launch targets), each with its real included-user line and
 * outcomes, and the honest early-access note. Prices render from config,
 * never from copy; no selector and no purchase flow. The trial section links here.
 */
export function Plans({
  t,
  locale,
  languages,
  languagesOr,
  cta,
}: {
  t: HomeT;
  locale: Locale;
  languages: string;
  languagesOr: string;
  cta: { href: string; label: string };
}) {
  const tiers = pricingTiers();
  return (
    <section id="plans" className="scroll-mt-20 border-t border-line" aria-labelledby="plans-title">
      <div className="mx-auto w-full max-w-[1200px] px-5 py-14 sm:px-6 lg:py-20">
        <SectionHead
          id="plans-title"
          eyebrow={t("home.plans.eyebrow")}
          title={t("home.plans.title")}
          body={t("home.plans.body")}
        />
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {tiers.map((tier) => {
            const name =
              locale === "ar" ? tier.names.ar : locale === "es" ? tier.names.es : tier.names.en;
            const free = tier.price.monthlyUsd === 0;
            return (
              <article
                key={tier.key}
                className={`flex flex-col rounded-md border p-6 ${
                  tier.featured
                    ? "border-mk-forest bg-mk-forest text-mk-forest-ink"
                    : "border-line bg-card text-ink"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-lg font-medium">{name}</h3>
                  {tier.badgeKey ? (
                    <span className="rounded-full bg-mk-lime px-2.5 py-1 text-[0.6rem] font-semibold text-mk-forest">
                      {t(tier.badgeKey)}
                    </span>
                  ) : null}
                </div>
                <p
                  className={`mt-1 text-xs leading-relaxed ${
                    tier.featured ? "text-mk-forest-dim" : "text-ink-secondary"
                  }`}
                >
                  {t(tier.tagKey)}
                </p>
                <p className="mt-5 flex items-baseline gap-2">
                  <strong className="mk-tight text-[2.4rem] font-medium leading-none tracking-[-0.04em] tabular-nums">
                    ${tier.price.monthlyUsd}
                  </strong>
                  <span
                    className={`text-xs ${tier.featured ? "text-mk-forest-dim" : "text-ink-secondary"}`}
                  >
                    {t(free ? "home.pricing.suffix_free" : "home.pricing.suffix_monthly")}
                  </span>
                </p>
                {!free ? (
                  <p
                    className={`mt-1 text-[0.7rem] ${tier.featured ? "text-mk-forest-dim" : "text-ink-muted"}`}
                  >
                    {t("home.plans.or_annual", {
                      amount: `$${tier.price.annualPerMonthUsd}`,
                      billed: `$${tier.price.annualBilledUsd}`,
                    })}
                  </p>
                ) : null}
                <p
                  className={`mt-4 text-xs font-medium ${tier.featured ? "text-white" : "text-ink"}`}
                >
                  {t(tier.usersKey)}
                </p>
                <ul className="mt-3 grid gap-2 text-xs">
                  {tier.outcomeKeys.map((k) => (
                    <li key={k} className="flex items-start gap-2">
                      <Icon
                        name="check"
                        size={12}
                        aria-hidden
                        className={`mt-0.5 shrink-0 ${tier.featured ? "text-mk-lime" : "text-brand"}`}
                      />
                      <span className={tier.featured ? "text-mk-forest-ink" : "text-ink-secondary"}>
                        {t(k, { languages, languages_or: languagesOr })}
                      </span>
                    </li>
                  ))}
                </ul>
                <Link
                  href={cta.href}
                  className={`mk-lift mt-6 inline-flex min-h-11 items-center justify-center rounded-sm px-4 text-xs font-semibold ${
                    tier.featured
                      ? "bg-mk-lime text-mk-forest hover:bg-mk-lime-strong"
                      : "border border-line-strong text-ink hover:bg-brand-soft"
                  }`}
                >
                  {cta.label}
                </Link>
                <p
                  className={`mt-2 text-center text-[0.65rem] ${tier.featured ? "text-mk-forest-dim" : "text-ink-muted"}`}
                >
                  {t(tier.microKey)}
                </p>
              </article>
            );
          })}
        </div>
        <div className="mt-6 rounded-md border border-line bg-mk-strip px-4 py-3">
          <Eyebrow>{t("home.pricing.spine_label")}</Eyebrow>
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-ink">
            {(["s1", "s2", "s3", "s4"] as const).map((k) => (
              <li key={k} className="flex items-center gap-1.5">
                <Icon name="check" size={12} aria-hidden className="shrink-0 text-brand" />
                {t(`home.pricing.${k}`, { languages })}
              </li>
            ))}
          </ul>
        </div>
        <p className="mt-4 text-center text-xs text-ink-secondary">{t("home.pricing.early")}</p>
      </div>
    </section>
  );
}
