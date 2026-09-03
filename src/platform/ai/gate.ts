/**
 * H28 — the one gate for Idara Intelligence (ADR-64).
 *
 * Every layer must agree before anything provider-dependent happens:
 *   release flag (exact "1") → organisation policy (mode, org switch) →
 *   platform switches (global, org) → at least one provider available to
 *   THIS organisation (credential, provider state, breaker, privacy register).
 *
 * `idaraGateFor` answers both questions the surfaces need: may the dock
 * appear at all (flag + policy + person permission decided by the caller), and
 * may a model be called right now (everything above). It never throws.
 */
import { idaraEnabled } from "@/platform/flags";
import type { Ctx } from "@/platform/tenancy";
import { aiAvailability, type GatewayDeps, type ProviderAvailability } from "./gateway";
import type { AiPolicy, AllowanceStatus } from "./budget";

export type IdaraGate = {
  flagOn: boolean;
  /** The dock and settings may render (flag on and the organisation has not disabled AI). */
  surfaceOn: boolean;
  /** A model may be called right now. */
  modelAvailable: boolean;
  policy: AiPolicy | null;
  providers: ProviderAvailability[];
  allowance: AllowanceStatus | null;
  globalStop: boolean;
  orgStop: boolean;
  /** Why models are unavailable (first reason), for honest UI copy. */
  reason:
    | "ok"
    | "flag_off"
    | "org_disabled"
    | "global_stop"
    | "org_stop"
    | "no_provider"
    | "allowance_exhausted";
  ownerAction: string | null;
};

export const NO_PROVIDER_OWNER_ACTION =
  "Provision an AI provider for this deployment (AI_OPENAI_API_KEY or AI_ANTHROPIC_API_KEY in the server environment, or an organisation-supplied key with AI_BYOK_KEK), record the organisation's privacy register for that provider, and set the organisation's AI policy to a mode other than disabled. Until then Idara stays off and nothing is simulated.";

export async function idaraGateFor(ctx: Ctx, deps: GatewayDeps = {}): Promise<IdaraGate> {
  if (!idaraEnabled()) {
    return {
      flagOn: false,
      surfaceOn: false,
      modelAvailable: false,
      policy: null,
      providers: [],
      allowance: null,
      globalStop: false,
      orgStop: false,
      reason: "flag_off",
      ownerAction: null,
    };
  }
  const a = await aiAvailability(ctx, deps);
  const orgDisabled = !a.policy.aiEnabledByOrg || a.policy.mode === "disabled";
  const base = {
    flagOn: true,
    policy: a.policy,
    providers: a.providers,
    allowance: a.allowance,
    globalStop: a.switches.globalStop,
    orgStop: a.switches.orgStop,
  };
  if (orgDisabled) {
    return {
      ...base,
      surfaceOn: false,
      modelAvailable: false,
      reason: "org_disabled",
      ownerAction: NO_PROVIDER_OWNER_ACTION,
    };
  }
  if (a.switches.globalStop)
    return {
      ...base,
      surfaceOn: true,
      modelAvailable: false,
      reason: "global_stop",
      ownerAction: null,
    };
  if (a.switches.orgStop)
    return {
      ...base,
      surfaceOn: true,
      modelAvailable: false,
      reason: "org_stop",
      ownerAction: null,
    };
  if (!a.anyAvailable)
    return {
      ...base,
      surfaceOn: true,
      modelAvailable: false,
      reason: "no_provider",
      ownerAction: NO_PROVIDER_OWNER_ACTION,
    };
  if (
    a.allowance.remaining !== null &&
    a.allowance.remaining <= 0 &&
    a.policy.hardStop &&
    !a.policy.overageAllowed
  ) {
    return {
      ...base,
      surfaceOn: true,
      modelAvailable: false,
      reason: "allowance_exhausted",
      ownerAction: null,
    };
  }
  return { ...base, surfaceOn: true, modelAvailable: true, reason: "ok", ownerAction: null };
}
