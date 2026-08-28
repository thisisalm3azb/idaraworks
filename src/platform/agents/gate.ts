/**
 * The agent feature gate (H12 / A1) — server-authoritative and fail-closed.
 *
 * The canonical key is feat.ai_agents. It is deliberately NOT yet registered
 * in the entitlement catalogue: the entitlement system's own laws (catalogue
 * to DB parity, one plan_entitlement row per plan per key, and the growth
 * trial enabling every registered feature) mean registration requires a
 * migration seeded together with a REAL runtime — and seeding into the
 * all-on trial would silently enable agents. Until that micro-step, this
 * gate resolves to FALSE for every organization by construction: nothing a
 * client sends can change it, and agent execution fails closed on it.
 *
 * When the key is registered and seeded (disabled) in the catalogue, this
 * same function automatically becomes the entitlement-resolved check with
 * no call-site changes.
 */
import { hasFeature, type FeatureKey } from "@/platform/entitlements";
import { isFeatureKey } from "@/platform/entitlements/catalogue";
import type { Ctx } from "@/platform/tenancy";

export const AI_AGENTS_FEATURE_KEY = "feat.ai_agents" as const;

export async function agentsEnabled(ctx: Ctx): Promise<boolean> {
  if (!isFeatureKey(AI_AGENTS_FEATURE_KEY)) return false; // unregistered → OFF everywhere
  return hasFeature(ctx, AI_AGENTS_FEATURE_KEY as FeatureKey);
}
