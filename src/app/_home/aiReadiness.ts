/**
 * The switch that will later allow live agent wording such as "powered by
 * role-aware AI agents" on the public homepage. It may become true ONLY when a
 * real production agent exists behind a tested backend capability (see
 * docs/architecture/ROLE_AWARE_AGENT_ARCHITECTURE.md §7); tests enforce that
 * such wording cannot render while this is false. The current homepage makes
 * no AI claim at all.
 */
export const AI_AGENTS_PRODUCTION_READY = false as const;
