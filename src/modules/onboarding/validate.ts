/**
 * S8 ConfigProposal validator (doc 09 #12 proposal-level rules + F-28).
 *
 * PURE (no DB): validates the STRUCTURE + safety of a proposal so the same checks run in the
 * builder, the API, and unit tests. Three proposal-level rules beyond per-artifact schema
 * validation:
 *   (a) F-28 — an AI/operator-proposed `auto_approve_below` is capped at 2× the template
 *       default; a value above the cap is REJECTED (never silently clamped).
 *   (b) no permission grants beyond preset bounds — a `config.roles` artifact may only assign
 *       actions the template's role presets already contain (onboarding cannot widen authz).
 *   (c) referential closure — an override artifact validates against its own schema; cross-
 *       artifact references (preset→stage, category kinds) are enforced by those schemas.
 * Entitlement closure (a capability outside the plan → requires_upgrade, never applied) needs
 * the org's resolved plan and is enforced in the service (assertEntitlementClosure).
 */
import type { z } from "zod";
import {
  StageTemplateSchema,
  StatusSetSchema,
  CategorySetSchema,
  ReferencePatternSetSchema,
  RolePresetSetSchema,
  HolidayCalendarSchema,
  FieldDefinitionSetSchema,
  TEMPLATE_BOATBUILDING,
} from "@/platform/config";
import {
  ConfigProposalSchema,
  TEMPLATE_APPROVAL_DEFAULT_MINOR,
  F28_CAP_MULTIPLE,
  type ConfigProposal,
} from "./proposal";

// Per-artifact-key schema map (mirrors the config pipeline's FIXED_HANDLERS).
const ARTIFACT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  "config.stage_template": StageTemplateSchema,
  "config.status_set.job": StatusSetSchema,
  "config.categories.item": CategorySetSchema,
  "config.categories.expense": CategorySetSchema,
  "config.categories.quote_section": CategorySetSchema,
  "config.reference_patterns": ReferencePatternSetSchema,
  "config.roles": RolePresetSetSchema,
  "config.holiday_calendar": HolidayCalendarSchema,
  "config.fields.job": FieldDefinitionSetSchema,
  "config.fields.customer": FieldDefinitionSetSchema,
};

/** The union of every action any template role preset grants — the authz ceiling (rule b). */
function templateAllowedActions(): Set<string> {
  const allowed = new Set<string>();
  const roles = (TEMPLATE_BOATBUILDING.role_presets as { roles?: Array<{ actions?: string[] }> })
    .roles;
  for (const r of roles ?? []) for (const a of r.actions ?? []) allowed.add(a);
  return allowed;
}

export type ProposalValidation = { ok: boolean; errors: string[] };

export function validateProposal(raw: unknown): ProposalValidation {
  const parsed = ConfigProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 12).map((i) => `proposal.${i.path.join(".")}: ${i.message}`) };
  }
  const proposal: ConfigProposal = parsed.data;
  const errors: string[] = [];

  // Per-artifact schema validation.
  const seenKeys = new Set<string>();
  for (const art of proposal.artifacts) {
    if (seenKeys.has(art.key)) errors.push(`duplicate artifact "${art.key}"`);
    seenKeys.add(art.key);
    // Install markers are never applied via a proposal override (install lays them down).
    if (art.key === "config.template" || art.key === "terminology.template") continue;
    const schema = ARTIFACT_SCHEMAS[art.key];
    if (!schema) {
      errors.push(`artifact "${art.key}" has no schema (unknown config artifact)`);
      continue;
    }
    const r = schema.safeParse(art.value);
    if (!r.success) {
      for (const i of r.error.issues.slice(0, 6)) errors.push(`${art.key}.${i.path.join(".")}: ${i.message}`);
    }
    // Category kind must match the key suffix (mirror the pipeline guard).
    const cat = art.key.match(/^config\.categories\.(item|expense|quote_section)$/);
    if (cat && (art.value as { kind?: string })?.kind !== cat[1]) {
      errors.push(`${art.key}: category set kind must be "${cat[1]}"`);
    }
  }

  // Rule (b): no permission grants beyond preset bounds.
  const rolesArt = proposal.artifacts.find((a) => a.key === "config.roles");
  if (rolesArt) {
    const allowed = templateAllowedActions();
    const roles = (rolesArt.value as { roles?: Array<{ key?: string; actions?: string[] }> }).roles;
    for (const role of roles ?? []) {
      for (const action of role.actions ?? []) {
        if (!allowed.has(action)) {
          errors.push(
            `config.roles: role "${role.key}" grants "${action}" beyond the template preset bounds (F-preset)`,
          );
        }
      }
    }
  }

  // Rule (a): F-28 auto-approve cap.
  for (const d of proposal.approval_defaults) {
    const base = TEMPLATE_APPROVAL_DEFAULT_MINOR[d.subject_type];
    const cap = base * F28_CAP_MULTIPLE;
    if (d.auto_approve_below_minor > cap) {
      errors.push(
        `approval_defaults: ${d.subject_type} auto_approve_below ${d.auto_approve_below_minor} exceeds the F-28 cap ${cap} (2× template default ${base}) — rejected, not clamped`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
