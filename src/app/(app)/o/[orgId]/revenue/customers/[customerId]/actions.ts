"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import {
  logActivity,
  MergeError,
  mergeCustomers,
  recordConsent,
  recordSignal,
  suppressAddress,
  updateContactRole,
  updateCustomerCrm,
} from "@/modules/crm/service";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};

async function ctxOrRedirect(orgId: string) {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  return resolved;
}
function fail(back: string, err: unknown): never {
  if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
  const code =
    err instanceof ForbiddenError ? "forbidden" : err instanceof MergeError ? err.code : "failed";
  redirect(`${back}?error=${code}`);
}

export async function updateCustomerCrmAction(
  orgId: string,
  customerId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/customers/${customerId}`;
  try {
    await updateCustomerCrm(resolved.ctx, resolved.archetype, {
      customerId,
      ownerUserId: str(formData, "owner_user_id"),
      territoryId: str(formData, "territory_id"),
      tags: (str(formData, "tags") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20),
      segment: str(formData, "segment"),
    });
    revalidatePath(back);
    redirect(`${back}?ok=saved`);
  } catch (err) {
    fail(back, err);
  }
}

export async function updateContactRoleAction(
  orgId: string,
  customerId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/customers/${customerId}`;
  try {
    await updateContactRole(resolved.ctx, resolved.archetype, {
      contactId: String(formData.get("contact_id") ?? ""),
      roleKind: str(formData, "role_kind") ?? undefined,
      language: str(formData, "language"),
      notes: str(formData, "notes"),
    });
    revalidatePath(back);
    redirect(`${back}?ok=saved#contacts`);
  } catch (err) {
    fail(back, err);
  }
}

export async function recordConsentAction(
  orgId: string,
  customerId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/customers/${customerId}`;
  try {
    const contactId = str(formData, "contact_id");
    await recordConsent(resolved.ctx, resolved.archetype, {
      customerId: contactId ? null : customerId,
      contactId,
      channel: String(formData.get("channel") ?? "email"),
      status: String(formData.get("status") ?? "unknown"),
      source: String(formData.get("source") ?? "written"),
      evidence: str(formData, "evidence"),
    });
    revalidatePath(back);
    redirect(`${back}?ok=consent#consent`);
  } catch (err) {
    fail(back, err);
  }
}

export async function suppressAddressAction(
  orgId: string,
  customerId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/customers/${customerId}`;
  try {
    await suppressAddress(resolved.ctx, resolved.archetype, {
      channel: String(formData.get("channel") ?? "email"),
      address: String(formData.get("address") ?? ""),
      reason: String(formData.get("reason") ?? "manual"),
      note: str(formData, "note"),
    });
    revalidatePath(back);
    redirect(`${back}?ok=suppressed#consent`);
  } catch (err) {
    fail(back, err);
  }
}

export async function recordSignalAction(
  orgId: string,
  customerId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/customers/${customerId}`;
  const score = str(formData, "score");
  try {
    await recordSignal(resolved.ctx, resolved.archetype, {
      customerId,
      kind: String(formData.get("kind") ?? "note"),
      score: score === null ? null : Number(score),
      status: str(formData, "status"),
      title: str(formData, "title"),
      body: str(formData, "body"),
      dueOn: str(formData, "due_on"),
    });
    revalidatePath(back);
    redirect(`${back}?ok=signal#health`);
  } catch (err) {
    fail(back, err);
  }
}

export async function logCustomerActivityAction(
  orgId: string,
  customerId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/customers/${customerId}`;
  try {
    await logActivity(resolved.ctx, resolved.archetype, {
      customerId,
      contactId: str(formData, "contact_id"),
      kind: String(formData.get("kind") ?? "note"),
      title: str(formData, "title"),
      body: str(formData, "body"),
      dueDate: str(formData, "due_date"),
      outcome: str(formData, "outcome"),
    });
    revalidatePath(back);
    redirect(`${back}?ok=logged#timeline`);
  } catch (err) {
    fail(back, err);
  }
}

/** Apply a reviewed merge: the preview page posts the resolutions and reason. */
export async function mergeCustomersAction(
  orgId: string,
  targetId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/customers/${targetId}/merge`;
  const sourceId = String(formData.get("source_id") ?? "");
  const resolutions: Record<string, "target" | "source"> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("res_") && (v === "target" || v === "source")) resolutions[k.slice(4)] = v;
  }
  try {
    await mergeCustomers(resolved.ctx, resolved.archetype, {
      sourceId,
      targetId,
      resolutions,
      reason: String(formData.get("reason") ?? ""),
    });
    revalidatePath(`/o/${orgId}/revenue/customers/${targetId}`);
    revalidatePath(`/o/${orgId}/customers`);
    redirect(`/o/${orgId}/revenue/customers/${targetId}?ok=merged`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const code =
      err instanceof ForbiddenError ? "forbidden" : err instanceof MergeError ? err.code : "failed";
    redirect(`${back}?source=${sourceId}&error=${code}`);
  }
}
