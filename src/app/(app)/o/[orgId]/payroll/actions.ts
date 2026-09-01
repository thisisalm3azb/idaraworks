"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import {
  createPayGroup,
  createPayRun,
  calculatePayRun,
  submitPayRunForApproval,
  finalizePayRun,
  reopenPayRun,
  createReversalRun,
} from "@/modules/payroll/service";

export async function createPayGroupAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/payroll`;
  try {
    await createPayGroup(resolved.ctx, resolved.archetype, {
      nameEn: String(formData.get("name") ?? ""),
      roundingMinor: Number(formData.get("rounding") ?? 1),
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=failed`);
  }
  revalidatePath(base);
  redirect(base);
}

export async function createPayRunAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/payroll`;
  let id = "";
  try {
    const r = await createPayRun(resolved.ctx, resolved.archetype, {
      payGroupId: String(formData.get("pay_group_id") ?? ""),
      periodStart: String(formData.get("period_start") ?? ""),
      periodEnd: String(formData.get("period_end") ?? ""),
      runKind: String(formData.get("run_kind") ?? "regular"),
    });
    id = r.id;
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=failed`);
  }
  revalidatePath(base);
  redirect(`${base}/${id}?ok=created`);
}

/** One action for the run lifecycle buttons — the service refuses any illegal
 *  transition, so a stale button cannot corrupt a run. */
export async function payRunStepAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const runId = String(formData.get("run_id") ?? "");
  const step = String(formData.get("step") ?? "");
  const base = `/o/${orgId}/payroll/${runId}`;
  try {
    if (step === "calculate") {
      await calculatePayRun(resolved.ctx, resolved.archetype, runId);
    } else if (step === "submit") {
      await submitPayRunForApproval(resolved.ctx, resolved.archetype, runId);
    } else if (step === "finalize") {
      await finalizePayRun(resolved.ctx, resolved.archetype, runId);
    } else if (step === "reopen") {
      await reopenPayRun(resolved.ctx, resolved.archetype, runId);
    } else if (step === "reverse") {
      const reason = String(formData.get("reason") ?? "").trim();
      const r = await createReversalRun(resolved.ctx, resolved.archetype, runId, reason);
      revalidatePath(`/o/${orgId}/payroll`);
      redirect(`/o/${orgId}/payroll/${r.id}?ok=created`);
    }
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=failed`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=${step}`);
}
