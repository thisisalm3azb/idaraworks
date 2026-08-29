/**
 * The deterministic workspace compiler (H14 Part F).
 *
 * ONE pure function from (approved blueprint, platform snapshot) to the
 * derived workspace configuration. The same inputs at the same compiler
 * version ALWAYS produce the same output — no I/O, no randomness, no clock.
 *
 * The compiler must not (and structurally cannot — it imports no DB, UI, AI
 * or agent-runtime module; pinned by test):
 *  - render UI, modify code or schemas, grant permissions, activate plan
 *    entitlements, call an AI provider, execute agent tools, delete records,
 *    or invent unsupported modules.
 *
 * It INTERSECTS, never grants: every capability decision applies the
 * canonical effective-access equation (./access.ts) over the server-resolved
 * platform snapshot. Client input can never reach the snapshot — the
 * lifecycle builds it from resolveEntitlements.
 */
import { can } from "@/platform/authz";
import { PLATFORM_DEFAULT_TERMS } from "@/platform/terminology/catalogue";
import { TERM_KEYS, type TermKey } from "@/platform/registries";
import { AGENT_IDS, AGENT_TOOL_ALLOW, type AgentId } from "@/platform/agents/registry";
import { AI_AGENTS_FEATURE_KEY } from "@/platform/agents/gate";
import { effectiveCapability } from "./access";
import { blueprintHash } from "./hash";
import { validateBlueprint } from "./validate";
import type { WorkspaceBlueprint } from "./blueprint";
import {
  MODULE_INFO,
  NAV_ITEM_KEYS,
  NAV_ITEM_INFO,
  DASHBOARD_CARD_MODULE,
  COUNTRY_PACKS,
  WORKSPACE_MODULE_KEYS,
  BLUEPRINT_ARCHETYPES,
  type WorkspaceModuleKey,
  type NavItemKey,
  type DashboardCardKey,
  type BlueprintArchetype,
  type CountryPack,
} from "./registry";

export const COMPILER_VERSION = "1.0.0";

/** Server-resolved facts the compiler intersects with. NEVER client input. */
export type PlatformSnapshot = {
  /** Plan entitlement per feature key (resolveEntitlements(ctx).features). */
  entitlements: Record<string, boolean>;
};

export type CompiledCapability = {
  key: WorkspaceModuleKey;
  configEnabled: boolean;
  planEntitled: boolean;
  platformAvailable: boolean;
  /** The equation result for a fully-permitted user (per-user permission is
   * intersected at read time by the consumer via can()). */
  effective: boolean;
  status: "active" | "disabled_by_configuration" | "unentitled" | "unavailable";
  reason: Record<string, string>;
};

export type CompiledWarning = { code: string; subject: string; message: string };

export type CompiledWorkspace = {
  compilerVersion: string;
  compiledFrom: { schemaVersion: number; blueprintHash: string };
  capabilities: CompiledCapability[];
  terminology: Record<
    TermKey,
    { source: "override" | "platform_default"; forms: Record<string, unknown> }
  >;
  workflows: Array<{
    id: "job";
    name: Record<string, string>;
    stageKeys: string[];
    requiredApprovals: Array<{ stageKey: string; approvedBy: BlueprintArchetype }>;
    versioning: "snapshot_on_creation";
  }>;
  navigation: Record<BlueprintArchetype, NavItemKey[]>;
  dashboards: Record<
    BlueprintArchetype,
    {
      cards: Array<{ key: DashboardCardKey; why: Record<string, string> }>;
      attentionSignals: DashboardCardKey[];
      decisionsRequired: DashboardCardKey[];
      timeHorizon: string;
    } | null
  >;
  agents: Array<{
    agentId: AgentId;
    relevant: boolean;
    relevantRoles: BlueprintArchetype[];
    readDomains: string[];
    entitled: boolean;
  }>;
  localization: {
    countryPack: CountryPack;
    defaultLocale: string;
    currency: string;
    timezone: string;
    vatRegistered: boolean;
  };
  explanations: Array<{ section: string; source: string; reason: Record<string, string> }>;
  warnings: CompiledWarning[];
};

