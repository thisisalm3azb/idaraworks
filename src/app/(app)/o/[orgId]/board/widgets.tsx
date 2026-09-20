import type { ReactNode } from "react";
import { Badge, buildQuickCreate } from "@/platform/ui";
import {
  ActivityTimeline,
  KpiCard,
  QuickActions,
  RowList,
  SectionCard,
  type ListRow,
} from "@/platform/ui/dashboard";
import { can } from "@/platform/authz";
import { logger } from "@/platform/logger";
import { formatDate, formatMoney } from "@/platform/format";
import type { Translator } from "@/platform/i18n/server";
import type { CurrencyCode, Locale, RoleArchetype } from "@/platform/registries";
import type { Ctx } from "@/platform/tenancy";
import { quickCreateAllowedByBlueprint, type WorkspaceModuleKey } from "@/platform/workspace";
import {
  WIDGETS,
  jobsHref,
  myWorkHref,
  quotesHref,
  type AdaptiveDashboardView,
  type DashboardData,
  type WidgetKey,
} from "@/modules/dashboard/service";
import {
  MY_WORK_BUCKETS,
  getMyWork,
  workDashboardCounts,
  type WorkDashboardCounts,
} from "@/modules/jobs/service";
import { listInbox, type InboxRow } from "@/modules/approvals/service";
import { computeAR, type ARSummary } from "@/modules/invoices/service";
import { listQuotes } from "@/modules/quotes/service";
import { attentionFeed as stockAttentionFeed } from "@/modules/inventory/service";
import { hrAttentionFeed } from "@/modules/hr/service";
import { getDashboardExtras, type DashboardExtras } from "@/modules/today/service";
import { AttentionSection, NextSection, ProgressSection, PulseSection } from "../adaptive";

/**
 * The widgets, rendered on the server for the keys a layout actually shows.
 *
 * ── Two laws ────────────────────────────────────────────────────────────────
 * 1. Permission is checked HERE, per widget, before any data is read, and
 *    again inside every service call (each asserts its own action). The
 *    stored layout chose the widget; it never chose what the person may see.
 * 2. Only selected widgets fetch. Data the page already holds (the adaptive
 *    gather, or the legacy composition's reads) is handed in and reused; a
 *    focused widget reads its own service only when nothing was handed in.
 *    A widget the person hid costs nothing.
 *
 * A widget that fails renders as unavailable in its own card. It never takes
 * the dashboard down with it, and it never renders a zero in place of an
 * answer it does not have.
 */

export type BoardInputs = {
  t: Translator;
  locale: Locale;
  orgId: string;
  ctx: Ctx;
  archetype: RoleArchetype;
  currency: CurrencyCode;
  timezone: string | null;
  vars: Record<string, string>;
  asOf: string;
  horizonDays: number;
  features: Record<string, boolean>;
  disabledModules: ReadonlySet<string>;
  /** The blueprint composition, when any adaptive layer is shown. */
  adaptive: { view: AdaptiveDashboardView; data: DashboardData } | null;
  /** The aggregates the page already read, if it did. */
  extras: DashboardExtras | null;
  prefetched?: {
    inbox?: InboxRow[] | null;
    ar?: ARSummary | null;
    work?: WorkDashboardCounts | null;
  };
  collapsed: ReadonlySet<string>;
  now: Date;
};

/** The widgets that need the adaptive composition, so the page knows whether to gather. */
export const ADAPTIVE_WIDGETS: ReadonlySet<WidgetKey> = new Set([
  "attention",
  "next",
  "pulse",
  "progress",
  "recent_activity",
]);

export async function renderWidgets(
  keys: readonly WidgetKey[],
  inp: BoardInputs,
): Promise<Partial<Record<WidgetKey, ReactNode>>> {
  const out: Partial<Record<WidgetKey, ReactNode>> = {};
  await Promise.all(
    keys.map(async (key) => {
      // The registry's permission, re-checked at the point of reading.
      if (!can(inp.archetype, WIDGETS[key].action)) return;
      try {
        out[key] = await renderOne(key, inp);
      } catch (err) {
        logger.error({ err, widget: key, orgId: inp.orgId }, "dashboard: widget failed");
        out[key] = (
          <SectionCard title={inp.t(`dash.widget.${key}`, inp.vars)}>
            <p role="status" className="text-sm text-ink-muted">
              {inp.t("dash.widget.unavailable")}
            </p>
          </SectionCard>
        );
      }
    }),
  );
  return out;
}

