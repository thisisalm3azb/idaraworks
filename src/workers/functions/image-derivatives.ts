/**
 * Ingest worker (S0 checklist §6 item 3; doc 01 Appendix A; audit F-35, AR-4):
 * on file/uploaded — download the original, re-encode (EXIF/GPS gone), generate
 * thumb + medium, write bytes + variants, flip pending→ready, and account the
 * bytes — the row flip and the counter move in ONE transaction.
 *
 * Idempotent: the pending→ready UPDATE is guarded (`where status='pending'`);
 * a duplicate delivery re-uploads identical derivative objects (S3 PUT is an
 * overwrite) and then skips accounting because the guard returns zero rows.
 *
 * Failure split: undecodable input = permanent → mark failed, NonRetriableError;
 * transport/infra errors throw and let Inngest retry with backoff.
 */
import { NonRetriableError } from "inngest";
import { fileUploadedEvent, FileUploadedData } from "@/platform/events";
import { sql, withCtx, objectStore, type Ctx } from "@/platform/tenancy";
import { CLASS_MAP, buildObjectPath, type FileVariants } from "@/platform/files";
import { processImage } from "@/platform/files/image";
import { logger } from "@/platform/logger";
import { defineOrgFunction } from "../harness";

type FileRow = {
  id: string;
  access_class: keyof typeof CLASS_MAP;
  attached_to_type: string;
  attached_to_id: string;
  bucket: string;
  object_path: string;
  status: string;
  legal_hold: boolean;
  voided_at: string | null;
  reserved_bytes: string | number;
};

