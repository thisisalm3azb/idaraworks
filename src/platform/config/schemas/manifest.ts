/**
 * #1 TemplateManifest (doc 09): a template is the full artifact bundle. The
 * schema validates each artifact AND the referential closure between them —
 * "every referenced artifact present and valid → template build fails
 * otherwise" (doc 07 tooling). Shipped templates are validated by a unit test
 * at build time, so a broken template can never reach an org.
 */
import { z } from "zod";
import { CONTAINER_KINDS } from "@/platform/registries";
import { TerminologyOverrideSchema } from "./terminology";
import {
  CategorySetSchema,
  FieldDefinitionSetSchema,
  HolidayCalendarSchema,
  JobPresetSchema,
  ReferencePatternSetSchema,
  RolePresetSetSchema,
  StageTemplateSchema,
  StatusSetSchema,
} from "./artifacts";

export const TemplateManifestSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
    version: z.number().int().min(1),
    object_kind: z.enum(CONTAINER_KINDS),
    terminology: TerminologyOverrideSchema,
    stage_template: StageTemplateSchema,
    status_sets: z.object({ job: StatusSetSchema }).strict(),
    category_sets: z
      .object({
        item: CategorySetSchema,
        expense: CategorySetSchema,
        quote_section: CategorySetSchema,
      })
      .strict(),
    reference_patterns: ReferencePatternSetSchema,
    role_presets: RolePresetSetSchema,
    presets: z.array(JobPresetSchema).min(1),
    /** Per-country holiday calendars; install picks the org's country (F-41). */
    holiday_calendars: z.record(z.string().regex(/^[A-Z]{2}$/), HolidayCalendarSchema),
    /** Custom-field definitions per entity (doc 09 #6; optional — S2). */
    field_definitions: z
      .object({
        job: FieldDefinitionSetSchema.optional(),
        customer: FieldDefinitionSetSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    // Referential closure (doc 09 #1 constraint):
    const stageKeys = new Set(m.stage_template.stages.map((s) => s.stage_key));
    for (const preset of m.presets) {
      for (const skipped of preset.default_skipped_stage_keys) {
        if (!stageKeys.has(skipped)) {
          ctx.addIssue({
            code: "custom",
            message: `preset ${preset.code}: skipped stage "${skipped}" not in stage template`,
          });
        }
      }
      for (const bp of preset.billing_points) {
        if (typeof bp.trigger === "object" && !stageKeys.has(bp.trigger.stage_key)) {
          ctx.addIssue({
            code: "custom",
            message: `preset ${preset.code}: billing trigger stage "${bp.trigger.stage_key}" not in stage template`,
          });
        }
      }
    }
    if (new Set(m.presets.map((p) => p.code)).size !== m.presets.length) {
      ctx.addIssue({ code: "custom", message: "duplicate preset code" });
    }
    for (const [kind, set] of Object.entries(m.category_sets)) {
      if (set.kind !== kind) {
        ctx.addIssue({
          code: "custom",
          message: `category set under "${kind}" has kind "${set.kind}"`,
        });
      }
    }
    if (m.category_sets.expense.categories.some((c) => !c.costing_mapping)) {
      ctx.addIssue({ code: "custom", message: "expense categories need costing_mapping" });
    }
  });

export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;
