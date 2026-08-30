import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Badge, Button, Card, CardHeader, Field } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatDate } from "@/platform/format";
import { getLead, listSalesActivities, USER_ACTIVITY_KINDS } from "@/modules/crm/service";
import { listCustomers } from "@/modules/masters/service";
import { orgToday } from "@/modules/dashboard/service";
import {
  convertLeadAction,
  leadActivityAction,
  leadArchiveAction,
  leadFollowUpDoneAction,
  leadStatusAction,
  updateLeadAction,
} from "./actions";

/** H20 — lead detail: identity, working status, activity history, follow-ups
 * and the conversion into an opportunity (idempotent, evidence-preserving). */
export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; leadId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgId, leadId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "leads.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();

  const lead = await getLead(resolved.ctx, resolved.archetype, leadId);
  if (!lead) notFound();
  const activities = await listSalesActivities(resolved.ctx, resolved.archetype, { leadId });
  const asOf = orgToday(new Date(), resolved.timezone);
  const canManage = can(resolved.archetype, "leads.manage");
  const canConvert = canManage && can(resolved.archetype, "opportunities.manage");
  const working = lead.status !== "converted" && !lead.archived;

  const save = updateLeadAction.bind(null, orgId, leadId);
  const setStatus = leadStatusAction.bind(null, orgId, leadId);
  const archive = leadArchiveAction.bind(null, orgId, leadId);
  const addActivity = leadActivityAction.bind(null, orgId, leadId);
  const followUpDone = leadFollowUpDoneAction.bind(null, orgId, leadId);
  const convert = convertLeadAction.bind(null, orgId, leadId);

  const customers =
    canConvert && working
      ? await listCustomers(resolved.ctx, resolved.archetype, { status: "active", limit: 200 })
      : [];

  const selectCls = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm">
        <Link href={`/o/${orgId}/leads`} className="text-ink-secondary hover:text-ink">
          {t("leads.back")}
        </Link>
      </div>

      {sp.ok ? (
        <p role="status" className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {t("common.saved")}
        </p>
      ) : null}
      {sp.error ? (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {sp.error === "convert" ? t("leads.error.convert") : t("common.action_failed")}
        </p>
      ) : null}

      <Card>
        <CardHeader
          title={lead.name}
          meta={
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={lead.status === "converted" ? "brand" : "info"}>
                {t(`leads.status.${lead.status}`)}
              </Badge>
              {lead.archived ? <Badge tone="neutral">{t("leads.filter.archived")}</Badge> : null}
            </span>
          }
        />
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {lead.contactName ? (
            <div>
              <dt className="text-ink-secondary">{t("leads.field.contact")}</dt>
              <dd className="text-ink">{lead.contactName}</dd>
            </div>
          ) : null}
          {lead.phone ? (
            <div>
              <dt className="text-ink-secondary">{t("common.phone")}</dt>
              <dd className="text-ink" dir="ltr">
                {lead.phone}
              </dd>
            </div>
          ) : null}
          {lead.email ? (
            <div>
              <dt className="text-ink-secondary">{t("common.email")}</dt>
              <dd className="break-all text-ink" dir="ltr">
                {lead.email}
              </dd>
            </div>
          ) : null}
          {lead.source ? (
            <div>
              <dt className="text-ink-secondary">{t("leads.field.source")}</dt>
              <dd className="text-ink">{lead.source}</dd>
            </div>
          ) : null}
          {lead.ownerName ? (
            <div>
              <dt className="text-ink-secondary">{t("leads.field.owner")}</dt>
              <dd className="text-ink">{lead.ownerName}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-ink-secondary">{t("common.created")}</dt>
            <dd className="text-ink" dir="ltr">
              {formatDate(lead.createdAt, { locale })}
            </dd>
          </div>
        </dl>
        {lead.notes ? <p className="mt-3 text-sm text-ink">{lead.notes}</p> : null}

        {lead.status === "converted" ? (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4 text-sm">
            {lead.convertedOpportunityId ? (
              <Link
                href={`/o/${orgId}/opportunities/${lead.convertedOpportunityId}`}
                className="font-medium text-ink underline underline-offset-2"
              >
                {t("leads.view_opportunity")}
              </Link>
            ) : null}
            {lead.convertedCustomerId ? (
              <Link
                href={`/o/${orgId}/customers/${lead.convertedCustomerId}`}
                className="font-medium text-ink underline underline-offset-2"
              >
                {t("leads.view_customer")}
              </Link>
            ) : null}
          </div>
        ) : null}

        {canManage && working ? (
          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4">
            <form action={setStatus} className="flex items-end gap-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                {t("leads.status_label")}
                <select name="status" defaultValue={lead.status} className={selectCls}>
                  {(["new", "contacted", "qualified", "disqualified"] as const).map((s) => (
                    <option key={s} value={s}>
                      {t(`leads.status.${s}`)}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" variant="secondary">
                {t("common.save")}
              </Button>
            </form>
            <form action={archive}>
              <input type="hidden" name="archived" value="1" />
              <Button type="submit" variant="ghost">
                {t("leads.archive")}
              </Button>
            </form>
          </div>
        ) : null}
        {canManage && lead.archived ? (
          <form action={archive} className="mt-4 border-t border-line pt-4">
            <input type="hidden" name="archived" value="0" />
            <Button type="submit" variant="secondary">
              {t("leads.restore")}
            </Button>
          </form>
        ) : null}
      </Card>

      {canManage && working ? (
        <Card>
          <CardHeader title={t("leads.edit.title")} />
          <form action={save} className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label={t("leads.field.name")}
                name="name"
                required
                maxLength={160}
                defaultValue={lead.name}
              />
              <Field
                label={t("leads.field.contact")}
                name="contact_name"
                maxLength={120}
                defaultValue={lead.contactName ?? ""}
              />
              <Field
                label={t("common.phone")}
                name="phone"
                maxLength={32}
                defaultValue={lead.phone ?? ""}
              />
              <Field
                label={t("common.email")}
                name="email"
                type="email"
                maxLength={254}
                defaultValue={lead.email ?? ""}
              />
              <Field
                label={t("leads.field.source")}
                name="source"
                maxLength={80}
                defaultValue={lead.source ?? ""}
              />
            </div>
            <input type="hidden" name="owner_user_id" value={lead.ownerUserId ?? ""} />
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              {t("leads.field.notes")}
              <textarea
                name="notes"
                rows={2}
                maxLength={2000}
                defaultValue={lead.notes ?? ""}
                className="rounded-md border border-line-strong bg-card px-3 py-2 text-base text-ink"
              />
            </label>
            <div>
              <Button type="submit" variant="secondary">
                {t("common.save")}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {canConvert && working ? (
        <Card>
          <CardHeader title={t("leads.convert.title")} meta={t("leads.convert.hint")} />
          <form action={convert} className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label={t("leads.convert.opportunity_name")}
                name="opportunity_name"
                maxLength={160}
                defaultValue={lead.name}
              />
              <Field
                label={t("opps.field.value")}
                name="estimated_value"
                type="number"
                min={0}
                step="0.01"
                hint={t("opps.field.value_hint")}
              />
              <Field label={t("opps.field.close")} name="expected_close" type="date" />
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                {t("leads.convert.customer")}
                <select name="customer_id" defaultValue="" className={selectCls}>
                  <option value="">{t("leads.convert.no_customer")}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                name="create_customer"
                value="1"
                className="size-4 accent-current"
              />
              {t("leads.convert.create_customer")}
            </label>
            <div>
              <Button type="submit">{t("leads.convert.cta")}</Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card>
        <CardHeader title={t("sales.activity.title")} />
        {canManage && working ? (
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
              return (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-card px-3 py-2.5 text-sm"
                >
                  <Badge tone={overdue ? "warning" : "neutral"}>{t(`sales.kind.${a.kind}`)}</Badge>
                  <span className="min-w-0 flex-1 text-ink">{a.body ?? ""}</span>
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
