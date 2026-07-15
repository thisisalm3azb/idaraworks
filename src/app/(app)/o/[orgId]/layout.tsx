import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import { Icon, Menu, buildBottomNav, buildNavGroups, buildQuickCreate } from "@/platform/ui";
import type { MenuSection } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { getSessionUser, listMyOrgs, resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import { resolveEntitlements } from "@/platform/entitlements";
import { getAppBranding } from "@/modules/branding/service";
import { logoutAction, setActiveLocaleAction } from "@/app/(auth)/actions";
import { OrgLogo } from "./OrgLogo";
import { SidebarNav } from "./nav/SidebarNav";
import { MobileNav } from "./nav/MobileNav";
import type { BottomItemVM, NavGroupVM } from "./nav/types";

/**
 * The org-scoped guard (S0 checklist §5) + the U5 navigation shell: every
 * /o/[orgId] route resolves the membership + role server-side; deactivated
 * members and non-members are redirected; org-enforced MFA is checked before
 * any org content renders.
 *
 * Shell (U5 §1): desktop = branded sidebar (role-aware grouped nav) + top bar;
 * mobile = compact top bar (burger → drawer) + the mounted BottomNav. All
 * visibility decisions stay with can() + entitlement features via the pure
 * builder (src/platform/ui/nav/build.ts). The org accent colour (branding
 * add-on) is injected as --accent here — indicator bars and tints only, never
 * text colour, so tenant accents stay WCAG-safe.
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
  // Add-on model (0065): entitlements shape which items exist / lock — NAV ONLY,
  // never a route guard (freeze FR-9: entitlements gate ADD, never seeing).
  const ent = await resolveEntitlements(resolved.ctx);

  // Terminology vars for every nav label (doc 07 — nouns are ICU variables).
  const navVars = {
    job: term("job", terms, "singular"),
    jobs: term("job", terms, "plural"),
    daily_report: term("daily_report", terms, "singular"),
    daily_reports: term("daily_report", terms, "plural"),
  };
  const input = { orgId, archetype: a, features: ent.features };
  const groups: NavGroupVM[] = buildNavGroups(input).map((g) => ({
    key: g.key,
    label: t(g.labelKey, navVars),
    icon: g.icon,
    items: g.items.map((i) => ({
      key: i.key,
      label: t(i.labelKey, navVars),
      href: i.href,
      icon: i.icon,
      locked: i.locked,
    })),
  }));
  const bottomItems: BottomItemVM[] = buildBottomNav(input).map((i) => ({
    key: i.key,
    label: t(i.labelKey, navVars),
    href: i.href,
    icon: i.icon,
    locked: i.locked,
    isMore: i.isMore,
  }));
  const quickCreate = buildQuickCreate(input).map((i) => ({
    key: i.key,
    label: t(i.labelKey, navVars),
    href: i.href,
    icon: i.icon,
  }));

  // U2 branding: tenant accent (only when feat.branding_app is on) drives the
  // --accent CSS variable; unset orgs keep the platform brand colour.
  let accentColor: string | null = null;
  try {
    const branding = await getAppBranding(resolved.ctx);
    if (branding.enabled) accentColor = branding.branding.accentColor;
  } catch {
    accentColor = null; // branding must never break the shell
  }
  const accentStyle = accentColor ? ({ "--accent": accentColor } as CSSProperties) : undefined;

  const brand = (
    <Link href={`/o/${orgId}`} className="block min-w-0 font-semibold text-ink">
      <OrgLogo ctx={resolved.ctx} archetype={a} orgName={resolved.orgName} />
    </Link>
  );
  const otherLocale = locale === "ar" ? "en" : "ar";

  // DEFECT 4: header menu data is computed server-side and handed to the client
  // <Menu> as plain view-models (labels already resolved). One section for the
  // quick-create panel; the account panel groups account links, the workspace
  // switcher (only with >1 org) and the logout server action.
  const quickCreateSections: MenuSection[] =
    quickCreate.length > 0
      ? [
          {
            key: "create",
            items: quickCreate.map((q) => ({
              key: q.key,
              label: q.label,
              href: q.href,
              icon: q.icon,
            })),
          },
        ]
      : [];

  const accountLinks: MenuSection["items"] = [
    { key: "account", label: t("auth.account.title"), href: "/account" },
  ];
  if (can(a, "billing.view")) {
    accountLinks.push({
      key: "subscription",
      label: t("nav.subscription"),
      href: `/o/${orgId}/settings/subscription`,
    });
  }
  if (can(a, "members.view")) {
    accountLinks.push({
      key: "members",
      label: t("members.title"),
      href: `/o/${orgId}/settings/members`,
    });
  }
  const accountSections: MenuSection[] = [{ key: "account", items: accountLinks }];
  if (orgs.length > 1) {
    accountSections.push({
      key: "workspace",
      heading: t("org.switcher.label"),
      items: orgs.map((o) => ({ key: o.orgId, label: o.orgName, href: `/o/${o.orgId}` })),
    });
  }
  accountSections.push({
    key: "session",
    items: [{ key: "logout", label: t("nav.logout"), icon: "logout", formAction: logoutAction }],
  });

  return (
    <div style={accentStyle} className="min-h-dvh md:flex">
      <SidebarNav
        groups={groups}
        brand={brand}
        lockedHint={t("nav.locked_hint")}
        navLabel={t("nav.primary")}
      />

      <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-card">
          <div className="flex min-h-14 items-center gap-1 px-2 md:px-4">
            <MobileNav
              groups={groups}
              bottomItems={bottomItems}
              brand={brand}
              openLabel={t("nav.open_menu")}
              closeLabel={t("nav.close_menu")}
              lockedHint={t("nav.locked_hint")}
              accountLabel={t("auth.account.title")}
              navLabel={t("nav.primary")}
            />
            {/* Page-context slot: the brand on mobile (the sidebar owns it on md+). */}
            <div className="min-w-0 flex-1 md:hidden">{brand}</div>
            <div className="hidden min-w-0 flex-1 md:block" />

            <nav className="flex items-center gap-0.5" aria-label={t("nav.top_bar")}>
              {quickCreateSections.length > 0 ? (
                <Menu
                  triggerLabel={t("nav.create.title")}
                  triggerClassName="flex h-11 min-w-11 items-center justify-center gap-1 rounded-md px-2 text-sm font-medium text-ink hover:bg-sunken"
                  trigger={
                    <>
                      <span
                        className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-ink-inverse"
                        aria-hidden
                      >
                        <Icon name="plus" size={16} />
                      </span>
                      <span className="hidden lg:inline">{t("nav.create.title")}</span>
                    </>
                  }
                  sections={quickCreateSections}
                />
              ) : null}

              <Link
                href={`/o/${orgId}/settings/notifications`}
                aria-label={t("nav.notifications")}
                className="flex h-11 w-11 items-center justify-center rounded-md text-ink-secondary hover:bg-sunken hover:text-ink"
              >
                <Icon name="bell" size={20} />
              </Link>

              <form action={setActiveLocaleAction.bind(null, otherLocale)}>
                <button
                  type="submit"
                  className="flex h-11 items-center gap-1.5 rounded-md px-2 text-sm text-ink-secondary hover:bg-sunken hover:text-ink"
                  aria-label={t("nav.switch_language")}
                >
                  <Icon name="globe" size={18} aria-hidden />
                  <span className="hidden sm:inline">
                    {otherLocale === "ar" ? "العربية" : "English"}
                  </span>
                </button>
              </form>

              <Menu
                triggerLabel={t("auth.account.title")}
                triggerClassName="flex h-11 w-11 items-center justify-center rounded-md text-ink-secondary hover:bg-sunken hover:text-ink"
                trigger={<Icon name="user" size={20} />}
                sections={accountSections}
                panelClassName="w-64"
              />
            </nav>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-24 md:pb-8">{children}</main>
      </div>
    </div>
  );
}
