/**
 * The storage helper (S0 checklist §6; doc 01 Appendix A; doc 10 #7, #39-41).
 * Every signed URL is minted HERE, after class + quota checks, AS THE REQUESTING
 * USER — storage.objects RLS (0008/0009) is the DB wall behind every mint, and
 * requires a matching pending file row so a direct upload cannot skip quota.
 * Reads are never quota-blocked (freeze FR-9). Void/legal-hold flow through
 * org+identity-pinned SECURITY DEFINER functions inside command() (audited).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, userStorage, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import {
  getLimit,
  resolveEntitlements,
  isReadOnlyBillingState,
  BillingReadOnlyError,
} from "@/platform/entitlements";
import { command } from "@/platform/audit";
import { publishEvent, type PublishableEvent } from "@/platform/events";
import { ATTACHABLE_TYPES, type FileAccessClass, type RoleArchetype } from "@/platform/registries";
import { ALLOWED_UPLOAD_MIMES, BUCKET_MAX_BYTES, CLASS_MAP } from "./classmap";
import { canAccessFileClass } from "./access";
import { buildObjectPath, extForMime } from "./paths";

export class FilesError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "forbidden"
      | "quota_exceeded"
      | "not_found"
      | "not_ready"
      | "voided"
      | "legal_hold"
      | "already_voided"
      | "storage_api",
    message: string,
  ) {
    super(message);
    this.name = "FilesError";
  }
}

/** Map a definer-function DB error (escapes the withCtx tx as a raw error) to a FilesError. */
function rethrowFilesDbError(err: unknown): never {
  if (err instanceof FilesError) throw err;
  const e = err as { message?: string; cause?: { message?: string } };
  const msg = `${e.message ?? ""} ${e.cause?.message ?? ""}`.toLowerCase();
  if (msg.includes("already voided"))
    throw new FilesError("already_voided", "file is already voided");
  if (msg.includes("legal hold"))
    throw new FilesError("legal_hold", "file is under legal hold — deletion paths are suspended");
  if (msg.includes("not found")) throw new FilesError("not_found", "file not found");
  throw new FilesError("storage_api", "the file operation could not be completed");
}

// ── quota (doc 10 #39: warn 80%, block adds at 100%, never reads) ────────────
export const QUOTA_WARN_RATIO = 0.8;
const GIB = 1024 ** 3;
const STALE_PENDING = "24 hours";

export type QuotaState = {
  bytesUsed: number;
  limitBytes: number | null; // null = unlimited
  usedRatio: number | null;
  warn: boolean;
};

/** Pure decision (unit-tested): may `addBytes` more bytes be admitted? */
export function evaluateQuota(
  bytesUsed: number,
  limitBytes: number | null,
  addBytes: number,
): QuotaState & { allowed: boolean } {
  if (limitBytes === null) {
    return { bytesUsed, limitBytes, usedRatio: null, warn: false, allowed: true };
  }
  const usedRatio = limitBytes === 0 ? 1 : bytesUsed / limitBytes;
  return {
    bytesUsed,
    limitBytes,
    usedRatio,
    warn: usedRatio >= QUOTA_WARN_RATIO,
    allowed: bytesUsed + addBytes <= limitBytes,
  };
}

async function readUsage(tx: TenantTx, orgId: string): Promise<number> {
  const rows = (await tx.execute(
    sql`select bytes_used from public.org_storage_usage where org_id = ${orgId}`,
  )) as unknown as Array<{ bytes_used: string | number }>;
  return rows[0] ? Number(rows[0].bytes_used) : 0;
}

/** Transactional byte accounting — always inside the caller's transaction. */
export async function applyUsageDelta(tx: TenantTx, orgId: string, delta: number): Promise<void> {
  await tx.execute(sql`
    insert into public.org_storage_usage (org_id, bytes_used)
    values (${orgId}, greatest(0, ${delta})::bigint)
    on conflict (org_id)
    do update set bytes_used = greatest(0, public.org_storage_usage.bytes_used + ${delta})
  `);
}

