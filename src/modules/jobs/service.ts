/**
 * Jobs module service — S1 walking-skeleton scope (doc 11: "one job created
 * from a preset"; full job lifecycle lands in S2). createJobFromPreset does the
 * real thing end-to-end: entitlement gate → row-locked reference allocation →
 * insert → audit + activity + job.created outbox event, ONE transaction.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, ForbiddenError } from "@/platform/authz";
import { JOB_CREATED } from "@/platform/events";
import { getLimit } from "@/platform/entitlements";
import { renderReference } from "@/platform/config/reference";
import { lockOrgConfigShared } from "@/platform/config/pipeline";
import { mergeCustomValues } from "@/platform/config/customFields";
import { createComment } from "@/platform/comments";
import { signUpload, type SignedUpload } from "@/platform/files";
import type { FieldDefinitionSet, StageTemplate, JobPreset } from "@/platform/config";
import { assignedJobCondition, isAssigned } from "./assigned";
import { changeWorkStatus, assertWorkMutableIn } from "./lifecycle";
import { WORK_PRIORITIES } from "./work";
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
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  customValues: z.record(z.string(), z.unknown()).optional(),
  // H21 — the work record's own fields.
  ownerUserId: z.string().uuid().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  description: z.string().trim().max(4000).optional(),
  location: z.string().trim().max(200).optional(),
  /** How this work came to exist. Set by the calling PATH, never by a form. */
  origin: z.enum(["quotation", "opportunity", "direct"]).default("direct"),
  /** Only meaningful with origin 'opportunity'; validated in-transaction. */
  sourceOpportunityId: z.string().uuid().optional(),
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

/** H18 — the approved workflow's stage snapshot source (pure, defensive).
 * Accepts the applied revision's blueprint jsonb (SERVER data only) and
 * returns the 'job' workflow's stages, or null when no usable workflow
 * exists (malformed shape → null → the legacy template path, fail safe).
 * Stage identity, bilingual labels, weights and ORDER are preserved. */
export type SnapshotStage = {
  stage_key: string;
  names: { en: string; ar: string };
  weight: number;
  /** H21: snapshotted so a job's own stage rows can answer the engine
   * predicates (isReportable / isPreFinal). Null when the source declared
   * none — never a reason to reject a workflow. */
  phase_semantic?: string | null;
};

/** The phase vocabulary a snapshot may carry (registries.PHASE_SEMANTICS). */
const PHASE_SEMANTIC_VALUES = new Set([
  "preparation",
  "production",
  "finishing",
  "verification",
  "handover",
]);

