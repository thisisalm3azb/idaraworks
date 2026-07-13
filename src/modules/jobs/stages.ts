/**
 * Stage lifecycle (doc 01 job_stage; doc 06 grid). Transitions:
 *   not_started → in_progress (startStage: manager+, or foreman on ASSIGNED)
 *   in_progress → completed   (completeStage: manager+ ONLY; guard-slot-ready)
 *   completed   → in_progress (reopenStage: manager+, REQUIRED reason — F-5)
 * Foreman contribution is REQUEST-complete (doc 06 "C (assigned;
 * request-complete)"): stamps the request, notifies via activity; completion
 * stays a manager act. The P3 QC gate strengthens completeStage's guard slot.
 * Every transition recomputes the sanctioned current_stage_id denormalisation.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, ForbiddenError } from "@/platform/authz";
import { EXCEPTION_RAISED, JOB_STAGE_COMPLETED, JOB_STAGE_REOPENED } from "@/platform/events";
import type { EventSpec } from "@/platform/events/outbox";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { isAssignedIn } from "./assigned";
import { currentStage, type StageForProgress } from "./progress";

export type StageRow = {
  id: string;
  stageKey: string;
  name: { en: string; ar: string };
  weight: number;
  sort: number;
  status: StageForProgress["status"];
  startedAt: string | null;
  completedAt: string | null;
  completionRequestedAt: string | null;
  notes: string | null;
};

export async function listStages(ctx: Ctx, jobId: string): Promise<StageRow[]> {
  const rows = (await withCtx(ctx, (tx) => stageRowsIn(tx, ctx, jobId))) as StageRawRow[];
  return rows.map(mapStage);
}

type StageRawRow = {
  id: string;
  stage_key: string;
  name: { en: string; ar: string };
  weight: number;
  sort: number;
  status: StageForProgress["status"];
  started_at: string | null;
  completed_at: string | null;
  completion_requested_at: string | null;
  notes: string | null;
};

async function stageRowsIn(tx: TenantTx, ctx: Ctx, jobId: string): Promise<StageRawRow[]> {
  return (await tx.execute(sql`
    select id::text as id, stage_key, name, weight, sort, status,
           started_at::text as started_at, completed_at::text as completed_at,
           completion_requested_at::text as completion_requested_at, notes
    from public.job_stage
    where org_id = ${ctx.orgId} and job_id = ${jobId}
    order by sort
  `)) as unknown as StageRawRow[];
}

function mapStage(r: StageRawRow): StageRow {
  return {
    id: r.id,
    stageKey: r.stage_key,
    name: r.name,
    weight: r.weight,
    sort: r.sort,
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    completionRequestedAt: r.completion_requested_at,
    notes: r.notes,
  };
}

/** Recompute job.current_stage_id from the (already-updated) stage rows. */
async function recomputeCurrentStageIn(tx: TenantTx, ctx: Ctx, jobId: string): Promise<void> {
  const rows = await stageRowsIn(tx, ctx, jobId);
  const cur = currentStage(
    rows.map((r) => ({ status: r.status, weight: r.weight, sort: r.sort, id: r.id })),
  );
  await tx.execute(sql`
    update public.job set current_stage_id = ${cur?.id ?? null}, updated_at = now()
    where org_id = ${ctx.orgId} and id = ${jobId}
  `);
}

type StageTarget = { id: string; stage_key: string; status: string; job_id: string };

async function loadStageIn(tx: TenantTx, ctx: Ctx, stageId: string): Promise<StageTarget> {
  // FOR UPDATE serializes concurrent transitions on the SAME stage (review
  // fix — two managers completing/reopening at once must not both pass the
  // precondition and each emit an event); the status re-check in every UPDATE
  // WHERE is the second belt (a mismatched status yields 0 rows → we throw).
  const rows = (await tx.execute(sql`
    select id::text as id, stage_key, status, job_id::text as job_id
    from public.job_stage where org_id = ${ctx.orgId} and id = ${stageId}
    for update
  `)) as unknown as StageTarget[];
  const stage = rows[0];
  if (!stage) throw new Error("stage not found");
  return stage;
}

/** Foreman path requires assignment (F-6); managers+ pass without it. */
async function assertStageActorIn(
  tx: TenantTx,
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
): Promise<void> {
  if (archetype === "foreman" && !(await isAssignedIn(tx, ctx, jobId))) {
    throw new ForbiddenError("stages.request_complete");
  }
}

export async function startStage(
  ctx: Ctx,
  archetype: RoleArchetype,
  stageId: string,
): Promise<void> {
  // Foreman may START work on an assigned job (the contribute grant);
  // managers+ hold stages.update outright.
  assertCan(archetype, archetype === "foreman" ? "stages.request_complete" : "stages.update");
  await command(
    ctx,
    {
      audit: (r: { stageKey: string; jobId: string }) => ({
        action: "job_stage.start",
        entityType: "job_stage" as const,
        entityId: stageId,
        summary: `Started stage ${r.stageKey}`,
      }),
      activity: (r: { stageKey: string; jobId: string }) => ({
        entityType: "job" as const,
        entityId: r.jobId,
        verb: "started",
        summary: `started stage ${r.stageKey}`,
      }),
    },
    async (tx) => {
      const stage = await loadStageIn(tx, ctx, stageId);
      await assertStageActorIn(tx, ctx, archetype, stage.job_id);
      if (stage.status !== "not_started") throw new Error(`cannot start a ${stage.status} stage`);
      await tx.execute(sql`
        update public.job_stage
        set status = 'in_progress', started_at = now(), updated_at = now()
        where org_id = ${ctx.orgId} and id = ${stageId}
      `);
      await recomputeCurrentStageIn(tx, ctx, stage.job_id);
      return { stageKey: stage.stage_key, jobId: stage.job_id };
    },
  );
}

