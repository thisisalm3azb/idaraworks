import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Card, CardHeader, EmptyState, FilterBar } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import { computeAR, listOutstandingInvoices } from "@/modules/invoices/service";
import { arHref, orgToday, parseArSearch, type ArView } from "@/modules/dashboard/service";

/**
 * H18 — receivables drill-down. The summary numbers and the invoice list
 * come from the SAME derivation (one shared CTE in the invoices service:
 * invoiced minus allocated payments minus attributed credit notes, floored
 * at zero, aged from the due date with an issue-date fallback), on the
 * ORG's calendar day. Outstanding, past due and over-90 are distinct,
 * linkable views; every row opens its invoice.
 */
export default async function ArPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "ar.view")) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  const currency = resolved.baseCurrency as CurrencyCode;
  const { view } = parseArSearch(sp);
  const asOf = orgToday(new Date(), resolved.timezone);
  const [ar, invoices] = await Promise.all([
    computeAR(resolved.ctx, resolved.archetype, asOf),
    listOutstandingInvoices(resolved.ctx, resolved.archetype, asOf, view),
  ]);
  const redacted = !resolved.ctx.pricePrivileged;
  const money = (v: number | null) =>
    v === null ? t("ar.redacted") : formatMoney(v, currency, { locale });
  const overdueTotal =
    ar.d1_30 === null
      ? null
      : (ar.d1_30 ?? 0) + (ar.d31_60 ?? 0) + (ar.d61_90 ?? 0) + (ar.over90 ?? 0);
  const views: Array<{ key: ArView; label: string; amount: number | null }> = [
    { key: "all", label: t("ar.view.all"), amount: ar.outstandingMinor },
    { key: "overdue", label: t("ar.view.overdue"), amount: overdueTotal },
    { key: "over90", label: t("ar.view.over90"), amount: ar.over90 },
  ];
  const activeView = views.find((v) => v.key === view)!;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("ar.title")}</h1>
        <p className="text-xs text-ink-muted">
          {t("ar.as_of")} {formatDate(asOf, { locale, timeZone: resolved.timezone ?? undefined })}
        </p>
      </div>

      {/* The three views: distinct, linkable, one financial definition. */}
      <div role="group" aria-label={t("ar.view.label")} className="flex flex-wrap gap-2">
        {views.map((v) => (
          <Link
            key={v.key}
            href={arHref(orgId, v.key)}
            aria-current={view === v.key ? "page" : undefined}
            className={`flex min-h-11 flex-col justify-center rounded-lg border px-4 py-2 ${
              view === v.key
                ? "border-ink bg-ink text-card"
                : "border-line bg-card text-ink hover:border-line-strong"
            }`}
          >
            <span className="text-xs opacity-80">{v.label}</span>
            <span dir="ltr" className="font-mono text-sm font-semibold">
              {money(v.amount)}
            </span>
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader title={activeView.label} />
        {view !== "all" ? (
          <FilterBar
            summary={activeView.label}
            countLabel={t("filters.count", { count: invoices?.length ?? 0 })}
            clearHref={arHref(orgId)}
            clearLabel={t("ar.view.show_all")}
          />
        ) : (
          <p role="status" className="mb-2 text-xs text-ink-muted">
            {redacted ? t("ar.redacted") : t("filters.count", { count: invoices?.length ?? 0 })}
          </p>
        )}
        {redacted ? (
          <p className="text-sm text-ink-muted">{t("ar.redacted_hint")}</p>
        ) : (invoices?.length ?? 0) === 0 ? (
          <EmptyState title={t("filters.empty")} description={t("filters.empty_hint")} />
        ) : (
          <ul className="divide-y divide-line">
            {invoices!.map((inv) => (
              <li key={inv.id}>
                <Link
                  href={`/o/${orgId}/invoices/${inv.id}`}
                  className="flex min-h-14 items-center justify-between gap-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">
                      {inv.reference}
                      {inv.customerName ? ` · ${inv.customerName}` : ""}
                    </span>
                    <span className="block text-xs text-ink-muted">
                      {inv.dueDate
                        ? `${t("ar.due")} ${formatDate(inv.dueDate, { locale })}`
                        : inv.issuedAt
                          ? `${t("ar.issued")} ${formatDate(inv.issuedAt, { locale })}`
                          : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {inv.ageDays > 0 ? (
                      <Badge tone={inv.ageDays > 90 ? "danger" : "warning"}>
                        {t("ar.days_overdue", { count: inv.ageDays })}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">{t("ar.bucket.current")}</Badge>
                    )}
                    <span dir="ltr" className="font-mono text-sm font-semibold text-ink">
                      {formatMoney(inv.balanceMinor, currency, { locale })}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title={t("ar.aging")} />
        <div className="flex flex-col">
          {(
            [
              [t("ar.bucket.current"), ar.current],
              [t("ar.bucket.d1_30"), ar.d1_30],
              [t("ar.bucket.d31_60"), ar.d31_60],
              [t("ar.bucket.d61_90"), ar.d61_90],
              [t("ar.bucket.over90"), ar.over90],
            ] as Array<[string, number | null]>
          ).map(([label, v]) => (
            <div
              key={label}
              className="flex items-center justify-between gap-2 border-b border-line py-2 text-sm last:border-0"
            >
              <span className="text-ink-muted">{label}</span>
              <span className="font-mono text-ink" dir="ltr">
                {money(v)}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