export function stagesFromBlueprint(blueprint: unknown): SnapshotStage[] | null {
  if (typeof blueprint !== "object" || blueprint === null) return null;
  const workflows = (blueprint as { workflows?: unknown }).workflows;
  if (!Array.isArray(workflows)) return null;
  const wf = workflows.find(
    (w): w is { id: string; stages: unknown } =>
      typeof w === "object" && w !== null && (w as { id?: unknown }).id === "job",
  );
  if (!wf || !Array.isArray(wf.stages) || wf.stages.length === 0) return null;
  const out: SnapshotStage[] = [];
  const seen = new Set<string>();
  for (const raw of wf.stages) {
    const st = raw as {
      key?: unknown;
      name?: { en?: unknown; ar?: unknown };
      weight?: unknown;
      phaseSemantic?: unknown;
    };
    if (
      typeof st.key !== "string" ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(st.key) ||
      seen.has(st.key) ||
      typeof st.name?.en !== "string" ||
      typeof st.name?.ar !== "string" ||
      typeof st.weight !== "number" ||
      !Number.isInteger(st.weight) ||
      st.weight < 0 ||
      st.weight > 100
    ) {
      return null; // any malformed stage disqualifies the whole workflow
    }
    seen.add(st.key);
    out.push({
      stage_key: st.key,
      names: { en: st.name.en, ar: st.name.ar },
      weight: st.weight,
      phase_semantic:
        typeof st.phaseSemantic === "string" && PHASE_SEMANTIC_VALUES.has(st.phaseSemantic)
          ? st.phaseSemantic
          : null,
    });
  }
  return out;
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
      audit: (r: { reference: string; blueprintRevisionId: string | null }) => ({
        action: "job.create",
        entityType: "job" as const,
        entityId: id,
        summary: `Created job ${r.reference}`,
      }),
      activity: (r: { reference: string; blueprintRevisionId: string | null }) => ({
        entityType: "job" as const,
        entityId: id,
        verb: "created",
        summary: `created ${r.reference} — ${data.name}`,
      }),
      events: (r: { reference: string; blueprintRevisionId: string | null }) => [
        {
          name: JOB_CREATED,
          payload: {
            orgId: ctx.orgId,
            actorUserId: ctx.userId,
            jobId: id,
            reference: r.reference,
            // H18: which applied blueprint revision supplied the stage
            // snapshot (null = legacy template path). The events outbox is
            // the safe existing metadata location for this provenance.
            blueprintRevisionId: r.blueprintRevisionId,
          },
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
           billing_points, custom_values, created_by,
           owner_user_id, priority, description, location, origin, source_opportunity_id)
        values (${id}, ${ctx.orgId}, ${reference}, ${data.name}, ${data.presetId},
                ${data.customerId ?? null}, ${initial.status_key}, ${initial.semantic_category},
                ${data.foremanUserId ?? null}, ${data.managerUserId ?? null},
                ${data.startDate ?? null}, ${data.dueDate ?? null},
                ${JSON.stringify(preset.billing_points)}::jsonb,
                ${JSON.stringify(customValues)}::jsonb, ${ctx.userId},
                ${data.ownerUserId ?? data.managerUserId ?? null}, ${data.priority},
                ${data.description ?? null}, ${data.location ?? null}, ${data.origin},
                ${data.sourceOpportunityId ?? null})
      `);

      // Seed job_stage SNAPSHOTS (immutable; template/blueprint edits never
      // rewrite these rows — versioning is snapshot_on_creation, H14 law 14).
      //
      // H18: organizations with an APPLIED Intelligent Clay blueprint adopt
      // the approved 'job' workflow's stages (read server-side from the
      // applied revision inside THIS transaction — never client input, never
      // another organization's row: the org filter + 0076 RLS pin it).
      // Legacy organizations keep the config.stage_template path unchanged.
      const revRows = (await tx.execute(sql`
        select id, blueprint from public.workspace_blueprint_revision
        where org_id = ${ctx.orgId} and status = 'applied'
      `)) as unknown as Array<{ id: string; blueprint: unknown }>;
      const blueprintStages = stagesFromBlueprint(revRows[0]?.blueprint);
      const blueprintRevisionId = blueprintStages ? revRows[0]!.id : null;
      let stages: SnapshotStage[];
      if (blueprintStages) {
        stages = blueprintStages;
      } else {
        const tmplRows = (await tx.execute(sql`
          select value from public.app_settings
          where org_id = ${ctx.orgId} and key = 'config.stage_template'
        `)) as unknown as Array<{ value: StageTemplate | null }>;
        stages = tmplRows[0]?.value?.stages ?? [];
      }
      const skipped = new Set(preset.default_skipped_stage_keys ?? []);
      let firstActiveStageId: string | null = null;
      for (let i = 0; i < stages.length; i++) {
        const st = stages[i]!;
        const stageId = randomUUID();
        const isSkipped = skipped.has(st.stage_key);
        if (!isSkipped && firstActiveStageId === null) firstActiveStageId = stageId;
        await tx.execute(sql`
          insert into public.job_stage
            (id, org_id, job_id, stage_key, name, weight, sort, status, phase_semantic)
          values (${stageId}, ${ctx.orgId}, ${id}, ${st.stage_key},
                  ${JSON.stringify(st.names)}::jsonb, ${st.weight}, ${i},
                  ${isSkipped ? "skipped" : "not_started"}, ${st.phase_semantic ?? null})
        `);
      }
      if (firstActiveStageId) {
        await tx.execute(sql`
          update public.job set current_stage_id = ${firstActiveStageId}
          where org_id = ${ctx.orgId} and id = ${id}
        `);
      }
      return { reference, blueprintRevisionId };
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
  /** H19: present on getJob reads (the 360 back-link). */
  customerId?: string | null;
  createdAt: string;
  dueDate?: string | null;
  progress?: number | null;
  progressOverridden?: boolean;
  /** Current stage key (U5 dashboard deep-links filter the list by it). */
  currentStageKey?: string | null;
  /** H21 lifecycle state (present on getJob reads). */
  archived?: boolean;
  onHoldReason?: string | null;
  cancellationReason?: string | null;
};

export async function listJobs(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: {
    /** H18 drill-down scope: narrow any role to its assigned jobs (the same
     * resolver the dashboard's scoped aggregates use for managers). */
    assignedOnly?: boolean;
    /** H19: narrow to one customer's work (validated upstream). */
    customerId?: string;
    /** Reference or name, case-insensitive. */
    search?: string;
    /** Only work currently at this stage. */
    stageKey?: string;
    /**
     * Due strictly before this org-local day, and still open. The SAME rule as
     * jobIsOverdue in the dashboard filters, moved into SQL so a page of overdue
     * work is a page of the overdue set rather than the overdue rows that happen
     * to fall inside an already-truncated page.
     */
    overdueAsOf?: string;
    /** Due on or after this day and within `dueSoonDays`, and still open. */
    dueSoonAsOf?: string;
    dueSoonDays?: number;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: JobRow[]; hasMore: boolean; total: number }> {
  assertCan(archetype, "jobs.view");
  // DoD (doc 06/F-6): the foreman sees ONLY assigned jobs, always.
  const scoped = archetype === "foreman" || opts.assignedOnly === true;
  const customerId = opts.customerId ?? null;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const search = (opts.search ?? "").trim();
  const stageKey = (opts.stageKey ?? "").trim();
  const overdueAsOf = opts.overdueAsOf ?? null;
  const dueSoonAsOf = opts.dueSoonAsOf ?? null;
  const dueSoonDays = Math.min(Math.max(opts.dueSoonDays ?? 7, 0), 365);
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select j.id::text as id, j.reference, j.name, j.status_key, j.status_category,
             p.code as preset_code, c.name as customer_name, j.created_at::text as created_at,
             j.due_date::text as due_date, j.progress_override,
             cs.stage_key as current_stage_key,
             (select coalesce(json_agg(json_build_object('weight', s.weight, 'status', s.status)), '[]'::json)
                from public.job_stage s where s.job_id = j.id) as stages,
             -- The size of the whole filtered set, from the same scan. A caller
             -- that needs only the number asks for one row and reads this rather
             -- than fetching a page to measure it.
             count(*) over () as total_count
      from public.job j
      left join public.job_preset p on p.id = j.preset_id
      left join public.customer c on c.id = j.customer_id
      left join public.job_stage cs on cs.id = j.current_stage_id
      where j.org_id = ${ctx.orgId} and j.archived = false
        ${scoped ? sql`and ${assignedJobCondition(ctx)}` : sql``}
        and (${customerId}::uuid is null or j.customer_id = ${customerId}::uuid)
        and (${search === ""} or j.reference ilike ${"%" + search + "%"}
                              or j.name ilike ${"%" + search + "%"})
        and (${stageKey === ""} or cs.stage_key = ${stageKey})
        -- jobIsOverdue: open, dated, and the date has passed.
        and (${overdueAsOf}::date is null or (
              j.status_category in ('active', 'on_hold')
              and j.due_date is not null and j.due_date < ${overdueAsOf}::date))
        -- jobIsDueSoon: open, dated, not yet overdue, within the window.
        and (${dueSoonAsOf}::date is null or (
              j.status_category in ('active', 'on_hold')
              and j.due_date is not null
              and j.due_date >= ${dueSoonAsOf}::date
              and j.due_date <= ${dueSoonAsOf}::date + ${dueSoonDays}::int))
      order by j.created_at desc
      limit ${limit + 1} offset ${offset}
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
    current_stage_key: string | null;
    stages: StageForProgress[];
    total_count: string;
  }>;
  return {
    rows: rows.slice(0, limit).map((r) => ({
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
      currentStageKey: r.current_stage_key,
    })),
    hasMore: rows.length > limit,
    total: Number(rows[0]?.total_count ?? 0),
  };
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
  // Review fix: the detail read must carry progress + override too, so the
  // job page shows the SAME progress number as the list/week and can render
  // the "Overridden" chip (D-1.4: an override is display + a visible chip,
  // never silent). Derived progress computed from the job's own stages.
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select j.id::text as id, j.reference, j.name, j.status_key, j.status_category,
             p.code as preset_code, j.customer_id::text as customer_id, c.name as customer_name,
             j.created_at::text as created_at,
             j.due_date::text as due_date, j.progress_override,
             j.archived, j.on_hold_reason, j.cancellation_reason,
             (select coalesce(json_agg(json_build_object('weight', s.weight, 'status', s.status)), '[]'::json)
                from public.job_stage s where s.job_id = j.id) as stages
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
    customer_id: string | null;
    customer_name: string | null;
    created_at: string;
    due_date: string | null;
    progress_override: number | null;
    archived: boolean;
    on_hold_reason: string | null;
    cancellation_reason: string | null;
    stages: StageForProgress[];
  }>;
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    name: r.name,
    statusKey: r.status_key,
    statusCategory: r.status_category,
    presetCode: r.preset_code,
    customerId: r.customer_id,
    customerName: r.customer_name,
    createdAt: r.created_at,
    dueDate: r.due_date,
    // H21 lifecycle state — the detail page's controls depend on these.
    archived: r.archived,
    onHoldReason: r.on_hold_reason,
    cancellationReason: r.cancellation_reason,
    progress:
      r.progress_override !== null ? Number(r.progress_override) : computeProgress(r.stages),
    progressOverridden: r.progress_override !== null,
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
  // Priority is set on the work itself, not only at creation: urgency is
  // discovered while the work runs. Without an edit path the whole priority
  // vocabulary, and the unowned-urgent delivery signal built on it, stayed at
  // the default forever.
  priority: z.enum(WORK_PRIORITIES).optional(),
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
      // Closed work answers to the same immutability rule as its tasks and
      // dependencies. A delivered job's target date and customer are historical
      // record: quietly rewriting them changes what "delivered late" meant. The
      // way to change closed work is to reopen it, which is authorized, reasoned
      // and audited.
      await assertWorkMutableIn(tx, ctx, jobId);
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
            priority = ${data.priority === undefined ? sql`priority` : data.priority},
            custom_values = ${JSON.stringify(customValues)}::jsonb,
            updated_at = now()
        where org_id = ${ctx.orgId} and id = ${jobId}
      `);
      return { reference: job.reference };
    },
  );
}

