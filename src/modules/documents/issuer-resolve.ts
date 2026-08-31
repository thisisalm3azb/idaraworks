/**
 * The one place a document decides whose identity it carries (H22.0).
 *
 * A draft shows the company as it is now. An issued document shows the company
 * as it was when it was issued, read back from the snapshot taken at that
 * moment. An issued document with no usable snapshot — one from before H22.0,
 * or a snapshot that no longer satisfies its own contract — falls back to
 * current details AND SAYS SO, because presenting today's legal name and tax
 * number as though they were the ones on the customer's copy is a quiet lie.
 *
 * This lives in its own leaf module rather than in service.ts because the
 * weekly plan's document builder needs it too, and service.ts already imports
 * that builder. Sharing it through the service would close a cycle; a leaf both
 * sides import cannot.
 */
import {
  shellIssuerFromIdentity,
  shellIssuerFromSnapshot,
  legacyIssuerFallback,
  IssuerSnapshot,
} from "@/platform/documents";
import { getDocumentProfile } from "@/modules/branding/service";
import type { Ctx } from "@/platform/tenancy";

export type ResolvedIssuer = {
  issuer: ReturnType<typeof shellIssuerFromIdentity>;
  /** Shown on the document when the identity is not the one it was issued under. */
  notice?: string;
};

export async function resolveIssuer(
  ctx: Ctx,
  storedSnapshot: unknown,
  isIssued: boolean,
): Promise<ResolvedIssuer> {
  const profile = await getDocumentProfile(ctx);
  if (!isIssued) {
    return { issuer: shellIssuerFromIdentity(profile.identity, profile.logoDataUri) };
  }
  const parsed = IssuerSnapshot.safeParse(storedSnapshot);
  if (parsed.success) {
    return { issuer: shellIssuerFromSnapshot(parsed.data, profile.logoDataUri) };
  }
  const fallback = legacyIssuerFallback(profile.identity);
  return {
    issuer: shellIssuerFromIdentity(fallback.identity, profile.logoDataUri),
    notice: "Issued before document snapshots were recorded. Details shown are current.",
  };
}
