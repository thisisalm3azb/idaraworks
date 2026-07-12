/**
 * The outbox relay (S0 checklist §7.2/§7.4; BUILD_BIBLE §8.7). Runs as a
 * PLATFORM TASK — a no-tenant-context client (A-B5) so the DB's
 * app.assert_platform_task() guard admits it and rejects every tenant path. It
 * claims a batch of unprocessed domain_events (attempts bumped, SKIP LOCKED so
 * concurrent relays never double-take), publishes each to Inngest keyed by the
 * event id (dedup / idempotency §8.11), and marks processed. Failures record an
 * error and retry next tick until MAX_ATTEMPTS, then dead-letter.
 *
 * At-least-once trade-off (review m1): attempts are bumped AT CLAIM, so a
 * successful send whose mark_processed then fails consumes an attempt on the
 * next tick and re-sends (Inngest de-dups by id — harmless). Bump-at-claim is
 * deliberate: it prevents a poison event from looping forever. MAX_ATTEMPTS is
 * generous so a transient queue outage does not exhaust attempts; redrive resets
 * a dead-lettered event once its root cause is fixed.
 */
import { createAppDb, sql, type AppDb } from "@/platform/tenancy";
import { logger } from "@/platform/logger";
import { inngest } from "./inngest";

export const RELAY_BATCH = 50;
// 20 attempts at a ~1-min cadence tolerates a ~20-min queue outage before
// dead-lettering a deliverable event (review m2).
export const MAX_ATTEMPTS = 20;
export const RETENTION = "90 days"; // Appendix B: purge processed > 90 days
export const DEAD_LETTER_RETENTION = "30 days"; // reap abandoned dead-letters

/** Run fn with a platform-task DB client — a caller-shared one, or a fresh
 * short-lived one (created + closed here) to avoid per-call churn (review m5). */
async function withPlatformDb<T>(db: AppDb | undefined, fn: (db: AppDb) => Promise<T>): Promise<T> {
  if (db) return fn(db);
  const { db: fresh, end } = createAppDb({ max: 1 });
  try {
    return await fn(fresh);
  } finally {
    await end();
  }
}

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
  sharedDb?: AppDb,
): Promise<RelayResult> {
  return withPlatformDb(sharedDb, async (db) => {
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
  });
}

/** Dead-letter alarm: exhausted-attempts events → ERROR ops log (the alert). The
 * Sentry captureException channel wires in with observability (Phase I). */
export async function checkDeadLetters(requestId = "relay", sharedDb?: AppDb): Promise<number> {
  return withPlatformDb(sharedDb, async (db) => {
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
  });
}

/** Retention (Appendix B): drop processed events, and reap dead-letters that
 * have sat abandoned past their window so nothing lingers forever (review m11). */
export async function purgeProcessedEvents(
  olderThan: string = RETENTION,
  requestId = "relay",
  sharedDb?: AppDb,
): Promise<{ processed: number; deadLettered: number }> {
  return withPlatformDb(sharedDb, async (db) => {
    const proc = (await db.execute(
      sql`select app.purge_processed_domain_events(${olderThan}::interval) as n`,
    )) as unknown as Array<{ n: number }>;
    const dead = (await db.execute(
      sql`select app.purge_dead_lettered_domain_events(${MAX_ATTEMPTS}, ${DEAD_LETTER_RETENTION}::interval) as n`,
    )) as unknown as Array<{ n: number }>;
    const processed = Number(proc[0]?.n ?? 0);
    const deadLettered = Number(dead[0]?.n ?? 0);
    if (processed || deadLettered) {
      logger.info({ processed, deadLettered, requestId }, "outbox retention purge");
    }
    return { processed, deadLettered };
  });
}

/** Ops recovery: reset dead-lettered events so they retry (call after fixing the
 * root cause). Not auto-invoked — auto-redrive would loop poison events. */
export async function redriveDeadLetters(requestId = "relay", sharedDb?: AppDb): Promise<number> {
  return withPlatformDb(sharedDb, async (db) => {
    const rows = (await db.execute(
      sql`select app.redrive_dead_lettered_domain_events(${MAX_ATTEMPTS}) as n`,
    )) as unknown as Array<{ n: number }>;
    const redriven = Number(rows[0]?.n ?? 0);
    if (redriven) logger.warn({ redriven, requestId }, "outbox dead-letter redrive");
    return redriven;
  });
}
