/**
 * H28 — closed registries of AI providers and models (ADR-52).
 *
 * Registries are CODE (closed vocabularies); mutable state (enabled, health,
 * breaker, prices) lives in tables. Every privacy fact below was fetched from
 * the provider's own documentation on the date given (docs/H28-TRUTH-MAP.md
 * C.1) and is surfaced to organisations only when that provider is actually
 * configured. Nothing here claims zero retention, residency or "no training"
 * beyond what the cited page says.
 */

export const AI_PROVIDER_KEYS = ["disabled", "deterministic", "openai", "anthropic"] as const;
export type AiProviderKey = (typeof AI_PROVIDER_KEYS)[number];
export function isAiProviderKey(x: string): x is AiProviderKey {
  return (AI_PROVIDER_KEYS as readonly string[]).includes(x);
}

export type AiProviderPrivacy = {
  /** What the provider publishes about training on API data. */
  training: "not_used_by_default" | "used_unless_paid" | "not_applicable";
  /** Published retention window in days for standard API use, or null when unspecified. */
  retentionDays: number | null;
  retentionNote: string;
  /** Zero-data-retention availability as published. */
  zdr: "on_request" | "approved_only" | "not_applicable";
  residency: string;
  sourceUrl: string | null;
  fetchedAt: string | null;
};

export type AiProviderDef = {
  key: AiProviderKey;
  name: string;
  kind: "none" | "test" | "external";
  /** The ONLY host the adapter may talk to (egress allow-list). */
  host: string | null;
  /** Environment variable holding the platform credential (server-side only). */
  envKey: string | null;
  privacy: AiProviderPrivacy;
};

export const AI_PROVIDERS: Record<AiProviderKey, AiProviderDef> = {
  disabled: {
    key: "disabled",
    name: "Disabled",
    kind: "none",
    host: null,
    envKey: null,
    privacy: {
      training: "not_applicable",
      retentionDays: null,
      retentionNote: "No provider configured: nothing leaves the platform.",
      zdr: "not_applicable",
      residency: "not applicable",
      sourceUrl: null,
      fetchedAt: null,
    },
  },
  deterministic: {
    key: "deterministic",
    name: "Deterministic test provider",
    kind: "test",
    host: null,
    envKey: null,
    privacy: {
      training: "not_applicable",
      retentionDays: null,
      retentionNote: "Scripted responses computed inside the platform; no external call.",
      zdr: "not_applicable",
      residency: "in-platform",
      sourceUrl: null,
      fetchedAt: null,
    },
  },
  openai: {
    key: "openai",
    name: "OpenAI API",
    kind: "external",
    host: "api.openai.com",
    envKey: "AI_OPENAI_API_KEY",
    privacy: {
      training: "not_used_by_default",
      retentionDays: 30,
      retentionNote:
        "API data is not used to train models unless the customer opts in; abuse-monitoring logs are kept up to 30 days unless the law requires longer; zero data retention is endpoint-specific and subject to approval.",
      zdr: "approved_only",
      residency:
        "Regional hosts (us., eu., ae. and others) at a published uplift for newer models; non-US regions require abuse-monitoring approval and a retention amendment.",
      sourceUrl: "https://developers.openai.com/api/docs/guides/your-data",
      fetchedAt: "2026-09-03",
    },
  },
  anthropic: {
    key: "anthropic",
    name: "Anthropic API",
    kind: "external",
    host: "api.anthropic.com",
    envKey: "AI_ANTHROPIC_API_KEY",
    privacy: {
      training: "not_used_by_default",
      retentionDays: 30,
      retentionNote:
        "Inputs and outputs are deleted within 30 days by default; flagged content may be kept longer; zero data retention is arranged per organisation and some models are excluded from it.",
      zdr: "on_request",
      residency:
        "inference_geo global or us (published uplift for us on supported models); workspace data at rest us only.",
      sourceUrl: "https://platform.claude.com/docs/en/manage-claude/api-and-data-retention",
      fetchedAt: "2026-09-03",
    },
  },
};

