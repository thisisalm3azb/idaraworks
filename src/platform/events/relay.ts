/**
 * The outbox relay (S0 checklist §7.2/§7.4; BUILD_BIBLE §8.7). Runs as a
 * PLATFORM TASK — a dedicated no-org-context client (A-B5) so the DB's
 * app.assert_platform_task() guard admits it and rejects every tenant path. It
 * claims a batch of unprocessed domain_events (attempts bumped, SKIP LOCKED so
 * concurrent relays never double-take), publishes each to Inngest keyed by the
 * event id (dedup / idempotency §8.11), and marks processed. Failures record an
 * error and retry next tick until MAX_ATTEMPTS, then dead-letter.
 */
import { sql } from "@/platform/tenancy";
import { createAppDb } from "@/platform/tenancy";
import { logger } from "@/platform/logger";
import { inngest } from "./inngest";

export const RELAY_BATCH = 50;
export const MAX_ATTEMPTS = 5;
export const RETENTION = "90 days"; // Appendix B: purge processed > 90 days

type ClaimedEvent = {
  id: string;
  org_id: string;
  name: string;
  version: number;
  payload: Record<string, unknown>;
};

/** The Inngest send, injectable for tests. Keyed by id → at-least-once + dedup. */
export type SendFn = (event: { name: string; data: unknown; id: string }) => Promise<unknown>;

const defaultSend: SendFn = (event) =>
  // Inngest.send accepts a dynamic name; the registry is the type authority.
  inngest.send({ name: event.name, data: event.data as Record<string, unknown>, id: event.id });

export type RelayResult = { claimed: number; sent: number; failed: number };

export async function relayOutbox(
  send: SendFn = defaultSend,
  requestId = "relay",
): Promise<RelayResult> {
  const { db, end } = createAppDb({ max: 1 });
  try {
    const claimed = (await db.execute(sql`
      select id::text as id, org_id::text as org_id, name, version, payload
      from app.claim_domain_events(${RELAY_BATCH}, ${MAX_ATTEMPTS})
    `)) as unknown as ClaimedEvent[];

    let sent = 0;
    let failed = 0;
    for (const e of claimed) {
      try {
        await send({ name: e.name, data: e.payload, id: e.id });
        await db.execute(sql`select app.mark_domain_event_processed(${e.id})`);
        sent += 1;
      } catch (err) {
        await db.execute(
          sql`select app.record_domain_event_error(${e.id}, ${(err as Error).message})`,
        );
        failed += 1;
      }
    }
    if (claimed.length) {
      logger.info({ claimed: claimed.length, sent, failed, requestId }, "outbox relay");
    }
    return { claimed: claimed.length, sent, failed };
  } finally {
    await end();
  }
}

/** Dead-letter alarm: exhausted-attempts events → ERROR ops log (the alert). The
 * Sentry captureException channel wires in with observability (Phase I). */
export async function checkDeadLetters(requestId = "relay"): Promise<number> {
  const { db, end } = createAppDb({ max: 1 });
  try {
    const dead = (await db.execute(sql`
      select id::text as id, name, attempts, last_error
      from app.dead_lettered_domain_events(${MAX_ATTEMPTS}, 100)
    `)) as unknown as Array<{
      id: string;
      name: string;
      attempts: number;
      last_error: string | null;
    }>;
    if (dead.length) {
      logger.error(
        {
          deadLettered: dead.length,
          sample: dead.slice(0, 5).map((d) => ({ id: d.id, name: d.name, attempts: d.attempts })),
          requestId,
        },
        "domain_event dead-letter — events exceeded max attempts",
      );
    }
    return dead.length;
  } finally {
    await end();
  }
}

/** Retention (Appendix B): drop processed events older than the window. */
export async function purgeProcessedEvents(
  olderThan: string = RETENTION,
  requestId = "relay",
): Promise<number> {
  const { db, end } = createAppDb({ max: 1 });
  try {
    const rows = (await db.execute(
      sql`select app.purge_processed_domain_events(${olderThan}::interval) as n`,
    )) as unknown as Array<{ n: number }>;
    const purged = Number(rows[0]?.n ?? 0);
    if (purged) logger.info({ purged, requestId }, "outbox retention purge");
    return purged;
  } finally {
    await end();
  }
}
