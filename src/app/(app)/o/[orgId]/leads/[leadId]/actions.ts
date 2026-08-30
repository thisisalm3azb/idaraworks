"use server";
/** H20 — lead detail actions: status, edit, activities, follow-ups and the
 * lead → opportunity conversion (idempotent in the service). */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import {
  addSalesActivity,
  completeFollowUp,
  convertLead,
  setLeadArchived,
  setLeadStatus,
  updateLead,
  USER_ACTIVITY_KINDS,
} from "@/modules/crm/service";

type Resolved = Exclude<Awaited<ReturnType<typeof resolveCtxForAction>>, string>;

async function resolveOr(orgId: string): Promise<Resolved> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  return resolved as Resolved;
}

function backTo(orgId: string, leadId: string): string {
  return `/o/${orgId}/leads/${leadId}`;
}

async function run(
  orgId: string,
  leadId: string,
  ok: string,
  fn: (r: Resolved) => Promise<void>,
): Promise<void> {
  const resolved = await resolveOr(orgId);
  const back = backTo(orgId, leadId);
  try {
    await fn(resolved);
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    redirect(`${back}?error=1`);
  }
  revalidatePath(back);
  redirect(`${back}?ok=${ok}`);
}

export async function updateLeadAction(
  orgId: string,
  leadId: string,
  formData: FormData,
): Promise<void> {
  await run(orgId, leadId, "saved", (r) =>
    updateLead(r.ctx, r.archetype, leadId, {
      name: String(formData.get("name") ?? ""),
      contactName: String(formData.get("contact_name") ?? "") || undefined,
      phone: String(formData.get("phone") ?? "") || undefined,
      email: String(formData.get("email") ?? "") || undefined,
      source: String(formData.get("source") ?? "") || undefined,
      notes: String(formData.get("notes") ?? "") || undefined,
      ownerUserId: String(formData.get("owner_user_id") ?? "") || undefined,
    }),
  );
}

export async function leadStatusAction(
  orgId: string,
  leadId: string,
  formData: FormData,
): Promise<void> {
  const status = String(formData.get("status") ?? "");
  if (!["new", "contacted", "qualified", "disqualified"].includes(status)) {
    redirect(`${backTo(orgId, leadId)}?error=1`);
  }
  await run(orgId, leadId, "saved", (r) =>
    setLeadStatus(r.ctx, r.archetype, leadId, status as "new"),
  );
}

export async function leadArchiveAction(
  orgId: string,
  leadId: string,
  formData: FormData,
): Promise<void> {
  const archived = formData.get("archived") === "1";
  await run(orgId, leadId, archived ? "archived" : "restored", (r) =>
    setLeadArchived(r.ctx, r.archetype, leadId, archived),
  );
}

export async function leadActivityAction(
  orgId: string,
  leadId: string,
  formData: FormData,
): Promise<void> {
  const kind = String(formData.get("kind") ?? "note");
  if (!(USER_ACTIVITY_KINDS as readonly string[]).includes(kind)) {
    redirect(`${backTo(orgId, leadId)}?error=1`);
  }
  await run(orgId, leadId, "activity", (r) =>
    addSalesActivity(
      r.ctx,
      r.archetype,
      { leadId },
      {
        kind,
        body: String(formData.get("body") ?? "") || undefined,
        dueDate: String(formData.get("due_date") ?? "") || undefined,
      },
    ).then(() => undefined),
  );
}

export async function leadFollowUpDoneAction(
  orgId: string,
  leadId: string,
  formData: FormData,
): Promise<void> {
  const activityId = String(formData.get("activity_id") ?? "");
  await run(orgId, leadId, "followup_done", (r) =>
    completeFollowUp(r.ctx, r.archetype, activityId),
  );
}

/** Convert: creates the opportunity (and optionally a customer) atomically,
 * marks the lead converted with evidence, then lands ON the opportunity. */
export async function convertLeadAction(
  orgId: string,
  leadId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await resolveOr(orgId);
  const back = backTo(orgId, leadId);
  const valueRaw = String(formData.get("estimated_value") ?? "").trim();
  const value = valueRaw === "" ? undefined : Math.round(Number(valueRaw) * 100);
  let opportunityId = "";
  try {
    ({ opportunityId } = await convertLead(resolved.ctx, resolved.archetype, leadId, {
      opportunityName: String(formData.get("opportunity_name") ?? "") || undefined,
      customerId: String(formData.get("customer_id") ?? "") || undefined,
      createCustomer: formData.get("create_customer") === "1",
      estimatedValueMinor:
        value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined,
      expectedCloseDate: String(formData.get("expected_close") ?? "") || undefined,
    }));
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    redirect(`${back}?error=convert`);
  }
  revalidatePath(back);
  redirect(`/o/${orgId}/opportunities/${opportunityId}`);
}
