/**
 * The exception-engine workers (doc 04; S5 + S7). Pieces:
 *  - the SIGNAL materializer: consumes exception/raised (S4 E-03 stub, S2 F-5 reopen);
 *  - the E-03 auto-clear on approval/decided;
 *  - E-08 unusual-expense on expense/created + self-clear on expense/voided (S7 event lane);
 *  - the NIGHTLY work, S7-refactored from a tenant-wide HERD into a STAGGERED FAN-OUT:
 *      · exceptionNightlyDispatch (cron platform task) discovers every org on a dedicated
 *        client and sends ONE org-scoped nightly/org_due event per org, delayed by a
 *        DETERMINISTIC per-org offset so the fleet spreads across the night window instead
 *        of all firing at ~03:00 (audit F-31; GCC tenants share UTC+3/4);
 *      · nightlyOrgRun (defineOrgFunction, concurrency-capped) runs ONE org's evaluators +
 *        rollup reconcile — idempotent (dedup upsert + recompute), so a duplicate delivery
 *        or retry is safe;
 *      · sweepExceptions stays as the DIRECT/on-demand path (tests, prod demo, manual).
 * Won't fire in production until Inngest is provisioned (owner action) — the seam is dormant
 * but the structure is correct.
 */
import { cron } from "inngest";
import {
  inngest,
  EXCEPTION_RAISED,
  APPROVAL_DECIDED,
  EXPENSE_CREATED,
  EXPENSE_VOIDED,
  NIGHTLY_ORG_DUE,
} from "@/platform/events";
import { defineOrgFunction } from "@/workers/harness";
import { createAppDb, sql, type Ctx } from "@/platform/tenancy";
import {
  materializeApprovalStuck,
  materializeBillingPointReopened,
  clearApprovalStuck,
  evaluateNightly,
  evaluateExpenseAnomaly,
} from "@/modules/exceptions/service";
import { reconcileOrgRollups } from "@/modules/costing/service";
import { composeOwnerDigest } from "@/modules/digest/service";
import { logger } from "@/platform/logger";

// The night window across which per-org runs are spread, and how many run at once.
const NIGHT_WINDOW_MINUTES = 240; // ~03:00–07:00 local spread (config-tunable later)
const NIGHTLY_CONCURRENCY = 10;

/**
 * Deterministic per-org stagger offset (seconds into the night window). Pure + total,
 * so two identical dispatch runs place an org at the same slot and unit tests can assert
 * the spread. FNV-1a over the org id, modulo the window.
 */
