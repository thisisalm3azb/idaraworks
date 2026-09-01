import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Card } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { financeSurfacesEnabled } from "@/platform/flags";
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import {
  financeSetupState,
  cashPosition,
  arOpenItems,
  apOpenItems,
  closingChecklist,
  trialBalance,
} from "@/modules/finance/service";

/** H24K — the finance overview: setup state, cash, AR/AP, the checklist. */
export default async function FinancePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  if (!financeSurfacesEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "finance.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const currency = resolved.baseCurrency as CurrencyCode;
  const money = (minor: number) => formatMoney(minor, currency, { locale });

  const setup = await financeSetupState(resolved.ctx, resolved.archetype);
  if (!setup.installed) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold text-ink">{t("finance.title")}</h1>
        <Card>
          <p className="text-sm text-ink-muted">{t("finance.not_set_up")}</p>
          {can(resolved.archetype, "finance.manage") ? (
            <Link
              href={`/o/${orgId}/finance/setup`}
              className="mt-3 inline-block rounded-md bg-accent px-4 py-2 text-sm font-medium text-white"
            >
              {t("finance.setup.title")}
            </Link>
          ) : null}
        </Card>
      </div>
    );
  }

  const year = new Date().getFullYear();
  const [cash, ar, ap, checklist, tb] = await Promise.all([
    cashPosition(resolved.ctx, resolved.archetype),
    arOpenItems(resolved.ctx, resolved.archetype),
    apOpenItems(resolved.ctx, resolved.archetype),
    closingChecklist(resolved.ctx, resolved.archetype, {
      from: `${year}-01-01`,
      to: `${year}-12-31`,
    }),
    trialBalance(resolved.ctx, resolved.archetype, {}),
  ]);
  const arTotal = ar.reduce((s, r) => s + r.outstandingMinor, 0);
  const apTotal = ap.reduce((s, r) => s + r.outstandingMinor, 0);
  const cashTotal = cash.reduce((s, r) => s + r.balanceMinor, 0);
  const attention = checklist.filter((c) => c.count > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{t("finance.title")}</h1>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link className="text-accent underline" href={`/o/${orgId}/finance/accounts`}>
            {t("finance.accounts.title")}
          </Link>
          {can(resolved.archetype, "finance.manage") ? (
            <Link className="text-accent underline" href={`/o/${orgId}/finance/setup`}>
              {t("finance.setup.title")}
            </Link>
          ) : null}
        </div>
      </div>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-xs text-ink-muted">{t("finance.cash_position")}</p>
          <p className="text-lg font-semibold text-ink" dir="ltr">
            {money(cashTotal)}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-ink-muted">
            {cash.map((c) => (
              <li key={c.bankAccountId} className="flex justify-between gap-2">
                <span className="truncate">{c.name}</span>
                <span dir="ltr">{money(c.balanceMinor)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <p className="text-xs text-ink-muted">{t("finance.ar_total")}</p>
          <p className="text-lg font-semibold text-ink" dir="ltr">
            {money(arTotal)}
          </p>
          <Link className="text-xs text-accent underline" href={`/o/${orgId}/finance/receivables`}>
            {t("nav.finance_receivables")}
          </Link>
        </Card>
        <Card>
          <p className="text-xs text-ink-muted">{t("finance.ap_total")}</p>
          <p className="text-lg font-semibold text-ink" dir="ltr">
            {money(apTotal)}
          </p>
          <Link className="text-xs text-accent underline" href={`/o/${orgId}/finance/payables`}>
            {t("nav.finance_payables")}
          </Link>
        </Card>
      </div>

      <Card>
        <h2 className="mb-2 text-sm font-semibold text-ink">{t("finance.checklist")}</h2>
        {attention.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("finance.checklist_clear")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {attention.map((c) => (
              <li key={c.key} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-ink">{c.label}</span>
                <Badge tone={c.blocking ? "danger" : "warning"}>{String(c.count)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">{t("finance.reports.trial_balance")}</h2>
          <span className="text-xs text-ink-muted" dir="ltr">
            {money(tb.totalDebitMinor)} = {money(tb.totalCreditMinor)}
          </span>
        </div>
        <Link className="text-xs text-accent underline" href={`/o/${orgId}/finance/reports`}>
          {t("nav.finance_reports")}
        </Link>
      </Card>
    </div>
  );
}
