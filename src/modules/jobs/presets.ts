/**
 * Work templates a company can edit (item 9, 2026-09-20).
 *
 * Two things make up a work template in this product:
 *   1. the organisation's STAGE TEMPLATE — the ordered activities every unit of
 *      work moves through (config artifact `config.stage_template`, versioned
 *      through the config pipeline with undo);
 *   2. the PRESETS — named starting points (`job_preset`) that pick which of
 *      those stages apply and how billing is split.
 *
 * Document layout templates (Document Studio) are a different thing and are
 * not touched here.
 *
 * Existing work is never changed by editing a template: a job snapshots its
 * stages when it is created (createJobFromPreset), and the pipeline's guard
 * refuses to drop a stage a live preset still references.
 */
import { z } from "zod";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import { command } from "@/platform/audit";
import type { RoleArchetype } from "@/platform/registries";
import { applyConfigChange, getInstalledTemplate } from "@/platform/config";
import {
  JobPresetSchema,
  StageTemplateSchema,
  type JobPreset,
  type StageTemplate,
} from "@/platform/config/schemas/artifacts";
import { PHASE_SEMANTICS } from "@/platform/registries";

export type StageRow = StageTemplate["stages"][number];

export class PresetError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid" | "not_found" | "duplicate_code" | "no_stages",
  ) {
    super(message);
    this.name = "PresetError";
  }
}

