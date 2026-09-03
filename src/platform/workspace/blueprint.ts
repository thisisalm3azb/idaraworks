/**
 * The versioned workspace blueprint (H14 Part D) — the typed contract that
 * describes how IdaraWorks shapes itself around one organization.
 *
 * Design laws encoded structurally:
 *  - every schema is .strict(): unknown fields are REJECTED, so a client can
 *    never smuggle roles, permissions, entitlements or provider settings in
 *    (law 3) — there is nowhere for them to live;
 *  - every section carries provenance with a human-readable bilingual reason
 *    (law 7);
 *  - every organization-facing label is a localized map requiring en AND ar
 *    (law 17) while accepting additional locale keys (law 18 — no English
 *    assumption is baked into the shape);
 *  - all vocabulary fields are closed-registry enums: the blueprint can only
 *    NAME existing platform truth (modules, nav items, dashboard cards,
 *    terminology keys, archetypes, agents), never invent it;
 *  - tenant-authored strings pass the config-string sanitiser (the same wall
 *    every config artifact goes through).
 *
 * The blueprint holds configuration INTENT. Nothing in it grants anything:
 * the compiler intersects it with platform availability, plan entitlement
 * and acting-user permission (see ./access.ts), and the lifecycle applies it
 * only after an authorized human approves the exact revision hash.
 */
import { z } from "zod";
import { configString, MAX_TEXT_LENGTH } from "@/platform/config";
import { TERM_KEYS, SUPPORTED_LOCALES, CURRENCY_CODES } from "@/platform/registries";
import { AGENT_IDS, ACTION_CLASSES } from "@/platform/agents/registry";
import { AI_AGENTS_FEATURE_KEY } from "@/platform/agents/gate";
import {
  BUSINESS_MODELS,
  WORK_DELIVERY_MODELS,
  REVENUE_MODELS,
  CUSTOMER_TYPES,
  OPERATING_MODES,
  ORG_SIZE_BANDS,
  WORKSPACE_MODULE_KEYS,
  NAV_ITEM_KEYS,
  DASHBOARD_CARD_KEYS,
  TIME_HORIZONS,
  PROVENANCE_SOURCES,
  WORKSPACE_COUNTRIES,
  BLUEPRINT_ARCHETYPES,
} from "./registry";

export const BLUEPRINT_SCHEMA_VERSION = 1;

// ── Shared shapes ───────────────────────────────────────────────────────────
const localeKey = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, "locale key");

/**
 * The languages a BLUEPRINT must be written in. Deliberately NOT the list of
 * languages the interface supports: adding a product language must never
 * invalidate a stored blueprint, and no organisation should be forced to author
 * its own labels in a language it does not use. H29 made that distinction
 * explicit; before it, the two lists were the same one by accident.
 */
export const BLUEPRINT_REQUIRED_LOCALES = ["en", "ar"] as const;

/**
 * A localized text map: en and ar are REQUIRED first-class values; any other
 * locale key is accepted with the same sanitised shape, so future locales
 * need no schema change (laws 17/18).
 */
export const LocalizedTextSchema = z
  .record(localeKey, configString(MAX_TEXT_LENGTH))
  .superRefine((map, ctx) => {
    for (const required of BLUEPRINT_REQUIRED_LOCALES) {
      if (!map[required] || map[required].length === 0) {
        ctx.addIssue({ code: "custom", message: `missing required locale "${required}"` });
      }
    }
  });
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

