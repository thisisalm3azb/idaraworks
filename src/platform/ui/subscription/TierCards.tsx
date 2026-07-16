"use client";
/**
 * <TierCards> — the four-path subscription comparison (U3, redesigned V2): Free /
 * Medium / High / Custom as EQUAL, wide, readable cards in a balanced responsive
 * grid. All four are visible in the initial 1440×900 viewport with no page-level
 * scroll for the basic comparison (desktop 4-up; tablet 2×2; mobile stacked with
 * 44px targets). Client component — it imports the pure, client-usable t() and
 * builds a request-locale translator, so it needs no serialized labels bag and
 * embeds unchanged in the settings page and the onboarding plan step.
 *
 * Layout law: grid-cols-1 (375px) → md:grid-cols-2 (2×2) → xl:grid-cols-4 (4-up).
 * RTL-safe: logical spacing only; dir="ltr" ONLY on money/number tokens (F-44).
 *
 * Honesty: the price is prominent with a non-wrapping "/mo · excl. VAT"; the tier
 * saving is shown NEXT TO the true individual member total; High says "all
 * currently available core features" (never "everything") and lists only
 * operational members; the no-payment-now line renders whenever the provider is
 * disabled (D1). Custom is a FIRST-CLASS fourth card whose button OPENS the
 * builder (onOpenCustom) — never a long list dumped below the grid.
 */
import Link from "next/link";
import { Badge, Button, Card } from "@/platform/ui";
import { formatMoney } from "@/platform/format";
import { t as translate } from "@/platform/i18n/t";
import type { Locale } from "@/platform/registries";
import type { SelectionCurrency, SelectionTier, SelectionView } from "./types";

export type TierCardsProps = {
  view: SelectionView;
  locale: Locale;
  currency: SelectionCurrency;
  jobsNoun: string;
  current: "free" | "medium" | "high" | "custom" | null;
  /** Server action posting { bundle: <bundleKey> }; omitted = read-only compare. */
  selectTierAction?: (formData: FormData) => Promise<void>;
  /** Server action selecting the FREE path (onboarding) — Free selects in-card. */
  selectFreeAction?: (formData: FormData) => Promise<void>;
  /** Two-step inline confirm before posting a tier (settings surface). */
  confirmSelect?: boolean;
  /** Current price-version fingerprint — posted with every tier/free change so the
   * governed path's stale-price guard applies to bundle changes too (review F5). */
  priceVersion?: string;
  /** Opens the in-page Custom builder (SubscriptionSelector). Preferred over a link. */
  onOpenCustom?: () => void;
  /** Fallback when there is no in-page builder (e.g. a read-only compare): a link. */
  customHref?: string;
  canManage: boolean;
  providerEnabled: boolean;
};

function tr(locale: Locale) {
  return (key: string, vars?: Record<string, string | number>) => translate(key, vars, locale);
}

/** The prominent price block: big number + a non-wrapping "/mo", then a tax line
 * that never overlaps the number (its own row). $0 renders as "Free". */
function PriceBlock({
  minor,
  currency,
  locale,
  t,
}: {
  minor: number;
  currency: SelectionCurrency;
  locale: Locale;
  t: ReturnType<typeof tr>;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="flex items-baseline gap-1 whitespace-nowrap leading-none">
        <span dir="ltr" className="font-mono text-3xl font-bold tracking-tight text-ink">
          {minor === 0 ? t("subscription.plan.free") : formatMoney(minor, currency, { locale })}
        </span>
        {minor > 0 ? (
          <span className="text-sm font-medium text-ink-muted">/{t("subscription.per_mo")}</span>
        ) : null}
      </p>
      <p className="text-xs text-ink-muted">
        {t("subscription.excl_vat")} · {t("subscription.indicative")}
      </p>
    </div>
  );
}

const Check = () => (
  <span aria-hidden className="mt-0.5 shrink-0 text-brand">
    ✓
  </span>
);

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm leading-snug text-ink">
      <Check />
      <span>{children}</span>
    </li>
  );
}

function CardShell({
  selected,
  accent,
  children,
}: {
  selected: boolean;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card
      className={`relative flex h-full flex-col gap-3 transition-shadow hover:shadow-md focus-within:shadow-md ${
        selected ? "ring-2 ring-brand" : accent ? "ring-1 ring-brand/40" : ""
      }`}
    >
      {children}
    </Card>
  );
}

