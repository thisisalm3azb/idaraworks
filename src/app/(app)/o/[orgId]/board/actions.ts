"use server";

import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { resolveEntitlements } from "@/platform/entitlements";
import { hrSurfacesEnabled, stockSurfacesEnabled } from "@/platform/flags";
import { captureRequestError } from "@/platform/observability/sentry";
import {
  availableWidgets,
  resetDashboardPref,
  sanitiseSubmitted,
  saveDashboardPref,
} from "@/modules/dashboard/service";
import { resolveShell } from "../shell";

/**
 * The two things the dashboard board can write: a layout, and "forget it".
 *
 * Neither redirects: the board advances on the client and refreshes the page
 * itself once the write is confirmed, so the person keeps their place and sees
 * a definite answer (saved, or why not). Neither takes a user id: the row
 * written is always the caller's own, decided by the session and enforced
 * again by row-level security.
 *
 * A submitted layout is reduced to the widgets THIS person may have before it
 * is stored. A key the person cannot see is dropped, not saved for later: the
 * layout is a preference, and a preference must never become a grant.
 */
export type BoardResult = { ok: true } | { ok: false; error: "forbidden" | "invalid" | "failed" };

export async function saveDashboardLayoutAction(
  orgId: string,
  layout: unknown,
): Promise<BoardResult> {
  try {
    const resolved = await resolveCtxForAction(orgId);
    if (typeof resolved === "string") return { ok: false, error: "forbidden" };
    const [ent, shell] = await Promise.all([
      resolveEntitlements(resolved.ctx),
      resolveShell(resolved),
    ]);
    const available = availableWidgets({
      archetype: resolved.archetype,
      features: ent.features,
      disabledModules: shell.disabledModules,
      seesPrice: resolved.ctx.pricePrivileged,
      flags: { stock: stockSurfacesEnabled(), hr: hrSurfacesEnabled() },
      adaptive: shell.shape !== null,
    });
    const clean = sanitiseSubmitted(layout, available);
    if (!clean) return { ok: false, error: "invalid" };
    await saveDashboardPref(resolved.ctx, clean);
    revalidatePath(`/o/${orgId}`);
    return { ok: true };
  } catch (err) {
    console.error(`[dashboard] save layout failed for org ${orgId}:`, err);
    captureRequestError(err, { path: `/o/${orgId}`, method: "action:saveDashboardLayout" });
    return { ok: false, error: "failed" };
  }
}

export async function resetDashboardLayoutAction(orgId: string): Promise<BoardResult> {
  try {
    const resolved = await resolveCtxForAction(orgId);
    if (typeof resolved === "string") return { ok: false, error: "forbidden" };
    await resetDashboardPref(resolved.ctx);
    revalidatePath(`/o/${orgId}`);
    return { ok: true };
  } catch (err) {
    console.error(`[dashboard] reset layout failed for org ${orgId}:`, err);
    captureRequestError(err, { path: `/o/${orgId}`, method: "action:resetDashboardLayout" });
    return { ok: false, error: "failed" };
  }
}
