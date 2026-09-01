import { notFound, redirect } from "next/navigation";
import { Card } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { financeSurfacesEnabled } from "@/platform/flags";
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import {
  trialBalance,
  balanceSheet,
  profitAndLoss,
  cashFlowStatement,
  accountLedger,
  listAccounts,
  type StatementSection,
} from "@/modules/finance/service";

/**
 * H24K — the statements hub. Every figure recomputes from the posted ledger
 * on request; the print/PDF links render the SAME numbers through the one
 * document pipeline. Management statements — labelled as such on the page
 * and on the paper.
 */
export default async function FinanceReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{
    report?: string;
    asOf?: string;
    from?: string;
    to?: string;
    account?: string;
  }>;
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

  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const report = sp.report ?? "tb";
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf ?? "") ? sp.asOf! : today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? sp.from! : `${year}-01-01`;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? sp.to! : today;
  const input =
    "mt-1 min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  const tabs = [
    { key: "tb", label: t("finance.reports.trial_balance") },
    { key: "bs", label: t("finance.reports.balance_sheet") },
    { key: "pl", label: t("finance.reports.profit_loss") },
    { key: "cf", label: t("finance.reports.cash_flow") },
    { key: "gl", label: t("finance.reports.account_ledger") },
  ];

  const sectionTable = (s: StatementSection) => (
    <div key={s.key} className="mb-3">
      <h3 className="mb-1 text-sm font-semibold text-ink">{s.label}</h3>
      <table className="w-full text-sm">
        <tbody>
          {s.rows.map((r) => (
            <tr key={r.accountId} className="border-b border-line last:border-0">
              <td className="py-1" dir="ltr">
                {r.code}
              </td>
              <td className="py-1 text-ink">{locale === "ar" && r.nameAr ? r.nameAr : r.nameEn}</td>
              <td className="py-1 text-end" dir="ltr">
                {money(r.amountMinor)}
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={2} className="py-1 font-semibold text-ink">
              {t("common.total")}
            </td>
            <td className="py-1 text-end font-semibold text-ink" dir="ltr">
              {money(s.totalMinor)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  let body: React.ReactNode = null;
  let docLink: string | null = null;
  if (report === "tb") {
    const tb = await trialBalance(resolved.ctx, resolved.archetype, { to: asOf });
    docLink = `/api/o/${orgId}/documents/trial_balance/${asOf}`;
    body = (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[26rem] text-sm">
          <thead>
            <tr className="border-b border-line text-xs text-ink-muted">
              <th className="py-2 text-start">{t("finance.accounts.code")}</th>
              <th className="py-2 text-start">{t("finance.accounts.name")}</th>
              <th className="py-2 text-end">{t("finance.journals.debit")}</th>
              <th className="py-2 text-end">{t("finance.journals.credit")}</th>
            </tr>
          </thead>
          <tbody>
            {tb.rows.map((r) => (
              <tr key={r.accountId} className="border-b border-line last:border-0">
                <td className="py-1" dir="ltr">
                  {r.code}
                </td>
                <td className="py-1 text-ink">
                  {locale === "ar" && r.nameAr ? r.nameAr : r.nameEn}
                </td>
                <td className="py-1 text-end" dir="ltr">
                  {r.debitMinor ? money(r.debitMinor) : ""}
                </td>
                <td className="py-1 text-end" dir="ltr">
                  {r.creditMinor ? money(r.creditMinor) : ""}
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={2} className="py-2 font-semibold text-ink">
                {t("common.total")}
              </td>
              <td className="py-2 text-end font-semibold" dir="ltr">
                {money(tb.totalDebitMinor)}
              </td>
              <td className="py-2 text-end font-semibold" dir="ltr">
                {money(tb.totalCreditMinor)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  } else if (report === "bs") {
    const bs = await balanceSheet(resolved.ctx, resolved.archetype, { asOf });
    docLink = `/api/o/${orgId}/documents/balance_sheet/${asOf}`;
    body = (
      <div>
        {[bs.assets, bs.liabilities, bs.equity].map(sectionTable)}
        <p className="text-xs text-ink-muted" dir="ltr">
          {money(bs.assets.totalMinor)} = {money(bs.liabilities.totalMinor + bs.equity.totalMinor)}
        </p>
      </div>
    );
  } else if (report === "pl") {
    const pl = await profitAndLoss(resolved.ctx, resolved.archetype, { from, to });
    docLink = `/api/o/${orgId}/documents/profit_loss/${from}_${to}`;
    body = (
      <div>
        {[pl.income, pl.expenses].map(sectionTable)}
        <p className="text-sm font-semibold text-ink">
          {t("finance.reports.net_profit")}: <span dir="ltr">{money(pl.netProfitMinor)}</span>
        </p>
      </div>
    );
  } else if (report === "cf") {
    const cf = await cashFlowStatement(resolved.ctx, resolved.archetype, { from, to });
    body = (
      <table className="w-full max-w-md text-sm">
        <tbody>
          {cf.detail.map((d) => (
            <tr key={d.label} className="border-b border-line last:border-0">
              <td className="py-1 text-ink">{d.label}</td>
              <td className="py-1 text-xs text-ink-muted">{d.group}</td>
              <td className="py-1 text-end" dir="ltr">
                {money(d.amountMinor)}
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={2} className="py-2 font-semibold text-ink">
              {t("finance.reports.net_cash_change")}
            </td>
            <td className="py-2 text-end font-semibold" dir="ltr">
              {money(cf.netChangeMinor)}
            </td>
          </tr>
        </tbody>
      </table>
    );
  } else if (report === "gl") {
    const accounts = await listAccounts(resolved.ctx, resolved.archetype);
    const accountId = sp.account || accounts[0]?.id;
    const ledger = accountId
      ? await accountLedger(resolved.ctx, resolved.archetype, { accountId, from, to })
      : { rows: [], openingMinor: 0, hasMore: false };
    body = (
      <div className="flex flex-col gap-2">
        <form className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="report" value="gl" />
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={to} />
          <label className="text-xs text-ink-muted">
            {t("finance.journals.account")}
            <select name="account" defaultValue={accountId} className={`${input} block`} dir="ltr">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {locale === "ar" && a.nameAr ? a.nameAr : a.nameEn}
                </option>
              ))}
            </select>
          </label>
          <button className="min-h-11 rounded-md border border-line-strong px-4 text-sm text-ink">
            {t("common.apply")}
          </button>
        </form>
        <p className="text-xs text-ink-muted">
          {t("finance.reports.opening")}: <span dir="ltr">{money(ledger.openingMinor)}</span>
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-ink-muted">
                <th className="py-2 text-start">{t("finance.journals.entry_date")}</th>
                <th className="py-2 text-start">#</th>
                <th className="py-2 text-end">{t("finance.journals.debit")}</th>
                <th className="py-2 text-end">{t("finance.journals.credit")}</th>
                <th className="py-2 text-end">{t("finance.reports.balance")}</th>
              </tr>
            </thead>
            <tbody>
              {ledger.rows.map((r, i) => (
                <tr key={`${r.entryId}-${i}`} className="border-b border-line last:border-0">
                  <td className="py-1" dir="ltr">
                    {r.entryDate}
                  </td>
                  <td className="py-1" dir="ltr">
                    {r.entryNo}
                  </td>
                  <td className="py-1 text-end" dir="ltr">
                    {r.debitMinor ? money(r.debitMinor) : ""}
                  </td>
                  <td className="py-1 text-end" dir="ltr">
                    {r.creditMinor ? money(r.creditMinor) : ""}
                  </td>
                  <td className="py-1 text-end" dir="ltr">
                    {money(r.runningMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("nav.finance_reports")}</h1>
      <div className="flex flex-wrap gap-2 text-sm">
        {tabs.map((tab) => (
          <a
            key={tab.key}
            href={`?report=${tab.key}`}
            className={`rounded-full border px-3 py-1 ${
              report === tab.key ? "border-accent text-accent" : "border-line text-ink-muted"
            }`}
          >
            {tab.label}
          </a>
        ))}
      </div>

      <Card>
        <form className="mb-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="report" value={report} />
          {report === "tb" || report === "bs" ? (
            <label className="text-xs text-ink-muted">
              {t("finance.reports.as_of")}
              <input
                name="asOf"
                type="date"
                defaultValue={asOf}
                className={`${input} block`}
                dir="ltr"
              />
            </label>
          ) : (
            <>
              <label className="text-xs text-ink-muted">
                {t("finance.reports.from")}
                <input
                  name="from"
                  type="date"
                  defaultValue={from}
                  className={`${input} block`}
                  dir="ltr"
                />
              </label>
              <label className="text-xs text-ink-muted">
                {t("finance.reports.to")}
                <input
                  name="to"
                  type="date"
                  defaultValue={to}
                  className={`${input} block`}
                  dir="ltr"
                />
              </label>
            </>
          )}
          <button className="min-h-11 rounded-md border border-line-strong px-4 text-sm text-ink">
            {t("common.apply")}
          </button>
          {docLink ? (
            <span className="flex gap-2">
              <a
                className="min-h-11 rounded-md border border-line-strong px-4 py-2.5 text-sm text-ink"
                target="_blank"
                href={`${docLink}?print=1&lang=${locale}`}
              >
                {t("finance.journals.print")}
              </a>
              <a
                className="min-h-11 rounded-md border border-line-strong px-4 py-2.5 text-sm text-ink"
                href={`${docLink}?format=pdf&lang=${locale}`}
              >
                PDF
              </a>
            </span>
          ) : null}
        </form>
        {body}
        <p className="mt-3 text-xs text-ink-muted">{t("finance.reports.management_note")}</p>
      </Card>
    </div>
  );
}
