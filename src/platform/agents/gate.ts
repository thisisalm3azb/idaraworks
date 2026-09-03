/**
 * The agent feature gate (H12 / A1, redefined by H28 — ADR-64).
 *
 * The canonical H12 key feat.ai_agents stays deliberately UNREGISTERED in the
 * entitlement catalogue (registering it would sweep it into the all-on growth
 * trial). Since H28 the gate is the Idara gate: release flag, organisation AI
 * policy, platform switches and a provider that this organisation may use.
 * Every H25–H27 seam that asks agentsEnabled() therefore follows the same
 * fail-closed law as the dock, with no call-site change.
 */
import { idaraGateFor } from "@/platform/ai/gate";
import type { Ctx } from "@/platform/tenancy";

export const AI_AGENTS_FEATURE_KEY = "feat.ai_agents" as const;

export async function agentsEnabled(ctx: Ctx): Promise<boolean> {
  try {
    const g = await idaraGateFor(ctx);
    return g.modelAvailable;
  } catch {
    return false;
  }
}
