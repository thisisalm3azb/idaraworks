import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { readSubscription } from "@/modules/subscription/service";
import { listImpersonations } from "@/modules/support/service";
import { formatMoney } from "@/platform/format";
import { changePlanAction, cancelSubscriptionAction } from "./actions";

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
const PLAN_ORDER = ["starter", "growth", "business"] as const;
// Whitelisted notices + their tone — 'error' MUST render in the danger tone, never the green
// success banner (review): a failed cancel/plan-change must not look like it succeeded.
const NOTICE_TONE: Record<string, "success" | "danger"> = {
  upgrade: "success",
  downgrade: "success",
  cancel_requested: "success",
  error: "danger",
};

export default async function SubscriptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  const t = await getT();
  const { orgId } = await params;
  const { notice } = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "billing.view")) redirect(`/o/${orgId}`);

  const view = await readSubscription(resolved.ctx, resolved.archetype);
  const active = await listImpersonations(resolved.ctx, resolved.archetype, true);
  const canManage = can(resolved.archetype, "billing.manage");
  const changeWithOrg = changePlanAction.bind(null, orgId);
  const cancelWithOrg = cancelSubscriptionAction.bind(null, orgId);

  // A month price per plan in the org's… we show the base currency the price book carries; pick AED
  // then USD as the display currency (placeholder book). Real per-currency price IDs land at D1.
  const displayCurrency = view.prices.some((p) => p.currency === "AED") ? "AED" : "USD";
  const monthly = (plan: string) =>
    view.prices.find(
      (p) => p.planKey === plan && p.interval === "month" && p.currency === displayCurrency,
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
          {view.trialEnd ? (
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">{t("subscription.trial_ends")}</span>
              <span dir="ltr" className="font-mono text-xs">
                {view.trialEnd.slice(0, 10)}
              </span>
            </div>
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

      {/* Provider-disabled (pre-D1) state: no live checkout / Buy action. */}
      {!view.providerEnabled ? (
        <div className="rounded-md bg-sunken p-3 text-sm text-ink-muted" role="note">
          {t("subscription.activation_unavailable")}
        </div>
      ) : null}

      <Card>
        <CardHeader title={t("subscription.plans_title")} />
        <p className="mb-3 text-xs text-ink-muted">{t("subscription.indicative_pricing")}</p>
        <ul className="flex flex-col gap-2">
          {PLAN_ORDER.map((plan) => {
            const price = monthly(plan);
            const isCurrent = plan === view.planKey;
            return (
              <li
                key={plan}
                className="flex items-center justify-between gap-3 rounded-md border border-line p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">
                    {t(`subscription.plan.${plan}`)}{" "}
                    {isCurrent ? <Badge tone="brand">{t("subscription.current")}</Badge> : null}
                  </p>
                  {price ? (
                    <p className="text-xs text-ink-muted">
                      <span dir="ltr" className="font-mono">
                        {formatMoney(price.unitAmountMinor, displayCurrency)}
                      </span>{" "}
                      / {t("subscription.per_month")}
                      {price.isPlaceholder ? ` · ${t("subscription.indicative")}` : ""}
                    </p>
                  ) : null}
                </div>
                {canManage && view.providerEnabled && !isCurrent ? (
                  <form action={changeWithOrg}>
                    <input type="hidden" name="plan" value={plan} />
                    <Button type="submit" variant="secondary">
                      {t("subscription.change_to")}
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
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