/** Provenance: what proposed this section, who, when and WHY (law 7). */
export const ProvenanceSchema = z
  .object({
    source: z.enum(PROVENANCE_SOURCES),
    /** Server-attributed proposer (user id or "system"); informational — the
     * lifecycle re-attributes every mutation to the server-resolved actor. */
    proposedBy: z.string().min(1).max(80),
    proposedAt: z.string().datetime(),
    reason: LocalizedTextSchema,
    confidence: z.enum(["high", "medium", "low"]).optional(),
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

// ── 1. Business profile ─────────────────────────────────────────────────────
export const BusinessProfileSchema = z
  .object({
    businessModel: z.enum(BUSINESS_MODELS),
    /** Free-text operating contexts (sanitised; e.g. "marine services"). */
    industries: z.array(configString()).min(1).max(5),
    size: z.enum(ORG_SIZE_BANDS),
    /** Markets served — configuration countries the platform knows. */
    markets: z.array(z.enum(WORKSPACE_COUNTRIES)).min(1).max(6),
    customerTypes: z.array(z.enum(CUSTOMER_TYPES)).min(1).max(4),
    workDelivery: z.array(z.enum(WORK_DELIVERY_MODELS)).min(1).max(5),
    revenueModels: z.array(z.enum(REVENUE_MODELS)).min(1).max(5),
    operatingMode: z.enum(OPERATING_MODES),
    operatingLocations: z.number().int().min(1).max(1000),
    provenance: ProvenanceSchema,
  })
  .strict();

// ── 2. Capability selection ─────────────────────────────────────────────────
export const CapabilitySelectionSchema = z
  .object({
    /** One entry per module the blueprint takes a position on. */
    modules: z
      .array(
        z
          .object({
            key: z.enum(WORKSPACE_MODULE_KEYS),
            enabled: z.boolean(),
            /** Why this module is in or out — always explained (law 7). */
            reason: LocalizedTextSchema,
          })
          .strict(),
      )
      .min(1)
      .max(WORKSPACE_MODULE_KEYS.length),
    provenance: ProvenanceSchema,
  })
  .strict();

// ── 3. Terminology ──────────────────────────────────────────────────────────
const TermFormSchema = z
  .object({
    singular: configString(),
    plural: configString(),
    /** Arabic grammatical gender — required for ar (agreement). */
    gender: z.enum(["m", "f"]).optional(),
  })
  .strict();

export const TerminologySchema = z
  .object({
    /** Overrides keyed by CANONICAL entity id — the key IS the identity and
     * never changes (law 13); only organization-facing words change. */
    overrides: z
      .partialRecord(
        z.enum(TERM_KEYS),
        z.record(localeKey, TermFormSchema).superRefine((map, ctx) => {
          for (const required of BLUEPRINT_REQUIRED_LOCALES) {
            if (!map[required]) {
              ctx.addIssue({ code: "custom", message: `missing required locale "${required}"` });
            }
          }
          if (map.ar && !map.ar.gender) {
            ctx.addIssue({ code: "custom", message: "ar term requires gender" });
          }
        }),
      )
      .default({}),
    /** Keys without an override resolve to the platform defaults. */
    fallback: z.literal("platform_default"),
    provenance: ProvenanceSchema,
  })
  .strict();

// ── 4. Workflow configuration ───────────────────────────────────────────────
const stageKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "stage key");

export const WorkflowSchema = z
  .object({
    /** The operational container this workflow shapes (closed registry). */
    id: z.literal("job"),
    name: LocalizedTextSchema,
    stages: z
      .array(
        z
          .object({
            key: stageKey,
            name: LocalizedTextSchema,
            weight: z.number().int().min(1).max(100),
            phaseSemantic: z.enum([
              "preparation",
              "production",
              "finishing",
              "verification",
              "handover",
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    /** Allowed transitions between stage keys (forward motion by default). */
    transitions: z
      .array(z.object({ from: stageKey, to: stageKey }).strict())
      .max(200)
      .default([]),
    /** Stages whose completion requires a human approval, and by whom. */
    requiredApprovals: z
      .array(z.object({ stageKey, approvedBy: z.enum(BLUEPRINT_ARCHETYPES) }).strict())
      .max(30)
      .default([]),
    /** Roles responsible for driving each stage. */
    responsibilities: z
      .array(z.object({ stageKey, role: z.enum(BLUEPRINT_ARCHETYPES) }).strict())
      .max(60)
      .default([]),
    /** Exception paths: explicitly allowed non-forward transitions. */
    exceptionPaths: z
      .array(z.object({ from: stageKey, to: stageKey, reason: LocalizedTextSchema }).strict())
      .max(30)
      .default([]),
    /** Shipped behavior: records snapshot their stages at creation, so a
     * workflow change NEVER rewrites historical records (law 14). */
    versioning: z.literal("snapshot_on_creation"),
    provenance: ProvenanceSchema,
  })
  .strict();

// ── 5. Roles ────────────────────────────────────────────────────────────────
export const RoleConfigSchema = z
  .object({
    /** The server-side archetype this organization-facing role maps to. The
     * archetype decides authority (authz matrix); the blueprint only names,
     * describes and prioritizes — it cannot re-cut permissions (law 5). */
    archetype: z.enum(BLUEPRINT_ARCHETYPES),
    name: LocalizedTextSchema,
    responsibilities: LocalizedTextSchema,
    /** DOCUMENTATION references to authz actions this role relies on. The
     * validator rejects any action the archetype does not actually hold —
     * a blueprint can never be a permission escalation vector. */
    permissionRefs: z.array(z.string().min(1).max(60)).max(40).default([]),
    /** Presentation-only nav visibility (subset; can() still decides). */
    navVisibility: z.array(z.enum(NAV_ITEM_KEYS)).max(NAV_ITEM_KEYS.length).default([]),
    relevantAgents: z.array(z.enum(AGENT_IDS)).max(AGENT_IDS.length).default([]),
    /** Whether this role decides approvals (informational; approvals.decide
     * in the matrix remains the authority). */
    approvalAuthority: z.boolean(),
    provenance: ProvenanceSchema,
  })
  .strict();

// ── 6. Navigation ───────────────────────────────────────────────────────────
export const NavigationSchema = z
  .object({
    /** Preferred ordering of nav items (presentation only). */
    order: z.array(z.enum(NAV_ITEM_KEYS)).max(NAV_ITEM_KEYS.length).default([]),
    /** Items hidden for THIS workspace (presentation only; the validator
     * refuses to hide safety-rail items, and hiding never revokes access —
     * the underlying route keeps its own authorization). */
    hidden: z.array(z.enum(NAV_ITEM_KEYS)).max(NAV_ITEM_KEYS.length).default([]),
    /** The shipped mobile contract: bottom bar with role-primary slots. */
    mobileContract: z.literal("bottom_bar_role_primary"),
    /** Structural statement, pinned by tests: navigation never makes access
     * decisions on the client. */
    clientAuthority: z.literal("none"),
    provenance: ProvenanceSchema,
  })
  .strict();

// ── 7. Dashboard priorities ─────────────────────────────────────────────────
export const DashboardPrioritySchema = z
  .object({
    archetype: z.enum(BLUEPRINT_ARCHETYPES),
    /** The business outcomes this role's dashboard serves. */
    outcomes: z.array(LocalizedTextSchema).min(1).max(6),
    /** Prioritized cards, each with WHY it matters for this role (law 7). */
    cards: z
      .array(
        z
          .object({
            key: z.enum(DASHBOARD_CARD_KEYS),
            why: LocalizedTextSchema,
          })
          .strict(),
      )
      .min(1)
      .max(DASHBOARD_CARD_KEYS.length),
    attentionSignals: z.array(z.enum(DASHBOARD_CARD_KEYS)).max(10).default([]),
    decisionsRequired: z.array(z.enum(DASHBOARD_CARD_KEYS)).max(10).default([]),
    exceptions: z.array(z.enum(DASHBOARD_CARD_KEYS)).max(10).default([]),
    timeHorizon: z.enum(TIME_HORIZONS),
    provenance: ProvenanceSchema,
  })
  .strict();

// ── 8. International configuration ──────────────────────────────────────────
export const InternationalSchema = z
  .object({
    /** The country pack this workspace runs under (must exist — law 19). */
    countryPack: z.enum(WORKSPACE_COUNTRIES),
    defaultLocale: z.enum(SUPPORTED_LOCALES),
    currency: z.enum(CURRENCY_CODES as unknown as [string, ...string[]]),
    timezone: z.string().min(1).max(64),
    /** Identity FIELD keys documents carry — configuration, never values. */
    taxIdentityFields: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/))
      .max(5)
      .default([]),
    vatRegistered: z.boolean(),
    provenance: ProvenanceSchema,
  })
  .strict();

// ── 9. Agent relevance ──────────────────────────────────────────────────────
export const AgentRelevanceSchema = z
  .object({
    /** Canonical agent ids ONLY — nothing else parses. */
    agentId: z.enum(AGENT_IDS),
    relevantRoles: z.array(z.enum(BLUEPRINT_ARCHETYPES)).min(1).max(7),
    relevantModules: z.array(z.enum(WORKSPACE_MODULE_KEYS)).max(WORKSPACE_MODULE_KEYS.length),
    /** Requested read domains — validated ⊆ the agent's canonical allow-list
     * (configuration can narrow an agent, never widen it — law 16). */
    readDomains: z.array(z.string().min(1).max(60)).max(10).default([]),
    /** Never "prohibited"; H14 platforms support read_explain only. */
    classifications: z.array(z.enum(ACTION_CLASSES)).min(1).max(ACTION_CLASSES.length),
    /** The one entitlement that can ever enable agents (fail-closed gate). */
    entitlement: z.literal(AI_AGENTS_FEATURE_KEY),
    provenance: ProvenanceSchema,
  })
  .strict();

// ── The blueprint ───────────────────────────────────────────────────────────
export const WorkspaceBlueprintSchema = z
  .object({
    schemaVersion: z.literal(BLUEPRINT_SCHEMA_VERSION),
    profile: BusinessProfileSchema,
    capabilities: CapabilitySelectionSchema,
    terminology: TerminologySchema,
    workflows: z.array(WorkflowSchema).min(1).max(1),
    roles: z.array(RoleConfigSchema).min(1).max(BLUEPRINT_ARCHETYPES.length),
    navigation: NavigationSchema,
    dashboards: z.array(DashboardPrioritySchema).min(1).max(BLUEPRINT_ARCHETYPES.length),
    international: InternationalSchema,
    agents: z.array(AgentRelevanceSchema).max(AGENT_IDS.length).default([]),
  })
  .strict();

export type WorkspaceBlueprint = z.infer<typeof WorkspaceBlueprintSchema>;
export type BusinessProfile = z.infer<typeof BusinessProfileSchema>;
export type CapabilitySelection = z.infer<typeof CapabilitySelectionSchema>;
export type WorkflowConfig = z.infer<typeof WorkflowSchema>;
export type RoleConfig = z.infer<typeof RoleConfigSchema>;
export type DashboardPriority = z.infer<typeof DashboardPrioritySchema>;
export type AgentRelevance = z.infer<typeof AgentRelevanceSchema>;
