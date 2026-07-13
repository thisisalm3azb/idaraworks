/**
 * Jobs module service — S1 walking-skeleton scope (doc 11: "one job created
 * from a preset"; full job lifecycle lands in S2). createJobFromPreset does the
 * real thing end-to-end: entitlement gate → row-locked reference allocation →
 * insert → audit + activity + job.created outbox event, ONE transaction.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { JOB_CREATED } from "@/platform/events";
import { getLimit } from "@/platform/entitlements";
import { renderReference } from "@/platform/config/reference";
import { lockOrgConfigShared } from "@/platform/config/pipeline";
import { mergeCustomValues } from "@/platform/config/customFields";
import type { FieldDefinitionSet, StageTemplate, JobPreset } from "@/platform/config";
import { assignedJobCondition, isAssigned } from "./assigned";
import { computeProgress, type StageForProgress } from "./progress";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";

export class JobLimitError extends Error {
  constructor(limit: number) {
    super(`active job limit reached (${limit}) — upgrade the plan or archive jobs`);
    this.name = "JobLimitError";
  }
}

export const CreateJobInput = z.object({
  presetId: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  customerId: z.string().uuid().optional(),
  // Review fix (the DoD persona): the foreman is assigned AT CREATION so the
  // walking-skeleton demo has a real assigned-foreman path (job_crew is S2).
  foremanUserId: z.string().uuid().optional(),
  managerUserId: z.string().uuid().optional(),
  startDate: z
    .string()
    .regex(/^d{4}-d{2}-d{2}$/)
    .optional(),
  dueDate: z
    .string()
    .regex(/^d{4}-d{2}-d{2}$/)
    .optional(),
  customValues: z.record(z.string(), z.unknown()).optional(),
});

type PresetRow = { code: string; retired_at: string | null };
type PatternRow = { value: { job: { pattern: string; start: number } } };
type StatusRow = {
  value: { statuses: Array<{ status_key: string; semantic_category: string; sort: number }> };
};

/** Row-locked per-(org, scope) sequence increment — concurrency-safe inside the
 * caller's transaction; two simultaneous creates get consecutive numbers. */
async function allocateSequence(
  tx: TenantTx,
  ctx: Ctx,
  scopeKey: string,
  start: number,
): Promise<number> {
  await tx.execute(sql`
    insert into public.reference_sequence (org_id, scope_key, next_value)
    values (${ctx.orgId}, ${scopeKey}, ${start})
    on conflict (org_id, scope_key) do nothing
  `);
  const rows = (await tx.execute(sql`
    update public.reference_sequence
    set next_value = next_value + 1
    where org_id = ${ctx.orgId} and scope_key = ${scopeKey}
    returning next_value - 1 as allocated
  `)) as unknown as Array<{ allocated: number }>;
  return Number(rows[0]!.allocated);
}

