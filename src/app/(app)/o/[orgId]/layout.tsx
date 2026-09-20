import Link from "next/link";
import { IdaraDockMount } from "./idara/IdaraDockMount";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import {
  ActionNotice,
  Icon,
  Menu,
  buildBottomNav,
  buildNavGroups,
  buildQuickCreate,
} from "@/platform/ui";
import { Suspense } from "react";
import type { MenuSection } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { formatDate } from "@/platform/format";
import { offeredLocales } from "@/platform/i18n/offered";
import { LOCALE_NATIVE_NAME } from "@/platform/i18n/locale";
import { getSessionUser, listMyOrgs, resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import {
  stockSurfacesEnabled,
  hrSurfacesEnabled,
  financeSurfacesEnabled,
  managementStudioEnabled,
  documentStudioEnabled,
  revenueStudioEnabled,
  countryPacksEnabled,
  brandedCompanyAppsEnabled,
  guidedOnboardingEnabled,
} from "@/platform/flags";
import { resolveEntitlements } from "@/platform/entitlements";
import {
  filterGroupsByBlueprint,
  navItemAllowedByBlueprint,
  quickCreateAllowedByBlueprint,
} from "@/platform/workspace";
import { getAppBranding } from "@/modules/branding/service";
import { logoutAction, setActiveLocaleAction } from "@/app/(auth)/actions";
import { OrgLogo } from "./OrgLogo";
import { CompanyAppHead } from "./CompanyAppHead";
import { InstallApp } from "./InstallApp";
import { installLabels } from "./install/labels";
import { GuidedTourMount } from "./onboarding-tour/GuidedTourMount";
import { restartTourAction } from "./onboarding-tour/actions";
import { resolveShell } from "./shell";
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
  // 30-day trial, visible: days left, what is included, what happens after.
  const trialDaysLeft = ent.trialDaysLeft;
  const canSeeBilling = can(a, "billing.manage");
  const trialBanner =
    ent.billingState === "trialing" && ent.trialEnd ? (
      <div
        role="status"
        className={
          ent.trialExpired
            ? "mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink"
            : "mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-brand/30 bg-brand/5 px-3 py-2 text-sm text-ink"
        }
      >
        <span>
          {ent.trialExpired
            ? t("trial.banner.ended", { date: formatDate(ent.trialEnd) })
            : t("trial.banner.active", { days: String(trialDaysLeft ?? 0) })}
          <span className="ms-2 text-ink-secondary">{t("trial.banner.no_card")}</span>
        </span>
        {canSeeBilling ? (
          <Link
            href={`/o/${orgId}/settings/subscription`}
            className="text-sm font-medium text-brand hover:underline"
          >
            {ent.trialExpired ? t("trial.banner.see_plan") : t("trial.promise.details")}
          </Link>
        ) : null}
      </div>
    ) : null;

  // Terminology vars for every nav label (doc 07 — nouns are ICU variables).
  const navVars = {
    job: term("job", terms, "singular"),
    jobs: term("job", terms, "plural"),
    daily_report: term("daily_report", terms, "singular"),
    daily_reports: term("daily_report", terms, "plural"),
  };
  // H16: the ONE shell resolution — the applied Intelligent Clay blueprint
  // (null for legacy organizations, whose shell stays exactly as today) plus
  // the member's organization-facing role label. The blueprint contributes
  // only the approved-CONFIGURATION layer; can() and live entitlements keep
  // deciding inside the builder (the H14 effective-access equation).
  const shell = await resolveShell(resolved);

  const input = {
    orgId,
    archetype: a,
    features: ent.features,
    // H22F release gate — the stock and asset screens are absent from every
    // menu until the deployment turns them on (platform/flags.ts).
    stockSurfaces: stockSurfacesEnabled(),
    // H23G release gate — same law as stock.
    hrSurfaces: hrSurfacesEnabled(),
    // H24K release gate — same law again.
    financeSurfaces: financeSurfacesEnabled(),
    // H25 release gate — same law.
    studioSurfaces: managementStudioEnabled(),
    // H26 release gate — same law.
    documentSurfaces: documentStudioEnabled(),
    revenueSurfaces: revenueStudioEnabled(),
    // H29 release gate — same law: the country screens are absent from every
    // menu until the deployment turns them on.
    countrySurfaces: countryPacksEnabled(),
    // H31 release gate — the company-app settings entry is absent from every
    // menu until the deployment turns it on.
    companyAppSurfaces: brandedCompanyAppsEnabled(),
  };
  const groups: NavGroupVM[] = filterGroupsByBlueprint(
    buildNavGroups(input).map((g) => ({
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
    })),
    shell.shape,
  );
  const bottomItems: BottomItemVM[] = buildBottomNav(input)
    .filter((i) => navItemAllowedByBlueprint(i.key, shell.disabledModules))
    .map((i) => ({
      key: i.key,
      label: t(i.labelKey, navVars),
      href: i.href,
      icon: i.icon,
      locked: i.locked,
      isMore: i.isMore,
    }));
  const quickCreate = buildQuickCreate(input)
    .filter((i) => quickCreateAllowedByBlueprint(i.key, shell.disabledModules))
    .map((i) => ({
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
    // H32: a deliberate, stable tour anchor. The tour points at meanings,
    // never at DOM positions or translated labels, so this attribute exists
    // for that and for nothing else.
    <Link data-tour="brand" href={`/o/${orgId}`} className="block min-w-0 font-semibold text-ink">
      <OrgLogo ctx={resolved.ctx} archetype={a} orgName={resolved.orgName} />
    </Link>
  );
  // H29: a two-way toggle cannot express three languages — a single button that
  // says "العربية" tells you nothing about where Spanish went. The header keeps
  // one compact control and opens a menu naming each language in itself.
  const languageSections = [
    {
      key: "language",
      heading: t("nav.switch_language"),
      items: offeredLocales().map((candidate) => ({
        key: candidate,
        label: LOCALE_NATIVE_NAME[candidate],
        formAction: setActiveLocaleAction.bind(null, candidate),
      })),
    },
  ];

  // H31: labels are resolved on the server so the client island ships no
  // translation catalogue and no locale logic of its own.
  const installLabelsVM = installLabels(t);

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

  // H16 role context: the shell states plainly who you are here (Part F/J) —
  // the org's own role label in the active locale, never a technical key.
  const roleLabel = locale === "ar" ? shell.roleLabel.ar : shell.roleLabel.en;
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
  // The permanent install entry, for every member: the Company app settings
  // page is for administrators, so this one lives in the account menu.
  if (brandedCompanyAppsEnabled()) {
    accountLinks.push({
      key: "install",
      label: t("app.install_page.title"),
      href: `/o/${orgId}/install`,
    });
  }
  // H32: the restart. Behind the flag, so with it off the menu is unchanged.
  if (guidedOnboardingEnabled()) {
    accountLinks.push({
      key: "tour",
      label: t("tour.restart"),
      formAction: restartTourAction.bind(null, orgId),
    });
  }
  const accountSections: MenuSection[] = [
    {
      key: "account",
      heading: t("shell.role_context", { org: resolved.orgName, role: roleLabel }),
      items: accountLinks,
    },
  ];
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

  // H16: sidebar collapse persists in a cookie so SSR renders the right
  // width immediately (no layout shift, no flicker on slow connections).
  const railCollapsed = (await cookies()).get("iw_sidebar")?.value === "rail";

  return (
    <div style={accentStyle} className="min-h-dvh md:flex">
      {/* H31: per-tenant manifest and icon links. Renders nothing with the
          flag off, which keeps today's head byte-identical. */}
      <CompanyAppHead orgId={orgId} />
      <SidebarNav
        groups={groups}
        brand={brand}
        lockedHint={t("nav.locked_hint")}
        navLabel={t("nav.primary")}
        initialCollapsed={railCollapsed}
        collapseLabel={t("nav.collapse")}
        expandLabel={t("nav.expand")}
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
                // A real box, not display:contents — the tour rings this element,
                // and a box-less wrapper measures 0×0 and can never be ringed.
                <span data-tour="create" className="inline-flex">
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
                </span>
              ) : null}

              <Link
                href={`/o/${orgId}/settings/notifications`}
                aria-label={t("nav.notifications")}
                className="flex h-11 w-11 items-center justify-center rounded-md text-ink-secondary hover:bg-sunken hover:text-ink"
              >
                <Icon name="bell" size={20} />
              </Link>

              <Menu
                triggerLabel={t("nav.switch_language")}
                triggerClassName="flex h-11 items-center gap-1.5 rounded-md px-2 text-sm text-ink-secondary hover:bg-sunken hover:text-ink"
                trigger={
                  <>
                    <Icon name="globe" size={18} aria-hidden />
                    <span className="hidden sm:inline" lang={locale}>
                      {LOCALE_NATIVE_NAME[locale]}
                    </span>
                  </>
                }
                sections={languageSections}
                panelClassName="w-44"
              />

              {/*
                H31: a quiet install affordance in the global chrome. It renders
                nothing at all when the flag is off, when the app is already
                running standalone, or once the user has said "don't remind me"
                on this device — so it can never become the banner everyone has
                learned to dismiss without reading.
              */}
              {brandedCompanyAppsEnabled() ? (
                <div className="hidden sm:block">
                  <InstallApp orgId={orgId} labels={installLabelsVM} />
                </div>
              ) : null}

              <span data-tour="account" className="inline-flex">
                <Menu
                  triggerLabel={t("auth.account.title")}
                  triggerClassName="flex h-11 w-11 items-center justify-center rounded-md text-ink-secondary hover:bg-sunken hover:text-ink"
                  trigger={<Icon name="user" size={20} />}
                  sections={accountSections}
                  panelClassName="w-64"
                />
              </span>
            </nav>
          </div>
        </header>

        {/* Bottom padding clears the mobile bar (3.5rem) plus the device's
            safe area, so a page's last action is never under the tabs. */}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-8">
          {/* The shared "did that work?" banner: any action that redirects with
              ?ok= or ?error= from the registry below is answered here. */}
          {/* One compact install card on phones (hidden once running as the
              installed app, or after "Not now" for a fortnight on that device). */}
          {brandedCompanyAppsEnabled() ? (
            <div className="md:hidden">
              <InstallApp
                orgId={orgId}
                variant="banner"
                labels={installLabelsVM}
                banner={{
                  title: t("app.banner.title", { org: resolved.orgName }),
                  body: t("app.banner.body"),
                  how: t("app.banner.how"),
                  later: t("app.banner.later"),
                  close: t("common.close"),
                }}
                leading={
                  <OrgLogo
                    ctx={resolved.ctx}
                    archetype={resolved.archetype}
                    orgName={resolved.orgName}
                  />
                }
              />
            </div>
          ) : null}
          {trialBanner}
          <Suspense fallback={null}>
            <ActionNotice
              messages={{
                ok: {
                  saved: t("notice.ok.saved"),
                  created: t("notice.ok.created"),
                  updated: t("notice.ok.updated"),
                  deleted: t("notice.ok.deleted"),
                  submitted: t("notice.ok.submitted"),
                  sent: t("notice.ok.sent"),
                  applied: t("notice.ok.applied"),
                  invite_accepted: t("notice.ok.invite_accepted"),
                  already_member: t("notice.ok.already_member"),
                  quote_converted: t("notice.ok.quote_converted", {
                    job: term("job", terms, "singular"),
                  }),
                },
                error: {
                  failed: t("notice.error.failed"),
                  invalid: t("notice.error.invalid"),
                  forbidden: t("notice.error.forbidden"),
                  rate_limited: t("notice.error.rate_limited"),
                  not_found: t("notice.error.not_found"),
                  create_failed: t("notice.error.create_failed"),
                  update_failed: t("notice.error.update_failed"),
                  delete_failed: t("notice.error.delete_failed"),
                  terms_failed: t("notice.error.terms_failed"),
                  hr_failed: t("notice.error.hr_failed"),
                  state: t("notice.error.state"),
                  create: t("notice.error.create"),
                  save: t("notice.error.save"),
                  apply: t("notice.error.apply"),
                  undo: t("notice.error.undo"),
                  move: t("notice.error.move"),
                  deactivate: t("notice.error.deactivate"),
                  empty: t("notice.error.empty"),
                  not_empty: t("notice.error.not_empty"),
                  no_file: t("notice.error.no_file"),
                  duplicates: t("notice.error.duplicates"),
                  unknown_step: t("notice.error.unknown_step"),
                  kind: t("notice.error.kind"),
                  unknown: t("notice.error.unknown"),
                  other: t("notice.error.other"),
                  not_employee: t("notice.error.not_employee"),
                  contact: t("notice.error.contact"),
                  start_work: t("notice.error.start_work"),
                  convert: t("notice.error.convert"),
                  no_template: t("notice.error.no_template"),
                  note: t("notice.error.note"),
                  self: t("notice.error.self"),
                  cap: t("notice.error.cap"),
                  unavailable: t("notice.error.unavailable"),
                },
                dismiss: t("common.dismiss"),
              }}
            />
          </Suspense>
          {children}
        </main>
        {/* H28 — the Idara Dock: rendered only behind FEATURE_IDARA_INTELLIGENCE, the person's permission and the organisation's AI policy. */}
        {/* H32 — the welcome panel and the short tour. Renders nothing with
            the flag off, and nothing for anybody who is not newly arrived. */}
        <GuidedTourMount
          orgId={orgId}
          ctx={resolved.ctx}
          archetype={resolved.archetype}
          orgName={resolved.orgName}
          terms={{ job: navVars.job, jobs: navVars.jobs, daily_report: navVars.daily_report }}
        />
        <IdaraDockMount
          orgId={orgId}
          ctx={resolved.ctx}
          archetype={resolved.archetype}
          locale={locale}
          userId={resolved.ctx.userId}
        />
      </div>
    </div>
  );
}