export function computeStaggerSeconds(orgId: string, windowMinutes: number): number {
  let h = 2166136261;
  for (let i = 0; i < orgId.length; i++) {
    h ^= orgId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const windowSeconds = Math.max(1, windowMinutes * 60);
  return Math.abs(h) % windowSeconds;
}

export const exceptionSignalMaterializer = defineOrgFunction(
  { id: "exception-signal-materializer", event: EXCEPTION_RAISED },
  async ({ payload, ctx }) => {
    if (payload.kind === "approval_stuck" && payload.subjectId) {
      return materializeApprovalStuck(ctx, {
        approvalId: payload.subjectId,
        severity: payload.severity ?? "warning",
      });
    }
    if (payload.kind === "billing_point_reopened" && payload.jobId && payload.stageKey) {
      return materializeBillingPointReopened(ctx, {
        jobId: payload.jobId,
        stageKey: payload.stageKey,
      });
    }
    return { created: false };
  },
);

export const exceptionClearOnApprovalDecided = defineOrgFunction(
  { id: "exception-clear-on-approval-decided", event: APPROVAL_DECIDED },
  async ({ payload, ctx }) => {
    await clearApprovalStuck(ctx, payload.approvalId);
    return { cleared: payload.approvalId };
  },
);

// E-08 unusual expense: raise on create, self-clear on void (idempotent by dedup key).
export const expenseAnomalyOnCreate = defineOrgFunction(
  { id: "expense-anomaly-on-create", event: EXPENSE_CREATED },
  async ({ payload, ctx }) => evaluateExpenseAnomaly(ctx, payload.expenseId),
);
export const expenseAnomalyOnVoid = defineOrgFunction(
  { id: "expense-anomaly-on-void", event: EXPENSE_VOIDED },
  async ({ payload, ctx }) => evaluateExpenseAnomaly(ctx, payload.expenseId),
);

/**
 * The per-org nightly unit — every rule evaluator + the rollup reconcile for ONE org.
 * Idempotent: evaluateNightly upserts by dedup key and self-heals from scratch, and the
 * reconcile recomputes; a duplicate delivery or a retry re-derives the same state.
 */
export async function runOrgNightly(
  ctx: Ctx,
  clock: { asOf: string; nowMs: number },
): Promise<{ raised: number; drifted: number; digestSections: number }> {
  const ex = await evaluateNightly(ctx, clock);
  const rec = await reconcileOrgRollups(ctx);
  // Compose the owner digest AFTER the evaluators so it reflects this morning's exceptions.
  const digest = await composeOwnerDigest(ctx, clock.asOf);
  const raised =
    ex.missing +
    ex.overdue +
    ex.blockers +
    ex.billing +
    ex.marginDrift +
    ex.lateSupplier +
    ex.documentExpiry;
  return { raised, drifted: rec.drifted, digestSections: digest.sections };
}

/**
 * DIRECT / on-demand sweep (tests, prod demo, manual). PLATFORM task: discover every org
 * on a DEDICATED client (A-B5), then run each org serially. Production scheduling uses the
 * staggered fan-out below; this path is the synchronous one used where a single call must
 * process the whole fleet.
 */
export async function sweepExceptions(
  requestId: string,
  clock: { asOf: string; nowMs: number },
): Promise<{ orgs: number; raised: number; drifted: number }> {
  const { db, end } = createAppDb({ max: 1 });
  let orgs = 0;
  let raised = 0;
  let drifted = 0;
  try {
    const targets = (await db.execute(sql`
      select org_id::text as org_id, actor_user_id::text as actor_user_id
      from app.orgs_for_exception_sweep()
    `)) as unknown as Array<{ org_id: string; actor_user_id: string | null }>;
    for (const t of targets) {
      if (!t.actor_user_id) continue;
      const ctx: Ctx = {
        orgId: t.org_id,
        userId: t.actor_user_id,
        costPrivileged: false,
        pricePrivileged: false,
        requestId,
      };
      try {
        const res = await runOrgNightly(ctx, clock);
        raised += res.raised;
        drifted += res.drifted;
        orgs++;
      } catch (err) {
        logger.error(
          { orgId: t.org_id, requestId, err: (err as Error).message },
          "exception sweep: org failed",
        );
      }
    }
  } finally {
    await end();
  }
  return { orgs, raised, drifted };
}

/**
 * PRODUCTION scheduling: the cron platform task fans out ONE staggered org-scoped event per
 * org instead of processing the fleet in a single herd invocation. Each event is delayed by
 * the org's deterministic offset (ts) and deduped by (org, asOf) so a re-dispatch the same
 * night can't double-run. Dormant until Inngest is provisioned.
 */
export async function dispatchNightly(clock: {
  asOf: string;
  nowMs: number;
}): Promise<{ dispatched: number }> {
  const { db, end } = createAppDb({ max: 1 });
  let dispatched = 0;
  try {
    const targets = (await db.execute(sql`
      select org_id::text as org_id, actor_user_id::text as actor_user_id
      from app.orgs_for_exception_sweep()
    `)) as unknown as Array<{ org_id: string; actor_user_id: string | null }>;
    for (const t of targets) {
      if (!t.actor_user_id) continue;
      const offsetSec = computeStaggerSeconds(t.org_id, NIGHT_WINDOW_MINUTES);
      await inngest.send({
        name: NIGHTLY_ORG_DUE,
        data: {
          orgId: t.org_id,
          actorUserId: t.actor_user_id,
          asOf: clock.asOf,
          nowMs: clock.nowMs,
        },
        // Deterministic per-night dedup so a re-dispatch can't double-enqueue an org.
        id: `nightly-${t.org_id}-${clock.asOf}`,
        // Spread across the night window (Inngest schedules delivery at this ts).
        ts: clock.nowMs + offsetSec * 1000,
      });
      dispatched++;
    }
  } finally {
    await end();
  }
  return { dispatched };
}

export const exceptionNightlyDispatch = inngest.createFunction(
  { id: "exception-nightly-dispatch", retries: 1, triggers: [cron("0 0 * * *")] }, // ~00:00 UTC, then staggered
  async ({ runId }) => {
    const now = new Date();
    return dispatchNightly({ asOf: now.toISOString().slice(0, 10), nowMs: now.getTime() });
  },
);

// The per-org child: concurrency-capped so the fleet stays inside the night window.
export const nightlyOrgRun = defineOrgFunction(
  { id: "nightly-org-run", event: NIGHTLY_ORG_DUE, retries: 2, concurrency: NIGHTLY_CONCURRENCY },
  async ({ payload, ctx }) => runOrgNightly(ctx, { asOf: payload.asOf, nowMs: payload.nowMs }),
);
