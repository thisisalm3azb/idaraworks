"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { supabaseServer } from "@/platform/tenancy";

import {
  addCrewMember,
  addJobComment,
  signJobPhotoUpload,
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
  changeWorkStatus,
  reopenJob,
  setJobArchived,
  updateTaskStatus,
  setTaskArchived,
  addDependency,
  removeDependency,
} from "@/modules/jobs/service";
import { confirmUpload, type SignedUpload } from "@/platform/files";

async function resolveOr(orgId: string) {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  return resolved;
}

function backTo(orgId: string, jobId: string, tab: string) {
  return `/o/${orgId}/jobs/${jobId}?tab=${tab}`;
}

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
    description: (f.get("description") as string) || undefined,
    stageId: (f.get("stage_id") as string) || undefined,
    assigneeEmployeeId: (f.get("assignee_employee_id") as string) || undefined,
    priority: (f.get("priority") as "low" | "normal" | "high" | "urgent") || "normal",
    startDate: (f.get("start_date") as string) || undefined,
    dueDate: (f.get("due_date") as string) || undefined,
    estimatedMinutes: f.get("estimated_minutes") ? Number(f.get("estimated_minutes")) : undefined,
    parentTaskId: (f.get("parent_task_id") as string) || undefined,
    requiresApproval: f.get("requires_approval") === "1",
  });
});
export const taskStatusAction = jobAction("tasks", async (r, _o, _j, f) => {
  // H21: the command decides the landing state (a task that requires approval
  // moves to awaiting_approval, not completed); the tab reload shows it.
  await updateTaskStatus(r.ctx, r.archetype, String(f.get("task_id")), {
    status: String(f.get("status")),
    reason: (f.get("reason") as string) || undefined,
    actualMinutes: f.get("actual_minutes") ? Number(f.get("actual_minutes")) : undefined,
  });
});
export const taskDependencyAddAction = jobAction("tasks", async (r, _o, _j, f) => {
  await addDependency(r.ctx, r.archetype, {
    taskId: String(f.get("task_id")),
    dependsOnTaskId: String(f.get("depends_on_task_id")),
    kind: "finish_to_start",
  });
});
export const taskDependencyRemoveAction = jobAction("tasks", async (r, _o, _j, f) => {
  await removeDependency(r.ctx, r.archetype, String(f.get("dependency_id")));
});
export const taskArchiveAction = jobAction("tasks", async (r, _o, _j, f) => {
  await setTaskArchived(r.ctx, r.archetype, String(f.get("task_id")), f.get("archived") === "1");
});

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
    // Only touch an assignment leg when the form posted its field — a form
    // that omits manager must NOT wipe manager_user_id (review fix, F-6).
    ...(f.has("foreman_user_id")
      ? { foremanUserId: (f.get("foreman_user_id") as string) || null }
      : {}),
    ...(f.has("manager_user_id")
      ? { managerUserId: (f.get("manager_user_id") as string) || null }
      : {}),
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

// ── comments (job-scoped: authz + F-6 assigned scope live in the service) ────
export const addCommentAction = jobAction("comments", async (r, _o, jobId, f) => {
  await addJobComment(r.ctx, r.archetype, jobId, String(f.get("body") ?? ""));
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
  // The service validates the job is in-org and (foreman) assigned before
  // minting a signed PUT (review fix — F-6 write scope).
  return signJobPhotoUpload(resolved.ctx, resolved.archetype, token, jobId, file);
}

export async function confirmJobUploadAction(orgId: string, fileId: string): Promise<void> {
  const resolved = await resolveOr(orgId);
  await confirmUpload(resolved.ctx, fileId);
  revalidatePath(`/o/${orgId}/jobs`);
}

// ── H21 work lifecycle ───────────────────────────────────────────────────────
/** Status changes now carry a reason where the structure demands one. */
export const workStatusAction = jobAction("overview", async (r, _o, jobId, f) => {
  await changeWorkStatus(r.ctx, r.archetype, jobId, {
    statusKey: String(f.get("status_key")),
    reason: (f.get("reason") as string) || undefined,
  });
});
export const reopenWorkAction = jobAction("overview", async (r, _o, jobId, f) => {
  await reopenJob(r.ctx, r.archetype, jobId, {
    statusKey: String(f.get("status_key")),
    reason: String(f.get("reason") ?? ""),
  });
});
export const archiveWorkAction = jobAction("overview", async (r, _o, jobId, f) => {
  await setJobArchived(r.ctx, r.archetype, jobId, f.get("archived") === "1");
});
