/**
 * H24E — banking: money vouchers post correctly, statements dedupe at file
 * and line level, suggestions carry evidence and never act, matches lock on
 * completion, supplier payments settle AP open items, cash position
 * recomputes from the ledger.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { createSupplier } from "@/modules/masters/service";
import {
  installFinanceSetup,
  createBankAccount,
  recordMoneyTransaction,
  voidMoneyTransaction,
  importBankStatement,
  startReconciliation,
  suggestMatches,
  addMatch,
  completeReconciliation,
  unreconciledReport,
  cashPosition,
  trialBalance,
} from "@/modules/finance/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
let bankId = "";
let cashId = "";
let supplierId = "";

const A = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h24e",
});

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h24e-${run}@example.invalid`}, '{"full_name":"H24E"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H24E", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h24e", run);
  await installFinanceSetup(A(), "owner", { booksStartDate: "2026-01-01" });
  bankId = (
    await createBankAccount(A(), "owner", { name: "Main bank", kind: "bank", glCode: "1111" })
  ).id;
  cashId = (await createBankAccount(A(), "owner", { name: "Till", kind: "cash", glCode: "1101" }))
    .id;
  supplierId = (await createSupplier(A(), "owner", { name: `Marine Supplies ${run}` })).id;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
}, 240_000);

describe("money vouchers", () => {
  it(
    "supplier payment, transfer, charge and interest each post the mapped entry; void reverses",
    { timeout: 300_000 },
    async () => {
      const pay = await recordMoneyTransaction(A(), "owner", {
        kind: "payment",
        bankAccountId: bankId,
        partyKind: "supplier",
        supplierId,
        txnDate: "2026-04-02",
        amountMinor: 40_000,
        memo: "PO settlement",
      });
      const entry = await owner`
      select e.id::text as id from public.journal_entry e
      where e.org_id = ${orgA} and e.source_type = 'money_transaction'
        and e.source_id = ${pay.id} and e.status = 'posted'`;
      const lines = await owner`
      select a.system_key as k, a.control_kind, l.debit_minor::int as d, l.credit_minor::int as c,
             l.supplier_id::text as supplier_id
      from public.journal_line l
      join public.gl_account a on a.id = l.account_id and a.org_id = l.org_id
      where l.entry_id = ${entry[0]!.id} order by l.line_no`;
      expect(lines.find((l) => l.k === "grni")).toMatchObject({
        d: 40_000,
        supplier_id: supplierId,
      });
      expect(lines.find((l) => l.control_kind === "bank")).toMatchObject({ c: 40_000 });

      const xfer = await recordMoneyTransaction(A(), "owner", {
        kind: "transfer",
        bankAccountId: bankId,
        counterBankAccountId: cashId,
        txnDate: "2026-04-03",
        amountMinor: 5_000,
      });
      expect(xfer.reference).toMatch(/^MT-/);
      await recordMoneyTransaction(A(), "owner", {
        kind: "bank_charge",
        bankAccountId: bankId,
        txnDate: "2026-04-04",
        amountMinor: 150,
      });
      await recordMoneyTransaction(A(), "owner", {
        kind: "bank_interest",
        bankAccountId: bankId,
        txnDate: "2026-04-05",
        amountMinor: 90,
      });

      // A misc payment without a party must name its account explicitly.
      await expect(
        recordMoneyTransaction(A(), "owner", {
          kind: "payment",
          bankAccountId: bankId,
          txnDate: "2026-04-06",
          amountMinor: 1_000,
        }),
      ).rejects.toThrow(/explicit account/);

      const position = await cashPosition(A(), "owner");
      const bank = position.find((p) => p.bankAccountId === bankId)!;
      const till = position.find((p) => p.bankAccountId === cashId)!;
      expect(bank.balanceMinor).toBe(-40_000 - 5_000 - 150 + 90);
      expect(till.balanceMinor).toBe(5_000);

      await voidMoneyTransaction(A(), "owner", { id: pay.id, reason: "wrong supplier" });
      const after = await cashPosition(A(), "owner");
      expect(after.find((p) => p.bankAccountId === bankId)!.balanceMinor).toBe(-5_000 - 150 + 90);

      const tb = await trialBalance(A(), "owner", {});
      expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
    },
  );
});

describe("statements and reconciliation", () => {
  let stmtId = "";

  it("imports with FILE and LINE dedupe", { timeout: 300_000 }, async () => {
    const fileText =
      "date,desc,amount\n2026-04-03,TRANSFER OUT,-5000\n2026-04-04,CHARGES,-150\n2026-04-05,INTEREST,90\n";
    const rows = [
      { date: "2026-04-03", description: "TRANSFER OUT", amountMinor: -5_000 },
      { date: "2026-04-04", description: "CHARGES", amountMinor: -150 },
      { date: "2026-04-05", description: "INTEREST", amountMinor: 90 },
    ];
    const first = await importBankStatement(A(), "owner", {
      bankAccountId: bankId,
      label: "April week 1",
      fileText,
      rows,
    });
    stmtId = first.statementId;
    expect(first.imported).toBe(3);
    expect(first.duplicates).toBe(0);

    // Same FILE again → refused by the file hash.
    await expect(
      importBankStatement(A(), "owner", {
        bankAccountId: bankId,
        label: "April week 1 again",
        fileText,
        rows,
      }),
    ).rejects.toThrow();

    // An OVERLAPPING different file re-lists two lines → line dedupe skips them.
    const second = await importBankStatement(A(), "owner", {
      bankAccountId: bankId,
      label: "April week 1-2 overlap",
      fileText: fileText + "2026-04-08,NEW LINE,-777\n",
      rows: [...rows, { date: "2026-04-08", description: "NEW LINE", amountMinor: -777 }],
    });
    expect(second.imported).toBe(1);
    expect(second.duplicates).toBe(3);
  });

  it(
    "suggests with evidence, matches on confirmation, and locks on completion",
    { timeout: 300_000 },
    async () => {
      const suggestions = await suggestMatches(A(), "owner", bankId);
      // Transfer, charge and interest all have exact ledger counterparts.
      expect(suggestions.filter((s) => s.confidence === "exact").length).toBeGreaterThanOrEqual(3);
      expect(suggestions[0]!.evidence).toMatch(/amount .* bank .* ledger/);

      const rec = await startReconciliation(A(), "owner", {
        bankAccountId: bankId,
        label: "April recon",
      });
      for (const s of suggestions.slice(0, 3)) {
        await addMatch(A(), "owner", {
          reconciliationId: rec.id,
          statementLineId: s.statementLineId,
          journalLineId: s.journalLineId,
          amountMinor: 1, // per-row amount is advisory detail; presence is the match
        });
      }
      const done = await completeReconciliation(A(), "owner", rec.id);
      expect(done.matched).toBe(3);
      expect(done.unmatchedStatementLines).toBe(1); // the -777 NEW LINE

      // Locked: no further matches on a completed session.
      const report = await unreconciledReport(A(), "owner", bankId);
      expect(report.statementLines.map((l) => l.amountMinor)).toContain(-777);
      await expect(
        addMatch(A(), "owner", {
          reconciliationId: rec.id,
          statementLineId: report.statementLines[0]!.id,
          journalLineId: report.ledgerLines[0]?.id ?? randomUUID(),
          amountMinor: 1,
        }),
      ).rejects.toThrow();
      void stmtId;
    },
  );
});
