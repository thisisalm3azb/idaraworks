import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { TierCards } from "@/platform/ui/subscription";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import {
  readSubscription,
  buildSelectionView,
  computeMonthlyTotalMinor,
  currentSelectionLabel,
} from "@/modules/subscription/service";
import { listImpersonations } from "@/modules/support/service";
import { formatMoney, formatNumber } from "@/platform/format";
import { sql, withCtx } from "@/platform/tenancy";
import {
  ADDONS,
  BUNDLES,
  getAddon,
  getTierBundle,
  isPurchasable,
  bundleIsPurchasable,
  bundleMemberTotalMinor,
  resolveEntitlements,
  type AddonDef,
  type BundleDef,
} from "@/platform/entitlements";
import { getStorageUsage } from "@/platform/files";
import { loadOrgTerminology, term } from "@/platform/terminology";
import {
  addAddonAction,
  removeAddonAction,
  selectBundleAction,
  removeBundleAction,
  cancelSubscriptionAction,
} from "./actions";

const STATE_TONE: Record<string, "success" | "brand" | "warning" | "danger" | "neutral"> = {
  active: "success",
  trialing: "brand",
  internal_pilot: "neutral",
  past_due: "warning",
  grace: "warning",
  suspended: "danger",
  cancelled: "danger",
  purge_pending: "danger",
  purged: "danger",
};
// Whitelisted notices + their tone — 'error' MUST render in the danger tone, never the green
// success banner (review): a failed add-on/bundle change must not look like it succeeded.
const NOTICE_TONE: Record<string, "success" | "danger"> = {
  cancel_requested: "success",
  addon_added: "success",
  addon_removed: "success",
  bundle_selected: "success",
  bundle_removed: "success",
  error: "danger",
};

// Display groups for the individual add-on catalogue. Availability decides the
// honesty groups (gated/later); the rest follow the catalogue's sort bands.
type GroupKey =
  "seats" | "money" | "purchasing" | "costing" | "data" | "support" | "gated" | "later";
const GROUP_ORDER: GroupKey[] = [
  "seats",
  "money",
  "purchasing",
  "costing",
  "data",
  "support",
  "gated",
  "later",
];
function groupOf(a: AddonDef): GroupKey {
  if (a.availability === "deferred") return "later";
  if (a.availability === "credential_gated" || a.availability === "d1_gated") return "gated";
  if (a.sort <= 30) return "seats";
  if (a.sort <= 60) return "money";
  if (a.sort <= 110) return "purchasing";
  if (a.sort <= 160) return "costing";
  if (a.sort <= 210) return "data";
  return "support";
}

type OrgAddonRow = {
  addon_key: string;
  quantity: number;
  status: "active" | "removal_scheduled";
  source: string;
};

const GIB = 1024 ** 3;

