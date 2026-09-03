import { revenueStudioEnabled } from "@/platform/flags";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Badge, Card, Pager } from "@/platform/ui";
import { can } from "@/platform/authz";
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { listMembers } from "@/platform/auth/identity";
import {
  boardPage,
  listPipelines,
  listStageSettings,
  STAGE_REQUIREMENTS,
  type StageRequirement,
} from "@/modules/crm/service";
import { localeText, pageOffset, resolveRevenue, tabLabels, withParam } from "../shared";
import { RevenueTabs } from "../RevenueTabs";
import { PipelineBoard, type BoardDict, type BoardStage } from "./PipelineBoard";

const LIMIT = 100;

/**
 * H27 — the pipeline board: columns per stage of the chosen pipeline, cards
 * paged from the database (100 per page), column totals computed across the
 * FULL filtered result, never the page.
 */
export default async function PipelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  if (!revenueStudioEnabled()) notFound(); // page-level gate: layouts and pages render concurrently
  const { orgId } = await params;
  const sp = await searchParams;
  const { resolved, t, locale } = await resolveRevenue(orgId, "opportunities.view");
  const canManage = can(resolved.archetype, "opportunities.manage");
  const seesPrice = resolved.ctx.pricePrivileged;
  const currency = resolved.baseCurrency as CurrencyCode;

  const pipelines = await listPipelines(resolved.ctx, resolved.archetype);
  const pipeline =
    pipelines.find((p) => p.id === sp.pipeline) ??
    pipelines.find((p) => p.isDefault) ??
    pipelines[0];
  const status = (["open", "won", "lost", "all"] as const).includes(sp.status as "open")
    ? (sp.status as "open" | "won" | "lost" | "all")
    : "open";
  const { page, offset } = pageOffset(sp.page, LIMIT);
  const stalledDays = sp.stalled ? Number(sp.stalled) : undefined;
  const [settings, board, members] = await Promise.all([
    listStageSettings(resolved.ctx, resolved.archetype, pipeline?.id || null),
    boardPage(resolved.ctx, resolved.archetype, {
      pipelineId: pipeline?.id || null,
      status,
      search: sp.q || undefined,
      ownerUserId: sp.owner || null,
      forecastCategory: sp.category || null,
      stalledDays: Number.isFinite(stalledDays) ? stalledDays : null,
      sort: sp.sort ?? "close",
      limit: LIMIT,
      offset,
    }),
    can(resolved.archetype, "members.view")
      ? listMembers(resolved.ctx, resolved.archetype)
      : Promise.resolve([]),
  ]);

  const stages: BoardStage[] = settings
    .filter((s) => s.active && (status === "open" ? s.category === "open" : true))
    .sort((a, b) => a.sort - b.sort)
    .map((s) => ({
      key: s.key,
      label: localeText(s.label, locale, s.key),
      category: s.category,
      requirements: s.requirements,
      maxAgeDays: s.maxAgeDays,
    }));

  const requirement = Object.fromEntries(
    STAGE_REQUIREMENTS.map((r) => [r, t(`revenue.requirement.${r}`)]),
  ) as Record<StageRequirement, string>;
  const dict: BoardDict = {
    move: t("revenue.board.move"),
    moveTo: t("revenue.board.move_to"),
    reason: t("revenue.board.reason"),
    reasonHint: t("revenue.board.reason_hint"),
    requirements: t("revenue.board.requirements"),
    unmet: t("revenue.board.unmet"),
    confirm: t("revenue.board.confirm"),
    cancel: t("common.cancel"),
    close: t("common.close"),
    moved: t("revenue.board.moved"),
    conflict: t("revenue.board.conflict"),
    forbidden: t("common.forbidden"),
    failed: t("common.error"),
    state: t("revenue.board.state"),
    selected: t("revenue.board.selected"),
    bulkMove: t("revenue.board.bulk_move"),
    review: t("revenue.board.review"),
    clear: t("revenue.board.clear"),
    cards: t("revenue.board.cards"),
    value: t("revenue.value"),
    weighted: t("revenue.weighted"),
    stalled: t("revenue.stalled"),
    days: t("revenue.days"),
    risks: t("revenue.risks"),
    stakeholders: t("revenue.stakeholders"),
    empty: t("revenue.board.empty"),
    open: t("revenue.status.open"),
    requirement,
    select: t("revenue.board.select"),
  };

  const base = { ...sp, page: undefined };
  const hrefFor = (p: number) => `/o/${orgId}/revenue/pipeline${withParam(base, "page", p)}`;
  const input = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-sm text-ink";
  const money = (n: number | null) =>
    seesPrice && n !== null ? formatMoney(n, currency, { locale }) : t("common.restricted");

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("revenue.pipeline.title")}</h1>
        <RevenueTabs
          orgId={orgId}
          active="pipeline"
          archetype={resolved.archetype}
          labels={tabLabels(t)}
        />
      </header>

      <Card>
        <form method="get" className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            {t("revenue.pipeline.pipeline")}
            <select name="pipeline" defaultValue={pipeline?.id ?? ""} className={input}>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {localeText(p.name, locale, p.key)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            {t("revenue.filter.status")}
            <select name="status" defaultValue={status} className={input}>
              {(["open", "won", "lost", "all"] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`revenue.status.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            {t("revenue.filter.search")}
            <input name="q" defaultValue={sp.q ?? ""} className={input} />
          </label>
          {members.length > 0 ? (
            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              {t("revenue.filter.owner")}
              <select name="owner" defaultValue={sp.owner ?? ""} className={input}>
                <option value="">{t("common.all")}</option>
                {members
                  .filter((m) => !m.deactivatedAt)
                  .map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.fullName}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            {t("revenue.filter.category")}
            <select name="category" defaultValue={sp.category ?? ""} className={input}>
              <option value="">{t("common.all")}</option>
              {(["pipeline", "best_case", "commit", "omitted"] as const).map((c) => (
                <option key={c} value={c}>
                  {t(`revenue.category.${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            {t("revenue.filter.stalled")}
            <select name="stalled" defaultValue={sp.stalled ?? ""} className={input}>
              <option value="">{t("common.all")}</option>
              {[7, 14, 30, 60].map((d) => (
                <option key={d} value={d}>
                  {t("revenue.filter.stalled_days", { n: d })}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2 sm:col-span-3 lg:col-span-6">
            <button
              type="submit"
              className="inline-flex min-h-11 items-center rounded-md bg-brand px-4 text-sm font-medium text-ink-inverse"
            >
              {t("common.apply")}
            </button>
            <Link
              href={`/o/${orgId}/revenue/pipeline`}
              className="inline-flex min-h-11 items-center px-2 text-sm text-ink-secondary hover:underline"
            >
              {t("common.clear")}
            </Link>
            <span className="ms-auto flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <Badge tone="brand">{t("revenue.board.total", { n: board.total })}</Badge>
              {seesPrice ? (
                <span dir="ltr">
                  {t("revenue.value")} {money(board.totals.valueMinor)} · {t("revenue.weighted")}{" "}
                  {money(board.totals.weightedMinor)}
                </span>
              ) : null}
            </span>
          </div>
        </form>
      </Card>

      <PipelineBoard
        orgId={orgId}
        stages={stages}
        cards={board.rows}
        aggregates={board.stages}
        canManage={canManage}
        seesPrice={seesPrice}
        currency={currency}
        locale={locale}
        dict={dict}
      />

      <Pager
        page={page}
        hasMore={offset + board.rows.length < board.total}
        hrefFor={hrefFor}
        labels={{
          previous: t("common.previous"),
          next: t("common.next"),
          page: t("common.page", { n: page }),
        }}
      />
    </div>
  );
}
