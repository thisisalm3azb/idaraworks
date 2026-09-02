"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import {
  applyScenario,
  captureForecastSnapshot,
  saveScenario,
  type Overlay,
} from "@/modules/crm/service";

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

/** Store the forecast as it stands today so accuracy can be measured later. */
export async function captureSnapshotAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/forecast`;
  try {
    const r = await captureForecastSnapshot(resolved.ctx, resolved.archetype, {
      periodKey: String(formData.get("period_key") ?? ""),
      note: String(formData.get("note") ?? "").trim() || null,
    });
    revalidatePath(back);
    redirect(`${back}?ok=snapshot&period=${r.periodKey}`);
  } catch (err) {
    fail(back, err);
  }
}

export type SaveScenarioResult = { ok: true; id: string } | { ok: false; code: string };

/** A scenario is an overlay: nothing on the live opportunities changes until it is reviewed and applied. */
export async function saveScenarioAction(
  orgId: string,
  payload: { id?: string; name: string; overlay: Overlay; assumptions?: string | null },
): Promise<SaveScenarioResult> {
  const resolved = await resolveCtxForAction(orgId);
  if (typeof resolved === "string") return { ok: false, code: "forbidden" };
  try {
    const r = await saveScenario(resolved.ctx, resolved.archetype, payload);
    revalidatePath(`/o/${orgId}/revenue/forecast`);
    return { ok: true, id: r.id };
  } catch (err) {
    return { ok: false, code: err instanceof ForbiddenError ? "forbidden" : "failed" };
  }
}

/** Owner/admin only: replay the reviewed scenario through the governed opportunity commands. */
export async function applyScenarioAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/forecast`;
  const id = String(formData.get("id") ?? "");
  try {
    const r = await applyScenario(resolved.ctx, resolved.archetype, {
      id,
      reason: String(formData.get("reason") ?? ""),
    });
    revalidatePath(back);
    revalidatePath(`/o/${orgId}/revenue/pipeline`);
    redirect(`${back}?ok=applied&applied=${r.applied}&skipped=${r.skipped.length}&scenario=${id}`);
  } catch (err) {
    fail(back, err);
  }
}
