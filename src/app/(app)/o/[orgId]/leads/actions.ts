"use server";
/** H20 — lead list actions. Same audited service commands as everywhere;
 * actions only translate the form post and route the outcome. */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { createLead } from "@/modules/crm/service";

export async function createLeadAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/leads`;
  let id = "";
  try {
    ({ id } = await createLead(resolved.ctx, resolved.archetype, {
      name: String(formData.get("name") ?? ""),
      contactName: String(formData.get("contact_name") ?? "") || undefined,
      phone: String(formData.get("phone") ?? "") || undefined,
      email: String(formData.get("email") ?? "") || undefined,
      source: String(formData.get("source") ?? "") || undefined,
      notes: String(formData.get("notes") ?? "") || undefined,
    }));
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    redirect(`${base}?error=create`);
  }
  revalidatePath(base);
  redirect(`${base}/${id}`);
}
