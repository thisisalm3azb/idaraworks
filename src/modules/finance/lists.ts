/**
 * H24K — small read-only listings for the finance surfaces. Every function
 * checks finance.view, reads within the tenant transaction, and stays bounded
 * (explicit limits on unbounded-growth tables). Nothing here writes.
 */
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { financeConfigIn } from "./chart";
import { vatProfileIn, type VatProfile } from "./tax";

export type FinanceSetupState = {
  installed: boolean;
  booksStartDate: string | null;
  vatPackInstalled: boolean;
  vatProfile: VatProfile | null;
};

export async function financeSetupState(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<FinanceSetupState> {
  assertCan(archetype, "finance.view");
  return withCtx(ctx, async (tx) => {
    const config = await financeConfigIn(tx, ctx);
    const profile = await vatProfileIn(tx, ctx);
    const codes = (await tx.execute(sql`
      select count(*)::int as n from public.tax_code where org_id = ${ctx.orgId}
    `)) as unknown as Array<{ n: number }>;
    return {
      installed: config !== null,
      booksStartDate: config?.booksStartDate ?? null,
      vatPackInstalled: (codes[0]?.n ?? 0) > 0,
      vatProfile: profile,
    };
  });
}

export type BankAccountRow = {
  id: string;
  name: string;
  kind: string;
  currency: string;
  bankName: string | null;
  active: boolean;
};

export async function listBankAccounts(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<BankAccountRow[]> {
  assertCan(archetype, "finance.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, kind, currency, bank_name, active
      from public.bank_account where org_id = ${ctx.orgId}
      order by name limit 500
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as string,
    currency: r.currency as string,
    bankName: (r.bank_name as string | null) ?? null,
    active: r.active === true,
  }));
}

export type MoneyTransactionRow = {
  id: string;
  reference: string;
  kind: string;
  bankAccountName: string;
  partyName: string | null;
  txnDate: string;
  amountMinor: number;
  currency: string;
  status: string;
  memo: string | null;
};

export async function listMoneyTransactions(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { limit?: number } = {},
): Promise<MoneyTransactionRow[]> {
  assertCan(archetype, "finance.view");
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select m.id::text as id, m.reference, m.kind, b.name as bank_name,
             coalesce(c.name, s.name, e.name) as party_name,
             m.txn_date::text as d, m.amount_minor::text as amount, m.currency,
             m.status, m.memo
      from public.money_transaction m
      join public.bank_account b on b.id = m.bank_account_id and b.org_id = m.org_id
      left join public.customer c on c.id = m.customer_id and c.org_id = m.org_id
      left join public.supplier s on s.id = m.supplier_id and s.org_id = m.org_id
      left join public.employee e on e.id = m.employee_id and e.org_id = m.org_id
      where m.org_id = ${ctx.orgId}
      order by m.txn_date desc, m.created_at desc
      limit ${limit}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    reference: r.reference as string,
    kind: r.kind as string,
    bankAccountName: r.bank_name as string,
    partyName: (r.party_name as string | null) ?? null,
    txnDate: r.d as string,
    amountMinor: Number(r.amount),
    currency: r.currency as string,
    status: r.status as string,
    memo: (r.memo as string | null) ?? null,
  }));
}

export type ReconciliationRow = {
  id: string;
  label: string;
  bankAccountId: string;
  bankAccountName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  matchCount: number;
};

export async function listReconciliations(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<ReconciliationRow[]> {
  assertCan(archetype, "finance.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select r.id::text as id, r.label, r.bank_account_id::text as bank_id,
             b.name as bank_name, r.status,
             r.started_at::date::text as started, r.completed_at::date::text as completed,
             (select count(*)::int from public.bank_match m
              where m.reconciliation_id = r.id and m.org_id = r.org_id
                and m.voided_at is null) as matches
      from public.bank_reconciliation r
      join public.bank_account b on b.id = r.bank_account_id and b.org_id = r.org_id
      where r.org_id = ${ctx.orgId}
      order by r.started_at desc limit 100
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    label: r.label as string,
    bankAccountId: r.bank_id as string,
    bankAccountName: r.bank_name as string,
    status: r.status as string,
    startedAt: r.started as string,
    completedAt: (r.completed as string | null) ?? null,
    matchCount: r.matches as number,
  }));
}

export type TaxReturnRow = {
  id: string;
  reference: string;
  taxType: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  packVersion: string;
};

export async function listTaxReturns(ctx: Ctx, archetype: RoleArchetype): Promise<TaxReturnRow[]> {
  assertCan(archetype, "tax.prepare");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, reference, tax_type, period_start::text as ps,
             period_end::text as pe, status, pack_version
      from public.tax_return where org_id = ${ctx.orgId}
      order by period_end desc, created_at desc limit 100
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    reference: r.reference as string,
    taxType: r.tax_type as string,
    periodStart: r.ps as string,
    periodEnd: r.pe as string,
    status: r.status as string,
    packVersion: r.pack_version as string,
  }));
}

export type BudgetRow = {
  id: string;
  name: string;
  status: string;
  fiscalYearId: string;
  fiscalYearLabel: string;
};

export async function listBudgets(ctx: Ctx, archetype: RoleArchetype): Promise<BudgetRow[]> {
  assertCan(archetype, "finance.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select b.id::text as id, b.name, b.status, b.fiscal_year_id::text as fy_id,
             y.label as fy_label
      from public.budget b
      join public.fiscal_year y on y.id = b.fiscal_year_id and y.org_id = b.org_id
      where b.org_id = ${ctx.orgId}
      order by y.starts_on desc, b.name limit 100
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    status: r.status as string,
    fiscalYearId: r.fy_id as string,
    fiscalYearLabel: r.fy_label as string,
  }));
}

export type FiscalYearRow = { id: string; label: string; startsOn: string; endsOn: string };

export async function listFiscalYears(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<FiscalYearRow[]> {
  assertCan(archetype, "finance.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, label, starts_on::text as s, ends_on::text as e
      from public.fiscal_year where org_id = ${ctx.orgId}
      order by starts_on desc limit 50
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    label: r.label as string,
    startsOn: r.s as string,
    endsOn: r.e as string,
  }));
}
