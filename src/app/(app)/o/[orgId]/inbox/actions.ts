"use server";

/**
 * Marking a notification read (H22F).
 *
 * The only mutation the inbox has. It is scoped to the caller by RLS and by the
 * statement's own predicate, so "mark somebody else's notification read" is not
 * a request this can express.
 */
import { revalidatePath } from "next/cache";
import { resolveCtx } from "@/platform/auth/resolve";
import { markNotificationRead } from "@/platform/notifications";

export async function markReadAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") return;
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await markNotificationRead(resolved.ctx, id);
  revalidatePath(`/o/${orgId}/inbox`);
}
