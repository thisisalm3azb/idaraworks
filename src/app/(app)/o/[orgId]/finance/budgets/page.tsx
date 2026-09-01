import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { financeSurfacesEnabled } from "@/platform/flags";
import { formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import {
  listBudgets,
  listFiscalYears,
  listAccounts,
  budgetVsActual,
} from "@/modules/finance/service";
import { saveBudgetAction, budgetStatusAction } from "../actions";

const STATUS_TONE: Record<string, "success" | "warning" | "info"> = {
  approved: "success",
  locked: "warning",
  draft: "info",
};

/** H24K — budgets: drafts freeze on approval; variance recomputes from the
 *  posted ledger every time the page renders. */
export default async function BudgetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ budget?: string; ok?: string; error?: string }>;
}) {
  if (!financeSurfacesEnabled()) notFound();
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "budget.manage")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const currency = resolved.baseCurrency as CurrencyCode;
  const money = (minor: number) => formatMoney(minor, currency, { locale });
  const [budgets, years, accounts] = await Promise.all([
    listBudgets(resolved.ctx, resolved.archetype),
    listFiscalYears(resolved.ctx, resolved.archetype),
    listAccounts(resolved.ctx, resolved.archetype),
  ]);
  const plAccounts = accounts.filter(
    (a) => a.accountType === "income" || a.accountType === "expense",
  );
  const selected = budgets.find((b) => b.id === sp.budget) ?? budgets[0];
  const bva = selected ? await budgetVsActual(resolved.ctx, resolved.archetype, selected.id) : [];
  const save = saveBudgetAction.bind(null, orgId);
  const status = budgetStatusAction.bind(null, orgId);
  const approves = can(resolved.archetype, "finance.approve");
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("nav.finance_budgets")}</h1>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}

      {years.length > 0 ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("finance.budgets.new")}</h2>
          <form action={save} className="flex flex-col gap-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="text-xs text-ink-muted">
                {t("finance.budgets.fiscal_year")}
                <select name="fiscal_year_id" className={input} dir="ltr">
                  {years.map((y) => (
                    <option key={y.id} value={y.id}>
                      {y.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-ink-muted">
                {t("finance.budgets.name")}
                <input name="name" required maxLength={120} className={input} />
              </label>
            </div>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="text-xs text-ink-muted">
                  {t("finance.journals.account")}
                  <select name={`line_${i}_account`} className={input} dir="ltr" defaultValue="">
                    <option value="">—</option>
                    {plAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {locale === "ar" && a.nameAr ? a.nameAr : a.nameEn}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-ink-muted">
                  {t("finance.banking.amount")}
                  <input
                    name={`line_${i}_amount`}
                    type="number"
                    step="0.01"
                    className={input}
                    dir="ltr"
                  />
                </label>
              </div>
            ))}
            <Button type="submit">{t("common.save")}</Button>
          </form>
        </Card>
      ) : null}

      {budgets.length === 0 ? (
        <EmptyState title={t("finance.budgets.empty")} />
      ) : (
        <Card>
          <div className="mb-2 flex flex-wrap gap-2 text-sm">
            {budgets.map((b) => (
              <a
                key={b.id}
                href={`?budget=${b.id}`}
                className={`rounded-full border px-3 py-1 ${
                  selected?.id === b.id ? "border-accent text-accent" : "border-line text-ink-muted"
                }`}
              >
                {b.name}
              </a>
            ))}
          </div>
          {selected ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONE[selected.status] ?? "info"}>
                  {t(`finance.budgets.status_${selected.status}`)}
                </Badge>
                <span className="text-xs text-ink-muted">{selected.fiscalYearLabel}</span>
                {selected.status === "draft" ? (
                  <form action={status}>
                    <input type="hidden" name="budget_id" value={selected.id} />
                    <input type="hidden" name="status" value="approved" />
                    <Button type="submit" variant="secondary">
                      {t("finance.budgets.approve")}
                    </Button>
                  </form>
                ) : null}
                {approves && selected.status === "approved" ? (
                  <form action={status}>
                    <input type="hidden" name="budget_id" value={selected.id} />
                    <input type="hidden" name="status" value="locked" />
                    <Button type="submit" variant="secondary">
                      {t("finance.budgets.lock")}
                    </Button>
                  </form>
                ) : null}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[26rem] text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs text-ink-muted">
                      <th className="py-2 text-start">{t("finance.journals.account")}</th>
                      <th className="py-2 text-end">{t("finance.budgets.budget")}</th>
                      <th className="py-2 text-end">{t("finance.budgets.actual")}</th>
                      <th className="py-2 text-end">{t("finance.budgets.variance")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bva.map((r) => (
                      <tr key={r.accountId} className="border-b border-line last:border-0">
                        <td className="py-2 text-ink">
                          <span dir="ltr">{r.code}</span> — {r.nameEn}
                        </td>
                        <td className="py-2 text-end" dir="ltr">
                          {money(r.budgetMinor)}
                        </td>
                        <td className="py-2 text-end" dir="ltr">
                          {money(r.actualMinor)}
                        </td>
                        <td
                          className={`py-2 text-end ${
                            r.varianceMinor < 0 ? "text-danger" : "text-success"
                          }`}
                          dir="ltr"
                        >
                          {money(r.varianceMinor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}
