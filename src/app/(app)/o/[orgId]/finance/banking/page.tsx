import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Card, EmptyState } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { financeSurfacesEnabled } from "@/platform/flags";
import { formatDate, formatMoney } from "@/platform/format";
import type { CurrencyCode } from "@/platform/registries";
import {
  listBankAccounts,
  listMoneyTransactions,
  listReconciliations,
  cashPosition,
  listAccounts,
} from "@/modules/finance/service";
import { listCustomers, listSuppliers } from "@/modules/masters/service";
import {
  createBankAccountAction,
  recordMoneyTransactionAction,
  startReconciliationAction,
} from "../actions";

/** H24K — banking: accounts, money in/out, reconciliations. Every voucher is
 *  frozen when recorded; corrections are explicit voids with reversals. */
export default async function BankingPage({
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
  const posts = can(resolved.archetype, "finance.post");
  const manages = can(resolved.archetype, "finance.manage");
  const reconciles = can(resolved.archetype, "finance.reconcile");

  const [banks, txns, recons, cash, customers, supplierPage, accounts] = await Promise.all([
    listBankAccounts(resolved.ctx, resolved.archetype),
    listMoneyTransactions(resolved.ctx, resolved.archetype, { limit: 25 }),
    listReconciliations(resolved.ctx, resolved.archetype),
    cashPosition(resolved.ctx, resolved.archetype),
    listCustomers(resolved.ctx, resolved.archetype),
    listSuppliers(resolved.ctx, resolved.archetype),
    listAccounts(resolved.ctx, resolved.archetype),
  ]);
  const suppliers = supplierPage.rows;
  const cashOf = new Map(cash.map((c) => [c.bankAccountId, c.balanceMinor]));
  const createBank = createBankAccountAction.bind(null, orgId);
  const record = recordMoneyTransactionAction.bind(null, orgId);
  const startRecon = startReconciliationAction.bind(null, orgId);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("finance.banking.title")}</h1>
      {sp.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{sp.error}</p>
      ) : null}

      {banks.length === 0 ? (
        <EmptyState title={t("finance.banking.empty")} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {banks.map((b) => (
            <Card key={b.id}>
              <p className="text-sm font-medium text-ink">{b.name}</p>
              <p className="text-xs text-ink-muted">
                {t(`finance.banking.kind_${b.kind}`)}
                {b.bankName ? ` · ${b.bankName}` : ""}
              </p>
              <p className="mt-1 text-lg font-semibold text-ink" dir="ltr">
                {money(cashOf.get(b.id) ?? 0)}
              </p>
            </Card>
          ))}
        </div>
      )}

      {manages ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">
            {t("finance.banking.new_account")}
          </h2>
          <form action={createBank} className="grid grid-cols-1 gap-2 sm:grid-cols-4">
            <label className="text-xs text-ink-muted">
              {t("finance.banking.account_name")}
              <input name="name" required maxLength={120} className={input} />
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.banking.kind")}
              <select name="kind" className={input} dir="ltr">
                {["bank", "cash", "petty_cash", "card_clearing"].map((k) => (
                  <option key={k} value={k}>
                    {t(`finance.banking.kind_${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.accounts.code")}
              <input name="gl_code" required maxLength={20} className={input} dir="ltr" />
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.banking.bank_name")}
              <input name="bank_name" maxLength={120} className={input} />
            </label>
            <div className="sm:col-span-4">
              <Button type="submit">{t("finance.banking.new_account")}</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {posts && banks.length > 0 ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("finance.banking.record")}</h2>
          <form action={record} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs text-ink-muted">
              {t("finance.banking.txn_kind")}
              <select name="kind" className={input} dir="ltr">
                {["receipt", "payment", "bank_charge", "bank_interest"].map((k) => (
                  <option key={k} value={k}>
                    {t(`finance.banking.txn_${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.banking.account")}
              <select name="bank_account_id" className={input} dir="ltr">
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.banking.date")}
              <input name="txn_date" type="date" required className={input} dir="ltr" />
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.banking.amount")}
              <input
                name="amount"
                type="number"
                step="0.01"
                min="0.01"
                required
                className={input}
                dir="ltr"
              />
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.banking.customer")}
              <select name="customer_id" className={input} dir="ltr" defaultValue="">
                <option value="">—</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.banking.supplier")}
              <select name="supplier_id" className={input} dir="ltr" defaultValue="">
                <option value="">—</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted sm:col-span-2">
              {t("finance.banking.contra_hint")}
              <select name="contra_account_id" className={input} dir="ltr" defaultValue="">
                <option value="">—</option>
                {accounts
                  .filter((a) => !a.isControl)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {locale === "ar" && a.nameAr ? a.nameAr : a.nameEn}
                    </option>
                  ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.journals.memo")}
              <input name="memo" maxLength={500} className={input} />
            </label>
            <div className="sm:col-span-3">
              <Button type="submit">{t("finance.banking.record")}</Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-2 text-sm font-semibold text-ink">{t("finance.banking.recent")}</h2>
        {txns.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("finance.banking.none_yet")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {txns.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex flex-col">
                  <span className="text-sm text-ink" dir="ltr">
                    {m.reference}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {formatDate(m.txnDate, { locale })} · {t(`finance.banking.txn_${m.kind}`)}
                    {m.partyName ? ` · ${m.partyName}` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-sm text-ink" dir="ltr">
                    {formatMoney(m.amountMinor, m.currency as CurrencyCode, { locale })}
                  </span>
                  {m.status === "void" ? (
                    <Badge tone="danger">{t("finance.banking.void")}</Badge>
                  ) : (
                    <a
                      className="text-xs text-accent underline"
                      target="_blank"
                      href={`/api/o/${orgId}/documents/${
                        m.kind === "receipt" || m.kind === "bank_interest"
                          ? "receipt_voucher"
                          : "payment_voucher"
                      }/${m.id}?print=1&lang=${locale}`}
                    >
                      {t("finance.journals.print")}
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {reconciles && banks.length > 0 ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t("finance.banking.recon")}</h2>
          <form action={startRecon} className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs text-ink-muted">
              {t("finance.banking.account")}
              <select name="bank_account_id" className={input} dir="ltr">
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.banking.recon_label")}
              <input name="label" required maxLength={120} className={input} />
            </label>
            <label className="text-xs text-ink-muted">
              {t("finance.banking.statement_closing")}
              <input
                name="statement_closing"
                type="number"
                step="0.01"
                className={input}
                dir="ltr"
              />
            </label>
            <div className="sm:col-span-3">
              <Button type="submit" variant="secondary">
                {t("finance.banking.start_recon")}
              </Button>
            </div>
          </form>
          {recons.length === 0 ? null : (
            <ul className="flex flex-col divide-y divide-line">
              {recons.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/o/${orgId}/finance/banking/${r.id}`}
                    className="flex min-h-11 items-center justify-between gap-2 py-2"
                  >
                    <span className="flex flex-col">
                      <span className="text-sm text-ink">{r.label}</span>
                      <span className="text-xs text-ink-muted">
                        {r.bankAccountName} · {formatDate(r.startedAt, { locale })}
                      </span>
                    </span>
                    <Badge tone={r.status === "completed" ? "success" : "info"}>
                      {t(`finance.banking.recon_${r.status}`)}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </div>
  );
}
