import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Badge, Card, CardHeader, Field, SubmitButton } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import {
  INVITE_TTL_DAYS,
  listAssignableRoles,
  listMembers,
  listPendingInvites,
} from "@/platform/auth/identity";
import { emailDeliveryConfigured } from "@/platform/notifications/email";
import { can } from "@/platform/authz";
import { formatDate } from "@/platform/format";
import {
  deactivateMemberAction,
  inviteMemberAction,
  reissueInviteAction,
  revokeInviteAction,
} from "./actions";
import { INVITE_LINK_COOKIE } from "./inviteLinkCookie";

/**
 * Members and invitations.
 *
 * The page says exactly what happened to an invitation: whether an email went
 * out (only when a provider is configured), or that the inviter must pass the
 * link on themselves — shown once, from a short-lived cookie, never from the
 * URL. Pending invitations are listed with their expiry so a mistyped address
 * can be withdrawn and a lost link re-issued.
 */
export default async function MembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; invite?: string }>;
}) {
  const t = await getT();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "members.view")) redirect(`/o/${orgId}`);

  const [members, pending] = await Promise.all([
    listMembers(resolved.ctx, resolved.archetype),
    listPendingInvites(resolved.ctx, resolved.archetype),
  ]);
  const canManage = can(resolved.archetype, "members.invite");
  const roles = canManage ? await listAssignableRoles(resolved.ctx, resolved.archetype) : [];
  const emailConfigured = emailDeliveryConfigured();

  // The one-time link for the invitation just created (cookie, matched by id).
  let freshLink: string | null = null;
  if (sp.ok === "invite_created" && sp.invite) {
    const raw = (await cookies()).get(INVITE_LINK_COOKIE)?.value ?? "";
    const dot = raw.indexOf(".");
    if (dot > 0 && raw.slice(0, dot) === sp.invite) {
      const origin =
        process.env.APP_URL ??
        (process.env.APP_ENV === "prod" ? "https://www.idaraworks.com" : "http://localhost:3000");
      freshLink = `${origin}/invite/${raw.slice(dot + 1)}`;
    }
  }
  const freshEmail = pending.find((p) => p.id === sp.invite)?.email ?? null;

  const inviteWithOrg = inviteMemberAction.bind(null, orgId);
  const deactivateWithOrg = deactivateMemberAction.bind(null, orgId);
  const revokeWithOrg = revokeInviteAction.bind(null, orgId);
  const reissueWithOrg = reissueInviteAction.bind(null, orgId);

  const okCopy: Record<string, string> = {
    invite_sent: t("members.invite.ok_sent", { email: freshEmail ?? "" }),
    invite_created: t("members.invite.ok_created", { email: freshEmail ?? "" }),
    invite_revoked: t("members.invite.ok_revoked"),
    member_deactivated: t("members.ok_deactivated"),
  };
  const errorCopy: Record<string, string> = {
    invite_failed: t("members.invite.error_failed"),
    invite_seats: t("members.invite.error_seats"),
    revoke_failed: t("members.invite.error_revoke"),
    deactivate_failed: t("members.error_deactivate"),
  };

  return (
    <div className="flex flex-col gap-4">
      {sp.ok && okCopy[sp.ok] ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-success/40 bg-success-soft p-3 text-sm text-success"
        >
          <p>{okCopy[sp.ok]}</p>
          {sp.ok === "invite_created" ? (
            <p className="mt-1 text-xs text-ink-secondary">{t("members.invite.link_hint")}</p>
          ) : null}
          {freshLink ? (
            <p className="mt-2 break-all rounded bg-card p-2 font-mono text-xs text-ink">
              {freshLink}
            </p>
          ) : sp.ok === "invite_created" ? (
            <p className="mt-1 text-xs text-ink-secondary">{t("members.invite.link_gone")}</p>
          ) : null}
        </div>
      ) : null}
      {sp.error && errorCopy[sp.error] ? (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-danger-soft p-3 text-sm text-danger"
        >
          {errorCopy[sp.error]}
        </p>
      ) : null}

      <Card>
        <CardHeader title={t("members.title")} meta={`${members.length}`} />
        <ul className="divide-y divide-line">
          {members.map((m) => (
            <li
              key={m.membershipId}
              className="flex min-h-14 items-center justify-between gap-3 py-2"
            >
              <div>
                <p className="text-sm font-medium text-ink">{m.fullName || m.userId.slice(0, 8)}</p>
                <p className="text-xs text-ink-muted">{m.roleKey}</p>
              </div>
              <div className="flex items-center gap-2">
                {m.deactivatedAt ? (
                  <Badge tone="neutral">{t("members.deactivated")}</Badge>
                ) : (
                  <Badge tone="success">{t("members.status.active")}</Badge>
                )}
                {canManage && !m.deactivatedAt && m.roleKey !== "owner" ? (
                  <form action={deactivateWithOrg}>
                    <input type="hidden" name="membership_id" value={m.membershipId} />
                    <SubmitButton
                      variant="ghost"
                      className="text-danger"
                      pendingLabel={t("common.working")}
                    >
                      {t("members.deactivate")}
                    </SubmitButton>
                  </form>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {pending.length > 0 ? (
        <Card>
          <CardHeader title={t("members.pending.title")} meta={`${pending.length}`} />
          <ul className="divide-y divide-line">
            {pending.map((p) => (
              <li
                key={p.id}
                className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium text-ink">{p.email ?? "—"}</p>
                  <p className="text-xs text-ink-muted">
                    {p.roleKey} · {t("members.pending.expires", { date: formatDate(p.expiresAt) })}
                  </p>
                </div>
                {canManage ? (
                  <div className="flex items-center gap-2">
                    {p.email ? (
                      <form action={reissueWithOrg}>
                        <input type="hidden" name="invite_id" value={p.id} />
                        <SubmitButton variant="secondary" pendingLabel={t("common.creating_link")}>
                          {t("members.pending.reissue")}
                        </SubmitButton>
                      </form>
                    ) : null}
                    <form action={revokeWithOrg}>
                      <input type="hidden" name="invite_id" value={p.id} />
                      <SubmitButton
                        variant="ghost"
                        className="text-danger"
                        pendingLabel={t("common.working")}
                      >
                        {t("members.pending.revoke")}
                      </SubmitButton>
                    </form>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {canManage ? (
        <Card>
          <CardHeader title={t("members.invite.title")} />
          <p className="mb-3 text-sm text-ink-secondary">
            {emailConfigured
              ? t("members.invite.how_email", { days: String(INVITE_TTL_DAYS) })
              : t("members.invite.how_link", { days: String(INVITE_TTL_DAYS) })}
          </p>
          <form action={inviteWithOrg} className="flex flex-col gap-4">
            <Field label={t("members.invite.email")} name="email" type="email" required />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="role_key" className="text-sm font-medium text-ink">
                {t("members.invite.role")}
              </label>
              <select
                id="role_key"
                name="role_key"
                required
                defaultValue="manager"
                className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
              >
                {roles.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </div>
            <SubmitButton pendingLabel={t("common.creating_link")}>
              {emailConfigured ? t("members.invite.submit") : t("members.invite.submit_link")}
            </SubmitButton>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
