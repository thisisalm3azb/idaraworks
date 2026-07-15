/**
 * Organization branding (U2; migration 0071) — ONE governed source for the
 * tenant's visual identity: logo (a normal file-pipeline row, re-encoded
 * server-side), accent colour, display/legal names and document footer.
 *
 * Enforcement (honest add-on gates, display-level — reads NEVER throw):
 *   feat.branding_app  → in-app placements (header/dashboard logo)
 *   feat.branding_docs → document placements (LPO / quote / invoice logo slot)
 * When a feature is off the caller falls back to the organization-name
 * initials avatar (in-app) or the plain org-name text header (documents).
 *
 * The logo NEVER has a public write path: uploads run through this service
 * (config.manage + validation matrix + the VC-4 re-encode pipeline) and the
 * bytes land under the org's own tenant-media prefix; reads are served through
 * the existing signed-read path (signRead — org-scoped RLS on the file table +
 * storage.objects) or embedded as a data URI at document render time.
 */
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { z } from "zod";
import { sql, withCtx, objectStore, type Ctx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import { command } from "@/platform/audit";
import { hasFeature, getLimit } from "@/platform/entitlements";
import { buildObjectPath, evaluateQuota, getFile, type FileVariants } from "@/platform/files";
import { logger } from "@/platform/logger";
import type { RoleArchetype } from "@/platform/registries";
import {
  ACCENT_COLOR_RE,
  checkLogoDimensions,
  validateLogoBytes,
  type LogoValidationError,
} from "./validation";

// Re-exported for app-layer consumers (BUILD_BIBLE §3.2: service.ts is the
// module's only public surface — pages/actions never import module internals).
export {
  LOGO_MAX_BYTES,
  LOGO_ALLOWED_MIMES,
  ACCENT_COLOR_RE,
  validateLogoBytes,
  checkLogoDimensions,
} from "./validation";

export class BrandingError extends Error {
  constructor(
    public readonly code: LogoValidationError | "invalid_input" | "quota_exceeded" | "bad_image",
    message: string,
  ) {
    super(message);
    this.name = "BrandingError";
  }
}

// ── read ──────────────────────────────────────────────────────────────────────
export type OrgBranding = {
  logoFileId: string | null;
  accentColor: string | null;
  displayName: string | null;
  legalName: string | null;
  footerDetails: string | null;
};

const EMPTY_BRANDING: OrgBranding = {
  logoFileId: null,
  accentColor: null,
  displayName: null,
  legalName: null,
  footerDetails: null,
};

/** Null-safe: an org without a row gets the empty defaults. */
export async function getBranding(ctx: Ctx): Promise<OrgBranding> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select logo_file_id::text as logo_file_id, accent_color, display_name,
             legal_name, footer_details
      from public.org_branding where org_id = ${ctx.orgId}
    `),
  )) as unknown as Array<{
    logo_file_id: string | null;
    accent_color: string | null;
    display_name: string | null;
    legal_name: string | null;
    footer_details: string | null;
  }>;
  const r = rows[0];
  if (!r) return { ...EMPTY_BRANDING };
  return {
    logoFileId: r.logo_file_id,
    accentColor: r.accent_color,
    displayName: r.display_name,
    legalName: r.legal_name,
    footerDetails: r.footer_details,
  };
}

// ── save (accent colour + names + footer) ─────────────────────────────────────
const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

export const SaveBrandingInput = z.object({
  accentColor: z.preprocess(emptyToNull, z.string().regex(ACCENT_COLOR_RE).nullable()),
  displayName: z.preprocess(emptyToNull, z.string().trim().min(1).max(120).nullable()),
  legalName: z.preprocess(emptyToNull, z.string().trim().min(1).max(200).nullable()),
  footerDetails: z.preprocess(emptyToNull, z.string().trim().min(1).max(500).nullable()),
});
export type SaveBrandingInput = z.infer<typeof SaveBrandingInput>;

export async function saveBranding(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "config.manage");
  const parsed = SaveBrandingInput.safeParse(raw);
  if (!parsed.success) throw new BrandingError("invalid_input", "invalid branding fields");
  const input = parsed.data;
  await command(
    ctx,
    {
      audit: {
        action: "branding.update",
        entityType: "org",
        entityId: ctx.orgId,
        summary: "Updated organization branding",
        after: input,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        insert into public.org_branding
          (org_id, accent_color, display_name, legal_name, footer_details)
        values (${ctx.orgId}, ${input.accentColor}, ${input.displayName},
                ${input.legalName}, ${input.footerDetails})
        on conflict (org_id) do update set
          accent_color = excluded.accent_color,
          display_name = excluded.display_name,
          legal_name = excluded.legal_name,
          footer_details = excluded.footer_details,
          updated_at = now()
      `);
    },
  );
}