/**
 * H21: the original status writer, kept as a thin delegate so no unguarded
 * path to job status survives. Every caller now goes through the validated
 * lifecycle — legal transitions only, reasons where the structure demands one,
 * and terminal work that refuses to move without an authorized reopen. Callers
 * needing to supply a reason should use changeWorkStatus directly.
 */
export async function updateJobStatus(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  statusKey: string,
): Promise<void> {
  await changeWorkStatus(ctx, archetype, jobId, { statusKey });
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
      // Every stage-trigger billing point must reference one of THIS job's
      // stage snapshots (review m10 — a bogus stage_key would never fire E-09
      // and would silently misprice the invoice).
      if (data.billingPoints) {
        const stageKeys = new Set(
          (
            (await tx.execute(sql`
              select stage_key from public.job_stage
              where org_id = ${ctx.orgId} and job_id = ${jobId}
            `)) as unknown as Array<{ stage_key: string }>
          ).map((r) => r.stage_key),
        );
        for (const bp of data.billingPoints) {
          if (typeof bp.trigger === "object" && !stageKeys.has(bp.trigger.stage_key)) {
            throw new Error(
              `billing trigger stage "${bp.trigger.stage_key}" is not a stage of this job`,
            );
          }
        }
      }
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

// ── S2 detail reads (Bible §3.2 — pages consume these, never raw SQL) ────────
export type JobDetail = {
  startDate: string | null;
  dueDate: string | null;
  customerId: string | null;
  foremanUserId: string | null;
  managerUserId: string | null;
  customValues: Record<string, unknown>;
  priority: "low" | "normal" | "high" | "urgent";
  progressOverride: number | null;
  progressOverrideReason: string | null;
};

export async function getJobDetail(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
): Promise<JobDetail | null> {
  assertCan(archetype, "jobs.view");
  if (archetype === "foreman" && !(await isAssigned(ctx, jobId))) return null;
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select start_date::text as start_date, due_date::text as due_date,
             customer_id::text as customer_id, foreman_user_id::text as foreman_user_id,
             manager_user_id::text as manager_user_id, custom_values, priority,
             progress_override, progress_override_reason
      from public.job where org_id = ${ctx.orgId} and id = ${jobId}
    `),
  )) as unknown as Array<{
    start_date: string | null;
    due_date: string | null;
    customer_id: string | null;
    foreman_user_id: string | null;
    manager_user_id: string | null;
    custom_values: Record<string, unknown>;
    priority: "low" | "normal" | "high" | "urgent" | null;
    progress_override: number | null;
    progress_override_reason: string | null;
  }>;
  const r = rows[0];
  if (!r) return null;
  return {
    startDate: r.start_date,
    dueDate: r.due_date,
    customerId: r.customer_id,
    priority: r.priority ?? "normal",
    foremanUserId: r.foreman_user_id,
    managerUserId: r.manager_user_id,
    customValues: r.custom_values ?? {},
    progressOverride: r.progress_override !== null ? Number(r.progress_override) : null,
    progressOverrideReason: r.progress_override_reason,
  };
}

export type JobPricing = {
  sellingPriceMinor: number | null;
  paymentTerms: string | null;
  priceAdjustments: Array<{ amountMinor: number; reason: string; at: string }>;
};

/** Pricing read — price-privileged ONLY (F-23: the wall is server-side, not a
 * JSX conditional; a foreman/viewer/manager session never receives these). */
export async function getJobPricing(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
): Promise<JobPricing | null> {
  assertCan(archetype, "jobs.price.manage");
  if (!ctx.pricePrivileged) return null;
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select selling_price_minor, payment_terms, price_adjustments
      from public.job where org_id = ${ctx.orgId} and id = ${jobId}
    `),
  )) as unknown as Array<{
    selling_price_minor: number | null;
    payment_terms: string | null;
    price_adjustments: Array<{ amount_minor: number; reason: string; at: string }>;
  }>;
  const r = rows[0];
  if (!r) return null;
  return {
    sellingPriceMinor: r.selling_price_minor !== null ? Number(r.selling_price_minor) : null,
    paymentTerms: r.payment_terms,
    priceAdjustments: (r.price_adjustments ?? []).map((a) => ({
      amountMinor: Number(a.amount_minor),
      reason: a.reason,
      at: a.at,
    })),
  };
}

