"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { requestOrigin } from "@/platform/auth/callback";
import {
  deactivateMember,
  inviteMember,
  revokeInvite,
  rotateInvite,
  SeatLimitError,
} from "@/platform/auth/identity";
import { rateLimit } from "@/platform/http/rateLimit";
import { clientIpFromHeaders } from "@/platform/http/clientIp";

import { INVITE_LINK_COOKIE } from "./inviteLinkCookie";

/**
 * The invitation link is shown to the inviter ONCE, when no email provider
 * delivers it. It travels in a short-lived HttpOnly cookie rather than the URL:
 * a bearer token in a query string lands in browser history, server logs and
 * Referer headers, and would stay there long after the invitation was used.
 */

async function flashInviteLink(orgId: string, inviteId: string, token: string): Promise<void> {
  const jar = await cookies();
  jar.set(INVITE_LINK_COOKIE, `${inviteId}.${token}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: `/o/${orgId}/settings/members`,
    maxAge: 600,
  });
}

function isRedirect(err: unknown): boolean {
  return Boolean((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT"));
}

export async function inviteMemberAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const h = await headers();
  const rl = await rateLimit("invite_send", `${orgId}:${clientIpFromHeaders(h)}`);
  const base = `/o/${orgId}/settings/members`;
  if (!rl.allowed) redirect(`${base}?error=rate_limited`);
  try {
    const { inviteId, token, delivered } = await inviteMember(resolved.ctx, resolved.archetype, {
      email: String(formData.get("email") ?? "").trim(),
      roleKey: String(formData.get("role_key") ?? ""),
      origin: requestOrigin(h),
    });
    revalidatePath(base);
    if (delivered) redirect(`${base}?ok=invite_sent&invite=${inviteId}`);
    await flashInviteLink(orgId, inviteId, token);
    redirect(`${base}?ok=invite_created&invite=${inviteId}`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(`${base}?error=${err instanceof SeatLimitError ? "invite_seats" : "invite_failed"}`);
  }
}

/** Withdraw a pending invitation: its link stops working at once. */
export async function revokeInviteAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/settings/members`;
  try {
    await revokeInvite(resolved.ctx, resolved.archetype, String(formData.get("invite_id") ?? ""));
    revalidatePath(base);
    redirect(`${base}?ok=invite_revoked`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(`${base}?error=revoke_failed`);
  }
}

/** Issue a fresh link (and email, when configured) for a pending invitation. */
export async function reissueInviteAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const h = await headers();
  const base = `/o/${orgId}/settings/members`;
  const rl = await rateLimit("invite_send", `${orgId}:${clientIpFromHeaders(h)}`);
  if (!rl.allowed) redirect(`${base}?error=rate_limited`);
  try {
    const { inviteId, token, delivered } = await rotateInvite(
      resolved.ctx,
      resolved.archetype,
      String(formData.get("invite_id") ?? ""),
      requestOrigin(h),
    );
    revalidatePath(base);
    if (delivered) redirect(`${base}?ok=invite_sent&invite=${inviteId}`);
    await flashInviteLink(orgId, inviteId, token);
    redirect(`${base}?ok=invite_created&invite=${inviteId}`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(`${base}?error=${err instanceof SeatLimitError ? "invite_seats" : "invite_failed"}`);
  }
}

export async function deactivateMemberAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/settings/members`;
  try {
    await deactivateMember(resolved.ctx, resolved.archetype, String(formData.get("membership_id")));
    revalidatePath(base);
    redirect(`${base}?ok=member_deactivated`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(`${base}?error=deactivate_failed`);
  }
}
