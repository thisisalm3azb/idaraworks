import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Badge, Button, Card, CardHeader, Field } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import {
  getOpportunity,
  listPipelineStages,
  listSalesActivities,
  LOSS_REASONS,
  USER_ACTIVITY_KINDS,
} from "@/modules/crm/service";
import { listCustomers } from "@/modules/masters/service";
import { orgToday } from "@/modules/dashboard/service";
import {
  loseOpportunityAction,
  moveStageDetailAction,
  oppActivityAction,
  oppFollowUpDoneAction,
  updateOpportunityAction,
  winOpportunityAction,
} from "./actions";

/** H20 — opportunity detail. Forecast value only (never revenue); win is an
 * explicit control or quotation acceptance — never quote creation or send. */
export default async function OpportunityDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; opportunityId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId, opportunityId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "opportunities.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const seesPrice = resolved.ctx.pricePrivileged;
  const currency = resolved.baseCurrency as CurrencyCode;

  const opp = await getOpportunity(resolved.ctx, resolved.archetype, opportunityId);
  if (!opp) notFound();
  const [stages, activities] = await Promise.all([
    listPipelineStages(resolved.ctx, resolved.archetype),
    listSalesActivities(resolved.ctx, resolved.archetype, { opportunityId }),
  ]);
  const asOf = orgToday(new Date(), resolved.timezone);
  const canManage = can(resolved.archetype, "opportunities.manage");
  const canQuote = can(resolved.archetype, "quotes.manage");
  const open = opp.status === "open" && !opp.archived;
  const openStages = stages.filter((s) => s.category === "open" && s.active);
  const stageLabel = (key: string) => {
    const s = stages.find((x) => x.key === key);
    return s ? (locale === "ar" ? s.label.ar : s.label.en) : key;
  };

  const save = updateOpportunityAction.bind(null, orgId, opportunityId);
  const move = moveStageDetailAction.bind(null, orgId, opportunityId);
  const win = winOpportunityAction.bind(null, orgId, opportunityId);
  const lose = loseOpportunityAction.bind(null, orgId, opportunityId);
  const addActivity = oppActivityAction.bind(null, orgId, opportunityId);
  const followUpDone = oppFollowUpDoneAction.bind(null, orgId, opportunityId);

  const customers =
    canManage && open
      ? await listCustomers(resolved.ctx, resolved.archetype, { status: "active", limit: 200 })
      : [];

  const selectCls = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm">
        <Link href={`/o/${orgId}/opportunities`} className="text-ink-secondary hover:text-ink">
          {t("opps.back")}
        </Link>
      </div>

      {sp.ok ? (
        <p role="status" className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {sp.ok === "won"
            ? t("opps.marked_won")
            : sp.ok === "lost"
              ? t("opps.marked_lost")
              : t("common.saved")}
        </p>
      ) : null}
      {sp.error ? (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {t("common.action_failed")}
        </p>
      ) : null}

      <Card>
        <CardHeader
          title={opp.name}
          meta={
            <span className="flex flex-wrap items-center gap-2">
              <Badge
                tone={opp.status === "won" ? "success" : opp.status === "lost" ? "neutral" : "info"}
              >
                {opp.status === "open" ? stageLabel(opp.stageKey) : t(`opps.status.${opp.status}`)}
              </Badge>
            </span>
          }
        />
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {opp.customerId ? (
            <div>
              <dt className="text-ink-secondary">{t("opps.field.customer")}</dt>
              <dd>
                <Link
                  href={`/o/${orgId}/customers/${opp.customerId}`}
                  className="text-ink underline underline-offset-2"
                >
                  {opp.customerName}
                </Link>
              </dd>
            </div>
          ) : null}
          {seesPrice ? (
            <div>
              <dt className="text-ink-secondary">{t("opps.field.value")}</dt>
              <dd className="text-ink" dir="ltr">
                {opp.estimatedValueMinor !== null
                  ? formatMoney(opp.estimatedValueMinor, currency, { locale })
                  : t("opps.value_unset")}
              </dd>
            </div>
          ) : null}
          {opp.expectedCloseDate ? (
            <div>
              <dt className="text-ink-secondary">{t("opps.field.close")}</dt>
              <dd className="text-ink" dir="ltr">
                {formatDate(opp.expectedCloseDate, { locale })}
              </dd>
            </div>
          ) : null}
          {opp.probability !== null ? (
            <div>
              <dt className="text-ink-secondary">{t("opps.field.probability")}</dt>
              <dd className="text-ink" dir="ltr">
                {opp.probability}%
              </dd>
            </div>
          ) : null}
          {opp.ownerName ? (
            <div>
              <dt className="text-ink-secondary">{t("leads.field.owner")}</dt>
              <dd className="text-ink">{opp.ownerName}</dd>
            </div>
          ) : null}
          {opp.nextAction ? (
            <div>
              <dt className="text-ink-secondary">{t("opps.field.next_action")}</dt>
              <dd className="text-ink">
                {opp.nextAction}
                {opp.nextActionDue ? (
                  <span className="ms-2 text-xs text-ink-secondary" dir="ltr">
                    {formatDate(opp.nextActionDue, { locale })}
                  </span>
                ) : null}
              </dd>
            </div>
          ) : null}
          {opp.leadId ? (
            <div>
              <dt className="text-ink-secondary">{t("opps.from_lead")}</dt>
              <dd>
                <Link
                  href={`/o/${orgId}/leads/${opp.leadId}`}
                  className="text-ink underline underline-offset-2"
                >
                  {t("opps.view_lead")}
                </Link>
              </dd>
            </div>
          ) : null}
          {opp.status === "lost" && opp.lossReason ? (
            <div>
              <dt className="text-ink-secondary">{t("opps.loss_reason")}</dt>
              <dd className="text-ink">
                {t(`opps.loss.${opp.lossReason}`)}
                {opp.lossNote ? (
                  <span className="ms-2 text-xs text-ink-secondary">{opp.lossNote}</span>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-sm">
          {opp.quoteId ? (
            <Link
              href={`/o/${orgId}/quotes/${opp.quoteId}`}
              className="font-medium text-ink underline underline-offset-2"
            >
              {t("opps.view_quote", { reference: opp.quoteReference ?? "" })}
            </Link>
          ) : null}
          {open && canQuote && opp.customerId && !opp.quoteId ? (
            <Link
              href={`/o/${orgId}/quotes/new?customer=${opp.customerId}&opportunity=${opp.id}`}
              className="inline-flex min-h-11 items-center rounded-md border border-line-strong bg-card px-3 font-medium text-ink hover:bg-sunken"
            >
              {t("opps.create_quote")}
            </Link>
          ) : null}
          {open && canQuote && !opp.customerId ? (
            <span className="text-ink-secondary">{t("opps.quote_needs_customer")}</span>
          ) : null}
        </div>

        {canManage && open ? (
          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <form action={move} className="flex items-end gap-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                {t("opps.stage_label")}
                <select name="stage_key" defaultValue={opp.stageKey} className={selectCls}>
                  {openStages.map((s) => (
                    <option key={s.key} value={s.key}>
                      {locale === "ar" ? s.label.ar : s.label.en}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" variant="secondary">
                {t("opps.move_cta")}
              </Button>
            </form>
            <form action={win}>
              <Button type="submit">{t("opps.win_cta")}</Button>
            </form>
          </div>
        ) : null}

        {canManage && open ? (
          <form
            action={lose}
            className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4"
          >
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              {t("opps.loss_reason")}
              <select name="reason" defaultValue="" required className={selectCls}>
                <option value="" disabled>
                  {t("opps.loss_pick")}
                </option>
                {LOSS_REASONS.map((rk) => (
                  <option key={rk} value={rk}>
                    {t(`opps.loss.${rk}`)}
                  </option>
                ))}
              </select>
            </label>
            <div className="min-w-40 flex-1">
              <Field label={t("opps.loss_note")} name="note" maxLength={1000} />
            </div>
            <Button type="submit" variant="danger">
              {t("opps.lose_cta")}
            </Button>
          </form>
        ) : null}
      </Card>

      {canManage && open ? (
        <Card>
          <CardHeader title={t("opps.edit.title")} />
          <form action={save} className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label={t("opps.field.name")}
                name="name"
                required
                maxLength={160}
                defaultValue={opp.name}
              />
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                {t("opps.field.customer")}
                <select
                  name="customer_id"
                  defaultValue={opp.customerId ?? ""}
                  className={selectCls}
                >
                  <option value="">{t("opps.field.no_customer")}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              {seesPrice ? (
                <Field
                  label={t("opps.field.value")}
                  name="estimated_value"
                  type="number"
                  min={0}
                  step="0.01"
                  defaultValue={
                    opp.estimatedValueMinor !== null
                      ? (opp.estimatedValueMinor / 100).toFixed(2)
                      : ""
                  }
                  hint={t("opps.field.value_hint")}
                />
              ) : null}
              <Field
                label={t("opps.field.close")}
                name="expected_close"
                type="date"
                defaultValue={opp.expectedCloseDate ?? ""}
              />
              <Field
                label={t("opps.field.probability")}
                name="probability"
                type="number"
                min={0}
                max={100}
                defaultValue={opp.probability !== null ? String(opp.probability) : ""}
              />
              <Field
                label={t("opps.field.next_action")}
                name="next_action"
                maxLength={300}
                defaultValue={opp.nextAction ?? ""}
              />
              <Field
                label={t("opps.field.next_action_due")}
                name="next_action_due"
                type="date"
                defaultValue={opp.nextActionDue ?? ""}
              />
            </div>
            <input type="hidden" name="owner_user_id" value={opp.ownerUserId ?? ""} />
            <div>
              <Button type="submit" variant="secondary">
                {t("common.save")}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card>
        <CardHeader title={t("sales.activity.title")} />
        {canManage && open ? (
          <form action={addActivity} className="mb-4 flex flex-col gap-3 border-b border-line pb-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                {t("sales.activity.kind")}
                <select name="kind" defaultValue="note" className={selectCls}>
                  {USER_ACTIVITY_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`sales.kind.${k}`)}
                    </option>
                  ))}
                </select>
              </label>
              <Field
                label={t("sales.activity.due")}
                name="due_date"
                type="date"
                hint={t("sales.activity.due_hint")}
              />
              <div className="flex items-end">
                <Button type="submit" variant="secondary">
                  {t("sales.activity.add")}
                </Button>
              </div>
            </div>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              {t("sales.activity.body")}
              <textarea
                name="body"
                rows={2}
                maxLength={2000}
                className="rounded-md border border-line-strong bg-card px-3 py-2 text-base text-ink"
              />
            </label>
          </form>
        ) : null}
        {activities.length === 0 ? (
          <p className="text-sm text-ink-secondary">{t("sales.activity.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {activities.map((a) => {
              const overdue =
                a.kind === "follow_up" && !a.completedAt && a.dueDate !== null && a.dueDate < asOf;
              const body =
                a.kind === "stage_change" && a.body?.includes("|")
                  ? t("sales.stage_change", {
                      from: stageLabel(a.body.split("|")[0]!),
                      to: stageLabel(a.body.split("|")[1]!),
                    })
                  : a.kind === "lost" && a.body
                    ? t(`opps.loss.${a.body}`)
                    : (a.body ?? "");
              return (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-card px-3 py-2.5 text-sm"
                >
                  <Badge
                    tone={
                      overdue
                        ? "warning"
                        : a.kind === "won"
                          ? "success"
                          : a.kind === "lost"
                            ? "neutral"
                            : "neutral"
                    }
                  >
                    {t(`sales.kind.${a.kind}`)}
                  </Badge>
                  <span className="min-w-0 flex-1 text-ink">{body}</span>
                  {a.dueDate ? (
                    <span className="text-xs text-ink-secondary" dir="ltr">
                      {t("sales.activity.due_on", { date: formatDate(a.dueDate, { locale }) })}
                    </span>
                  ) : null}
                  {a.kind === "follow_up" && a.completedAt ? (
                    <Badge tone="success">{t("sales.activity.done")}</Badge>
                  ) : null}
                  {a.kind === "follow_up" && !a.completedAt && canManage ? (
                    <form action={followUpDone}>
                      <input type="hidden" name="activity_id" value={a.id} />
                      <Button type="submit" variant="ghost">
                        {t("sales.activity.mark_done")}
                      </Button>
                    </form>
                  ) : null}
                  <span className="text-xs text-ink-secondary" dir="ltr">
                    {formatDate(a.createdAt, { locale })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