async function renderOne(key: WidgetKey, inp: BoardInputs): Promise<ReactNode> {
  const { t, locale, orgId, ctx, archetype, vars } = inp;
  const title = t(`dash.widget.${key}`, vars);
  const viewAll = t("dashboard.view_all");
  const nothing = t("dashboard.adaptive.nothing_here");

  switch (key) {
    // The page renders this one itself: it is the composition it already built.
    case "classic":
      return null;

    case "attention":
    case "next":
    case "pulse":
    case "progress": {
      const ad = inp.adaptive;
      if (!ad) return null;
      const common = {
        t,
        locale,
        orgId,
        currency: inp.currency,
        timezone: inp.timezone,
        vars,
        view: ad.view,
        extras: inp.extras,
        collapsed: inp.collapsed,
      };
      if (key === "attention") return <AttentionSection {...common} />;
      if (key === "next") return <NextSection {...common} />;
      if (key === "pulse") return <PulseSection {...common} />;
      return (
        <ProgressSection
          {...common}
          myJobs={ad.data.myJobs ?? []}
          returnedReports={ad.data.returnedReports ?? []}
          force
        />
      );
    }

    case "recent_activity": {
      const extras =
        inp.extras ??
        (await getDashboardExtras(ctx, archetype, {
          asOf: inp.asOf,
          computedAt: inp.now.toISOString(),
        }));
      return (
        <SectionCard title={title}>
          <ActivityTimeline
            entries={extras.activity.map((e) => ({
              key: e.id,
              summary: e.summary,
              when: formatDate(e.createdAt, { locale, timeZone: inp.timezone ?? undefined }),
              actor: e.actorName,
            }))}
            emptyLabel={t("dashboard.activity_empty")}
          />
        </SectionCard>
      );
    }

    case "my_tasks": {
      const view = await getMyWork(ctx, archetype, {
        asOf: inp.asOf,
        horizonDays: inp.horizonDays,
      });
      const rows: ListRow[] = [];
      for (const b of MY_WORK_BUCKETS) {
        if (b === "approvals") continue;
        for (const task of view.buckets[b].rows) {
          if (rows.length >= 6) break;
          rows.push({
            key: task.id,
            title: `${task.jobReference} ${task.title}`,
            href: `/o/${orgId}/jobs/${task.jobId}?tab=tasks`,
            meta: task.dueDate ? formatDate(task.dueDate, { locale }) : undefined,
            metaLtr: !!task.dueDate,
            badge: {
              label: t(`my_work.focus.${b}`),
              tone: b === "overdue" ? "danger" : b === "blocked" ? "warning" : "info",
            },
          });
        }
      }
      return (
        <SectionCard title={title} viewAllHref={myWorkHref(orgId)} viewAllLabel={viewAll}>
          <RowList rows={rows} emptyLabel={t("my_work.empty.now")} />
        </SectionCard>
      );
    }

    case "approvals": {
      const inbox = inp.prefetched?.inbox ?? (await listInbox(ctx, archetype));
      const rows: ListRow[] = inbox.slice(0, 6).map((r) => ({
        key: r.id,
        title: r.title,
        href: `/o/${orgId}/approvals`,
        meta: r.jobRef ?? formatDate(r.createdAt, { locale }),
        metaLtr: true,
      }));
      return (
        <SectionCard
          title={title}
          meta={<span className="font-mono text-xs text-ink-muted">{inbox.length}</span>}
          viewAllHref={`/o/${orgId}/approvals`}
          viewAllLabel={viewAll}
        >
          <RowList rows={rows} emptyLabel={t("approvals.inbox_empty")} />
        </SectionCard>
      );
    }

    case "active_work": {
      const counts =
        inp.prefetched?.work ??
        (await workDashboardCounts(ctx, archetype, {
          asOf: inp.asOf,
          horizonDays: inp.horizonDays,
        }));
      return (
        <SectionCard title={title}>
          <div className="grid grid-cols-3 gap-2">
            <KpiCard
              label={t("dash.kpi.active", vars)}
              value={String(counts.activeWork)}
              href={jobsHref(orgId)}
            />
            <KpiCard
              label={t("dash.kpi.due_soon")}
              value={String(counts.workDueSoon)}
              href={jobsHref(orgId, { filter: "due_soon", days: inp.horizonDays })}
              tone={counts.workDueSoon > 0 ? "warning" : "neutral"}
            />
            <KpiCard
              label={t("dashboard.overdue")}
              value={String(counts.overdueWork)}
              href={jobsHref(orgId, { filter: "overdue" })}
              tone={counts.overdueWork > 0 ? "danger" : "neutral"}
            />
          </div>
        </SectionCard>
      );
    }

    case "quotes_awaiting": {
      const quotes = await listQuotes(ctx, archetype, { limit: 100 });
      const awaiting = quotes.filter(
        (q) => q.status === "draft" || q.status === "pending_approval",
      );
      const rows: ListRow[] = awaiting.slice(0, 5).map((q) => ({
        key: q.id,
        title: q.customerName ? `${q.reference} · ${q.customerName}` : q.reference,
        href: `/o/${orgId}/quotes/${q.id}`,
        badge: { label: t(`quotes.status.${q.status}`), tone: "brand" },
      }));
      return (
        <SectionCard
          title={title}
          meta={<span className="font-mono text-xs text-ink-muted">{awaiting.length}</span>}
          viewAllHref={quotesHref(orgId, true)}
          viewAllLabel={viewAll}
        >
          <RowList rows={rows} emptyLabel={nothing} />
        </SectionCard>
      );
    }

    case "receivables": {
      const ar = inp.prefetched?.ar ?? (await computeAR(ctx, archetype, inp.asOf));
      const money = (v: number | null) =>
        v === null
          ? t("dashboard.adaptive.unavailable_value")
          : formatMoney(v, inp.currency, { locale });
      return (
        <SectionCard title={title} viewAllHref={`/o/${orgId}/ar`} viewAllLabel={viewAll}>
          <div className="grid grid-cols-2 gap-2">
            <KpiCard
              label={t("ar.outstanding")}
              value={money(ar.outstandingMinor)}
              href={`/o/${orgId}/ar`}
            />
            <KpiCard
              label={t("dash.kpi.over_90")}
              value={money(ar.over90)}
              href={`/o/${orgId}/ar`}
              tone={(ar.over90 ?? 0) > 0 ? "danger" : "neutral"}
            />
          </div>
        </SectionCard>
      );
    }

    case "stock_alerts": {
      const feed = await stockAttentionFeed(ctx, archetype, { withinDays: 30 });
      const rows: ListRow[] = feed.items.slice(0, 6).map((item, i) => {
        const name = item.name
          ? locale === "ar"
            ? (item.name.ar ?? item.name.en)
            : item.name.en
          : "";
        const v = { ...item.vars, name, date: item.on ? formatDate(item.on, { locale }) : "" };
        return {
          key: `${item.kind}:${item.entityId}:${i}`,
          title: t(`inbox.attn.${item.kind}.title`, v),
          href:
            item.entityType === "asset"
              ? `/o/${orgId}/assets/${item.entityId}`
              : `/o/${orgId}/stock/${item.entityId}`,
          badge: {
            label: t(`inbox.severity_${item.severity}`),
            tone: item.severity === "urgent" ? "danger" : "warning",
          },
        };
      });
      return (
        <SectionCard title={title} viewAllHref={`/o/${orgId}/inbox`} viewAllLabel={viewAll}>
          <RowList rows={rows} emptyLabel={nothing} />
          {feed.truncated ? <Badge tone="neutral">{t("dash.widget.truncated")}</Badge> : null}
        </SectionCard>
      );
    }

    case "team_actions": {
      const feed = await hrAttentionFeed(ctx, archetype, { withinDays: 30 });
      const rows: ListRow[] = feed.items.slice(0, 6).map((item, i) => {
        const name = item.name
          ? locale === "ar"
            ? (item.name.ar ?? item.name.en)
            : item.name.en
          : "";
        const v = { ...item.vars, name, date: item.on ? formatDate(item.on, { locale }) : "" };
        return {
          key: `${item.kind}:${item.entityId}:${i}`,
          title: t(`inbox.attn.${item.kind}.title`, v),
          href:
            item.entityType === "pay_run"
              ? `/o/${orgId}/payroll/${item.entityId}`
              : `/o/${orgId}/people`,
          badge: {
            label: t(`inbox.severity_${item.severity}`),
            tone: item.severity === "urgent" ? "danger" : "warning",
          },
        };
      });
      return (
        <SectionCard title={title} viewAllHref={`/o/${orgId}/inbox`} viewAllLabel={viewAll}>
          <RowList rows={rows} emptyLabel={nothing} />
        </SectionCard>
      );
    }

    case "quick_actions": {
      const disabled = inp.disabledModules as ReadonlySet<WorkspaceModuleKey>;
      const actions = buildQuickCreate({ orgId, archetype, features: inp.features })
        .filter((q) => quickCreateAllowedByBlueprint(q.key, disabled))
        .map((q) => ({ key: q.key, label: t(q.labelKey, vars), href: q.href, icon: q.icon }));
      return (
        <SectionCard title={title}>
          {actions.length === 0 ? (
            <p className="text-sm text-ink-muted">{nothing}</p>
          ) : (
            <QuickActions actions={actions} />
          )}
        </SectionCard>
      );
    }
  }
}
