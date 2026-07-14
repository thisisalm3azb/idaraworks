/**
 * S10 retention pruning worker (doc 10 #36 / doc 01 Appendix B). A platform (no tenant context)
 * nightly cron that calls the assert_platform_task-guarded app.prune_retention() DEFINER to delete
 * ephemeral rows past their window (notifications, cleared exceptions, AI-interaction metadata,
 * digests). audit_log (≥6y financial floor), activity (tenant promise), and domain_event (relay-
 * pruned) are deliberately never touched. Directly invokable + dormant in prod until Inngest.
 */
import { createAppDb, sql } from "@/platform/tenancy";
import { inngest } from "@/platform/events";
import { cron } from "inngest";
import { logger } from "@/platform/logger";

export type PruneResult = {
  notifications: number;
  exceptions: number;
  aiInteractions: number;
  digests: number;
};

export async function pruneRetention(nowIso?: string): Promise<PruneResult> {
  const { db, end } = createAppDb({ max: 1 });
  try {
    // Review fix: passing NULL::timestamptz OVERRIDES the SQL `default now()` (an explicit NULL is
    // still an argument), which makes every `col < NULL` window false → a silent no-op. Call with
    // NO argument for the live cron (default now() applies); only pass a timestamp in tests.
    const rows = (await db.execute(
      nowIso
        ? sql`select notifications_pruned, exceptions_pruned, ai_interactions_pruned, digests_pruned
               from app.prune_retention(${nowIso}::timestamptz)`
        : sql`select notifications_pruned, exceptions_pruned, ai_interactions_pruned, digests_pruned
               from app.prune_retention()`,
    )) as unknown as Array<{
      notifications_pruned: string;
      exceptions_pruned: string;
      ai_interactions_pruned: string;
      digests_pruned: string;
    }>;
    const r = rows[0]!;
    const result = {
      notifications: Number(r.notifications_pruned),
      exceptions: Number(r.exceptions_pruned),
      aiInteractions: Number(r.ai_interactions_pruned),
      digests: Number(r.digests_pruned),
    };
    logger.info(result, "retention prune complete");
    return result;
  } finally {
    await end();
  }
}

export const retentionPruneCron = inngest.createFunction(
  { id: "retention-prune", retries: 1, triggers: [cron("30 3 * * *")] }, // ~03:30 UTC nightly
  async () => pruneRetention(),
);