export type ActivityRow = { summary: string; createdAt: string; actorName: string | null };

export async function listJobActivity(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  limit = 50,
): Promise<ActivityRow[]> {
  assertCan(archetype, "jobs.view");
  if (archetype === "foreman" && !(await isAssigned(ctx, jobId))) return [];
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select a.summary, a.created_at::text as created_at, u.full_name
      from public.activity a
      left join public.user_profile u on u.id = a.actor_user_id
      where a.org_id = ${ctx.orgId} and a.entity_type = 'job' and a.entity_id = ${jobId}
      order by a.created_at desc
      limit ${Math.min(Math.max(limit, 1), 200)}
    `),
  )) as unknown as Array<{ summary: string; created_at: string; full_name: string | null }>;
  return rows.map((r) => ({ summary: r.summary, createdAt: r.created_at, actorName: r.full_name }));
}

/** The org's job custom-field definitions, visibility-filtered for the caller. */
export async function listJobFields(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<
  Array<{ key: string; type: string; labels: { en: string; ar: string }; required: boolean }>
> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select value from public.app_settings
      where org_id = ${ctx.orgId} and key = 'config.fields.job'
    `),
  )) as unknown as Array<{ value: FieldDefinitionSet | null }>;
  return (rows[0]?.value?.fields ?? [])
    .filter(
      (f) =>
        !f.retired && (f.visibility.length === 0 || (f.visibility as string[]).includes(archetype)),
    )
    .map((f) => ({ key: f.field_key, type: f.type, labels: f.labels, required: f.required }));
}

