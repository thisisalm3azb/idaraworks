"use server";

/**
 * Settings subscription actions (PART B + C). Every management control routes
 * through the GOVERNED test/trial path (applyGoverned*), so the page is a real
 * self-service management surface EVEN when the real payment provider is disabled
 * (prod, D1): the change is owner-authorized, server-side, audited as
 * `owner_action`, applied through the same lifecycle writers as a provider event —
 * and NO payment is collected. It never claims money moved, and a client claim can
 * never activate entitlements (the applier is reachable only through this
 * owner-gated action).
 *
 * PART C: any failure is classified into a safe code + a correlation id; the real
 * error is logged under that id; the banner shows `subscription.error.<code>` and
 * the id — never a DB/provider internal. The proposed selection is retained by the
 * builder (client state) across the redirect.
 */
import { redirect } from "next/navigation";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import {
  applyGovernedAddonChange,
  applyGovernedAddonSet,
  applyGovernedCancellation,
  applyGovernedGoFree,
  classifySubscriptionError,
} from "@/modules/subscription/service";
import { getAddon, getBundle } from "@/platform/entitlements";
import { logger } from "@/platform/logger";

const BASE = (orgId: string) => `/o/${orgId}/settings/subscription`;

/** Build the redirect query for a governed action's outcome. On failure, encode the
 * classified code + correlation id so the page shows a specific, safe message. */
function outcomeQuery(
  ok: boolean,
  successNotice: string,
  err?: { code: string; correlationId: string },
): string {
  if (ok) return `notice=${successNotice}`;
  return `notice=error&code=${err?.code ?? "internal"}&cid=${err?.correlationId ?? "unknown"}`;
}

function fail(orgId: string, context: string, err: unknown): never {
  const classified = classifySubscriptionError(err);
  logger.error(
    {
      orgId,
      context,
      code: classified.code,
      cid: classified.correlationId,
      err: (err as Error).message,
    },
    "governed subscription action failed",
  );
  redirect(`${BASE(orgId)}?${outcomeQuery(false, "", classified)}`);
}

// ── Change plan / select a tier (governed) ──────────────────────────────────────
export async function selectTierAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const bundleKey = String(formData.get("bundle") ?? "");
  if (!getBundle(bundleKey))
    fail(orgId, "selectTier:badKey", new Error(`unknown bundle ${bundleKey}`));
  try {
    await applyGovernedAddonChange(
      resolved.ctx,
      resolved.archetype,
      {
        additions: [],
        removals: [],
        bundleKey,
      },
      { priceVersion: String(formData.get("priceVersion") ?? "") || undefined },
    );
  } catch (err) {
    fail(orgId, "selectTier", err);
  }
  redirect(`${BASE(orgId)}?${outcomeQuery(true, "bundle_selected")}`);
}

// ── Return to the Free base (governed — schedules removal of every live add-on) ──
export async function selectFreeAction(orgId: string): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  try {
    await applyGovernedGoFree(resolved.ctx, resolved.archetype);
  } catch (err) {
    fail(orgId, "goFree", err);
  }
  redirect(`${BASE(orgId)}?${outcomeQuery(true, "addon_removed")}`);
}

// ── Manage add-ons (governed CustomBuilder submit — makes the individual set = desired) ──
export async function manageAddonsAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const desired: Record<string, number> = {};
  for (const key of new Set(formData.keys())) {
    if (!key.startsWith("addon:")) continue;
    const addonKey = key.slice("addon:".length);
    if (!getAddon(addonKey)) continue; // ignore unknown keys (never trust the client)
    const qty = Math.trunc(Number(formData.get(key) ?? 0));
    if (Number.isFinite(qty) && qty >= 1) desired[addonKey] = Math.min(99, qty);
  }
  try {
    await applyGovernedAddonSet(resolved.ctx, resolved.archetype, desired, {
      priceVersion: String(formData.get("priceVersion") ?? "") || undefined,
    });
  } catch (err) {
    fail(orgId, "manageAddons", err);
  }
  redirect(`${BASE(orgId)}?${outcomeQuery(true, "addons_changed")}`);
}

// ── Themed bundle select / remove (governed) ────────────────────────────────────
export async function selectBundleAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const bundleKey = String(formData.get("bundle") ?? "");
  if (!getBundle(bundleKey))
    fail(orgId, "selectBundle:badKey", new Error(`unknown bundle ${bundleKey}`));
  try {
    await applyGovernedAddonChange(resolved.ctx, resolved.archetype, {
      additions: [],
      removals: [],
      bundleKey,
    });
  } catch (err) {
    fail(orgId, "selectBundle", err);
  }
  redirect(`${BASE(orgId)}?${outcomeQuery(true, "bundle_selected")}`);
}

export async function removeBundleAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const bundleKey = String(formData.get("bundle") ?? "");
  if (!getBundle(bundleKey))
    fail(orgId, "removeBundle:badKey", new Error(`unknown bundle ${bundleKey}`));
  try {
    await applyGovernedAddonChange(resolved.ctx, resolved.archetype, {
      additions: [],
      removals: [],
      removeBundleKey: bundleKey,
    });
  } catch (err) {
    fail(orgId, "removeBundle", err);
  }
  redirect(`${BASE(orgId)}?${outcomeQuery(true, "bundle_removed")}`);
}

// ── Remove a single add-on (governed) ───────────────────────────────────────────
export async function removeAddonAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const addonKey = String(formData.get("addon") ?? "");
  if (!getAddon(addonKey))
    fail(orgId, "removeAddon:badKey", new Error(`unknown addon ${addonKey}`));
  try {
    await applyGovernedAddonChange(resolved.ctx, resolved.archetype, {
      additions: [],
      removals: [addonKey],
    });
  } catch (err) {
    fail(orgId, "removeAddon", err);
  }
  redirect(`${BASE(orgId)}?${outcomeQuery(true, "addon_removed")}`);
}

// ── Cancellation (governed — reuses the existing state machine, no second machine) ──
export async function cancelSubscriptionAction(orgId: string): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  try {
    await applyGovernedCancellation(resolved.ctx, resolved.archetype);
  } catch (err) {
    fail(orgId, "cancel", err);
  }
  redirect(`${BASE(orgId)}?${outcomeQuery(true, "cancel_requested")}`);
}
