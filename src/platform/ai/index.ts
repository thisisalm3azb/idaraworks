/**
 * H28 — Idara Intelligence platform substrate (L1): the provider-neutral
 * gateway, registries, price book, budget, metering and BYOK. Modules import
 * from here only; adapters are internal to the gateway.
 */
export * from "./registry";
export {
  listPrivacyRegister,
  recordPrivacyRegister,
  revokePrivacyRegister,
  setSelfServicePolicy,
  PrivacyInput,
  SelfServicePolicyInput,
  type PrivacyRow,
} from "./privacy";
export {
  isPlatformOperator,
  operatorUsage,
  operatorUsageRows,
  operatorOrgs,
  operatorSwitches,
  operatorProviderHealth,
  operatorEconomics,
  operatorAudit,
  setKillSwitch,
  setProviderEnabled,
  setModelEnabled,
  addPriceBookRow,
  setOrgAiPolicy,
  grantCredits,
  registrySnapshot,
  NotOperatorError,
  type Economics,
  type OperatorUsageRow,
  type OperatorOrgRow,
} from "./operator";
export {
  idaraGateFor,
  FLAG_OFF_OWNER_ACTION,
  NO_PROVIDER_OWNER_ACTION,
  type IdaraGate,
} from "./gate";
export { PLATFORM_CONTRACT, AGENT_PROMPTS, agentPrompt, PROMPT_VERSION } from "./prompts";
export {
  invokeModel,
  aiAvailability,
  providerAvailabilityIn,
  routeIn,
  GatewayError,
  RouteError,
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  type GatewayDeps,
  type InvokeArgs,
  type InvokeResult,
  type ProviderAvailability,
  type RouteDecision,
  type GatewayFailure,
} from "./gateway";
export {
  AdapterError,
  renderBlocks,
  approxTokens,
  ZERO_USAGE,
  type GatewayBlock,
  type GatewayContent,
  type GatewayMessage,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayToolDef,
  type GatewayUsage,
  type StreamEvent,
  type AiAdapter,
  type FetchLike,
} from "./adapters/types";
export {
  setDeterministicScript,
  deterministicAdapter,
  type DeterministicScript,
} from "./adapters/deterministic";
export {
  resolveAiPolicy,
  allowanceStatus,
  decideBudget,
  readSwitches,
  periodKeyOf,
  DEFAULT_POLICY,
  AI_MODES,
  BUDGET_REASON_KEY,
  type AiPolicy,
  type AiMode,
  type AllowanceStatus,
  type BudgetDecision,
  type BudgetReason,
  type BudgetVerdict,
  type BudgetFacts,
} from "./budget";
export {
  effectivePrice,
  priceHistory,
  estimateCostMicros,
  estimateUpperBoundMicros,
  effectiveCreditPolicy,
  creditsForUsdMicros,
  type PriceRow,
  type CreditPolicy,
} from "./pricebook";
export {
  recordInteraction,
  listUsage,
  AI_FEATURES,
  type AiFeature,
  type UsageRow,
} from "./metering";
export {
  byokProvisioned,
  BYOK_OWNER_ACTION,
  ByokUnavailableError,
  listByokKeys,
  storeByokKeyIn,
  revokeByokKeyIn,
  type ByokRow,
} from "./byok";
