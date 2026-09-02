"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import {
  createPipeline,
  PipelineError,
  STAGE_REQUIREMENTS,
  updatePipeline,
  updateStageSettings,
} from "@/modules/crm/service";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};
async function ctxOrRedirect(orgId: string) {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  return resolved;
}
function fail(back: string, err: unknown): never {
  if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
  const code =
    err instanceof ForbiddenError
      ? "forbidden"
      : err instanceof PipelineError
        ? err.code
        : "failed";
  redirect(`${back}${back.includes("?") ? "&" : "?"}error=${code}`);
}

/** Stages come one per line as `key | English label | Arabic label`. */
export async function createPipelineAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/settings`;
  const stages = (str(formData, "stages") ?? "")
    .split(/\r?\n/)
    .map((line) => line.split("|").map((p) => p.trim()))
    .filter((p) => p[0])
    .map((p) => ({ key: p[0]!, label: { en: p[1] || p[0], ar: p[2] || p[1] || p[0] } }));
  try {
    const r = await createPipeline(resolved.ctx, resolved.archetype, {
      key: str(formData, "key") ?? "",
      name: {
        en: str(formData, "name_en") ?? undefined,
        ar: str(formData, "name_ar") ?? undefined,
      },
      kind: str(formData, "kind") ?? "custom",
      stages,
    });
    revalidatePath(back);
    redirect(`${back}?ok=created&pipeline=${r.id}`);
  } catch (err) {
    fail(back, err);
  }
}

export async function updatePipelineAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/settings`;
  const id = String(formData.get("id") ?? "");
  const intent = String(formData.get("intent") ?? "");
  try {
    await updatePipeline(resolved.ctx, resolved.archetype, {
      id,
      ...(intent === "default" ? { isDefault: true } : {}),
      ...(intent === "activate" ? { active: true } : {}),
      ...(intent === "deactivate" ? { active: false } : {}),
    });
    revalidatePath(back);
    redirect(`${back}?ok=saved&pipeline=${id}`);
  } catch (err) {
    fail(back, err);
  }
}

export async function updateStageSettingsAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const pipeline = str(formData, "pipeline_id");
  const back = `/o/${orgId}/revenue/settings${pipeline ? `?pipeline=${pipeline}` : ""}`;
  const prob = str(formData, "default_probability");
  const age = str(formData, "max_age_days");
  try {
    await updateStageSettings(resolved.ctx, resolved.archetype, {
      stageKey: String(formData.get("stage_key") ?? ""),
      requirements: STAGE_REQUIREMENTS.filter((r) => formData.get(`req_${r}`) === "on"),
      exitCriteria: {
        en: str(formData, "exit_en") ?? undefined,
        ar: str(formData, "exit_ar") ?? undefined,
      },
      defaultProbability: prob === null ? null : Number(prob),
      maxAgeDays: age === null ? null : Number(age),
    });
    revalidatePath(back);
    redirect(`${back}${back.includes("?") ? "&" : "?"}ok=stage`);
  } catch (err) {
    fail(back, err);
  }
}
