"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import {
  createWeekPlan,
  updateWeekPlan,
  setWeekPlanJobs,
  issueWeekPlan,
  reviseWeekPlan,
  cancelWeekPlan,
  WeekPlanImmutableError,
  WeekPlanReasonRequiredError,
} from "@/modules/documents/service";

/** Map a thrown error to a short code the page turns into a specific message. */
function code(err: unknown): string {
  if (err instanceof ForbiddenError) return "forbidden";
  if (err instanceof WeekPlanImmutableError) return "immutable";
  if (err instanceof WeekPlanReasonRequiredError) return "reason";
  return "failed";
}

export async function createWeekPlanAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const list = `/o/${orgId}/week/plans`;
  const weekStart = String(formData.get("week_start") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) redirect(`${list}?error=invalid`);
  let id: string;
  try {
    const created = await createWeekPlan(resolved.ctx, resolved.archetype, {
      weekStart,
      title: String(formData.get("title") ?? "").trim() || null,
      managerUserId: String(formData.get("manager_user_id") ?? "") || null,
    });
    id = created.id;
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    // A second live plan for the same week is refused by a unique index, which
    // is the intended answer rather than a failure to explain away.
    redirect(`${list}?error=${code(err) === "failed" ? "duplicate_week" : code(err)}`);
  }
  revalidatePath(list);
  redirect(`${list}/${id}`);
}

/** Shared shape for the actions that operate on one existing plan. */
async function planAction(
  orgId: string,
  formData: FormData,
  run: (ctx: never, arch: never, id: string) => Promise<unknown>,
  ok: string,
): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("plan_id") ?? "");
  const base = `/o/${orgId}/week/plans/${id}`;
  try {
    await run(resolved.ctx as never, resolved.archetype as never, id);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${code(err)}`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=${ok}`);
}

export async function updateWeekPlanAction(orgId: string, formData: FormData): Promise<void> {
  const title = String(formData.get("title") ?? "").trim() || null;
  const managerUserId = String(formData.get("manager_user_id") ?? "") || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  await planAction(
    orgId,
    formData,
    (c, a, id) => updateWeekPlan(c, a, id, { title, managerUserId, notes }),
    "saved",
  );
}

export async function setWeekPlanJobsAction(orgId: string, formData: FormData): Promise<void> {
  const jobIds = formData.getAll("job_id").map(String).filter(Boolean);
  await planAction(orgId, formData, (c, a, id) => setWeekPlanJobs(c, a, id, jobIds), "saved");
}

export async function issueWeekPlanAction(orgId: string, formData: FormData): Promise<void> {
  await planAction(orgId, formData, (c, a, id) => issueWeekPlan(c, a, id), "issued");
}

export async function cancelWeekPlanAction(orgId: string, formData: FormData): Promise<void> {
  const reason = String(formData.get("reason") ?? "");
  await planAction(orgId, formData, (c, a, id) => cancelWeekPlan(c, a, id, reason), "cancelled");
}

/**
 * Revising creates a NEW draft and leaves the issued plan untouched, so this
 * lands the user on the new draft rather than back on the document they just
 * superseded.
 */
export async function reviseWeekPlanAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("plan_id") ?? "");
  const base = `/o/${orgId}/week/plans/${id}`;
  let next: string;
  try {
    const created = await reviseWeekPlan(
      resolved.ctx,
      resolved.archetype,
      id,
      String(formData.get("reason") ?? ""),
    );
    next = created.id;
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${code(err)}`);
  }
  revalidatePath(base);
  revalidatePath(`/o/${orgId}/week/plans`);
  redirect(`/o/${orgId}/week/plans/${next}?ok=revised`);
}
