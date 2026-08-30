import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState, Field } from "@/platform/ui";
import { getT } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { cn } from "@/lib/cn";
import { formatDate } from "@/platform/format";
import { getServerLocale } from "@/platform/i18n/server";
import { listLeads, type LeadStatus } from "@/modules/crm/service";
import { orgToday, parseLeadsSearch, leadsHref } from "@/modules/dashboard/service";
import { createLeadAction } from "./actions";

/**
 * H20 — leads list: potential sales BEFORE a customer, a price or a
 * quotation exists. Search and filters are server-side and URL-backed
 * (shareable, validated by the canonical filter contract).
 */
const STATUS_TONE: Record<
  LeadStatus,
  "neutral" | "info" | "success" | "warning" | "danger" | "brand"
> = {
  new: "info",
  contacted: "neutral",
  qualified: "success",
  disqualified: "neutral",
  converted: "brand",
};

export default async function LeadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{
    q?: string;
    status?: string;
    owner?: string;
    source?: string;
    focus?: string;
    view?: string;
    error?: string;
  }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "leads.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const f = parseLeadsSearch(sp);
  const asOf = orgToday(new Date(), resolved.timezone);

  const leads = await listLeads(resolved.ctx, resolved.archetype, {
    q: f.q ?? undefined,
    status: (f.status as LeadStatus | null) ?? "all",
    ownerUserId: f.owner ?? undefined,
    source: f.source ?? undefined,
    archived: f.archived,
    overdueFollowUp: f.overdue ? asOf : undefined,
  });

  const canManage = can(resolved.archetype, "leads.manage");
  const create = createLeadAction.bind(null, orgId);

  const chip = (label: string, href: string, active: boolean) => (
    <Link
      key={href}
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium",
        active ? "border-ink bg-ink text-card" : "border-line bg-card text-ink-secondary",
      )}
    >
      {label}
    </Link>
  );

  const keep = { q: f.q, owner: f.owner, source: f.source } as const;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("leads.title")} meta={t("leads.subtitle")} />
        <form method="get" className="flex flex-wrap items-end gap-2" role="search">
          {f.status ? <input type="hidden" name="status" value={f.status} /> : null}
          {f.overdue ? <input type="hidden" name="focus" value="overdue" /> : null}
          {f.archived ? <input type="hidden" name="view" value="archived" /> : null}
          <div className="min-w-48 flex-1">
            <Field label={t("common.search")} name="q" defaultValue={f.q ?? ""} maxLength={120} />
          </div>
          <Button type="submit" variant="secondary">
            {t("common.search")}
          </Button>
        </form>
        <div
          className="mt-3 flex flex-wrap gap-2"
          role="group"
          aria-label={t("leads.filter.label")}
        >
          {chip(
            t("leads.filter.all"),
            leadsHref(orgId, keep),
            !f.status && !f.overdue && !f.archived,
          )}
          {(["new", "contacted", "qualified", "disqualified", "converted"] as const).map((s) =>
            chip(t(`leads.status.${s}`), leadsHref(orgId, { ...keep, status: s }), f.status === s),
          )}
          {chip(t("leads.filter.overdue"), leadsHref(orgId, { ...keep, overdue: true }), f.overdue)}
          {chip(
            t("leads.filter.archived"),
            leadsHref(orgId, { ...keep, archived: true }),
            f.archived,
          )}
        </div>
        {sp.error ? (
          <p role="alert" className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {t("leads.error.create")}
          </p>
        ) : null}
      </Card>

      <Card>
        {leads.length === 0 ? (
          <EmptyState
            title={t("leads.empty.title")}
            description={f.q || f.status || f.overdue ? t("filters.empty") : t("leads.empty.hint")}
          />
        ) : (
          <ul className="divide-y divide-line">
            {leads.map((l) => (
              <li key={l.id}>
                <Link
                  href={`/o/${orgId}/leads/${l.id}`}
                  className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2.5 hover:bg-sunken"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                    {l.name}
                  </span>
                  {l.nextFollowUpDue && l.nextFollowUpDue < asOf && !l.archived ? (
                    <Badge tone="warning">{t("leads.followup_overdue")}</Badge>
                  ) : null}
                  {l.source ? <span className="text-xs text-ink-secondary">{l.source}</span> : null}
                  {l.ownerName ? (
                    <span className="text-xs text-ink-secondary">{l.ownerName}</span>
                  ) : null}
                  <Badge tone={STATUS_TONE[l.status]}>{t(`leads.status.${l.status}`)}</Badge>
                  <span className="text-xs text-ink-secondary" dir="ltr">
                    {formatDate(l.createdAt, { locale })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage && !f.archived ? (
        <Card id="add-lead">
          <CardHeader title={t("leads.add.title")} meta={t("leads.add.hint")} />
          <form action={create} className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("leads.field.name")} name="name" required maxLength={160} />
              <Field label={t("leads.field.contact")} name="contact_name" maxLength={120} />
              <Field label={t("common.phone")} name="phone" maxLength={32} />
              <Field label={t("common.email")} name="email" type="email" maxLength={254} />
              <Field label={t("leads.field.source")} name="source" maxLength={80} />
            </div>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              {t("leads.field.notes")}
              <textarea
                name="notes"
                rows={2}
                maxLength={2000}
                className="rounded-md border border-line-strong bg-card px-3 py-2 text-base text-ink"
              />
            </label>
            <div>
              <Button type="submit">{t("leads.add.cta")}</Button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
