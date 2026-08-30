"use server";
/** H21 — My Work status updates. The same audited command the work detail
 * uses; this surface only chooses which task to act on. */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { updateTaskStatus } from "@/modules/jobs/service";

export async function myWorkStatusAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const back = `/o/${orgId}/my-work`;
  try {
    await updateTaskStatus(resolved.ctx, resolved.archetype, String(formData.get("task_id")), {
      status: String(formData.get("status")),
      reason: (formData.get("reason") as string) || undefined,
    });
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    redirect(`${back}?error=1`);
  }
  revalidatePath(back);
  redirect(`${back}?ok=1`);
}
