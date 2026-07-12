/**
 * The config pipeline (S1; v1 §14 steps 4–6 / §15 "one write path").
 * validate → preview → apply → undo, over a CLOSED artifact registry. Human
 * editors, template installs, and (later) AI proposals all pass through
 * applyConfigChange — one set of validation rules, one revision trail.
 *
 * Storage model: blob artifacts live in app_settings under their artifact key;
 * table-backed artifacts (job presets, role labels/flags, holiday rows) are
 * written by their handler in the SAME transaction. Every apply is ONE
 * command(): artifact write + config_revision (full before/after) + audit_log.
 *
 * D-9.2 guardrails: keys are immutable, labels are mutable, deletes are
 * mappings — a change that would strand live data (a category key items still
 * use, a status key jobs still hold, a stage key presets still reference) is
 * REJECTED with an explicit error, never silently applied.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { command } from "@/platform/audit";
import { getLimit } from "@/platform/entitlements";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { diffConfig, type DiffEntry } from "./diff";
import { insertConfigRevisionIn } from "./revision";
import { z as zx } from "zod";
import { TerminologyOverrideSchema } from "./schemas/terminology";
import { TEMPLATES } from "./templates/boatbuilding";
import {
  CategorySetSchema,
  HolidayCalendarSchema,
  JobPresetSchema,
  ReferencePatternSetSchema,
  RolePresetSetSchema,
  StageTemplateSchema,
  StatusSetSchema,
  type HolidayCalendar,
  type JobPreset,
  type RolePresetSet,
} from "./schemas/artifacts";

export class ConfigValidationError extends Error {
  constructor(
    public readonly artifactKey: string,
    public readonly issues: string[],
  ) {
    super(`config validation failed for ${artifactKey}: ${issues.join("; ")}`);
    this.name = "ConfigValidationError";
  }
}

export class ConfigGuardError extends Error {
  constructor(
    public readonly artifactKey: string,
    message: string,
  ) {
    super(`config guard rejected ${artifactKey}: ${message}`);
    this.name = "ConfigGuardError";
  }
}

type Handler = {
  /** Zod schema for the artifact value (null = delete/retire, where allowed). */
  schema: z.ZodTypeAny;
  read: (tx: TenantTx, ctx: Ctx, key: string) => Promise<unknown>;
  write: (tx: TenantTx, ctx: Ctx, key: string, value: unknown) => Promise<void>;
  /** D-9.2 / data-intact guard — throws ConfigGuardError to reject. */
  guard?: (tx: TenantTx, ctx: Ctx, key: string, next: unknown, current: unknown) => Promise<void>;
  /** Whether `null` is a legal value (preset retire). */
  nullable?: boolean;
};

/**
 * Per-org config lock (review fix — the one-write-path had no concurrency
 * control): every applyConfigChange takes the EXCLUSIVE per-org advisory xact
 * lock, so concurrent applies serialize — revision N's before_data always
 * equals revision N-1's after_data, and D-9.2 guards cannot race each other.
 * Business writers that READ config inside their own transactions (job create)
 * take the SHARED form, so a guard can never race a concurrent business write
 * it should have seen.
 */
export async function lockOrgConfig(tx: TenantTx, ctx: Ctx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${ctx.orgId + ":config"}, 0))`,
  );
}

export async function lockOrgConfigShared(tx: TenantTx, ctx: Ctx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${ctx.orgId + ":config"}, 0))`,
  );
}

// ── blob helpers (app_settings) ───────────────────────────────────────────────
async function readBlob(tx: TenantTx, ctx: Ctx, key: string): Promise<unknown> {
  const rows = (await tx.execute(sql`
    select value from public.app_settings where org_id = ${ctx.orgId} and key = ${key}
  `)) as unknown as Array<{ value: unknown }>;
  return rows[0]?.value ?? null;
}

async function writeBlob(tx: TenantTx, ctx: Ctx, key: string, value: unknown): Promise<void> {
  // Undo of a CREATE reverts the artifact to "unset": stored as jsonb null
  // (app_settings deliberately has no DELETE grant — 0001); readBlob returns
  // JS null for it, so resolution falls back (template/platform defaults).
  await tx.execute(sql`
    insert into public.app_settings (org_id, key, value)
    values (${ctx.orgId}, ${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (org_id, key) do update set value = excluded.value, updated_at = now()
  `);
}

