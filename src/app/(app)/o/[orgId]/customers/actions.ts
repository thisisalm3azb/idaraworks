"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { createCustomer } from "@/modules/masters/service";

export async function createCustomerAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/customers`;
  try {
    await createCustomer(resolved.ctx, resolved.archetype, {
      name: String(formData.get("name") ?? ""),
      country: (formData.get("country") as string)?.trim().toUpperCase() || undefined,
      phone: (formData.get("phone") as string) || undefined,
      email: (formData.get("email") as string) || undefined,
      taxRegNo: (formData.get("tax_reg_no") as string) || undefined,
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=create_failed`);
  }
  revalidatePath(base);
  redirect(base);
}