function TierCard({
  tier,
  badge,
  accent,
  locale,
  currency,
  t,
  isCurrent,
  selectTierAction,
  confirmSelect,
  priceVersion,
  canManage,
}: {
  tier: SelectionTier;
  badge: string;
  accent: boolean;
  locale: Locale;
  currency: SelectionCurrency;
  t: ReturnType<typeof tr>;
  isCurrent: boolean;
  selectTierAction?: (formData: FormData) => Promise<void>;
  confirmSelect?: boolean;
  priceVersion?: string;
  canManage: boolean;
}) {
  let extraSeats = 0;
  let extraStorage = 0;
  for (const m of tier.members) {
    extraSeats += m.limitDeltas["limit.full_users"] ?? 0;
    extraStorage += m.limitDeltas["limit.storage_gb"] ?? 0;
  }
  const audienceKey =
    tier.tier === "medium"
      ? "subscription.tier.medium_audience"
      : "subscription.tier.high_audience";
  // 4–6 concise BENEFIT bullets, not paragraphs. High names its scope honestly.
  const bulletsKey =
    tier.tier === "medium" ? "subscription.tier.medium_bullets" : "subscription.tier.high_bullets";
  const bullets = t(bulletsKey).split("|");

  return (
    <CardShell selected={isCurrent} accent={accent}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="text-lg font-bold text-ink">{tier.names[locale]}</h3>
          <Badge tone={tier.tier === "medium" ? "brand" : "info"}>{badge}</Badge>
        </div>
        {isCurrent ? <Badge tone="success">{t("subscription.current")}</Badge> : null}
      </div>

      <PriceBlock
        minor={tier.priceMonthlyMinor[currency]}
        currency={currency}
        locale={locale}
        t={t}
      />

      <p className="text-xs text-ink-muted">
        <span dir="ltr" className="font-mono line-through">
          {formatMoney(tier.memberTotalMinor[currency], currency, { locale })}
        </span>{" "}
        {t("subscription.tier.individually")}{" "}
        <Badge tone="success">
          {t("subscription.bundle.save", { percent: tier.savingPct[currency] })}
        </Badge>
      </p>

      <p className="text-sm text-ink-muted">{t(audienceKey)}</p>

      <ul className="flex flex-col gap-1.5">
        {bullets.map((b, i) => (
          <Bullet key={i}>{b}</Bullet>
        ))}
        {extraSeats > 0 ? (
          <Bullet>{t("subscription.tier.extra_seats", { count: extraSeats })}</Bullet>
        ) : null}
        {extraStorage > 0 ? (
          <Bullet>{t("subscription.tier.extra_storage", { count: extraStorage })}</Bullet>
        ) : null}
      </ul>

      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer list-none py-2 font-medium text-brand [&::-webkit-details-marker]:hidden">
          {t("subscription.tier.full_list", { count: tier.members.length })}
        </summary>
        <ul className="mt-1 flex flex-col gap-1">
          {tier.members.map((m) => (
            <li key={m.key} className="border-s-2 border-line ps-2 text-ink-muted">
              {m.names[locale]}
            </li>
          ))}
        </ul>
      </details>

      <p className="text-xs text-ink-muted">{t("subscription.tier.change_one_liner")}</p>

      <div className="mt-auto pt-1">
        {canManage && selectTierAction && !isCurrent ? (
          confirmSelect ? (
            <details>
              <summary className="inline-flex min-h-11 w-full cursor-pointer list-none items-center justify-center gap-2 rounded-md bg-brand px-4 text-sm font-semibold text-ink-inverse transition-colors hover:bg-brand-strong [&::-webkit-details-marker]:hidden">
                {t("subscription.tier.select", { tier: tier.names[locale] })}
              </summary>
              <div className="mt-2 flex flex-col items-start gap-2 rounded-md border border-line bg-sunken p-3">
                <p className="text-sm text-ink">{t("subscription.confirm.body")}</p>
                <form action={selectTierAction} className="w-full">
                  <input type="hidden" name="bundle" value={tier.bundleKey} />
                  {priceVersion ? (
                    <input type="hidden" name="priceVersion" value={priceVersion} />
                  ) : null}
                  <Button type="submit" variant={tier.tier === "medium" ? "primary" : "secondary"}>
                    {t("subscription.confirm.review")}
                  </Button>
                </form>
              </div>
            </details>
          ) : (
            <form action={selectTierAction}>
              <input type="hidden" name="bundle" value={tier.bundleKey} />
              {priceVersion ? (
                <input type="hidden" name="priceVersion" value={priceVersion} />
              ) : null}
              <Button
                type="submit"
                variant={tier.tier === "medium" ? "primary" : "secondary"}
                className="w-full"
              >
                {t("subscription.tier.select", { tier: tier.names[locale] })}
              </Button>
            </form>
          )
        ) : isCurrent ? (
          <p className="text-center text-xs font-medium text-success">
            {t("subscription.tier.your_plan")}
          </p>
        ) : null}
      </div>
    </CardShell>
  );
}