export async function createJobFromPreset(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "jobs.create");
  const data = CreateJobInput.parse(input);

  const limit = await getLimit(ctx, "limit.active_jobs");

  const id = randomUUID();
  const result = await command(
    ctx,
    {
      audit: (r: { reference: string }) => ({
        action: "job.create",
        entityType: "job" as const,
        entityId: id,
        summary: `Created job ${r.reference}`,
      }),
      activity: (r: { reference: string }) => ({
        entityType: "job" as const,
        entityId: id,
        verb: "created",
        summary: `created ${r.reference} — ${data.name}`,
      }),
      events: (r: { reference: string }) => [
        {
          name: JOB_CREATED,
          payload: { orgId: ctx.orgId, actorUserId: ctx.userId, jobId: id, reference: r.reference },
        },
      ],
    },
    async (tx) => {
      // Shared org-config lock: a concurrent config apply (exclusive) cannot
      // interleave with this create — the status/pattern config read here and
      // the D-9.2 guards' view of live jobs stay mutually consistent (review).
      await lockOrgConfigShared(tx, ctx);
      // Per-org job-create mutex: the entitlement count is re-checked IN THIS
      // transaction under an exclusive advisory lock, so N concurrent creates
      // serialize and the plan limit cannot be raced (review fix — the old
      // pre-tx check was a TOCTOU; distinct references never collide, so the
      // unique index was no mitigation).
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${ctx.orgId + ":jobs.create"}, 0))`,
      );
      if (limit !== null) {
        const counted = (await tx.execute(sql`
          select count(*)::int as n from public.job
          where org_id = ${ctx.orgId} and archived = false
            and status_category in ('draft', 'active', 'on_hold')
        `)) as unknown as Array<{ n: number }>;
        if ((counted[0]?.n ?? 0) >= limit) throw new JobLimitError(limit);
      }
      // Preset (live), pattern config, and initial status resolve in-tx.
      const presets = (await tx.execute(sql`
        select code, retired_at, default_skipped_stage_keys, billing_points
        from public.job_preset
        where org_id = ${ctx.orgId} and id = ${data.presetId}
      `)) as unknown as Array<
        PresetRow & {
          default_skipped_stage_keys: string[];
          billing_points: JobPreset["billing_points"];
        }
      >;
      const preset = presets[0];
      if (!preset || preset.retired_at) throw new Error("unknown or retired preset");

      const patterns = (await tx.execute(sql`
        select value from public.app_settings
        where org_id = ${ctx.orgId} and key = 'config.reference_patterns'
      `)) as unknown as PatternRow[];
      const jobPattern = patterns[0]?.value?.job ?? { pattern: "{preset_code}-{seq:3}", start: 1 };

      const statusSets = (await tx.execute(sql`
        select value from public.app_settings
        where org_id = ${ctx.orgId} and key = 'config.status_set.job'
      `)) as unknown as StatusRow[];
      const statuses = statusSets[0]?.value?.statuses ?? [];
      const initial = statuses
        .filter((s) => s.semantic_category === "draft")
        .sort((a, b) => a.sort - b.sort)[0] ?? { status_key: "draft", semantic_category: "draft" };

      // Sequence scope is per-preset when the pattern uses {preset_code} (doc 07).
      const scope = jobPattern.pattern.includes("{preset_code}") ? `job.${preset.code}` : "job";
      const seq = await allocateSequence(tx, ctx, scope, jobPattern.start);
      const reference = renderReference(jobPattern.pattern, { presetCode: preset.code, seq });

      // Custom values validated against the org's job field definitions (S2).
      const fieldDefRows = (await tx.execute(sql`
        select value from public.app_settings
        where org_id = ${ctx.orgId} and key = 'config.fields.job'
      `)) as unknown as Array<{ value: FieldDefinitionSet | null }>;
      const customValues = mergeCustomValues(
        fieldDefRows[0]?.value ?? null,
        {},
        data.customValues ?? {},
      );

      await tx.execute(sql`
        insert into public.job
          (id, org_id, reference, name, preset_id, customer_id, status_key, status_category,
           foreman_user_id, manager_user_id, start_date, due_date,
           billing_points, custom_values, created_by)
        values (${id}, ${ctx.orgId}, ${reference}, ${data.name}, ${data.presetId},
                ${data.customerId ?? null}, ${initial.status_key}, ${initial.semantic_category},
                ${data.foremanUserId ?? null}, ${data.managerUserId ?? null},
                ${data.startDate ?? null}, ${data.dueDate ?? null},
                ${JSON.stringify(preset.billing_points)}::jsonb,
                ${JSON.stringify(customValues)}::jsonb, ${ctx.userId})
      `);

      // Seed job_stage SNAPSHOTS from the org stage template, preset skips
      // applied (doc 11 DoD: 13S/18S auto-skip Upholstery); template edits
      // never rewrite these rows.
      const tmplRows = (await tx.execute(sql`
        select value from public.app_settings
        where org_id = ${ctx.orgId} and key = 'config.stage_template'
      `)) as unknown as Array<{ value: StageTemplate | null }>;
      const stages = tmplRows[0]?.value?.stages ?? [];
      const skipped = new Set(preset.default_skipped_stage_keys ?? []);
      let firstActiveStageId: string | null = null;
      for (let i = 0; i < stages.length; i++) {
        const st = stages[i]!;
        const stageId = randomUUID();
        const isSkipped = skipped.has(st.stage_key);
        if (!isSkipped && firstActiveStageId === null) firstActiveStageId = stageId;
        await tx.execute(sql`
          insert into public.job_stage
            (id, org_id, job_id, stage_key, name, weight, sort, status)
          values (${stageId}, ${ctx.orgId}, ${id}, ${st.stage_key},
                  ${JSON.stringify(st.names)}::jsonb, ${st.weight}, ${i},
                  ${isSkipped ? "skipped" : "not_started"})
        `);
      }
      if (firstActiveStageId) {
        await tx.execute(sql`
          update public.job set current_stage_id = ${firstActiveStageId}
          where org_id = ${ctx.orgId} and id = ${id}
        `);
      }
      return { reference };
    },
  );
  return { id, reference: result.reference };
}

export type JobRow = {
  id: string;
  reference: string;
  name: string;
  statusKey: string;
  statusCategory: string;
  presetCode: string | null;
  customerName: string | null;
  createdAt: string;
  dueDate?: string | null;
  progress?: number | null;
  progressOverridden?: boolean;
};

export async function listJobs(ctx: Ctx, archetype: RoleArchetype): Promise<JobRow[]> {
  assertCan(archetype, "jobs.view");
  // DoD (doc 06/F-6): the foreman sees ONLY assigned jobs.
  const foreman = archetype === "foreman";
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select j.id::text as id, j.reference, j.name, j.status_key, j.status_category,
             p.code as preset_code, c.name as customer_name, j.created_at::text as created_at,
             j.due_date::text as due_date, j.progress_override,
             (select coalesce(json_agg(json_build_object('weight', s.weight, 'status', s.status)), '[]'::json)
                from public.job_stage s where s.job_id = j.id) as stages
      from public.job j
      left join public.job_preset p on p.id = j.preset_id
      left join public.customer c on c.id = j.customer_id
      where j.org_id = ${ctx.orgId} and j.archived = false
        ${foreman ? sql`and ${assignedJobCondition(ctx)}` : sql``}
      order by j.created_at desc
    `),
  )) as unknown as Array<{
    id: string;
    reference: string;
    name: string;
    status_key: string;
    status_category: string;
    preset_code: string | null;
    customer_name: string | null;
    created_at: string;
    due_date: string | null;
    progress_override: number | null;
    stages: StageForProgress[];
  }>;
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    name: r.name,
    statusKey: r.status_key,
    statusCategory: r.status_category,
    presetCode: r.preset_code,
    customerName: r.customer_name,
    createdAt: r.created_at,
    dueDate: r.due_date,
    progress:
      r.progress_override !== null ? Number(r.progress_override) : computeProgress(r.stages),
    progressOverridden: r.progress_override !== null,
  }));
}

