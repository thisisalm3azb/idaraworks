import Link from "next/link";
import { Badge, Button, Card, CardHeader, EmptyState, Pager } from "@/platform/ui";
import { can } from "@/platform/authz";
import { formatDate } from "@/platform/format";
import { listMembers } from "@/platform/auth/identity";
import { successOverview } from "@/modules/crm/service";
import { pageOffset, resolveRevenue, tabLabels, withParam } from "../shared";
import { RevenueTabs } from "../RevenueTabs";

const LIMIT = 50;
const input = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-sm text-ink";
const field = "flex flex-col gap-1 text-xs text-ink-muted";

/**
 * H27 — customer success: every active customer with an evidence-based
 * health band, the at-risk and renewal counts across the whole set, paged
 * from the database. A score never pretends: facts the role cannot see are
 * "unknown", and the band says so.
 */
export default async function SuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { resolved, t, locale } = await resolveRevenue(orgId, "customers.view");
  const { page, offset } = pageOffset(sp.page, LIMIT);
  const [overview, members] = await Promise.all([
    successOverview(resolved.ctx, resolved.archetype, {
      band: sp.band || "all",
      search: sp.q || undefined,
      ownerUserId: sp.owner || null,
      limit: LIMIT,
      offset,
    }),
    can(resolved.archetype, "members.view")
      ? listMembers(resolved.ctx, resolved.archetype)
      : Promise.resolve([]),
  ]);
  const base = { ...sp, page: undefined };
  const hrefFor = (p: number) => `/o/${orgId}/revenue/success${withParam(base, "page", p)}`;
  const tone = (b: string) =>
    b === "healthy"
      ? "success"
      : b === "watch"
        ? "warning"
        : b === "at_risk"
          ? "danger"
          : "neutral";

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("revenue.success.title")}</h1>
        <RevenueTabs
          orgId={orgId}
          active="success"
          archetype={resolved.archetype}
          labels={tabLabels(t)}
        />
      </header>

      <section
        className="grid grid-cols-2 gap-2 lg:grid-cols-5"
        aria-label={t("revenue.health.title")}
      >
        {(
          [
            ["at_risk", overview.counts.atRisk],
            ["watch", overview.counts.watch],
            ["healthy", overview.counts.healthy],
            ["unknown", overview.counts.unknown],
          ] as const
        ).map(([band, n]) => (
          <Link
            key={band}
            href={`/o/${orgId}/revenue/success?band=${band}`}
            className="flex flex-col gap-0.5 rounded-lg border border-line bg-card p-3 hover:bg-sunken"
          >
            <span className="text-xs text-ink-muted">{t(`revenue.health.band.${band}`)}</span>
            <span className="text-lg font-semibold text-ink" dir="ltr">
              {n}
            </span>
          </Link>
        ))}
        <div className="flex flex-col gap-0.5 rounded-lg border border-line bg-card p-3">
          <span className="text-xs text-ink-muted">{t("revenue.success.renewals_90")}</span>
          <span className="text-lg font-semibold text-ink" dir="ltr">
            {overview.counts.renewalsDue90}
          </span>
        </div>
      </section>

      <Card>
        <form method="get" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <label className={field}>
            {t("revenue.health.title")}
            <select name="band" defaultValue={sp.band ?? "all"} className={input}>
              <option value="all">{t("common.all")}</option>
              {(["at_risk", "watch", "healthy", "unknown"] as const).map((b) => (
                <option key={b} value={b}>
                  {t(`revenue.health.band.${b}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("revenue.filter.search")}
            <input name="q" defaultValue={sp.q ?? ""} className={input} />
          </label>
          {members.length > 0 ? (
            <label className={field}>
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
          <div className="flex items-end gap-2">
            <Button type="submit">{t("common.apply")}</Button>
            <Link
              href={`/o/${orgId}/revenue/success`}
              className="text-sm text-ink-secondary hover:underline"
            >
              {t("common.clear")}
            </Link>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          title={t("revenue.success.customers")}
          meta={<Badge tone="brand">{t("revenue.success.total", { n: overview.total })}</Badge>}
        />
        <p className="mb-2 text-xs text-ink-muted">{t("revenue.health.hint")}</p>
        {overview.rows.length === 0 ? (
          <EmptyState title={t("revenue.success.none")} />
        ) : (
          <ul className="flex flex-col gap-2">
            {overview.rows.map((c) => (
              <li
                key={c.id}
                className="flex flex-col gap-1 rounded-md border border-line p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    href={`/o/${orgId}/revenue/customers/${c.id}`}
                    className="font-medium text-ink hover:underline"
                  >
                    {c.name}
                  </Link>
                  <span className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge tone={tone(c.health.band)}>
                      {t(`revenue.health.band.${c.health.band}`)}
                      {c.health.score !== null ? ` · ${c.health.score}` : ""}
                    </Badge>
                    {c.renewalsDue90 > 0 ? (
                      <Badge tone="warning">
                        {t("revenue.success.renewals", { n: c.renewalsDue90 })}
                      </Badge>
                    ) : null}
                    {c.ownerName ? <span className="text-ink-muted">{c.ownerName}</span> : null}
                  </span>
                </div>
                <p className="flex flex-wrap gap-x-3 text-xs text-ink-muted">
                  <span>
                    {c.openOpportunities} {t("revenue.kpi.open")}
                  </span>
                  {c.overdueInvoices !== null ? (
                    <span className={c.overdueInvoices > 0 ? "text-danger" : ""}>
                      {c.overdueInvoices} {t("revenue.success.overdue_invoices")}
                    </span>
                  ) : null}
                  {c.openIssues !== null ? (
                    <span>
                      {c.openIssues} {t("revenue.customer.issues")}
                    </span>
                  ) : null}
                  {c.satisfaction !== null ? (
                    <span>
                      {t("revenue.signal.satisfaction")} {c.satisfaction}/5
                    </span>
                  ) : null}
                  {c.churnRisk !== null ? (
                    <span className={c.churnRisk >= 60 ? "text-danger" : ""}>
                      {t("revenue.signal.churn_risk")} {c.churnRisk}
                    </span>
                  ) : null}
                  <span dir="ltr">
                    {t("revenue.success.last_activity")}{" "}
                    {c.lastActivityAt ? formatDate(c.lastActivityAt.slice(0, 10), { locale }) : "—"}
                  </span>
                </p>
                <details>
                  <summary className="cursor-pointer text-xs text-brand">
                    {t("revenue.health.evidence")}
                  </summary>
                  <ul className="mt-1 grid grid-cols-1 gap-0.5 text-xs sm:grid-cols-2">
                    {c.health.signals.map((s) => (
                      <li key={s.key} className="flex justify-between gap-2">
                        <span className="text-ink">{s.label}</span>
                        <span
                          className={
                            s.value === null
                              ? "text-ink-muted"
                              : s.value < 0
                                ? "text-danger"
                                : "text-success"
                          }
                        >
                          {s.value === null ? t("revenue.health.unknown") : s.evidence}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Pager
        page={page}
        hasMore={offset + overview.rows.length < overview.total}
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