// ── logo upload / remove ──────────────────────────────────────────────────────
export type UploadLogoInput = {
  fileName: string;
  mime: string;
  bytes: Buffer;
};

/**
 * Validate (size → MIME whitelist → magic bytes → decoded dimensions), then
 * re-encode through the platform image pipeline (VC-4 — the uploaded bytes are
 * never stored as-is), store the clean PNG variants under the org's own
 * prefix, insert the file row READY, account the bytes, and point
 * org_branding.logo_file_id at it — the row flip + counter + pointer move in
 * ONE audited transaction (command()). Replacing keeps the previous file row
 * (files are never hard-deleted); only the pointer moves.
 */
export async function uploadLogo(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: UploadLogoInput,
): Promise<{ fileId: string }> {
  assertCan(archetype, "config.manage");

  const verdict = validateLogoBytes(input.bytes, input.mime);
  if (!verdict.ok) throw new BrandingError(verdict.error, `logo rejected: ${verdict.error}`);

  // sharp is loaded LAZILY: this module is also imported by the org layout
  // (getAppBranding/getDocBranding paths), which must never pull the native
  // binding into every page's runtime (serverless trace, VC-4 worker note).
  const { default: sharp } = await import("sharp");
  const { processLogo } = await import("@/platform/files/image");

  let meta: { width?: number; height?: number };
  try {
    meta = await sharp(input.bytes, { failOn: "error" }).metadata();
  } catch {
    throw new BrandingError("bad_image", "the image could not be decoded");
  }
  const dims = checkLogoDimensions(meta.width, meta.height);
  if (dims) throw new BrandingError(dims, `logo rejected: ${dims}`);

  let processed;
  try {
    processed = await processLogo(input.bytes);
  } catch {
    throw new BrandingError("bad_image", "the image could not be re-encoded");
  }

  const fileId = randomUUID();
  const base = {
    orgId: ctx.orgId,
    accessClass: "job_media" as const, // tenant-media bucket; readable by every member
    attachedToType: "org",
    attachedToId: ctx.orgId,
    fileId,
  };
  const mainPath = buildObjectPath({ ...base, ext: "png" });
  const thumbPath = buildObjectPath({ ...base, ext: "png", variant: "thumb" });
  const totalBytes = processed.main.bytes + processed.thumb.bytes;

  const limitGb = await getLimit(ctx, "limit.storage_gb");
  const limitBytes = limitGb === null ? null : limitGb * 1024 ** 3;

  // Network I/O OUTSIDE the transaction (Bible §8.8): put the clean variants
  // first; if the transaction below fails, the stray objects are swept by the
  // nightly storage reconcile (no live file row → orphan cleanup path).
  const store = objectStore();
  const CACHE = "private, max-age=3600";
  await store.put("tenant-media", mainPath, processed.main.buffer, "image/png", CACHE);
  await store.put("tenant-media", thumbPath, processed.thumb.buffer, "image/png", CACHE);

  const variants: FileVariants = {
    main: {
      path: mainPath,
      bytes: processed.main.bytes,
      width: processed.main.width,
      height: processed.main.height,
      mime: "image/png",
    },
    thumb: {
      path: thumbPath,
      bytes: processed.thumb.bytes,
      width: processed.thumb.width,
      height: processed.thumb.height,
      mime: "image/png",
    },
  };

  await command(
    ctx,
    {
      audit: {
        action: "branding.logo.upload",
        entityType: "file",
        entityId: fileId,
        summary: `Uploaded organization logo ${input.fileName}`,
        after: { fileId, bytes: totalBytes, mime: "image/png" },
      },
    },
    async (tx) => {
      const usage = (await tx.execute(
        sql`select bytes_used from public.org_storage_usage where org_id = ${ctx.orgId}`,
      )) as unknown as Array<{ bytes_used: string | number }>;
      const used = usage[0] ? Number(usage[0].bytes_used) : 0;
      const q = evaluateQuota(used, limitBytes, totalBytes);
      if (!q.allowed) {
        throw new BrandingError(
          "quota_exceeded",
          "storage limit reached — adds are blocked (reads are never blocked)",
        );
      }
      await tx.execute(sql`
        insert into public.file
          (id, org_id, access_class, attached_to_type, attached_to_id, bucket,
           object_path, original_name, mime, status, bytes, variants,
           exif_stripped, created_by)
        values
          (${fileId}, ${ctx.orgId}, 'job_media', 'org', ${ctx.orgId}, 'tenant-media',
           ${mainPath}, ${input.fileName}, 'image/png', 'ready', ${totalBytes},
           ${JSON.stringify(variants)}::jsonb, true, ${ctx.userId})
      `);
      await tx.execute(sql`
        insert into public.org_storage_usage (org_id, bytes_used)
        values (${ctx.orgId}, greatest(0, ${totalBytes})::bigint)
        on conflict (org_id)
        do update set bytes_used = greatest(0, public.org_storage_usage.bytes_used + ${totalBytes})
      `);
      await tx.execute(sql`
        insert into public.org_branding (org_id, logo_file_id)
        values (${ctx.orgId}, ${fileId})
        on conflict (org_id) do update set logo_file_id = excluded.logo_file_id,
          updated_at = now()
      `);
    },
  );
  return { fileId };
}

