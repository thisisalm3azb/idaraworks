"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import { createAutomation, runAutomation, updateAutomation } from "@/modules/crm/service";

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
  redirect(`${back}?error=${err instanceof ForbiddenError ? "forbidden" : "failed"}`);
}

/** Conditions and actions come from bounded form rows; the module validates every shape. */
export async function createAutomationAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/automations`;
  const conditions: Array<{ key: string; op: string; value?: string | number | boolean }> = [];
  for (let i = 0; i < 3; i++) {
    const key = str(formData, `c${i}_key`);
    const op = str(formData, `c${i}_op`);
    if (!key || !op) continue;
    const raw = str(formData, `c${i}_value`);
    const value =
      raw === null
        ? undefined
        : raw === "true"
          ? true
          : raw === "false"
            ? false
            : Number.isFinite(Number(raw))
              ? Number(raw)
              : raw;
    conditions.push({ key, op, ...(value === undefined ? {} : { value }) });
  }
  const actions: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 3; i++) {
    const kind = str(formData, `a${i}_kind`);
    if (!kind) continue;
    const title = str(formData, `a${i}_title`) ?? "";
    if (kind === "create_task")
      actions.push({
        kind,
        title,
        dueInDays: Number(str(formData, `a${i}_days`) ?? 1),
        assignToOwner: true,
      });
    else if (kind === "notify") actions.push({ kind, title, toOwner: true });
    else if (kind === "flag_risk")
      actions.push({ kind, title, severity: str(formData, `a${i}_severity`) ?? "medium" });
    else if (kind === "set_forecast_category")
      actions.push({ kind, category: str(formData, `a${i}_category`) ?? "pipeline" });
    else if (kind === "request_approval") actions.push({ kind, note: title || undefined });
    else if (kind === "assign_owner") {
      const userId = str(formData, `a${i}_user`);
      if (userId) actions.push({ kind, userId });
    }
  }
  try {
    await createAutomation(resolved.ctx, resolved.archetype, {
      name: str(formData, "name") ?? "",
      description: str(formData, "description"),
      trigger: str(formData, "trigger") ?? "lead_created",
      conditions: conditions.length ? { all: conditions } : { all: [] },
      actions,
      enabled: false,
      dryRun: true,
    });
    revalidatePath(back);
    redirect(`${back}?ok=created`);
  } catch (err) {
    fail(back, err);
  }
}

export async function toggleAutomationAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/automations`;
  const id = String(formData.get("id") ?? "");
  const intent = String(formData.get("intent") ?? "");
  try {
    await updateAutomation(resolved.ctx, resolved.archetype, {
      id,
      ...(intent === "enable" ? { enabled: true, dryRun: false } : {}),
      ...(intent === "disable" ? { enabled: false } : {}),
      ...(intent === "dry_run" ? { dryRun: true } : {}),
    });
    revalidatePath(back);
    redirect(`${back}?ok=saved&runs=${id}`);
  } catch (err) {
    fail(back, err);
  }
}

/** Dry run (report only) or live run (idempotent per subject and occurrence). */
export async function runAutomationAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/automations`;
  const id = String(formData.get("id") ?? "");
  const mode = String(formData.get("mode") ?? "dry_run") === "live" ? "live" : "dry_run";
  try {
    const r = await runAutomation(resolved.ctx, resolved.archetype, { id, mode });
    revalidatePath(back);
    redirect(
      `${back}?ok=ran&runs=${id}&mode=${r.mode}&matched=${r.matched}&applied=${r.applied}&skipped=${r.skipped}&failed=${r.failed}`,
    );
  } catch (err) {
    fail(back, err);
  }
}