const blobHandler = (schema: z.ZodTypeAny, guard?: Handler["guard"]): Handler => ({
  schema,
  read: readBlob,
  write: writeBlob,
  guard,
  nullable: true, // undo of a first-time apply restores "unset"
});

// ── guards ───────────────────────────────────────────────────────────────────
const stageTemplateGuard: Handler["guard"] = async (tx, ctx, _key, next) => {
  const nextKeys = new Set(
    ((next as { stages: Array<{ stage_key: string }> } | null)?.stages ?? []).map(
      (s) => s.stage_key,
    ),
  );
  // Live presets referencing a removed stage key strand their skip/billing refs.
  const presets = (await tx.execute(sql`
    select code, default_skipped_stage_keys, billing_points
    from public.job_preset where org_id = ${ctx.orgId} and retired_at is null
  `)) as unknown as Array<{
    code: string;
    default_skipped_stage_keys: string[];
    billing_points: Array<{ trigger: string | { stage_key: string } }>;
  }>;
  for (const p of presets) {
    for (const k of p.default_skipped_stage_keys) {
      if (!nextKeys.has(k)) {
        throw new ConfigGuardError(
          "config.stage_template",
          `stage "${k}" is referenced by preset ${p.code} (skip list) — retire the preset first or keep the key (D-9.2)`,
        );
      }
    }
    for (const bp of p.billing_points) {
      if (typeof bp.trigger === "object" && !nextKeys.has(bp.trigger.stage_key)) {
        throw new ConfigGuardError(
          "config.stage_template",
          `stage "${bp.trigger.stage_key}" is referenced by preset ${p.code} (billing point) — keep the key (D-9.2)`,
        );
      }
    }
  }
};

type StatusSetValue = {
  statuses: Array<{ status_key: string; semantic_category: string }>;
} | null;

const statusSetGuard: Handler["guard"] = async (tx, ctx, _key, next) => {
  const nextStatuses = (next as StatusSetValue)?.statuses ?? [];
  const nextByKey = new Map(nextStatuses.map((s) => [s.status_key, s.semantic_category]));
  const inUse = (await tx.execute(sql`
    select distinct status_key from public.job where org_id = ${ctx.orgId}
  `)) as unknown as Array<{ status_key: string }>;
  const current = (await readBlob(tx, ctx, "config.status_set.job")) as StatusSetValue;
  const currentByKey = new Map(
    (current?.statuses ?? []).map((s) => [s.status_key, s.semantic_category]),
  );
  for (const row of inUse) {
    if (!nextByKey.has(row.status_key)) {
      throw new ConfigGuardError(
        "config.status_set.job",
        `status "${row.status_key}" is held by existing jobs — statuses in use are renamed or retired via mapping, never removed (D-9.2)`,
      );
    }
    // Semantic-anchor freeze (review fix): jobs denormalize status_category at
    // creation; re-mapping an IN-USE key's category would silently desynchronize
    // the engine's anchor (e.g. the active-jobs entitlement count). Category
    // changes for in-use keys require a mapping migration, not a label edit.
    const was = currentByKey.get(row.status_key);
    const now = nextByKey.get(row.status_key);
    if (was !== undefined && now !== undefined && was !== now) {
      throw new ConfigGuardError(
        "config.status_set.job",
        `status "${row.status_key}" is held by existing jobs — its semantic category ("${was}") is frozen while in use (D-9.2 mapping rule)`,
      );
    }
  }
};

const categoryGuard =
  (kind: "item" | "expense" | "quote_section"): Handler["guard"] =>
  async (tx, ctx, key, next) => {
    if (kind !== "item") return; // expense/quote_section consumers land in S4/S6
    const nextKeys = new Set(
      ((next as { categories: Array<{ key: string }> } | null)?.categories ?? []).map((c) => c.key),
    );
    const inUse = (await tx.execute(sql`
      select distinct category_key from public.item where org_id = ${ctx.orgId}
    `)) as unknown as Array<{ category_key: string }>;
    for (const row of inUse) {
      if (!nextKeys.has(row.category_key)) {
        throw new ConfigGuardError(
          key,
          `category "${row.category_key}" is used by catalog items — retire it (retired: true), never remove (D-9.2)`,
        );
      }
    }
  };

