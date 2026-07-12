/**
 * S1 config-artifact schemas (doc 09 B: #3 StageTemplate, #4 StatusSet,
 * #5 JobPreset, #10 CategorySet, #11 ReferencePatternSet, #13 RoleAssignmentPreset,
 * #14 HolidayCalendar). Outlines-made-Zod (doc 11 risk note) — every
 * tenant-authored string passes the shared sanitiser; keys are closed catalogs
 * or key-shaped identifiers (D-9.2: keys immutable, labels mutable).
 *
 * Cross-ARTIFACT references (preset.skipped ⊂ stage template, billing stage
 * triggers ⊂ stage keys, item.category ∈ category set) are validated at the
 * pipeline/manifest level (referential closure) — an isolated schema stays pure.
 */
import { z } from "zod";
import {
  MVP_GRANTABLE_ARCHETYPES,
  PHASE_SEMANTICS,
  STATUS_CATEGORIES,
} from "@/platform/registries";
import { configString, MAX_TEXT_LENGTH } from "../sanitize";

/** snake_case config keys — immutable identity, never shown raw to users. */
export const CONFIG_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const configKey = z.string().regex(CONFIG_KEY_RE, "config keys are snake_case, ≤40 chars");

/** Preset codes feed reference patterns — pattern-safe, terse, uppercase. */
export const PRESET_CODE_RE = /^[A-Z0-9]{1,8}$/;

const labels = z.object({ en: configString(), ar: configString() });

// ── #3 StageTemplate ─────────────────────────────────────────────────────────
export const StageTemplateSchema = z
  .object({
    stages: z
      .array(
        z.object({
          stage_key: configKey,
          names: labels,
          weight: z.number().int().min(1).max(100),
          phase_semantic: z.enum(PHASE_SEMANTICS),
        }),
      )
      .min(1),
  })
  .strict()
  .superRefine((v, ctx) => {
    const sum = v.stages.reduce((a, s) => a + s.weight, 0);
    if (sum !== 100) {
      ctx.addIssue({ code: "custom", message: `stage weights must sum to 100 (got ${sum})` });
    }
    if (new Set(v.stages.map((s) => s.stage_key)).size !== v.stages.length) {
      ctx.addIssue({ code: "custom", message: "duplicate stage_key" });
    }
  });
export type StageTemplate = z.infer<typeof StageTemplateSchema>;

// ── #4 StatusSet (MVP entity: job) ───────────────────────────────────────────
// Semantic-anchor rule: a job set must reach draft/active/done/cancelled.
const JOB_REQUIRED_CATEGORIES = ["draft", "active", "done", "cancelled"] as const;

export const StatusSetSchema = z
  .object({
    entity: z.literal("job"), // registry grows in later slices
    statuses: z
      .array(
        z.object({
          status_key: configKey,
          labels,
          semantic_category: z.enum(STATUS_CATEGORIES),
          sort: z.number().int().min(0),
        }),
      )
      .min(1),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.statuses.map((s) => s.status_key)).size !== v.statuses.length) {
      ctx.addIssue({ code: "custom", message: "duplicate status_key" });
    }
    const present = new Set(v.statuses.map((s) => s.semantic_category));
    for (const required of JOB_REQUIRED_CATEGORIES) {
      if (!present.has(required)) {
        ctx.addIssue({
          code: "custom",
          message: `job status set must map semantic category "${required}"`,
        });
      }
    }
  });
export type StatusSet = z.infer<typeof StatusSetSchema>;

// ── #5 JobPreset ─────────────────────────────────────────────────────────────
export const BillingPointSchema = z.object({
  trigger: z.union([z.literal("on_acceptance"), z.object({ stage_key: configKey })]),
  pct: z.number().int().min(1).max(100),
});

export const JobPresetSchema = z
  .object({
    code: z.string().regex(PRESET_CODE_RE, "preset code: 1-8 uppercase letters/digits"),
    names: labels,
    default_skipped_stage_keys: z.array(configKey).default([]),
    billing_points: z.array(BillingPointSchema).min(1),
    description: configString(MAX_TEXT_LENGTH).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const sum = v.billing_points.reduce((a, b) => a + b.pct, 0);
    if (sum !== 100) {
      ctx.addIssue({ code: "custom", message: `billing points must sum to 100% (got ${sum})` });
    }
  });
