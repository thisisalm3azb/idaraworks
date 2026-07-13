/**
 * Template installer (S1; v1 §15 "Template installer = same pipeline as AI
 * proposals"). An install is a SEQUENCE of ordinary applyConfigChange calls —
 * one config_revision per artifact, each individually diffable and undoable.
 * Nothing here has special write powers; a template is just a pre-validated
 * bundle of the same artifacts an org admin could author by hand.
 */
import { randomUUID } from "node:crypto";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { getLimit } from "@/platform/entitlements";
import { applyConfigChange, ConfigGuardError } from "./pipeline";
import { TemplateManifestSchema, type TemplateManifest } from "./schemas/manifest";
import { TEMPLATES } from "./templates/boatbuilding";

export class TemplateInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateInstallError";
  }
}

export function getTemplate(templateKey: string): TemplateManifest {
  const manifest = TEMPLATES[templateKey];
  if (!manifest) throw new TemplateInstallError(`unknown template "${templateKey}"`);
  // Defensive re-validation — shipped templates are build-time validated, but a
  // broken registry entry must fail HERE, not half-way through an install.
  const parsed = TemplateManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new TemplateInstallError(`template "${templateKey}" failed validation`);
  }
  return parsed.data;
}

export type InstallResult = { revisionIds: string[]; presetIds: Record<string, string> };

/** Install a shipped template into the org (owner/admin — config.manage). */
export async function installTemplate(ctx: Ctx, templateKey: string): Promise<InstallResult> {
  const manifest = getTemplate(templateKey);

  // Idempotence guard: an org installs one template once (re-configuration is
  // per-artifact editing; switching templates is a post-MVP migration story).
  const installed = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select value from public.app_settings
      where org_id = ${ctx.orgId} and key = 'config.template'
    `),
  )) as unknown as Array<{ value: unknown }>;
  // jsonb-null = "unset" (an undone install marker) — only a NON-null marker blocks.
  if (installed.length > 0 && installed[0]!.value !== null) {
    throw new ConfigGuardError("config.template", "a template is already installed for this org");
  }

  // Entitlement gate: preset count ≤ limit.presets (doc 09 catalogue).
  const presetLimit = await getLimit(ctx, "limit.presets");
  if (presetLimit !== null && manifest.presets.length > presetLimit) {
    throw new ConfigGuardError(
      "config.template",
      `template ships ${manifest.presets.length} presets; plan allows ${presetLimit}`,
    );
  }

  // Org country picks the holiday calendar (F-41); fall back to the first shipped.
  const orgRows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`select country from public.org where id = ${ctx.orgId}`),
  )) as unknown as Array<{ country: string }>;
  const country = orgRows[0]?.country?.trim() ?? "AE";
  const calendar =
    manifest.holiday_calendars[country] ?? Object.values(manifest.holiday_calendars)[0];

  const revisionIds: string[] = [];
  const apply = async (key: string, value: unknown, what: string) => {
    const { revisionId } = await applyConfigChange(ctx, key, value, {
      summary: `Install ${manifest.key}: ${what}`,
    });
    revisionIds.push(revisionId);
  };

  // Order matters: stage template before presets (preset guards read it).
  await apply("config.stage_template", manifest.stage_template, "stage template");
  await apply("config.status_set.job", manifest.status_sets.job, "job statuses");
  await apply("config.categories.item", manifest.category_sets.item, "item categories");
  await apply("config.categories.expense", manifest.category_sets.expense, "expense categories");
  await apply(
    "config.categories.quote_section",
    manifest.category_sets.quote_section,
    "quote sections",
  );
  await apply("config.reference_patterns", manifest.reference_patterns, "reference patterns");
  await apply("config.roles", manifest.role_presets, "role presets");
  if (calendar) await apply("config.holiday_calendar", calendar, "holiday calendar");
  if (manifest.field_definitions?.job) {
    await apply("config.fields.job", manifest.field_definitions.job, "job custom fields");
  }
  if (manifest.field_definitions?.customer) {
    await apply(
      "config.fields.customer",
      manifest.field_definitions.customer,
      "customer custom fields",
    );
  }
  await apply("terminology.template", manifest.key, "terminology");

  // Retry/reinstall safety (review fix): reuse the EXISTING row's id per preset
  // code, so a repeated install (after a mid-sequence failure, or after undoing
  // the install marker) upserts the same rows instead of colliding on
  // job_preset_org_code_uq with freshly minted ids. Install is a SEQUENCE of
  // independent revisions by design (each undoable); with id-reuse the sequence
  // is idempotent — re-running it converges, never wedges.
  const existing = (await withCtx(ctx, (tx) =>
    tx.execute(sql`select id::text as id, code from public.job_preset where org_id = ${ctx.orgId}`),
  )) as unknown as Array<{ id: string; code: string }>;
  const idByCode = new Map(existing.map((r) => [r.code, r.id]));
  const presetIds: Record<string, string> = {};
  for (const preset of manifest.presets) {
    const id = idByCode.get(preset.code) ?? randomUUID();
    presetIds[preset.code] = id;
    await apply(`preset.${id}`, preset, `preset ${preset.code}`);
  }

  await apply(
    "config.template",
    { key: manifest.key, version: manifest.version },
    "install marker",
  );
  return { revisionIds, presetIds };
}
