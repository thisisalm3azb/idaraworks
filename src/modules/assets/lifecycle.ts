/**
 * What happens to an asset while it is owned (H22E): inspections, maintenance,
 * downtime and the end of its life.
 *
 * The load-bearing decision here is what this module does NOT do.
 *
 * Maintenance work is a JOB, and its steps are TASKS — the ones H21 already made
 * canonical. `asset_maintenance_event` adds the asset dimension to that work; it
 * does not schedule, assign, or complete anything. Completing the job is what
 * completing the work means, and there is exactly one place that happens.
 *
 * Disposal runs through the platform's approval engine, so it inherits the same
 * routing, the same self-approval guard and the same audit trail as a purchase
 * order. Somebody proposes with a reason, somebody else decides, and a third act
 * records what actually happened — three steps because taking an owned thing off
 * the books with nobody accountable is precisely the failure to prevent.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import { command } from "@/platform/audit";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { submitForApproval } from "@/modules/approvals/service";
import type { RoleArchetype } from "@/platform/registries";
import { AssetError, AssetStateError } from "./register";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const CONDITION = z.enum(["new", "good", "fair", "poor", "unserviceable"]);

// ── Inspections ─────────────────────────────────────────────────────────────
export const RecordInspectionInput = z.object({
  assetId: z.string().uuid(),
  inspectedOn: DATE,
  kind: z
    .enum(["routine", "safety", "calibration", "pre_use", "handover", "incident"])
    .optional()
    .default("routine"),
  passed: z.boolean(),
  conditionFound: CONDITION,
  findings: z.string().trim().max(2000).optional(),
  nextDueOn: DATE.optional(),
  /** Work raised because of what was found. A canonical H21 job, never a new kind. */
  jobId: z.string().uuid().optional(),
  inspectedBy: z.string().uuid().optional(),
});

/**
 * Record an inspection, and let what was found update the asset's condition.
 *
 * A failed inspection does not automatically take the asset out of service —
 * that is a decision with consequences for whoever is using it, and it is made
 * by a person through setAssetStatus. What this does is make the finding
 * impossible to miss.
 */
export async function recordInspection(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "assets.maintain");
  const data = RecordInspectionInput.parse(input);
  const id = randomUUID();

  return command<{ id: string }>(
    ctx,
    {
      audit: {
        action: "asset.inspected",
        entityType: "asset",
        entityId: data.assetId,
        summary: `${data.kind} inspection ${data.passed ? "passed" : "FAILED"} (${data.conditionFound})`,
      },
    },
    async (tx) => {
      const asset = await liveAsset(tx, ctx, data.assetId);
      if (asset.status === "disposed") {
        throw new AssetStateError("a disposed asset cannot be inspected");
      }
      await tx.execute(sql`
        insert into public.asset_inspection
          (id, org_id, asset_id, inspected_on, inspected_by, kind, passed, condition_found,
           findings, next_due_on, job_id, recorded_by)
        values (${id}, ${ctx.orgId}, ${data.assetId}, ${data.inspectedOn}::date,
                ${data.inspectedBy ?? ctx.userId}, ${data.kind}, ${data.passed},
                ${data.conditionFound}, ${data.findings ?? null},
                ${data.nextDueOn ?? null}::date, ${data.jobId ?? null}, ${ctx.userId})
      `);
      // What the inspector found is the asset's condition now.
      await tx.execute(sql`
        update public.asset set condition = ${data.conditionFound}, updated_at = now()
        where id = ${data.assetId} and org_id = ${ctx.orgId}
      `);
      return { id };
    },
  );
}

