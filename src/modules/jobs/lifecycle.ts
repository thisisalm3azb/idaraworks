/**
 * H21 — the work lifecycle: validated transitions, required reasons, terminal
 * immutability, authorized reopen, and archival that keeps history.
 *
 * The organization configures status KEYS and labels (config.status_set.job);
 * this file governs the STRUCTURE those keys map onto — the semantic categories
 * draft / active / on_hold / done / cancelled. Labels differ per organization,
 * structural meaning never does.
 *
 * Terminal work (done, cancelled) is operationally immutable: the only way back
 * is reopenJob, which requires the reopen permission and a written reason, and
 * which is audited like any other command.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { supersedeApprovalsForSubjectsIn } from "@/modules/approvals/service";
import { assertCan, ForbiddenError } from "@/platform/authz";
import { sql, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";

/** The structural lifecycle. Keys are org config; these categories are not. */
export const WORK_CATEGORIES = ["draft", "active", "on_hold", "done", "cancelled"] as const;
export type WorkCategory = (typeof WORK_CATEGORIES)[number];

/**
 * Legal category transitions. Leaving a terminal category is deliberately NOT
 * here: that is reopenJob's job, so every resurrection carries a reason and a
 * permission check rather than riding an ordinary status edit.
 */
export const WORK_TRANSITIONS: Record<WorkCategory, readonly WorkCategory[]> = {
  draft: ["draft", "active", "cancelled"],
  active: ["active", "on_hold", "done", "cancelled"],
  on_hold: ["on_hold", "active", "cancelled"],
  done: ["done"],
  cancelled: ["cancelled"],
};

export function isTerminalCategory(c: string): boolean {
  return c === "done" || c === "cancelled";
}

export function canTransition(from: string, to: string): boolean {
  const legal = WORK_TRANSITIONS[from as WorkCategory];
  return legal ? (legal as readonly string[]).includes(to) : false;
}

export class WorkTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`work cannot move from ${from} to ${to}`);
    this.name = "WorkTransitionError";
  }
}

export class WorkReasonRequiredError extends Error {
  constructor(public readonly category: string) {
    super(`a reason is required to move work to ${category}`);
    this.name = "WorkReasonRequiredError";
  }
}

export class WorkImmutableError extends Error {
  constructor(public readonly category: string) {
    super(`this work is ${category} and cannot be changed until it is reopened`);
    this.name = "WorkImmutableError";
  }
}

/** Terminal work rejects operational writes (tasks, dependencies, scheduling).
 * Callers pass the job id; the check runs inside their own transaction. */
export async function assertWorkMutableIn(
  tx: TenantTx,
  ctx: Ctx,
  jobId: string,
): Promise<{ statusCategory: string }> {
  const rows = (await tx.execute(sql`
    select status_category, archived from public.job
    where org_id = ${ctx.orgId} and id = ${jobId}
  `)) as unknown as Array<{ status_category: string; archived: boolean }>;
  const job = rows[0];
  if (!job) throw new Error("job not found");
  if (job.archived) throw new WorkImmutableError("archived");
  if (isTerminalCategory(job.status_category)) throw new WorkImmutableError(job.status_category);
  return { statusCategory: job.status_category };
}

export const StatusChangeInput = z.object({
  statusKey: z.string().trim().min(1).max(40),
  /** Required when the target category is on_hold or cancelled. */
  reason: z.string().trim().min(1).max(500).optional(),
});

/**
 * The validated lifecycle move. Replaces the unguarded status write: the target
 * status must exist in the organization's own set, the category transition must
 * be legal, holds and cancellations must explain themselves, and terminal work
 * refuses to move at all (reopenJob is the only way back).
 */
export async function changeWorkStatus(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  input: unknown,
): Promise<{ from: string; to: string }> {
  assertCan(archetype, "jobs.edit");
  const data = StatusChangeInput.parse(input);
  return command(
    ctx,
    {
      audit: (r: { reference: string; from: string; to: string }) => ({
        action: "job.status",
        entityType: "job" as const,
        entityId: jobId,
        summary: `${r.reference}: ${r.from} -> ${r.to}`,
      }),
      activity: (r: { reference: string; to: string }) => ({
        entityType: "job" as const,
        entityId: jobId,
        verb: "moved",
        summary: `moved ${r.reference} to ${r.to}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select reference, status_key, status_category, archived
        from public.job
        where org_id = ${ctx.orgId} and id = ${jobId}
        for update
      `)) as unknown as Array<{
        reference: string;
        status_key: string;
        status_category: string;
        archived: boolean;
      }>;
      const job = rows[0];
      if (!job) throw new Error("job not found");
      if (job.archived) throw new WorkImmutableError("archived");

      const sets = (await tx.execute(sql`
        select value from public.app_settings
        where org_id = ${ctx.orgId} and key = 'config.status_set.job'
      `)) as unknown as Array<{
        value: { statuses: Array<{ status_key: string; semantic_category: string }> } | null;
      }>;
      const target = (sets[0]?.value?.statuses ?? []).find((x) => x.status_key === data.statusKey);
      if (!target) throw new Error(`unknown status "${data.statusKey}"`);

      const to = target.semantic_category;
      if (!canTransition(job.status_category, to)) {
        throw new WorkTransitionError(job.status_category, to);
      }
      if ((to === "on_hold" || to === "cancelled") && !data.reason) {
        throw new WorkReasonRequiredError(to);
      }

      // Reasons are written for the category being ENTERED and cleared when the
      // work leaves that state, so a stale explanation never lingers.
      await tx.execute(sql`
        update public.job
        set status_key = ${data.statusKey},
            status_category = ${to},
            on_hold_reason = ${to === "on_hold" ? (data.reason ?? null) : null},
            cancellation_reason = ${to === "cancelled" ? (data.reason ?? null) : null},
            completed_date = ${to === "done" ? sql`coalesce(completed_date, current_date)` : sql`completed_date`},
            updated_at = now()
        where org_id = ${ctx.orgId} and id = ${jobId}
      `);

      // H21.1: cancelling the work closes every question still open inside it.
      // Left pending, an approval on a step of cancelled work could still be
      // approved — and the engine's subject write is guarded on the STEP's status,
      // not the job's, so it would have completed a step on work that is supposed
      // to be immutable. Same transaction as the cancellation.
      if (to === "cancelled") {
        const open = (await tx.execute(sql`
          select id::text as id from public.task
          where org_id = ${ctx.orgId} and job_id = ${jobId} and status = 'awaiting_approval'
        `)) as unknown as Array<{ id: string }>;
        await supersedeApprovalsForSubjectsIn(tx, ctx, {
          subjectType: "task_completion",
          subjectIds: open.map((r) => r.id),
          reason: data.reason ?? "The work was cancelled",
        });
      }
      return { reference: job.reference, from: job.status_category, to };
    },
  );
}

