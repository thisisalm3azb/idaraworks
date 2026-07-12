/**
 * The outbox relay + retention crons (S0 checklist §7.2/§7.4). These are NOT
 * org functions (no payload, no org) — they are platform tasks that run without
 * a tenant context, which is exactly what the DB's assert_platform_task() guard
 * requires. Delivery latency is bounded by the relay cadence (~1 min), which is
 * fine for the background work the bus drives.
 */
import { cron } from "inngest";
import { inngest, relayOutbox, checkDeadLetters, purgeProcessedEvents } from "@/platform/events";
import { createAppDb } from "@/platform/tenancy";

/** Every minute: publish the unprocessed batch, then alarm on dead-letters —
 * both over ONE shared platform-task connection (review m5). */
export const outboxRelay = inngest.createFunction(
  { id: "outbox-relay", retries: 1, triggers: [cron("* * * * *")] },
  async ({ runId }) => {
    const { db, end } = createAppDb({ max: 1 });
    try {
      const relay = await relayOutbox(undefined, `relay-${runId}`, db);
      const deadLettered = await checkDeadLetters(`relay-${runId}`, db);
      return { ...relay, deadLettered };
    } finally {
      await end();
    }
  },
);

/** Nightly: purge processed events past retention + reap abandoned dead-letters
 * (Appendix B; review m11). */
export const outboxRetention = inngest.createFunction(
  { id: "outbox-retention", retries: 1, triggers: [cron("15 3 * * *")] },
  async ({ runId }) => {
    return purgeProcessedEvents(undefined, `retention-${runId}`);
  },
);
