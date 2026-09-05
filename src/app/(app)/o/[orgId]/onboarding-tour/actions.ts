"use server";

import { redirect } from "next/navigation";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import {
  dismissChecklist,
  restartTour,
  saveProgress,
  tourKeyForRole,
  ONBOARDING_STATUSES,
  type OnboardingStatus,
} from "@/modules/guidedtour/service";

/**
 * H32 — the four things the welcome experience can write.
 *
 * ── Why none of these redirect ──────────────────────────────────────────────
 * Everywhere else in this codebase an action ends in a redirect, because
 * everywhere else the action changed the business and the page must re-render
 * to show it. Here the only thing that changed is a note about what somebody
 * has already read. Redirecting would tear down the page mid-tour and lose
 * their place — the tour advances on the client, and this records it behind.
 *
 * ── Why they cannot fail loudly ─────────────────────────────────────────────
 * Each returns void and swallows its own failure. A welcome mat that produces
 * an error screen because it could not save "step 3" is a strictly worse
 * product than one that silently forgets. The tour is designed to work with
 * every one of these calls failing; all that is lost is resuming on another
 * device.
 *
 * Note what is absent: no action takes a user id. The row written is always the
 * caller's own, decided by the session and enforced again by row-level security
 * — so there is no shape of request that marks a colleague's tour complete.
 */

function isStatus(v: string): v is OnboardingStatus {
  return (ONBOARDING_STATUSES as readonly string[]).includes(v);
}

/** Record progress: welcomed, started, finished or skipped. */
export async function saveTourProgressAction(
  orgId: string,
  status: string,
  stepIndex: number,
): Promise<void> {
  try {
    if (!isStatus(status)) return;
    const resolved = await resolveCtxForAction(orgId);
    if (typeof resolved === "string") return;
    await saveProgress(resolved.ctx, {
      status,
      stepIndex,
      // The tour is derived from the role on the server, never accepted from the
      // client: a request cannot ask to be recorded against a tour its sender
      // was never eligible for.
      tourKey: tourKeyForRole(resolved.archetype),
    });
  } catch {
    // Deliberate. See the note above.
  }
}

/**
 * Start again from the beginning, from the account menu.
 *
 * This one DOES navigate, and it is the exception that proves the rule above:
 * the tour is mounted by the layout from server state, so asking for it from a
 * menu has to produce a fresh render or nothing visible happens. Home is also
 * simply where the tour begins.
 */
export async function restartTourAction(orgId: string): Promise<void> {
  try {
    const resolved = await resolveCtxForAction(orgId);
    if (typeof resolved !== "string") await restartTour(resolved.ctx, resolved.archetype);
  } catch {
    // Even a failed write should still take them home, where the tour they
    // asked for is at worst one click away in the same menu.
  }
  // Outside the catch: redirect() signals by throwing, and swallowing it would
  // turn a working navigation into a silent no-op.
  redirect(`/o/${orgId}`);
}

/** Hide the getting-started checklist for this person. */
export async function dismissChecklistAction(orgId: string): Promise<void> {
  try {
    const resolved = await resolveCtxForAction(orgId);
    if (typeof resolved === "string") return;
    await dismissChecklist(resolved.ctx);
  } catch {
    // Deliberate.
  }
}
