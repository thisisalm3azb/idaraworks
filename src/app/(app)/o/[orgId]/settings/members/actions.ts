"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtx } from "@/platform/auth/resolve";
import { deactivateMember, inviteMember } from "@/platform/auth/identity";
import { rateLimit } from "@/platform/http/rateLimit";

export async function inviteMemberAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const h = await headers();
  const rl = await rateLimit(
    "invite_send",
    `${orgId}:${h.get("x-forwarded-for")?.split(",")[0] ?? resolved.ctx.userId}`,
  );
  const base = `/o/${orgId}/settings/members`;
  if (!rl.allowed) redirect(`${base}?error=rate_limited`);
  try {
    const { token, delivered } = await inviteMember(resolved.ctx, resolved.archetype, {
      email: String(formData.get("email") ?? ""),
      roleKey: String(formData.get("role_key") ?? ""),
    });
    revalidatePath(base);
    // When no email provider is configured (dev/pilot bootstrap), surface the
    // invite link once to the inviter so the flow stays usable.
    redirect(delivered ? `${base}?notice=sent` : `${base}?notice=sent&link=${token}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=invite_failed`);
  }
}

export async function deactivateMemberAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/settings/members`;
  try {
    await deactivateMember(resolved.ctx, resolved.archetype, String(formData.get("membership_id")));
    revalidatePath(base);
    redirect(base);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=deactivate_failed`);
  }
}