export async function getStorageUsage(ctx: Ctx): Promise<QuotaState> {
  const limitGb = await getLimit(ctx, "limit.storage_gb");
  const limitBytes = limitGb === null ? null : limitGb * GIB;
  const bytesUsed = await withCtx(ctx, (tx) => readUsage(tx, ctx.orgId));
  return evaluateQuota(bytesUsed, limitBytes, 0);
}

// ── file row shape ────────────────────────────────────────────────────────────
export type VariantInfo = {
  path: string;
  bytes: number;
  width?: number;
  height?: number;
  mime: string;
};
export type FileVariants = Partial<Record<"main" | "medium" | "thumb" | "original", VariantInfo>>;

export type FileRecord = {
  id: string;
  orgId: string;
  accessClass: FileAccessClass;
  attachedToType: string;
  attachedToId: string;
  bucket: string;
  objectPath: string;
  originalName: string;
  mime: string;
  status: "pending" | "ready" | "failed";
  bytes: number | null;
  variants: FileVariants | null;
  exifStripped: boolean;
  legalHold: boolean;
  voidedAt: string | null;
  createdBy: string;
  createdAt: string;
};

function mapRow(r: Record<string, unknown>): FileRecord {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    accessClass: r.access_class as FileAccessClass,
    attachedToType: r.attached_to_type as string,
    attachedToId: r.attached_to_id as string,
    bucket: r.bucket as string,
    objectPath: r.object_path as string,
    originalName: r.original_name as string,
    mime: r.mime as string,
    status: r.status as FileRecord["status"],
    bytes: r.bytes === null ? null : Number(r.bytes),
    variants: (r.variants as FileVariants | null) ?? null,
    exifStripped: r.exif_stripped as boolean,
    legalHold: r.legal_hold as boolean,
    voidedAt: (r.voided_at as string | null) ?? null,
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
  };
}

const FILE_COLUMNS = sql`
  id::text as id, org_id::text as org_id, access_class, attached_to_type,
  attached_to_id::text as attached_to_id, bucket, object_path, original_name,
  mime, status, bytes, variants, exif_stripped, legal_hold,
  voided_at::text as voided_at, created_by::text as created_by,
  created_at::text as created_at`;

