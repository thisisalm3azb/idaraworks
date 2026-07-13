"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { markAttendance, InvalidAttendanceError } from "@/modules/attendance/service";

export async function markAttendanceAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const date = String(formData.get("date") ?? "");
  const base = `/o/${orgId}/attendance?date=${date}`;
  try {
    await markAttendance(resolved.ctx, resolved.archetype, {
      employeeId: String(formData.get("employee_id") ?? ""),
      attendanceDate: date,
      status: String(formData.get("status") ?? ""),
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}&error=${err instanceof InvalidAttendanceError ? "invalid" : "failed"}`);
  }
  revalidatePath(`/o/${orgId}/attendance`);
  redirect(`${base}&ok=1`);
}
