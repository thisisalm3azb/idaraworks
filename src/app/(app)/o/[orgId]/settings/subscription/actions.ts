"use server";

import { redirect } from "next/navigation";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { changePlan, cancelSubscription } from "@/modules/subscription/service";

const BASE = (orgId: string) => `/o/${orgId}/settings/subscription`;

export async function changePlanAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const plan = String(formData.get("plan") ?? "");
  const valid = plan === "starter" || plan === "growth" || plan === "business";
  let mode: string | null = null;
  try {
    if (valid) {
      const r = await changePlan(resolved.ctx, resolved.archetype, plan as never);
      mode = r.mode;
    }
  } catch {
    mode = null;
  }
  redirect(
    `${BASE(orgId)}?notice=${mode ? (mode === "scheduled" ? "downgrade" : "upgrade") : "error"}`,
  );
}

export async function cancelSubscriptionAction(orgId: string): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  let ok = false;
  try {
    await cancelSubscription(resolved.ctx, resolved.archetype);
    ok = true;
  } catch {
    ok = false;
  }
  redirect(`${BASE(orgId)}?notice=${ok ? "cancel_requested" : "error"}`);
}
