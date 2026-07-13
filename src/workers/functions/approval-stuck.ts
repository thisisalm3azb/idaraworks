/**
 * E-03 evaluator stub (doc 04; doc 11 S4). Hourly age check on pending approvals.
 * PLATFORM sweep: discover orgs with a stuck pending approval via the platform-
 * guarded app.orgs_with_pending_approvals (0036) on a DEDICATED client (A-B5: the
 * shared pool is withCtx-only), then run the ORG-SCOPED evaluateStuckApprovals per
 * org (which emits exception/raised(approval_stuck) into the outbox). Per-org
 * isolation: one org's failure never aborts the sweep. The exception TABLE +
 * persistent dedup are S5 — this stub detects + emits; the facts accumulate on the
 * bus. Won't fire in production until Inngest is provisioned (owner action).
 */
import { cron } from "inngest";
import { inngest } from "@/platform/events";
import { createAppDb, sql, type Ctx } from "@/platform/tenancy";
import { evaluateStuckApprovals } from "@/modules/approvals/service";
import { logger } from "@/platform/logger";

const WARN_INTERVAL = "8 hours"; // the E-03 warning threshold (stub wall-clock)

export async function sweepStuckApprovals(
  requestId: string,
): Promise<{ orgs: number; raised: number }> {
  const { db, end } = createAppDb({ max: 1 });
  let orgs = 0;
  let raised = 0;
  try {
    const targets = (await db.execute(sql`
      select org_id::text as org_id, actor_user_id::text as actor_user_id
      from app.orgs_with_pending_approvals(${WARN_INTERVAL}::interval)
    `)) as unknown as Array<{ org_id: string; actor_user_id: string | null }>;
    for (const t of targets) {
      if (!t.actor_user_id) continue; // no owner to attribute the exception to
      const ctx: Ctx = {
        orgId: t.org_id,
        userId: t.actor_user_id,
        costPrivileged: false,
        pricePrivileged: false,
        requestId,
      };
      try {
        const res = await evaluateStuckApprovals(ctx);
        raised += res.raised;
        orgs++;
      } catch (err) {
        logger.error(
          { orgId: t.org_id, requestId, err: (err as Error).message },
          "approval-stuck: org sweep failed",
        );
      }
    }
  } finally {
    await end();
  }
  return { orgs, raised };
}

export const approvalStuckEvaluator = inngest.createFunction(
  { id: "approval-stuck-evaluator", retries: 1, triggers: [cron("0 * * * *")] }, // hourly, UTC
  async ({ runId }) => sweepStuckApprovals(`inngest-${runId}`),
);
