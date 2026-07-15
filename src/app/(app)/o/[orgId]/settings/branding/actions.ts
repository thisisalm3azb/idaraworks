"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { assertCan } from "@/platform/authz";
import { currentRequestId } from "@/platform/observability";
import { requestLogger } from "@/platform/logger";
import {
  BrandingError,
  LOGO_MAX_BYTES,
  removeLogo,
  saveBranding,
  uploadLogo,
} from "@/modules/branding/service";

async function resolveOr(orgId: string) {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  assertCan(resolved.archetype, "config.manage");
  return resolved;
}

/** Map a caught error to a client result. A BrandingError surfaces its specific
 * validation code (each mapped to a helpful message); anything unexpected is
 * logged server-side with a correlation id and returned as a generic
 * server_error carrying that id ("Reference: <id>" for the user to quote). */
async function toResult(
  err: unknown,
  ctx: { orgId: string; userId: string },
): Promise<BrandingActionResult> {
  if (err instanceof BrandingError) return { error: err.code };
  const correlationId = await currentRequestId();
  requestLogger({ requestId: correlationId, orgId: ctx.orgId, userId: ctx.userId }).error(
    { err: (err as Error)?.message ?? String(err), action: "branding.logo_upload" },
    "branding action failed unexpectedly",
  );
  return { error: "server_error", correlationId };
}

function revalidate(orgId: string): void {
  revalidatePath(`/o/${orgId}/settings/branding`);
  revalidatePath(`/o/${orgId}`, "layout"); // the header brand slot changes
}

export type BrandingActionResult = { error: string | null; correlationId?: string };

/** Logo upload (client-invoked with FormData carrying the file). */
export async function uploadLogoAction(
  orgId: string,
  formData: FormData,
): Promise<BrandingActionResult> {
  const resolved = await resolveOr(orgId);
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) return { error: "bad_type" };
  // Cheap pre-check before buffering; the service re-validates authoritatively.
  if (file.size > LOGO_MAX_BYTES) return { error: "too_large" };
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    await uploadLogo(resolved.ctx, resolved.archetype, {
      fileName: file.name || "logo",
      mime: file.type,
      bytes,
    });
  } catch (err) {
    return toResult(err, resolved.ctx);
  }
  revalidate(orgId);
  return { error: null };
}

export async function removeLogoAction(orgId: string): Promise<BrandingActionResult> {
  const resolved = await resolveOr(orgId);
  try {
    await removeLogo(resolved.ctx, resolved.archetype);
  } catch (err) {
    return toResult(err, resolved.ctx);
  }
  revalidate(orgId);
  return { error: null };
}

export async function saveBrandingAction(
  orgId: string,
  formData: FormData,
): Promise<BrandingActionResult> {
  const resolved = await resolveOr(orgId);
  try {
    await saveBranding(resolved.ctx, resolved.archetype, {
      accentColor: String(formData.get("accent_color") ?? ""),
      displayName: String(formData.get("display_name") ?? ""),
      legalName: String(formData.get("legal_name") ?? ""),
      footerDetails: String(formData.get("footer_details") ?? ""),
    });
  } catch (err) {
    return toResult(err, resolved.ctx);
  }
  revalidate(orgId);
  return { error: null };
}