export async function getJob(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
): Promise<JobRow | null> {
  assertCan(archetype, "jobs.view");
  const rows = await listJobsById(ctx, jobId);
  const job = rows[0] ?? null;
  // F-6: the foreman sees only ASSIGNED jobs — detail included.
  if (job && archetype === "foreman" && !(await isAssigned(ctx, jobId))) return null;
  return job;
}

async function listJobsById(ctx: Ctx, jobId: string): Promise<JobRow[]> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select j.id::text as id, j.reference, j.name, j.status_key, j.status_category,
             p.code as preset_code, c.name as customer_name, j.created_at::text as created_at
      from public.job j
      left join public.job_preset p on p.id = j.preset_id
      left join public.customer c on c.id = j.customer_id
      where j.org_id = ${ctx.orgId} and j.id = ${jobId}
    `),
  )) as unknown as Array<{
    id: string;
    reference: string;
    name: string;
    status_key: string;
    status_category: string;
    preset_code: string | null;
    customer_name: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    name: r.name,
    statusKey: r.status_key,
    statusCategory: r.status_category,
    presetCode: r.preset_code,
    customerName: r.customer_name,
    createdAt: r.created_at,
  }));
}

/** Live presets for the create form (page-facing read — Bible 3.2 service surface). */
export async function listActivePresets(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<Array<{ id: string; code: string; names: { en: string; ar: string } }>> {
  assertCan(archetype, "jobs.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, code, names from public.job_preset
      where org_id = ${ctx.orgId} and retired_at is null order by code
    `),
  )) as unknown as Array<{ id: string; code: string; names: { en: string; ar: string } }>;
  return rows;
}

/** Active members assignable as foreman (user references — doc 01/F-6). */
export async function listAssignableMembers(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<Array<{ userId: string; fullName: string; roleKey: string }>> {
  assertCan(archetype, "jobs.create");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select m.user_id::text as user_id, u.full_name, m.role_key
      from public.membership m
      join public.user_profile u on u.id = m.user_id
      where m.org_id = ${ctx.orgId} and m.deactivated_at is null
      order by u.full_name
    `),
  )) as unknown as Array<{ user_id: string; full_name: string; role_key: string }>;
  return rows.map((r) => ({ userId: r.user_id, fullName: r.full_name, roleKey: r.role_key }));
}

/** Job status labels (status_key to localized label) for display (review fix —
 * the UI showed raw snake_case keys instead of the configured bilingual labels). */
export async function getJobStatusLabels(
  ctx: Ctx,
  locale: "en" | "ar",
): Promise<Record<string, string>> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select value from public.app_settings
      where org_id = ${ctx.orgId} and key = 'config.status_set.job'
    `),
  )) as unknown as Array<{
    value: { statuses: Array<{ status_key: string; labels: { en: string; ar: string } }> } | null;
  }>;
  const statuses = rows[0]?.value?.statuses ?? [];
  return Object.fromEntries(statuses.map((s) => [s.status_key, s.labels[locale]]));
}

