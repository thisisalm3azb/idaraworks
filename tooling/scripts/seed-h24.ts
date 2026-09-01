/**
 * Bleed-harness seeders for the H24 finance tables.
 *
 * Same contract as seed-h23.ts — ONE seeder per org-scoped table, writing via
 * the OWNER connection so both orgs get real rows; chains build their own
 * dependencies inline so every seeder stands alone. Journal entries are
 * seeded as DRAFTS (the born-draft trigger would force that anyway); nothing
 * here posts, so the ledger invariants stay untouched.
 *
 * Fiscal years use disjoint future ranges per chain (2033/2034/2035) because
 * fiscal_year carries a no-overlap exclusion per org.
 */
import { randomUUID } from "node:crypto";
import type postgres from "postgres";

type Owner = ReturnType<typeof postgres>;
type Seeder = (owner: Owner, orgId: string, userId: string, recipientId: string) => Promise<void>;

const short = () => randomUUID().slice(0, 8);
const hex64 = () => (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 64);

async function glAccountRow(o: Owner, org: string, u: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.gl_account
            (id, org_id, code, name_en, account_type, normal_balance, created_by)
          values (${id}, ${org}, ${"BL" + short()}, 'Bleed account', 'expense', 'debit', ${u})`;
  return id;
}

async function journalEntryRow(o: Owner, org: string, u: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.journal_entry
            (id, org_id, entry_no, entry_date, currency, base_currency, created_by)
          values (${id}, ${org}, ${"BLJE-" + short()}, '2033-06-15', 'AED', 'AED', ${u})`;
  return id;
}

async function journalLineRow(o: Owner, org: string, u: string): Promise<string> {
  const entry = await journalEntryRow(o, org, u);
  const account = await glAccountRow(o, org, u);
  const id = randomUUID();
  await o`insert into public.journal_line
            (id, org_id, entry_id, line_no, account_id, debit_minor, base_debit_minor)
          values (${id}, ${org}, ${entry}, 1, ${account}, 100, 100)`;
  return id;
}

async function fiscalYearRow(
  o: Owner,
  org: string,
  u: string,
  from: string,
  to: string,
): Promise<string> {
  const id = randomUUID();
  await o`insert into public.fiscal_year (id, org_id, label, starts_on, ends_on, created_by)
          values (${id}, ${org}, ${"BLFY" + short()}, ${from}, ${to}, ${u})`;
  return id;
}

async function bankAccountRow(o: Owner, org: string, u: string): Promise<string> {
  const gl = await glAccountRow(o, org, u);
  const id = randomUUID();
  await o`insert into public.bank_account
            (id, org_id, name, kind, gl_account_id, currency, created_by)
          values (${id}, ${org}, ${"Bleed bank " + short()}, 'bank', ${gl}, 'AED', ${u})`;
  return id;
}

async function bankStatementChain(o: Owner, org: string, u: string) {
  const bank = await bankAccountRow(o, org, u);
  const statement = randomUUID();
  const line = randomUUID();
  await o`insert into public.bank_statement
            (id, org_id, bank_account_id, label, file_hash, line_count, imported_by)
          values (${statement}, ${org}, ${bank}, 'Bleed statement', ${hex64()}, 1, ${u})`;
  await o`insert into public.bank_statement_line
            (id, org_id, statement_id, bank_account_id, line_no, txn_date, description,
             amount_minor, line_hash)
          values (${line}, ${org}, ${statement}, ${bank}, 1, '2033-06-15', 'bleed line',
                  500, ${hex64()})`;
  return { bank, statement, line };
}