/** A stable snake_case key from an English name: "Growing & Care" → "growing_care". */
export function stageKeyFrom(labelEn: string, taken: Set<string>): string {
  let base = labelEn
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 34);
  if (!/^[a-z]/.test(base)) base = `s_${base}`;
  if (base.length < 2) base = "stage";
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base.slice(0, 31)}_${n++}`;
  return key;
}

/** Spread weights so they sum to exactly 100, keeping proportions. */
export function normaliseWeights(stages: StageRow[]): StageRow[] {
  if (stages.length === 0) return stages;
  const total = stages.reduce((a, s) => a + Math.max(1, s.weight), 0);
  const scaled = stages.map((s) => Math.max(1, Math.round((Math.max(1, s.weight) / total) * 100)));
  let diff = 100 - scaled.reduce((a, b) => a + b, 0);
  // Fix rounding on the largest stage so small ones never drop to zero.
  const order = scaled.map((w, i) => [w, i] as const).sort((a, b) => b[0] - a[0]);
  let k = 0;
  while (diff !== 0 && k < 1000) {
    const idx = order[k % order.length]![1];
    const step = diff > 0 ? 1 : -1;
    if (scaled[idx]! + step >= 1) {
      scaled[idx]! += step;
      diff -= step;
    }
    k++;
  }
  return stages.map((s, i) => ({ ...s, weight: scaled[i]! }));
}

// ── stage template ────────────────────────────────────────────────────────────

export async function readStageTemplate(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<StageTemplate> {
  assertCan(archetype, "config.view");
  const rows = await withCtx(
    ctx,
    async (tx) =>
      (await tx.execute(sql`
      select value from public.app_settings where org_id = ${ctx.orgId} and key = 'config.stage_template'
    `)) as unknown as Array<{ value: unknown }>,
  );
  const parsed = StageTemplateSchema.safeParse(rows[0]?.value);
  return parsed.success ? parsed.data : { stages: [] };
}

export const StageEditInput = z.object({
  stageKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .optional(),
  nameEn: z.string().trim().min(1).max(60),
  nameAr: z.string().trim().min(1).max(60),
  weight: z.coerce.number().int().min(1).max(100),
  phase: z.enum(PHASE_SEMANTICS),
});

/** Add a stage at the end (weights are re-spread to keep the 100% rule). */
export async function addStage(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ stageKey: string }> {
  assertCan(archetype, "config.manage");
  const input = StageEditInput.parse(raw);
  let key = "";
  await applyConfigChange(
    ctx,
    "config.stage_template",
    (before: unknown) => {
      const cur = StageTemplateSchema.safeParse(before);
      const stages = cur.success ? [...cur.data.stages] : [];
      key = stageKeyFrom(input.nameEn, new Set(stages.map((s) => s.stage_key)));
      stages.push({
        stage_key: key,
        names: { en: input.nameEn, ar: input.nameAr },
        weight: input.weight,
        phase_semantic: input.phase,
      });
      return { stages: normaliseWeights(stages) };
    },
    { summary: `Added stage "${input.nameEn}"` },
  );
  return { stageKey: key };
}

/** Rename / re-weight / re-phase one stage (its key never changes). */
export async function updateStage(ctx: Ctx, archetype: RoleArchetype, raw: unknown): Promise<void> {
  assertCan(archetype, "config.manage");
  const input = StageEditInput.parse(raw);
  if (!input.stageKey) throw new PresetError("stage key required", "invalid");
  await applyConfigChange(
    ctx,
    "config.stage_template",
    (before: unknown) => {
      const cur = StageTemplateSchema.safeParse(before);
      const stages = cur.success ? [...cur.data.stages] : [];
      const i = stages.findIndex((s) => s.stage_key === input.stageKey);
      if (i < 0) throw new PresetError("stage not found", "not_found");
      stages[i] = {
        ...stages[i]!,
        names: { en: input.nameEn, ar: input.nameAr },
        weight: input.weight,
        phase_semantic: input.phase,
      };
      return { stages: normaliseWeights(stages) };
    },
    { summary: `Updated stage "${input.nameEn}"` },
  );
}

export async function moveStage(
  ctx: Ctx,
  archetype: RoleArchetype,
  stageKey: string,
  direction: "up" | "down",
): Promise<void> {
  assertCan(archetype, "config.manage");
  await applyConfigChange(
    ctx,
    "config.stage_template",
    (before: unknown) => {
      const cur = StageTemplateSchema.safeParse(before);
      const stages = cur.success ? [...cur.data.stages] : [];
      const i = stages.findIndex((s) => s.stage_key === stageKey);
      if (i < 0) throw new PresetError("stage not found", "not_found");
      const j = direction === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= stages.length) return { stages };
      [stages[i], stages[j]] = [stages[j]!, stages[i]!];
      return { stages };
    },
    { summary: `Moved stage "${stageKey}" ${direction}` },
  );
}

/** Remove a stage. The pipeline guard refuses when a live preset still references it. */
export async function removeStage(
  ctx: Ctx,
  archetype: RoleArchetype,
  stageKey: string,
): Promise<void> {
  assertCan(archetype, "config.manage");
  await applyConfigChange(
    ctx,
    "config.stage_template",
    (before: unknown) => {
      const cur = StageTemplateSchema.safeParse(before);
      const stages = cur.success ? cur.data.stages.filter((s) => s.stage_key !== stageKey) : [];
      if (stages.length === 0)
        throw new PresetError("a template needs at least one stage", "no_stages");
      return { stages: normaliseWeights(stages) };
    },
    { summary: `Removed stage "${stageKey}"` },
  );
}

// ── presets ───────────────────────────────────────────────────────────────────

export type PresetView = {
  id: string;
  code: string;
  names: { en: string; ar: string };
  description: string | null;
  defaultSkippedStageKeys: string[];
  billingPoints: JobPreset["billing_points"];
  retiredAt: string | null;
};

export async function listPresets(ctx: Ctx, archetype: RoleArchetype): Promise<PresetView[]> {
  assertCan(archetype, "config.view");
  const rows = await withCtx(
    ctx,
    async (tx) =>
      (await tx.execute(sql`
      select id::text as id, code, names, description, default_skipped_stage_keys, billing_points,
             retired_at::text as retired_at
      from public.job_preset where org_id = ${ctx.orgId}
      order by retired_at nulls first, code
    `)) as unknown as Array<{
        id: string;
        code: string;
        names: { en: string; ar: string };
        description: string | null;
        default_skipped_stage_keys: string[];
        billing_points: JobPreset["billing_points"];
        retired_at: string | null;
      }>,
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    names: r.names,
    description: r.description,
    defaultSkippedStageKeys: r.default_skipped_stage_keys ?? [],
    billingPoints: r.billing_points ?? [],
    retiredAt: r.retired_at,
  }));
}

export const PresetCreateInput = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,8}$/),
  nameEn: z.string().trim().min(1).max(60),
  nameAr: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).optional(),
  skippedStageKeys: z.array(z.string()).default([]),
});

export async function createPreset(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "config.manage");
  const input = PresetCreateInput.parse(raw);
  const tpl = await readStageTemplate(ctx, archetype);
  const known = new Set(tpl.stages.map((s) => s.stage_key));
  const skipped = input.skippedStageKeys.filter((k) => known.has(k));
  if (skipped.length >= tpl.stages.length && tpl.stages.length > 0) {
    throw new PresetError("a preset must keep at least one stage", "invalid");
  }
  // New presets bill 100% on acceptance until the company decides otherwise —
  // the one split that needs no stage to exist.
  const preset = JobPresetSchema.parse({
    code: input.code,
    names: { en: input.nameEn, ar: input.nameAr },
    default_skipped_stage_keys: skipped,
    billing_points: [{ trigger: "on_acceptance", pct: 100 }],
    description: input.description || undefined,
  });
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "preset.create",
        entityType: "config",
        entityId: r.id,
        summary: `Created work template ${preset.code} (${preset.names.en})`,
      }),
    },
    async (tx) => {
      const dup = (await tx.execute(sql`
        select 1 as one from public.job_preset where org_id = ${ctx.orgId} and code = ${preset.code}
      `)) as unknown as Array<{ one: number }>;
      if (dup.length)
        throw new PresetError("a template with this code already exists", "duplicate_code");
      const rows = (await tx.execute(sql`
        insert into public.job_preset (org_id, code, names, default_skipped_stage_keys, billing_points, description)
        values (${ctx.orgId}, ${preset.code}, ${JSON.stringify(preset.names)}::jsonb,
                ${JSON.stringify(preset.default_skipped_stage_keys)}::jsonb,
                ${JSON.stringify(preset.billing_points)}::jsonb, ${preset.description ?? null})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export const PresetUpdateInput = z.object({
  id: z.string().uuid(),
  nameEn: z.string().trim().min(1).max(60),
  nameAr: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).optional(),
  skippedStageKeys: z.array(z.string()).default([]),
});

