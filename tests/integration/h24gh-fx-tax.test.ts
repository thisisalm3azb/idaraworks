/**
 * H24G/H — rate book, budgets, and the tax engine.
 *
 * Properties: rates are suggestions with effective timestamps; budgets freeze
 * when approved and variance recomputes from the ledger; VAT facts are
 * captured at posting (credit notes net negatively), the VAT201 working
 * report groups by the official boxes, reconciles against the VAT control
 * accounts, lists unclassifiable documents as EXCEPTIONS, and locks
 * review→amend; the CT workpaper starts from ledger accounting income, takes
 * only explicit adjustments with legal sources, applies the ONLY verified
 * bracket, and never auto-elects reliefs.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createCustomer } from "@/modules/masters/service";
import { createInvoice, issueInvoice, createCreditNote } from "@/modules/invoices/service";
import { createExpense, listExpenseCategories } from "@/modules/expenses/service";
import {
  installFinanceSetup,
  installUaeVatPack,
  setVatProfile,
  prepareVatReturn,
  setReturnStatus,
  amendVatReturn,
  prepareCtWorkpaper,
  addCtAdjustment,
  computeCtWorkpaper,
  computeCtTax,
  setCurrencyRate,
  latestRate,
  saveBudget,
  setBudgetStatus,
  budgetVsActual,
  systemAccountIn,
  cashFlowForecast,
} from "@/modules/finance/service";
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
  requestId: "h24gh",
});

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h24gh-${run}@example.invalid`}, '{"full_name":"H24GH"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H24GH", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h24gh", run);
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  await installFinanceSetup(A(), "owner", { booksStartDate: "2026-01-01" });
  await installUaeVatPack(A(), "owner");
  await setVatProfile(A(), "owner", {
    trn: "100123456700003",
    emirate: "DXB",
    periodicity: "quarterly",
    registered: true,
  });
  customerId = (await createCustomer(A(), "owner", { name: `Gulf Marine ${run}` })).id;
  const cats = await listExpenseCategories(A());
  categoryKey = cats.find((c) => c.costingMapping === "overhead")?.key ?? cats[0]!.key;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
}, 240_000);

describe("VAT201 working papers", () => {
  it(
    "captures facts at posting, groups by official boxes, reconciles, excepts, locks and amends",
    { timeout: 600_000 },
    async () => {
      // Standard-rated sale (box 1b — Dubai profile), a credit note netting it,
      // and a recoverable expense (box 9).
      const inv = await createInvoice(A(), "owner", {
        customerId,
        lines: [
          { description: "Charter", qty: 1, unit: "job", unitPriceMinor: 200_000, vatRate: 5 },
        ],
      });
      await issueInvoice(A(), "owner", inv.id);
      const inv2 = await createInvoice(A(), "owner", {
        customerId,
        lines: [{ description: "Refit", qty: 1, unit: "job", unitPriceMinor: 40_000, vatRate: 5 }],
      });
      await issueInvoice(A(), "owner", inv2.id);
      await createCreditNote(A(), "owner", inv2.id, "cancelled charter");
      await createExpense(A(), "owner", {
        categoryKey,
        description: "Dockage",
        expenseDate: "2026-06-10",
        amountMinor: 30_000,
        vatAmountMinor: 1_500,
      });
      // An unclassifiable zero-VAT domestic invoice → EXCEPTION, not a guess.
      const oddball = await createInvoice(A(), "owner", {
        customerId,
        lines: [{ description: "Mystery", qty: 1, unit: "job", unitPriceMinor: 9_999, vatRate: 0 }],
      });
      await issueInvoice(A(), "owner", oddball.id);

      const prep = await prepareVatReturn(A(), "owner", {
        periodStart: "2026-04-01",
        periodEnd: "2026-09-30",
      });
      const w = prep.working;
      // Output: 200,000+40,000−40,000 = 200,000 base; 10,000+2,000−2,000 = 10,000 tax → box 1b.
      expect(w.boxes["1b"]).toMatchObject({ baseMinor: 200_000, taxMinor: 10_000 });
      expect(w.boxes["9"]).toMatchObject({ baseMinor: 30_000, taxMinor: 1_500 });
      expect(w.totals.netPayableMinor).toBe(10_000 - 1_500);
      expect(w.reconciliation.outputDriftMinor).toBe(0);
      expect(w.reconciliation.inputDriftMinor).toBe(0);
      expect(w.exceptions.some((e) => e.sourceType === "invoice")).toBe(true);

      await setReturnStatus(A(), "owner", { returnId: prep.returnId, status: "under_review" });
      await setReturnStatus(A(), "owner", { returnId: prep.returnId, status: "locked" });
      await expect(
        owner`update public.tax_return set working = '{}' where id = ${prep.returnId}`,
      ).rejects.toThrow();

      const amended = await amendVatReturn(A(), "owner", prep.returnId);
      const prior = await owner`
      select status from public.tax_return where id = ${prep.returnId}`;
      expect(prior[0]!.status).toBe("amended");
      const fresh = await owner`
      select amends_return_id::text as a from public.tax_return where id = ${amended.returnId}`;
      expect(fresh[0]!.a).toBe(prep.returnId);
    },
  );
});

describe("Corporate Tax workpaper", () => {
  it(
    "starts from ledger P&L, takes explicit adjustments, brackets correctly, never auto-elects",
    { timeout: 300_000 },
    async () => {
      // The ledger P&L so far: 200,000 revenue − 30,000 expense = 170,000.
      const wp = await prepareCtWorkpaper(A(), "owner", {
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
      });
      expect(wp.accountingIncomeMinor).toBe(209_999 - 30_000); // incl. the 9,999 oddball

      await addCtAdjustment(A(), "owner", {
        returnId: wp.returnId,
        ruleKey: "entertainment_50",
        sourceAmountMinor: 8_000,
        adjustmentMinor: 4_000,
        calculation: "8,000 entertainment × 50% non-deductible",
        evidence: "GL 6100 supplier dinner",
      });
      const c = await computeCtWorkpaper(A(), "owner", wp.returnId);
      expect(c.taxableIncomeMinor).toBe(179_999 + 4_000);
      // Below the AED 375,000 (minor 37,500,000) threshold → 0%.
      expect(c.taxMinor).toBe(0);
      expect(c.sbrApplied).toBe(false);
      expect(c.adjustments[0]).toMatchObject({
        ruleKey: "entertainment_50",
        legalSource: expect.stringContaining("47/2022"),
      });

      // The bracket math itself (the only auto-computed rule).
      expect(computeCtTax(37_500_000)).toBe(0);
      expect(computeCtTax(37_500_000 + 100)).toBe(9);
      expect(computeCtTax(100_000_000)).toBe(Math.floor(((100_000_000 - 37_500_000) * 9) / 100));

      // SBR needs an explicit election AND the revenue test AND the window.
      const withSbr = await computeCtWorkpaper(A(), "owner", wp.returnId, {
        sbrElected: true,
        sbrRevenueMinor: 2_000_000_00,
      });
      expect(withSbr.sbrApplied).toBe(true);
      expect(withSbr.taxMinor).toBe(0);
    },
  );
});

describe("rate book and budgets", () => {
  it(
    "rates are effective-dated suggestions; budgets freeze and variance recomputes",
    { timeout: 300_000 },
    async () => {
      await setCurrencyRate(A(), "owner", {
        fromCurrency: "USD",
        toCurrency: "AED",
        rate: 3.6725,
        effectiveAt: "2026-06-01T00:00:00Z",
      });
      await setCurrencyRate(A(), "owner", {
        fromCurrency: "USD",
        toCurrency: "AED",
        rate: 3.68,
        effectiveAt: "2026-07-01T00:00:00Z",
      });
      const june = await latestRate(A(), "USD", "AED", "2026-06-15T00:00:00Z");
      expect(june?.rate).toBe(3.6725);
      const now = await latestRate(A(), "USD", "AED");
      expect(now?.rate).toBe(3.68);

      const fy = await owner`
      select id::text as id from public.fiscal_year where org_id = ${orgA} limit 1`;
      const revenue = await withCtx(A(), (tx) => systemAccountIn(tx, A(), "sales_revenue"));
      const b = await saveBudget(A(), "owner", {
        fiscalYearId: fy[0]!.id,
        name: "FY26 plan",
        lines: [{ accountId: revenue, amountMinor: 500_000 }],
      });
      await setBudgetStatus(A(), "owner", { budgetId: b.id, status: "approved" });
      await expect(owner`
      insert into public.budget_line (org_id, budget_id, account_id, amount_minor)
      values (${orgA}, ${b.id}, ${revenue}, 1)
    `).rejects.toThrow(/cannot change/);

      const bva = await budgetVsActual(A(), "owner", b.id);
      expect(bva[0]).toMatchObject({
        budgetMinor: 500_000,
        actualMinor: 209_999,
        varianceMinor: -290_001,
      });

      const forecast = await cashFlowForecast(A(), "owner", { weeks: 4 });
      expect(forecast.weeks).toHaveLength(4);
    },
  );
});
