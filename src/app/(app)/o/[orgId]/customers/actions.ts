"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { createCustomer } from "@/modules/masters/service";
import { failMasterDataAction } from "@/platform/http/actionError";

export async function createCustomerAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/customers`;
  // Captured up front so a failure can echo them back — the form is never wiped.
  const values = {
    name: String(formData.get("name") ?? ""),
    country: String(formData.get("country") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    tax_reg_no: String(formData.get("tax_reg_no") ?? ""),
  };
  try {
    await createCustomer(resolved.ctx, resolved.archetype, {
      name: values.name,
      country: values.country.trim().toUpperCase() || undefined,
      phone: values.phone || undefined,
      email: values.email || undefined,
      taxRegNo: values.tax_reg_no || undefined,
    });
  } catch (err) {
    return failMasterDataAction(err, { ctx: resolved.ctx, base, entity: "customer", values });
  }
  revalidatePath(base);
  redirect(base);
}
