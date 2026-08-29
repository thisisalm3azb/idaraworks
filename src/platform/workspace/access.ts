/**
 * The canonical effective-access equation (H14 Part C).
 *
 *   Effective capability = platform availability
 *                        ∩ plan entitlement
 *                        ∩ approved organization configuration
 *                        ∩ acting-user permission
 *
 * For agent-assisted actions, additionally:
 *
 *                        ∩ agent allow-list
 *                        ∩ action classification
 *                        ∩ approval state
 *
 * Strict intersection: EVERY layer must independently allow; a lower layer
 * can never override a higher one (there is no override input by
 * construction — the functions are pure ANDs over server-resolved booleans).
 * Missing/undefined inputs are treated as DENIED (law 19: fail closed).
 */

export type EffectiveCapabilityInput = {
  /** The platform ships this capability (module registry availability). */
  platformAvailable: boolean;
  /** The organization's plan entitlement includes it (server-resolved). */
  planEntitled: boolean;
  /** The approved workspace configuration enables it. */
  configEnabled: boolean;
  /** The acting user's server-resolved permissions allow the action. */
  userPermitted: boolean;
};

export function effectiveCapability(input: EffectiveCapabilityInput): boolean {
  return (
    input.platformAvailable === true &&
    input.planEntitled === true &&
    input.configEnabled === true &&
    input.userPermitted === true
  );
}

export type EffectiveAgentActionInput = EffectiveCapabilityInput & {
  /** The tool/domain is on the agent's canonical allow-list. */
  agentAllowListed: boolean;
  /** The action classification is supported and is not prohibited. */
  classificationSupported: boolean;
  /** Any required human approval is attached and valid. */
  approvalSatisfied: boolean;
};

export function effectiveAgentAction(input: EffectiveAgentActionInput): boolean {
  return (
    effectiveCapability(input) &&
    input.agentAllowListed === true &&
    input.classificationSupported === true &&
    input.approvalSatisfied === true
  );
}