// ── Maintenance schedules ───────────────────────────────────────────────────
export const CreateMaintenancePlanInput = z
  .object({
    assetId: z.string().uuid(),
    nameEn: z.string().trim().min(1).max(160),
    nameAr: z.string().trim().max(160).optional(),
    kind: z
      .enum(["preventive", "calibration", "inspection", "statutory"])
      .optional()
      .default("preventive"),
    intervalDays: z.number().int().positive().max(36500).optional(),
    intervalUsage: z.number().positive().optional(),
    usageUnit: z.string().trim().max(24).optional(),
    instructions: z.string().trim().max(4000).optional(),
    nextDueOn: DATE.optional(),
  })
  .refine((p) => p.intervalDays !== undefined || p.intervalUsage !== undefined, {
    message: "a schedule needs an interval — days, usage, or both",
  })
  .refine((p) => p.intervalUsage === undefined || p.usageUnit !== undefined, {
    message: "a usage interval needs a unit (hours, kilometres, cycles)",
  });

export async function createMaintenancePlan(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "assets.maintain");
  const data = CreateMaintenancePlanInput.parse(input);
  const id = randomUUID();

  return command<{ id: string }>(
    ctx,
    {
      audit: {
        action: "asset.maintenance_planned",
        entityType: "asset",
        entityId: data.assetId,
        summary: `Maintenance schedule "${data.nameEn}"`,
      },
    },
    async (tx) => {
      await liveAsset(tx, ctx, data.assetId);
      await tx.execute(sql`
        insert into public.asset_maintenance_plan
          (id, org_id, asset_id, name_en, name_ar, kind, interval_days, interval_usage,
           usage_unit, instructions, next_due_on, created_by)
        values (${id}, ${ctx.orgId}, ${data.assetId}, ${data.nameEn}, ${data.nameAr ?? null},
                ${data.kind}, ${data.intervalDays ?? null}, ${data.intervalUsage ?? null},
                ${data.usageUnit ?? null}, ${data.instructions ?? null},
                ${data.nextDueOn ?? null}::date, ${ctx.userId})
      `);
      return { id };
    },
  );
}

// ── Maintenance that actually happened ──────────────────────────────────────
export const RecordMaintenanceInput = z.object({
  assetId: z.string().uuid(),
  planId: z.string().uuid().optional(),
  kind: z
    .enum(["preventive", "corrective", "calibration", "inspection", "statutory"])
    .optional()
    .default("corrective"),
  /**
   * The canonical work this records. A JOB from H21, and optionally the TASK
   * within it — never a private work item.
   */
  jobId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  performedOn: DATE,
  performedBy: z.string().uuid().optional(),
  vendorSupplierId: z.string().uuid().optional(),
  costMinor: z.number().int().min(0).optional(),
  currency: z.enum(["AED", "SAR", "QAR", "KWD", "BHD", "OMR", "USD", "EUR"]).optional(),
  meterReading: z.number().min(0).optional(),
  notes: z.string().trim().max(2000).optional(),
  /** Roll the schedule forward by its interval. */
  advancePlan: z.boolean().optional().default(true),
});

/**
 * Record that maintenance was done, and move the schedule on.
 *
 * The task, if one is named, must belong to the job that is named — a task from
 * a different job would attach this asset's history to work it had nothing to do
 * with, and the composite key alone cannot see that.
 *
 * Advancing the plan uses the date the work was DONE, not today: a service
 * carried out late still resets the clock from when it happened, and one entered
 * late must not push the next one further out than it should be.
 */
