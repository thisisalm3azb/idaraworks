"use server";
/** H20 — opportunity detail actions: edit, stage move, win/lose (explicit,
 * validated, idempotent in the service), activities and follow-ups. */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import {
  addSalesActivity,
  completeFollowUp,
  loseOpportunity,
  moveOpportunityStage,
  updateOpportunity,
  winOpportunity,
  USER_ACTIVITY_KINDS,
} from "@/modules/crm/service";

type Resolved = Exclude<Awaited<ReturnType<typeof resolveCtxForAction>>, string>;

async function resolveOr(orgId: string): Promise<Resolved> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  return resolved as Resolved;
}

function backTo(orgId: string, id: string): string {
  return `/o/${orgId}/opportunities/${id}`;
}

async function run(
  orgId: string,
  id: string,
  ok: string,
  fn: (r: Resolved) => Promise<unknown>,
): Promise<void> {
  const resolved = await resolveOr(orgId);
  const back = backTo(orgId, id);
  try {
    await fn(resolved);
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    redirect(`${back}?error=1`);
  }
  revalidatePath(back);
  redirect(`${back}?ok=${ok}`);
}

export async function updateOpportunityAction(
  orgId: string,
  id: string,
  formData: FormData,
): Promise<void> {
  const valueRaw = String(formData.get("estimated_value") ?? "").trim();
  const value = valueRaw === "" ? undefined : Math.round(Number(valueRaw) * 100);
  const probRaw = String(formData.get("probability") ?? "").trim();
  const prob = probRaw === "" ? undefined : Number.parseInt(probRaw, 10);
  await run(orgId, id, "saved", (r) =>
    updateOpportunity(r.ctx, r.archetype, id, {
      name: String(formData.get("name") ?? ""),
      customerId: String(formData.get("customer_id") ?? "") || undefined,
      ownerUserId: String(formData.get("owner_user_id") ?? "") || undefined,
      estimatedValueMinor:
        value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined,
      expectedCloseDate: String(formData.get("expected_close") ?? "") || undefined,
      probability:
        prob !== undefined && Number.isInteger(prob) && prob >= 0 && prob <= 100 ? prob : undefined,
      nextAction: String(formData.get("next_action") ?? "") || undefined,
      nextActionDue: String(formData.get("next_action_due") ?? "") || undefined,
    }),
  );
}

export async function moveStageDetailAction(
  orgId: string,
  id: string,
  formData: FormData,
): Promise<void> {
  await run(orgId, id, "moved", (r) =>
    moveOpportunityStage(r.ctx, r.archetype, id, String(formData.get("stage_key") ?? "")),
  );
}

export async function winOpportunityAction(orgId: string, id: string): Promise<void> {
  await run(orgId, id, "won", (r) => winOpportunity(r.ctx, r.archetype, id));
}

export async function loseOpportunityAction(
  orgId: string,
  id: string,
  formData: FormData,
): Promise<void> {
  await run(orgId, id, "lost", (r) =>
    loseOpportunity(r.ctx, r.archetype, id, {
      reason: String(formData.get("reason") ?? ""),
      note: String(formData.get("note") ?? "") || undefined,
    }),
  );
}

export async function oppActivityAction(
  orgId: string,
  id: string,
  formData: FormData,
): Promise<void> {
  const kind = String(formData.get("kind") ?? "note");
  if (!(USER_ACTIVITY_KINDS as readonly string[]).includes(kind)) {
    redirect(`${backTo(orgId, id)}?error=1`);
  }
  await run(orgId, id, "activity", (r) =>
    addSalesActivity(
      r.ctx,
      r.archetype,
      { opportunityId: id },
      {
        kind,
        body: String(formData.get("body") ?? "") || undefined,
        dueDate: String(formData.get("due_date") ?? "") || undefined,
      },
    ),
  );
}

export async function oppFollowUpDoneAction(
  orgId: string,
  id: string,
  formData: FormData,
): Promise<void> {
  await run(orgId, id, "followup_done", (r) =>
    completeFollowUp(r.ctx, r.archetype, String(formData.get("activity_id") ?? "")),
  );
}