export async function requestStageCompletion(
  ctx: Ctx,
  archetype: RoleArchetype,
  stageId: string,
): Promise<void> {
  assertCan(archetype, "stages.request_complete");
  await command(
    ctx,
    {
      audit: (r: { stageKey: string; jobId: string }) => ({
        action: "job_stage.request_complete",
        entityType: "job_stage" as const,
        entityId: stageId,
        summary: `Requested completion of stage ${r.stageKey}`,
      }),
      activity: (r: { stageKey: string; jobId: string }) => ({
        entityType: "job" as const,
        entityId: r.jobId,
        verb: "requested",
        summary: `requested completion of stage ${r.stageKey}`,
      }),
    },
    async (tx) => {
      const stage = await loadStageIn(tx, ctx, stageId);
      await assertStageActorIn(tx, ctx, archetype, stage.job_id);
      if (stage.status !== "in_progress") {
        throw new Error("only an in-progress stage can be submitted for completion");
      }
      await tx.execute(sql`
        update public.job_stage
        set completion_requested_by = ${ctx.userId}, completion_requested_at = now(),
            updated_at = now()
        where org_id = ${ctx.orgId} and id = ${stageId}
      `);
      return { stageKey: stage.stage_key, jobId: stage.job_id };
    },
  );
}

/**
 * Completion — manager+ only; the GUARD SLOT runs here (S2 guard = none;
 * the P3 QC gate plugs in without changing the transition — doc 01).
 */
export async function completeStage(
  ctx: Ctx,
  archetype: RoleArchetype,
  stageId: string,
): Promise<void> {
  assertCan(archetype, "stages.update");
  await command(
    ctx,
    {
      audit: (r: { stageKey: string }) => ({
        action: "job_stage.complete",
        entityType: "job_stage" as const,
        entityId: stageId,
        summary: `Completed stage ${r.stageKey}`,
      }),
      activity: (r: { stageKey: string; jobId: string }) => ({
        entityType: "job" as const,
        entityId: r.jobId,
        verb: "completed",
        summary: `completed stage ${r.stageKey}`,
      }),
      events: (r: { stageKey: string; jobId: string }) => [
        {
          name: JOB_STAGE_COMPLETED,
          payload: {
            orgId: ctx.orgId,
            actorUserId: ctx.userId,
            jobId: r.jobId,
            stageId,
            stageKey: r.stageKey,
          },
        },
      ],
    },
    async (tx) => {
      const stage = await loadStageIn(tx, ctx, stageId);
      if (stage.status !== "in_progress") {
        throw new Error("only an in-progress stage can be completed");
      }
      // ── guard slot (P3: QC gate E-15 evaluates here) ──
      await tx.execute(sql`
        update public.job_stage
        set status = 'completed', completed_at = now(),
            completion_requested_by = null, completion_requested_at = null,
            updated_at = now()
        where org_id = ${ctx.orgId} and id = ${stageId}
      `);
      await recomputeCurrentStageIn(tx, ctx, stage.job_id);
      return { stageKey: stage.stage_key, jobId: stage.job_id };
    },
  );
}

export const ReopenInput = z.object({
  reason: z.string().trim().min(1).max(500), // REQUIRED (F-5)
});

/** Reopen completed → in_progress; reason required; billing-point reopen
 * raises the placeholder exception event (F-5) — never claws back anything. */
export async function reopenStage(
  ctx: Ctx,
  archetype: RoleArchetype,
  stageId: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "stages.reopen");
  const { reason } = ReopenInput.parse(input);
  await command(
    ctx,
    {
      audit: (r: { stageKey: string }) => ({
        action: "job_stage.reopen",
        entityType: "job_stage" as const,
        entityId: stageId,
        summary: `Reopened stage ${r.stageKey}: ${reason}`,
      }),
      activity: (r: { stageKey: string; jobId: string }) => ({
        entityType: "job" as const,
        entityId: r.jobId,
        verb: "reopened",
        summary: `reopened stage ${r.stageKey} — ${reason}`,
      }),
      events: (r: { stageKey: string; jobId: string; billingPointHit: boolean }) => {
        const events: EventSpec[] = [
          {
            name: JOB_STAGE_REOPENED,
            payload: {
              orgId: ctx.orgId,
              actorUserId: ctx.userId,
              jobId: r.jobId,
              stageId,
              stageKey: r.stageKey,
              reason,
            },
          },
        ];
        if (r.billingPointHit) {
          events.push({
            name: EXCEPTION_RAISED,
            payload: {
              orgId: ctx.orgId,
              actorUserId: ctx.userId,
              kind: "billing_point_reopened",
              jobId: r.jobId,
              stageKey: r.stageKey,
            },
          });
        }
        return events;
      },
    },
    async (tx) => {
      const stage = await loadStageIn(tx, ctx, stageId);
      if (stage.status !== "completed") throw new Error("only a completed stage can be reopened");
      // Billing-point check (F-5): is this stage a billing trigger on the job?
      const jobs = (await tx.execute(sql`
        select billing_points from public.job
        where org_id = ${ctx.orgId} and id = ${stage.job_id}
      `)) as unknown as Array<{
        billing_points: Array<{ trigger: string | { stage_key: string } }>;
      }>;
      const billingPointHit = (jobs[0]?.billing_points ?? []).some(
        (bp) => typeof bp.trigger === "object" && bp.trigger.stage_key === stage.stage_key,
      );
      await tx.execute(sql`
        update public.job_stage
        set status = 'in_progress', completed_at = null, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${stageId}
      `);
      await recomputeCurrentStageIn(tx, ctx, stage.job_id);
      return { stageKey: stage.stage_key, jobId: stage.job_id, billingPointHit };
    },
  );
}