export type JobPreset = z.infer<typeof JobPresetSchema>;

// ── #10 CategorySet ──────────────────────────────────────────────────────────
export const CATEGORY_KINDS = ["item", "expense", "quote_section"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export const COSTING_MAPPINGS = ["job_materials", "job_other", "overhead"] as const;

export const CategorySetSchema = z
  .object({
    kind: z.enum(CATEGORY_KINDS),
    categories: z
      .array(
        z.object({
          key: configKey,
          labels,
          // The costing spine (doc 08 / audit F-2): REQUIRED on expense sets.
          costing_mapping: z.enum(COSTING_MAPPINGS).optional(),
          retired: z.boolean().default(false), // D-9.2: retire, never delete
        }),
      )
      .min(1),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.categories.map((c) => c.key)).size !== v.categories.length) {
      ctx.addIssue({ code: "custom", message: "duplicate category key" });
    }
    if (v.kind === "expense") {
      for (const c of v.categories) {
        if (!c.costing_mapping) {
          ctx.addIssue({
            code: "custom",
            message: `expense category "${c.key}" needs costing_mapping`,
          });
        }
      }
    }
  });
export type CategorySet = z.infer<typeof CategorySetSchema>;

// ── #11 ReferencePatternSet ──────────────────────────────────────────────────
// Closed token grammar: literal chars + {preset_code} | {year} | {seq:n}.
// S1 documents: job only (serial docs arrive with their slices).
export const REFERENCE_TOKEN_RE = /\{(preset_code|year|seq:\d)\}/g;
const PATTERN_SAFE_RE = /^[A-Za-z0-9{}:_\-/]{1,40}$/;

export const ReferencePatternSchema = z
  .object({
    pattern: z.string().regex(PATTERN_SAFE_RE, "pattern: letters/digits/-/_//{} only"),
    start: z.number().int().min(1).default(1), // paper-continuity starting number
  })
  .strict()
  .superRefine((v, ctx) => {
    const tokens = [...v.pattern.matchAll(REFERENCE_TOKEN_RE)].map((m) => m[1]!);
    const unknownBraces = v.pattern.replace(REFERENCE_TOKEN_RE, "").match(/[{}]/);
    if (unknownBraces) {
      ctx.addIssue({
        code: "custom",
        message: "unknown token — allowed: {preset_code} {year} {seq:n}",
      });
    }
    if (tokens.filter((t) => t.startsWith("seq:")).length !== 1) {
      ctx.addIssue({ code: "custom", message: "pattern needs exactly one {seq:n} token" });
    }
  });

export const ReferencePatternSetSchema = z.object({ job: ReferencePatternSchema }).strict();
export type ReferencePatternSet = z.infer<typeof ReferencePatternSetSchema>;

// ── #13 RoleAssignmentPreset ─────────────────────────────────────────────────
export const RolePresetSchema = z.object({
  key: configKey, // matches role_definition.key (created at org bootstrap)
  archetype: z.enum(MVP_GRANTABLE_ARCHETYPES),
  labels,
  cost_privileged: z.boolean(),
  price_privileged: z.boolean(),
});
export const RolePresetSetSchema = z
  .object({ roles: z.array(RolePresetSchema).min(1).max(12) }) // ≤12 roles/org (doc 06)
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.roles.map((r) => r.key)).size !== v.roles.length) {
      ctx.addIssue({ code: "custom", message: "duplicate role key" });
    }
  });
export type RolePresetSet = z.infer<typeof RolePresetSetSchema>;

// ── #14 HolidayCalendar ──────────────────────────────────────────────────────
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date (YYYY-MM-DD)");
export const HolidayCalendarSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            starts_on: isoDate,
            ends_on: isoDate.optional(),
            label: labels,
            kind: z.enum(["public_holiday", "eid", "org"]),
          })
          .superRefine((e, ctx) => {
            if (e.ends_on && e.ends_on < e.starts_on) {
              ctx.addIssue({ code: "custom", message: "ends_on before starts_on" });
            }
          }),
      )
      .max(100),
    // Ramadan working-hours profile (audit F-41)
    ramadan: z
      .object({ starts_on: isoDate, ends_on: isoDate, daily_hours: z.number().min(1).max(12) })
      .optional(),
  })
  .strict();
export type HolidayCalendar = z.infer<typeof HolidayCalendarSchema>;
