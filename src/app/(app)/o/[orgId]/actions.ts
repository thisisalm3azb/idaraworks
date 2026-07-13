"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import { dismissException, ExceptionScopeError } from "@/modules/exceptions/service";

export async function dismissExceptionAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  try {
    await dismissException(resolved.ctx, resolved.archetype, {
      exceptionId: String(formData.get("exception_id") ?? ""),
      note: String(formData.get("note") ?? "") || undefined,
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const code =
      err instanceof ForbiddenError
        ? "forbidden"
        : err instanceof ExceptionScopeError
          ? "scope"
          : "failed";
    redirect(`/o/${orgId}?error=${code}`);
  }
  revalidatePath(`/o/${orgId}`);
  redirect(`/o/${orgId}?ok=dismissed`);
}