// ── job-scoped comment + photo upload (authz lives HERE, not the action) ─────
export async function addJobComment(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  body: string,
): Promise<void> {
  assertCan(archetype, "comments.create");
  // Foreman is assigned-scoped (F-6); the job must exist in-org for everyone.
  if (archetype === "foreman") {
    if (!(await isAssigned(ctx, jobId))) throw new ForbiddenError("comments.create");
  } else {
    const rows = (await withCtx(ctx, (tx) =>
      tx.execute(sql`select 1 as ok from public.job where org_id = ${ctx.orgId} and id = ${jobId}`),
    )) as unknown as Array<{ ok: number }>;
    if (rows.length === 0) throw new Error("job not found");
  }
  await createComment(ctx, { entityType: "job", entityId: jobId, body });
}

export async function signJobPhotoUpload(
  ctx: Ctx,
  archetype: RoleArchetype,
  accessToken: string,
  jobId: string,
  file: { name: string; mime: string; sizeBytes: number },
): Promise<SignedUpload> {
  // The job must exist in-org and (foreman) be ASSIGNED before we mint a
  // signed PUT — the Phase E class wall alone let a foreman attach to ANY job
  // (review fix, F-6 write scope).
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`select 1 as ok from public.job where org_id = ${ctx.orgId} and id = ${jobId}`),
  )) as unknown as Array<{ ok: number }>;
  if (rows.length === 0) throw new Error("job not found");
  if (archetype === "foreman" && !(await isAssigned(ctx, jobId))) {
    throw new ForbiddenError("reports.create");
  }
  return signUpload(ctx, archetype, accessToken, {
    accessClass: "job_media",
    attachedToType: "job",
    attachedToId: jobId,
    originalName: file.name,
    mime: file.mime,
    sizeBytes: file.sizeBytes,
  });
}

