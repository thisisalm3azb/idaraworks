import { guidedOnboardingEnabled } from "@/platform/flags";
import { getT } from "@/platform/i18n/server";
import { loadOnboarding } from "@/modules/guidedtour/service";
import type { Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { GuidedTour, type TourStepView } from "./GuidedTour";

/**
 * H32 — the gate, and where the words come from.
 *
 * Everything that decides whether a person is greeted happens here, on the
 * server: the release flag, the eligibility rule, their role, their
 * permissions, and what they have already seen. The client island receives a
 * finished list of steps in their own language and no logic for choosing them.
 *
 * ── Why every failure returns null ──────────────────────────────────────────
 * This is mounted in the org layout, so a throw here takes down every page in
 * the product for that person. An onboarding tour is not permitted to be the
 * reason somebody cannot reach their work, so the failure mode is "no tour".
 */
/**
 * The organisation's own words for the nouns this copy uses.
 *
 * Resolved by the caller, which already has them: an organisation that calls a
 * job a "boat" or a "hull" must read its own word here, and a tour that says
 * "job" to that company is the first thing it will notice is not really theirs.
 */
export type TourTerms = { job: string; jobs: string };

export async function GuidedTourMount({
  orgId,
  ctx,
  archetype,
  orgName,
  terms,
}: {
  orgId: string;
  ctx: Ctx;
  archetype: RoleArchetype;
  orgName: string;
  terms: TourTerms;
}) {
  // The release gate, first and cheapest: with the flag off this component does
  // not query, does not translate and renders nothing at all.
  if (!guidedOnboardingEnabled()) return null;

  // The catch covers the query and the catalogue lookup, and nothing else: a
  // try/catch cannot catch a render, because React builds the tree after this
  // function has already returned.
  let onboarding: Awaited<ReturnType<typeof loadOnboarding>>;
  let t: Awaited<ReturnType<typeof getT>>;
  try {
    onboarding = await loadOnboarding(ctx, archetype);
    t = await getT();
  } catch {
    return null;
  }
  if (!onboarding.autoStart || onboarding.steps.length === 0) return null;

  const total = onboarding.steps.length;

  const steps: TourStepView[] = onboarding.steps.map((s) => ({
    key: s.key,
    target: s.target,
    // Keyed by tour AND step, so the same idea can be phrased for the person
    // reading it — "your invoices" means something different to the owner and
    // to the bookkeeper.
    title: t(`tour.${onboarding.tourKey}.${s.key}.title`, { org: orgName, ...terms }),
    body: t(`tour.${onboarding.tourKey}.${s.key}.body`, { org: orgName, ...terms }),
  }));

  return (
    <GuidedTour
      orgId={orgId}
      steps={steps}
      mode={onboarding.state.status === "in_progress" ? "tour" : "welcome"}
      startAt={onboarding.state.stepIndex}
      labels={{
        welcomeTitle: t("tour.welcome.title", { org: orgName }),
        welcomeBody: t("tour.welcome.body", { org: orgName }),
        start: t("tour.start"),
        notNow: t("tour.not_now"),
        next: t("tour.next"),
        back: t("tour.back"),
        finish: t("tour.finish"),
        skip: t("tour.skip"),
        close: t("tour.close"),
        // Resolved here, one per step: ICU stays on the server and the island
        // ships no formatter and no catalogue.
        progress: onboarding.steps.map((_, i) =>
          t("tour.progress", { current: i + 1, total }),
        ),
      }}
    />
  );
}