// ── Models ──────────────────────────────────────────────────────────────────

export const AI_MODEL_TIERS = ["small", "standard", "strong"] as const;
export type AiModelTier = (typeof AI_MODEL_TIERS)[number];

export const AI_MODEL_KEYS = [
  "deterministic:fast",
  "deterministic:strong",
  "openai:gpt-5-nano",
  "openai:gpt-5.4-nano",
  "openai:gpt-5.6-sol",
  "anthropic:claude-haiku-4-5",
  "anthropic:claude-sonnet-5",
  "anthropic:claude-opus-5",
  "anthropic:claude-fable-5-1",
] as const;
export type AiModelKey = (typeof AI_MODEL_KEYS)[number];
export function isAiModelKey(x: string): x is AiModelKey {
  return (AI_MODEL_KEYS as readonly string[]).includes(x);
}

export type AiModelDef = {
  key: AiModelKey;
  provider: AiProviderKey;
  /** The identifier sent to the provider. */
  providerModelId: string;
  name: string;
  tier: AiModelTier;
  capabilities: { tools: boolean; jsonSchema: boolean; streaming: boolean; vision: boolean };
  contextTokens: number;
  maxOutputTokens: number;
  status: "active" | "retiring" | "retired";
  replacedBy: AiModelKey | null;
  costClass: "low" | "medium" | "high";
  privacy: { zdrEligible: boolean | null; residencyOption: string | null };
  sourceUrl: string | null;
  fetchedAt: string | null;
};

