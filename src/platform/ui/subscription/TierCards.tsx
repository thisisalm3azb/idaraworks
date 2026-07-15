/**
 * <TierCards> — the four-path subscription comparison (U3): Free / Medium /
 * High / Custom as large cards. Pure-presentational server component: data
 * arrives as a SelectionView (buildSelectionView), the translator and locale
 * are passed in, and tier selection posts through whatever server action the
 * host surface provides (settings today; onboarding wave-2).
 *
 * Layout law: single-column at 375px (grid-cols-1), 2-up from sm, 4-up from
 * xl. RTL-safe: logical spacing classes only; dir="ltr" ONLY on money/number
 * tokens (F-44).
 *
 * Honesty: prices are indicative + tax-exclusive (labelled); the saving is
 * shown next to the real member total; the provider-disabled statement renders
 * whenever no payment can actually be collected (D1).
 */
import Link from "next/link";
import { Badge, Button, Card } from "@/platform/ui";
import { formatMoney } from "@/platform/format";
import type { Locale } from "@/platform/registries";
import type { SelectionCurrency, SelectionTier, SelectionTranslator, SelectionView } from "./types";

export type TierCardsProps = {
  view: SelectionView;
  locale: Locale;
  currency: SelectionCurrency;
  t: SelectionTranslator;
  /** Localized plural domain noun for the free-plan jobs limit (doc 07 #1). */
  jobsNoun: string;
  /** Display mapping only — which path describes the org today (never converts). */
  current: "free" | "medium" | "high" | "custom" | null;
  /** Server action posting { bundle: <bundleKey> }; omitted = read-only compare. */
  selectTierAction?: (formData: FormData) => Promise<void>;
  /**
   * Server action selecting the FREE path (onboarding wizard) — gives the Free
   * card the same in-card select slot as the tiers, so the plan step never
   * needs a second Free card below the grid.
   */
  selectFreeAction?: (formData: FormData) => Promise<void>;
  /**
   * Two-step confirm for tier selection (settings surface): the select button
   * opens an inline details/summary confirm; the server action is unchanged.
   * The onboarding wizard omits it — its explicit review step is the confirm.
   */
  confirmSelect?: boolean;
  /** Where the Custom path leads (the add-on catalogue / builder). */
  customHref: string;
  canManage: boolean;
  providerEnabled: boolean;
};

function Price({
  minor,
  currency,
  locale,
  per,
}: {
  minor: number;
  currency: SelectionCurrency;
  locale: Locale;
  per: string;
}) {
  return (
    <p className="flex items-baseline gap-1">
      <span dir="ltr" className="font-mono text-2xl font-semibold text-ink">
        {formatMoney(minor, currency, { locale })}
      </span>
      <span className="text-xs text-ink-muted">/ {per}</span>
    </p>
  );
}

function TierCard({
  tier,
  badge,
  locale,
  currency,
  t,
  isCurrent,
  selectTierAction,
  confirmSelect,
  canManage,
  providerEnabled,
}: {
  tier: SelectionTier;
  badge: string;
  locale: Locale;
  currency: SelectionCurrency;
  t: SelectionTranslator;
  isCurrent: boolean;
  selectTierAction?: (formData: FormData) => Promise<void>;
  confirmSelect?: boolean;
  canManage: boolean;
  providerEnabled: boolean;
}) {
  // Seat/storage deltas the tier adds on top of the free base (from the SAME
  // member add-ons — packs at quantity 1 inside a bundle).
  let extraSeats = 0;
  let extraStorage = 0;
  for (const m of tier.members) {
    extraSeats += m.limitDeltas["limit.full_users"] ?? 0;
    extraStorage += m.limitDeltas["limit.storage_gb"] ?? 0;
  }
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-ink">{tier.names[locale]}</h3>
        <span className="flex items-center gap-1">
          <Badge tone={tier.tier === "medium" ? "brand" : "info"}>{badge}</Badge>
          {isCurrent ? <Badge tone="success">{t("subscription.current")}</Badge> : null}
        </span>
      </div>
      <Price
        minor={tier.priceMonthlyMinor[currency]}
        currency={currency}
        locale={locale}
        per={t("subscription.per_month")}
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
      <p className="text-xs text-ink-muted">{t("subscription.monthly_total_note")}</p>
      <p className="text-sm text-ink">{tier.description[locale]}</p>
      <ul className="flex flex-col gap-1 text-sm text-ink">
        {extraSeats > 0 ? (
          <li>{t("subscription.tier.extra_seats", { count: extraSeats })}</li>
        ) : null}
        {extraStorage > 0 ? (
          <li>{t("subscription.tier.extra_storage", { count: extraStorage })}</li>
        ) : null}
        <li>{t("subscription.tier.field_seats_free")}</li>
      </ul>
      <details>
        <summary className="min-h-11 cursor-pointer text-sm leading-[44px] text-brand">
          {t("subscription.tier.full_list", { count: tier.members.length })}
        </summary>
        <ul className="flex flex-col gap-1 text-sm text-ink">
          {tier.members.map((m) => (
            <li key={m.key} className="border-s-2 border-line ps-2">
              {m.names[locale]}
            </li>
          ))}
        </ul>
      </details>
      {canManage && providerEnabled && selectTierAction && !isCurrent ? (
        confirmSelect ? (
          // Two-step confirm (settings): no-JS details/summary; action unchanged.
          <details className="mt-auto">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center justify-center gap-2 rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink transition-colors hover:bg-sunken [&::-webkit-details-marker]:hidden">
              {t("subscription.tier.select", { tier: tier.names[locale] })}
            </summary>
            <div className="mt-2 flex flex-col items-start gap-2 rounded-md border border-line bg-sunken p-3">
              <p className="text-sm text-ink">{t("subscription.confirm.body")}</p>
              <form action={selectTierAction}>
                <input type="hidden" name="bundle" value={tier.bundleKey} />
                <Button type="submit" variant={tier.tier === "medium" ? "primary" : "secondary"}>
                  {t("subscription.confirm.apply")}
                </Button>
              </form>
            </div>
          </details>
        ) : (
          <form action={selectTierAction} className="mt-auto">
            <input type="hidden" name="bundle" value={tier.bundleKey} />
            <Button type="submit" variant={tier.tier === "medium" ? "primary" : "secondary"}>
              {t("subscription.tier.select", { tier: tier.names[locale] })}
            </Button>
          </form>
        )
      ) : null}
    </Card>
  );
}