export default async function SubscriptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  const t = await getT();
  const locale = await getServerLocale();
  const { orgId } = await params;
  const { notice } = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "billing.view")) redirect(`/o/${orgId}`);

  const view = await readSubscription(resolved.ctx, resolved.archetype);
  const active = await listImpersonations(resolved.ctx, resolved.archetype, true);
  const ent = await resolveEntitlements(resolved.ctx);
  const storage = await getStorageUsage(resolved.ctx);
  // Domain nouns arrive as ICU variables (doc 07 #1 — never baked into a catalog string).
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const jobsNoun = term("job", terms, "plural");
  const canManage = can(resolved.archetype, "billing.manage");
  const addWithOrg = addAddonAction.bind(null, orgId);
  const removeWithOrg = removeAddonAction.bind(null, orgId);
  const selectWithOrg = selectBundleAction.bind(null, orgId);
  const removeBundleWithOrg = removeBundleAction.bind(null, orgId);
  const cancelWithOrg = cancelSubscriptionAction.bind(null, orgId);

  // Active add-ons (tenant SELECT — org_addon is tenant-read-only) + the cheap
  // usage counts for the seats card, in one tenant transaction. Seat classes
  // mirror identity.ts (office archetypes; field/foreman seats are never limited).
  const { addonRows, officeSeats, viewerSeats, activeJobs } = await withCtx(
    resolved.ctx,
    async (tx) => {
      const addons = (await tx.execute(sql`
        select addon_key, quantity, status, source from public.org_addon
        where org_id = ${resolved.ctx.orgId} and status in ('active','removal_scheduled')
        order by addon_key`)) as unknown as OrgAddonRow[];
      const seats = (await tx.execute(sql`
        select
          count(*) filter (where r.archetype in ('owner','admin','manager','procurement','accounts'))::int as office,
          count(*) filter (where r.archetype = 'viewer')::int as viewer
        from public.membership m
        join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
        where m.org_id = ${resolved.ctx.orgId} and m.deactivated_at is null`)) as unknown as Array<{
        office: number;
        viewer: number;
      }>;
      const jobs = (await tx.execute(sql`
        select count(*)::int as n from public.job
        where org_id = ${resolved.ctx.orgId} and archived = false
          and status_category in ('draft', 'active', 'on_hold')`)) as unknown as Array<{
        n: number;
      }>;
      return {
        addonRows: addons,
        officeSeats: Number(seats[0]?.office ?? 0),
        viewerSeats: Number(seats[0]?.viewer ?? 0),
        activeJobs: Number(jobs[0]?.n ?? 0),
      };
    },
  );

  // Display currency: AED when the price book carries it, else USD (the code
  // catalogue carries exactly these two; real per-currency price IDs land at D1).
  const displayCurrency: "AED" | "USD" = view.prices.some((p) => p.currency === "AED")
    ? "AED"
    : "USD";
  const addonMonthly = (a: AddonDef) =>
    displayCurrency === "AED" ? a.aedMonthlyMinor : a.usdMonthlyMinor;
  const bundleMonthly = (b: BundleDef) =>
    displayCurrency === "AED" ? b.aedMonthlyMinor : b.usdMonthlyMinor;

  // Current monthly total: bundle-sourced rows charge the BUNDLE price once
  // (that is what the org pays — never the undiscounted member sum); individual
  // rows charge the add-on price × quantity. Labelled tax-exclusive + indicative.
  // (Shared with the selection tests — modules/subscription/selection.ts.)
  const monthlyTotalMinor = computeMonthlyTotalMinor(addonRows, displayCurrency);

  // U3 four-path selection: the comparison cards + the display-only mapping of
  // the org's current state onto a path (never converts an existing org).
  const selection = buildSelectionView();
  const tierLabel = currentSelectionLabel(addonRows);
  const currentPath =
    tierLabel ?? (view.planKey === "free" && view.billingState !== "trialing" ? "free" : null);

  const addonState = new Map(addonRows.map((r) => [r.addon_key, r]));
  const bundleActive = (b: BundleDef) => addonRows.some((r) => r.source === b.key);
  // Removable while ≥1 member row is still 'active' (all-scheduled = nothing left to remove;
  // the bundle price stays counted once until the rows flip to 'removed' at period end).
  const bundleRemovable = (b: BundleDef) =>
    addonRows.some((r) => r.source === b.key && r.status === "active");

  const grouped = new Map<GroupKey, AddonDef[]>();
  for (const a of [...ADDONS].sort((x, y) => x.sort - y.sort)) {
    const g = groupOf(a);
    grouped.set(g, [...(grouped.get(g) ?? []), a]);
  }

  // Bidi-safe usage figure (review): dir="ltr" isolates ONLY the numeric tokens — the old wrapper
  // forced the whole localized "{used} من {limit}" phrase LTR, garbling the Arabic word order.
  // The translated connective renders in the page direction; numbers keep font-mono.
  const usageFigure = (used: number | string, limit: number | string | null) => (
    <span>
      <span dir="ltr" className="font-mono">
        {used}
      </span>{" "}
      {t("subscription.usage.of")}{" "}
      {limit === null ? (
        t("subscription.usage.unlimited")
      ) : (
        <span dir="ltr" className="font-mono">
          {limit}
        </span>
      )}
    </span>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Persistent support-impersonation banner (a session is open on this org). */}
      {active.length > 0 ? (
        <div className="rounded-md bg-warning-soft p-3 text-sm text-warning" role="status">
          {t("subscription.impersonation_active")}
        </div>
      ) : null}

      {notice && NOTICE_TONE[notice] ? (
        <p
          role={NOTICE_TONE[notice] === "danger" ? "alert" : "status"}
          className={`rounded-md p-3 text-sm ${
            NOTICE_TONE[notice] === "danger"
              ? "bg-danger-soft text-danger"
              : "bg-success-soft text-success"
          }`}
        >
          {t(`subscription.notice.${notice}`)}
        </p>
      ) : null}

      {/* 1 — current state: plan, billing state, trial note, monthly total. */}
      <Card>
        <CardHeader
          title={t("subscription.title")}
          meta={
            <Badge tone={STATE_TONE[view.billingState] ?? "neutral"}>
              {t(`subscription.state.${view.billingState}`)}
            </Badge>
          }
        />
        <div className="flex flex-col gap-1 text-sm text-ink">
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">{t("subscription.current_plan")}</span>
            <span className="font-medium">{t(`subscription.plan.${view.planKey}`)}</span>
          </div>
          {/* U3 compact current-state strip: display mapping only — which path
              describes the org's live add-ons (never a conversion). */}
          {tierLabel ? (
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">{t("subscription.strip.selection")}</span>
              <span className="font-medium">
                {tierLabel === "custom"
                  ? t("subscription.tier.custom")
                  : (getTierBundle(tierLabel)?.names[locale] ?? tierLabel)}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">{t("subscription.strip.addons")}</span>
            <span dir="ltr" className="font-mono">
              {addonRows.length}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">{t("subscription.usage.office_seats")}</span>
            {usageFigure(officeSeats, ent.limits["limit.full_users"] ?? null)}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">{t("subscription.usage.storage")}</span>
            {usageFigure(
              `${formatNumber(storage.bytesUsed / GIB, locale, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })} GB`,
              storage.limitBytes === null
                ? null
                : `${formatNumber(storage.limitBytes / GIB, locale, { maximumFractionDigits: 0 })} GB`,
            )}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">{t("subscription.monthly_total")}</span>
            <span dir="ltr" className="font-mono font-medium">
              {formatMoney(monthlyTotalMinor, displayCurrency)}
            </span>
          </div>
          <p className="text-xs text-ink-muted">{t("subscription.monthly_total_note")}</p>
          {view.trialEnd ? (
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">{t("subscription.trial_ends")}</span>
              <span dir="ltr" className="font-mono text-xs">
                {view.trialEnd.slice(0, 10)}
              </span>
            </div>
          ) : null}
          {view.billingState === "trialing" ? (
            <p className="text-xs text-ink-muted">{t("subscription.trial_note")}</p>
          ) : null}
          {view.scheduledPlanKey ? (
            <div className="flex items-center justify-between text-warning">
              <span>{t("subscription.downgrade_scheduled")}</span>
              <span className="font-medium">{t(`subscription.plan.${view.scheduledPlanKey}`)}</span>
            </div>
          ) : null}
          {view.cancelAtPeriodEnd ? (
            <p className="text-warning">{t("subscription.cancel_at_period_end")}</p>
          ) : null}
        </div>
      </Card>

      {/* 2 — the free base: always included, on every workspace, forever. */}
      <Card>
        <CardHeader title={t("subscription.free_base.title")} />
        <ul className="list-inside list-disc text-sm text-ink">
          <li>{t("subscription.free_base.core", { jobs: jobsNoun })}</li>
          <li>{t("subscription.free_base.records")}</li>
          <li>{t("subscription.free_base.seats")}</li>
          <li>{t("subscription.free_base.storage")}</li>
        </ul>
      </Card>

      {/* Provider-disabled (pre-D1) state: no live purchase actions of any kind. */}
      {!view.providerEnabled ? (
        <div className="rounded-md bg-sunken p-3 text-sm text-ink-muted" role="note">
          {t("subscription.activation_unavailable")}
        </div>
      ) : null}

      {/* 3 — the four paths (U3): Free / Medium / High / Custom comparison.
          Tiers select through the SAME bundle action (a tier is a governed
          bundle of the same add-on keys — never a second entitlement system). */}
      <TierCards
        view={selection}
        locale={locale}
        currency={displayCurrency}
        t={t}
        jobsNoun={jobsNoun}
        current={currentPath}
        selectTierAction={selectWithOrg}
        customHref="#custom-addons"
        canManage={canManage}
        providerEnabled={view.providerEnabled}
      />

      {/* 4 — themed bundles (discounted collections of the same add-ons); the
          tier bundles render above as comparison cards, not in this list. */}
      <Card>
        <CardHeader title={t("subscription.bundles_title")} />
        <p className="mb-3 text-xs text-ink-muted">{t("subscription.indicative_pricing")}</p>
        <ul className="flex flex-col gap-2">
          {[...BUNDLES]
            .filter((b) => b.tier === undefined)
            .sort((a, b) => a.sort - b.sort)
            .map((b) => {
              const price = bundleMonthly(b);
              const memberTotal = bundleMemberTotalMinor(b, displayCurrency);
              const savePct = memberTotal > 0 ? Math.round((1 - price / memberTotal) * 100) : 0;
              const isActive = bundleActive(b);
              return (
                <li key={b.key} className="flex flex-col gap-2 rounded-md border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-ink">
                      {b.names[locale]}{" "}
                      {isActive ? (
                        <Badge tone="success">{t("subscription.bundle.active")}</Badge>
                      ) : null}
                    </p>
                    <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
                      <span dir="ltr" className="font-mono font-medium">
                        {formatMoney(price, displayCurrency)}
                      </span>
                      <span className="text-xs text-ink-muted">
                        / {t("subscription.per_month")} · {t("subscription.excl_vat")}
                      </span>
                      {savePct > 0 ? (
                        <>
                          <span dir="ltr" className="font-mono text-xs text-ink-muted line-through">
                            {formatMoney(memberTotal, displayCurrency)}
                          </span>
                          <Badge tone="success">
                            {t("subscription.bundle.save", { percent: savePct })}
                          </Badge>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <p className="text-xs text-ink-muted">{b.description[locale]}</p>
                  <div className="flex flex-wrap gap-1">
                    {b.addonKeys.map((k) => (
                      <Badge key={k} tone="neutral">
                        {getAddon(k)?.names[locale] ?? k}
                      </Badge>
                    ))}
                  </div>
                  {canManage && view.providerEnabled ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {bundleIsPurchasable(b) ? (
                        <form action={selectWithOrg}>
                          <input type="hidden" name="bundle" value={b.key} />
                          <Button type="submit" variant="secondary">
                            {t("subscription.bundle.select")}
                          </Button>
                        </form>
                      ) : null}
                      {bundleRemovable(b) ? (
                        <form action={removeBundleWithOrg}>
                          <input type="hidden" name="bundle" value={b.key} />
                          <Button type="submit" variant="ghost" className="text-danger">
                            {t("subscription.bundle.remove")}
                          </Button>
                        </form>
                      ) : null}
                    </div>
                  ) : null}
                  {canManage && view.providerEnabled && bundleRemovable(b) ? (
                    <p className="text-xs text-ink-muted">{t("subscription.addon.remove_note")}</p>
                  ) : null}
                </li>
              );
            })}
        </ul>
      </Card>

      {/* 5 — individual add-ons (the Custom path), grouped; honesty groups last
          (gated → note, deferred → plainly not purchasable, no price). */}
      <Card id="custom-addons">
        <CardHeader title={t("subscription.addons_title")} />
        <p className="mb-3 text-xs text-ink-muted">{t("subscription.indicative_pricing")}</p>
        <div className="flex flex-col gap-4">
          {GROUP_ORDER.map((g) => {
            const items = grouped.get(g);
            if (!items || items.length === 0) return null;
            return (
              <section key={g}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                  {t(`subscription.group.${g}`)}
                </h3>
                <ul className="flex flex-col gap-2">
                  {items.map((a) => {
                    const state = addonState.get(a.key);
                    const purchasable = isPurchasable(a);
                    const deferred = a.availability === "deferred";
                    return (
                      <li
                        key={a.key}
                        className="flex flex-col gap-2 rounded-md border border-line p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium text-ink">
                            {a.names[locale]}{" "}
                            {state?.status === "active" ? (
                              <Badge tone="success">
                                {t("subscription.addon.active")}
                                {a.stackable && state.quantity > 1 ? ` ×${state.quantity}` : ""}
                              </Badge>
                            ) : null}
                            {state?.status === "removal_scheduled" ? (
                              <Badge tone="warning">
                                {t("subscription.addon.removal_scheduled")}
                              </Badge>
                            ) : null}
                          </p>
                          {!deferred ? (
                            <p className="text-sm text-ink">
                              <span dir="ltr" className="font-mono font-medium">
                                {formatMoney(addonMonthly(a), displayCurrency)}
                              </span>{" "}
                              <span className="text-xs text-ink-muted">
                                / {t("subscription.per_month")} · {t("subscription.excl_vat")}
                              </span>
                            </p>
                          ) : (
                            <Badge tone="neutral">{t("subscription.addon.coming_later")}</Badge>
                          )}
                        </div>
                        <p className="text-xs text-ink-muted">{a.description[locale]}</p>
                        {a.availabilityNote ? (
                          <p className="text-xs text-warning">{a.availabilityNote[locale]}</p>
                        ) : null}
                        {canManage && view.providerEnabled && purchasable ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <form action={addWithOrg} className="flex flex-wrap items-center gap-2">
                              <input type="hidden" name="addon" value={a.key} />
                              {a.stackable ? (
                                <label className="flex items-center gap-2 text-xs text-ink-muted">
                                  {t("subscription.addon.quantity")}
                                  <input
                                    type="number"
                                    name="quantity"
                                    min={1}
                                    defaultValue={state?.quantity ?? 1}
                                    className="min-h-11 w-20 rounded-md border border-line bg-card px-2 text-sm text-ink"
                                  />
                                </label>
                              ) : null}
                              <Button type="submit" variant="secondary">
                                {state?.status === "active" && a.stackable
                                  ? t("subscription.addon.update_quantity")
                                  : t("subscription.addon.add")}
                              </Button>
                            </form>
                            {state ? (
                              <form action={removeWithOrg}>
                                <input type="hidden" name="addon" value={a.key} />
                                <Button type="submit" variant="ghost" className="text-danger">
                                  {t("subscription.addon.remove")}
                                </Button>
                              </form>
                            ) : null}
                          </div>
                        ) : null}
                        {canManage && view.providerEnabled && purchasable && state ? (
                          <p className="text-xs text-ink-muted">
                            {t("subscription.addon.remove_note")}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </Card>

      {/* 5 — usage & seats (limits govern ADD, never read — FR-9). */}
      <Card>
        <CardHeader title={t("subscription.usage_title")} />
        <div className="flex flex-col gap-1 text-sm text-ink">
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">{t("subscription.usage.office_seats")}</span>
            {usageFigure(officeSeats, ent.limits["limit.full_users"] ?? null)}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">{t("subscription.usage.viewer_seats")}</span>
            {usageFigure(viewerSeats, ent.limits["limit.viewer_users"] ?? null)}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">{t("subscription.usage.field_seats")}</span>
            <span>{t("subscription.usage.unlimited")}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">{t("subscription.usage.storage")}</span>
            {usageFigure(
              `${formatNumber(storage.bytesUsed / GIB, locale, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })} GB`,
              storage.limitBytes === null
                ? null
                : `${formatNumber(storage.limitBytes / GIB, locale, { maximumFractionDigits: 0 })} GB`,
            )}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">
              {t("subscription.usage.active_jobs", { jobs: jobsNoun })}
            </span>
            {usageFigure(activeJobs, ent.limits["limit.active_jobs"] ?? null)}
          </div>
        </div>
      </Card>

      {canManage && view.providerEnabled && !view.cancelAtPeriodEnd ? (
        <Card>
          <CardHeader title={t("subscription.cancel_title")} />
          <p className="mb-3 text-sm text-ink-muted">{t("subscription.cancel_help")}</p>
          <form action={cancelWithOrg}>
            <Button type="submit" variant="ghost" className="text-danger">
              {t("subscription.cancel")}
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
