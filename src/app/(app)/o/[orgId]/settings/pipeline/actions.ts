"use server";
/** H20 — pipeline configuration actions (pipeline.configure holders). */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import {
  deactivatePipelineStage,
  StageNotEmptyError,
  updatePipelineStage,
} from "@/modules/crm/service";

function back(orgId: string): string {
  return `/o/${orgId}/settings/pipeline`;
}

export async function updateStageAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const key = String(formData.get("key") ?? "");
  const sortRaw = String(formData.get("sort") ?? "").trim();
  const sort = Number.parseInt(sortRaw, 10);
  try {
    await updatePipelineStage(resolved.ctx, resolved.archetype, key, {
      labelEn: String(formData.get("label_en") ?? "") || undefined,
      labelAr: String(formData.get("label_ar") ?? "") || undefined,
      sort: Number.isInteger(sort) && sort >= 0 && sort <= 99 ? sort : undefined,
    });
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    redirect(`${back(orgId)}?error=save`);
  }
  revalidatePath(back(orgId));
  redirect(`${back(orgId)}?ok=saved`);
}

export async function deactivateStageAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const key = String(formData.get("key") ?? "");
  const reassignTo = String(formData.get("reassign_to") ?? "");
  try {
    await deactivatePipelineStage(resolved.ctx, resolved.archetype, key, {
      reassignTo: reassignTo || undefined,
    });
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    if (err instanceof StageNotEmptyError) {
      redirect(`${back(orgId)}?error=not_empty&stage=${encodeURIComponent(key)}`);
    }
    redirect(`${back(orgId)}?error=deactivate`);
  }
  revalidatePath(back(orgId));
  redirect(`${back(orgId)}?ok=deactivated`);
}
