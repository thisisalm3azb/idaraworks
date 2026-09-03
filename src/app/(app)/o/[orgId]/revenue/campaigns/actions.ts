"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import {
  ConsentError,
  createCampaign,
  recordTouch,
  sendMarketingMessage,
  updateCampaign,
} from "@/modules/crm/service";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};
const minor = (fd: FormData, k: string) => {
  const v = str(fd, k);
  if (v === null) return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
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
    err instanceof ForbiddenError ? "forbidden" : err instanceof ConsentError ? err.code : "failed";
  redirect(`${back}?error=${code}`);
}

export async function createCampaignAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/campaigns`;
  const budget = minor(formData, "budget_major");
  try {
    await createCampaign(resolved.ctx, resolved.archetype, {
      name: str(formData, "name") ?? "",
      objective: str(formData, "objective"),
      channel: str(formData, "channel") ?? "other",
      status: str(formData, "status") ?? "planned",
      audience: { note: str(formData, "audience") ?? undefined },
      budgetMinor: budget,
      currency:
        budget === null
          ? null
          : (str(formData, "currency")?.toUpperCase() ?? resolved.baseCurrency),
      startsOn: str(formData, "starts_on"),
      endsOn: str(formData, "ends_on"),
      ownerUserId: str(formData, "owner_user_id"),
    });
    revalidatePath(back);
    redirect(`${back}?ok=created`);
  } catch (err) {
    fail(back, err);
  }
}

export async function updateCampaignAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/campaigns`;
  const cost = minor(formData, "cost_major");
  try {
    await updateCampaign(resolved.ctx, resolved.archetype, {
      id: String(formData.get("id") ?? ""),
      status: str(formData, "status") ?? undefined,
      costMinor: cost === null ? undefined : cost,
    });
    revalidatePath(back);
    redirect(`${back}?ok=saved`);
  } catch (err) {
    fail(back, err);
  }
}

/** A touch is a recorded exposure or response; attribution models split value across touches later. */
export async function recordTouchAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/campaigns`;
  try {
    await recordTouch(resolved.ctx, resolved.archetype, {
      campaignId: String(formData.get("campaign_id") ?? ""),
      leadId: str(formData, "lead_id"),
      customerId: str(formData, "customer_id"),
      opportunityId: str(formData, "opportunity_id"),
      kind: str(formData, "kind") ?? "manual",
      note: str(formData, "note"),
    });
    revalidatePath(back);
    redirect(`${back}?ok=touch`);
  } catch (err) {
    fail(back, err);
  }
}

/**
 * The explicit send. Consent and suppression are checked per recipient at
 * send time; without a configured provider the send fails closed and the
 * owner action is shown. Never runs from an automation.
 */
export async function sendMarketingAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/campaigns`;
  const recipients = formData
    .getAll("c")
    .map((v) => String(v))
    .filter(Boolean)
    .map((customerId) => ({ customerId }));
  try {
    const r = await sendMarketingMessage(resolved.ctx, resolved.archetype, {
      campaignId: String(formData.get("campaign_id") ?? ""),
      channel: String(formData.get("channel") ?? "email"),
      subject: String(formData.get("subject") ?? ""),
      body: String(formData.get("body") ?? ""),
      recipients,
      confirmed: true, // the person pressed the explicit send
    });
    revalidatePath(back);
    redirect(`${back}?ok=sent&sent=${r.sent}&skipped=${r.skipped.length}`);
  } catch (err) {
    fail(back, err);
  }
}