async function loadFile(tx: TenantTx, fileId: string): Promise<FileRecord | null> {
  const rows = (await tx.execute(
    sql`select ${FILE_COLUMNS} from public.file where id = ${fileId}`,
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Files attached to one entity (S2 job files tab) — ready, non-voided. */
export async function listEntityFiles(
  ctx: Ctx,
  attachedToType: string,
  attachedToId: string,
): Promise<FileRecord[]> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id from public.file
      where org_id = ${ctx.orgId} and attached_to_type = ${attachedToType}
        and attached_to_id = ${attachedToId} and voided_at is null
      order by created_at desc
    `),
  )) as unknown as Array<{ id: string }>;
  // Resolve the records CONCURRENTLY (review fix — the sequential per-id
  // getFile was an N+1 of separate withCtx transactions; concurrent withCtx
  // transactions on the shared pool are the sanctioned pattern, A-B5/VC-1).
  const resolved = await Promise.all(rows.map((r) => getFile(ctx, r.id)));
  return resolved.filter((f): f is FileRecord => f !== null);
}

export async function getFile(ctx: Ctx, fileId: string): Promise<FileRecord | null> {
  // RLS does the org scoping AND the class gating (0008 file_select).
  return withCtx(ctx, (tx) => loadFile(tx, fileId));
}

// ── signUpload ────────────────────────────────────────────────────────────────
export const SignUploadInput = z.object({
  accessClass: z.enum(["job_media", "financial_doc", "hr_doc", "customer_share"]),
  attachedToType: z.enum(ATTACHABLE_TYPES as unknown as [string, ...string[]]),
  attachedToId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(255),
  mime: z.enum(ALLOWED_UPLOAD_MIMES as unknown as [string, ...string[]]),
  sizeBytes: z.number().int().positive(),
});
export type SignUploadInput = z.infer<typeof SignUploadInput>;

export type SignedUpload = {
  fileId: string;
  bucket: string;
  objectPath: string;
  /** PUT target — client uploads the (compressed) bytes here. */
  signedUrl: string;
  token: string;
  quota: QuotaState;
};

export async function signUpload(
  ctx: Ctx,
  archetype: RoleArchetype,
  accessToken: string,
  raw: unknown,
): Promise<SignedUpload> {
  const input = SignUploadInput.parse(raw);
  const cls = input.accessClass as FileAccessClass;
  const spec = CLASS_MAP[cls];
  if (!spec.hasMemberPath) {
    throw new FilesError("invalid_input", `class ${cls} has no member upload path`);
  }
  if (!canAccessFileClass(archetype, ctx.pricePrivileged, cls, true)) {
    throw new FilesError("forbidden", `Forbidden: upload ${cls}`);
  }
  if (input.sizeBytes > BUCKET_MAX_BYTES[spec.bucket]) {
    throw new FilesError("invalid_input", "file exceeds the bucket size cap");
  }
  const ext = extForMime(input.mime);
  if (!ext) throw new FilesError("invalid_input", "unsupported mime type");

  const limitGb = await getLimit(ctx, "limit.storage_gb");
  const limitBytes = limitGb === null ? null : limitGb * GIB;

  // FR-9: a read-only billing state blocks new uploads (an ADD). Uses the same resolved entitlements
  // getLimit just loaded (cache hit). signUpload does not go through command(), so it needs its own gate.
  const ent = await resolveEntitlements(ctx);
  if (isReadOnlyBillingState(ent.billingState)) throw new BillingReadOnlyError(ent.billingState);

  const fileId = randomUUID();
  const objectPath = buildObjectPath({
    orgId: ctx.orgId,
    accessClass: cls,
    attachedToType: input.attachedToType,
    attachedToId: input.attachedToId,
    fileId,
    ext,
    variant: "orig",
  });

  // Sweep-then-reserve, all in ONE transaction (no network calls inside it —
  // Bible §8.8). The self-sweep releases this org's abandoned reservations so a
  // dormant pending upload cannot hold quota forever (review m17); the RESERVE
  // (declared bytes onto the counter, atomic with the pending row) removes the
  // check→use TOCTOU that let concurrent signs overshoot the limit (review m7).
  const quota = await withCtx(ctx, async (tx) => {
    await tx.execute(
      sql`select app.fail_stale_pending_files(${ctx.orgId}, ${STALE_PENDING}::interval)`,
    );
    const used = await readUsage(tx, ctx.orgId);
    const q = evaluateQuota(used, limitBytes, input.sizeBytes);
    if (!q.allowed) {
      throw new FilesError(
        "quota_exceeded",
        "storage limit reached — adds are blocked (reads are never blocked)",
      );
    }
    await tx.execute(sql`
      insert into public.file
        (id, org_id, access_class, attached_to_type, attached_to_id, bucket,
         object_path, original_name, mime, created_by, reserved_bytes)
      values
        (${fileId}, ${ctx.orgId}, ${input.accessClass}, ${input.attachedToType},
         ${input.attachedToId}, ${spec.bucket}, ${objectPath}, ${input.fileName},
         ${input.mime}, ${ctx.userId}, ${input.sizeBytes})
    `);
    await applyUsageDelta(tx, ctx.orgId, input.sizeBytes); // reserve
    return q;
  });

  const { data, error } = await userStorage(accessToken)
    .from(spec.bucket)
    .createSignedUploadUrl(objectPath);
  if (error || !data) {
    // The DB wall refused (or the API failed): the pending row + reservation are
    // released by the next self-sweep / nightly reconcile.
    throw new FilesError("storage_api", `could not sign upload: ${error?.message ?? "no data"}`);
  }
  return {
    fileId,
    bucket: spec.bucket,
    objectPath,
    signedUrl: data.signedUrl,
    token: data.token,
    quota,
  };
}

// ── confirmUpload → queue the ingest worker ──────────────────────────────────
export async function confirmUpload(
  ctx: Ctx,
  fileId: string,
  publish: (e: PublishableEvent) => Promise<void> = publishEvent,
): Promise<void> {
  const file = await getFile(ctx, fileId);
  if (!file) throw new FilesError("not_found", "file not found");
  if (file.status !== "pending") return; // idempotent — already processed
  await publish({
    name: "file/uploaded",
    data: { orgId: ctx.orgId, fileId, actorUserId: ctx.userId },
  });
}

// ── signRead (class-checked, short TTL; NEVER quota-gated — FR-9) ────────────
export const THUMB_TTL_SECONDS = 3600; // ≤1h for cacheable thumbnails
export const READ_TTL_SECONDS = 300; // 60-300s app use

export type ReadVariant = "main" | "medium" | "thumb";

export async function signRead(
  ctx: Ctx,
  archetype: RoleArchetype,
  accessToken: string,
  fileId: string,
  variant: ReadVariant = "medium",
): Promise<{ url: string; expiresIn: number }> {
  const file = await getFile(ctx, fileId);
  if (!file) throw new FilesError("not_found", "file not found");
  if (!canAccessFileClass(archetype, ctx.pricePrivileged, file.accessClass, false)) {
    // Denial reads as absence — no metadata leak.
    throw new FilesError("not_found", "file not found");
  }
  if (file.voidedAt) throw new FilesError("voided", "file is voided");
  if (file.status !== "ready") throw new FilesError("not_ready", "file is still processing");
  // NB: the retained EXIF-bearing `original` (financial_doc/hr_doc) is NEVER
  // served here — only the clean re-encoded variants (review m16).
  const v = file.variants?.[variant];
  if (!v) throw new FilesError("not_found", `variant ${variant} does not exist`);
  const expiresIn = variant === "thumb" ? THUMB_TTL_SECONDS : READ_TTL_SECONDS;
  const { data, error } = await userStorage(accessToken)
    .from(file.bucket)
    .createSignedUrl(v.path, expiresIn);
  if (error || !data) {
    throw new FilesError("storage_api", `could not sign read: ${error?.message ?? "no data"}`);
  }
  return { url: data.signedUrl, expiresIn };
}

// ── void / legal hold (D-1.7 foundations; audited; DB-pinned definers) ───────
export async function voidFile(
  ctx: Ctx,
  archetype: RoleArchetype,
  fileId: string,
  reason: string,
): Promise<void> {
  assertCan(archetype, "files.void");
  try {
    await command(
      ctx,
      {
        audit: (r: { originalName: string; prevStatus: string; effectiveBytes: number }) => ({
          action: "file.void",
          entityType: "file" as const,
          entityId: fileId,
          summary: `Voided file ${r.originalName}`,
          before: { status: r.prevStatus },
          after: { voided: true, reason, freedBytes: r.effectiveBytes },
        }),
      },
      async (tx) => {
        const rows = (await tx.execute(sql`
          select original_name, prev_status, effective_bytes
          from app.void_file(${fileId}, ${reason})
        `)) as unknown as Array<{
          original_name: string;
          prev_status: string;
          effective_bytes: string | number;
        }>;
        const r = rows[0];
        if (!r) throw new FilesError("not_found", "file not found");
        return {
          originalName: r.original_name,
          prevStatus: r.prev_status,
          effectiveBytes: Number(r.effective_bytes),
        };
      },
    );
  } catch (err) {
    rethrowFilesDbError(err);
  }
}

export async function setLegalHold(
  ctx: Ctx,
  archetype: RoleArchetype,
  fileId: string,
  hold: boolean,
): Promise<void> {
  assertCan(archetype, "files.legal_hold");
  try {
    await command(
      ctx,
      {
        audit: (r: { originalName: string; wasHeld: boolean }) => ({
          action: hold ? "file.legal_hold.set" : "file.legal_hold.clear",
          entityType: "file" as const,
          entityId: fileId,
          summary: `${hold ? "Placed" : "Released"} legal hold on ${r.originalName}`,
          before: { legalHold: r.wasHeld },
          after: { legalHold: hold },
        }),
      },
      async (tx) => {
        const rows = (await tx.execute(sql`
          select original_name, was_held from app.set_legal_hold(${fileId}, ${hold})
        `)) as unknown as Array<{ original_name: string; was_held: boolean }>;
        const r = rows[0];
        if (!r) throw new FilesError("not_found", "file not found");
        return { originalName: r.original_name, wasHeld: r.was_held };
      },
    );
  } catch (err) {
    rethrowFilesDbError(err);
  }
}
