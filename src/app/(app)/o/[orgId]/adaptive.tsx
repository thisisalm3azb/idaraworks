/**
 * H17 — the adaptive dashboard renderer (blueprint organizations).
 *
 * A decision-led management home in five layers: Needs your attention (never
 * collapsible), Next, Business pulse, In progress, Recently changed. Every
 * item was composed server-side by the deterministic composer under the full
 * effective-content law; this file only translates, formats (locale, org
 * currency, org timezone) and lays out. Empty sections are not rendered.
 * Urgency is never color-alone: every severity carries its text label.
 * Card visibility is presentation, not authorization — every destination
 * route keeps its own permission guard.
 *
 * Each layer is exported on its own so the dashboard board can place, size
 * and hide them as widgets; `AdaptiveDashboard` is the fixed five-layer
 * arrangement, unchanged.
 */
import Link from "next/link";
import {
  ActivityTimeline,
  DistributionBar,
  RowList,
  SectionCard,
  type DistributionDatum,
  type ListRow,
} from "@/platform/ui/dashboard";
import { Badge } from "@/platform/ui";
import { formatDate, formatMoney } from "@/platform/format";
import type { Translator } from "@/platform/i18n/server";
import type { CurrencyCode, Locale } from "@/platform/registries";
import type { AdaptiveDashboardView, DashboardItem } from "@/modules/dashboard/service";
import type { DashboardExtras } from "@/modules/today/service";
import { AdaptiveSection } from "./AdaptiveSection";

const SEV_TONE = {
  critical: "danger",
  warning: "warning",
  info: "info",
} as const;

export type AdaptiveProps = {
  t: Translator;
  locale: Locale;
  orgId: string;
  currency: CurrencyCode;
  timezone: string | null;
  vars: Record<string, string>;
  view: AdaptiveDashboardView;
  extras: DashboardExtras | null;
  myJobs: Array<{ id: string; reference: string; name: string; lastReport: string | null }>;
  returnedReports: Array<{ id: string; reference: string; reportDate: string }>;
  /** Section keys collapsed via the iw_dash cookie (server-read, Part M). */
  collapsed: ReadonlySet<string>;
  now: Date;
  orgName: string;
  roleLabel: string;
};

/** What every layer needs. */
export type LayerProps = Pick<
  AdaptiveProps,
  "t" | "locale" | "orgId" | "currency" | "timezone" | "vars" | "view" | "extras" | "collapsed"
>;

