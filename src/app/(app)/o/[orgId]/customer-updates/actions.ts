"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import {
  createDraft,
  updateDraft,
  sendUpdate,
  revokeShare,
  CustomerUpdateStateError,
} from "@/modules/customer-updates/service";

export async function createDraftAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const jobId = String(formData.get("job_id") ?? "").trim();
  const customerId = String(formData.get("customer_id") ?? "").trim();
  try {
    const { id } = await createDraft(resolved.ctx, resolved.archetype, {
      jobId: jobId || undefined,
      customerId: customerId || undefined,
      title: String(formData.get("title") ?? ""),
      body: String(formData.get("body") ?? ""),
      language: String(formData.get("language") ?? "ar") as never,
    });
    revalidatePath(`/o/${orgId}/customer-updates`);
    redirect(`/o/${orgId}/customer-updates/${id}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(
      `/o/${orgId}/customer-updates/new?error=${err instanceof ForbiddenError ? "forbidden" : "failed"}`,
    );
  }
}

export async function updateDraftAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("update_id") ?? "");
  try {
    await updateDraft(resolved.ctx, resolved.archetype, id, {
      title: String(formData.get("title") ?? "") || undefined,
      body: String(formData.get("body") ?? "") || undefined,
    });
    revalidatePath(`/o/${orgId}/customer-updates/${id}`);
    redirect(`/o/${orgId}/customer-updates/${id}?ok=saved`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`/o/${orgId}/customer-updates/${id}?error=state`);
  }
}

export async function sendUpdateAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("update_id") ?? "");
  try {
    await sendUpdate(resolved.ctx, resolved.archetype, id);
    revalidatePath(`/o/${orgId}/customer-updates/${id}`);
    redirect(`/o/${orgId}/customer-updates/${id}?ok=sent`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(
      `/o/${orgId}/customer-updates/${id}?error=${err instanceof CustomerUpdateStateError ? "state" : "failed"}`,
    );
  }
}

/**
 * Send + REVEAL the link inline (never via the URL — a token is sensitive). Returns the
 * absolute share URL ONCE for the client to display/copy; the raw token is never persisted.
 */
export async function sendAndRevealAction(
  orgId: string,
  updateId: string,
): Promise<{ link: string } | { error: string }> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") return { error: "mfa" };
  if (typeof resolved === "string") return { error: "auth" };
  try {
    const { token } = await sendUpdate(resolved.ctx, resolved.archetype, updateId);
    const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
    revalidatePath(`/o/${orgId}/customer-updates/${updateId}`);
    return { link: `${base}/s/${token}` };
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: "forbidden" };
    return { error: err instanceof CustomerUpdateStateError ? "state" : "failed" };
  }
}

export async function revokeShareAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("update_id") ?? "");
  const tokenId = String(formData.get("token_id") ?? "");
  try {
    await revokeShare(resolved.ctx, resolved.archetype, tokenId);
    revalidatePath(`/o/${orgId}/customer-updates/${id}`);
    redirect(`/o/${orgId}/customer-updates/${id}?ok=revoked`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`/o/${orgId}/customer-updates/${id}?error=state`);
  }
}