export function TierCards({
  view,
  locale,
  currency,
  t,
  jobsNoun,
  current,
  selectTierAction,
  selectFreeAction,
  confirmSelect,
  customHref,
  canManage,
  providerEnabled,
}: TierCardsProps) {
  const { free } = view;
  return (
    <section className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {/* Free — the permanent base, never a trap. */}
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-ink">{t("subscription.plan.free")}</h3>
            {current === "free" ? <Badge tone="success">{t("subscription.current")}</Badge> : null}
          </div>
          <Price minor={0} currency={currency} locale={locale} per={t("subscription.per_month")} />
          <p className="text-sm text-ink">{t("subscription.tier.free_pitch")}</p>
          <ul className="flex flex-col gap-1 text-sm text-ink">
            <li>{t("subscription.tier.free_seats", { count: free.limits.officeSeats })}</li>
            <li>{t("subscription.tier.free_viewers", { count: free.limits.viewerSeats })}</li>
            <li>{t("subscription.tier.field_seats_free")}</li>
            <li>
              {t("subscription.tier.free_jobs", {
                count: free.limits.activeJobs,
                jobs: jobsNoun,
              })}
            </li>
            <li>{t("subscription.tier.free_storage", { count: free.limits.storageGb })}</li>
          </ul>
          <p className="mt-auto text-xs text-ink-muted">{t("subscription.tier.free_note")}</p>
          {/* The wizard's Free select lives IN the card — one Free path, one place. */}
          {canManage && selectFreeAction && current !== "free" ? (
            <form action={selectFreeAction}>
              <Button type="submit" variant="secondary">
                {t("subscription.tier.select", { tier: t("subscription.plan.free") })}
              </Button>
            </form>
          ) : null}
        </Card>

        <TierCard
          tier={view.medium}
          badge={t("subscription.tier.recommended")}
          locale={locale}
          currency={currency}
          t={t}
          isCurrent={current === "medium"}
          selectTierAction={selectTierAction}
          confirmSelect={confirmSelect}
          canManage={canManage}
          providerEnabled={providerEnabled}
        />
        <TierCard
          tier={view.high}
          badge={t("subscription.tier.most_complete")}
          locale={locale}
          currency={currency}
          t={t}
          isCurrent={current === "high"}
          selectTierAction={selectTierAction}
          confirmSelect={confirmSelect}
          canManage={canManage}
          providerEnabled={providerEnabled}
        />

        {/* Custom — build from the same add-on keys, à la carte. */}
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-ink">{t("subscription.tier.custom")}</h3>
            {current === "custom" ? (
              <Badge tone="success">{t("subscription.current")}</Badge>
            ) : null}
          </div>
          <p className="text-sm text-ink">{t("subscription.tier.custom_pitch")}</p>
          <p className="text-xs text-ink-muted">{t("subscription.tier.custom_note")}</p>
          <Link
            href={customHref}
            className="mt-auto inline-flex min-h-11 items-center justify-center rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink hover:bg-sunken"
          >
            {t("subscription.tier.custom_cta")}
          </Link>
        </Card>
      </div>

      {/* Shared honesty footnotes for all four paths. */}
      <div className="flex flex-col gap-1 text-xs text-ink-muted">
        <p>{t("subscription.tier.change_note")}</p>
        {!providerEnabled ? <p>{t("subscription.tier.no_payment_now")}</p> : null}
      </div>
    </section>
  );
}
