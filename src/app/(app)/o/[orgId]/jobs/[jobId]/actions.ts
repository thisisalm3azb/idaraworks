"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { supabaseServer } from "@/platform/tenancy";
import { createComment } from "@/platform/comments";
import {
  addCrewMember,
  addPriceAdjustment,
  clearProgressOverride,
  completeStage,
  createTask,
  removeCrewMember,
  reopenStage,
  requestStageCompletion,
  setProgressOverride,
  startStage,
  updateJobCore,
  updateJobPricing,
  updateJobStatus,
  updateTaskStatus,
} from "@/modules/jobs/service";
import { confirmUpload, signUpload, type SignedUpload } from "@/platform/files";

async function resolveOr(orgId: string) {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  return resolved;
}

function backTo(orgId: string, jobId: string, tab: string) {
  return `/o/${orgId}/jobs/${jobId}?tab=${tab}`;
}

type Act = (formData: FormData) => Promise<void>;

function jobAction(
  tab: string,
  run: (
    resolved: Awaited<ReturnType<typeof resolveOr>>,
    orgId: string,
    jobId: string,
    formData: FormData,
  ) => Promise<void>,
): (orgId: string, jobId: string, formData: FormData) => Promise<void> {
  return async (orgId, jobId, formData) => {
    const resolved = await resolveOr(orgId);
    const base = backTo(orgId, jobId, tab);
    try {
      await run(resolved, orgId, jobId, formData);
    } catch (err) {
      if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
      redirect(`${base}&error=failed`);
    }
    revalidatePath(`/o/${orgId}/jobs/${jobId}`);
    redirect(base);
  };
}

// ── stages ───────────────────────────────────────────────────────────────────
export const startStageAction: (o: string, j: string, f: FormData) => Promise<void> = jobAction(
  "stages",
  async (r, _o, _j, f) => startStage(r.ctx, r.archetype, String(f.get("stage_id"))),
);
export const requestCompleteAction = jobAction("stages", async (r, _o, _j, f) =>
  requestStageCompletion(r.ctx, r.archetype, String(f.get("stage_id"))),
);
export const completeStageAction = jobAction("stages", async (r, _o, _j, f) =>
  completeStage(r.ctx, r.archetype, String(f.get("stage_id"))),
);
export const reopenStageAction = jobAction("stages", async (r, _o, _j, f) =>
  reopenStage(r.ctx, r.archetype, String(f.get("stage_id")), {
    reason: String(f.get("reason") ?? ""),
  }),
);

// ── tasks ────────────────────────────────────────────────────────────────────
export const createTaskAction = jobAction("tasks", async (r, _o, jobId, f) => {
  await createTask(r.ctx, r.archetype, {
    jobId,
    title: String(f.get("title") ?? ""),
    stageId: (f.get("stage_id") as string) || undefined,
    assigneeEmployeeId: (f.get("assignee_employee_id") as string) || undefined,
    dueDate: (f.get("due_date") as string) || undefined,
  });
});
export const taskStatusAction = jobAction("tasks", async (r, _o, _j, f) =>
  updateTaskStatus(r.ctx, r.archetype, String(f.get("task_id")), {
    status: String(f.get("status")),
  }),
);

// ── crew ─────────────────────────────────────────────────────────────────────
export const addCrewAction = jobAction("overview", async (r, _o, jobId, f) =>
  addCrewMember(r.ctx, r.archetype, jobId, String(f.get("employee_id"))),
);
export const removeCrewAction = jobAction("overview", async (r, _o, jobId, f) =>
  removeCrewMember(r.ctx, r.archetype, jobId, String(f.get("employee_id"))),
);

// ── job core / status / pricing / override ───────────────────────────────────
export const updateJobCoreAction = jobAction("overview", async (r, _o, jobId, f) => {
  const custom: Record<string, unknown> = {};
  for (const [key, value] of f.entries()) {
    if (key.startsWith("cf_")) custom[key.slice(3)] = value === "" ? null : String(value);
  }
  await updateJobCore(r.ctx, r.archetype, jobId, {
    name: String(f.get("name") ?? ""),
    customerId: (f.get("customer_id") as string) || null,
    foremanUserId: (f.get("foreman_user_id") as string) || null,
    managerUserId: (f.get("manager_user_id") as string) || null,
    startDate: (f.get("start_date") as string) || null,
    dueDate: (f.get("due_date") as string) || null,
    customValues: custom,
  });
});
export const jobStatusAction = jobAction("overview", async (r, _o, jobId, f) =>
  updateJobStatus(r.ctx, r.archetype, jobId, String(f.get("status_key"))),
);
export const pricingAction = jobAction("overview", async (r, _o, jobId, f) => {
  const price = String(f.get("selling_price_minor") ?? "").trim();
  await updateJobPricing(r.ctx, r.archetype, jobId, {
    sellingPriceMinor: price ? Number(price) : null,
    paymentTerms: (f.get("payment_terms") as string) || null,
  });
});
export const adjustmentAction = jobAction("overview", async (r, _o, jobId, f) =>
  addPriceAdjustment(r.ctx, r.archetype, jobId, {
    amountMinor: Number(f.get("amount_minor") ?? 0),
    reason: String(f.get("reason") ?? ""),
  }),
);
export const overrideAction = jobAction("overview", async (r, _o, jobId, f) =>
  setProgressOverride(r.ctx, r.archetype, jobId, {
    percent: Number(f.get("percent") ?? 0),
    reason: String(f.get("reason") ?? ""),
  }),
);
export const clearOverrideAction = jobAction("overview", async (r, _o, jobId) =>
  clearProgressOverride(r.ctx, r.archetype, jobId),
);

// ── comments (Phase F engine) ────────────────────────────────────────────────
export const addCommentAction = jobAction("comments", async (r, _o, jobId, f) => {
  await createComment(r.ctx, {
    entityType: "job",
    entityId: jobId,
    body: String(f.get("body") ?? ""),
  });
});

// ── files (Phase E engine — sign/confirm server actions for the upload hook) ─
export async function signJobUploadAction(
  orgId: string,
  jobId: string,
  file: { name: string; mime: string; sizeBytes: number },
): Promise<SignedUpload> {
  const resolved = await resolveOr(orgId);
  const store = await cookies();
  const { data } = await supabaseServer(store).auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect("/login");
  return signUpload(resolved.ctx, resolved.archetype, token, {
    accessClass: "job_media",
    attachedToType: "job",
    attachedToId: jobId,
    originalName: file.name,
    mime: file.mime,
    sizeBytes: file.sizeBytes,
  });
}

export async function confirmJobUploadAction(orgId: string, fileId: string): Promise<void> {
  const resolved = await resolveOr(orgId);
  await confirmUpload(resolved.ctx, fileId);
  revalidatePath(`/o/${orgId}/jobs`);
}
