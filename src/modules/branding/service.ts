/**
 * Organization branding (U2; migration 0071) — ONE governed source for the
 * tenant's visual identity: logo (a normal file-pipeline row, re-encoded
 * server-side), accent colour, display/legal names and document footer.
 *
 * Enforcement (honest add-on gates, display-level — reads NEVER throw):
 *   feat.branding_app  → in-app placements (header/dashboard logo)
 *   feat.branding_docs → ADVANCED document styling only (accent/letterhead —
 *                        003B.1). Basic document identity (logo, names, TRN,
 *                        address, footer) is CORE and never gated.
 * When branding_app is off the in-app caller falls back to the
 * organization-name initials avatar.
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
import {
  DOC_LANGUAGES,
  formatIssuerAddress,
  type DocLanguage,
  type IssuerIdentity,
} from "@/platform/documents";
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
  // legalName intentionally ABSENT (003B.1): org_branding.legal_name is frozen
  // as a legacy fallback — the canonical legal name lives on the default
  // company row (saveDocumentIdentity). Two legal names must never drift.
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
      // legal_name is deliberately untouched (frozen legacy column — 003B.1).
      await tx.execute(sql`
        insert into public.org_branding
          (org_id, accent_color, display_name, footer_details)
        values (${ctx.orgId}, ${input.accentColor}, ${input.displayName},
                ${input.footerDetails})
        on conflict (org_id) do update set
          accent_color = excluded.accent_color,
          display_name = excluded.display_name,
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

// ── Document profile (003B.1 — audit §12, phase2/14 §4) ──────────────────────
//
// ONE composed issuer read for every formal document. `company` (the default
// row) is the canonical LEGAL identity — legal name, TRN (the only source),
// licence, structured bilingual address, contacts, signatory, payment
// instructions, default document language. `org_branding` is the canonical
// VISUAL identity — logo, accent, trading display name, footer. Basic issuer
// identity is a CORE capability: it is NEVER entitlement-gated.
// feat.branding_docs gates ADVANCED STYLING ONLY (accent/letterhead controls).

/** Resolve the tenant-scoped logo embed. Never a URL; degrades to null (the
 * shell then renders the legal-name text header). */
async function resolveLogoDataUri(ctx: Ctx, logoFileId: string | null): Promise<string | null> {
  if (!logoFileId) return null;
  try {
    // RLS scopes this read to ctx.orgId — a foreign file id yields null.
    const file = await getFile(ctx, logoFileId);
    const main = file && file.status === "ready" && !file.voidedAt ? file.variants?.main : null;
    if (!main) return null;
    const bytes = await objectStore().get(file!.bucket, main.path);
    return bytes ? `data:${main.mime};base64,${bytes.toString("base64")}` : null;
  } catch (err) {
    logger.warn(
      { orgId: ctx.orgId, requestId: ctx.requestId, err: (err as Error).message },
      "branding logo fetch failed — document renders with the legal-name fallback",
    );
    return null;
  }
}

const optional = (max: number) =>
  z.preprocess(emptyToNull, z.string().trim().min(1).max(max).nullable());

export const SaveDocumentIdentityInput = z.object({
  legalName: optional(200),
  taxRegNo: optional(50),
  tradeLicenseNo: optional(100),
  addressEn: optional(400),
  addressAr: optional(400),
  city: optional(120),
  region: optional(120),
  postalCode: optional(20),
  country: optional(120),
  phone: optional(50),
  email: z.preprocess(emptyToNull, z.string().trim().email().max(254).nullable()),
  website: optional(200),
  signatoryName: optional(160),
  signatoryTitle: optional(160),
  paymentInstructions: z.preprocess(emptyToNull, z.string().trim().min(1).max(1000).nullable()),
  docLanguage: z.enum(DOC_LANGUAGES),
});
export type SaveDocumentIdentityInput = z.infer<typeof SaveDocumentIdentityInput>;

/** Write the legal issuer identity onto the org's DEFAULT company row (the
 * canonical source; unique-indexed per org by 0074). Audited via command(). */
