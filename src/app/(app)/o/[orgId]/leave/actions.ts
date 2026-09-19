"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import {
  submitLeaveRequest,
  cancelLeaveRequest,
  submitOvertimeRequest,
  myEmployee,
  createLeaveType,
  leaveTypeKeyFrom,
} from "@/modules/hr/service";

/**
 * Define a leave type for this company (D2). Permission-controlled by the
 * same `employees.manage` the service asserts; nothing is created for a
 * company that does not do this itself, and entitlements stay a separate,
 * explicit policy — this form only names the kind of leave.
 */
export async function createLeaveTypeAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/leave`;
  if (!can(resolved.archetype, "employees.manage")) redirect(base);
  const labelEn = String(formData.get("label_en") ?? "").trim();
  const labelAr = String(formData.get("label_ar") ?? "").trim();
  if (!labelEn || !labelAr) redirect(`${base}?error=type_invalid#leave-types`);
  try {
    await createLeaveType(resolved.ctx, resolved.archetype, {
      key: leaveTypeKeyFrom(labelEn),
      labelEn,
      labelAr,
      paid: formData.get("paid") === "on",
      requiresAttachment: formData.get("requires_attachment") === "on",
      countBasis:
        formData.get("count_basis") === "calendar_days" ? "calendar_days" : "working_days",
      allowHalfDay: formData.get("allow_half_day") === "on",
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const hrCode = (err as { code?: string }).code;
    const code =
      hrCode === "duplicate" || /leave_type_key_uq|duplicate|already exists|23505/i.test(message)
        ? "type_exists"
        : /ZodError|invalid|regex|too_small|too_big/i.test(`${(err as Error).name} ${message}`)
          ? "type_invalid"
          : "failed";
    redirect(`${base}?error=${code}#leave-types`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=type_created#leave-types`);
}

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