// ── table-backed handlers ─────────────────────────────────────────────────────
const rolesHandler: Handler = {
  schema: RolePresetSetSchema,
  read: async (tx, ctx) => {
    const rows = (await tx.execute(sql`
      select key, archetype, label, cost_privileged, price_privileged
      from public.role_definition where org_id = ${ctx.orgId} order by key
    `)) as unknown as Array<{
      key: string;
      archetype: string;
      label: { en: string; ar: string };
      cost_privileged: boolean;
      price_privileged: boolean;
    }>;
    return {
      roles: rows.map((r) => ({
        key: r.key,
        archetype: r.archetype,
        labels: r.label,
        cost_privileged: r.cost_privileged,
        price_privileged: r.price_privileged,
      })),
    };
  },
  guard: async (tx, ctx, _key, next) => {
    const existing = (await tx.execute(sql`
      select key, archetype from public.role_definition where org_id = ${ctx.orgId}
    `)) as unknown as Array<{ key: string; archetype: string }>;
    const byKey = new Map(existing.map((r) => [r.key, r.archetype]));
    for (const role of (next as RolePresetSet).roles) {
      const archetype = byKey.get(role.key);
      if (!archetype) {
        throw new ConfigGuardError(
          "config.roles",
          `unknown role key "${role.key}" — S1 edits existing role presets only`,
        );
      }
      if (archetype !== role.archetype) {
        throw new ConfigGuardError(
          "config.roles",
          `role "${role.key}" archetype is immutable (${archetype})`,
        );
      }
    }
  },
  write: async (tx, ctx, _key, value) => {
    for (const role of (value as RolePresetSet).roles) {
      await tx.execute(sql`
        update public.role_definition
        set label = ${JSON.stringify(role.labels)}::jsonb,
            cost_privileged = ${role.cost_privileged},
            price_privileged = ${role.price_privileged},
            updated_at = now()
        where org_id = ${ctx.orgId} and key = ${role.key}
      `);
    }
  },
};

const holidayHandler: Handler = {
  schema: HolidayCalendarSchema,
  nullable: true,
  // The blob is the artifact source of truth; table rows are the SQL-consumable
  // materialization (working-day math reads org_holiday_calendar in later slices).
  read: readBlob,
  write: async (tx, ctx, key, value) => {
    await writeBlob(tx, ctx, key, value);
    await tx.execute(sql`delete from public.org_holiday_calendar where org_id = ${ctx.orgId}`);
    if (value === null) return;
    const cal = value as HolidayCalendar;
    for (const e of cal.entries) {
      await tx.execute(sql`
        insert into public.org_holiday_calendar (org_id, starts_on, ends_on, label, kind)
        values (${ctx.orgId}, ${e.starts_on}, ${e.ends_on ?? null},
                ${JSON.stringify(e.label)}::jsonb, ${e.kind})
      `);
    }
  },
};

