import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState, Field, FilterBar } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { cn } from "@/lib/cn";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { listOpportunities, listPipelineStages, type OpportunityRow } from "@/modules/crm/service";
import { listCustomers } from "@/modules/masters/service";
import { opportunitiesHref, orgToday, parseOpportunitiesSearch } from "@/modules/dashboard/service";
import { createOpportunityAction, moveStageAction } from "./actions";

/**
 * H20 — the pipeline: a stage-grouped board (default) and a flat list
 * (?view=list). Stage moves post a server action from a per-card select —
 * fully keyboard-accessible, no drag required. Forecast totals render only
 * for price-privileged users; counts render for everyone with access.
 */
export default async function OpportunitiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{
    view?: string;
    stage?: string;
    owner?: string;
    customer?: string;
    closing?: string;
    focus?: string;
    status?: string;
    ok?: string;
    error?: string;
  }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "opportunities.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const f = parseOpportunitiesSearch(sp);
  const asOf = orgToday(new Date(), resolved.timezone);
  const seesPrice = resolved.ctx.pricePrivileged;
  const currency = resolved.baseCurrency as CurrencyCode;
  const canManage = can(resolved.archetype, "opportunities.manage");

  const stages = await listPipelineStages(resolved.ctx, resolved.archetype);
  const openStages = stages.filter((s) => s.category === "open" && s.active);
  const stageLabel = (key: string) => {
    const s = stages.find((x) => x.key === key);
    return s ? (locale === "ar" ? s.label.ar : s.label.en) : key;
  };

  const filtered = Boolean(
    f.stage || f.owner || f.customerId || f.closing || f.followup || f.status,
  );
  const opps = await listOpportunities(resolved.ctx, resolved.archetype, {
    status: f.status ?? (f.archived ? "all" : f.view === "list" && filtered ? "all" : "open"),
    stageKey: f.stage ?? undefined,
    ownerUserId: f.owner ?? undefined,
    customerId: f.customerId ?? undefined,
    overdue: f.followup ? asOf : undefined,
    closingWithinDays: f.closing ? { asOf, days: f.closing } : undefined,
    archived: f.archived,
  });

  const create = createOpportunityAction.bind(null, orgId);
  const move = moveStageAction.bind(null, orgId);
  const customers = canManage
    ? await listCustomers(resolved.ctx, resolved.archetype, { status: "active", limit: 200 })
    : [];

  const summaryParts: string[] = [];
  if (f.stage) summaryParts.push(t("opps.filter.stage", { stage: stageLabel(f.stage) }));
  if (f.closing) summaryParts.push(t("opps.filter.closing", { days: f.closing }));
  if (f.followup) summaryParts.push(t("opps.filter.followup"));
  if (f.status) summaryParts.push(t(`opps.status.${f.status}`));
  if (f.customerId) {
    const c = opps.find((o) => o.customerId === f.customerId)?.customerName;
    summaryParts.push(t("filters.customer", { name: c ?? t("opps.filter.customer_generic") }));
  }

  const selectCls = "min-h-11 rounded-md border border-line-strong bg-card px-2 text-sm text-ink";
  const backQs = (() => {
    const q = new URLSearchParams();
    if (f.view === "list") q.set("view", "list");
    if (f.stage) q.set("stage", f.stage);
    if (f.closing) q.set("closing", String(f.closing));
    if (f.followup) q.set("focus", "followup");
    if (f.customerId) q.set("customer", f.customerId);
    const s = q.toString();
    return s ? `?${s}` : "";
  })();

  const oppCard = (o: OpportunityRow) => (
    <div
      key={o.id}
      className="flex flex-col gap-1.5 rounded-lg border border-line bg-card px-3 py-2.5"
    >
      <Link
        href={`/o/${orgId}/opportunities/${o.id}`}
        className="min-h-6 text-sm font-medium text-ink hover:underline"
      >
        {o.name}
      </Link>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-secondary">
        {o.customerName ? <span>{o.customerName}</span> : null}
        {seesPrice && o.estimatedValueMinor !== null ? (
          <span dir="ltr" className="font-mono">
            {formatMoney(o.estimatedValueMinor, currency, { locale })}
          </span>
        ) : null}
        {o.expectedCloseDate ? (
          <span dir="ltr">{formatDate(o.expectedCloseDate, { locale })}</span>
        ) : null}
        {o.status !== "open" ? (
          <Badge tone={o.status === "won" ? "success" : "neutral"}>
            {t(`opps.status.${o.status}`)}
          </Badge>
        ) : null}
      </div>
      {canManage && o.status === "open" && !o.archived ? (
        <form action={move} className="flex items-center gap-2">
          <input type="hidden" name="opportunity_id" value={o.id} />
          <input type="hidden" name="back" value={backQs} />
          <label className="sr-only" htmlFor={`stage-${o.id}`}>
            {t("opps.move_label", { name: o.name })}
          </label>
          <select
            id={`stage-${o.id}`}
            name="stage_key"
            defaultValue={o.stageKey}
            className={cn(selectCls, "flex-1")}
          >
            {openStages.map((s) => (
              <option key={s.key} value={s.key}>
                {locale === "ar" ? s.label.ar : s.label.en}
              </option>
            ))}
          </select>
          <Button type="submit" variant="ghost">
            {t("opps.move_cta")}
          </Button>
        </form>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={t("opps.title")}
          meta={
            <span className="flex flex-wrap gap-2">
              <Link
                href={opportunitiesHref(orgId, { ...f, view: "board" })}
                aria-current={f.view === "board" ? "true" : undefined}
                className={cn(
                  "inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium",
                  f.view === "board"
                    ? "border-ink bg-ink text-card"
                    : "border-line bg-card text-ink-secondary",
                )}
              >
                {t("opps.view.board")}
              </Link>
              <Link
                href={opportunitiesHref(orgId, { ...f, view: "list" })}
                aria-current={f.view === "list" ? "true" : undefined}
                className={cn(
                  "inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium",
                  f.view === "list"
                    ? "border-ink bg-ink text-card"
                    : "border-line bg-card text-ink-secondary",
                )}
              >
                {t("opps.view.list")}
              </Link>
            </span>
          }
        />
        {sp.error ? (
          <p role="alert" className="mt-1 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {t("common.action_failed")}
          </p>
        ) : null}
        {sp.ok === "moved" ? (
          <p
            role="status"
            className="mt-1 rounded-md bg-success-soft px-3 py-2 text-sm text-success"
          >
            {t("opps.moved")}
          </p>
        ) : null}
      </Card>

      {filtered ? (
        <FilterBar
          summary={summaryParts.join(" · ")}
          countLabel={t("filters.count", { count: opps.length })}
          clearHref={opportunitiesHref(orgId, { view: f.view })}
          clearLabel={t("jobs.filter_clear")}
        />
      ) : null}

      {f.view === "board" && !f.archived ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {openStages.map((s) => {
            const inStage = opps.filter((o) => o.stageKey === s.key && o.status === "open");
            const total = seesPrice
              ? inStage.reduce((acc, o) => acc + (o.estimatedValueMinor ?? 0), 0)
              : null;
            return (
              <section key={s.key} aria-label={locale === "ar" ? s.label.ar : s.label.en}>
                <Card className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-ink">
                      {locale === "ar" ? s.label.ar : s.label.en}
                    </h2>
                    <span className="text-xs text-ink-secondary">
                      {t("opps.board.count", { count: inStage.length })}
                      {total !== null && total > 0 ? (
                        <span dir="ltr" className="ms-2 font-mono">
                          {formatMoney(total, currency, { locale })}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  {inStage.length === 0 ? (
                    <p className="text-xs text-ink-secondary">{t("opps.board.empty")}</p>
                  ) : (
                    <div className="flex flex-col gap-2">{inStage.map(oppCard)}</div>
                  )}
                </Card>
              </section>
            );
          })}
        </div>
      ) : (
        <Card>
          {opps.length === 0 ? (
            <EmptyState
              title={t("opps.empty.title")}
              description={filtered ? t("filters.empty") : t("opps.empty.hint")}
            />
          ) : (
            <ul className="divide-y divide-line">
              {opps.map((o) => (
                <li key={o.id}>
                  <Link
                    href={`/o/${orgId}/opportunities/${o.id}`}
                    className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2.5 hover:bg-sunken"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                      {o.name}
                    </span>
                    {o.customerName ? (
                      <span className="text-xs text-ink-secondary">{o.customerName}</span>
                    ) : null}
                    <Badge
                      tone={
                        o.status === "won" ? "success" : o.status === "lost" ? "neutral" : "info"
                      }
                    >
                      {o.status === "open" ? stageLabel(o.stageKey) : t(`opps.status.${o.status}`)}
                    </Badge>
                    {seesPrice && o.estimatedValueMinor !== null ? (
                      <span dir="ltr" className="font-mono text-xs text-ink">
                        {formatMoney(o.estimatedValueMinor, currency, { locale })}
                      </span>
                    ) : null}
                    {o.expectedCloseDate ? (
                      <span className="text-xs text-ink-secondary" dir="ltr">
                        {formatDate(o.expectedCloseDate, { locale })}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {canManage && !f.archived ? (
        <Card id="add-opportunity">
          <CardHeader title={t("opps.add.title")} meta={t("opps.add.hint")} />
          <form action={create} className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("opps.field.name")} name="name" required maxLength={160} />
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                {t("opps.field.customer")}
                <select
                  name="customer_id"
                  defaultValue=""
                  className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
                >
                  <option value="">{t("opps.field.no_customer")}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <Field
                label={t("opps.field.value")}
                name="estimated_value"
                type="number"
                min={0}
                step="0.01"
                hint={t("opps.field.value_hint")}
              />
              <Field label={t("opps.field.close")} name="expected_close" type="date" />
            </div>
            <div>
              <Button type="submit">{t("opps.add.cta")}</Button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
