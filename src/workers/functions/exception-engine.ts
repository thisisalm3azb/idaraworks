/**
 * The S5 exception-engine workers (doc 04; doc 11 S5). Three pieces:
 *  - the SIGNAL materializer: consumes exception/raised (the S4 E-03 approval-stuck
 *    stub, the S2 F-5 billing-point reopen) and folds it into a real exception row;
 *  - the E-03 auto-clear: on approval/decided, resolves the stuck-approval row;
 *  - the NIGHTLY sweep (cron platform task, like approval-stuck): discovers orgs and
 *    per org runs the calendar-aware E-01/E-02/E-04 raise+clear pass AND the cost-
 *    rollup reconcile (drift alarm, doc 10 #49). Per-org isolation: one org's failure
 *    never aborts the sweep. Won't fire in production until Inngest is provisioned.
 */
import { cron } from "inngest";
import { inngest, EXCEPTION_RAISED, APPROVAL_DECIDED } from "@/platform/events";
import { defineOrgFunction } from "@/workers/harness";
import { createAppDb, sql, type Ctx } from "@/platform/tenancy";
import {
  materializeApprovalStuck,
  materializeBillingPointReopened,
  clearApprovalStuck,
  evaluateNightly,
} from "@/modules/exceptions/service";
import { reconcileOrgRollups } from "@/modules/costing/service";
import { logger } from "@/platform/logger";

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

/**
 * Nightly sweep. PLATFORM task: discover every org (+ an owner to attribute to) via
 * the platform-guarded app.orgs_for_exception_sweep on a DEDICATED client (A-B5),
 * then run the ORG-SCOPED evaluators + rollup reconcile per org.
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
        const ex = await evaluateNightly(ctx, clock);
        const rec = await reconcileOrgRollups(ctx);
        raised += ex.missing + ex.overdue + ex.blockers;
        drifted += rec.drifted;
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

export const exceptionNightlySweep = inngest.createFunction(
  { id: "exception-nightly-sweep", retries: 1, triggers: [cron("0 2 * * *")] }, // ~nightly, UTC
  async ({ runId }) => {
    const now = new Date();
    return sweepExceptions(`inngest-${runId}`, {
      asOf: now.toISOString().slice(0, 10),
      nowMs: now.getTime(),
    });
  },
);
