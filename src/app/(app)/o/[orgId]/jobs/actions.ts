"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { createJobFromPreset, JobLimitError } from "@/modules/jobs/service";
import { DuplicateReportError, submitDailyReport } from "@/modules/reports/service";

export async function createJobAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/jobs`;
  let jobId = "";
  try {
    const { id } = await createJobFromPreset(resolved.ctx, resolved.archetype, {
      presetId: String(formData.get("preset_id") ?? ""),
      name: String(formData.get("name") ?? ""),
      customerId: (formData.get("customer_id") as string) || undefined,
      foremanUserId: (formData.get("foreman_user_id") as string) || undefined,
    });
    jobId = id;
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${err instanceof JobLimitError ? "limit" : "create_failed"}`);
  }
  revalidatePath(base);
  redirect(`${base}/${jobId}`);
}

export async function submitReportAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const jobId = String(formData.get("job_id") ?? "");
  const reportDate = String(formData.get("report_date") ?? "");
  const base = `/o/${orgId}/jobs/${jobId}`;
  try {
    await submitDailyReport(resolved.ctx, resolved.archetype, {
      jobId,
      reportDate,
      summary: String(formData.get("summary") ?? ""),
      blockers: (formData.get("blockers") as string) || undefined,
      nextSteps: (formData.get("next_steps") as string) || undefined,
      // DETERMINISTIC key per (job, date) — same as the composer (review finding
      // C): a resubmit for the same day resolves the existing report in place
      // rather than colliding on the (job, date) unique.
      idempotencyKey: `dr:${jobId}:${reportDate}`,
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(
      `${base}?error=${err instanceof DuplicateReportError ? "duplicate" : "report_failed"}`,
    );
  }
  revalidatePath(base);
  redirect(`${base}?notice=submitted`);
}