export const AI_MODELS: Record<AiModelKey, AiModelDef> = {
  "deterministic:fast": {
    key: "deterministic:fast",
    provider: "deterministic",
    providerModelId: "deterministic-fast",
    name: "Deterministic (fast)",
    tier: "small",
    capabilities: { tools: true, jsonSchema: true, streaming: true, vision: false },
    contextTokens: 200_000,
    maxOutputTokens: 16_000,
    status: "active",
    replacedBy: null,
    costClass: "low",
    privacy: { zdrEligible: null, residencyOption: "in-platform" },
    sourceUrl: null,
    fetchedAt: null,
  },
  "deterministic:strong": {
    key: "deterministic:strong",
    provider: "deterministic",
    providerModelId: "deterministic-strong",
    name: "Deterministic (strong)",
    tier: "strong",
    capabilities: { tools: true, jsonSchema: true, streaming: true, vision: false },
    contextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    status: "active",
    replacedBy: null,
    costClass: "low",
    privacy: { zdrEligible: null, residencyOption: "in-platform" },
    sourceUrl: null,
    fetchedAt: null,
  },
  "openai:gpt-5-nano": {
    key: "openai:gpt-5-nano",
    provider: "openai",
    providerModelId: "gpt-5-nano",
    name: "GPT-5 nano",
    tier: "small",
    capabilities: { tools: true, jsonSchema: true, streaming: true, vision: true },
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    status: "active",
    replacedBy: null,
    costClass: "low",
    privacy: { zdrEligible: true, residencyOption: "regional host prefix" },
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    fetchedAt: "2026-09-03",
  },
  "openai:gpt-5.4-nano": {
    key: "openai:gpt-5.4-nano",
    provider: "openai",
    providerModelId: "gpt-5.4-nano",
    name: "GPT-5.4 nano",
    tier: "small",
    capabilities: { tools: true, jsonSchema: true, streaming: true, vision: true },
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    status: "active",
    replacedBy: null,
    costClass: "low",
    privacy: { zdrEligible: true, residencyOption: "regional host prefix" },
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.4-nano",
    fetchedAt: "2026-09-03",
  },
  "openai:gpt-5.6-sol": {
    key: "openai:gpt-5.6-sol",
    provider: "openai",
    providerModelId: "gpt-5.6-sol",
    name: "GPT-5.6 sol",
    tier: "strong",
    capabilities: { tools: true, jsonSchema: true, streaming: true, vision: true },
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    status: "active",
    replacedBy: null,
    costClass: "high",
    privacy: { zdrEligible: true, residencyOption: "regional host prefix" },
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    fetchedAt: "2026-09-03",
  },
  "anthropic:claude-haiku-4-5": {
    key: "anthropic:claude-haiku-4-5",
    provider: "anthropic",
    providerModelId: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    tier: "small",
    capabilities: { tools: true, jsonSchema: true, streaming: true, vision: true },
    contextTokens: 200_000,
    maxOutputTokens: 64_000,
    status: "active",
    replacedBy: null,
    costClass: "low",
    privacy: { zdrEligible: true, residencyOption: null },
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/models/overview",
    fetchedAt: "2026-09-03",
  },
  "anthropic:claude-sonnet-5": {
    key: "anthropic:claude-sonnet-5",
    provider: "anthropic",
    providerModelId: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    tier: "standard",
    capabilities: { tools: true, jsonSchema: true, streaming: true, vision: true },
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    status: "active",
    replacedBy: null,
    costClass: "medium",
    privacy: { zdrEligible: true, residencyOption: "inference_geo us" },
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/models/overview",
    fetchedAt: "2026-09-03",
  },
  "anthropic:claude-opus-5": {
    key: "anthropic:claude-opus-5",
    provider: "anthropic",
    providerModelId: "claude-opus-5",
    name: "Claude Opus 5",
    tier: "strong",
    capabilities: { tools: true, jsonSchema: true, streaming: true, vision: true },
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    status: "active",
    replacedBy: null,
    costClass: "high",
    privacy: { zdrEligible: false, residencyOption: "inference_geo us" },
    sourceUrl: "https://platform.claude.com/docs/en/manage-claude/api-and-data-retention",
    fetchedAt: "2026-09-03",
  },
  "anthropic:claude-fable-5-1": {
    key: "anthropic:claude-fable-5-1",
    provider: "anthropic",
    providerModelId: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    tier: "strong",
    capabilities: { tools: true, jsonSchema: true, streaming: true, vision: true },
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    status: "active",
    replacedBy: null,
    costClass: "high",
    privacy: { zdrEligible: false, residencyOption: "inference_geo us" },
    sourceUrl: "https://platform.claude.com/docs/en/manage-claude/api-and-data-retention",
    fetchedAt: "2026-09-03",
  },
};

/** Resolve a retired model to its replacement (one hop per call; loops are impossible by registry review). */
export function resolveModelKey(key: AiModelKey): AiModelKey {
  const def = AI_MODELS[key];
  if (def.status === "retired" && def.replacedBy) return def.replacedBy;
  return key;
}

// ── Task classes and routing defaults (ADR-60 routing table) ────────────────

export const AI_TASK_CLASSES = [
  "classify",
  "extract",
  "summarise",
  "answer",
  "draft",
  "analyse",
  "plan",
] as const;
export type AiTaskClass = (typeof AI_TASK_CLASSES)[number];

/** The tier each task class needs; a stronger tier is never required silently. */
export const TASK_TIER: Record<AiTaskClass, AiModelTier> = {
  classify: "small",
  extract: "small",
  summarise: "small",
  answer: "standard",
  draft: "standard",
  analyse: "strong",
  plan: "strong",
};

/** Whether a task class may run one tier below its default when the preferred tier is unavailable
 * (assurance-neutral classes only; analysis and planning never downgrade silently). */
export const TASK_MAY_DOWNGRADE: Record<AiTaskClass, boolean> = {
  classify: true,
  extract: true,
  summarise: true,
  answer: true,
  draft: true,
  analyse: false,
  plan: false,
};

export const TIER_RANK: Record<AiModelTier, number> = { small: 0, standard: 1, strong: 2 };