export class CompileError extends Error {
  constructor(public readonly issues: Array<{ code: string; path: string; message: string }>) {
    super(`blueprint failed validation: ${issues.length} error(s)`);
    this.name = "CompileError";
  }
}

export function compileBlueprint(raw: unknown, platform: PlatformSnapshot): CompiledWorkspace {
  // Fail closed (law 19): an invalid blueprint never compiles.
  const validation = validateBlueprint(raw);
  if (!validation.ok || !validation.blueprint) throw new CompileError(validation.errors);
  const bp: WorkspaceBlueprint = validation.blueprint;
  const warnings: CompiledWarning[] = validation.warnings.map((w) => ({
    code: w.code,
    subject: w.path,
    message: w.message,
  }));

  // ── Capabilities: the equation, module by module ──────────────────────────
  const configEnabledByKey = new Map<WorkspaceModuleKey, boolean>();
  const reasonByKey = new Map<WorkspaceModuleKey, Record<string, string>>();
  for (const m of bp.capabilities.modules) {
    configEnabledByKey.set(m.key, m.enabled);
    reasonByKey.set(m.key, m.reason);
  }
  const capabilities: CompiledCapability[] = WORKSPACE_MODULE_KEYS.map((key) => {
    const info = MODULE_INFO[key];
    const platformAvailable = info.availability === "shipped";
    const planEntitled = platform.entitlements[info.entitlement] === true;
    const configEnabled = configEnabledByKey.get(key) ?? false;
    const effective = effectiveCapability({
      platformAvailable,
      planEntitled,
      configEnabled,
      userPermitted: true, // per-user layer intersects at read time via can()
    });
    const status: CompiledCapability["status"] = !platformAvailable
      ? "unavailable"
      : !configEnabled
        ? "disabled_by_configuration"
        : !planEntitled
          ? "unentitled"
          : "active";
    if (status === "unentitled") {
      warnings.push({
        code: "unentitled_capability",
        subject: key,
        message: `${key} is configured on but the plan does not include it — it stays inaccessible until the plan covers it`,
      });
    }
    return {
      key,
      configEnabled,
      planEntitled,
      platformAvailable,
      effective,
      status,
      reason: reasonByKey.get(key) ?? {},
    };
  });
  const activeModules = new Set(
    capabilities.filter((c) => c.status === "active").map((c) => c.key),
  );

  // ── Terminology: canonical identity, override or platform default ─────────
  const terminology = {} as CompiledWorkspace["terminology"];
  for (const key of TERM_KEYS) {
    const override = bp.terminology.overrides[key];
    terminology[key] = override
      ? { source: "override", forms: override }
      : { source: "platform_default", forms: PLATFORM_DEFAULT_TERMS[key] };
  }

  // ── Workflows: references only — never a data migration (law 14) ──────────
  const workflows = bp.workflows.map((wf) => ({
    id: wf.id,
    name: wf.name,
    stageKeys: wf.stages.map((s) => s.key),
    requiredApprovals: wf.requiredApprovals,
    versioning: wf.versioning,
  }));

  // ── Navigation per role: order ∪ canon, minus hidden, ∩ can() ∩ modules ───
  const hidden = new Set(bp.navigation.hidden);
  const orderedKeys: NavItemKey[] = [
    ...bp.navigation.order,
    ...NAV_ITEM_KEYS.filter((k) => !bp.navigation.order.includes(k)),
  ];
  const roleNavPref = new Map<BlueprintArchetype, Set<NavItemKey>>();
  for (const role of bp.roles) {
    if (role.navVisibility.length > 0) {
      roleNavPref.set(role.archetype, new Set(role.navVisibility));
    }
  }
  const navigation = {} as CompiledWorkspace["navigation"];
  for (const archetype of BLUEPRINT_ARCHETYPES) {
    const pref = roleNavPref.get(archetype);
    navigation[archetype] = orderedKeys.filter((key) => {
      const info = NAV_ITEM_INFO[key];
      // Authority first (law 6): can() decides existence, always.
      if (info.action !== null && !can(archetype, info.action)) return false;
      // Modules disabled by configuration disappear from navigation…
      if (info.module !== null && !info.alwaysVisible && !activeModules.has(info.module)) {
        return false;
      }
      // …then presentation-only hiding applies (never on safety rails).
      if (hidden.has(key) && !info.alwaysVisible) return false;
      if (pref && !pref.has(key) && !info.alwaysVisible) return false;
      return true;
    });
  }

  // ── Dashboards per role: priorities filtered to live modules ──────────────
  const dashboards = {} as CompiledWorkspace["dashboards"];
  for (const archetype of BLUEPRINT_ARCHETYPES) dashboards[archetype] = null;
  for (const dash of bp.dashboards) {
    const liveCard = (key: DashboardCardKey) => {
      const mod = DASHBOARD_CARD_MODULE[key];
      return mod === null || activeModules.has(mod);
    };
    dashboards[dash.archetype] = {
      cards: dash.cards.filter((c) => liveCard(c.key)),
      attentionSignals: dash.attentionSignals.filter(liveCard),
      decisionsRequired: dash.decisionsRequired.filter(liveCard),
      timeHorizon: dash.timeHorizon,
    };
  }

  // ── Agents: relevance without authority (law 16) ──────────────────────────
  const agentsEntitled = platform.entitlements[AI_AGENTS_FEATURE_KEY] === true;
  const configured = new Map(bp.agents.map((a) => [a.agentId, a]));
  const agents = AGENT_IDS.map((agentId) => {
    const cfg = configured.get(agentId);
    if (!cfg) {
      return { agentId, relevant: false, relevantRoles: [], readDomains: [], entitled: false };
    }
    // Narrowing only: configured domains ∩ the canonical allow-list.
    const allow = AGENT_TOOL_ALLOW[agentId] as readonly string[];
    const readDomains =
      cfg.readDomains.length > 0 ? cfg.readDomains.filter((d) => allow.includes(d)) : [...allow];
    const relevantModules = cfg.relevantModules.filter((m) => activeModules.has(m));
    const relevant = relevantModules.length > 0 || cfg.relevantModules.length === 0;
    return {
      agentId,
      relevant,
      relevantRoles: cfg.relevantRoles,
      readDomains,
      entitled: agentsEntitled,
    };
  });
  if (bp.agents.length > 0 && !agentsEntitled) {
    warnings.push({
      code: "agents_unentitled",
      subject: "agents",
      message:
        "agent relevance is configured but the agents entitlement is not active — agents remain disabled",
    });
  }

  // ── Localization ──────────────────────────────────────────────────────────
  const localization = {
    countryPack: COUNTRY_PACKS[bp.international.countryPack],
    defaultLocale: bp.international.defaultLocale,
    currency: bp.international.currency,
    timezone: bp.international.timezone,
    vatRegistered: bp.international.vatRegistered,
  };

  // ── Explanations: provenance carried through (law 7) ──────────────────────
  const explanations = [
    { section: "profile", ...prov(bp.profile.provenance) },
    { section: "capabilities", ...prov(bp.capabilities.provenance) },
    { section: "terminology", ...prov(bp.terminology.provenance) },
    ...bp.workflows.map((w) => ({ section: `workflow:${w.id}`, ...prov(w.provenance) })),
    ...bp.roles.map((r) => ({ section: `role:${r.archetype}`, ...prov(r.provenance) })),
    { section: "navigation", ...prov(bp.navigation.provenance) },
    ...bp.dashboards.map((d) => ({ section: `dashboard:${d.archetype}`, ...prov(d.provenance) })),
    { section: "international", ...prov(bp.international.provenance) },
    ...bp.agents.map((a) => ({ section: `agent:${a.agentId}`, ...prov(a.provenance) })),
  ];

  return {
    compilerVersion: COMPILER_VERSION,
    compiledFrom: { schemaVersion: bp.schemaVersion, blueprintHash: blueprintHash(bp) },
    capabilities,
    terminology,
    workflows,
    navigation,
    dashboards,
    agents,
    localization,
    explanations,
    warnings,
  };
}

function prov(p: { source: string; reason: Record<string, string> }) {
  return { source: p.source, reason: p.reason };
}
