import { cache } from "react";
import { loadOnboarding } from "@/modules/guidedtour/service";
import type { Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";

/**
 * H32 — one onboarding read per request, not two.
 *
 * The tour mount lives in the org layout and the checklist lives on the home
 * page, so on the home page both were asking the same question of the database
 * in the same request. React's `cache` deduplicates within a single render
 * pass, which is exactly the scope that matters here: the answer cannot change
 * mid-request, and nothing is held between requests.
 *
 * The cache key is the argument list, so a different organisation, person or
 * role is a different entry — this can never serve one tenant's state to
 * another. That is worth stating explicitly rather than relying on it being
 * obvious, because a request-scoped cache that got the key wrong would be a
 * cross-tenant leak rather than a slow page.
 */
export const loadOnboardingCached = cache(async (ctx: Ctx, archetype: RoleArchetype) =>
  loadOnboarding(ctx, archetype),
);
