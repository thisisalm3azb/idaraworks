import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { SubscriptionSelector } from "@/platform/ui/subscription";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import {
  readSubscription,
  readSubscriptionAuditHistory,
  buildSelectionView,
  computeMonthlyTotalMinor,
  currentSelectionLabel,
  currentPriceVersion,
} from "@/modules/subscription/service";
import { listImpersonations } from "@/modules/support/service";
import { formatMoney, formatNumber } from "@/platform/format";
import { sql, withCtx } from "@/platform/tenancy";
import {
  BUNDLES,
  getAddon,
  getTierBundle,
  bundleIsPurchasable,
  bundleMemberTotalMinor,
  resolveEntitlements,
  type BundleDef,
} from "@/platform/entitlements";
import { getStorageUsage } from "@/platform/files";
import { loadOrgTerminology, term } from "@/platform/terminology";
import {
  selectTierAction,
  selectFreeAction,
  manageAddonsAction,
  removeBundleAction,
  selectBundleAction,
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

// Whitelisted success notices + tone. Errors render in the danger tone with the
// classified code + correlation id (PART C) — never a green "success" banner.
const SUCCESS_NOTICE_TONE: Record<string, "success"> = {
  cancel_requested: "success",
  addon_removed: "success",
  addons_changed: "success",
  bundle_selected: "success",
  bundle_removed: "success",
};

// The classified error codes the danger banner can name (PART C). Anything else
// falls back to the generic message. Kept in sync with SubscriptionErrorCode.
const ERROR_CODES = new Set([
  "authorization",
  "read_only",
  "invalid_quantity",
  "unavailable_addon",
  "credential_gated",
  "d1_gated",
  "deferred",
  "unknown_addon",
  "not_active",
  "stale_price_version",
  "concurrent_change",
  "invalid_transition",
  "provider_unavailable",
  "network_retry",
  "internal",
]);

type OrgAddonRow = {
  addon_key: string;
  quantity: number;
  status: "active" | "removal_scheduled";
  source: string;
};

const GIB = 1024 ** 3;

/** Two-step confirm (no-JS details/summary) for the themed-bundle + cancel controls. */
function ConfirmAction({
  label,
  body,
  danger,
  children,
}: {
  label: string;
  body: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <details>
      <summary
        className={`inline-flex min-h-11 cursor-pointer list-none items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors [&::-webkit-details-marker]:hidden ${
          danger
            ? "text-danger hover:bg-danger-soft"
            : "border border-line-strong bg-card text-ink hover:bg-sunken"
        }`}
      >
        {label}
      </summary>
      <div
        className={`mt-2 flex flex-col items-start gap-2 rounded-md border p-3 ${
          danger ? "border-danger bg-danger-soft" : "border-line bg-sunken"
        }`}
      >
        <p className={`text-sm ${danger ? "text-danger" : "text-ink"}`}>{body}</p>
        {children}
      </div>
    </details>
  );
}

export default async function SubscriptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ notice?: string; code?: string; cid?: string; highlight?: string }>;
}) {
  const t = await getT();
  const locale = await getServerLocale();
  const { orgId } = await params;
  const { notice, code, cid, highlight } = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "billing.view")) redirect(`/o/${orgId}`);

  const [view, active, ent, storage, terms, auditHistory] = await Promise.all([
    readSubscription(resolved.ctx, resolved.archetype),
    listImpersonations(resolved.ctx, resolved.archetype, true),
    resolveEntitlements(resolved.ctx),
    getStorageUsage(resolved.ctx),
    loadOrgTerminology(resolved.ctx, locale),
    readSubscriptionAuditHistory(resolved.ctx, resolved.archetype, 40),
  ]);
  const jobsNoun = term("job", terms, "plural");
  // Management is enabled on canManage ALONE (owner; billing.manage). The provider
  // being disabled (prod, D1) NO LONGER hides the controls — confirmed changes route
  // through the governed test/trial path (server-authorized + audited, no charge).
  const canManage = can(resolved.archetype, "billing.manage");
  const selectTierWithOrg = selectTierAction.bind(null, orgId);
  const selectFreeWithOrg = selectFreeAction.bind(null, orgId);
  const manageWithOrg = manageAddonsAction.bind(null, orgId);
  const selectBundleWithOrg = selectBundleAction.bind(null, orgId);
  const removeBundleWithOrg = removeBundleAction.bind(null, orgId);
  const cancelWithOrg = cancelSubscriptionAction.bind(null, orgId);

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

  const displayCurrency: "AED" | "USD" = view.prices.some((p) => p.currency === "AED")
    ? "AED"
    : "USD";
  const bundleMonthly = (b: BundleDef) =>
    displayCurrency === "AED" ? b.aedMonthlyMinor : b.usdMonthlyMinor;
  const monthlyTotalMinor = computeMonthlyTotalMinor(addonRows, displayCurrency);

  const selection = buildSelectionView();
  const tierLabel = currentSelectionLabel(addonRows);
  const currentPath =
    tierLabel ?? (view.planKey === "free" && view.billingState !== "trialing" ? "free" : null);

  // Active-add-on split: bundle-derived vs individually-selected (labelled).
  const individualAddons = addonRows.filter((r) => r.source === "individual");
  const bundleAddons = addonRows.filter((r) => r.source !== "individual");
  const initialCustomQuantities = Object.fromEntries(
    individualAddons
      .filter((r) => r.status === "active")
      .map((r) => [r.addon_key, Number(r.quantity)]),
  );
  const bundleIncludedKeys = bundleAddons.map((r) => r.addon_key);
  const scheduledAddons = addonRows.filter((r) => r.status === "removal_scheduled");

  // LockedFeature deep link: ?highlight=addon.<key> opens the builder focused on it.
  const highlightKey = highlight && getAddon(highlight) ? highlight : undefined;

  const bundleActive = (b: BundleDef) => addonRows.some((r) => r.source === b.key);
  const bundleRemovable = (b: BundleDef) =>
    addonRows.some((r) => r.source === b.key && r.status === "active");

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

  const isError = notice === "error";
  const errorCode = code && ERROR_CODES.has(code) ? code : "internal";

  return (
    <div className="flex flex-col gap-4">
      {active.length > 0 ? (
        <div className="rounded-md bg-warning-soft p-3 text-sm text-warning" role="status">
          {t("subscription.impersonation_active")}
        </div>
      ) : null}

      {isError ? (
        <div role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">
          <p className="font-medium">{t(`subscription.error.${errorCode}`)}</p>
          {cid ? (
            <p className="mt-1 text-xs text-danger/80">
              {t("subscription.error.reference")}{" "}
              <span dir="ltr" className="font-mono">
                {cid}
              </span>
            </p>
          ) : null}
        </div>
      ) : notice && SUCCESS_NOTICE_TONE[notice] ? (
        <p role="status" className="rounded-md bg-success-soft p-3 text-sm text-success">
          {t(`subscription.notice.${notice}`)}
        </p>
      ) : null}

      {/* 1 — current state. */}
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
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">{t("subscription.strip.selection")}</span>
            <span className="font-medium">
              {tierLabel === "custom"
                ? t("subscription.tier.custom")
                : tierLabel
                  ? (getTierBundle(tierLabel)?.names[locale] ?? tierLabel)
                  : t("subscription.plan.free")}
            </span>
          </div>
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

      {/* Governed test/trial honesty notice — the page IS manageable, but no money moves. */}
      {!view.providerEnabled ? (
        <div className="rounded-md bg-sunken p-3 text-sm text-ink" role="note">
          {t("subscription.governed_test_notice")}
        </div>
      ) : null}

      {/* 2 — active add-ons: bundle-derived vs individually-selected (labelled). */}
      {addonRows.length > 0 ? (
        <Card>
          <CardHeader title={t("subscription.active_addons_title")} />
          <ul className="flex flex-col gap-1.5 text-sm">
            {addonRows.map((r) => (
              <li key={r.addon_key} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-ink">
                  {getAddon(r.addon_key)?.names[locale] ?? r.addon_key}
                </span>
                <span className="flex items-center gap-2">
                  {r.source === "individual" ? (
                    <Badge tone="neutral">{t("subscription.source.individual")}</Badge>
                  ) : (
                    <Badge tone="info">
                      {t("subscription.source.bundle", {
                        bundle:
                          getTierBundle("medium")?.key === r.source
                            ? getTierBundle("medium")!.names[locale]
                            : getTierBundle("high")?.key === r.source
                              ? getTierBundle("high")!.names[locale]
                              : (BUNDLES.find((b) => b.key === r.source)?.names[locale] ??
                                r.source),
                      })}
                    </Badge>
                  )}
                  {r.status === "removal_scheduled" ? (
                    <Badge tone="warning">{t("subscription.addon.removal_scheduled")}</Badge>
                  ) : getAddon(r.addon_key)?.stackable && Number(r.quantity) > 1 ? (
                    <span dir="ltr" className="font-mono text-xs text-ink-muted">
                      ×{r.quantity}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {scheduledAddons.length > 0 ? (
            <p className="mt-2 text-xs text-warning">{t("subscription.scheduled_note")}</p>
          ) : null}
        </Card>
      ) : null}

      {/* 3 — the four-path selector: Change plan (tiers) + Manage add-ons (Custom builder).
          Enabled on canManage ALONE. Custom OPENS the builder in-page (deep links open it
          focused). The builder shows a change-review before submit. */}
      <Card>
        <CardHeader title={t("subscription.manage_title")} />
        <p className="mb-3 text-sm text-ink-muted">{t("subscription.manage_help")}</p>
        <SubscriptionSelector
          view={selection}
          locale={locale}
          currency={displayCurrency}
          jobsNoun={jobsNoun}
          current={currentPath}
          canManage={canManage}
          providerEnabled={view.providerEnabled}
          selectTierAction={canManage ? selectTierWithOrg : undefined}
          selectFreeAction={canManage ? selectFreeWithOrg : undefined}
          customAction={canManage ? manageWithOrg : undefined}
          confirmSelect
          reviewBeforeSubmit
          initialCustomQuantities={initialCustomQuantities}
          bundleIncludedKeys={bundleIncludedKeys}
          hiddenFields={{ priceVersion: currentPriceVersion() }}
          initialPanel={highlightKey ? "custom" : "compare"}
          highlightKey={highlightKey}
        />
      </Card>

      {/* 4 — themed bundles (discounted collections; bundle↔custom switching). */}
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
                        <Badge tone="success">
                          {t("subscription.bundle.save", { percent: savePct })}
                        </Badge>
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
                  {canManage ? (
                    <div className="flex flex-wrap items-start gap-2">
                      {bundleIsPurchasable(b) && !isActive ? (
                        <ConfirmAction
                          label={t("subscription.bundle.select")}
                          body={t("subscription.confirm.body")}
                        >
                          <form action={selectBundleWithOrg}>
                            <input type="hidden" name="bundle" value={b.key} />
                            <Button type="submit" variant="secondary">
                              {t("subscription.confirm.apply")}
                            </Button>
                          </form>
                        </ConfirmAction>
                      ) : null}
                      {bundleRemovable(b) ? (
                        <ConfirmAction
                          label={t("subscription.bundle.remove")}
                          body={t("subscription.addon.remove_note")}
                          danger
                        >
                          <form action={removeBundleWithOrg}>
                            <input type="hidden" name="bundle" value={b.key} />
                            <Button type="submit" variant="danger">
                              {t("subscription.confirm.apply")}
                            </Button>
                          </form>
                        </ConfirmAction>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
        </ul>
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

      {/* 6 — cancellation (governed; canManage ALONE). */}
      {canManage && !view.cancelAtPeriodEnd && view.billingState !== "cancelled" ? (
        <Card>
          <CardHeader title={t("subscription.cancel_title")} />
          <p className="mb-3 text-sm text-ink-muted">{t("subscription.cancel_help")}</p>
          <ConfirmAction
            label={t("subscription.cancel")}
            body={t("subscription.confirm.cancel_body")}
            danger
          >
            <form action={cancelWithOrg}>
              <Button type="submit" variant="danger">
                {t("subscription.confirm.cancel_apply")}
              </Button>
            </form>
          </ConfirmAction>
        </Card>
      ) : null}

      {/* 7 — tenant-visible audit history (this org only; the platform stream stays separate). */}
      <Card>
        <CardHeader title={t("subscription.audit_title")} />
        {auditHistory.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("subscription.audit_empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {auditHistory.map((e) => (
              <li key={e.id} className="flex flex-col gap-1 py-2 first:pt-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-ink">{e.summary}</span>
                  <Badge tone={e.status === "scheduled" ? "warning" : "neutral"}>
                    {t(`subscription.audit.status.${e.status}`)}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                  <Badge tone="neutral">{t(`subscription.audit.source.${e.source}`)}</Badge>
                  <span dir="ltr" className="font-mono">
                    {e.createdAt.slice(0, 16).replace("T", " ")}
                  </span>
                  {e.effectiveDate ? (
                    <span>
                      {t("subscription.audit.effective")}{" "}
                      <span dir="ltr" className="font-mono">
                        {e.effectiveDate.slice(0, 10)}
                      </span>
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
