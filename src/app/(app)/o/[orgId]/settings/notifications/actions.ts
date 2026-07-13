"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { setMyNotificationPreferences } from "@/platform/notifications";

const KINDS = ["approval_requested", "approval_decided"] as const;
const CHANNELS = ["in_app", "email"] as const;

export async function saveNotifPrefsAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const channels: Record<string, Record<string, boolean>> = {};
  for (const kind of KINDS) {
    channels[kind] = {};
    for (const ch of CHANNELS) {
      channels[kind]![ch] = formData.get(`${kind}.${ch}`) === "on";
    }
  }
  await setMyNotificationPreferences(resolved.ctx, channels);
  revalidatePath(`/o/${orgId}/settings/notifications`);
  redirect(`/o/${orgId}/settings/notifications?ok=1`);
}
