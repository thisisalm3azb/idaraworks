"use server";
/** H20 — opportunities board/list actions. */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { createOpportunity, moveOpportunityStage } from "@/modules/crm/service";

export async function createOpportunityAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/opportunities`;
  const valueRaw = String(formData.get("estimated_value") ?? "").trim();
  const value = valueRaw === "" ? undefined : Math.round(Number(valueRaw) * 100);
  let id = "";
  try {
    ({ id } = await createOpportunity(resolved.ctx, resolved.archetype, {
      name: String(formData.get("name") ?? ""),
      customerId: String(formData.get("customer_id") ?? "") || undefined,
      estimatedValueMinor:
        value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined,
      expectedCloseDate: String(formData.get("expected_close") ?? "") || undefined,
    }));
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    redirect(`${base}?error=create`);
  }
  revalidatePath(base);
  redirect(`${base}/${id}`);
}

/** Keyboard-accessible stage move (board card select — no drag required). */
export async function moveStageAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/opportunities`;
  const id = String(formData.get("opportunity_id") ?? "");
  const stageKey = String(formData.get("stage_key") ?? "");
  const backQs = String(formData.get("back") ?? "");
  const back = `${base}${backQs && backQs.startsWith("?") ? backQs : ""}`;
  try {
    await moveOpportunityStage(resolved.ctx, resolved.archetype, id, stageKey);
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    redirect(`${back}${backQs ? "&" : "?"}error=move`);
  }
  revalidatePath(base);
  redirect(`${back}${backQs ? "&" : "?"}ok=moved`);
}
