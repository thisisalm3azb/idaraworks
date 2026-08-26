"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { createCustomer, setCustomerActive, updateCustomer } from "@/modules/masters/service";
import { classifyMasterDataError, failMasterDataAction } from "@/platform/http/actionError";
import { currentRequestId } from "@/platform/observability";
import { requestLogger } from "@/platform/logger";
import type { RelationshipCreateResult } from "@/platform/ui";

/** Typed-result outcome for the client customer forms (003C): field-specific,
 * nothing in the URL, nothing lost on failure. Sensitive values never leave
 * the form — no query-string echo on this path. */
export type CustomerActionResult =
  { ok: true } | { ok: false; error: string; field?: string; correlationId?: string };

async function classify(
  err: unknown,
  ctx: { orgId: string; userId: string },
  action: string,
): Promise<{ error: string; field?: string; correlationId?: string }> {
  const { code, field } = classifyMasterDataError(err);
  if (code !== "server_error") return { error: code, field };
  const correlationId = await currentRequestId();
  requestLogger({ requestId: correlationId, orgId: ctx.orgId, userId: ctx.userId }).error(
    { err: (err as Error)?.message ?? String(err), action },
    "customer action failed unexpectedly",
  );
  return { error: code, correlationId };
}

function customerInput(formData: FormData) {
  return {
    name: String(formData.get("name") ?? ""),
    country:
      String(formData.get("country") ?? "")
        .trim()
        .toUpperCase() || undefined,
    contactName: String(formData.get("contact_name") ?? "") || undefined,
    phone: String(formData.get("phone") ?? "") || undefined,
    email: String(formData.get("email") ?? "") || undefined,
    taxRegNo: String(formData.get("tax_reg_no") ?? "") || undefined,
    notes: String(formData.get("notes") ?? "") || undefined,
  };
}

/** Full-page create (Customers page). Keeps the established echo pattern for
 * the server-rendered form; success now lands on the NEW CUSTOMER's detail
 * page (workflow continuity) instead of the generic list. */
export async function createCustomerAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/customers`;
  const values = {
    name: String(formData.get("name") ?? ""),
    country: String(formData.get("country") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    tax_reg_no: String(formData.get("tax_reg_no") ?? ""),
  };
  let id = "";
  try {
    ({ id } = await createCustomer(resolved.ctx, resolved.archetype, customerInput(formData)));
  } catch (err) {
    return failMasterDataAction(err, { ctx: resolved.ctx, base, entity: "customer", values });
  }
  revalidatePath(base);
  redirect(`${base}/${id}`);
}

/** Inline create for RelationshipField (New Quote etc.): typed result, the
 * same audited service command, minimal fields. */
export async function createCustomerInlineAction(
  orgId: string,
  formData: FormData,
): Promise<RelationshipCreateResult> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") return { ok: false, error: "unauthorized" };
  const input = customerInput(formData);
  try {
    const { id } = await createCustomer(resolved.ctx, resolved.archetype, input);
    revalidatePath(`/o/${orgId}/customers`);
    return { ok: true, id, label: input.name };
  } catch (err) {
    return { ok: false, ...(await classify(err, resolved.ctx, "customer.inline_create")) };
  }
}

/** Edit (typed result; the client form owns its state — nothing is echoed
 * through URLs). `active` is deliberately NOT accepted here: lifecycle moves
 * only through setCustomerActiveAction. */
export async function updateCustomerAction(
  orgId: string,
  customerId: string,
  currentActive: boolean,
  formData: FormData,
): Promise<CustomerActionResult> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") return { ok: false, error: "unauthorized" };
  try {
    await updateCustomer(resolved.ctx, resolved.archetype, customerId, {
      ...customerInput(formData),
      active: currentActive,
    });
  } catch (err) {
    return { ok: false, ...(await classify(err, resolved.ctx, "customer.update")) };
  }
  revalidatePath(`/o/${orgId}/customers`);
  revalidatePath(`/o/${orgId}/customers/${customerId}`);
  return { ok: true };
}

/** Archive / reactivate — explicit lifecycle command, idempotent, audited. */
export async function setCustomerActiveAction(
  orgId: string,
  customerId: string,
  active: boolean,
): Promise<CustomerActionResult> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") return { ok: false, error: "unauthorized" };
  try {
    await setCustomerActive(resolved.ctx, resolved.archetype, customerId, active);
  } catch (err) {
    return { ok: false, ...(await classify(err, resolved.ctx, "customer.lifecycle")) };
  }
  revalidatePath(`/o/${orgId}/customers`);
  revalidatePath(`/o/${orgId}/customers/${customerId}`);
  return { ok: true };
}