async function taxCodeRow(o: Owner, org: string, u: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.tax_code
            (id, org_id, code, name_en, treatment, rate_percent, effective_from, created_by)
          values (${id}, ${org}, ${"BLTX" + short()}, 'Bleed tax code', 'standard', 5,
                  '2033-01-01', ${u})`;
  return id;
}

async function taxReturnRow(
  o: Owner,
  org: string,
  u: string,
  taxType: "vat" | "corporate",
): Promise<string> {
  const id = randomUUID();
  await o`insert into public.tax_return
            (id, org_id, reference, tax_type, period_start, period_end, pack_version, prepared_by)
          values (${id}, ${org}, ${"BLTR-" + short()}, ${taxType}, '2033-01-01', '2033-03-31',
                  'bleed-1', ${u})`;
  return id;
}

export const H24_SEEDERS: Record<string, Seeder> = {
  gl_account: async (o, org, u) => {
    await glAccountRow(o, org, u);
  },
  cost_centre: async (o, org) => {
    await o`insert into public.cost_centre (org_id, code, name_en)
            values (${org}, ${"BLCC" + short()}, 'Bleed cost centre')`;
  },
  fiscal_year: async (o, org, u) => {
    await fiscalYearRow(o, org, u, "2033-01-01", "2033-12-31");
  },
  fiscal_period: async (o, org, u) => {
    const fy = await fiscalYearRow(o, org, u, "2034-01-01", "2034-12-31");
    await o`insert into public.fiscal_period
              (org_id, fiscal_year_id, period_no, starts_on, ends_on)
            values (${org}, ${fy}, 1, '2034-01-01', '2034-01-31')`;
  },
  journal_entry: async (o, org, u) => {
    await journalEntryRow(o, org, u);
  },
  journal_line: async (o, org, u) => {
    await journalLineRow(o, org, u);
  },
  journal_template: async (o, org, u) => {
    await o`insert into public.journal_template (org_id, name, created_by)
            values (${org}, ${"Bleed template " + short()}, ${u})`;
  },
  settlement_allocation: async (o, org, u) => {
    // payer/target ids are polymorphic references (no FK) — random is fine.
    await o`insert into public.settlement_allocation
              (org_id, payer_type, payer_id, target_type, target_id,
               amount_minor, base_amount_minor, created_by)
            values (${org}, 'payment', ${randomUUID()}, 'invoice', ${randomUUID()},
                    100, 100, ${u})`;
  },
  bank_account: async (o, org, u) => {
    await bankAccountRow(o, org, u);
  },
  money_transaction: async (o, org, u) => {
    const bank = await bankAccountRow(o, org, u);
    const contra = await glAccountRow(o, org, u);
    await o`insert into public.money_transaction
              (org_id, reference, kind, bank_account_id, contra_account_id, txn_date,
               amount_minor, currency, base_amount_minor, created_by)
            values (${org}, ${"BLMT-" + short()}, 'receipt', ${bank}, ${contra},
                    '2033-06-15', 700, 'AED', 700, ${u})`;
  },
  bank_statement: async (o, org, u) => {
    await bankStatementChain(o, org, u);
  },
  bank_statement_line: async (o, org, u) => {
    await bankStatementChain(o, org, u);
  },
  bank_reconciliation: async (o, org, u) => {
    const bank = await bankAccountRow(o, org, u);
    await o`insert into public.bank_reconciliation (org_id, bank_account_id, label, started_by)
            values (${org}, ${bank}, 'Bleed reconciliation', ${u})`;
  },
  bank_match: async (o, org, u) => {
    const { bank, line } = await bankStatementChain(o, org, u);
    const recon = randomUUID();
    await o`insert into public.bank_reconciliation (id, org_id, bank_account_id, label, started_by)
            values (${recon}, ${org}, ${bank}, 'Bleed match recon', ${u})`;
    const jl = await journalLineRow(o, org, u);
    await o`insert into public.bank_match
              (org_id, reconciliation_id, statement_line_id, journal_line_id,
               amount_minor, matched_by)
            values (${org}, ${recon}, ${line}, ${jl}, 500, ${u})`;
  },
  asset_depreciation_run: async (o, org, u) => {
    await o`insert into public.asset_depreciation_run
              (org_id, reference, period_start, period_end, total_minor, created_by)
            values (${org}, ${"BLDR-" + short()}, '2033-01-01', '2033-01-31', 0, ${u})`;
  },
  asset_depreciation_line: async (o, org, u) => {
    const run = randomUUID();
    await o`insert into public.asset_depreciation_run
              (id, org_id, reference, period_start, period_end, total_minor, created_by)
            values (${run}, ${org}, ${"BLDR-" + short()}, '2034-02-01', '2034-02-28', 0, ${u})`;
    const category = randomUUID();
    const asset = randomUUID();
    await o`insert into public.asset_category (id, org_id, code, name_en, created_by)
            values (${category}, ${org}, ${"BLAC" + short()}, 'Bleed dep category', ${u})`;
    await o`insert into public.asset
              (id, org_id, asset_no, category_id, name_en, status, condition, created_by)
            values (${asset}, ${org}, ${"BLAS-" + short()}, ${category},
                    'Bleed dep asset', 'in_service', 'good', ${u})`;
    await o`insert into public.asset_depreciation_line
              (org_id, run_id, asset_id, amount_minor, accumulated_after_minor)
            values (${org}, ${run}, ${asset}, 100, 100)`;
  },
  currency_rate: async (o, org, u) => {
    await o`insert into public.currency_rate
              (org_id, from_currency, to_currency, rate, effective_at, created_by)
            values (${org}, 'USD', 'AED', 3.6725, now(), ${u})`;
  },
  budget: async (o, org, u) => {
    const fy = await fiscalYearRow(o, org, u, "2035-01-01", "2035-12-31");
    await o`insert into public.budget (org_id, fiscal_year_id, name, created_by)
            values (${org}, ${fy}, ${"Bleed budget " + short()}, ${u})`;
  },
  budget_line: async (o, org, u) => {
    const fy = await fiscalYearRow(o, org, u, "2036-01-01", "2036-12-31");
    const budget = randomUUID();
    await o`insert into public.budget (id, org_id, fiscal_year_id, name, created_by)
            values (${budget}, ${org}, ${fy}, ${"Bleed line budget " + short()}, ${u})`;
    const account = await glAccountRow(o, org, u);
    await o`insert into public.budget_line (org_id, budget_id, account_id, amount_minor)
            values (${org}, ${budget}, ${account}, 1000)`;
  },
  tax_code: async (o, org, u) => {
    await taxCodeRow(o, org, u);
  },
  tax_entry: async (o, org, u) => {
    const entry = await journalEntryRow(o, org, u);
    const code = await taxCodeRow(o, org, u);
    await o`insert into public.tax_entry
              (org_id, journal_entry_id, source_type, source_id, tax_code_id, direction,
               base_minor, tax_minor, txn_date, code_snapshot)
            values (${org}, ${entry}, 'invoice', ${randomUUID()}, ${code}, 'output',
                    1000, 50, '2033-06-15', '{"bleed":true}'::jsonb)`;
  },
  tax_return: async (o, org, u) => {
    await taxReturnRow(o, org, u, "vat");
  },
  ct_adjustment: async (o, org, u) => {
    const ret = await taxReturnRow(o, org, u, "corporate");
    await o`insert into public.ct_adjustment
              (org_id, return_id, rule_key, label, direction, source_amount_minor,
               adjustment_minor, legal_source, calculation, created_by)
            values (${org}, ${ret}, 'bleed_rule', 'Bleed adjustment', 'add', 100, 100,
                    'bleed source', 'bleed calc', ${u})`;
  },
  tally_import: async (o, org, u) => {
    await o`insert into public.tally_import (org_id, filename, file_sha256, format, created_by)
            values (${org}, 'bleed.csv', ${hex64()}, 'csv', ${u})`;
  },
};
