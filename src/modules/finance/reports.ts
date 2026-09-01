/**
 * H24I — financial statements and drillable registers.
 *
 * Every number recomputes from posted journal lines (truth map D1) with
 * server-side aggregation and pagination — correct at any volume, and no
 * silent truncation: paged reads return `hasMore`. Statements carry their
 * basis, period and currency; they are MANAGEMENT statements (no IFRS claim).
 */
import { z } from "zod";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { FinanceError } from "./ledger";
import { subledgerReconciliations } from "./subledgers";

const PAGE_MAX = 200;

// ── balance sheet & profit and loss ─────────────────────────────────────────

export type StatementSection = {
  key: string;
  label: string;
  rows: Array<{
    accountId: string;
    code: string;
    nameEn: string;
    nameAr: string | null;
    amountMinor: number;
  }>;
  totalMinor: number;
};

async function typedBalances(
  ctx: Ctx,
  opts: { from?: string; to: string },
): Promise<
  Map<
    string,
    {
      code: string;
      nameEn: string;
      nameAr: string | null;
      type: string;
      normal: string;
      net: number;
    }
  >
> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select a.id::text as id, a.code, a.name_en, a.name_ar, a.account_type, a.normal_balance,
             coalesce(sum(l.base_debit_minor - l.base_credit_minor), 0)::text as net_debit
      from public.gl_account a
      join public.journal_line l on l.account_id = a.id and l.org_id = a.org_id
      join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
      where a.org_id = ${ctx.orgId} and e.status in ('posted', 'reversed')
        and e.entry_date <= ${opts.to}::date
        ${opts.from ? sql`and e.entry_date >= ${opts.from}::date` : sql``}
      group by a.id, a.code, a.name_en, a.name_ar, a.account_type, a.normal_balance
    `)) as unknown as Array<Record<string, string>>;
    const map = new Map();
    for (const r of rows) {
      map.set(r.id!, {
        code: r.code!,
        nameEn: r.name_en!,
        nameAr: r.name_ar ?? null,
        type: r.account_type!,
        normal: r.normal_balance!,
        net: Number(r.net_debit),
      });
    }
    return map;
  });
}

/** P&L for a period: income and expenses in their natural sign. */
export async function profitAndLoss(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{
  from: string;
  to: string;
  income: StatementSection;
  expenses: StatementSection;
  netProfitMinor: number;
  comparative?: { from: string; to: string; netProfitMinor: number };
}> {
  assertCan(archetype, "finance.view");
  const input = z
    .object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      compareFrom: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      compareTo: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .parse(raw);
  const balances = await typedBalances(ctx, { from: input.from, to: input.to });
  const income: StatementSection = { key: "income", label: "Income", rows: [], totalMinor: 0 };
  const expenses: StatementSection = {
    key: "expenses",
    label: "Expenses",
    rows: [],
    totalMinor: 0,
  };
  for (const [id, b] of balances) {
    if (b.type === "income") {
      const amount = -b.net; // credit-normal
      if (amount === 0) continue;
      income.rows.push({
        accountId: id,
        code: b.code,
        nameEn: b.nameEn,
        nameAr: b.nameAr,
        amountMinor: amount,
      });
      income.totalMinor += amount;
    } else if (b.type === "expense") {
      const amount = b.net;
      if (amount === 0) continue;
      expenses.rows.push({
        accountId: id,
        code: b.code,
        nameEn: b.nameEn,
        nameAr: b.nameAr,
        amountMinor: amount,
      });
      expenses.totalMinor += amount;
    }
  }
  income.rows.sort((a, b) => a.code.localeCompare(b.code));
  expenses.rows.sort((a, b) => a.code.localeCompare(b.code));
  const out = {
    from: input.from,
    to: input.to,
    income,
    expenses,
    netProfitMinor: income.totalMinor - expenses.totalMinor,
  } as Awaited<ReturnType<typeof profitAndLoss>>;
  if (input.compareFrom && input.compareTo) {
    const prior = await typedBalances(ctx, { from: input.compareFrom, to: input.compareTo });
    let inc = 0;
    let exp = 0;
    for (const b of prior.values()) {
      if (b.type === "income") inc += -b.net;
      else if (b.type === "expense") exp += b.net;
    }
    out.comparative = { from: input.compareFrom, to: input.compareTo, netProfitMinor: inc - exp };
  }
  return out;
}

/** Balance sheet as of a date. Retained earnings absorb life-to-date P&L. */
export async function balanceSheet(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{
  asOf: string;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  balancedMinor: number;
}> {
  assertCan(archetype, "finance.view");
  const input = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(raw);
  const balances = await typedBalances(ctx, { to: input.asOf });
  const assets: StatementSection = { key: "assets", label: "Assets", rows: [], totalMinor: 0 };
  const liabilities: StatementSection = {
    key: "liabilities",
    label: "Liabilities",
    rows: [],
    totalMinor: 0,
  };
  const equity: StatementSection = { key: "equity", label: "Equity", rows: [], totalMinor: 0 };
  let plNet = 0;
  for (const [id, b] of balances) {
    if (b.type === "asset") {
      if (b.net === 0) continue;
      assets.rows.push({
        accountId: id,
        code: b.code,
        nameEn: b.nameEn,
        nameAr: b.nameAr,
        amountMinor: b.net,
      });
      assets.totalMinor += b.net;
    } else if (b.type === "liability") {
      const amount = -b.net;
      if (amount === 0) continue;
      liabilities.rows.push({
        accountId: id,
        code: b.code,
        nameEn: b.nameEn,
        nameAr: b.nameAr,
        amountMinor: amount,
      });
      liabilities.totalMinor += amount;
    } else if (b.type === "equity") {
      const amount = -b.net;
      if (amount === 0) continue;
      equity.rows.push({
        accountId: id,
        code: b.code,
        nameEn: b.nameEn,
        nameAr: b.nameAr,
        amountMinor: amount,
      });
      equity.totalMinor += amount;
    } else if (b.type === "income") plNet += -b.net;
    else if (b.type === "expense") plNet -= b.net;
  }
  if (plNet !== 0) {
    equity.rows.push({
      accountId: "current-earnings",
      code: "—",
      nameEn: "Current earnings (life-to-date P&L)",
      nameAr: "أرباح الفترة",
      amountMinor: plNet,
    });
    equity.totalMinor += plNet;
  }
  for (const s of [assets, liabilities, equity])
    s.rows.sort((a, b) => a.code.localeCompare(b.code));
  return {
    asOf: input.asOf,
    assets,
    liabilities,
    equity,
    balancedMinor: assets.totalMinor - liabilities.totalMinor - equity.totalMinor,
  };
}

/** Indirect cash-flow (management statement): profit + non-cash + working
 *  capital deltas, investing (fixed assets), financing (equity). */
export async function cashFlowStatement(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{
  from: string;
  to: string;
  operatingMinor: number;
  investingMinor: number;
  financingMinor: number;
  netChangeMinor: number;
  detail: Array<{ label: string; amountMinor: number; group: string }>;
}> {
  assertCan(archetype, "finance.view");
  const input = z
    .object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .parse(raw);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select coalesce(a.control_kind, a.account_type) as bucket, a.account_type, a.system_key,
             coalesce(sum(l.base_debit_minor - l.base_credit_minor), 0)::text as net
      from public.gl_account a
      join public.journal_line l on l.account_id = a.id and l.org_id = a.org_id
      join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
      where a.org_id = ${ctx.orgId} and e.status in ('posted', 'reversed')
        and e.entry_date between ${input.from}::date and ${input.to}::date
      group by coalesce(a.control_kind, a.account_type), a.account_type, a.system_key
    `)) as unknown as Array<Record<string, string>>;
    // Bucketing invariant: every account lands in exactly one group, so
    // operating + investing + financing === net cash change (a balanced
    // ledger sums to zero). The depreciation add-back is the accumulated-
    // depreciation movement — its expense twin already sits inside profit.
    let profit = 0;
    let depreciation = 0;
    let wcDelta = 0; // AR/AP/inventory/tax/other working-capital deltas
    let investing = 0;
    let financing = 0;
    let cashDelta = 0;
    for (const r of rows) {
      const net = Number(r.net);
      if (r.account_type === "income") profit += -net;
      else if (r.account_type === "expense") profit -= net;
      else if (r.bucket === "bank" || r.bucket === "cash") cashDelta += net;
      else if (r.system_key === "accumulated_depreciation") depreciation += -net;
      else if (r.system_key === "fixed_assets") investing -= net;
      else if (r.account_type === "equity") financing += -net;
      else wcDelta -= net; // every remaining asset/liability
    }
    const operating = profit + depreciation + wcDelta;
    return {
      from: input.from,
      to: input.to,
      operatingMinor: operating,
      investingMinor: investing,
      financingMinor: financing,
      netChangeMinor: cashDelta,
      detail: [
        { label: "Net profit", amountMinor: profit, group: "operating" },
        { label: "Depreciation (non-cash)", amountMinor: depreciation, group: "operating" },
        { label: "Working-capital movement", amountMinor: wcDelta, group: "operating" },
        { label: "Fixed-asset movement", amountMinor: investing, group: "investing" },
        { label: "Equity movement", amountMinor: financing, group: "financing" },
      ],
    };
  });
}

