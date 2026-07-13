import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell, Badge } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { getSessionUser, listMyOrgs, resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";

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
  const t = await getT();
  const { orgId } = await params;
  const resolved = await resolveCtx(orgId);
  if (resolved === "no_session") redirect(`/login?next=/o/${orgId}`);
  if (resolved === "no_membership") redirect("/");
  if (resolved === "mfa_required" || !resolved.mfaSatisfied) redirect("/mfa");

  const user = await getSessionUser();
  const orgs = user ? await listMyOrgs(user.id) : [];
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const a = resolved.archetype;
  // S1 section nav (mobile-first: wraps; the full S5 IA replaces this).
  const links: Array<{ href: string; label: string }> = [
    ...(can(a, "jobs.view")
      ? [{ href: `/o/${orgId}/jobs`, label: term("job", terms, "plural") }]
      : []),
    ...(can(a, "week.view") ? [{ href: `/o/${orgId}/week`, label: t("nav.week") }] : []),
    // S3 heartbeat surfaces (gated per doc 06).
    ...(can(a, "reports.create")
      ? [
          {
            href: `/o/${orgId}/reports/new`,
            label: t("reports.new.title", {
              daily_report: term("daily_report", terms, "singular"),
            }),
          },
        ]
      : []),
    ...(can(a, "reports.review")
      ? [{ href: `/o/${orgId}/reports/review`, label: t("nav.reports_review") }]
      : []),
    ...(can(a, "attendance.view")
      ? [{ href: `/o/${orgId}/attendance`, label: t("nav.attendance") }]
      : []),
    ...(can(a, "issues.raise") ? [{ href: `/o/${orgId}/issues`, label: t("nav.issues") }] : []),
    // S4 supply & approve surfaces (gated per doc 06).
    ...(can(a, "approvals.decide")
      ? [{ href: `/o/${orgId}/approvals`, label: t("nav.approvals") }]
      : []),
    ...(can(a, "mr.create")
      ? [{ href: `/o/${orgId}/material-requests`, label: t("nav.material_requests") }]
      : []),
    ...(can(a, "po.view")
      ? [{ href: `/o/${orgId}/purchase-orders`, label: t("nav.purchase_orders") }]
      : []),
    // S5 "Measure" surfaces (gated per doc 06).
    ...(can(a, "expenses.view")
      ? [{ href: `/o/${orgId}/expenses`, label: t("nav.expenses") }]
      : []),
    ...(can(a, "costing.view") ? [{ href: `/o/${orgId}/costing`, label: t("nav.costing") }] : []),
    // S6 "Bill" surfaces (gated per doc 06).
    ...(can(a, "quotes.view") ? [{ href: `/o/${orgId}/quotes`, label: t("nav.quotes") }] : []),
    ...(can(a, "invoices.view")
      ? [{ href: `/o/${orgId}/invoices`, label: t("nav.invoices") }]
      : []),
    ...(can(a, "payments.view")
      ? [{ href: `/o/${orgId}/payments`, label: t("nav.payments") }]
      : []),
    ...(can(a, "ar.view") ? [{ href: `/o/${orgId}/ar`, label: t("nav.ar") }] : []),
    // S7 "Improve" surface.
    ...(can(a, "customer_updates.draft")
      ? [{ href: `/o/${orgId}/customer-updates`, label: t("nav.customer_updates") }]
      : []),
    ...(can(a, "employees.view") ? [{ href: `/o/${orgId}/people`, label: t("nav.people") }] : []),
    ...(can(a, "customers.view")
      ? [{ href: `/o/${orgId}/customers`, label: t("nav.customers") }]
      : []),
    ...(can(a, "catalog.view")
      ? [
          { href: `/o/${orgId}/suppliers`, label: t("nav.suppliers") },
          { href: `/o/${orgId}/items`, label: t("nav.items") },
        ]
      : []),
    ...(can(a, "config.view")
      ? [{ href: `/o/${orgId}/settings/configuration`, label: t("nav.configuration") }]
      : []),
  ];

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
          <Link href={`/o/${orgId}/settings/notifications`} className="text-ink-secondary">
            {t("nav.notifications")}
          </Link>
          <Link href={`/o/${orgId}/settings/members`} className="text-ink-secondary">
            {t("members.title")}
          </Link>
          <Link href="/account" className="text-ink-secondary">
            {t("auth.account.title")}
          </Link>
        </nav>
      }
    >
      <nav className="mb-4 flex flex-wrap gap-2">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="min-h-11 rounded-md border border-line bg-card px-3 py-2.5 text-sm text-ink hover:bg-sunken"
          >
            {l.label}
          </Link>
        ))}
      </nav>
      {children}
    </AppShell>
  );
}