/** Clear the logo pointer. The file row (and its bytes) are never hard-deleted
 * — void/retention flows own that lifecycle. */
export async function removeLogo(ctx: Ctx, archetype: RoleArchetype): Promise<void> {
  assertCan(archetype, "config.manage");
  await command(
    ctx,
    {
      audit: {
        action: "branding.logo.remove",
        entityType: "org",
        entityId: ctx.orgId,
        summary: "Removed organization logo",
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.org_branding set logo_file_id = null, updated_at = now()
        where org_id = ${ctx.orgId}
      `);
    },
  );
}

// ── gated display reads (never throw on a missing capability) ────────────────
export type AppBranding = {
  /** feat.branding_app — gates the in-app placements (header/dashboard). */
  enabled: boolean;
  branding: OrgBranding;
};

/** In-APP placements read: the header/dashboard render the logo only when
 * feat.branding_app resolves true (growth-trial plans grant it); otherwise the
 * caller falls back to the initials avatar. Per-request memoized (React
 * cache()): the org layout and OrgLogo share one read per request — keyed on
 * the ctx object identity, which resolveCtx (itself cache()d) keeps stable. */
export const getAppBranding = cache(async (ctx: Ctx): Promise<AppBranding> => {
  const [enabled, branding] = await Promise.all([
    hasFeature(ctx, "feat.branding_app"),
    getBranding(ctx),
  ]);
  return { enabled, branding };
});

export type DocBranding = {
  /** Embedded at render time from tenant-scoped storage — never a URL. */
  logoDataUri: string | null;
  displayName: string | null;
  footerDetails: string | null;
};

const EMPTY_DOC_BRANDING: DocBranding = {
  logoDataUri: null,
  displayName: null,
  footerDetails: null,
};

/**
 * DOCUMENT placements read (LPO / quote / invoice renderers). Gated by
 * feat.branding_docs — when off, templates keep their org-name text header.
 * The logo bytes come from the org's OWN file row (RLS-scoped read) and are
 * embedded as a data URI; a storage hiccup degrades to the text fallback
 * rather than failing the document render.
 */
export async function getDocBranding(ctx: Ctx): Promise<DocBranding> {
  if (!(await hasFeature(ctx, "feat.branding_docs"))) return { ...EMPTY_DOC_BRANDING };
  const branding = await getBranding(ctx);
  let logoDataUri: string | null = null;
  if (branding.logoFileId) {
    try {
      // RLS scopes this read to ctx.orgId — a foreign file id yields null.
      const file = await getFile(ctx, branding.logoFileId);
      const main = file && file.status === "ready" && !file.voidedAt ? file.variants?.main : null;
      if (main) {
        const bytes = await objectStore().get(file!.bucket, main.path);
        if (bytes) logoDataUri = `data:${main.mime};base64,${bytes.toString("base64")}`;
      }
    } catch (err) {
      logger.warn(
        { orgId: ctx.orgId, requestId: ctx.requestId, err: (err as Error).message },
        "branding logo fetch failed — document renders with the org-name fallback",
      );
      logoDataUri = null;
    }
  }
  return {
    logoDataUri,
    displayName: branding.displayName,
    footerDetails: branding.footerDetails,
  };
}
