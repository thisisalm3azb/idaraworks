/**
 * Blueprint validation (H14 Part E "Validation produces structured errors and
 * warnings"). Pure — no I/O; the DB lifecycle stores this result on the
 * revision. Fail closed (law 19): a blueprint with ANY error can never be
 * approved or applied.
 *
 * Errors are violations of platform truth or of the Intelligent Clay laws;
 * warnings are honest signals (unentitled-but-configured, unusual choices)
 * that a human should see at review.
 */
import { MATRIX, type Action } from "@/platform/authz";
import { can } from "@/platform/authz";
import { AGENT_TOOL_ALLOW, isAgentToolId, A1_SUPPORTED_CLASSES } from "@/platform/agents/registry";
import { WorkspaceBlueprintSchema, type WorkspaceBlueprint } from "./blueprint";
import {
  MODULE_INFO,
  NAV_ITEM_INFO,
  DASHBOARD_CARD_MODULE,
  COUNTRY_PACKS,
  isWorkspaceCountry,
  type WorkspaceModuleKey,
} from "./registry";

export type BlueprintIssue = {
  code: string;
  path: string;
  message: string;
};

export type BlueprintValidation = {
  ok: boolean;
  errors: BlueprintIssue[];
  warnings: BlueprintIssue[];
};

export function validateBlueprint(raw: unknown): BlueprintValidation & {
  blueprint: WorkspaceBlueprint | null;
} {
  const errors: BlueprintIssue[] = [];
  const warnings: BlueprintIssue[] = [];

  const parsed = WorkspaceBlueprintSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 25)) {
      errors.push({ code: "schema", path: issue.path.join("."), message: issue.message });
    }
    return { ok: false, errors, warnings, blueprint: null };
  }
  const bp = parsed.data;

  // ── Capabilities: coverage, duplicates, dependencies ──────────────────────
  const seenModules = new Set<string>();
  const enabled = new Set<WorkspaceModuleKey>();
  for (const [i, m] of bp.capabilities.modules.entries()) {
    if (seenModules.has(m.key)) {
      errors.push({
        code: "duplicate_module",
        path: `capabilities.modules.${i}`,
        message: `module ${m.key} listed twice`,
      });
    }
    seenModules.add(m.key);
    if (m.enabled) enabled.add(m.key);
  }
  for (const key of enabled) {
    for (const dep of MODULE_INFO[key].requires) {
      if (!enabled.has(dep)) {
        errors.push({
          code: "missing_dependency",
          path: "capabilities.modules",
          message: `${key} requires ${dep}, which is not enabled`,
        });
      }
    }
    for (const rec of MODULE_INFO[key].recommends) {
      if (!enabled.has(rec)) {
        warnings.push({
          code: "missing_recommendation",
          path: "capabilities.modules",
          message: `${key} usually pairs with ${rec}, which is not enabled`,
        });
      }
    }
  }

  // ── Workflows: stage integrity, transitions, approvals ────────────────────
  for (const [wi, wf] of bp.workflows.entries()) {
    const stageKeys = new Set(wf.stages.map((s) => s.key));
    if (stageKeys.size !== wf.stages.length) {
      errors.push({
        code: "duplicate_stage",
        path: `workflows.${wi}.stages`,
        message: "duplicate stage key",
      });
    }
    const weightSum = wf.stages.reduce((n, s) => n + s.weight, 0);
    if (weightSum !== 100) {
      errors.push({
        code: "stage_weights",
        path: `workflows.${wi}.stages`,
        message: `stage weights must sum to 100 (got ${weightSum})`,
      });
    }
    for (const [ti, t] of [...wf.transitions, ...wf.exceptionPaths].entries()) {
      if (!stageKeys.has(t.from) || !stageKeys.has(t.to)) {
        errors.push({
          code: "invalid_transition",
          path: `workflows.${wi}.transitions.${ti}`,
          message: `transition references unknown stage "${!stageKeys.has(t.from) ? t.from : t.to}"`,
        });
      } else if (t.from === t.to) {
        errors.push({
          code: "invalid_transition",
          path: `workflows.${wi}.transitions.${ti}`,
          message: "a stage cannot transition to itself",
        });
      }
    }
    for (const [ai, a] of wf.requiredApprovals.entries()) {
      if (!stageKeys.has(a.stageKey)) {
        errors.push({
          code: "invalid_approval",
          path: `workflows.${wi}.requiredApprovals.${ai}`,
          message: `approval references unknown stage "${a.stageKey}"`,
        });
      }
      if (!can(a.approvedBy, "approvals.decide")) {
        errors.push({
          code: "approver_without_authority",
          path: `workflows.${wi}.requiredApprovals.${ai}`,
          message: `${a.approvedBy} cannot decide approvals (authz matrix)`,
        });
      }
    }
    for (const [ri, r] of wf.responsibilities.entries()) {
      if (!stageKeys.has(r.stageKey)) {
        errors.push({
          code: "invalid_responsibility",
          path: `workflows.${wi}.responsibilities.${ri}`,
          message: `responsibility references unknown stage "${r.stageKey}"`,
        });
      }
    }
  }

  // ── Roles: no escalation, no duplicates ───────────────────────────────────
  const seenArchetypes = new Set<string>();
  for (const [ri, role] of bp.roles.entries()) {
    if (seenArchetypes.has(role.archetype)) {
      errors.push({
        code: "duplicate_role",
        path: `roles.${ri}`,
        message: `archetype ${role.archetype} configured twice`,
      });
    }
    seenArchetypes.add(role.archetype);
    for (const ref of role.permissionRefs) {
      if (!(ref in MATRIX)) {
        errors.push({
          code: "unknown_permission",
          path: `roles.${ri}.permissionRefs`,
          message: `unknown authz action "${ref}"`,
        });
      } else if (!can(role.archetype, ref as Action)) {
        // Law 5: a blueprint can never claim authority the archetype lacks.
        errors.push({
          code: "permission_escalation",
          path: `roles.${ri}.permissionRefs`,
          message: `${role.archetype} does not hold "${ref}" — configuration cannot grant it`,
        });
      }
    }
    if (role.approvalAuthority && !can(role.archetype, "approvals.decide")) {
      errors.push({
        code: "permission_escalation",
        path: `roles.${ri}.approvalAuthority`,
        message: `${role.archetype} cannot decide approvals — configuration cannot grant it`,
      });
    }
  }

  // ── Navigation: presentation only, safety rails stay ──────────────────────
  for (const key of bp.navigation.hidden) {
    if (NAV_ITEM_INFO[key].alwaysVisible) {
      errors.push({
        code: "hidden_safety_rail",
        path: "navigation.hidden",
        message: `"${key}" cannot be hidden`,
      });
    }
  }
  const orderSet = new Set(bp.navigation.order);
  if (orderSet.size !== bp.navigation.order.length) {
    errors.push({
      code: "duplicate_nav_item",
      path: "navigation.order",
      message: "duplicate item",
    });
  }
  for (const key of bp.navigation.hidden) {
    const mod = NAV_ITEM_INFO[key].module;
    if (mod && enabled.has(mod)) {
      warnings.push({
        code: "hidden_enabled_module",
        path: "navigation.hidden",
        message: `"${key}" is hidden although its module ${mod} is enabled`,
      });
    }
  }

  // ── Dashboards: card/module coherence, one per role ───────────────────────
  const seenDash = new Set<string>();
  for (const [di, dash] of bp.dashboards.entries()) {
    if (seenDash.has(dash.archetype)) {
      errors.push({
        code: "duplicate_dashboard",
        path: `dashboards.${di}`,
        message: `dashboard for ${dash.archetype} configured twice`,
      });
    }
    seenDash.add(dash.archetype);
    const cardKeys = new Set(dash.cards.map((c) => c.key));
    if (cardKeys.size !== dash.cards.length) {
      errors.push({
        code: "duplicate_card",
        path: `dashboards.${di}.cards`,
        message: "duplicate card key",
      });
    }
    for (const c of dash.cards) {
      const mod = DASHBOARD_CARD_MODULE[c.key];
      if (mod && !enabled.has(mod)) {
        warnings.push({
          code: "card_module_disabled",
          path: `dashboards.${di}.cards`,
          message: `card "${c.key}" depends on ${mod}, which is not enabled`,
        });
      }
    }
  }

  // ── International: the pack must exist (law 19 — fail closed) ─────────────
  if (!isWorkspaceCountry(bp.international.countryPack)) {
    errors.push({
      code: "missing_country_pack",
      path: "international.countryPack",
      message: `no country pack for "${bp.international.countryPack}"`,
    });
  } else {
    const pack = COUNTRY_PACKS[bp.international.countryPack];
    for (const field of bp.international.taxIdentityFields) {
      if (!pack.taxIdentityFields.some((f) => f.key === field)) {
        errors.push({
          code: "unknown_tax_field",
          path: "international.taxIdentityFields",
          message: `"${field}" is not a tax identity field of the ${pack.country} pack`,
        });
      }
    }
    if (bp.international.currency !== pack.defaultCurrency) {
      warnings.push({
        code: "non_default_currency",
        path: "international.currency",
        message: `currency ${bp.international.currency} differs from the ${pack.country} pack default (${pack.defaultCurrency}) — allowed, and kept separate from country`,
      });
    }
  }

  // ── Agents: bounded, never widened (law 16) ───────────────────────────────
  const seenAgents = new Set<string>();
  for (const [ai, agent] of bp.agents.entries()) {
    if (seenAgents.has(agent.agentId)) {
      errors.push({
        code: "duplicate_agent",
        path: `agents.${ai}`,
        message: `agent ${agent.agentId} configured twice`,
      });
    }
    seenAgents.add(agent.agentId);
    const allow = AGENT_TOOL_ALLOW[agent.agentId];
    for (const domain of agent.readDomains) {
      if (!isAgentToolId(domain) || !(allow as readonly string[]).includes(domain)) {
        errors.push({
          code: "agent_domain_widening",
          path: `agents.${ai}.readDomains`,
          message: `"${domain}" is not on the ${agent.agentId} allow-list — configuration can narrow an agent, never widen it`,
        });
      }
    }
    for (const cls of agent.classifications) {
      if (cls === "prohibited") {
        errors.push({
          code: "prohibited_classification",
          path: `agents.${ai}.classifications`,
          message: "the prohibited class can never be configured as available",
        });
      } else if (!(A1_SUPPORTED_CLASSES as readonly string[]).includes(cls)) {
        warnings.push({
          code: "unsupported_classification",
          path: `agents.${ai}.classifications`,
          message: `classification "${cls}" is not runtime-supported yet — it stays inert until the platform ships it`,
        });
      }
    }
    for (const mod of agent.relevantModules) {
      if (!enabled.has(mod)) {
        warnings.push({
          code: "agent_module_disabled",
          path: `agents.${ai}.relevantModules`,
          message: `agent ${agent.agentId} references ${mod}, which is not enabled`,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, blueprint: errors.length === 0 ? bp : null };
}
