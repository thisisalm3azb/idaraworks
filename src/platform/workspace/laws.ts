/**
 * The Intelligent Clay laws (H14) — the governing contract for workspace
 * configuration. These are NON-NEGOTIABLE: the blueprint schema, validator,
 * compiler and lifecycle implement them, and tests/unit/workspace-laws.test.ts
 * pins each one to executable behavior. Changing a law means changing this
 * file, its tests, and docs/architecture/INTELLIGENT_CLAY_WORKSPACE_CONTRACT.md
 * together.
 */

export type IntelligentClayLaw = {
  id: number;
  law: string;
};

export const INTELLIGENT_CLAY_LAWS: readonly IntelligentClayLaw[] = [
  {
    id: 1,
    law: "Intelligent Clay configures the product. It does not generate application code, database structure or security rules.",
  },
  { id: 2, law: "Organization configuration is always organization-scoped." },
  {
    id: 3,
    law: "Client-provided roles, permissions, entitlements or organization identity are never trusted.",
  },
  {
    id: 4,
    law: "Configuration cannot grant access beyond the organization's plan entitlement.",
  },
  {
    id: 5,
    law: "Configuration cannot grant a user access beyond their server-resolved permissions.",
  },
  { id: 6, law: "User preferences may change presentation but never authority." },
  { id: 7, law: "Every proposal must explain what it changes and why." },
  { id: 8, law: "Nothing is applied until an authorized human confirms it." },
  {
    id: 9,
    law: "Applying the same approved revision twice must be safe and idempotent.",
  },
  { id: 10, law: "Every applied change must be audited." },
  { id: 11, law: "Every reversible change must support undo." },
  { id: 12, law: "Disabling a module must never delete its business records." },
  { id: 13, law: "Changing terminology must not change entity identity." },
  { id: 14, law: "Changing workflows must not corrupt historical records." },
  {
    id: 15,
    law: "Country packs may add requirements but may not weaken security.",
  },
  {
    id: 16,
    law: "Agent access must remain bounded by entitlement, workspace configuration and acting-user permission.",
  },
  { id: 17, law: "English and Arabic are first-class configuration languages." },
  {
    id: 18,
    law: "The model must support future locales without embedding English assumptions.",
  },
  {
    id: 19,
    law: "The system must fail closed when configuration is missing, invalid or incompatible.",
  },
  {
    id: 20,
    law: "Product implementation truth remains internal even when customer-facing launch copy describes the finished vision.",
  },
] as const;

/**
 * The canonical effective-access equation (H14 Part C). Order IS precedence:
 * no lower layer may override a higher one, and every layer must
 * independently allow. Encoded in ./access.ts and consumed by the compiler.
 */
export const EFFECTIVE_ACCESS_LAYERS = [
  "platform_availability",
  "plan_entitlement",
  "approved_organization_configuration",
  "acting_user_permission",
] as const;

/** The additional layers required for agent-assisted actions. */
export const AGENT_ACCESS_LAYERS = [
  ...EFFECTIVE_ACCESS_LAYERS,
  "agent_allow_list",
  "action_classification",
  "approval_state",
] as const;