export function TierCards({
  view,
  locale,
  currency,
  jobsNoun,
  current,
  selectTierAction,
  selectFreeAction,
  confirmSelect,
  priceVersion,
  onOpenCustom,
  customHref,
  canManage,
  providerEnabled,
}: TierCardsProps) {
  const t = tr(locale);
  const { free } = view;

  return (
    <section className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4" data-testid="tier-grid">
        {/* Free — the permanent base, never a trap. */}
        <CardShell selected={current === "free"}>
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-lg font-bold text-ink">{t("subscription.plan.free")}</h3>
            {current === "free" ? <Badge tone="success">{t("subscription.current")}</Badge> : null}
          </div>
          <PriceBlock minor={0} currency={currency} locale={locale} t={t} />
          <p className="text-sm text-ink-muted">{t("subscription.tier.free_audience")}</p>
          <ul className="flex flex-col gap-1.5">
            <Bullet>{t("subscription.tier.free_seats", { count: free.limits.officeSeats })}</Bullet>
            <Bullet>
              {t("subscription.tier.free_viewers", { count: free.limits.viewerSeats })}
            </Bullet>
            <Bullet>{t("subscription.tier.field_seats_free")}</Bullet>
            <Bullet>
              {t("subscription.tier.free_jobs", { count: free.limits.activeJobs, jobs: jobsNoun })}
            </Bullet>
            <Bullet>{t("subscription.tier.free_storage", { count: free.limits.storageGb })}</Bullet>
          </ul>
          <p className="text-xs text-ink-muted">{t("subscription.tier.free_note")}</p>
          <div className="mt-auto pt-1">
            {canManage && selectFreeAction && current !== "free" ? (
              confirmSelect ? (
                <details>
                  <summary className="inline-flex min-h-11 w-full cursor-pointer list-none items-center justify-center gap-2 rounded-md border border-line-strong bg-card px-4 text-sm font-semibold text-ink transition-colors hover:bg-sunken [&::-webkit-details-marker]:hidden">
                    {t("subscription.tier.select", { tier: t("subscription.plan.free") })}
                  </summary>
                  <div className="mt-2 flex flex-col items-start gap-2 rounded-md border border-warning bg-warning-soft p-3">
                    <p className="text-sm text-ink">{t("subscription.confirm.go_free")}</p>
                    <form action={selectFreeAction} className="w-full">
                      {priceVersion ? (
                        <input type="hidden" name="priceVersion" value={priceVersion} />
                      ) : null}
                      <Button type="submit" variant="secondary">
                        {t("subscription.confirm.review")}
                      </Button>
                    </form>
                  </div>
                </details>
              ) : (
                <form action={selectFreeAction}>
                  {priceVersion ? (
                    <input type="hidden" name="priceVersion" value={priceVersion} />
                  ) : null}
                  <Button type="submit" variant="secondary" className="w-full">
                    {t("subscription.tier.select", { tier: t("subscription.plan.free") })}
                  </Button>
                </form>
              )
            ) : current === "free" ? (
              <p className="text-center text-xs font-medium text-success">
                {t("subscription.tier.your_plan")}
              </p>
            ) : null}
          </div>
        </CardShell>

        <TierCard
          tier={view.medium}
          badge={t("subscription.tier.recommended")}
          accent
          locale={locale}
          currency={currency}
          t={t}
          isCurrent={current === "medium"}
          selectTierAction={selectTierAction}
          confirmSelect={confirmSelect}
          priceVersion={priceVersion}
          canManage={canManage}
        />
        <TierCard
          tier={view.high}
          badge={t("subscription.tier.most_complete")}
          accent={false}
          locale={locale}
          currency={currency}
          t={t}
          isCurrent={current === "high"}
          selectTierAction={selectTierAction}
          confirmSelect={confirmSelect}
          priceVersion={priceVersion}
          canManage={canManage}
        />

        {/* Custom — a FIRST-CLASS fourth card whose button OPENS the builder. */}
        <CardShell selected={current === "custom"}>
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-lg font-bold text-ink">{t("subscription.tier.custom")}</h3>
            {current === "custom" ? (
              <Badge tone="success">{t("subscription.current")}</Badge>
            ) : null}
          </div>
          <div className="flex flex-col gap-0.5">
            <p className="text-3xl font-bold tracking-tight text-ink">
              {t("subscription.tier.custom_price")}
            </p>
            <p className="text-xs text-ink-muted">
              {t("subscription.excl_vat")} · {t("subscription.indicative")}
            </p>
          </div>
          <p className="text-sm text-ink-muted">{t("subscription.tier.custom_audience")}</p>
          <ul className="flex flex-col gap-1.5">
            <Bullet>{t("subscription.tier.custom_b1")}</Bullet>
            <Bullet>{t("subscription.tier.custom_b2")}</Bullet>
            <Bullet>{t("subscription.tier.custom_b3")}</Bullet>
            <Bullet>{t("subscription.tier.custom_b4")}</Bullet>
          </ul>
          <p className="text-xs text-ink-muted">{t("subscription.tier.custom_note")}</p>
          <div className="mt-auto pt-1">
            {onOpenCustom ? (
              <Button type="button" variant="secondary" className="w-full" onClick={onOpenCustom}>
                {t("subscription.tier.custom_cta")}
              </Button>
            ) : customHref ? (
              <Link
                href={customHref}
                className="inline-flex min-h-11 w-full items-center justify-center rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink hover:bg-sunken"
              >
                {t("subscription.tier.custom_cta")}
              </Link>
            ) : null}
          </div>
        </CardShell>
      </div>

      <div className="flex flex-col gap-1 text-xs text-ink-muted">
        <p>{t("subscription.tier.change_note")}</p>
        {!providerEnabled ? (
          <p className="font-medium">{t("subscription.tier.no_payment_now")}</p>
        ) : null}
      </div>
    </section>
  );
}
