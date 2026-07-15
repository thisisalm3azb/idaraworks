"use server";

import { redirect } from "next/navigation";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { cancelSubscription, changeAddons } from "@/modules/subscription/service";
import { getAddon, getBundle } from "@/platform/entitlements";
import { logger } from "@/platform/logger";

const BASE = (orgId: string) => `/o/${orgId}/settings/subscription`;

// changePlanAction was removed: the rebuilt add-on-model page no longer posts a plan switch (plan
// changes ride the trial→free landing + the add-on catalogue); changePlan in the service stays —
// the s9 plan-change tests and the prod-demo script still exercise it.

export async function cancelSubscriptionAction(orgId: string): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  let ok = false;
  try {
    await cancelSubscription(resolved.ctx, resolved.archetype);
    ok = true;
  } catch (err) {
    logger.error({ orgId, err: (err as Error).message }, "cancelSubscription action failed");
    ok = false;
  }
  redirect(`${BASE(orgId)}?notice=${ok ? "cancel_requested" : "error"}`);
}

// ── Add-on model (0065): all three funnel through changeAddons, which drives the
// provider→webhook round-trip — org_addon is never written from a tenant action.
// AddonUnavailableError / BillingProviderDisabledError (and any other failure)
// map to the whitelisted notice=error danger banner, matching the actions above.

export async function addAddonAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const addonKey = String(formData.get("addon") ?? "");
  const qtyRaw = Number(formData.get("quantity") ?? 1);
  const quantity = Number.isFinite(qtyRaw) ? Math.max(1, Math.trunc(qtyRaw)) : 1;
  let ok = false;
  try {
    if (getAddon(addonKey)) {
      await changeAddons(resolved.ctx, resolved.archetype, {
        additions: [{ addonKey, quantity }],
        removals: [],
      });
      ok = true;
    }
  } catch (err) {
    logger.error({ orgId, addonKey, err: (err as Error).message }, "addAddon action failed");
    ok = false;
  }
  redirect(`${BASE(orgId)}?notice=${ok ? "addon_added" : "error"}`);
}

export async function removeAddonAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const addonKey = String(formData.get("addon") ?? "");
  let ok = false;
  try {
    if (getAddon(addonKey)) {
      // Removal is scheduled to PERIOD END by the service — never mid-cycle,
      // never deletes data (the UI copy says exactly that).
      await changeAddons(resolved.ctx, resolved.archetype, {
        additions: [],
        removals: [addonKey],
      });
      ok = true;
    }
  } catch (err) {
    logger.error({ orgId, addonKey, err: (err as Error).message }, "removeAddon action failed");
    ok = false;
  }
  redirect(`${BASE(orgId)}?notice=${ok ? "addon_removed" : "error"}`);
}

export async function removeBundleAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const bundleKey = String(formData.get("bundle") ?? "");
  let ok = false;
  try {
    if (getBundle(bundleKey)) {
      // Schedules period-end removal of EVERY member row sourced from this bundle
      // — never mid-cycle, never deletes data (same law as single-add-on removal).
      await changeAddons(resolved.ctx, resolved.archetype, {
        additions: [],
        removals: [],
        removeBundleKey: bundleKey,
      });
      ok = true;
    }
  } catch (err) {
    logger.error({ orgId, bundleKey, err: (err as Error).message }, "removeBundle action failed");
    ok = false;
  }
  redirect(`${BASE(orgId)}?notice=${ok ? "bundle_removed" : "error"}`);
}

export async function selectBundleAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const bundleKey = String(formData.get("bundle") ?? "");
  let ok = false;
  try {
    if (getBundle(bundleKey)) {
      await changeAddons(resolved.ctx, resolved.archetype, {
        additions: [],
        removals: [],
        bundleKey,
      });
      ok = true;
    }
  } catch (err) {
    logger.error({ orgId, bundleKey, err: (err as Error).message }, "selectBundle action failed");
    ok = false;
  }
  redirect(`${BASE(orgId)}?notice=${ok ? "bundle_selected" : "error"}`);
}
