/**
 * The outbox relay + retention crons (S0 checklist §7.2/§7.4). These are NOT
 * org functions (no payload, no org) — they are platform tasks that run without
 * an org context, which is exactly what the DB's assert_platform_task() guard
 * requires. Delivery latency is bounded by the relay cadence (~1 min), which is
 * fine for the background work the bus drives.
 */
import { inngest, relayOutbox, checkDeadLetters, purgeProcessedEvents } from "@/platform/events";
import { cron } from "inngest";

/** Every minute: publish the unprocessed batch, then alarm on dead-letters. */
export const outboxRelay = inngest.createFunction(
  { id: "outbox-relay", retries: 1, triggers: [cron("* * * * *")] },
  async ({ runId }) => {
    const relay = await relayOutbox(undefined, `relay-${runId}`);
    const deadLettered = await checkDeadLetters(`relay-${runId}`);
    return { ...relay, deadLettered };
  },
);

/** Nightly: purge processed events past the retention window (Appendix B). */
export const outboxRetention = inngest.createFunction(
  { id: "outbox-retention", retries: 1, triggers: [cron("15 3 * * *")] },
  async ({ runId }) => {
    const purged = await purgeProcessedEvents(undefined, `retention-${runId}`);
    return { purged };
  },
);
