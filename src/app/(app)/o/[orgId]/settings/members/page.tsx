import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, Field } from "@/platform/ui";
import { t } from "@/platform/i18n/t";
import { resolveCtx } from "@/platform/auth/resolve";
import { listAssignableRoles, listMembers } from "@/platform/auth/identity";
import { can } from "@/platform/authz";
import { deactivateMemberAction, inviteMemberAction } from "./actions";

export default async function MembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ notice?: string; error?: string; link?: string }>;
}) {
  const { orgId } = await params;
  const { notice, error, link } = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "members.view")) redirect(`/o/${orgId}`);

  const members = await listMembers(resolved.ctx, resolved.archetype);
  const canManage = can(resolved.archetype, "members.invite");

  const roles = canManage ? await listAssignableRoles(resolved.ctx, resolved.archetype) : [];

  const inviteWithOrg = inviteMemberAction.bind(null, orgId);
  const deactivateWithOrg = deactivateMemberAction.bind(null, orgId);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("members.title")} meta={`${members.length}`} />
        {notice === "sent" ? (
          <div className="mb-3 rounded-md bg-success-soft p-3 text-sm text-success">
            {t("members.invite.sent")}
            {link ? (
              <p className="mt-1 break-all font-mono text-xs text-ink-secondary">
                {`${process.env.APP_URL ?? "http://localhost:3000"}/invite/${link}`}
              </p>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
            {t("common.error")}
          </p>
        ) : null}
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
                    <Button type="submit" variant="ghost" className="text-danger">
                      {t("members.deactivate")}
                    </Button>
                  </form>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {canManage ? (
        <Card>
          <CardHeader title={t("members.invite.title")} />
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
            <Button type="submit">{t("members.invite.submit")}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
