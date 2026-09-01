"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { submitLeaveRequest, cancelLeaveRequest, submitOvertimeRequest, myEmployee } from "@/modules/hr/service";

/** Self-service: the employee id always resolves from the LOGIN, never a form
 *  field — a crafted request cannot file leave for someone else this way. */
export async function requestLeaveAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/leave`;
  const me = await myEmployee(resolved.ctx);
  if (!me) redirect(`${base}?error=not_employee`);
  try {
    await submitLeaveRequest(resolved.ctx, resolved.archetype, {
      employeeId: me.id,
      leaveTypeId: String(formData.get("leave_type_id") ?? ""),
      startDate: String(formData.get("start_date") ?? ""),
      endDate: String(formData.get("end_date") ?? ""),
      reason: (formData.get("reason") as string) || undefined,
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=failed`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=submitted`);
}

export async function cancelLeaveAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/leave`;
  try {
    await cancelLeaveRequest(
      resolved.ctx,
      resolved.archetype,
      String(formData.get("request_id") ?? ""),
      "cancelled from the leave page",
    );
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=failed`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=cancelled`);
}

export async function requestOvertimeAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/leave`;
  const me = await myEmployee(resolved.ctx);
  if (!me) redirect(`${base}?error=not_employee`);
  try {
    await submitOvertimeRequest(resolved.ctx, resolved.archetype, {
      employeeId: me.id,
      workDate: String(formData.get("work_date") ?? ""),
      minutes: Number(formData.get("minutes") ?? 0),
      reason: String(formData.get("reason") ?? ""),
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=failed`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=submitted`);
}