// ── registers (paged, drillable) ─────────────────────────────────────────────

export type JournalRegisterRow = {
  entryId: string;
  entryNo: string;
  entryDate: string;
  journalKind: string;
  memo: string | null;
  status: string;
  totalDebitMinor: number;
  sourceType: string | null;
  sourceId: string | null;
};

export async function journalRegister(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: {
    from?: string;
    to?: string;
    status?: string;
    kind?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: JournalRegisterRow[]; hasMore: boolean; total: number }> {
  assertCan(archetype, "finance.view");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), PAGE_MAX);
  const offset = Math.max(opts.offset ?? 0, 0);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, entry_no, entry_date::text as d, journal_kind, memo, status,
             total_debit_minor::text as td, source_type, source_id::text as source_id,
             count(*) over ()::int as total
      from public.journal_entry
      where org_id = ${ctx.orgId}
        ${opts.from ? sql`and entry_date >= ${opts.from}::date` : sql``}
        ${opts.to ? sql`and entry_date <= ${opts.to}::date` : sql``}
        ${opts.status ? sql`and status = ${opts.status}` : sql``}
        ${opts.kind ? sql`and journal_kind = ${opts.kind}` : sql``}
      order by entry_date desc, entry_no desc
      limit ${limit + 1} offset ${offset}
    `)) as unknown as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      rows: page.map((r) => ({
        entryId: r.id as string,
        entryNo: r.entry_no as string,
        entryDate: r.d as string,
        journalKind: r.journal_kind as string,
        memo: (r.memo as string | null) ?? null,
        status: r.status as string,
        totalDebitMinor: Number(r.td),
        sourceType: (r.source_type as string | null) ?? null,
        sourceId: (r.source_id as string | null) ?? null,
      })),
      hasMore,
      total: page.length > 0 ? (page[0]!.total as number) : 0,
    };
  });
}

export type LedgerLine = {
  entryId: string;
  entryNo: string;
  entryDate: string;
  description: string | null;
  debitMinor: number;
  creditMinor: number;
  runningMinor: number;
};

/** One account's ledger with a running balance, paged forward. */
export async function accountLedger(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { accountId: string; from?: string; to?: string; limit?: number; offset?: number },
): Promise<{ rows: LedgerLine[]; openingMinor: number; hasMore: boolean }> {
  assertCan(archetype, "finance.view");
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), PAGE_MAX);
  const offset = Math.max(opts.offset ?? 0, 0);
  return withCtx(ctx, async (tx) => {
    const opening = (await tx.execute(sql`
      select coalesce(sum(l.base_debit_minor - l.base_credit_minor), 0)::text as bal
      from public.journal_line l
      join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
      where l.org_id = ${ctx.orgId} and l.account_id = ${opts.accountId}
        and e.status in ('posted', 'reversed')
        ${opts.from ? sql`and e.entry_date < ${opts.from}::date` : sql`and false`}
    `)) as unknown as Array<{ bal: string }>;
    const openingMinor = opts.from ? Number(opening[0]!.bal) : 0;
    const rows = (await tx.execute(sql`
      select e.id::text as id, e.entry_no, e.entry_date::text as d, l.description,
             l.base_debit_minor::text as dm, l.base_credit_minor::text as cm,
             sum(l.base_debit_minor - l.base_credit_minor)
               over (order by e.entry_date, e.entry_no, l.line_no)::text as running
      from public.journal_line l
      join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
      where l.org_id = ${ctx.orgId} and l.account_id = ${opts.accountId}
        and e.status in ('posted', 'reversed')
        ${opts.from ? sql`and e.entry_date >= ${opts.from}::date` : sql``}
        ${opts.to ? sql`and e.entry_date <= ${opts.to}::date` : sql``}
      order by e.entry_date, e.entry_no, l.line_no
      limit ${limit + 1} offset ${offset}
    `)) as unknown as Array<Record<string, string>>;
    const hasMore = rows.length > limit;
    return {
      openingMinor,
      hasMore,
      rows: rows.slice(0, limit).map((r) => ({
        entryId: r.id!,
        entryNo: r.entry_no!,
        entryDate: r.d!,
        description: r.description ?? null,
        debitMinor: Number(r.dm),
        creditMinor: Number(r.cm),
        runningMinor: openingMinor + Number(r.running),
      })),
    };
  });
}

/** The full detail of one entry, with its source link — the drill target. */
export async function journalEntryDetail(
  ctx: Ctx,
  archetype: RoleArchetype,
  entryId: string,
): Promise<{
  entryNo: string;
  entryDate: string;
  status: string;
  journalKind: string;
  memo: string | null;
  currency: string;
  exchangeRate: number;
  sourceType: string | null;
  sourceId: string | null;
  reversesEntryId: string | null;
  reversedByEntryId: string | null;
  lines: Array<{
    lineNo: number;
    accountCode: string;
    accountNameEn: string;
    accountNameAr: string | null;
    description: string | null;
    debitMinor: number;
    creditMinor: number;
  }>;
}> {
  assertCan(archetype, "finance.view");
  return withCtx(ctx, async (tx) => {
    const e = (await tx.execute(sql`
      select entry_no, entry_date::text as d, status, journal_kind, memo, currency,
             exchange_rate::text as rate, source_type, source_id::text as source_id,
             reverses_entry_id::text as rev_of, reversed_by_entry_id::text as rev_by
      from public.journal_entry where id = ${entryId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, string | null>>;
    if (!e[0]) throw new FinanceError("journal entry not found", "not_found");
    const lines = (await tx.execute(sql`
      select l.line_no, a.code, a.name_en, a.name_ar, l.description,
             l.debit_minor::text as dm, l.credit_minor::text as cm
      from public.journal_line l
      join public.gl_account a on a.id = l.account_id and a.org_id = l.org_id
      where l.entry_id = ${entryId} and l.org_id = ${ctx.orgId}
      order by l.line_no
    `)) as unknown as Array<Record<string, unknown>>;
    return {
      entryNo: e[0].entry_no!,
      entryDate: e[0].d!,
      status: e[0].status!,
      journalKind: e[0].journal_kind!,
      memo: e[0].memo ?? null,
      currency: e[0].currency!,
      exchangeRate: Number(e[0].rate),
      sourceType: e[0].source_type ?? null,
      sourceId: e[0].source_id ?? null,
      reversesEntryId: e[0].rev_of ?? null,
      reversedByEntryId: e[0].rev_by ?? null,
      lines: lines.map((l) => ({
        lineNo: l.line_no as number,
        accountCode: l.code as string,
        accountNameEn: l.name_en as string,
        accountNameAr: (l.name_ar as string | null) ?? null,
        description: (l.description as string | null) ?? null,
        debitMinor: Number(l.dm),
        creditMinor: Number(l.cm),
      })),
    };
  });
}