export async function updatePreset(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "config.manage");
  const input = PresetUpdateInput.parse(raw);
  const tpl = await readStageTemplate(ctx, archetype);
  const known = new Set(tpl.stages.map((s) => s.stage_key));
  const skipped = input.skippedStageKeys.filter((k) => known.has(k));
  if (skipped.length >= tpl.stages.length && tpl.stages.length > 0) {
    throw new PresetError("a preset must keep at least one stage", "invalid");
  }
  await command(
    ctx,
    {
      audit: {
        action: "preset.update",
        entityType: "config",
        entityId: input.id,
        summary: `Updated work template (${input.nameEn})`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.job_preset
        set names = ${JSON.stringify({ en: input.nameEn, ar: input.nameAr })}::jsonb,
            description = ${input.description || null},
            default_skipped_stage_keys = ${JSON.stringify(skipped)}::jsonb,
            updated_at = now()
        where id = ${input.id} and org_id = ${ctx.orgId} and retired_at is null
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new PresetError("template not found", "not_found");
    },
  );
}

/** Retire a template: new work can no longer start from it; existing work is untouched. */
export async function retirePreset(ctx: Ctx, archetype: RoleArchetype, id: string): Promise<void> {
  assertCan(archetype, "config.manage");
  await command(
    ctx,
    {
      audit: {
        action: "preset.retire",
        entityType: "config",
        entityId: id,
        summary: "Retired a work template",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.job_preset set retired_at = now(), updated_at = now()
        where id = ${id} and org_id = ${ctx.orgId} and retired_at is null
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new PresetError("template not found", "not_found");
    },
  );
}

export async function restorePreset(ctx: Ctx, archetype: RoleArchetype, id: string): Promise<void> {
  assertCan(archetype, "config.manage");
  await command(
    ctx,
    {
      audit: {
        action: "preset.restore",
        entityType: "config",
        entityId: id,
        summary: "Restored a work template",
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.job_preset set retired_at = null, updated_at = now()
        where id = ${id} and org_id = ${ctx.orgId} and retired_at is not null
      `);
    },
  );
}

/** The installed template key, for the page header ("based on Agriculture"). */
export async function installedTemplateKey(ctx: Ctx): Promise<string | null> {
  const t = await getInstalledTemplate(ctx);
  return t?.key ?? null;
}
