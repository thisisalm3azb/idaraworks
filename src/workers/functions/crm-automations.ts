/**
 * H27 — daily CRM automation sweep. PLATFORM discovery through
 * app.orgs_with_crm_automations on a DEDICATED client (A-B5), then the
 * ORG-SCOPED runEnabledAutomations per organisation, so one organisation's
 * failure never aborts the sweep. Every run is idempotent per subject and
 * occurrence, so a retried or duplicated sweep applies nothing twice. When
 * Inngest is not configured this function simply never fires; automations
 * can still be run by hand from the studio.
 */
import { cron } from "inngest";
import { inngest } from "@/platform/events";
import { createAppDb, sql, type Ctx } from "@/platform/tenancy";
import { runEnabledAutomations } from "@/modules/crm/service";
import { logger } from "@/platform/logger";

export async function sweepCrmAutomations(
  requestId: string,
): Promise<{ orgs: number; automations: number; applied: number }> {
  const { db, end } = createAppDb({ max: 1 });
  let orgs = 0;
  let automations = 0;
  let applied = 0;
  try {
    const targets = (await db.execute(sql`
      select org_id::text as org_id, actor_user_id::text as actor_user_id
      from app.orgs_with_crm_automations()
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
        const res = await runEnabledAutomations(ctx);
        automations += res.automations;
        applied += res.applied;
        orgs++;
      } catch (err) {
        logger.error(
          { orgId: t.org_id, requestId, err: (err as Error).message },
          "crm-automations: org sweep failed",
        );
      }
    }
  } finally {
    await end();
  }
  return { orgs, automations, applied };
}

export const crmAutomationSweep = inngest.createFunction(
  { id: "crm-automation-sweep", retries: 1, triggers: [cron("15 4 * * *")] }, // daily 04:15 UTC
  async ({ runId }) => sweepCrmAutomations(`inngest-${runId}`),
);
