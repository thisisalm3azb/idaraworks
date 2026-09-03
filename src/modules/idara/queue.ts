/**
 * H28 — background execution of queued runs (ADR-59).
 *
 * Platform discovery (dedicated client, `app.ai_queued_runs`, guarded by
 * `app.assert_platform_task`) names the queued runs and their requesters;
 * each run then executes under the REQUESTER's own organisation context and
 * archetype (never with cost or price privilege), so background work has
 * exactly the authority the person had when they asked. One run's failure
 * never aborts the batch. Called by the Inngest cron when Inngest is
 * configured and by the authenticated cron route otherwise.
 */
import { idaraEnabled } from "@/platform/flags";
import { normalizeLocale } from "@/platform/i18n";
import { logger } from "@/platform/logger";
import type { RoleArchetype } from "@/platform/registries";
import { createAppDb, sql, withCtx, type Ctx } from "@/platform/tenancy";
import { executeRun } from "./runs";

export type IdaraRunSweep = {
  discovered: number;
  executed: number;
  failed: number;
  skipped: number;
};

export async function executeQueuedIdaraRuns(
  requestId: string,
  limit = 20,
): Promise<IdaraRunSweep> {
  const out: IdaraRunSweep = { discovered: 0, executed: 0, failed: 0, skipped: 0 };
  if (!idaraEnabled()) return out;
  const { db, end } = createAppDb({ max: 1 });
  try {
    const rows = (await db.execute(
      sql`select id::text as id, org_id::text as org_id, requested_by::text as requested_by from app.ai_queued_runs(${limit})`,
    )) as unknown as Array<{ id: string; org_id: string; requested_by: string }>;
    out.discovered = rows.length;
    for (const r of rows) {
      const ctx: Ctx = {
        orgId: r.org_id,
        userId: r.requested_by,
        costPrivileged: false,
        pricePrivileged: false,
        requestId,
      };
      try {
        const who = (await withCtx(ctx, (tx) =>
          tx.execute(sql`
            select rd.archetype, coalesce(up.locale, 'en') as locale
            from public.membership m
            join public.role_definition rd on rd.org_id = m.org_id and rd.key = m.role_key
            left join public.user_profile up on up.id = m.user_id
            where m.org_id = ${ctx.orgId} and m.user_id = ${ctx.userId} and m.deactivated_at is null`),
        )) as unknown as Array<{ archetype: string; locale: string }>;
        const w = who[0];
        if (!w) {
          out.skipped++;
          continue;
        }
        const row = await executeRun(
          ctx,
          w.archetype as RoleArchetype,
          normalizeLocale(w.locale),
          r.id,
          {},
        );
        if (row.status === "failed") out.failed++;
        else out.executed++;
      } catch (e) {
        out.failed++;
        logger.warn(
          {
            worker: "idara-run-executor",
            org_id: r.org_id,
            run_id: r.id,
            request_id: requestId,
            err: String((e as Error).message ?? e),
          },
          "idara run failed",
        );
      }
    }
  } finally {
    await end();
  }
  return out;
}