const presetHandler: Handler = {
  schema: JobPresetSchema,
  nullable: true, // null = retire (D-9.2: no deletes)
  read: async (tx, ctx, key) => {
    const id = key.slice("preset.".length);
    const rows = (await tx.execute(sql`
      select code, names, default_skipped_stage_keys, billing_points, description, retired_at
      from public.job_preset where org_id = ${ctx.orgId} and id = ${id}
    `)) as unknown as Array<{
      code: string;
      names: unknown;
      default_skipped_stage_keys: unknown;
      billing_points: unknown;
      description: string | null;
      retired_at: string | null;
    }>;
    const r = rows[0];
    if (!r || r.retired_at) return null;
    return {
      code: r.code,
      names: r.names,
      default_skipped_stage_keys: r.default_skipped_stage_keys,
      billing_points: r.billing_points,
      ...(r.description ? { description: r.description } : {}),
    };
  },
  guard: async (tx, ctx, key, next, current) => {
    if (next === null) return; // retire is always safe — jobs keep their FK
    if (current === null) {
      // NEW preset: the limit.presets entitlement applies on EVERY path, not
      // just installTemplate (review minor).
      const limit = await getLimit(ctx, "limit.presets");
      if (limit !== null) {
        const rows = (await tx.execute(sql`
          select count(*)::int as n from public.job_preset
          where org_id = ${ctx.orgId} and retired_at is null
        `)) as unknown as Array<{ n: number }>;
        if ((rows[0]?.n ?? 0) >= limit) {
          throw new ConfigGuardError(key, `preset limit reached (${limit})`);
        }
      }
    }
    const cur = current as JobPreset | null;
    const nxt = next as JobPreset;
    if (cur && cur.code !== nxt.code) {
      throw new ConfigGuardError(
        key,
        `preset code is immutable ("${cur.code}") — references embed it (D-9.2)`,
      );
    }
    // Skip/billing refs must exist in the CURRENT stage template.
    const stages = (await readBlob(tx, ctx, "config.stage_template")) as {
      stages: Array<{ stage_key: string }>;
    } | null;
    const stageKeys = new Set(stages?.stages.map((s) => s.stage_key) ?? []);
    for (const k of nxt.default_skipped_stage_keys) {
      if (!stageKeys.has(k)) {
        throw new ConfigGuardError(key, `skipped stage "${k}" not in the org stage template`);
      }
    }
    for (const bp of nxt.billing_points) {
      if (typeof bp.trigger === "object" && !stageKeys.has(bp.trigger.stage_key)) {
        throw new ConfigGuardError(
          key,
          `billing trigger stage "${bp.trigger.stage_key}" not in the org stage template`,
        );
      }
    }
  },
  write: async (tx, ctx, key, value) => {
    const id = key.slice("preset.".length);
    if (value === null) {
      await tx.execute(sql`
        update public.job_preset set retired_at = now(), updated_at = now()
        where org_id = ${ctx.orgId} and id = ${id}
      `);
      return;
    }
    const p = value as JobPreset;
    await tx.execute(sql`
      insert into public.job_preset (id, org_id, code, names, default_skipped_stage_keys, billing_points, description)
      values (${id}, ${ctx.orgId}, ${p.code}, ${JSON.stringify(p.names)}::jsonb,
              ${JSON.stringify(p.default_skipped_stage_keys)}::jsonb,
              ${JSON.stringify(p.billing_points)}::jsonb, ${p.description ?? null})
      on conflict (id) do update
        set names = excluded.names,
            default_skipped_stage_keys = excluded.default_skipped_stage_keys,
            billing_points = excluded.billing_points,
            description = excluded.description,
            retired_at = null,
            updated_at = now()
    `);
  },
};

// ── the closed artifact registry ─────────────────────────────────────────────
const FIXED_HANDLERS: Record<string, Handler> = {
  "terminology.overrides": blobHandler(TerminologyOverrideSchema),
  "config.stage_template": blobHandler(StageTemplateSchema, stageTemplateGuard),
  "config.status_set.job": blobHandler(StatusSetSchema, statusSetGuard),
  "config.categories.item": blobHandler(CategorySetSchema, categoryGuard("item")),
  "config.categories.expense": blobHandler(CategorySetSchema, categoryGuard("expense")),
  "config.categories.quote_section": blobHandler(CategorySetSchema, categoryGuard("quote_section")),
  "config.reference_patterns": blobHandler(ReferencePatternSetSchema),
  "config.roles": rolesHandler,
  "config.holiday_calendar": holidayHandler,
  // The selected terminology template (resolution: override → template → default).
  "terminology.template": blobHandler(
    zx.string().refine((k) => k in TEMPLATES, "unknown template key"),
  ),
  // Install marker — written last by installTemplate; also its idempotence guard.
  "config.template": blobHandler(
    zx.object({ key: zx.string().min(1).max(60), version: zx.number().int().min(1) }).strict(),
  ),
};

export const CONFIG_ARTIFACT_KEYS = Object.keys(FIXED_HANDLERS);

