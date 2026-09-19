"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ConfigGuardError } from "@/platform/config";
import {
  addStage,
  createPreset,
  moveStage,
  PresetError,
  removeStage,
  restorePreset,
  retirePreset,
  updatePreset,
  updateStage,
} from "@/modules/jobs/service";

function isRedirect(err: unknown): boolean {
  return Boolean((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT"));
}
function codeOf(err: unknown): string {
  if (err instanceof ConfigGuardError) return "stage_referenced";
  if (err instanceof PresetError) return err.code;
  if ((err as { name?: string }).name === "ZodError") return "invalid";
  return "failed";
}
async function resolveOr(orgId: string) {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  return resolved;
}
const base = (orgId: string) => `/o/${orgId}/settings/work-templates`;

function stageInput(formData: FormData) {
  return {
    stageKey: String(formData.get("stage_key") ?? "") || undefined,
    nameEn: String(formData.get("name_en") ?? ""),
    nameAr: String(formData.get("name_ar") ?? ""),
    weight: Number(formData.get("weight") ?? 0),
    phase: String(formData.get("phase") ?? ""),
  };
}

export async function addStageAction(orgId: string, formData: FormData): Promise<void> {
  const r = await resolveOr(orgId);
  try {
    await addStage(r.ctx, r.archetype, stageInput(formData));
    revalidatePath(base(orgId));
    redirect(`${base(orgId)}?ok=stage_added#stages`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(`${base(orgId)}?error=${codeOf(err)}#stages`);
  }
}

export async function updateStageAction(orgId: string, formData: FormData): Promise<void> {
  const r = await resolveOr(orgId);
  try {
    await updateStage(r.ctx, r.archetype, stageInput(formData));
    revalidatePath(base(orgId));
    redirect(`${base(orgId)}?ok=stage_saved#stages`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(`${base(orgId)}?error=${codeOf(err)}#stages`);
  }
}

export async function moveStageAction(orgId: string, formData: FormData): Promise<void> {
  const r = await resolveOr(orgId);
  const dir = String(formData.get("direction") ?? "") === "up" ? "up" : "down";
  try {
    await moveStage(r.ctx, r.archetype, String(formData.get("stage_key") ?? ""), dir);
    revalidatePath(base(orgId));
    redirect(`${base(orgId)}?ok=stage_moved#stages`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(`${base(orgId)}?error=${codeOf(err)}#stages`);
  }
}

export async function removeStageAction(orgId: string, formData: FormData): Promise<void> {
  const r = await resolveOr(orgId);
  try {
    await removeStage(r.ctx, r.archetype, String(formData.get("stage_key") ?? ""));
    revalidatePath(base(orgId));
    redirect(`${base(orgId)}?ok=stage_removed#stages`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(`${base(orgId)}?error=${codeOf(err)}#stages`);
  }
}

function presetInput(formData: FormData) {
  return {
    code: String(formData.get("code") ?? ""),
    id: String(formData.get("preset_id") ?? ""),
    nameEn: String(formData.get("name_en") ?? ""),
    nameAr: String(formData.get("name_ar") ?? ""),
    description: String(formData.get("description") ?? "").trim() || undefined,
    skippedStageKeys: formData.getAll("skip").map(String),
  };
}

export async function createPresetAction(orgId: string, formData: FormData): Promise<void> {
  const r = await resolveOr(orgId);
  try {
    const input = presetInput(formData);
    await createPreset(r.ctx, r.archetype, {
      code: input.code,
      nameEn: input.nameEn,
      nameAr: input.nameAr,
      description: input.description,
      skippedStageKeys: input.skippedStageKeys,
    });
    revalidatePath(base(orgId));
    redirect(`${base(orgId)}?ok=preset_created#templates`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(`${base(orgId)}?error=${codeOf(err)}#templates`);
  }
}

export async function updatePresetAction(orgId: string, formData: FormData): Promise<void> {
  const r = await resolveOr(orgId);
  try {
    const input = presetInput(formData);
    await updatePreset(r.ctx, r.archetype, {
      id: input.id,
      nameEn: input.nameEn,
      nameAr: input.nameAr,
      description: input.description,
      skippedStageKeys: input.skippedStageKeys,
    });
    revalidatePath(base(orgId));
    redirect(`${base(orgId)}?ok=preset_saved#templates`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(`${base(orgId)}?error=${codeOf(err)}#templates`);
  }
}

export async function retirePresetAction(orgId: string, formData: FormData): Promise<void> {
  const r = await resolveOr(orgId);
  const id = String(formData.get("preset_id") ?? "");
  const restore = String(formData.get("restore") ?? "") === "1";
  try {
    if (restore) await restorePreset(r.ctx, r.archetype, id);
    else await retirePreset(r.ctx, r.archetype, id);
    revalidatePath(base(orgId));
    redirect(`${base(orgId)}?ok=${restore ? "preset_restored" : "preset_retired"}#templates`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(`${base(orgId)}?error=${codeOf(err)}#templates`);
  }
}