function ItemRow({
  t,
  locale,
  item,
  vars,
}: {
  t: Translator;
  locale: Locale;
  item: DashboardItem;
  vars: Record<string, string>;
}) {
  const blueprintWhy = item.blueprintWhy
    ? (locale === "ar" ? item.blueprintWhy.ar : item.blueprintWhy.en) || null
    : null;
  return (
    <li>
      <Link
        href={item.href}
        className="flex min-h-11 items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5 hover:border-line-strong hover:bg-sunken"
      >
        <span
          aria-hidden
          className={`mt-0.5 size-2 shrink-0 self-start rounded-full ${
            item.severity === "critical"
              ? "bg-danger"
              : item.severity === "warning"
                ? "bg-warning"
                : "bg-info"
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-ink">
              {t(item.titleKey, { ...vars, ...item.vars })}
            </span>
            {item.kind === "decision" ? (
              <Badge tone="brand">{t("dashboard.adaptive.decision")}</Badge>
            ) : null}
            <Badge tone={SEV_TONE[item.severity]}>
              {t(`exceptions.severity.${item.severity}`)}
            </Badge>
            {!item.canAct ? (
              <span className="text-xs text-ink-muted">{t("dashboard.adaptive.view_only")}</span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-xs text-ink-muted">
            {t(item.whyKey, { ...vars, ...item.whyVars })}
            {blueprintWhy ? ` ${t("dashboard.adaptive.org_why", { reason: blueprintWhy })}` : ""}
          </span>
        </span>
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="size-4 shrink-0 text-ink-muted rtl:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Link>
    </li>
  );
}

function sectionProps(p: LayerProps, key: string, title: string) {
  return {
    orgId: p.orgId,
    sectionKey: key,
    title,
    initiallyCollapsed: p.collapsed.has(`${p.orgId}:${key}`),
    collapseLabel: p.t("dashboard.adaptive.collapse", { section: title }),
    expandLabel: p.t("dashboard.adaptive.expand", { section: title }),
  };
}

/** 1 — Needs your attention (mandatory; never collapsible). */
export function AttentionSection(p: LayerProps) {
  const { t, locale, vars, view } = p;
  return (
    <section aria-labelledby="dash-attention-h" className="flex flex-col gap-2">
      <h2 id="dash-attention-h" className="text-sm font-semibold tracking-wide text-ink">
        {t("dashboard.adaptive.attention_title")}
      </h2>
      {view.attention.length === 0 ? (
        <div className="rounded-lg border border-line bg-card px-4 py-5">
          <p className="text-sm font-medium text-ink">{t("dashboard.adaptive.all_clear")}</p>
          <p className="mt-1 text-xs text-ink-muted">{t("dashboard.adaptive.all_clear_hint")}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {view.attention.map((item) => (
            <ItemRow key={item.key} t={t} locale={locale} item={item} vars={vars} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** 2 — Next (approaching within the blueprint's horizon). */
export function NextSection(p: LayerProps) {
  const { t, locale, vars, view } = p;
  if (view.next.length === 0) return null;
  return (
    <AdaptiveSection {...sectionProps(p, "next", t("dashboard.adaptive.next_title"))}>
      <ul className="flex flex-col gap-2">
        {view.next.map((item) => (
          <ItemRow key={item.key} t={t} locale={locale} item={item} vars={vars} />
        ))}
      </ul>
    </AdaptiveSection>
  );
}

/** 3 — Business pulse (real totals; zero is zero, unavailable says so). */
export function PulseSection(p: LayerProps) {
  const { t, locale, vars, view, currency } = p;
  if (view.pulse.length === 0) return null;
  return (
    <AdaptiveSection {...sectionProps(p, "pulse", t("dashboard.adaptive.pulse_title"))}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {view.pulse.map((m) => (
          <Link
            key={m.key}
            href={m.href}
            className="flex min-h-11 flex-col gap-0.5 rounded-lg border border-line bg-card p-3 hover:border-line-strong hover:bg-sunken"
          >
            <span className="text-xs text-ink-muted">{t(m.labelKey, vars)}</span>
            <span dir="ltr" className="font-mono text-lg font-semibold text-ink">
              {m.unavailable || m.value === null
                ? t("dashboard.adaptive.unavailable_value")
                : m.money
                  ? formatMoney(m.value, currency, { locale })
                  : String(m.value)}
            </span>
            <span className="text-[11px] leading-4 text-ink-muted">
              {t(m.periodKey)}
              {m.deltaPrev !== undefined && m.value !== null
                ? ` · ${t("dashboard.adaptive.prev_period", { count: m.deltaPrev })}`
                : ""}
            </span>
          </Link>
        ))}
      </div>
    </AdaptiveSection>
  );
}

/** 4 — In progress. `force` renders the layer even when the composition would
 * have left it out, because the person chose it as a widget. */
export function ProgressSection(
  p: LayerProps & {
    myJobs: AdaptiveProps["myJobs"];
    returnedReports: AdaptiveProps["returnedReports"];
    force?: boolean;
  },
) {
  const { t, locale, orgId, vars, view, extras } = p;
  const showStages = view.showStages && !!extras?.stageDist;
  const showMyJobs = view.showMyJobs || (p.force === true && p.myJobs.length > 0);
  if (!showStages && !showMyJobs && !p.force) return null;
  return (
    <AdaptiveSection {...sectionProps(p, "progress", t("dashboard.adaptive.progress_title"))}>
      {showStages && extras?.stageDist ? (
        <SectionCard
          title={t("dashboard.stage_dist", vars)}
          viewAllHref={`/o/${orgId}/jobs`}
          viewAllLabel={t("dashboard.view_all")}
        >
          <DistributionBar
            data={extras.stageDist.map((slice): DistributionDatum => ({
              key: slice.key,
              label:
                slice.key === "_none"
                  ? t("dashboard.stage_none")
                  : (locale === "ar" ? slice.name?.ar : slice.name?.en) ||
                    slice.name?.en ||
                    t("dashboard.stage_none"),
              value: slice.count,
              href:
                slice.key === "_none"
                  ? `/o/${orgId}/jobs`
                  : `/o/${orgId}/jobs?stage=${encodeURIComponent(slice.key)}`,
            }))}
            title={t("dashboard.stage_dist", vars)}
          />
        </SectionCard>
      ) : null}
      {showMyJobs ? (
        <>
          <SectionCard
            title={t("dashboard.adaptive.my_jobs", vars)}
            viewAllHref={`/o/${orgId}/jobs`}
            viewAllLabel={t("dashboard.view_all")}
          >
            <RowList
              rows={p.myJobs.map((j): ListRow => ({
                key: j.id,
                title: `${j.reference} ${j.name}`,
                href: `/o/${orgId}/jobs/${j.id}`,
                meta: j.lastReport
                  ? formatDate(j.lastReport, { locale })
                  : t("dashboard.no_report_yet"),
                metaLtr: !!j.lastReport,
              }))}
              emptyLabel={t("dashboard.adaptive.nothing_here")}
            />
          </SectionCard>
          {p.returnedReports.length > 0 ? (
            <SectionCard
              id="returned"
              className="scroll-mt-20"
              title={t("dashboard.adaptive.returned_title", vars)}
            >
              <RowList
                rows={p.returnedReports.map((r): ListRow => ({
                  key: r.id,
                  title: r.reference,
                  href: `/o/${orgId}/reports/${r.id}`,
                  meta: formatDate(r.reportDate, { locale }),
                  metaLtr: true,
                  badge: { label: t("dashboard.returned"), tone: "warning" as const },
                }))}
                emptyLabel={t("dashboard.adaptive.nothing_here")}
              />
            </SectionCard>
          ) : null}
        </>
      ) : null}
      {!showStages && !showMyJobs ? (
        <p className="text-sm text-ink-muted">{t("dashboard.adaptive.nothing_here")}</p>
      ) : null}
    </AdaptiveSection>
  );
}

/** 5 — Recently changed (already permission-scoped by the service). */
export function RecentSection(p: LayerProps & { force?: boolean }) {
  const { t, locale, timezone, view, extras } = p;
  if (!extras) return null;
  if (!view.showActivity && !p.force) return null;
  return (
    <AdaptiveSection {...sectionProps(p, "recent", t("dashboard.adaptive.recent_title"))}>
      <SectionCard title={t("dashboard.activity")}>
        <ActivityTimeline
          entries={extras.activity.map((e) => ({
            key: e.id,
            summary: e.summary,
            when: formatDate(e.createdAt, { locale, timeZone: timezone ?? undefined }),
            actor: e.actorName,
          }))}
          emptyLabel={t("dashboard.activity_empty")}
        />
      </SectionCard>
    </AdaptiveSection>
  );
}

/** The calm header: org day + role; no hero, no greeting. */
export function AdaptiveHeader(p: {
  t: Translator;
  locale: Locale;
  timezone: string | null;
  now: Date;
  roleLabel: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h1 className="text-xl font-semibold text-ink">{p.t("today.title")}</h1>
      <p className="text-xs text-ink-muted">
        {formatDate(p.now, { locale: p.locale, timeZone: p.timezone ?? undefined })}
        {" · "}
        {p.roleLabel}
      </p>
    </div>
  );
}

export function UnavailableNotice(p: {
  t: Translator;
  locale: Locale;
  view: AdaptiveDashboardView;
}) {
  if (p.view.unavailable.length === 0) return null;
  return (
    <p role="status" className="rounded-md bg-warning-soft p-3 text-sm text-warning">
      {p.t("dashboard.adaptive.unavailable", {
        sources: p.view.unavailable
          .map((s) => p.t(`dashboard.source.${s}`))
          .join(p.locale === "ar" ? "، " : ", "),
      })}
    </p>
  );
}

/** The fixed five-layer arrangement (kept for the tests and as the reference). */
export function AdaptiveDashboard(p: AdaptiveProps) {
  return (
    <div className="flex flex-col gap-5">
      <AdaptiveHeader
        t={p.t}
        locale={p.locale}
        timezone={p.timezone}
        now={p.now}
        roleLabel={p.roleLabel}
      />
      <UnavailableNotice t={p.t} locale={p.locale} view={p.view} />
      <AttentionSection {...p} />
      <NextSection {...p} />
      <PulseSection {...p} />
      <ProgressSection {...p} />
      <RecentSection {...p} />
    </div>
  );
}
