"use server";
/** H20 — sales overview actions. */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { completeFollowUp } from "@/modules/crm/service";

/** Complete an overdue follow-up from the overview and stay on it. */
export async function salesFollowUpDoneAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const back = `/o/${orgId}/sales`;
  try {
    await completeFollowUp(
      resolved.ctx,
      resolved.archetype,
      String(formData.get("activity_id") ?? ""),
    );
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    redirect(`${back}?error=1`);
  }
  revalidatePath(back);
  redirect(`${back}#followups`);
}
