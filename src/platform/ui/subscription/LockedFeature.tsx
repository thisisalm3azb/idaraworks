/**
 * <LockedFeature> — the honest locked-capability screen (U3): when a gated
 * page's capability is OFF for the org, render WHAT the feature does, WHICH
 * add-on / tier unlocks it and at what price, and WHERE to turn it on — never
 * a generic permission error, and never an implication that payment can
 * complete while the provider is disabled (D1).
 *
 * `lockedFeatureGate` is the one-line page wiring:
 *
 *   const locked = await lockedFeatureGate(resolved.ctx, resolved.archetype, orgId, "cap.quoting");
 *   if (locked) return locked;
 *
 * Gates govern ADD/mutate ENTRY pages only — reads/exports are never blocked
 * (freeze FR-9); the service-level requireCapability call remains the actual
 * enforcement wall (this is UX, not authz).
 */
import Link from "next/link";
import type { ReactElement } from "react";
import { Badge, Card, CardHeader } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { formatMoney } from "@/platform/format";
import { can } from "@/platform/authz";
import { getBillingProvider } from "@/platform/billing/adapter";
import type { RoleArchetype } from "@/platform/registries";
import type { Ctx } from "@/platform/tenancy";
import { hasFeature, purchasableUnlocksFor, type FeatureKey } from "@/platform/entitlements";

export type LockedFeatureProps = {
  orgId: string;
  featureKey: FeatureKey;
  archetype: RoleArchetype;
};

export async function LockedFeature({ orgId, featureKey, archetype }: LockedFeatureProps) {
  const t = await getT();
  const locale = await getServerLocale();
  const { addons, bundles } = purchasableUnlocksFor(featureKey);

  // Nothing purchasable unlocks this key (a deferred capability reached a gate)
  // — say so honestly instead of pretending a purchase path exists.
  if (addons.length === 0) {
    return (
      <Card>
        <CardHeader title={t("locked.unavailable_title")} />
        <p className="text-sm text-ink-muted">{t("locked.unavailable")}</p>
      </Card>
    );
  }

  const primary = [...addons].sort((a, b) => a.usdMonthlyMinor - b.usdMonthlyMinor)[0]!;
  const tiers = bundles.filter((b) => b.tier !== undefined);
  const providerEnabled = getBillingProvider().enabled;
  const canViewBilling = can(archetype, "billing.view");

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader
        title={primary.names[locale]}
        meta={<Badge tone="brand">{t("locked.badge")}</Badge>}
      />
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-ink">{t("locked.explain", { name: primary.names[locale] })}</p>
        <p className="text-ink-muted">{primary.description[locale]}</p>
        <p className="text-ink">
          <span dir="ltr" className="font-mono font-medium">
            {formatMoney(primary.usdMonthlyMinor, "USD", { locale })}
          </span>{" "}
          ·{" "}
          <span dir="ltr" className="font-mono font-medium">
            {formatMoney(primary.aedMonthlyMinor, "AED", { locale })}
          </span>{" "}
          <span className="text-xs text-ink-muted">
            / {t("subscription.per_month")} · {t("subscription.excl_vat")} ·{" "}
            {t("subscription.indicative")}
          </span>
        </p>
        {tiers.length > 0 ? (
          <p className="text-ink-muted">
            {t("locked.tiers", { tiers: tiers.map((b) => b.names[locale]).join(" · ") })}
          </p>
        ) : null}
        {canViewBilling ? (
          <Link
            href={`/o/${orgId}/settings/subscription`}
            className="mt-1 inline-flex min-h-11 w-fit items-center rounded-md bg-brand px-4 text-sm font-medium text-ink-inverse hover:bg-brand-strong"
          >
            {t("locked.cta")}
          </Link>
        ) : (
          <p className="text-ink-muted">{t("locked.ask_admin")}</p>
        )}
        {!providerEnabled ? (
          <p className="text-xs text-ink-muted">{t("subscription.tier.no_payment_now")}</p>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * One-line page gate: null when the capability is ON; the rendered
 * <LockedFeature> screen when it is OFF. Keeps every wired page's diff minimal
 * and the locked UX uniform.
 */
export async function lockedFeatureGate(
  ctx: Ctx,
  archetype: RoleArchetype,
  orgId: string,
  featureKey: FeatureKey,
): Promise<ReactElement | null> {
  if (await hasFeature(ctx, featureKey)) return null;
  return <LockedFeature orgId={orgId} featureKey={featureKey} archetype={archetype} />;
}