// ── S2 job commands ───────────────────────────────────────────────────────────
export const JobCoreInput = z.object({
  name: z.string().trim().min(1).max(160),
  customerId: z.string().uuid().nullable().optional(),
  managerUserId: z.string().uuid().nullable().optional(),
  foremanUserId: z.string().uuid().nullable().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  customValues: z.record(z.string(), z.unknown()).optional(),
});

export async function updateJobCore(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "jobs.edit");
  const data = JobCoreInput.parse(input);
  await command(
    ctx,
    {
      audit: (r: { reference: string }) => ({
        action: "job.update",
        entityType: "job" as const,
        entityId: jobId,
        summary: `Updated ${r.reference}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select reference, custom_values from public.job
        where org_id = ${ctx.orgId} and id = ${jobId}
      `)) as unknown as Array<{ reference: string; custom_values: Record<string, unknown> }>;
      const job = rows[0];
      if (!job) throw new Error("job not found");
      const defs = (await tx.execute(sql`
        select value from public.app_settings
        where org_id = ${ctx.orgId} and key = 'config.fields.job'
      `)) as unknown as Array<{ value: FieldDefinitionSet | null }>;
      const customValues = mergeCustomValues(
        defs[0]?.value ?? null,
        job.custom_values ?? {},
        data.customValues ?? {},
      );
      await tx.execute(sql`
        update public.job
        set name = ${data.name},
            customer_id = ${data.customerId === undefined ? sql`customer_id` : (data.customerId ?? null)},
            manager_user_id = ${data.managerUserId === undefined ? sql`manager_user_id` : (data.managerUserId ?? null)},
            foreman_user_id = ${data.foremanUserId === undefined ? sql`foreman_user_id` : (data.foremanUserId ?? null)},
            start_date = ${data.startDate === undefined ? sql`start_date` : (data.startDate ?? null)},
            due_date = ${data.dueDate === undefined ? sql`due_date` : (data.dueDate ?? null)},
            custom_values = ${JSON.stringify(customValues)}::jsonb,
            updated_at = now()
        where org_id = ${ctx.orgId} and id = ${jobId}
      `);
      return { reference: job.reference };
    },
  );
}

export async function updateJobStatus(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  statusKey: string,
): Promise<void> {
  assertCan(archetype, "jobs.edit");
  await command(
    ctx,
    {
      audit: (r: { reference: string }) => ({
        action: "job.status",
        entityType: "job" as const,
        entityId: jobId,
        summary: `${r.reference} -> ${statusKey}`,
      }),
      activity: (r: { reference: string }) => ({
        entityType: "job" as const,
        entityId: jobId,
        verb: "moved",
        summary: `moved ${r.reference} to ${statusKey}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select reference from public.job where org_id = ${ctx.orgId} and id = ${jobId}
      `)) as unknown as Array<{ reference: string }>;
      if (!rows[0]) throw new Error("job not found");
      // Status must exist in the org status set; the SEMANTIC ANCHOR moves
      // with it (v1 §15 discipline — engine logic reads the category).
      const sets = (await tx.execute(sql`
        select value from public.app_settings
        where org_id = ${ctx.orgId} and key = 'config.status_set.job'
      `)) as unknown as Array<{
        value: { statuses: Array<{ status_key: string; semantic_category: string }> } | null;
      }>;
      const status = (sets[0]?.value?.statuses ?? []).find((x) => x.status_key === statusKey);
      if (!status) throw new Error(`unknown status "${statusKey}"`);
      await tx.execute(sql`
        update public.job
        set status_key = ${statusKey}, status_category = ${status.semantic_category},
            completed_date = ${status.semantic_category === "done" ? sql`coalesce(completed_date, current_date)` : sql`completed_date`},
            updated_at = now()
        where org_id = ${ctx.orgId} and id = ${jobId}
      `);
      return { reference: rows[0].reference };
    },
  );
}

