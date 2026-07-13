"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { createIssue, updateIssueStatus, InvalidIssueError } from "@/modules/issues/service";
import { ForbiddenError } from "@/platform/authz";

export async function raiseIssueAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/issues`;
  try {
    await createIssue(resolved.ctx, resolved.archetype, {
      jobId: (formData.get("job_id") as string) || undefined,
      title: String(formData.get("title") ?? ""),
      description: (formData.get("description") as string) || undefined,
      severity: (formData.get("severity") as string) || "medium",
      isBlocker: formData.get("is_blocker") === "on",
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const code =
      err instanceof ForbiddenError
        ? "forbidden"
        : err instanceof InvalidIssueError
          ? "invalid"
          : "failed";
    redirect(`${base}?error=${code}`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=raised`);
}

export async function updateIssueStatusAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/issues`;
  try {
    await updateIssueStatus(resolved.ctx, resolved.archetype, {
      issueId: String(formData.get("issue_id") ?? ""),
      status: String(formData.get("status") ?? ""),
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${err instanceof ForbiddenError ? "forbidden" : "failed"}`);
  }
  revalidatePath(base);
  redirect(base);
}