// ── the closing checklist ────────────────────────────────────────────────────

export type ClosingCheck = { key: string; label: string; count: number; blocking: boolean };

/** Computed-on-read month-end checklist — states facts, forces nothing. */
export async function closingChecklist(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<ClosingCheck[]> {
  assertCan(archetype, "finance.view");
  const input = z
    .object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .parse(raw);
  const checks: ClosingCheck[] = [];
  const counts = await withCtx(ctx, async (tx) => {
    const r = (await tx.execute(sql`
      select
        (select count(*)::int from public.journal_entry
         where org_id = ${ctx.orgId} and status = 'draft'
           and entry_date between ${input.from}::date and ${input.to}::date) as drafts,
        (select count(*)::int from public.bank_statement_line sl
         where sl.org_id = ${ctx.orgId}
           and sl.txn_date between ${input.from}::date and ${input.to}::date
           and not exists (select 1 from public.bank_match m
                           where m.org_id = sl.org_id and m.statement_line_id = sl.id
                             and m.voided_at is null)) as unreconciled,
        (select count(*)::int from public.invoice i
         where i.org_id = ${ctx.orgId} and i.status not in ('draft', 'cancelled')
           and coalesce(i.issued_at::date, i.created_at::date)
               between ${input.from}::date and ${input.to}::date
           and not exists (select 1 from public.tax_entry t
                           where t.org_id = i.org_id and t.source_type = 'invoice'
                             and t.source_id = i.id)) as tax_exceptions,
        (select count(*)::int from public.journal_template
         where org_id = ${ctx.orgId} and active and recurrence is not null
           and next_run_on <= ${input.to}::date) as due_templates
    `)) as unknown as Array<Record<string, number>>;
    return r[0]!;
  });
  checks.push({
    key: "draft_journals",
    label: "Draft journals dated in the period",
    count: counts.drafts!,
    blocking: true,
  });
  checks.push({
    key: "unreconciled_bank",
    label: "Unreconciled bank-statement lines",
    count: counts.unreconciled!,
    blocking: false,
  });
  checks.push({
    key: "tax_exceptions",
    label: "Documents without a tax classification",
    count: counts.tax_exceptions!,
    blocking: false,
  });
  checks.push({
    key: "due_templates",
    label: "Recurring journals due but not materialized",
    count: counts.due_templates!,
    blocking: false,
  });
  const drift = await subledgerReconciliations(ctx, archetype);
  for (const d of drift) {
    checks.push({
      key: `drift_${d.name}`,
      label: `Subledger drift — ${d.name}`,
      count: d.driftMinor === 0 ? 0 : 1,
      blocking: d.driftMinor !== 0,
    });
  }
  return checks;
}