export async function recordMaintenance(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string; nextDueOn: string | null }> {
  assertCan(archetype, "assets.maintain");
  const data = RecordMaintenanceInput.parse(input);
  const id = randomUUID();

  return command<{ id: string; nextDueOn: string | null }>(
    ctx,
    {
      audit: {
        action: "asset.maintained",
        entityType: "asset",
        entityId: data.assetId,
        summary: `${data.kind} maintenance recorded for ${data.performedOn}`,
      },
    },
    async (tx) => {
      const asset = await liveAsset(tx, ctx, data.assetId);
      if (asset.status === "disposed") {
        throw new AssetStateError("a disposed asset cannot be maintained");
      }
      if (data.taskId && !data.jobId) {
        throw new AssetError("name the job the task belongs to");
      }
      if (data.taskId && data.jobId) {
        const rows = (await tx.execute(sql`
          select 1 as ok from public.task
          where id = ${data.taskId} and org_id = ${ctx.orgId} and job_id = ${data.jobId}
        `)) as unknown as Array<{ ok: number }>;
        if (!rows[0]) {
          throw new AssetError("that task does not belong to that job");
        }
      }

      await tx.execute(sql`
        insert into public.asset_maintenance_event
          (id, org_id, asset_id, plan_id, kind, job_id, task_id, performed_on, performed_by,
           vendor_supplier_id, cost_minor, currency, meter_reading, notes, recorded_by)
        values (${id}, ${ctx.orgId}, ${data.assetId}, ${data.planId ?? null}, ${data.kind},
                ${data.jobId ?? null}, ${data.taskId ?? null}, ${data.performedOn}::date,
                ${data.performedBy ?? null}, ${data.vendorSupplierId ?? null},
                ${data.costMinor ?? null}, ${data.currency ?? null},
                ${data.meterReading ?? null}, ${data.notes ?? null}, ${ctx.userId})
      `);

      let nextDueOn: string | null = null;
      if (data.planId && data.advancePlan) {
        const rows = (await tx.execute(sql`
          update public.asset_maintenance_plan
          set last_done_on = ${data.performedOn}::date,
              next_due_on = case
                when interval_days is null then next_due_on
                else (${data.performedOn}::date + (interval_days || ' days')::interval)::date
              end,
              updated_at = now()
          where id = ${data.planId} and org_id = ${ctx.orgId} and asset_id = ${data.assetId}
          returning next_due_on::text as next_due_on
        `)) as unknown as Array<{ next_due_on: string | null }>;
        if (!rows[0]) throw new AssetError("that schedule does not belong to this asset");
        nextDueOn = rows[0].next_due_on;
      }
      return { id, nextDueOn };
    },
  );
}

// ── Downtime ────────────────────────────────────────────────────────────────
export const StartDowntimeInput = z.object({
  assetId: z.string().uuid(),
  startedAt: z.string().optional(),
  reason: z
    .enum([
      "breakdown",
      "maintenance",
      "awaiting_parts",
      "awaiting_approval",
      "inspection",
      "transport",
      "other",
    ])
    .optional()
    .default("breakdown"),
  detail: z.string().trim().max(1000).optional(),
});

/**
 * Start a spell of downtime.
 *
 * Downtime is not the same as maintenance. A machine waiting three weeks for a
 * part is unavailable the whole time and nobody is working on it; recording only
 * the two hours of repair would say it was available for the other twenty days.
 *
 * One open spell at a time, enforced by a partial unique index — an asset that
 * is already down cannot break again first.
 */
export async function startDowntime(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "assets.maintain");
  const data = StartDowntimeInput.parse(input);
  const id = randomUUID();

  return command<{ id: string }>(
    ctx,
    {
      audit: {
        action: "asset.downtime_started",
        entityType: "asset",
        entityId: data.assetId,
        summary: `Down: ${data.reason}`,
      },
    },
    async (tx) => {
      const asset = await liveAsset(tx, ctx, data.assetId);
      if (asset.status === "disposed") {
        throw new AssetStateError("a disposed asset cannot go down");
      }
      const open = (await tx.execute(sql`
        select id::text as id from public.asset_downtime
        where org_id = ${ctx.orgId} and asset_id = ${data.assetId} and ended_at is null
        for update
      `)) as unknown as Array<{ id: string }>;
      if (open[0]) {
        throw new AssetStateError("that asset is already down; close the open spell first");
      }
      await tx.execute(sql`
        insert into public.asset_downtime
          (id, org_id, asset_id, started_at, reason, detail, recorded_by)
        values (${id}, ${ctx.orgId}, ${data.assetId},
                coalesce(${data.startedAt ?? null}::timestamptz, now()),
                ${data.reason}, ${data.detail ?? null}, ${ctx.userId})
      `);
      return { id };
    },
  );
}