function handlerFor(artifactKey: string): Handler {
  const fixed = FIXED_HANDLERS[artifactKey];
  if (fixed) return fixed;
  if (/^preset\.[0-9a-f-]{36}$/i.test(artifactKey)) return presetHandler;
  throw new ConfigValidationError(artifactKey, ["unknown config artifact key"]);
}

function validate(artifactKey: string, value: unknown): unknown {
  const handler = handlerFor(artifactKey);
  if (value === null) {
    if (!handler.nullable) {
      throw new ConfigValidationError(artifactKey, ["this artifact cannot be removed"]);
    }
    return null;
  }
  const parsed = handler.schema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigValidationError(
      artifactKey,
      parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  // Category artifacts: the payload kind must match the key suffix (review
  // minor — 'config.categories.item' must never hold an expense set).
  const catMatch = artifactKey.match(/^config.categories.(item|expense|quote_section)$/);
  if (catMatch && (parsed.data as { kind?: string }).kind !== catMatch[1]) {
    throw new ConfigValidationError(artifactKey, [
      `category set kind must be "${catMatch[1]}" for this artifact`,
    ]);
  }
  return parsed.data;
}

export type ConfigPreview = {
  artifactKey: string;
  before: unknown;
  after: unknown;
  entries: DiffEntry[];
};

/** Step 1+2: validate + diff against current — nothing is written. */
export async function previewConfigChange(
  ctx: Ctx,
  artifactKey: string,
  next: unknown,
): Promise<ConfigPreview> {
  const value = validate(artifactKey, next);
  const handler = handlerFor(artifactKey);
  const before = await withCtx(ctx, (tx) => handler.read(tx, ctx, artifactKey));
  return { artifactKey, before, after: value, entries: diffConfig(before, value) };
}

/**
 * Step 3: apply as ONE atomic revision (artifact write + config_revision +
 * audit), under the per-org config lock. `next` may be a VALUE or a MERGER
 * function of the current value — the merger runs INSIDE the locked
 * transaction, so read-modify-write edits (the terminology editor) can never
 * lose a concurrent editor's change (review fix).
 */
export async function applyConfigChange(
  ctx: Ctx,
  artifactKey: string,
  next: unknown | ((before: unknown) => unknown),
  opts?: { summary?: string; aiFlag?: boolean },
): Promise<{ revisionId: string }> {
  const handler = handlerFor(artifactKey);
  // Value-form inputs are validated eagerly (fail before opening a tx).
  if (typeof next !== "function") validate(artifactKey, next);
  const revisionId = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "config.apply",
        entityType: "config",
        entityId: revisionId,
        summary: opts?.summary ?? `Updated ${artifactKey}`,
      },
    },
    async (tx) => {
      await lockOrgConfig(tx, ctx);
      const before = await handler.read(tx, ctx, artifactKey);
      const value = validate(
        artifactKey,
        typeof next === "function" ? (next as (b: unknown) => unknown)(before) : next,
      );
      if (handler.guard) await handler.guard(tx, ctx, artifactKey, value, before);
      await handler.write(tx, ctx, artifactKey, value);
      await insertConfigRevisionIn(tx, ctx, revisionId, {
        artifactKey,
        before,
        after: value,
        aiFlag: opts?.aiFlag ?? false,
        summary: opts?.summary,
      });
    },
  );
  return { revisionId };
}

/** Step 4: undo — re-applies the revision's BEFORE as a NEW revision (append-only
 * history), through the same validation + guards, so an undo can never strand data. */
export async function undoRevision(ctx: Ctx, revisionId: string): Promise<{ revisionId: string }> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select artifact_key, before_data from public.config_revision
      where org_id = ${ctx.orgId} and id = ${revisionId}
    `),
  )) as unknown as Array<{ artifact_key: string; before_data: unknown }>;
  const rev = rows[0];
  if (!rev) throw new ConfigValidationError("revision", ["revision not found"]);
  return applyConfigChange(ctx, rev.artifact_key, rev.before_data ?? null, {
    summary: `Undo revision ${revisionId.slice(0, 8)}`,
  });
}