async function loadRow(ctx: Ctx, fileId: string): Promise<FileRow | null> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, access_class, attached_to_type,
             attached_to_id::text as attached_to_id, bucket, object_path, status,
             legal_hold, voided_at::text as voided_at, reserved_bytes
      from public.file where id = ${fileId}
    `)) as unknown as FileRow[];
    return rows[0] ?? null;
  });
}

/**
 * Discard the EXIF-bearing job_media original (Appendix A). Idempotent (404 =
 * success). Runs on the ready path AND is re-attempted on the already-ready skip
 * path, so a transient delete failure can never orphan the original past a retry
 * (review CM3).
 */
async function cleanupOriginal(store: ReturnType<typeof objectStore>, row: FileRow): Promise<void> {
  if (CLASS_MAP[row.access_class].retainOriginal || row.legal_hold) return;
  await store.del(row.bucket, row.object_path);
}

async function markFailed(ctx: Ctx, fileId: string): Promise<void> {
  await withCtx(ctx, (tx) =>
    tx.execute(sql`
      update public.file set status = 'failed'
      where id = ${fileId} and status = 'pending'
    `),
  );
}

export type DeriveResult =
  | { outcome: "ready"; bytes: number }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string };

/**
 * The full pipeline as a plain function. Receives an ALREADY-VERIFIED payload +
 * ctx (defineOrgFunction does the org re-verification, so it happens in exactly
 * one place). Invoked by the Inngest wrapper below and by integration tests.
 */
export async function deriveImageVariants(
  payload: FileUploadedData,
  ctx: Ctx,
): Promise<DeriveResult> {
  const row = await loadRow(ctx, payload.fileId);
  if (!row) return { outcome: "skipped", reason: "file row not visible in org context" };
  const store = objectStore();
  if (row.status === "ready") {
    // Resume an interrupted original cleanup: a delete that failed after the
    // flip is retried here on the duplicate delivery instead of being lost.
    await cleanupOriginal(store, row);
    return { outcome: "skipped", reason: "already processed" };
  }
  if (row.status === "failed") return { outcome: "skipped", reason: "previously failed" };
  if (row.voided_at) return { outcome: "skipped", reason: "voided before processing" };

  const original = await store.get(row.bucket, row.object_path);
  if (!original) {
    // The client may still be uploading — retryable; the stale sweep eventually
    // fails rows whose object never arrives.
    throw new Error(`original object missing: ${row.bucket}/${row.object_path}`);
  }

  let processed;
  try {
    processed = await processImage(original);
  } catch (err) {
    await markFailed(ctx, payload.fileId);
    logger.warn(
      { fileId: payload.fileId, requestId: ctx.requestId, err: (err as Error).message },
      "image re-encode failed — file marked failed",
    );
    throw new NonRetriableError("undecodable image");
  }

  const spec = CLASS_MAP[row.access_class];
  const base = {
    orgId: ctx.orgId,
    accessClass: row.access_class,
    attachedToType: row.attached_to_type,
    attachedToId: row.attached_to_id,
    fileId: row.id,
  } as const;
  const mainPath = buildObjectPath({ ...base, ext: "jpg" });
  const mediumPath = buildObjectPath({ ...base, ext: "jpg", variant: "medium" });
  const thumbPath = buildObjectPath({ ...base, ext: "jpg", variant: "thumb" });

  await store.put(row.bucket, mainPath, processed.main.buffer, "image/jpeg");
  await store.put(row.bucket, mediumPath, processed.medium.buffer, "image/jpeg");
  await store.put(row.bucket, thumbPath, processed.thumb.buffer, "image/jpeg");

  const variants: FileVariants = {
    main: {
      path: mainPath,
      bytes: processed.main.bytes,
      width: processed.main.width,
      height: processed.main.height,
      mime: "image/jpeg",
    },
    medium: {
      path: mediumPath,
      bytes: processed.medium.bytes,
      width: processed.medium.width,
      height: processed.medium.height,
      mime: "image/jpeg",
    },
    thumb: {
      path: thumbPath,
      bytes: processed.thumb.bytes,
      width: processed.thumb.width,
      height: processed.thumb.height,
      mime: "image/jpeg",
    },
  };
  let totalBytes = processed.main.bytes + processed.medium.bytes + processed.thumb.bytes;

  if (spec.retainOriginal) {
    // financial_doc / hr_doc: the uploaded original is evidence — retained,
    // never served on app surfaces (signRead serves the clean variants).
    variants.original = {
      path: row.object_path,
      bytes: original.length,
      mime: "application/octet-stream",
    };
    totalBytes += original.length;
  }

  // Flip + SETTLE the reservation atomically; the status guard makes duplicate
  // deliveries a no-op. The counter already holds the declared reservation from
  // signUpload, so we apply only the delta (actual − reserved) and zero the
  // reservation — reserve→settle keeps accounting exact (review m7).
  const reserved = Number(row.reserved_bytes) || 0;
  const delta = totalBytes - reserved;
  const flipped = await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      update public.file
      set status = 'ready', bytes = ${totalBytes}, reserved_bytes = 0,
          variants = ${JSON.stringify(variants)}::jsonb, exif_stripped = true
      where id = ${payload.fileId} and status = 'pending' and voided_at is null
      returning id
    `)) as unknown as Array<{ id: string }>;
    if (rows.length === 0) return false;
    await tx.execute(sql`
      insert into public.org_storage_usage (org_id, bytes_used)
      values (${ctx.orgId}, greatest(0, ${delta})::bigint)
      on conflict (org_id)
      do update set bytes_used = greatest(0, public.org_storage_usage.bytes_used + ${delta})
    `);
    return true;
  });

  if (flipped) {
    // job_media: discard the EXIF-bearing original (Appendix A). Resumable —
    // see cleanupOriginal (review CM3).
    await cleanupOriginal(store, row);
  }

  return flipped
    ? { outcome: "ready", bytes: totalBytes }
    : { outcome: "skipped", reason: "another delivery completed first" };
}

export const imageDerivatives = defineOrgFunction(
  { id: "image-derivatives", trigger: fileUploadedEvent, schema: FileUploadedData, retries: 3 },
  ({ payload, ctx }) => deriveImageVariants(payload, ctx),
);