/** Close the open spell. The start never moves; only the end is written. */
export async function endDowntime(
  ctx: Ctx,
  archetype: RoleArchetype,
  assetId: string,
  opts: { endedAt?: string; maintenanceEventId?: string } = {},
): Promise<{ id: string; minutes: number }> {
  assertCan(archetype, "assets.maintain");

  return command<{ id: string; minutes: number }>(
    ctx,
    {
      audit: (r) => ({
        action: "asset.downtime_ended",
        entityType: "asset" as const,
        entityId: assetId,
        summary: `Back in service after ${r.minutes} minute(s) down`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.asset_downtime
        set ended_at = coalesce(${opts.endedAt ?? null}::timestamptz, now()),
            maintenance_event_id = coalesce(${opts.maintenanceEventId ?? null},
                                            maintenance_event_id),
            updated_at = now()
        where org_id = ${ctx.orgId} and asset_id = ${assetId} and ended_at is null
        returning id::text as id,
                  (extract(epoch from (ended_at - started_at)) / 60)::int as minutes
      `)) as unknown as Array<{ id: string; minutes: number }>;
      if (!rows[0]) throw new AssetStateError("that asset has no open downtime");
      return { id: rows[0].id, minutes: Number(rows[0].minutes) };
    },
  );
}

// ── Disposal ────────────────────────────────────────────────────────────────
export const RequestDisposalInput = z.object({
  assetId: z.string().uuid(),
  method: z.enum(["sale", "scrap", "donation", "trade_in", "write_off", "returned_to_lessor"]),
  reason: z.string().trim().min(1).max(1000),
  proposedProceedsMinor: z.number().int().min(0).optional(),
  currency: z.enum(["AED", "SAR", "QAR", "KWD", "BHD", "OMR", "USD", "EUR"]).optional(),
});

/**
 * Propose getting rid of something the organization owns.
 *
 * The request enters the ordinary approval engine, which means the person who
 * proposes it is not the person who decides it — the same guard that stops
 * somebody approving their own purchase order. A reason is required and is
 * carried onto the approval, because "why" is the whole substance of the
 * decision the approver is being asked to make.
 */
export async function requestDisposal(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string; reference: string; approvalId: string }> {
  assertCan(archetype, "assets.dispose");
  const data = RequestDisposalInput.parse(input);
  const id = randomUUID();

  return command<{ id: string; reference: string; approvalId: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "asset.disposal_requested",
        entityType: "asset" as const,
        entityId: data.assetId,
        summary: `Disposal ${r.reference} proposed (${data.method}): ${data.reason}`,
      }),
    },
    async (tx) => {
      const asset = await liveAsset(tx, ctx, data.assetId);
      if (asset.status === "disposed") {
        throw new AssetStateError("that asset has already been disposed of");
      }

      const seq = await allocateReference(tx, ctx, "asset_disposal", 1);
      const reference = formatRef("ADP", seq);

      await tx.execute(sql`
        insert into public.asset_disposal
          (id, org_id, asset_id, reference, method, reason, status,
           proposed_proceeds_minor, currency, requested_by)
        values (${id}, ${ctx.orgId}, ${data.assetId}, ${reference}, ${data.method}, ${data.reason},
                'submitted', ${data.proposedProceedsMinor ?? null}, ${data.currency ?? null},
                ${ctx.userId})
      `);

      const { approvalId, decided } = await submitForApproval(tx, ctx, {
        subjectType: "asset_disposal",
        subjectId: id,
        subjectSummary: {
          title: `Dispose of ${asset.asset_no} by ${data.method}`,
          amountMinor: data.proposedProceedsMinor ?? null,
        },
      });

      /*
       * An approval that decided itself has to move the request with it.
       *
       * The engine can auto-approve below a configured threshold, and it reports
       * that in `decided`. Discarding it left the request sitting at 'submitted'
       * with an approval already marked approved — and completeDisposal only
       * accepts 'approved', so the asset could never actually be disposed of.
       */
      if (decided) {
        await tx.execute(sql`
          update public.asset_disposal
          set status = 'approved', decided_by = ${ctx.userId}, decided_at = now(),
              updated_at = now()
          where id = ${id} and org_id = ${ctx.orgId} and status = 'submitted'
        `);
      }
      return { id, reference, approvalId };
    },
  );
}

export const CompleteDisposalInput = z.object({
  disposalId: z.string().uuid(),
  disposedOn: DATE,
  actualProceedsMinor: z.number().int().min(0).optional(),
  buyerName: z.string().trim().max(160).optional(),
});

/**
 * Carry out an APPROVED disposal, and take the asset off the register.
 *
 * The guard is the whole protection, in one statement: only an approved request
 * can complete, and completing moves it out of approved in the same update that
 * claims it — so a second call finds nothing to do rather than disposing twice.
 *
 * The asset becomes 'disposed', which the database makes final. It stays
 * readable forever; what it may not do is change.
 */
export async function completeDisposal(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string; assetId: string }> {
  assertCan(archetype, "assets.dispose");
  const data = CompleteDisposalInput.parse(input);

  return command<{ id: string; assetId: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "asset.disposed",
        entityType: "asset" as const,
        entityId: r.assetId,
        summary: `Disposal completed on ${data.disposedOn}`,
      }),
    },
    async (tx) => {
      /*
       * Read and validate BEFORE writing anything.
       *
       * Claiming the row first and checking afterwards made the friendly "a sale
       * has to record what it actually fetched" message unreachable: the very
       * UPDATE that claimed the row also wrote status='completed' with no
       * proceeds, which trips the CHECK constraint, so the caller got an opaque
       * 23514 instead of a sentence they could act on.
       */
      const pending = (await tx.execute(sql`
        select asset_id::text as asset_id, method, status
        from public.asset_disposal
        where id = ${data.disposalId} and org_id = ${ctx.orgId}
        for update
      `)) as unknown as Array<{ asset_id: string; method: string; status: string }>;
      if (!pending[0]) throw new AssetError("no such disposal in this organization");
      if (pending[0].status !== "approved") {
        throw new AssetStateError(
          `only an approved disposal can be completed (this one is ${pending[0].status})`,
        );
      }
      if (pending[0].method === "sale" && data.actualProceedsMinor === undefined) {
        throw new AssetError("a sale has to record what it actually fetched");
      }

      // The ASSET is locked too, so a concurrent status change cannot slip
      // between the two updates below and leave the disposal completed against
      // an asset that never moved.
      const asset = await liveAsset(tx, ctx, pending[0].asset_id);

      const claimed = (await tx.execute(sql`
        update public.asset_disposal
        set status = 'completed', completed_at = now(), completed_by = ${ctx.userId},
            disposed_on = ${data.disposedOn}::date,
            actual_proceeds_minor = ${data.actualProceedsMinor ?? null},
            buyer_name = ${data.buyerName ?? null}, updated_at = now()
        where id = ${data.disposalId} and org_id = ${ctx.orgId} and status = 'approved'
        returning asset_id::text as asset_id
      `)) as unknown as Array<{ asset_id: string }>;
      if (!claimed[0]) throw new AssetStateError("that disposal was completed by somebody else");

      /*
       * An asset must be retired before it is disposed of — the state machine
       * says so — so retire it here if nobody has. Both updates are checked:
       * an unchecked UPDATE that matches nothing would leave the disposal marked
       * completed against an asset still in service, and nothing would say so.
       */
      if (asset.status !== "retired" && asset.status !== "disposed") {
        const retired = (await tx.execute(sql`
          update public.asset
          set status = 'retired', retired_at = now(),
              retired_reason = coalesce(retired_reason, 'disposed'), updated_at = now()
          where id = ${asset.id} and org_id = ${ctx.orgId}
            and status not in ('retired', 'disposed')
          returning id::text as id
        `)) as unknown as Array<{ id: string }>;
        if (!retired[0]) throw new AssetStateError("that asset could not be retired for disposal");
      }
      const disposed = (await tx.execute(sql`
        update public.asset
        set status = 'disposed', disposed_at = now(),
            custodian_user_id = null, custodian_since = null, updated_at = now()
        where id = ${asset.id} and org_id = ${ctx.orgId} and status = 'retired'
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      if (!disposed[0]) {
        throw new AssetStateError("that asset was not in a state that could be disposed of");
      }
      return { id: data.disposalId, assetId: asset.id! };
    },
  );
}

/**
 * Put a withdrawn request again, or abandon it.
 *
 * The approval engine parks a withdrawn disposal back at 'draft'. Without a way
 * out of that state the asset was permanently undisposable — a request could be
 * withdrawn once and never replaced, because a second one collided with the
 * first on the "one live request" index and each attempt burned a reference
 * number. A state nothing can leave is a trap, not a state.
 */
export async function resubmitDisposal(
  ctx: Ctx,
  archetype: RoleArchetype,
  disposalId: string,
  reason?: string,
): Promise<{ id: string; approvalId: string }> {
  assertCan(archetype, "assets.dispose");

  return command<{ id: string; approvalId: string }>(
    ctx,
    {
      audit: {
        action: "asset.disposal_resubmitted",
        entityType: "asset",
        entityId: disposalId,
        summary: `Disposal put again${reason ? `: ${reason}` : ""}`,
      },
    },
    async (tx) => {
      const claimed = (await tx.execute(sql`
        update public.asset_disposal
        set status = 'submitted', updated_at = now()
        where id = ${disposalId} and org_id = ${ctx.orgId} and status = 'draft'
        returning asset_id::text as asset_id, method,
                  proposed_proceeds_minor::text as proposed_proceeds_minor
      `)) as unknown as Array<Record<string, string | null>>;
      if (!claimed[0]) {
        throw new AssetStateError("only a withdrawn disposal can be put again");
      }
      const asset = await liveAsset(tx, ctx, claimed[0].asset_id!);

      const { approvalId, decided } = await submitForApproval(tx, ctx, {
        subjectType: "asset_disposal",
        subjectId: disposalId,
        subjectSummary: {
          title: `Dispose of ${asset.asset_no} by ${claimed[0].method}`,
          amountMinor:
            claimed[0].proposed_proceeds_minor === null
              ? null
              : Number(claimed[0].proposed_proceeds_minor),
        },
      });
      if (decided) {
        await tx.execute(sql`
          update public.asset_disposal
          set status = 'approved', decided_by = ${ctx.userId}, decided_at = now(),
              updated_at = now()
          where id = ${disposalId} and org_id = ${ctx.orgId} and status = 'submitted'
        `);
      }
      return { id: disposalId, approvalId };
    },
  );
}

/** Abandon a request that will not be put again. Final, and it frees the asset. */
export async function cancelDisposal(
  ctx: Ctx,
  archetype: RoleArchetype,
  disposalId: string,
  reason: string,
): Promise<{ id: string }> {
  assertCan(archetype, "assets.dispose");
  if (!reason.trim()) throw new AssetError("abandoning a disposal needs a reason");

  return command<{ id: string }>(
    ctx,
    {
      audit: {
        action: "asset.disposal_cancelled",
        entityType: "asset",
        entityId: disposalId,
        summary: `Disposal abandoned: ${reason.trim()}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.asset_disposal
        set status = 'cancelled', cancelled_at = now(),
            decision_note = ${reason.trim()}, updated_at = now()
        where id = ${disposalId} and org_id = ${ctx.orgId} and status in ('draft', 'submitted')
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) {
        throw new AssetStateError("only a disposal that has not been decided can be abandoned");
      }
      return { id: disposalId };
    },
  );
}

/** The asset, if it exists here. Locked, so two lifecycle acts cannot interleave. */
async function liveAsset(
  tx: TenantTx,
  ctx: Ctx,
  assetId: string,
): Promise<Record<string, string | null>> {
  const rows = (await tx.execute(sql`
    select id::text as id, asset_no, status, condition
    from public.asset
    where id = ${assetId} and org_id = ${ctx.orgId}
    for update
  `)) as unknown as Array<Record<string, string | null>>;
  if (!rows[0]) throw new AssetError("no such asset in this organization");
  return rows[0];
}

// ── Reading ─────────────────────────────────────────────────────────────────
/**
 * What is due, and what is overdue.
 *
 * Bounded and organization scoped like everything else. A maintenance list is
 * exactly the sort of screen that grows without anybody noticing, so the cap is
 * explicit rather than a hope about fleet size.
 */
export async function listMaintenanceDue(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { withinDays?: number; limit?: number } = {},
): Promise<
  Array<{
    planId: string;
    assetId: string;
    assetNo: string;
    name: string;
    nextDueOn: string | null;
    overdue: boolean;
  }>
> {
  assertCan(archetype, "assets.view");
  const withinDays = Math.min(Math.max(opts.withinDays ?? 30, 0), 3650);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select p.id::text as plan_id, a.id::text as asset_id, a.asset_no, p.name_en,
             p.next_due_on::text as next_due_on,
             (p.next_due_on < current_date) as overdue
      from public.asset_maintenance_plan p
      join public.asset a on a.id = p.asset_id and a.org_id = p.org_id
      where p.org_id = ${ctx.orgId} and p.active
        and a.status not in ('retired', 'disposed')
        and p.next_due_on is not null
        -- Cast: a bare parameter arrives as , and 
        -- matches several operators, so Postgres refuses rather than guessing.
        and p.next_due_on <= current_date + ${withinDays}::int
      order by p.next_due_on, a.asset_no
      limit ${limit}
    `)) as unknown as Array<Record<string, string | boolean | null>>;
    return rows.map((r) => ({
      planId: String(r.plan_id),
      assetId: String(r.asset_id),
      assetNo: String(r.asset_no),
      name: String(r.name_en),
      nextDueOn: (r.next_due_on as string | null) ?? null,
      overdue: r.overdue === true,
    }));
  });
}

/** Downtime for one asset over a window, with the total it adds up to. */
export async function assetDowntime(
  ctx: Ctx,
  archetype: RoleArchetype,
  assetId: string,
  opts: { since?: string; limit?: number } = {},
): Promise<{
  spells: Array<Record<string, string | null>>;
  totalMinutes: number;
  totalSpells: number;
  /** True when the listed spells are only part of what the total covers. */
  truncated: boolean;
}> {
  assertCan(archetype, "assets.view");
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  return withCtx(ctx, async (tx) => {
    const spells = (await tx.execute(sql`
      select id::text as id, started_at::text as started_at, ended_at::text as ended_at,
             reason, detail,
             (extract(epoch from (coalesce(ended_at, now()) - started_at)) / 60)::int::text
               as minutes
      from public.asset_downtime
      where org_id = ${ctx.orgId} and asset_id = ${assetId}
        and (${opts.since ?? null}::timestamptz is null
             or started_at >= ${opts.since ?? null}::timestamptz)
      order by started_at desc
      limit ${limit}
    `)) as unknown as Array<Record<string, string | null>>;
    /*
     * The total is computed over EVERY spell, not over the page.
     *
     * Summing the returned rows meant an asset with more spells than the page
     * size reported a total that was simply the visible part — and it looked
     * exactly like a real number, which is worse than an obviously missing one.
     */
    const totals = (await tx.execute(sql`
      select
        coalesce(sum(extract(epoch from (coalesce(ended_at, now()) - started_at)) / 60), 0)::int
          as minutes,
        count(*)::int as spells
      from public.asset_downtime
      where org_id = ${ctx.orgId} and asset_id = ${assetId}
        and (${opts.since ?? null}::timestamptz is null
             or started_at >= ${opts.since ?? null}::timestamptz)
    `)) as unknown as Array<{ minutes: number; spells: number }>;

    return {
      spells,
      totalMinutes: Number(totals[0]?.minutes ?? 0),
      totalSpells: Number(totals[0]?.spells ?? 0),
      truncated: spells.length < Number(totals[0]?.spells ?? 0),
    };
  });
}
