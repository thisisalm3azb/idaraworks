/**
 * Issuer identity for formal documents (003B.1 — audit §12, phase2/14 §4).
 *
 * Two shapes live here:
 *
 * 1. `IssuerIdentity` — the serializable issuer view the document-profile
 *    service resolves per request (current truth; used by draft previews and
 *    by the Brand & Documents sample).
 * 2. `IssuerSnapshot` — the IMMUTABLE capture taken at the moment a
 *    commercial/legal document becomes formal (quote sent, invoice issued,
 *    purchase order formalized). Historical-integrity rule: draft previews
 *    always use the current profile; a formal document re-renders from its
 *    stored snapshot forever — later logo/TRN/address/legal-name changes must
 *    never rewrite issued documents. Documents issued before snapshot support
 *    render through an EXPLICIT legacy fallback (`legacyIssuerFallback`) —
 *    the current profile is never silently retrofitted as historical truth.
 *
 * The snapshot stores the logo as a FILE REFERENCE, not bytes: file rows are
 * never hard-deleted (replacing a logo only moves the org_branding pointer),
 * so the referenced row remains resolvable, tenant-scoped, forever. The
 * transition writers and storage columns land with the first print/export
 * routes (003B.2); this module fixes the schema and compatibility rules so
 * those writers cannot improvise.
 *
 * Pure + platform-level: no database access, no module imports.
 */
import { z } from "zod";

export const ISSUER_SNAPSHOT_VERSION = 1 as const;

export const DOC_LANGUAGES = ["en", "ar", "bilingual"] as const;
export type DocLanguage = (typeof DOC_LANGUAGES)[number];

const bounded = (max: number) => z.string().trim().min(1).max(max).nullable();

/** The current-truth issuer view (resolved by the document-profile service). */
export type IssuerIdentity = {
  /** Trading/display name (org_branding.display_name → org name). */
  tradingName: string;
  /** Legal entity name (company.legal_name → org_branding.legal_name → company.name). */
  legalName: string;
  /** TRN/VAT/tax registration — company.tax_reg_no is the ONLY source. */
  trn: string | null;
  licenseNo: string | null;
  addressEn: string | null;
  addressAr: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  paymentInstructions: string | null;
  footer: string | null;
  docLanguage: DocLanguage;
  logoFileId: string | null;
};

/**
 * Immutable issuer capture. `strict()` — unknown keys are rejected so a stored
 * snapshot can never smuggle fields the renderer would trust; `version` pins
 * the shape for forward migration of old snapshots.
 */
export const IssuerSnapshot = z
  .object({
    version: z.literal(ISSUER_SNAPSHOT_VERSION),
    /** ISO-8601 capture moment (the formalization transition supplies it). */
    capturedAt: z.string().datetime(),
    legalName: z.string().trim().min(1).max(200),
    tradingName: bounded(120),
    trn: bounded(50),
    licenseNo: bounded(100),
    addressEn: bounded(400),
    addressAr: bounded(400),
    city: bounded(120),
    region: bounded(120),
    postalCode: bounded(20),
    country: bounded(120),
    phone: bounded(50),
    email: bounded(254),
    website: bounded(200),
    signatoryName: bounded(160),
    signatoryTitle: bounded(160),
    paymentInstructions: z.string().trim().min(1).max(1000).nullable(),
    footer: z.string().trim().min(1).max(500).nullable(),
    docLanguage: z.enum(DOC_LANGUAGES),
    logoFileId: z.string().uuid().nullable(),
  })
  .strict();
export type IssuerSnapshot = z.infer<typeof IssuerSnapshot>;

/**
 * Capture the immutable snapshot from the current identity. Throws (Zod) when
 * the identity cannot form a valid snapshot — formalization must fail loudly
 * rather than issue a document with a broken issuer block.
 */
export function captureIssuerSnapshot(
  identity: IssuerIdentity,
  capturedAt: string,
): IssuerSnapshot {
  return IssuerSnapshot.parse({
    version: ISSUER_SNAPSHOT_VERSION,
    capturedAt,
    legalName: identity.legalName,
    tradingName: identity.tradingName || null,
    trn: identity.trn,
    licenseNo: identity.licenseNo,
    addressEn: identity.addressEn,
    addressAr: identity.addressAr,
    city: identity.city,
    region: identity.region,
    postalCode: identity.postalCode,
    country: identity.country,
    phone: identity.phone,
    email: identity.email,
    website: identity.website,
    signatoryName: identity.signatoryName,
    signatoryTitle: identity.signatoryTitle,
    paymentInstructions: identity.paymentInstructions,
    footer: identity.footer,
    docLanguage: identity.docLanguage,
    logoFileId: identity.logoFileId,
  });
}

/**
 * Explicit legacy fallback for documents formalized BEFORE snapshot support:
 * renders from the current identity but is marked `legacy: true` so the
 * renderer/UI can say so — never presented as a stored historical snapshot.
 */
export function legacyIssuerFallback(identity: IssuerIdentity): {
  legacy: true;
  identity: IssuerIdentity;
} {
  return { legacy: true, identity };
}

/**
 * Bilingual address formatting: one line per language, composed from the
 * structured fields (never parsed back out of the footer). Missing parts are
 * skipped; an identity with no address parts formats to null.
 */
export function formatIssuerAddress(
  identity: Pick<
    IssuerIdentity,
    "addressEn" | "addressAr" | "city" | "region" | "postalCode" | "country"
  >,
  lang: "en" | "ar",
): string | null {
  const street =
    lang === "ar"
      ? (identity.addressAr ?? identity.addressEn)
      : (identity.addressEn ?? identity.addressAr);
  const parts = [street, identity.city, identity.region, identity.postalCode, identity.country]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  // Arabic joins with the Arabic comma; both keep the same structured order.
  return parts.join(lang === "ar" ? "، " : ", ");
}
