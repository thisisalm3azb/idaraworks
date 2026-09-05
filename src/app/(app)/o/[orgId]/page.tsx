import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState, buildQuickCreate } from "@/platform/ui";
import {
  ActivityTimeline,
  AttentionZone,
  BusinessBrief,
  CapabilitiesRow,
  DistributionBar,
  KpiCard,
  LockedCard,
  NextBestActions,
  QuickActions,
  RowList,
  SectionCard,
  SetupProgress,
  StatusDonut,
  TrendChart,
  WelcomeBanner,
  computeDelta,
  type AttentionRowView,
  type BriefChipView,
  type DistributionDatum,
  type DonutDatum,
  type HomeActionView,
  type ListRow,
  type OwnerHomeView,
  type SetupStepView,
  type TrendPoint,
} from "@/platform/ui/dashboard";
import { getAppBranding } from "@/modules/branding/service";
import { OrgLogo } from "./OrgLogo";
import { GettingStarted } from "./onboarding-tour/GettingStarted";
import { getT, getServerLocale, type Translator } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { loadOrgTerminology, term } from "@/platform/terminology";
import type { Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import {
  composeOwnerHome,
  composeToday,
  getDashboardExtras,
  type DashboardExtras,
  type TodayCard,
} from "@/modules/today/service";
import { listInbox, type InboxRow } from "@/modules/approvals/service";
import { listAttendanceForDate } from "@/modules/attendance/service";
import {
  hasFeature,
  resolveEntitlements,
  type ResolvedEntitlements,
} from "@/platform/entitlements";
import { getOwnerDigest, type DigestSection } from "@/modules/digest/service";
import { getInstalledTemplate } from "@/platform/config";
import { formatDate, formatMoney, formatTime } from "@/platform/format";
import type { CurrencyCode, Locale } from "@/platform/registries";
import type { BlueprintArchetype } from "@/platform/workspace";
import { disabledModulesOf } from "@/platform/workspace";
import {
  composeAdaptiveDashboard,
  gatherDashboardData,
  orgToday,
  HORIZON_DAYS,
} from "@/modules/dashboard/service";
import { resolveShell } from "./shell";
import { AdaptiveDashboard } from "./adaptive";
import { dismissExceptionAction } from "./actions";

const SEV_TONE: Record<string, "neutral" | "info" | "warning" | "danger"> = {
  info: "info",
  warning: "warning",
  critical: "danger",
};
// Manager exception cards carry a dismiss action (owner/admin/manager, audience+scope).
const EXCEPTION_CARDS = new Set(["missing_reports", "overdue", "blockers"]);

/** Everything a role screen needs, resolved once (server). */
type ScreenCtx = {
  t: Translator;
  locale: Locale;
  orgId: string;
  currency: CurrencyCode;
  ctx: Ctx;
  archetype: RoleArchetype;
  cards: TodayCard[];
  extras: DashboardExtras;
  inbox: InboxRow[];
  ent: ResolvedEntitlements;
  canDismiss: boolean;
  jobVars: Record<string, string>;
  seesPrice: boolean;
  canBilling: boolean;
  /** Org IANA timezone (null → freshness times render as UTC, labelled). */
  timezone: string | null;
};

export default async function OrgHome({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; welcome?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const a = resolved.archetype;

  if (!can(a, "today.view")) {
    return (
      <EmptyState
        title={t("today.other_role.title")}
        description={t("today.other_role.description")}
      />
    );
  }

  // ── H17: blueprint organizations get the adaptive, decision-led home. ─────
  // Legacy organizations (no applied blueprint) fall through to the pre-H17
  // composition below, byte-for-byte (the legacy law, pinned by tests).
  const shell = await resolveShell(resolved);
  if (shell.shape && a !== "worker_reserved_p3") {
    const adaptiveLocale = await getServerLocale();
    const terms = await loadOrgTerminology(resolved.ctx, adaptiveLocale);
    const vars = {
      job: term("job", terms, "singular"),
      jobs: term("job", terms, "plural"),
      daily_report: term("daily_report", terms, "singular"),
      daily_reports: term("daily_report", terms, "plural"),
      material_request: term("material_request", terms, "singular"),
      material_requests: term("material_request", terms, "plural"),
    };
    const now = new Date();
    const asOf = orgToday(now, resolved.timezone);
    // The compiled horizon feeds the gather too, so window-bounded counts
    // (closing opportunities, expiring quotes) match their drill-downs.
    const compiledDash = shell.shape.compiled.dashboards[a as BlueprintArchetype] ?? null;
    const horizonDays = HORIZON_DAYS[compiledDash?.timeHorizon ?? ""] ?? 7;
    const [data, ent] = await Promise.all([
      gatherDashboardData(resolved.ctx, a, { asOf, computedAt: now.toISOString(), horizonDays }),
      resolveEntitlements(resolved.ctx),
    ]);
    const view = composeAdaptiveDashboard(
      {
        orgId,
        archetype: a as BlueprintArchetype,
        seesPrice: resolved.ctx.pricePrivileged,
        features: ent.features,
        disabledModules: disabledModulesOf(shell.shape.compiled),
        compiledDashboard: compiledDash,
        asOf,
      },
      data,
    );
    const cookieJar = await cookies();
    const collapsed = new Set(
      decodeURIComponent(cookieJar.get("iw_dash")?.value ?? "")
        .split(",")
        .filter(Boolean),
    );
    const welcomeLinksAdaptive = [
      ...(can(a, "onboarding.run")
        ? [
            { key: "setup", label: t("onboarding.checklist.run"), href: `/o/${orgId}/onboarding` },
            { key: "import", label: t("onboarding.checklist.import"), href: `/o/${orgId}/imports` },
          ]
        : []),
      ...(can(a, "jobs.view")
        ? [{ key: "jobs", label: t("nav.item.jobs", vars), href: `/o/${orgId}/jobs` }]
        : []),
    ];
    return (
      <>
        {sp.welcome === "1" ? (
          <div className="mb-4">
            <WelcomeBanner
              title={t("dashboard.welcome.title")}
              body={t("dashboard.welcome.body")}
              dismissLabel={t("dashboard.welcome.dismiss")}
              links={welcomeLinksAdaptive}
            />
          </div>
        ) : null}
        <AdaptiveDashboard
          t={t}
          locale={adaptiveLocale}
          orgId={orgId}
          currency={resolved.baseCurrency as CurrencyCode}
          timezone={resolved.timezone}
          vars={vars}
          view={view}
          extras={data.extras}
          myJobs={data.myJobs ?? []}
          returnedReports={data.returnedReports ?? []}
          collapsed={collapsed}
          now={now}
          orgName={resolved.orgName}
          roleLabel={adaptiveLocale === "ar" ? shell.roleLabel.ar : shell.roleLabel.en}
        />
      </>
    );
  }

  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const jobVars = {
    job: term("job", terms, "singular"),
    jobs: term("job", terms, "plural"),
    daily_report: term("daily_report", terms, "singular"),
    daily_reports: term("daily_report", terms, "plural"),
  };
  const now = new Date();
  const asOf = now.toISOString().slice(0, 10);
  const opts = { asOf, computedAt: now.toISOString() };
  // Viewer (adversarial review): no composeToday screen exists for the role —
  // its read-only Today is assembled from getDashboardExtras alone (every
  // block in there is gated by the viewer's own can() grants; never money).
  const isViewer = a === "viewer";
  // S7 digest gating — unchanged semantics (display-only add-on gate, FR-9).
  const canViewDigest = can(a, "digest.view");
  // Perf (adversarial review): the previously-serial tail (inbox → digest gate
  // → installed template) is folded into ONE concurrent fan-out. Only
  // getOwnerDigest stays behind — it depends on the entitlement gate.
  const [payload, extras, ent, inbox, installedTemplate, digestFeatureOn] = await Promise.all([
    isViewer ? null : composeToday(resolved.ctx, a, opts),
    getDashboardExtras(resolved.ctx, a, opts),
    resolveEntitlements(resolved.ctx),
    can(a, "approvals.decide") ? listInbox(resolved.ctx, a) : ([] as InboxRow[]),
    can(a, "onboarding.run") ? getInstalledTemplate(resolved.ctx) : null,
    canViewDigest ? hasFeature(resolved.ctx, "feat.owner_digest") : false,
  ]);
  const canDismiss = can(a, "exceptions.dismiss");
  const currency = resolved.baseCurrency as CurrencyCode;

  const digestEntitled = canViewDigest && digestFeatureOn;
  const digest = digestEntitled ? await getOwnerDigest(resolved.ctx, a) : null;

  // First-run: owner/admin without an installed template gets setup guidance.
  const needsSetup = can(a, "onboarding.run") ? !installedTemplate : false;

  const s: ScreenCtx = {
    t,
    locale,
    orgId,
    currency,
    ctx: resolved.ctx,
    archetype: a,
    cards: payload?.cards ?? [],
    extras,
    inbox,
    ent,
    canDismiss,
    jobVars,
    seesPrice: resolved.ctx.pricePrivileged,
    canBilling: can(a, "billing.view"),
    timezone: resolved.timezone,
  };

  // Role-aware quick actions (same pure builder as the top-bar + New menu).
  const quickActions = buildQuickCreate({ orgId, archetype: a, features: ent.features }).map(
    (q) => ({ key: q.key, label: t(q.labelKey, jobVars), href: q.href, icon: q.icon }),
  );

  const welcomeLinks = [
    ...(can(a, "onboarding.run")
      ? [
          { key: "setup", label: t("onboarding.checklist.run"), href: `/o/${orgId}/onboarding` },
          { key: "import", label: t("onboarding.checklist.import"), href: `/o/${orgId}/imports` },
        ]
      : []),
    ...(can(a, "jobs.view")
      ? [{ key: "jobs", label: t("nav.item.jobs", jobVars), href: `/o/${orgId}/jobs` }]
      : []),
  ];

  // Owner/Admin (microstep 002B — blueprint): the page head becomes the
  // org-led Business Brief + Next Best Actions + Attention, composed by the
  // pure deterministic owner-home composer from the EXISTING payloads above.
  // All other roles keep the existing header + layout untouched.
  const isOwnerScreen = payload?.screen === "owner";
  let ownerHome: OwnerHomeView | null = null;
  let ownerHasLogo = false;
  if (isOwnerScreen) {
    // Request-cached (the layout already fetches it) — no additional query cost.
    const appBranding = await getAppBranding(resolved.ctx);
    ownerHasLogo = appBranding.branding.logoFileId !== null;
    const card = (key: string) => cardOf(payload?.cards ?? [], key);
    const collections0 = card("collections")?.items[0] as
      { outstandingMinor?: number | null; over90?: number | null } | undefined;
    const atRiskItems = (card("at_risk")?.items ?? []).map((item, i) => ({
      id: String(item.id ?? i),
      ruleKey: String(item.ruleKey ?? ""),
      severity: typeof item.severity === "string" ? item.severity : "warning",
      jobId: item.jobId ? String(item.jobId) : null,
    }));
    const oldest = inbox.reduce<number | null>((acc, r) => {
      const days = Math.floor((now.getTime() - Date.parse(r.createdAt)) / 86_400_000);
      return acc === null || days > acc ? days : acc;
    }, null);
    ownerHome = composeOwnerHome({
      orgId,
      seesPrice: resolved.ctx.pricePrivileged,
      canBilling: can(a, "billing.view"),
      needsSetup,
      hasLogo: ownerHasLogo,
      counts: {
        activeJobs: extras.jobs?.active ?? 0,
        doneThisWeek: extras.jobs?.doneThisWeek ?? 0,
        overdueJobs: extras.jobs?.overdue ?? 0,
        reportsThisWeek: extras.reportsThisWeek,
        reportsPrevWeek: extras.reportsPrevWeek,
        approvalsPending: extras.approvalsPending ?? 0,
        openIssues: extras.openIssues ?? 0,
        quotesAwaiting: extras.quotesAwaiting,
        blockers: card("blockers")?.count ?? 0,
        missingReports: card("missing_reports")?.count ?? 0,
        reportsToReview: card("reports_to_review")?.count ?? 0,
        paymentsWeekMinor: extras.paymentsWeekMinor,
        outstandingMinor: (collections0?.outstandingMinor ?? null) as number | null,
        over90Minor: (collections0?.over90 ?? null) as number | null,
        seatsTotal: extras.seats ? extras.seats.office + extras.seats.viewer : null,
        mrSubmitted: (extras.mrOpen?.submitted ?? 0) + (extras.mrOpen?.approved ?? 0),
        poOpen: extras.poStatus
          ? extras.poStatus.approved + extras.poStatus.sent + extras.poStatus.partial
          : 0,
      },
      atRisk: atRiskItems,
      approvalsOldestDays: oldest,
      quick: buildQuickCreate({ orgId, archetype: a, features: ent.features }).map((q) => ({
        key: q.key,
        labelKey: q.labelKey,
        href: q.href,
        icon: q.icon,
      })),
      capsOn: Object.entries(ent.features).filter(([k, v]) => k.startsWith("cap.") && v).length,
      hasReportTrendData: (extras.reportTrend?.points ?? []).some((p) => p.value > 0),
      hasPaymentsTrendData: (extras.paymentsTrend?.points ?? []).some((p) => p.value > 0),
      hasStageData: (extras.stageDist ?? []).some((sl) => sl.count > 0),
      hasActivity: extras.activity.length > 0,
      hasDeadlines: (extras.deadlines ?? []).length > 0,
      invoicingOn: ent.features["cap.invoicing"] ?? false,
      paymentsOn: ent.features["cap.payments"] ?? false,
    });
  }

  // The digest card, shared unchanged between the non-owner position and the
  // owner home's curated layout (single markup, two slots).
  const digestCard = digest ? (
    <Card>
      <CardHeader
        title={t("digest.title")}
        meta={
          <span className="text-xs text-ink-muted">
            {t("today.card_as_of")}{" "}
            <span dir="ltr">
              {formatTime(digest.computedAt, {
                locale,
                timeZone: resolved.timezone ?? undefined,
              })}
            </span>
          </span>
        }
      />
      {digest.narration ? (
        <p className="mb-2 text-sm leading-relaxed text-ink">{digest.narration}</p>
      ) : null}
      <ul className="flex flex-col">
        {digest.sections
          .filter((sec) => sec.count > 0 || sec.moneyMinor)
          .map((sec) => (
            <DigestRow
              key={sec.key}
              section={sec}
              orgId={orgId}
              label={t(sec.labelKey)}
              currency={currency}
            />
          ))}
      </ul>
      {digest.sections.every((sec) => sec.count === 0 && !sec.moneyMinor) ? (
        <p className="text-xs text-ink-muted">{t("digest.all_clear")}</p>
      ) : null}
    </Card>
  ) : null;

  // The org-led Business Brief (owner) — every string translated here; the
  // composer supplied only grounded keys/vars.
  const briefNode = ownerHome ? (
    <BusinessBrief
      orgName={resolved.orgName}
      logo={
        ownerHasLogo ? (
          <OrgLogo ctx={resolved.ctx} archetype={a} orgName={resolved.orgName} />
        ) : null
      }
      dateLine={formatDate(now, { locale })}
      sentence={t(ownerHome.brief.sentenceKey, { ...jobVars, ...ownerHome.brief.sentenceVars })}
      chips={ownerHome.brief.chips.map((c): BriefChipView => ({
        key: c.key,
        label:
          c.key === "payments" && extras.paymentsWeekMinor !== null
            ? t(c.labelKey, {
                ...jobVars,
                amount: formatMoney(extras.paymentsWeekMinor, currency, { locale }),
              })
            : t(c.labelKey, { ...jobVars, ...c.vars }),
        tone: c.tone,
        href: c.href,
      }))}
    />
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      {briefNode ?? (
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold text-ink">{t("today.title")}</h1>
            <p className="text-xs text-ink-muted">
              {`${t("today.card_as_of")} ${formatDate(now, { locale })}`}
            </p>
          </div>
          <Badge tone="neutral">{t(`today.screen.${payload?.screen ?? "viewer"}`)}</Badge>
        </div>
      )}

      {/* H32 — the getting-started checklist. Renders nothing with the
          flag off, nothing once its items are done, and nothing once the person
          has dismissed it. */}
      <GettingStarted
        orgId={orgId}
        ctx={resolved.ctx}
        archetype={a}
        terms={{ job: jobVars.job, jobs: jobVars.jobs }}
      />

      {sp.welcome === "1" ? (
        <WelcomeBanner
          title={t("dashboard.welcome.title")}
          body={t("dashboard.welcome.body")}
          dismissLabel={t("dashboard.welcome.dismiss")}
          links={welcomeLinks}
        />
      ) : null}

      {sp.ok === "dismissed" ? (
        <Badge tone="success">{t("today.dismissed")}</Badge>
      ) : sp.error ? (
        <Badge tone="danger">{t("common.error")}</Badge>
      ) : null}

      {/* Non-owner screens keep the digest block exactly where it was. The
          owner home renders the digest inside its curated layout instead, and
          replaces the LockedCard upsell with the compact capabilities row. */}
      {!isOwnerScreen && canViewDigest && !digestEntitled ? (
        <LockedCard
          title={t("digest.title")}
          description={t("digest.upsell")}
          href={s.canBilling ? `/o/${orgId}/settings/subscription` : undefined}
          ctaLabel={s.canBilling ? t("digest.upsell_cta") : undefined}
        />
      ) : null}
      {!isOwnerScreen ? digestCard : null}

      {ownerHome ? <OwnerScreen s={s} home={ownerHome} digestCard={digestCard} /> : null}
      {payload?.screen === "manager" ? <ManagerScreen s={s} /> : null}
      {payload?.screen === "foreman" ? <ForemanScreen s={s} /> : null}
      {payload?.screen === "accounts" ? <AccountsScreen s={s} /> : null}
      {payload?.screen === "procurement" ? <ProcurementScreen s={s} /> : null}
      {isViewer ? <ViewerScreen s={s} /> : null}

      {/* Non-owner screens keep the shared bottom section unchanged (002B
          restructures ONLY the owner composition). */}
      {!isOwnerScreen ? (
        <>
          {quickActions.length > 0 ? (
            <SectionCard title={t("dashboard.quick_actions")}>
              <QuickActions actions={quickActions} />
            </SectionCard>
          ) : null}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {extras.deadlines !== null ? <DeadlinesCard s={s} /> : null}
            <SectionCard title={t("dashboard.activity")}>
              <ActivityTimeline
                entries={extras.activity.map((e) => ({
                  key: e.id,
                  summary: e.summary,
                  when: formatDate(e.createdAt, { locale }),
                  actor: e.actorName,
                }))}
                emptyLabel={t("dashboard.activity_empty")}
              />
            </SectionCard>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── shared pieces ─────────────────────────────────────────────────────────────
function cardOf(cards: TodayCard[], key: string): TodayCard | undefined {
  return cards.find((c) => c.key === key);
}

function stageLabel(
  name: { en: string; ar: string } | null,
  locale: Locale,
  noneLabel: string,
): string {
  if (!name) return noneLabel;
  return (locale === "ar" ? name.ar : name.en) || name.en || noneLabel;
}

function trendPoints(extras: DashboardExtras["reportTrend"]): TrendPoint[] {
  if (!extras) return [];
  return extras.points.map((p) => ({ label: p.date.slice(5), value: p.value }));
}

function moneyTrendPoints(
  series: DashboardExtras["paymentsTrend"],
  currency: CurrencyCode,
  locale: Locale,
): TrendPoint[] {
  if (!series) return [];
  return series.points.map((p) => ({
    label: p.date.slice(5),
    value: p.value,
    display: series.unit === "money" ? formatMoney(p.value, currency, { locale }) : String(p.value),
  }));
}

function StageCard({ s }: { s: ScreenCtx }) {
  const { t, locale, orgId, extras } = s;
  const data: DistributionDatum[] = (extras.stageDist ?? []).map((slice) => ({
    key: slice.key,
    label: stageLabel(slice.name, locale, t("dashboard.stage_none")),
    value: slice.count,
    href:
      slice.key === "_none"
        ? `/o/${orgId}/jobs`
        : `/o/${orgId}/jobs?stage=${encodeURIComponent(slice.key)}`,
  }));
  return (
    <SectionCard
      title={t("dashboard.stage_dist", s.jobVars)}
      viewAllHref={`/o/${orgId}/jobs`}
      viewAllLabel={t("dashboard.view_all")}
    >
      {data.length === 0 ? (
        <p className="py-2 text-sm text-ink-muted">{t("dashboard.stage_empty", s.jobVars)}</p>
      ) : (
        <DistributionBar data={data} title={t("dashboard.stage_dist", s.jobVars)} />
      )}
    </SectionCard>
  );
}

function ReportTrendCard({ s }: { s: ScreenCtx }) {
  const { t, extras, orgId } = s;
  const points = trendPoints(extras.reportTrend);
  return (
    <SectionCard
      title={t("dashboard.report_trend", s.jobVars)}
      viewAllHref={`/o/${orgId}/reports/review`}
      viewAllLabel={t("dashboard.view_all")}
    >
      {points.length === 0 || points.every((p) => p.value === 0) ? (
        <p className="py-2 text-sm text-ink-muted">{t("dashboard.trend_empty")}</p>
      ) : (
        <TrendChart points={points} title={t("dashboard.report_trend", s.jobVars)} kind="bar" />
      )}
    </SectionCard>
  );
}

/**
 * Owner/Admin home (microstep 002B — "Your business, alive"). The Brief is
 * rendered by OrgHome above; this screen renders the action-led body from the
 * pure composer's view model: Next Best Actions dominate the start column,
 * Attention (elevated, only when real) + digest sit in the end column; the
 * lower area shows ONLY sections with meaningful content; the empty state
 * replaces charts with grounded Setup Progress + a teaching diagram. The old
 * ApprovalsCard / at-risk card / money LockedCards / subscription strip /
 * quick-action card are removed here per the approved removal list — their
 * information lives in Attention, the actions, or the capabilities row.
 */
function OwnerScreen({
  s,
  home,
  digestCard,
}: {
  s: ScreenCtx;
  home: OwnerHomeView;
  digestCard: React.ReactNode;
}) {
  const { t, locale, orgId, extras, currency } = s;
  const vars = s.jobVars;

  const actionViews: HomeActionView[] = home.actions.map((a) => ({
    key: a.key,
    title: t(a.titleKey, { ...vars, ...a.vars }),
    reason: a.reasonKey ? t(a.reasonKey, { ...vars, ...a.vars }) : undefined,
    href: a.href,
    icon: a.icon,
    urgency: a.urgency,
  }));

  const attentionViews: AttentionRowView[] = home.attention.map((r) => ({
    key: r.key,
    label: r.ruleKey
      ? t(`dashboard.rule.${r.ruleKey}`, vars)
      : t(r.labelKey ?? "", { ...vars, ...r.vars }),
    severity: r.severity,
    severityLabel: t(`exceptions.severity.${r.severity}`),
    href: r.href,
  }));

  const setupViews: SetupStepView[] | null = home.setup
    ? home.setup.map((st) => ({
        key: st.key,
        label: t(st.labelKey, vars),
        done: st.done,
        href: st.href,
        unlocks: st.unlocksKey ? t(st.unlocksKey, vars) : undefined,
      }))
    : null;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <NextBestActions title={t("home.actions.title")} actions={actionViews} />
        <div className="flex flex-col gap-4">
          <AttentionZone
            title={t("home.attention.title")}
            rows={attentionViews}
            viewAllLabel={t("dashboard.view_all")}
            viewAllHref={`/o/${orgId}/week`}
          />
          {setupViews ? (
            <SetupProgress
              title={t("home.setup.title")}
              steps={setupViews}
              diagram={{
                from: vars.job ?? "",
                mid: vars.daily_reports ?? "",
                to: t("home.setup.diagram_done"),
                caption: t("home.setup.diagram_caption", vars),
              }}
            />
          ) : null}
          {digestCard}
        </div>
      </div>

      {home.sections.stages || home.sections.reportTrend ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {home.sections.stages ? <StageCard s={s} /> : null}
          {home.sections.reportTrend ? (
            <SectionCard
              title={t("dashboard.report_trend", vars)}
              viewAllHref={`/o/${orgId}/reports/review`}
              viewAllLabel={t("dashboard.view_all")}
            >
              <p className="mb-2 text-xs text-ink-muted">
                {t("dashboard.week_delta")}{" "}
                <span dir="ltr" className="font-mono text-ink">
                  {computeDelta(extras.reportsThisWeek, extras.reportsPrevWeek).label}
                </span>
              </p>
              <TrendChart
                points={trendPoints(extras.reportTrend)}
                title={t("dashboard.report_trend", vars)}
                kind="bar"
              />
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {home.sections.collections || home.sections.payments ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {home.sections.collections ? <CollectionsCard s={s} /> : null}
          {home.sections.payments ? (
            <SectionCard
              title={t("dashboard.payments_trend")}
              viewAllHref={`/o/${orgId}/payments`}
              viewAllLabel={t("dashboard.view_all")}
            >
              {extras.paymentsWeekMinor !== null ? (
                <p className="mb-2 text-xs text-ink-muted">
                  {t("today.card.payments_week")}{" "}
                  <span dir="ltr" className="font-mono font-semibold text-ink">
                    {formatMoney(extras.paymentsWeekMinor, currency, { locale })}
                  </span>
                </p>
              ) : null}
              {moneyTrendPoints(extras.paymentsTrend, currency, locale).length > 0 ? (
                <TrendChart
                  points={moneyTrendPoints(extras.paymentsTrend, currency, locale)}
                  title={t("dashboard.payments_trend")}
                />
              ) : null}
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {home.sections.purchasing ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <PurchasingCard s={s} />
          <AttendanceCard s={s} />
        </div>
      ) : null}

      {home.sections.deadlines || home.sections.activity ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {home.sections.deadlines ? <DeadlinesCard s={s} /> : null}
          {home.sections.activity ? (
            <SectionCard title={t("dashboard.activity")}>
              <ActivityTimeline
                entries={extras.activity.map((e) => ({
                  key: e.id,
                  summary: e.summary,
                  when: formatDate(e.createdAt, { locale }),
                  actor: e.actorName,
                }))}
                emptyLabel={t("dashboard.activity_empty")}
              />
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {home.map ? (
        <CapabilitiesRow
          label={t("home.map.caps", { count: home.map.capsOn })}
          manageLabel={home.map.showManage ? t("home.map.manage") : undefined}
          manageHref={home.map.showManage ? `/o/${orgId}/settings/subscription` : undefined}
        />
      ) : null}
    </>
  );
}

/** Receivables summary — rendered only when price-visible AND non-zero (002B). */
function CollectionsCard({ s }: { s: ScreenCtx }) {
  const { t, locale, orgId, cards, currency } = s;
  const collections = cardOf(cards, "collections");
  const outstanding = (collections?.items[0]?.outstandingMinor ?? null) as number | null;
  const over90 = (collections?.items[0]?.over90 ?? null) as number | null;
  return (
    <SectionCard
      title={t("today.card.collections")}
      viewAllHref={`/o/${orgId}/ar`}
      viewAllLabel={t("dashboard.view_all")}
    >
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <div>
          <p className="text-xs text-ink-muted">{t("dashboard.outstanding")}</p>
          <p dir="ltr" className="font-mono text-xl font-semibold text-ink">
            {outstanding !== null ? formatMoney(outstanding, currency, { locale }) : "—"}
          </p>
        </div>
        <div>
          <p className="text-xs text-ink-muted">{t("dashboard.over90")}</p>
          <p dir="ltr" className="font-mono text-xl font-semibold text-danger">
            {over90 !== null ? formatMoney(over90, currency, { locale }) : "—"}
          </p>
        </div>
      </div>
    </SectionCard>
  );
}

function DeadlinesCard({ s }: { s: ScreenCtx }) {
  const { t, locale, orgId, extras } = s;
  const rows: ListRow[] = (extras.deadlines ?? []).map((d) => ({
    key: d.id,
    title: `${d.reference} — ${d.name}`,
    href: `/o/${orgId}/jobs/${d.id}`,
    meta: formatDate(d.dueDate, { locale }),
    badge: d.overdue ? { label: t("dashboard.overdue"), tone: "danger" as const } : undefined,
  }));
  return (
    <SectionCard
      title={t("dashboard.deadlines")}
      viewAllHref={`/o/${orgId}/week`}
      viewAllLabel={t("dashboard.view_all")}
    >
      <RowList rows={rows} emptyLabel={t("dashboard.deadlines_empty")} />
    </SectionCard>
  );
}

function ApprovalsCard({ s }: { s: ScreenCtx }) {
  const { t, locale, orgId, inbox, currency } = s;
  const rows: ListRow[] = inbox.slice(0, 6).map((r) => ({
    key: r.id,
    title: r.title || r.subjectType,
    href: `/o/${orgId}/approvals`,
    meta:
      r.amountMinor !== null
        ? formatMoney(Number(r.amountMinor), currency, { locale })
        : formatDate(r.createdAt, { locale }),
    metaLtr: r.amountMinor !== null,
    badge: r.jobRef ? { label: r.jobRef, tone: "neutral" as const } : undefined,
  }));
  return (
    <SectionCard
      title={t("nav.approvals")}
      viewAllHref={`/o/${orgId}/approvals`}
      viewAllLabel={t("dashboard.view_all")}
    >
      <RowList rows={rows} emptyLabel={t("approvals.inbox_empty")} />
    </SectionCard>
  );
}

function PurchasingCard({ s }: { s: ScreenCtx }) {
  const { t, orgId, extras, ent } = s;
  if (!extras.mrOpen && !extras.poStatus) return null;
  const mrOn = ent.features["cap.material_requests"] ?? false;
  const poOn = ent.features["cap.purchase_orders"] ?? false;
  const rows: ListRow[] = [
    ...(extras.mrOpen && mrOn
      ? [
          {
            key: "mr_submitted",
            title: t("dashboard.mr_submitted"),
            href: `/o/${orgId}/material-requests`,
            meta: String(extras.mrOpen.submitted),
            metaLtr: true,
          },
          {
            key: "mr_approved",
            title: t("today.card.approved_mrs"),
            href: `/o/${orgId}/material-requests`,
            meta: String(extras.mrOpen.approved),
            metaLtr: true,
          },
        ]
      : []),
    ...(extras.poStatus && poOn
      ? [
          {
            key: "po_open",
            title: t("today.card.open_pos"),
            href: `/o/${orgId}/purchase-orders`,
            meta: String(extras.poStatus.approved + extras.poStatus.sent + extras.poStatus.partial),
            metaLtr: true,
          },
          {
            key: "po_partial",
            title: t("dashboard.awaiting_receipt"),
            href: `/o/${orgId}/purchase-orders`,
            meta: String(extras.poStatus.partial),
            metaLtr: true,
          },
        ]
      : []),
  ];
  if (rows.length === 0) return null;
  return (
    <SectionCard title={t("dashboard.purchasing")}>
      <RowList rows={rows} emptyLabel={t("today.card_empty")} />
    </SectionCard>
  );
}

async function AttendanceCard({ s }: { s: ScreenCtx }) {
  const { t, orgId, ent } = s;
  if (!(ent.features["cap.attendance"] ?? false)) return null;
  if (!can(s.archetype, "attendance.view")) return null;
  // Reuse the existing grid read (attendance.view re-asserted inside).
  let present = 0;
  let marked = 0;
  let total = 0;
  try {
    const grid = await listAttendanceForDate(
      s.ctx,
      s.archetype,
      new Date().toISOString().slice(0, 10),
    );
    total = grid.length;
    marked = grid.filter((g) => g.status !== null).length;
    present = grid.filter((g) => g.status === "present" || g.status === "late").length;
  } catch {
    return null;
  }
  return (
    <SectionCard
      title={t("dashboard.attendance_today")}
      viewAllHref={`/o/${orgId}/attendance`}
      viewAllLabel={t("dashboard.view_all")}
    >
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <div>
          <p className="text-xs text-ink-muted">{t("dashboard.attendance_present")}</p>
          <p dir="ltr" className="font-mono text-xl font-semibold text-ink">
            {present} / {total}
          </p>
        </div>
        <div>
          <p className="text-xs text-ink-muted">{t("dashboard.attendance_marked")}</p>
          <p dir="ltr" className="font-mono text-xl font-semibold text-ink">
            {marked} / {total}
          </p>
        </div>
      </div>
    </SectionCard>
  );
}

/** Viewer (adversarial review): a minimal READ-ONLY Today assembled purely
 * from reads the viewer already holds (jobs/week — doc 06 row) — status
 * distribution + this-week completions. NO queues, NO money; the shared
 * deadlines + activity grid below covers the rest. */
function ViewerScreen({ s }: { s: ScreenCtx }) {
  const { t, orgId, extras } = s;
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <KpiCard
          label={t("dashboard.kpi.active_jobs", s.jobVars)}
          value={String(extras.jobs?.active ?? 0)}
          icon="briefcase"
          href={`/o/${orgId}/jobs`}
        />
        <KpiCard
          label={t("dashboard.kpi.done_week", s.jobVars)}
          value={String(extras.jobs?.doneThisWeek ?? 0)}
          icon="check"
          tone={(extras.jobs?.doneThisWeek ?? 0) > 0 ? "success" : "neutral"}
          href={`/o/${orgId}/jobs`}
        />
      </div>
      <StageCard s={s} />
    </>
  );
}

function ManagerScreen({ s }: { s: ScreenCtx }) {
  const { t, orgId, extras, cards } = s;
  const toReview = cardOf(cards, "reports_to_review");
  const missingToday = cardOf(cards, "missing_today");
  const blockers = cardOf(cards, "blockers");
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label={t("dashboard.kpi.active_jobs", s.jobVars)}
          value={String(extras.jobs?.active ?? 0)}
          icon="briefcase"
          href={`/o/${orgId}/jobs`}
        />
        <KpiCard
          label={t("today.card.reports_to_review")}
          value={String(toReview?.count ?? 0)}
          icon="clipboard"
          tone={(toReview?.count ?? 0) > 0 ? "warning" : "neutral"}
          href={`/o/${orgId}/reports/review`}
        />
        <KpiCard
          label={t("today.card.missing_today")}
          value={String(missingToday?.count ?? 0)}
          icon="alert"
          tone={(missingToday?.count ?? 0) > 0 ? "warning" : "neutral"}
          href={`/o/${orgId}/reports/review`}
        />
        <KpiCard
          label={t("today.card.blockers")}
          value={String(blockers?.count ?? 0)}
          icon="alert"
          tone={(blockers?.count ?? 0) > 0 ? "danger" : "neutral"}
          href={`/o/${orgId}/issues`}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <StageCard s={s} />
        <ReportTrendCard s={s} />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <ApprovalsCard s={s} />
        <AttentionCards s={s} keys={["missing_reports", "overdue", "blockers"]} />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <AttentionCards s={s} keys={["reports_to_review", "missing_today"]} />
      </div>
    </>
  );
}

function ForemanScreen({ s }: { s: ScreenCtx }) {
  const { t, orgId, extras, cards } = s;
  const myJobs = cardOf(cards, "my_jobs_today");
  const toSubmit = cardOf(cards, "submit_daily_report");
  const returned = cardOf(cards, "waiting_on_me");
  const myJobRows: ListRow[] = (myJobs?.items ?? []).map((item, i) => ({
    key: String(item.id ?? i),
    title: `${String(item.reference ?? "")} — ${String(item.name ?? "")}`,
    href: `/o/${orgId}/jobs/${String(item.id)}`,
    meta: item.lastReport ? String(item.lastReport) : t("dashboard.no_report_yet"),
    metaLtr: !!item.lastReport,
  }));
  const returnedRows: ListRow[] = (returned?.items ?? []).map((item, i) => ({
    key: String(item.id ?? i),
    title: String(item.reference ?? ""),
    href: `/o/${orgId}/reports/${String(item.id)}`,
    meta: String(item.reportDate ?? ""),
    metaLtr: true,
    badge: { label: t("dashboard.returned"), tone: "warning" as const },
  }));
  return (
    <>
      {/* Field-first: the day's ONE big action. */}
      {(toSubmit?.count ?? 0) > 0 ? (
        <Link
          href={`/o/${orgId}/reports/new`}
          className="flex min-h-14 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-base font-semibold text-ink-inverse shadow-card hover:opacity-95"
        >
          {t("dashboard.submit_report_cta", s.jobVars)}
          <Badge tone="neutral" className="bg-card/20 text-ink-inverse">
            {toSubmit?.count ?? 0}
          </Badge>
        </Link>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label={t("today.card.my_jobs_today", s.jobVars)}
          value={String(myJobs?.count ?? 0)}
          icon="briefcase"
          href={`/o/${orgId}/jobs`}
        />
        <KpiCard
          label={t("today.card.submit_daily_report")}
          value={String(toSubmit?.count ?? 0)}
          icon="clipboard"
          tone={(toSubmit?.count ?? 0) > 0 ? "warning" : "success"}
          href={`/o/${orgId}/reports/new`}
        />
        <KpiCard
          label={t("today.card.waiting_on_me")}
          value={String(returned?.count ?? 0)}
          icon="alert"
          tone={(returned?.count ?? 0) > 0 ? "warning" : "neutral"}
          // No org-wide reports list exists — the honest target is the
          // returned-reports list on this page (each row deep-links its
          // report), never the NEW-report composer.
          href="#waiting-on-me"
        />
        <KpiCard
          label={t("nav.issues")}
          value={String(extras.openIssues ?? 0)}
          icon="alert"
          href={`/o/${orgId}/issues`}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <SectionCard
          title={t("today.card.my_jobs_today", s.jobVars)}
          viewAllHref={`/o/${orgId}/jobs`}
          viewAllLabel={t("dashboard.view_all")}
        >
          {myJobRows.length === 0 ? (
            <EmptyState
              title={t("dashboard.foreman_empty_title", s.jobVars)}
              description={t("dashboard.foreman_empty_body", s.jobVars)}
            />
          ) : (
            <RowList rows={myJobRows} emptyLabel={t("today.card_empty")} />
          )}
        </SectionCard>
        <SectionCard
          id="waiting-on-me"
          className="scroll-mt-20"
          title={t("today.card.waiting_on_me")}
        >
          <RowList rows={returnedRows} emptyLabel={t("today.card_empty")} />
          <div className="mt-3">
            <ReportTrendMini s={s} />
          </div>
        </SectionCard>
      </div>
    </>
  );
}

function ReportTrendMini({ s }: { s: ScreenCtx }) {
  const { t, extras } = s;
  const points = trendPoints(extras.reportTrend);
  if (points.length === 0 || points.every((p) => p.value === 0)) return null;
  return (
    <TrendChart
      points={points}
      title={t("dashboard.report_trend", s.jobVars)}
      kind="bar"
      height={90}
    />
  );
}

function AccountsScreen({ s }: { s: ScreenCtx }) {
  const { t, locale, orgId, extras, cards, currency } = s;
  // 6 KPIs — 3-up on lg (2×3) instead of the ragged 4+2 of lg:grid-cols-4.
  const ar = cardOf(cards, "ar_summary");
  const arRow = (ar?.items[0] ?? {}) as Record<string, unknown>;
  const outstanding = (arRow.outstandingMinor ?? null) as number | null;
  const overdueRecv = cardOf(cards, "overdue_receivables");
  const toIssue = cardOf(cards, "invoices_to_issue");
  const agingData: DonutDatum[] = [
    {
      key: "current",
      label: t("dashboard.aging.current"),
      value: num(arRow.current),
      color: "var(--success)",
      href: `/o/${orgId}/ar`,
    },
    {
      key: "d1_30",
      label: t("dashboard.aging.d1_30"),
      value: num(arRow.d1_30),
      color: "var(--info)",
      href: `/o/${orgId}/ar`,
    },
    {
      key: "d31_60",
      label: t("dashboard.aging.d31_60"),
      value: num(arRow.d31_60),
      color: "var(--warning)",
      href: `/o/${orgId}/ar`,
    },
    {
      key: "d61_90",
      label: t("dashboard.aging.d61_90"),
      value: num(arRow.d61_90),
      color: "var(--danger)",
      href: `/o/${orgId}/ar`,
    },
    {
      key: "over90",
      label: t("dashboard.aging.over90"),
      value: num(arRow.over90),
      color: "var(--text-primary)",
      href: `/o/${orgId}/ar`,
    },
  ];
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiCard
          label={t("today.card.ar_summary")}
          value={
            s.seesPrice && outstanding !== null
              ? formatMoney(outstanding, currency, { locale })
              : "—"
          }
          icon="chart"
          href={`/o/${orgId}/ar`}
        />
        <KpiCard
          label={t("today.card.overdue_receivables")}
          value={String(overdueRecv?.count ?? 0)}
          icon="alert"
          tone={(overdueRecv?.count ?? 0) > 0 ? "danger" : "neutral"}
          href={`/o/${orgId}/ar`}
        />
        <KpiCard
          label={t("today.card.invoices_to_issue")}
          value={String(toIssue?.count ?? 0)}
          icon="receipt"
          tone={(toIssue?.count ?? 0) > 0 ? "warning" : "neutral"}
          href={`/o/${orgId}/invoices`}
        />
        <KpiCard
          label={t("today.card.expenses_queue")}
          value={String(extras.unpaidExpenses ?? 0)}
          icon="wallet"
          href={`/o/${orgId}/expenses`}
        />
        <KpiCard
          label={t("dashboard.quotes_awaiting")}
          value={String(extras.quotesAwaiting ?? 0)}
          icon="fileText"
          href={`/o/${orgId}/quotes`}
        />
        <KpiCard
          label={t("today.card.payments_week")}
          value={
            s.seesPrice && extras.paymentsWeekMinor !== null
              ? formatMoney(extras.paymentsWeekMinor, currency, { locale })
              : "—"
          }
          icon="banknote"
          href={`/o/${orgId}/payments`}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <SectionCard
          title={t("dashboard.ar_aging")}
          viewAllHref={`/o/${orgId}/ar`}
          viewAllLabel={t("dashboard.view_all")}
        >
          {agingData.every((d) => d.value === 0) ? (
            <p className="py-2 text-sm text-ink-muted">{t("today.card_empty")}</p>
          ) : (
            <StatusDonut
              data={agingData}
              title={t("dashboard.ar_aging")}
              centerLabel={String(agingData.reduce((sum, d) => sum + d.value, 0))}
            />
          )}
        </SectionCard>
        <SectionCard
          title={t("dashboard.payments_trend")}
          viewAllHref={`/o/${orgId}/payments`}
          viewAllLabel={t("dashboard.view_all")}
        >
          {moneyTrendPoints(extras.paymentsTrend, currency, locale).length === 0 ? (
            <p className="py-2 text-sm text-ink-muted">{t("dashboard.trend_empty")}</p>
          ) : (
            <TrendChart
              points={moneyTrendPoints(extras.paymentsTrend, currency, locale)}
              title={t("dashboard.payments_trend")}
            />
          )}
        </SectionCard>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <ApprovalsCard s={s} />
        <AttentionCards s={s} keys={["invoices_to_issue", "overdue_receivables"]} />
      </div>
    </>
  );
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function ProcurementScreen({ s }: { s: ScreenCtx }) {
  const { t, orgId, extras, cards } = s;
  const approvedMrs = cardOf(cards, "approved_mrs");
  const openPos = cardOf(cards, "open_pos");
  const poData: DonutDatum[] = extras.poStatus
    ? [
        {
          key: "approved",
          label: t("dashboard.po.approved"),
          value: extras.poStatus.approved,
          color: "var(--info)",
          href: `/o/${orgId}/purchase-orders`,
        },
        {
          key: "sent",
          label: t("dashboard.po.sent"),
          value: extras.poStatus.sent,
          color: "var(--brand)",
          href: `/o/${orgId}/purchase-orders`,
        },
        {
          key: "partial",
          label: t("dashboard.po.partial"),
          value: extras.poStatus.partial,
          color: "var(--warning)",
          href: `/o/${orgId}/purchase-orders`,
        },
      ]
    : [];
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label={t("dashboard.mr_submitted")}
          value={String(extras.mrOpen?.submitted ?? 0)}
          icon="package"
          tone={(extras.mrOpen?.submitted ?? 0) > 0 ? "warning" : "neutral"}
          href={`/o/${orgId}/material-requests`}
        />
        <KpiCard
          label={t("today.card.approved_mrs")}
          value={String(approvedMrs?.count ?? 0)}
          icon="check"
          href={`/o/${orgId}/material-requests`}
        />
        <KpiCard
          label={t("today.card.open_pos")}
          value={String(openPos?.count ?? 0)}
          icon="cart"
          href={`/o/${orgId}/purchase-orders`}
        />
        <KpiCard
          label={t("dashboard.awaiting_receipt")}
          value={String(extras.poStatus?.partial ?? 0)}
          icon="truck"
          tone={(extras.poStatus?.partial ?? 0) > 0 ? "warning" : "neutral"}
          href={`/o/${orgId}/purchase-orders`}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <SectionCard
          title={t("dashboard.po_status")}
          viewAllHref={`/o/${orgId}/purchase-orders`}
          viewAllLabel={t("dashboard.view_all")}
        >
          {poData.every((d) => d.value === 0) ? (
            <p className="py-2 text-sm text-ink-muted">{t("today.card_empty")}</p>
          ) : (
            <StatusDonut
              data={poData}
              title={t("dashboard.po_status")}
              centerLabel={String(poData.reduce((sum, d) => sum + d.value, 0))}
            />
          )}
        </SectionCard>
        <SectionCard title={t("dashboard.suppliers_items")}>
          <RowList
            rows={[
              { key: "suppliers", title: t("nav.suppliers"), href: `/o/${orgId}/suppliers` },
              { key: "items", title: t("nav.items"), href: `/o/${orgId}/items` },
            ]}
            emptyLabel={t("today.card_empty")}
          />
        </SectionCard>
      </div>
    </>
  );
}

/** The composeToday attention cards, rendered with their original semantics
 * (severity badges, job links, manager dismiss actions). */
function AttentionCards({ s, keys }: { s: ScreenCtx; keys: string[] }) {
  const { t, cards } = s;
  return (
    <>
      {keys
        .map((k) => cardOf(cards, k))
        .filter((c): c is TodayCard => !!c)
        .map((card) => (
          <TodayCardView
            key={card.key}
            card={card}
            orgId={s.orgId}
            title={t(`today.card.${card.key}`, s.jobVars)}
            emptyLabel={t("today.card_empty")}
            canDismiss={s.canDismiss && EXCEPTION_CARDS.has(card.key)}
            dismissLabel={t("today.dismiss")}
            asOfLabel={t("today.card_as_of")}
            asOfDisplay={formatTime(card.freshness.computedAt, {
              locale: s.locale,
              timeZone: s.timezone ?? undefined,
            })}
            severityLabel={(sev: string) => t(`exceptions.severity.${sev}`)}
          />
        ))}
    </>
  );
}

// Deep-link target per digest section (evidence links come from the structured source).
const DIGEST_LINK: Record<string, string> = {
  needs_decision: "approvals",
  at_risk: "week",
  collections: "ar",
  supply: "purchase-orders",
  yesterday: "reports/review",
  crew: "week",
  customers_awaiting: "customer-updates",
  this_week: "week",
};

function DigestRow({
  section,
  orgId,
  label,
  currency,
}: {
  section: DigestSection;
  orgId: string;
  label: string;
  currency: CurrencyCode;
}) {
  const href = `/o/${orgId}/${DIGEST_LINK[section.key] ?? ""}`;
  return (
    <li className="flex items-center justify-between gap-2 border-b border-line py-2 text-sm last:border-0">
      <Link href={href} className="text-ink hover:underline">
        {label}
      </Link>
      <span className="flex items-center gap-2 font-mono text-ink" dir="ltr">
        {section.moneyMinor !== null ? formatMoney(section.moneyMinor, currency) : null}
        <Badge tone={section.count > 0 ? "brand" : "neutral"}>{section.count}</Badge>
      </span>
    </li>
  );
}

function TodayCardView({
  card,
  orgId,
  title,
  emptyLabel,
  canDismiss,
  dismissLabel,
  asOfLabel,
  asOfDisplay,
  severityLabel,
}: {
  card: TodayCard;
  orgId: string;
  title: string;
  emptyLabel: string;
  canDismiss: boolean;
  dismissLabel: string;
  asOfLabel: string;
  /** Pre-formatted freshness time — org timezone (or labelled UTC fallback). */
  asOfDisplay: string;
  severityLabel: (s: string) => string;
}) {
  return (
    <Card>
      <CardHeader
        title={title}
        meta={
          <span className="flex items-center gap-2 text-xs text-ink-muted">
            <Badge tone={card.count > 0 ? "brand" : "neutral"}>{card.count}</Badge>
            <span>
              {asOfLabel} <span dir="ltr">{asOfDisplay}</span>
            </span>
          </span>
        }
      />
      {card.count === 0 ? (
        <p className="text-xs text-ink-muted">{emptyLabel}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {card.items.slice(0, 8).map((item, i) => (
            <li
              key={String(item.id ?? i)}
              className="flex items-center justify-between gap-2 rounded-md border border-line p-2 text-sm"
            >
              <span className="min-w-0 truncate text-ink">
                {typeof item.severity === "string" ? (
                  <Badge tone={SEV_TONE[item.severity] ?? "neutral"}>
                    {severityLabel(item.severity)}
                  </Badge>
                ) : null}{" "}
                {itemLabel(item, orgId)}
              </span>
              {canDismiss && typeof item.id === "string" ? (
                <form action={dismissExceptionAction.bind(null, orgId)}>
                  <input type="hidden" name="exception_id" value={item.id} />
                  <Button type="submit" variant="ghost">
                    {dismissLabel}
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function itemLabel(item: Record<string, unknown>, orgId: string) {
  const ref = (item.reference as string | undefined) ?? (item.name as string | undefined);
  const jobId = item.jobId as string | undefined;
  const label = ref ?? (typeof item.reportDate === "string" ? item.reportDate : "—");
  if (jobId) {
    return (
      <Link href={`/o/${orgId}/jobs/${jobId}`} className="text-brand hover:underline">
        {label}
      </Link>
    );
  }
  return <span>{label}</span>;
}