export const ReopenWorkInput = z.object({
  reason: z.string().trim().min(1).max(500),
  /** The status key the work returns to; must map to draft or active. */
  statusKey: z.string().trim().min(1).max(40),
});

/**
 * The authorized way back from done or cancelled. Requires jobs.reopen, a
 * written reason, and a target status whose category is draft or active. The
 * completion date is cleared so "actual completion" never claims a date the
 * work no longer has.
 */
export async function reopenJob(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "jobs.reopen");
  const data = ReopenWorkInput.parse(input);
  await command(
    ctx,
    {
      audit: (r: { reference: string; from: string }) => ({
        action: "job.reopen",
        entityType: "job" as const,
        entityId: jobId,
        summary: `Reopened ${r.reference} from ${r.from}: ${data.reason}`,
      }),
      activity: (r: { reference: string }) => ({
        entityType: "job" as const,
        entityId: jobId,
        verb: "reopened",
        summary: `reopened ${r.reference}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select reference, status_category, archived from public.job
        where org_id = ${ctx.orgId} and id = ${jobId}
        for update
      `)) as unknown as Array<{ reference: string; status_category: string; archived: boolean }>;
      const job = rows[0];
      if (!job) throw new Error("job not found");
      if (job.archived) throw new WorkImmutableError("archived");
      if (!isTerminalCategory(job.status_category)) {
        throw new WorkTransitionError(job.status_category, "reopened");
      }
      const sets = (await tx.execute(sql`
        select value from public.app_settings
        where org_id = ${ctx.orgId} and key = 'config.status_set.job'
      `)) as unknown as Array<{
        value: { statuses: Array<{ status_key: string; semantic_category: string }> } | null;
      }>;
      const target = (sets[0]?.value?.statuses ?? []).find((x) => x.status_key === data.statusKey);
      if (!target) throw new Error(`unknown status "${data.statusKey}"`);
      if (target.semantic_category !== "draft" && target.semantic_category !== "active") {
        throw new WorkTransitionError(job.status_category, target.semantic_category);
      }
      await tx.execute(sql`
        update public.job
        set status_key = ${data.statusKey},
            status_category = ${target.semantic_category},
            completed_date = null,
            cancellation_reason = null,
            on_hold_reason = null,
            updated_at = now()
        where org_id = ${ctx.orgId} and id = ${jobId}
      `);
      return { reference: job.reference, from: job.status_category };
    },
  );
}

/**
 * Archival hides work from working views. It destroys nothing: every record,
 * stage, task, report and audit row stays exactly where it was, and restoring
 * is a single authorized command.
 */
export async function setJobArchived(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  archived: boolean,
): Promise<void> {
  assertCan(archetype, "jobs.archive");
  await command(
    ctx,
    {
      audit: (r: { reference: string }) => ({
        action: archived ? "job.archive" : "job.restore",
        entityType: "job" as const,
        entityId: jobId,
        summary: `${archived ? "Archived" : "Restored"} ${r.reference}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select reference, status_category from public.job
        where org_id = ${ctx.orgId} and id = ${jobId}
        for update
      `)) as unknown as Array<{ reference: string; status_category: string }>;
      const job = rows[0];
      if (!job) throw new Error("job not found");
      // Archiving live work would hide something still being delivered.
      if (archived && !isTerminalCategory(job.status_category)) {
        throw new WorkTransitionError(job.status_category, "archived");
      }
      await tx.execute(sql`
        update public.job
        set archived = ${archived},
            archived_at = ${archived ? sql`now()` : sql`null`},
            archived_by = ${archived ? ctx.userId : null},
            updated_at = now()
        where org_id = ${ctx.orgId} and id = ${jobId}
      `);
      return { reference: job.reference };
    },
  );
}

/** Guard used by the pages: may this archetype act on this work at all? */
export function assertCanOperate(archetype: RoleArchetype, statusCategory: string): void {
  if (isTerminalCategory(statusCategory)) throw new WorkImmutableError(statusCategory);
  if (!archetype) throw new ForbiddenError("jobs.edit");
}
