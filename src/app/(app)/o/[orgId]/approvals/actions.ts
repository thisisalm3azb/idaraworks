"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import { decideApproval, ApprovalStateError, SelfApprovalError } from "@/modules/approvals/service";

export async function decideApprovalAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/approvals`;
  const decision = String(formData.get("decision") ?? "") as "approved" | "rejected";
  try {
    await decideApproval(resolved.ctx, resolved.archetype, {
      approvalId: String(formData.get("approval_id") ?? ""),
      decision,
      note: (formData.get("note") as string) || undefined,
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const code =
      err instanceof SelfApprovalError
        ? "self"
        : err instanceof ForbiddenError
          ? "forbidden"
          : err instanceof ApprovalStateError
            ? "state"
            : "failed";
    redirect(`${base}?error=${code}`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=decided`);
}