export async function saveDocumentIdentity(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "config.manage");
  const parsed = SaveDocumentIdentityInput.safeParse(raw);
  if (!parsed.success) throw new BrandingError("invalid_input", "invalid document identity fields");
  const i = parsed.data;
  await command(
    ctx,
    {
      audit: {
        action: "document_profile.update",
        entityType: "org",
        entityId: ctx.orgId,
        summary: "Updated organization document identity",
        after: i,
      },
    },
    async (tx) => {
      const updated = (await tx.execute(sql`
        update public.company set
          legal_name = ${i.legalName},
          tax_reg_no = ${i.taxRegNo},
          trade_license_no = ${i.tradeLicenseNo},
          address_en = ${i.addressEn},
          address_ar = ${i.addressAr},
          city = ${i.city},
          region = ${i.region},
          postal_code = ${i.postalCode},
          country = ${i.country},
          phone = ${i.phone},
          email = ${i.email},
          website = ${i.website},
          signatory_name = ${i.signatoryName},
          signatory_title = ${i.signatoryTitle},
          payment_instructions = ${i.paymentInstructions},
          doc_language = ${i.docLanguage},
          updated_at = now()
        where org_id = ${ctx.orgId} and is_default
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (updated.length === 0) {
        // Legacy safety net: every org since 0003 gets a default company at
        // signup; an org somehow without one gets it created here.
        await tx.execute(sql`
          insert into public.company
            (org_id, name, is_default, legal_name, tax_reg_no, trade_license_no,
             address_en, address_ar, city, region, postal_code, country, phone,
             email, website, signatory_name, signatory_title,
             payment_instructions, doc_language)
          values
            (${ctx.orgId},
             coalesce(${i.legalName}, (select name from public.org where id = ${ctx.orgId})),
             true, ${i.legalName}, ${i.taxRegNo}, ${i.tradeLicenseNo},
             ${i.addressEn}, ${i.addressAr}, ${i.city}, ${i.region},
             ${i.postalCode}, ${i.country}, ${i.phone}, ${i.email}, ${i.website},
             ${i.signatoryName}, ${i.signatoryTitle}, ${i.paymentInstructions},
             ${i.docLanguage})
        `);
      }
    },
  );
}

export type DocumentProfile = {
  /** Structured, serializable issuer identity (platform/documents contract). */
  identity: IssuerIdentity;
  /** Tenant-scoped logo embed — never a URL; null → legal-name text header. */
  logoDataUri: string | null;
  /** Pre-formatted address lines for the shell. */
  addressLineEn: string | null;
  addressLineAr: string | null;
  /** feat.branding_docs — ADVANCED STYLING ONLY (never issuer identity). */
  advancedStyling: boolean;
  /** Only non-null when advanced styling is entitled. */
  accentColor: string | null;
};

/**
 * The ONE issuer read every formal document (and the settings preview) uses.
 * Composes org (name) + default company (legal identity) + org_branding
 * (visual identity). Legal-name resolution — the drift-proof chain:
 * company.legal_name → org_branding.legal_name (frozen legacy) → company.name
 * (signup-seeded) → org.name. Safe for legacy orgs: every field degrades to
 * null and the names always resolve.
 */
export async function getDocumentProfile(ctx: Ctx): Promise<DocumentProfile> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select o.name as org_name,
             c.name as company_name, c.legal_name, c.tax_reg_no,
             c.trade_license_no, c.address_en, c.address_ar, c.city, c.region,
             c.postal_code, c.country, c.phone, c.email, c.website,
             c.signatory_name, c.signatory_title, c.payment_instructions,
             c.doc_language,
             b.logo_file_id::text as logo_file_id, b.accent_color,
             b.display_name, b.legal_name as branding_legal_name,
             b.footer_details
      from public.org o
      left join public.company c on c.org_id = o.id and c.is_default
      left join public.org_branding b on b.org_id = o.id
      where o.id = ${ctx.orgId}
    `),
  )) as unknown as Array<Record<string, string | null>>;
  const r = rows[0] ?? {};
  const orgName = r.org_name ?? "";
  const legalName = r.legal_name ?? r.branding_legal_name ?? r.company_name ?? orgName;
  const tradingName = r.display_name ?? orgName;
  const docLanguage = (r.doc_language ?? "bilingual") as DocLanguage;

  const identity: IssuerIdentity = {
    tradingName,
    legalName,
    trn: r.tax_reg_no ?? null,
    licenseNo: r.trade_license_no ?? null,
    addressEn: r.address_en ?? null,
    addressAr: r.address_ar ?? null,
    city: r.city ?? null,
    region: r.region ?? null,
    postalCode: r.postal_code ?? null,
    country: r.country ?? null,
    phone: r.phone ?? null,
    email: r.email ?? null,
    website: r.website ?? null,
    signatoryName: r.signatory_name ?? null,
    signatoryTitle: r.signatory_title ?? null,
    paymentInstructions: r.payment_instructions ?? null,
    footer: r.footer_details ?? null,
    docLanguage,
    logoFileId: r.logo_file_id ?? null,
  };

  // Core identity is never gated; the feature check covers STYLING only.
  const [advancedStyling, logoDataUri] = await Promise.all([
    hasFeature(ctx, "feat.branding_docs"),
    resolveLogoDataUri(ctx, identity.logoFileId),
  ]);

  return {
    identity,
    logoDataUri,
    addressLineEn: formatIssuerAddress(identity, "en"),
    addressLineAr: formatIssuerAddress(identity, "ar"),
    advancedStyling,
    accentColor: advancedStyling ? (r.accent_color ?? null) : null,
  };
}

export type DocBranding = {
  /** Embedded at render time from tenant-scoped storage — never a URL. */
  logoDataUri: string | null;
  displayName: string | null;
  footerDetails: string | null;
};

/**
 * DOCUMENT placements read (LPO / quote / invoice renderers) — kept for the
 * existing template callers. 003B.1: NO LONGER entitlement-gated — the
 * organization's logo, name and footer are core document identity on every
 * plan (audit §12.1). feat.branding_docs now gates only advanced styling,
 * enforced in getDocumentProfile.
 */
export async function getDocBranding(ctx: Ctx): Promise<DocBranding> {
  const profile = await getDocumentProfile(ctx);
  return {
    logoDataUri: profile.logoDataUri,
    displayName: profile.identity.tradingName,
    footerDetails: profile.identity.footer,
  };
}
