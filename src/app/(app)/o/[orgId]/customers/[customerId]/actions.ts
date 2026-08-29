"use server";

/**
 * H19 — Customer 360 contact actions. The customer association is resolved
 * and validated on the SERVER (route params, org-scoped service checks) —
 * the browser can never substitute another organization's customer, and
 * duplicate submissions are safe (adds are idempotent per submit; removal
 * of an already-removed contact is a no-op update).
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { addCustomerContact, deactivateCustomerContact } from "@/modules/masters/service";

export async function addContactAction(
  orgId: string,
  customerId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (typeof resolved === "string") {
    redirect(resolved === "mfa_required" ? "/mfa" : "/");
  }
  const back = `/o/${orgId}/customers/${customerId}`;
  try {
    await addCustomerContact(resolved.ctx, resolved.archetype, customerId, {
      name: String(formData.get("name") ?? ""),
      roleTitle: String(formData.get("role_title") ?? "") || undefined,
      phone: String(formData.get("phone") ?? "") || undefined,
      email: String(formData.get("email") ?? "") || undefined,
      isPrimary: formData.get("is_primary") === "1",
    });
  } catch {
    redirect(`${back}?error=contact`);
  }
  revalidatePath(back);
  redirect(`${back}?ok=contact_added`);
}

export async function removeContactAction(
  orgId: string,
  customerId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (typeof resolved === "string") {
    redirect(resolved === "mfa_required" ? "/mfa" : "/");
  }
  const back = `/o/${orgId}/customers/${customerId}`;
  try {
    await deactivateCustomerContact(
      resolved.ctx,
      resolved.archetype,
      customerId,
      String(formData.get("contact_id") ?? ""),
    );
  } catch {
    redirect(`${back}?error=contact`);
  }
  revalidatePath(back);
  redirect(back);
}
