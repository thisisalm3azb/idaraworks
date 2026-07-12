/**
 * Nightly storage reconcile (S0 checklist §6 item 5; doc 10 #39; audit F-36).
 * Per org (never cross-org state — Bible §5 "scheduled fan-out" rule):
 *   1. fail stale pendings (>24h) and release their reservations,
 *   2. true the counter up to file-row truth (ready actual + pending reserved)
 *      under the counter lock (app.reconcile_storage_usage — race-free, m13),
 *   3. LEAK DETECTION: diff the bucket listing against the paths the DB knows
 *      (app.org_known_object_paths). An object with no owning row is a leak
 *      (a bypassed direct upload, or a failed-cleanup original) → error alarm.
 *      This is the direction real leaks occur; a positive bucket−file delta is
 *      no longer assumed benign (review CM4).
 *
 * Org discovery here is by bucket prefix (orgs that hold objects). An org with
 * ONLY abandoned pending rows and zero objects self-heals via signUpload's
 * opportunistic stale-sweep on its next upload (review m17); a permanently
 * dormant org's tiny lingering reservation is bounded and harmless.
 */
import { cron } from "inngest";
import { inngest } from "@/platform/events";
import { sql, withCtx, objectStore, type Ctx } from "@/platform/tenancy";
import { logger } from "@/platform/logger";

const BUCKETS = ["tenant-media", "tenant-docs"] as const;
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";
const STALE_PENDING = "24 hours";

export type OrgReconcileResult = {
  orgId: string;
  bucketBytes: number;
  fileBytes: number;
  previousCounter: number;
  staleFailed: number;
  orphanKeys: number;
  drift: boolean;
};

/** Reconcile one org — plain function shared by the cron wrapper and tests. */
export async function reconcileOrg(orgId: string, requestId: string): Promise<OrgReconcileResult> {
  const store = objectStore();
  const bucketKeys: string[] = [];
  let bucketBytes = 0;
  for (const bucket of BUCKETS) {
    for (const obj of await store.list(bucket, `${orgId}/`)) {
      bucketKeys.push(obj.path);
      bucketBytes += obj.bytes;
    }
  }

  const ctx: Ctx = {
    orgId,
    userId: SYSTEM_ACTOR,
    costPrivileged: false,
    pricePrivileged: false,
    requestId,
  };
  const { fileBytes, previousCounter, staleFailed, known } = await withCtx(ctx, async (tx) => {
    const stale = (await tx.execute(
      sql`select app.fail_stale_pending_files(${orgId}, ${STALE_PENDING}::interval) as n`,
    )) as unknown as Array<{ n: number }>;
    const recon = (await tx.execute(
      sql`select previous_bytes, current_bytes from app.reconcile_storage_usage(${orgId})`,
    )) as unknown as Array<{ previous_bytes: string | number; current_bytes: string | number }>;
    const paths = (await tx.execute(
      sql`select p from app.org_known_object_paths(${orgId}) as p`,
    )) as unknown as Array<{ p: string }>;
    return {
      fileBytes: Number(recon[0]?.current_bytes ?? 0),
      previousCounter: Number(recon[0]?.previous_bytes ?? 0),
      staleFailed: Number(stale[0]?.n ?? 0),
      known: new Set(paths.map((r) => r.p)),
    };
  });

  // Orphans: objects the DB has no live row for (bypassed upload / stray object).
  const orphanKeys = bucketKeys.filter((k) => !known.has(k));
  const counterCorrected = previousCounter !== fileBytes;
  const drift = orphanKeys.length > 0 || counterCorrected;
  const level = orphanKeys.length > 0 ? "error" : counterCorrected ? "warn" : "debug";
  logger[level](
    {
      orgId,
      bucketBytes,
      fileBytes,
      previousCounter,
      staleFailed,
      orphanKeys: orphanKeys.length,
      sampleOrphans: orphanKeys.slice(0, 5),
      requestId,
    },
    "storage reconcile",
  );
  return {
    orgId,
    bucketBytes,
    fileBytes,
    previousCounter,
    staleFailed,
    orphanKeys: orphanKeys.length,
    drift,
  };
}

export async function reconcileAllOrgs(requestId: string): Promise<OrgReconcileResult[]> {
  const store = objectStore();
  const orgIds = new Set<string>();
  for (const bucket of BUCKETS) {
    for (const prefix of await store.listTopLevelPrefixes(bucket)) orgIds.add(prefix);
  }
  const results: OrgReconcileResult[] = [];
  const failed: string[] = [];
  for (const orgId of orgIds) {
    // Sequential + per-org isolation: one org's failure (orphaned bucket, etc.)
    // must not abort the sweep for the rest (review m3).
    try {
      results.push(await reconcileOrg(orgId, requestId));
    } catch (err) {
      failed.push(orgId);
      logger.error({ orgId, requestId, err: (err as Error).message }, "reconcile: org failed");
    }
  }
  if (failed.length) logger.error({ failed, requestId }, "reconcile: some orgs failed");
  return results;
}

export const storageReconcile = inngest.createFunction(
  { id: "storage-reconcile", retries: 1, triggers: [cron("0 2 * * *")] }, // nightly, UTC
  async ({ runId }) => {
    const results = await reconcileAllOrgs(`inngest-${runId}`);
    return {
      orgs: results.length,
      drift: results.filter((r) => r.drift).map((r) => r.orgId),
      orphans: results.reduce((n, r) => n + r.orphanKeys, 0),
      staleFailed: results.reduce((n, r) => n + r.staleFailed, 0),
    };
  },
);
