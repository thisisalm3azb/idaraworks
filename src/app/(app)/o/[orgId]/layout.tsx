import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell, Badge } from "@/platform/ui";
import { t } from "@/platform/i18n/t";
import { getSessionUser, listMyOrgs, resolveCtx } from "@/platform/auth/resolve";

/**
 * The org-scoped guard (S0 checklist §5): every /o/[orgId] route resolves the
 * membership + role server-side; deactivated members and non-members are
 * redirected; org-enforced MFA is checked before any org content renders.
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (resolved === "no_session") redirect(`/login?next=/o/${orgId}`);
  if (resolved === "no_membership") redirect("/");
  if (!resolved.mfaSatisfied) redirect("/mfa");

  const user = await getSessionUser();
  const orgs = user ? await listMyOrgs(user.id) : [];

  return (
    <AppShell
      brand={
        <div className="flex items-center gap-3">
          <Link href={`/o/${orgId}`}>IdaraWorks</Link>
          <Badge tone="neutral">{resolved.orgName}</Badge>
        </div>
      }
      actions={
        <nav className="flex items-center gap-3 text-sm">
          {orgs.length > 1 ? (
            <details className="relative">
              <summary className="min-h-11 cursor-pointer list-none px-2 leading-[44px] text-ink-secondary">
                {t("org.switcher.label")}
              </summary>
              <ul className="absolute end-0 z-20 mt-1 w-56 rounded-md border border-line bg-card p-1 shadow-sm">
                {orgs.map((o) => (
                  <li key={o.orgId}>
                    <Link
                      href={`/o/${o.orgId}`}
                      className="block min-h-11 rounded-sm px-3 py-2.5 text-ink hover:bg-sunken"
                    >
                      {o.orgName}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <Link href={`/o/${orgId}/settings/members`} className="text-ink-secondary">
            {t("members.title")}
          </Link>
          <Link href="/account" className="text-ink-secondary">
            {t("auth.account.title")}
          </Link>
        </nav>
      }
    >
      {children}
    </AppShell>
  );
}
