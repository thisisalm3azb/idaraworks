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

  // Entitlement gate (limit.active_jobs) — checked before the write tx; the
  // unique reference makes double-submit safe regardless.
  const limit = await getLimit(ctx, "limit.active_jobs");
  if (limit !== null) {
    const rows = (await withCtx(ctx, (tx) =>
      tx.execute(sql`
        select count(*)::int as n from public.job
        where org_id = ${ctx.orgId} and archived = false and status_category in ('draft', 'active', 'on_hold')
      `),
    )) as unknown as Array<{ n: number }>;
    if ((rows[0]?.n ?? 0) >= limit) throw new JobLimitError(limit);
  }

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
      // Preset (live), pattern config, and initial status resolve in-tx.
      const presets = (await tx.execute(sql`
        select code, retired_at from public.job_preset
        where org_id = ${ctx.orgId} and id = ${data.presetId}
      `)) as unknown as PresetRow[];
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

      await tx.execute(sql`
        insert into public.job
          (id, org_id, reference, name, preset_id, customer_id, status_key, status_category, created_by)
        values (${id}, ${ctx.orgId}, ${reference}, ${data.name}, ${data.presetId},
                ${data.customerId ?? null}, ${initial.status_key}, ${initial.semantic_category},
                ${ctx.userId})
      `);
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
};

export async function listJobs(ctx: Ctx, archetype: RoleArchetype): Promise<JobRow[]> {
  assertCan(archetype, "jobs.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select j.id::text as id, j.reference, j.name, j.status_key, j.status_category,
             p.code as preset_code, c.name as customer_name, j.created_at::text as created_at
      from public.job j
      left join public.job_preset p on p.id = j.preset_id
      left join public.customer c on c.id = j.customer_id
      where j.org_id = ${ctx.orgId} and j.archived = false
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

export async function getJob(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
): Promise<JobRow | null> {
  assertCan(archetype, "jobs.view");
  const rows = await listJobsById(ctx, jobId);
  return rows[0] ?? null;
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