// ── module public surface re-exports (Bible §3.2) ────────────────────────────
export { computeProgress, displayProgress, currentStage } from "./progress";
export { isAssigned, isAssignedIn, assignedJobCondition } from "./assigned";
// H21 — work lifecycle, task micro-steps and dependencies (module surface).
export {
  WORK_CATEGORIES,
  WORK_TRANSITIONS,
  canTransition,
  isTerminalCategory,
  changeWorkStatus,
  reopenJob,
  setJobArchived,
  assertWorkMutableIn,
  WorkTransitionError,
  WorkReasonRequiredError,
  WorkImmutableError,
  type WorkCategory,
} from "./lifecycle";
export {
  addDependency,
  removeDependency,
  getTaskDependencies,
  blockerCountsForJob,
  countUnfinishedBlockersIn,
  DEPENDENCY_KINDS,
  DependencyCycleError,
  DependencyScopeError,
  TaskBlockedError,
  type DependencyEdge,
  type DependencyKind,
} from "./dependencies";
export {
  listWork,
  workCountsByCategory,
  getMyWork,
  getSchedule,
  getWorkload,
  workDashboardCounts,
  customerWork,
  seesWorkMoney,
  WORK_PRIORITIES,
  MY_WORK_BUCKETS,
  MY_WORK_PAGE_SIZE,
  MY_WORK_PREVIEW,
  type WorkRow,
  type WorkListFilters,
  type WorkPriority,
  type MyWorkView,
  type MyWorkBucket,
  type MyWorkBucketKey,
  type MyTask,
  type ScheduleItem,
  type ScheduleView,
  type WorkloadRow,
  type WorkDashboardCounts,
} from "./work";
export {
  listStages,
  startStage,
  requestStageCompletion,
  completeStage,
  reopenStage,
  type StageRow,
} from "./stages";
export {
  createTask,
  updateTask,
  updateTaskStatus,
  setTaskArchived,
  listJobTasks,
  getTask,
  TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_OPEN_STATUSES,
  MAX_TASK_DEPTH,
  TaskTransitionError,
  TaskChildrenOpenError,
  TaskDepthError,
  TaskReasonRequiredError,
  type TaskRow,
  type TaskStatus,
  type TaskPriority,
} from "./tasks";
export { addCrewMember, removeCrewMember, listCrew, type CrewRow } from "./crew";
export { getWeekView, type WeekJob } from "./week";
