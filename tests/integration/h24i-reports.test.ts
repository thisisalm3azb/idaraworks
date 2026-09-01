/**
 * H24I — statements and drillable registers.
 *
 * Properties: the balance sheet balances BY RECOMPUTATION (assets =
 * liabilities + equity, never a stored total); the P&L ties to the trial
 * balance; the cash-flow statement's three groups sum exactly to the cash
 * movement (bucketing invariant); registers page without losing rows and the
 * running balance survives pagination; every register row drills to full
 * entry detail with its source link; the closing checklist surfaces known
 * facts (an unposted draft, an unclassified document) without forcing
 * anything.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createCustomer } from "@/modules/masters/service";
import { createInvoice, issueInvoice } from "@/modules/invoices/service";
import { createExpense, listExpenseCategories } from "@/modules/expenses/service";
import { recordPayment } from "@/modules/payments/service";
import {
  installFinanceSetup,
  installUaeVatPack,
  createJournalEntry,
  systemAccountIn,
  trialBalance,
  balanceSheet,
  profitAndLoss,
  cashFlowStatement,
  journalRegister,
  accountLedger,
  journalEntryDetail,
  closingChecklist,
} from "@/modules/finance/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
let customerId = "";
let arAccountId = "";
let cashAccountId = "";
let bankAccountId = "";

const YEAR = { from: "2026-01-01", to: "2026-12-31" };

const A = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h24i",
});

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h24i-${run}@example.invalid`}, '{"full_name":"H24I"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H24I", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h24i", run);
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  await installFinanceSetup(A(), "owner", { booksStartDate: "2026-01-01" });
  await installUaeVatPack(A(), "owner");
  customerId = (await createCustomer(A(), "owner", { name: `Delta Marine ${run}` })).id;
  [arAccountId, cashAccountId, bankAccountId] = await withCtx(A(), async (tx) => [
    await systemAccountIn(tx, A(), "ar_control"),
    await systemAccountIn(tx, A(), "cash_on_hand"),
    await systemAccountIn(tx, A(), "bank_default"),
  ]);

  // The books: a 200,000+5% invoice, a 9,999 zero-VAT oddball (no tax fact →
  // checklist exception), a 30,000+1,500 overhead expense, a 100,000 receipt.
  const inv = await createInvoice(A(), "owner", {
    customerId,
    lines: [
      { description: "Hull works", qty: 1, unit: "job", unitPriceMinor: 200_000, vatRate: 5 },
    ],
  });
  await issueInvoice(A(), "owner", inv.id);
  const oddball = await createInvoice(A(), "owner", {
    customerId,
    lines: [{ description: "Mystery", qty: 1, unit: "job", unitPriceMinor: 9_999, vatRate: 0 }],
  });
  await issueInvoice(A(), "owner", oddball.id);
  const cats = await listExpenseCategories(A());
  const categoryKey = cats.find((c) => c.costingMapping === "overhead")?.key ?? cats[0]!.key;
  await createExpense(A(), "owner", {
    categoryKey,
    description: "Yard electricity",
    expenseDate: "2026-06-10",
    amountMinor: 30_000,
    vatAmountMinor: 1_500,
  });
  await recordPayment(A(), "owner", {
    invoiceId: inv.id,
    customerId,
    method: "bank_transfer",
    paymentDate: "2026-09-01",
    amountMinor: 100_000,
  });
  // An unposted draft dated inside the period — checklist material.
  await createJournalEntry(A(), "owner", {
    entryDate: "2026-09-15",
    memo: "month-end accrual, not yet posted",
    lines: [
      { accountId: cashAccountId, debitMinor: 5_000, creditMinor: 0 },
      { accountId: bankAccountId, debitMinor: 0, creditMinor: 5_000 },
    ],
  });
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
}, 240_000);

describe("statements recompute from the posted ledger", () => {
  it("balance sheet balances; AR is the open receivable", { timeout: 300_000 }, async () => {
    const bs = await balanceSheet(A(), "owner", { asOf: "2026-12-31" });
    expect(bs.balancedMinor).toBe(0);
    const ar = bs.assets.rows.find((r) => r.accountId === arAccountId);
    // 210,000 + 9,999 invoiced − 100,000 received.
    expect(ar?.amountMinor).toBe(119_999);
    expect(bs.assets.totalMinor).toBe(bs.liabilities.totalMinor + bs.equity.totalMinor);
  });

  it("P&L ties to the trial balance", { timeout: 300_000 }, async () => {
    const pl = await profitAndLoss(A(), "owner", {
      ...YEAR,
      compareFrom: "2025-01-01",
      compareTo: "2025-12-31",
    });
    expect(pl.income.totalMinor).toBe(209_999);
    expect(pl.expenses.totalMinor).toBe(30_000);
    expect(pl.netProfitMinor).toBe(179_999);
    // Nothing may post before the books start — the comparative year is empty.
    expect(pl.comparative?.netProfitMinor).toBe(0);
    const tb = await trialBalance(A(), "owner", {});
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
  });

  it("cash-flow groups sum exactly to the cash movement", { timeout: 300_000 }, async () => {
    const cf = await cashFlowStatement(A(), "owner", YEAR);
    expect(cf.operatingMinor + cf.investingMinor + cf.financingMinor).toBe(cf.netChangeMinor);
    // Independent check: the cash movement equals the cash+bank lines on the
    // balance sheet (books started this year, so movement = position).
    const bs = await balanceSheet(A(), "owner", { asOf: YEAR.to });
    const cashish = bs.assets.rows
      .filter((r) => r.accountId === cashAccountId || r.accountId === bankAccountId)
      .reduce((s, r) => s + r.amountMinor, 0);
    expect(cf.netChangeMinor).toBe(cashish);
  });
});

describe("registers page and drill", () => {
  it("the journal register pages without losing rows", { timeout: 300_000 }, async () => {
    const all = await journalRegister(A(), "owner", {});
    expect(all.rows.length).toBeGreaterThanOrEqual(4); // 2 invoices, expense, payment
    const page1 = await journalRegister(A(), "owner", { limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.total).toBe(all.total);
    const drafts = await journalRegister(A(), "owner", { status: "draft" });
    expect(drafts.rows.some((r) => r.memo?.includes("month-end accrual"))).toBe(true);
  });

  it("the account ledger's running balance survives pagination", { timeout: 300_000 }, async () => {
    const full = await accountLedger(A(), "owner", { accountId: arAccountId });
    expect(full.rows.length).toBeGreaterThanOrEqual(3);
    expect(full.rows.at(-1)!.runningMinor).toBe(119_999);
    const page2 = await accountLedger(A(), "owner", {
      accountId: arAccountId,
      limit: 1,
      offset: 1,
    });
    expect(page2.rows[0]!.runningMinor).toBe(full.rows[1]!.runningMinor);
    // A dated window carries what came before it as the opening balance.
    const windowed = await accountLedger(A(), "owner", {
      accountId: arAccountId,
      from: "2026-09-01",
    });
    const before = full.rows.filter((r) => r.entryDate < "2026-09-01");
    expect(windowed.openingMinor).toBe(
      before.reduce((s, r) => s + r.debitMinor - r.creditMinor, 0),
    );
  });

  it(
    "a register row drills to full entry detail with its source",
    { timeout: 300_000 },
    async () => {
      const sales = await journalRegister(A(), "owner", { kind: "sales" });
      expect(sales.rows.length).toBeGreaterThanOrEqual(2);
      const detail = await journalEntryDetail(A(), "owner", sales.rows[0]!.entryId);
      expect(detail.lines.length).toBeGreaterThanOrEqual(2);
      expect(detail.sourceType).toBe("invoice");
      expect(detail.status).toBe("posted");
      const debits = detail.lines.reduce((s, l) => s + l.debitMinor, 0);
      const credits = detail.lines.reduce((s, l) => s + l.creditMinor, 0);
      expect(debits).toBe(credits);
    },
  );
});

describe("closing checklist", () => {
  it(
    "surfaces the draft and the unclassified document; drift is clean",
    { timeout: 300_000 },
    async () => {
      const checks = await closingChecklist(A(), "owner", YEAR);
      const byKey = Object.fromEntries(checks.map((c) => [c.key, c]));
      expect(byKey.draft_journals!.count).toBeGreaterThanOrEqual(1);
      expect(byKey.draft_journals!.blocking).toBe(true);
      // The zero-VAT oddball invoice has no tax classification.
      expect(byKey.tax_exceptions!.count).toBeGreaterThanOrEqual(1);
      expect(byKey.unreconciled_bank!.count).toBe(0);
      for (const c of checks.filter((x) => x.key.startsWith("drift_"))) {
        expect(c.count, c.key).toBe(0);
      }
    },
  );
});
