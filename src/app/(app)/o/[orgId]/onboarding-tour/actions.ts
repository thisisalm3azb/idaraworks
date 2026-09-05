"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { captureRequestError } from "@/platform/observability/sentry";
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
 * ── Why three of them do not redirect ───────────────────────────────────────
 * Everywhere else in this codebase an action ends in a redirect, because
 * everywhere else the action changed the business and the page must re-render
 * to show it. Here the only thing that changed is a note about what somebody
 * has already read. Redirecting would tear down the page mid-tour and lose
 * their place — the tour advances on the client, and this records it behind.
 *
 * ── Why they cannot fail loudly, and why they must not fail silently ────────
 * Each returns void and catches its own failure: a welcome mat that produces an
 * error screen because it could not save "step 3" is a strictly worse product
 * than one that forgets. But "does not break the page" and "nobody ever finds
 * out" are different properties. Every caught failure is reported through the
 * house error channel, so a broken write shows up where an operator looks
 * rather than being discovered by a customer who clicked and saw nothing.
 *
 * Note what is absent: no action takes a user id. The row written is always the
 * caller's own, decided by the session and enforced again by row-level security
 * — so there is no shape of request that marks a colleague's tour complete.
 */

function isStatus(v: string): v is OnboardingStatus {
  return (ONBOARDING_STATUSES as readonly string[]).includes(v);
}

/** Report, never throw: the page must survive; the operator must still know. */
function reportSwallowed(err: unknown, orgId: string, what: string): void {
  console.error(`[onboarding] ${what} failed for org ${orgId}:`, err);
  captureRequestError(err, { path: `/o/${orgId}`, method: `action:${what}` });
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
  } catch (err) {
    reportSwallowed(err, orgId, "saveTourProgress");
  }
}

/**
 * Start again from the beginning, from the account menu.
 *
 * This one DOES navigate, and it is the exception that proves the rule above:
 * the tour is mounted by the org LAYOUT from server state, so asking for it has
 * to produce a fresh render of that layout or nothing visible happens.
 *
 * ── The bug this shipped with ───────────────────────────────────────────────
 * The first version wrote the row and then called redirect() to the org home —
 * which is where the person already was. A redirect to the current URL is a
 * soft navigation, and a soft navigation reuses the layout segment from the
 * client router cache; the server log showed the action's 303 followed by no
 * request at all. The row said in_progress, the layout still said null, and the
 * owner clicked "Show me around" in production and nothing happened.
 *
 * revalidatePath on the layout is what tells the client its cached copy of the
 * org shell is stale, so the redirect actually re-renders it. The sibling
 * dismissExceptionAction does the same thing for the same reason.
 */
export async function restartTourAction(orgId: string): Promise<void> {
  try {
    const resolved = await resolveCtxForAction(orgId);
    if (typeof resolved !== "string") await restartTour(resolved.ctx, resolved.archetype);
  } catch (err) {
    // Still take them home — the menu item is one click away there — but this
    // must never be a silent failure: the whole feature would look dead.
    reportSwallowed(err, orgId, "restartTour");
  }
  // "layout": the tour mount lives in the org layout, not the page. Revalidating
  // the page alone would re-render everything EXCEPT the thing that needs it.
  revalidatePath(`/o/${orgId}`, "layout");
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
  } catch (err) {
    reportSwallowed(err, orgId, "dismissChecklist");
  }
  // The checklist is rendered by the home PAGE, so the page is what must
  // re-render for the dismissal to be visible without a manual refresh.
  revalidatePath(`/o/${orgId}`);
}
