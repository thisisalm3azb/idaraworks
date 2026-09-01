/**
 * H24C/D — setup, opening balances, document posting, AR/AP open items.
 *
 * The properties: setup is idempotent; opening balances post once with the
 * offset SHOWN; issuing an invoice / recording a payment / recording an
 * expense each post exactly one entry with the right accounts and amounts;
 * voids reverse; documents dated before the books start never post; the
 * trial balance stays balanced through all of it; allocations explain money
 * without moving it; ageing and statements recompute.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createCustomer } from "@/modules/masters/service";
import { createInvoice, issueInvoice, createCreditNote } from "@/modules/invoices/service";
import { recordPayment, voidPayment } from "@/modules/payments/service";
import { createExpense, voidExpense, listExpenseCategories } from "@/modules/expenses/service";
import {
  installFinanceSetup,
  financeConfig,
  postOpeningBalances,
  trialBalance,
  systemAccountIn,
  createReversingJournal,
  saveJournalTemplate,
  dueTemplates,
  materializeTemplate,
  allocatePayment,
  arOpenItems,
  arAgeing,
  customerStatement,
  customerCreditCheck,
  ledgerReconciliation,
} from "@/modules/finance/service";
import { withCtx } from "@/platform/tenancy";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
let customerId = "";
let categoryKey = "";

const A = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h24cd",
});

async function entryFor(sourceType: string, sourceId: string, eventKey: string) {
  const rows = await owner`
    select e.id::text as id, e.status, e.total_debit_minor::int as td
    from public.journal_entry e
    where e.org_id = ${orgA} and e.source_type = ${sourceType}
      and e.source_id = ${sourceId} and e.event_key = ${eventKey}
      and e.status in ('posted', 'reversed')`;
  return rows[0] ?? null;
}

async function linesOf(entryId: string) {
  return owner`
    select a.system_key as k, l.debit_minor::int as d, l.credit_minor::int as c,
           l.customer_id::text as customer_id
    from public.journal_line l
    join public.gl_account a on a.id = l.account_id and a.org_id = l.org_id
    where l.entry_id = ${entryId} order by l.line_no`;
}

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h24cd-${run}@example.invalid`}, '{"full_name":"H24CD"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H24CD", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h24cd", run);
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  const cats = await listExpenseCategories(A());
  categoryKey = cats.find((c) => c.costingMapping === "overhead")?.key ?? cats[0]!.key;
  customerId = (await createCustomer(A(), "owner", { name: `Acme ${run}` })).id;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
}, 240_000);

describe("guided setup and opening balances", () => {
  it("seeds the chart idempotently and creates the fiscal year", { timeout: 300_000 }, async () => {
    const first = await installFinanceSetup(A(), "owner", { booksStartDate: "2026-01-01" });
    expect(first.accountsCreated).toBeGreaterThan(20);
    expect(first.fiscalYearCreated).toBe(true);
    const second = await installFinanceSetup(A(), "owner", { booksStartDate: "2026-01-01" });
    expect(second.accountsCreated).toBe(0);
    expect(second.fiscalYearCreated).toBe(false);
    const config = await financeConfig(A());
    expect(config?.booksStartDate).toBe("2026-01-01");
  });

  it("opening balances post once, offset SHOWN, and balance", { timeout: 300_000 }, async () => {
    const cash = await withCtx(A(), (tx) => systemAccountIn(tx, A(), "cash_on_hand"));
    const ar = await withCtx(A(), (tx) => systemAccountIn(tx, A(), "ar_control"));
    const r = await postOpeningBalances(A(), "owner", {
      lines: [
        { accountId: cash, debitMinor: 250_000 },
        { accountId: ar, debitMinor: 100_000, customerId },
      ],
    });
    expect(r.offsetMinor).toBe(350_000);
    const lines = await linesOf(r.entryId);
    const equity = lines.find((l) => l.k === "opening_balance_equity");
    expect(equity?.c).toBe(350_000);
    await expect(
      postOpeningBalances(A(), "owner", { lines: [{ accountId: cash, debitMinor: 1 }] }),
    ).rejects.toThrow(/already posted/);
    const tb = await trialBalance(A(), "owner", {});
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
  });
});

describe("documents post once and reverse explicitly", () => {
  let invoiceId = "";
  let paymentId = "";

  it(
    "issuing an invoice posts AR / revenue / VAT with the customer dimension",
    { timeout: 300_000 },
    async () => {
      const inv = await createInvoice(A(), "owner", {
        customerId,
        lines: [
          { description: "Hull repair", qty: 1, unit: "job", unitPriceMinor: 100_000, vatRate: 5 },
        ],
      });
      invoiceId = inv.id;
      await issueInvoice(A(), "owner", invoiceId);
      const e = await entryFor("invoice", invoiceId, "issued");
      expect(e?.status).toBe("posted");
      expect(e?.td).toBe(105_000);
      const lines = await linesOf(e!.id);
      expect(lines.find((l) => l.k === "ar_control")).toMatchObject({
        d: 105_000,
        customer_id: customerId,
      });
      expect(lines.find((l) => l.k === "sales_revenue")).toMatchObject({ c: 100_000 });
      expect(lines.find((l) => l.k === "vat_output")).toMatchObject({ c: 5_000 });
    },
  );

  it("a credit note posts the exact mirror and nets AR", { timeout: 300_000 }, async () => {
    const inv2 = await createInvoice(A(), "owner", {
      customerId,
      lines: [
        { description: "Cancelled work", qty: 1, unit: "job", unitPriceMinor: 20_000, vatRate: 5 },
      ],
    });
    await issueInvoice(A(), "owner", inv2.id);
    const cn = await createCreditNote(A(), "owner", inv2.id, "work not performed");
    const e = await entryFor("invoice", cn.id, "issued");
    const lines = await linesOf(e!.id);
    expect(lines.find((l) => l.k === "ar_control")).toMatchObject({ c: 21_000 });
    expect(lines.find((l) => l.k === "sales_revenue")).toMatchObject({ d: 20_000 });
  });

  it(
    "recording a payment posts the receipt; voiding reverses it",
    { timeout: 300_000 },
    async () => {
      const p = await recordPayment(A(), "owner", {
        invoiceId,
        customerId,
        method: "bank_transfer",
        paymentDate: "2026-05-10",
        amountMinor: 60_000,
      });
      paymentId = p.id;
      const e = await entryFor("payment", paymentId, "received");
      expect(e?.status).toBe("posted");
      const lines = await linesOf(e!.id);
      expect(lines.find((l) => l.k === "bank_default")).toMatchObject({ d: 60_000 });
      expect(lines.find((l) => l.k === "ar_control")).toMatchObject({
        c: 60_000,
        customer_id: customerId,
      });

      await voidPayment(A(), "owner", paymentId, "bounced");
      const after = await entryFor("payment", paymentId, "received");
      expect(after?.status).toBe("reversed");
      const tb = await trialBalance(A(), "owner", {});
      expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
    },
  );

  it("an expense posts cost + input VAT; voiding reverses", { timeout: 300_000 }, async () => {
    const e = await createExpense(A(), "owner", {
      categoryKey,
      description: "Office supplies",
      expenseDate: "2026-05-12",
      amountMinor: 10_000,
      vatAmountMinor: 500,
    });
    const posted = await entryFor("expense", e.id, "recorded");
    expect(posted?.status).toBe("posted");
    const lines = await linesOf(posted!.id);
    expect(lines.find((l) => l.k === "overhead_expense")).toMatchObject({ d: 10_000 });
    expect(lines.find((l) => l.k === "vat_input")).toMatchObject({ d: 500 });
    expect(lines.find((l) => l.k === "accrued_expenses")).toMatchObject({ c: 10_500 });
    await voidExpense(A(), "owner", { expenseId: e.id, reason: "duplicate" });
    const after = await entryFor("expense", e.id, "recorded");
    expect(after?.status).toBe("reversed");
  });

  it("documents dated BEFORE the books start never post (D7)", { timeout: 300_000 }, async () => {
    const e = await createExpense(A(), "owner", {
      categoryKey,
      description: "Ancient history",
      expenseDate: "2025-06-01",
      amountMinor: 999,
      vatAmountMinor: 0,
    });
    const posted = await entryFor("expense", e.id, "recorded");
    expect(posted).toBeNull();
  });

  it(
    "allocation, ageing, statement and credit check recompute from the documents",
    { timeout: 300_000 },
    async () => {
      // A second payment, unlinked, allocated across the open invoice.
      const p2 = await recordPayment(A(), "owner", {
        customerId,
        method: "cash",
        paymentDate: "2026-05-20",
        amountMinor: 30_000,
      });
      await allocatePayment(A(), "owner", {
        paymentId: p2.id,
        allocations: [{ invoiceId, amountMinor: 30_000 }],
      });
      await expect(
        allocatePayment(A(), "owner", {
          paymentId: p2.id,
          allocations: [{ invoiceId, amountMinor: 1 }],
        }),
      ).rejects.toThrow(/exceeds/);

      const open = await arOpenItems(A(), "owner", { asOf: "2026-07-01" });
      const mine = open.find((o) => o.invoiceId === invoiceId);
      // 105,000 total − 30,000 allocated (the 60,000 direct payment was voided).
      expect(mine?.outstandingMinor).toBe(75_000);

      const ageing = await arAgeing(A(), "owner", { asOf: "2026-07-01" });
      expect(ageing.totalMinor).toBeGreaterThan(0);
      expect(ageing.buckets).toHaveLength(5);

      const stmt = await customerStatement(A(), "owner", { customerId });
      expect(stmt.rows.length).toBeGreaterThanOrEqual(3);
      expect(stmt.closingMinor).toBe(75_000 + 0); // invoice2 fully credited nets to 0

      await owner`update public.customer set credit_limit_minor = 50000 where id = ${customerId}`;
      const credit = await customerCreditCheck(A(), "owner", customerId);
      expect(credit.overLimit).toBe(true);

      const rec = await ledgerReconciliation(A(), "owner");
      expect(rec.drift).toHaveLength(0);
    },
  );
});

describe("accruals and templates", () => {
  it("an accrual posts with a DRAFT reversing mirror", { timeout: 300_000 }, async () => {
    const accrued = await withCtx(A(), (tx) => systemAccountIn(tx, A(), "accrued_expenses"));
    const overhead = await withCtx(A(), (tx) => systemAccountIn(tx, A(), "overhead_expense"));
    const r = await createReversingJournal(A(), "owner", {
      entryDate: "2026-05-31",
      reversalDate: "2026-06-01",
      memo: "May utilities accrual",
      lines: [
        { accountId: overhead, debitMinor: 4_000 },
        { accountId: accrued, creditMinor: 4_000 },
      ],
    });
    const main = await owner`select status from public.journal_entry where id = ${r.entryId}`;
    const mirror =
      await owner`select status from public.journal_entry where id = ${r.reversalDraftId}`;
    expect(main[0]!.status).toBe("posted");
    expect(mirror[0]!.status).toBe("draft");
  });

  it(
    "recurring templates come due and materialize drafts, advancing the schedule",
    { timeout: 300_000 },
    async () => {
      const cash = await withCtx(A(), (tx) => systemAccountIn(tx, A(), "cash_on_hand"));
      const overhead = await withCtx(A(), (tx) => systemAccountIn(tx, A(), "overhead_expense"));
      await saveJournalTemplate(A(), "owner", {
        name: "Monthly rent",
        lines: [
          { accountId: overhead, debitMinor: 12_000, description: "Rent" },
          { accountId: cash, creditMinor: 12_000 },
        ],
        recurrence: "monthly",
        nextRunOn: "2026-01-01",
      });
      const due = await dueTemplates(A(), "owner");
      const rent = due.find((d) => d.name === "Monthly rent");
      expect(rent).toBeDefined();
      const m = await materializeTemplate(A(), "owner", {
        templateId: rent!.id,
        entryDate: "2026-06-05",
      });
      const st = await owner`select status from public.journal_entry where id = ${m.entryId}`;
      expect(st[0]!.status).toBe("draft");
      const advanced = await owner`
      select next_run_on::text as n from public.journal_template where id = ${rent!.id}`;
      expect(advanced[0]!.n).toBe("2026-02-01");
    },
  );
});
