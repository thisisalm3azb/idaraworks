"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { createSupplier } from "@/modules/masters/service";

export async function createSupplierAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/suppliers`;
  try {
    await createSupplier(resolved.ctx, resolved.archetype, {
      name: String(formData.get("name") ?? ""),
      taxRegNo: (formData.get("tax_reg_no") as string) || undefined,
      phone: (formData.get("phone") as string) || undefined,
      email: (formData.get("email") as string) || undefined,
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=create_failed`);
  }
  revalidatePath(base);
  redirect(base);
}
