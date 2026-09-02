/**
 * H26H — daily reminder sweep for document obligations and expiring
 * documents. PLATFORM discovery through app.orgs_with_due_documents on a
 * DEDICATED client (A-B5), then the ORG-SCOPED sendDueReminders per org, so
 * one organisation's failure never aborts the sweep. Reminders are also
 * computed on read (due states in the obligations screens), so the product
 * does not depend on this worker being provisioned; when Inngest is not
 * configured this function simply never fires.
 */
import { cron } from "inngest";
import { inngest } from "@/platform/events";
import { createAppDb, sql, type Ctx } from "@/platform/tenancy";
import { sendDueReminders } from "@/modules/docstudio/service";
import { logger } from "@/platform/logger";

const LOOKAHEAD_DAYS = 365;

export async function sweepDocumentReminders(
  requestId: string,
): Promise<{ orgs: number; reminders: number }> {
  const { db, end } = createAppDb({ max: 1 });
  let orgs = 0;
  let reminders = 0;
  try {
    const targets = (await db.execute(sql`
      select org_id::text as org_id, actor_user_id::text as actor_user_id
      from app.orgs_with_due_documents(${LOOKAHEAD_DAYS}::integer)
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
        const res = await sendDueReminders(ctx);
        reminders += res.sent;
        orgs++;
      } catch (err) {
        logger.error(
          { orgId: t.org_id, requestId, err: (err as Error).message },
          "doc-reminders: org sweep failed",
        );
      }
    }
  } finally {
    await end();
  }
  return { orgs, reminders };
}

export const docObligationReminders = inngest.createFunction(
  { id: "doc-obligation-reminders", retries: 1, triggers: [cron("30 4 * * *")] }, // daily 04:30 UTC
  async ({ runId }) => sweepDocumentReminders(`inngest-${runId}`),
);