export const PricingInput = z.object({
  sellingPriceMinor: z.number().int().min(0).nullable().optional(),
  paymentTerms: z.string().trim().max(500).nullable().optional(),
  billingPoints: z
    .array(
      z.object({
        trigger: z.union([z.literal("on_acceptance"), z.object({ stage_key: z.string() })]),
        pct: z.number().int().min(1).max(100),
      }),
    )
    .optional(),
});

/** Selling price / billing points / terms — price-privileged O/A (F-23). */
export async function updateJobPricing(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "jobs.price.manage");
  const data = PricingInput.parse(input);
  if (data.billingPoints) {
    const sum = data.billingPoints.reduce((a, b) => a + b.pct, 0);
    if (sum !== 100) throw new Error(`billing points must sum to 100% (got ${sum})`);
  }
  await command(
    ctx,
    {
      audit: {
        action: "job.pricing",
        entityType: "job",
        entityId: jobId,
        // Identifiers only — never price VALUES in audit summaries (§5.9).
        summary: "Updated job pricing",
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.job
        set selling_price_minor = ${data.sellingPriceMinor === undefined ? sql`selling_price_minor` : (data.sellingPriceMinor ?? null)},
            payment_terms = ${data.paymentTerms === undefined ? sql`payment_terms` : (data.paymentTerms ?? null)},
            billing_points = ${data.billingPoints === undefined ? sql`billing_points` : sql`${JSON.stringify(data.billingPoints)}::jsonb`},
            updated_at = now()
        where org_id = ${ctx.orgId} and id = ${jobId}
      `);
    },
  );
}

export const AdjustmentInput = z.object({
  amountMinor: z.number().int(), // signed: scope increase or decrease
  reason: z.string().trim().min(1).max(500),
});

/** Price adjustment — OWNER-only append (F-10, the scope-change mechanism). */
export async function addPriceAdjustment(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "jobs.price.adjust");
  const data = AdjustmentInput.parse(input);
  await command(
    ctx,
    {
      audit: {
        action: "job.price_adjustment",
        entityType: "job",
        entityId: jobId,
        summary: `Price adjustment: ${data.reason}`, // the reason, never the amount
      },
      activity: {
        entityType: "job",
        entityId: jobId,
        verb: "adjusted",
        summary: `recorded a price adjustment — ${data.reason}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        update public.job
        set price_adjustments = price_adjustments || ${JSON.stringify([
          {
            amount_minor: data.amountMinor,
            reason: data.reason,
            actor_user_id: ctx.userId,
            at: new Date().toISOString(),
          },
        ])}::jsonb,
            updated_at = now()
        where org_id = ${ctx.orgId} and id = ${jobId}
      `),
  );
}

export const OverrideInput = z.object({
  percent: z.number().min(0).max(100),
  reason: z.string().trim().min(1).max(500), // who/when/why — D-1.4
});

export async function setProgressOverride(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "jobs.progress.override");
  const data = OverrideInput.parse(input);
  await command(
    ctx,
    {
      audit: {
        action: "job.progress_override",
        entityType: "job",
        entityId: jobId,
        summary: `Progress override ${data.percent}%: ${data.reason}`,
      },
      activity: {
        entityType: "job",
        entityId: jobId,
        verb: "overrode",
        summary: `set progress to ${data.percent}% — ${data.reason}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        update public.job
        set progress_override = ${data.percent}, progress_override_reason = ${data.reason},
            progress_override_by = ${ctx.userId}, progress_override_at = now(),
            updated_at = now()
        where org_id = ${ctx.orgId} and id = ${jobId}
      `),
  );
}

export async function clearProgressOverride(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
): Promise<void> {
  assertCan(archetype, "jobs.progress.override");
  await command(
    ctx,
    {
      audit: {
        action: "job.progress_override_clear",
        entityType: "job",
        entityId: jobId,
        summary: "Cleared progress override",
      },
    },
    (tx) =>
      tx.execute(sql`
        update public.job
        set progress_override = null, progress_override_reason = null,
            progress_override_by = null, progress_override_at = null, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${jobId}
      `),
  );
}

// ── module public surface re-exports (Bible §3.2) ────────────────────────────
export { computeProgress, displayProgress, currentStage } from "./progress";
export { isAssigned, assignedJobCondition } from "./assigned";
export {
  listStages,
  startStage,
  requestStageCompletion,
  completeStage,
  reopenStage,
  type StageRow,
} from "./stages";
export { createTask, updateTaskStatus, listJobTasks, TASK_STATUSES, type TaskRow } from "./tasks";
export { addCrewMember, removeCrewMember, listCrew, type CrewRow } from "./crew";
export { getWeekView, type WeekJob } from "./week";
