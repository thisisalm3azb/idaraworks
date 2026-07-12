/**
 * Health probes (Phase I; BUILD_BIBLE §15.5, S0 checklist §15 "Observability":
 * /api/health checks DB / queue / storage — per-dependency status).
 *
 * Semantics:
 * - `db` and `storage` are the hard S0 dependencies → overall ok (HTTP 200/503).
 * - `queue` reports outbox gauges (backlog, oldest age, dead-letters). A
 *   dead-letter raises `alert: true` (page-worthy per §15.4 — Sentry fires from
 *   the relay) but does NOT 503 the app: requests still serve while the bus
 *   drains. The probe itself failing marks queue.ok=false (also non-gating —
 *   it shares the DB dependency already gated above).
 * - `inngest` is a CONFIGURATION status, never a gate: `unconfigured` is the
 *   documented pre-provisioning state (owner action OA-4), reported explicitly
 *   so production never shows an unexplained generic failure.
 *
 * Connection law (A-B5): one dedicated `createAppDb({ max: 1 })` client per
 * report — no GUCs are ever set on it, so it is a PLATFORM session and may call
 * app.outbox_stats(). The shared request pool is never touched.
 */
import { createAppDb, sql, objectStore } from "@/platform/tenancy";
import { MAX_ATTEMPTS } from "@/platform/events";

export type ProbeResult = { ok: boolean; latency_ms: number; error?: string };
export type QueueProbe = ProbeResult & {
  unprocessed?: number;
  oldest_unprocessed_age_s?: number;
  dead_lettered?: number;
  alert?: boolean;
};
export type InngestStatus = {
  configured: boolean;
  status: "configured" | "unconfigured";
  detail?: string;
};

export type HealthReport = {
  ok: boolean;
  request_id: string;
  uptime_s: number;
  commit: string | null;
  checks: { db: ProbeResult; storage: ProbeResult; queue: QueueProbe; inngest: InngestStatus };
};

const PROBE_TIMEOUT_MS = 5_000;

async function bounded<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} probe timed out`)), PROBE_TIMEOUT_MS).unref?.();
    }),
  ]);
}

/** Identifiers-only error text: never echo connection strings or hosts. */
function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.slice(0, 200);
}

export function inngestStatus(): InngestStatus {
  const configured = Boolean(process.env.INNGEST_SIGNING_KEY && process.env.INNGEST_EVENT_KEY);
  return configured
    ? { configured, status: "configured" }
    : {
        configured,
        status: "unconfigured",
        detail:
          "INNGEST_SIGNING_KEY / INNGEST_EVENT_KEY not provisioned (owner action; runbooks/inngest-provisioning.md)",
      };
}

export async function healthReport(requestId: string): Promise<HealthReport> {
  const db: ProbeResult = { ok: false, latency_ms: 0 };
  const queue: QueueProbe = { ok: false, latency_ms: 0 };
  const storage: ProbeResult = { ok: false, latency_ms: 0 };

  // db + queue share one dedicated platform client (A-B5; no GUCs → platform task).
  let started = Date.now();
  try {
    const client = createAppDb({ max: 1 });
    try {
      const rows = (await bounded("db", () =>
        client.db.execute(sql`select 1 as ok`),
      )) as unknown as Array<{ ok: number }>;
      db.ok = rows[0]?.ok === 1;
      db.latency_ms = Date.now() - started;

      started = Date.now();
      try {
        const stats = (await bounded("queue", () =>
          client.db.execute(sql`
            select unprocessed::int as unprocessed,
                   oldest_unprocessed_age_s::int as oldest_age,
                   dead_lettered::int as dead_lettered
            from app.outbox_stats(${MAX_ATTEMPTS})`),
        )) as unknown as Array<{ unprocessed: number; oldest_age: number; dead_lettered: number }>;
        const s = stats[0];
        if (s) {
          queue.ok = true;
          queue.unprocessed = s.unprocessed;
          queue.oldest_unprocessed_age_s = s.oldest_age;
          queue.dead_lettered = s.dead_lettered;
          queue.alert = s.dead_lettered > 0;
        }
      } catch (e) {
        queue.error = errText(e);
      }
      queue.latency_ms = Date.now() - started;
    } finally {
      await client.end();
    }
  } catch (e) {
    db.error = errText(e);
    db.latency_ms = Date.now() - started;
  }

  // storage: one authenticated ListObjectsV2 against the media bucket with an
  // improbable prefix — proves endpoint + credential + bucket, returns ~nothing.
  started = Date.now();
  try {
    await bounded("storage", () => objectStore().list("tenant-media", "healthcheck-nonexistent/"));
    storage.ok = true;
  } catch (e) {
    storage.error = errText(e);
  }
  storage.latency_ms = Date.now() - started;

  return {
    ok: db.ok && storage.ok,
    request_id: requestId,
    uptime_s: Math.round(process.uptime()),
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    checks: { db, storage, queue, inngest: inngestStatus() },
  };
}
