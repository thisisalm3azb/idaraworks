"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { createSupplier } from "@/modules/masters/service";
import { failMasterDataAction } from "@/platform/http/actionError";

export async function createSupplierAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/suppliers`;
  // Captured up front so a failure can echo them back — the form is never wiped.
  const values = {
    name: String(formData.get("name") ?? ""),
    tax_reg_no: String(formData.get("tax_reg_no") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
  };
  try {
    await createSupplier(resolved.ctx, resolved.archetype, {
      name: values.name,
      taxRegNo: values.tax_reg_no || undefined,
      phone: values.phone || undefined,
      email: values.email || undefined,
    });
  } catch (err) {
    return failMasterDataAction(err, { ctx: resolved.ctx, base, entity: "supplier", values });
  }
  revalidatePath(base);
  redirect(base);
}
