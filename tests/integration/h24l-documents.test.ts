/**
 * H24L — finance documents through the ONE document pipeline.
 *
 * Properties: a journal voucher renders the posted entry with balanced totals
 * in both languages; the statement documents recompute from the ledger at
 * render time; a receipt voucher refuses to impersonate a payment voucher;
 * the VAT working paper renders the STORED working data behind the tax
 * preparation lane (a viewer holds finance.view but not tax.prepare); an
 * unknown or malformed id is a not-found, never a crash.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { ForbiddenError } from "@/platform/authz";
import { createCustomer } from "@/modules/masters/service";
import { createInvoice, issueInvoice } from "@/modules/invoices/service";
import {
  installFinanceSetup,
  installUaeVatPack,
  setVatProfile,
  prepareVatReturn,
  createBankAccount,
  recordMoneyTransaction,
  journalRegister,
} from "@/modules/finance/service";
import { documentModel, documentHtml } from "@/modules/documents/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
let customerId = "";
let postedEntryId = "";
let receiptTxnId = "";
let vatReturnId = "";

const A = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h24l",
});

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h24l-${run}@example.invalid`}, '{"full_name":"H24L"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H24L", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h24l", run);
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  await installFinanceSetup(A(), "owner", { booksStartDate: "2026-01-01" });
  await installUaeVatPack(A(), "owner");
  await setVatProfile(A(), "owner", {
    trn: "100123456700003",
    emirate: "DXB",
    periodicity: "quarterly",
    registered: true,
  });
  customerId = (await createCustomer(A(), "owner", { name: `Coral Marine ${run}` })).id;
  const inv = await createInvoice(A(), "owner", {
    customerId,
    lines: [
      { description: "Deck refit", qty: 1, unit: "job", unitPriceMinor: 120_000, vatRate: 5 },
    ],
  });
  await issueInvoice(A(), "owner", inv.id);
  const sales = await journalRegister(A(), "owner", { kind: "sales" });
  postedEntryId = sales.rows[0]!.entryId;

  const bank = await createBankAccount(A(), "owner", {
    name: "Operating account",
    glCode: "1021",
  });
  receiptTxnId = (
    await recordMoneyTransaction(A(), "owner", {
      kind: "receipt",
      bankAccountId: bank.id,
      partyKind: "customer",
      customerId,
      txnDate: "2026-09-01",
      amountMinor: 50_000,
      memo: "On-account receipt",
    })
  ).id;

  vatReturnId = (
    await prepareVatReturn(A(), "owner", { periodStart: "2026-07-01", periodEnd: "2026-09-30" })
  ).returnId;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
}, 240_000);

describe("finance documents render through the one pipeline", () => {
  it(
    "journal voucher: balanced, bilingual, watermark-free once posted",
    { timeout: 300_000 },
    async () => {
      const model = await documentModel(A(), "owner", {
        kind: "journal_voucher",
        id: postedEntryId,
        language: "en",
      });
      expect(model.watermark ?? null).toBeNull();
      expect(model.sections[0]!.lines.length).toBeGreaterThanOrEqual(2);
      const en = await documentHtml(A(), "owner", {
        kind: "journal_voucher",
        id: postedEntryId,
        language: "en",
      });
      expect(en).toContain("Journal voucher");
      const ar = await documentHtml(A(), "owner", {
        kind: "journal_voucher",
        id: postedEntryId,
        language: "ar",
      });
      expect(ar).toContain("سند قيد");
    },
  );

  it("statement documents recompute from the ledger", { timeout: 300_000 }, async () => {
    const tb = await documentModel(A(), "owner", {
      kind: "trial_balance",
      id: "2026-12-31",
      language: "en",
    });
    // Total debits and total credits are the last two totals — equal strings.
    expect(tb.totals!.at(-1)!.value).toBe(tb.totals!.at(-2)!.value);

    const soa = await documentModel(A(), "owner", {
      kind: "customer_statement",
      id: customerId,
      language: "en",
    });
    expect(soa.recipient?.name).toContain("Coral Marine");
    expect(soa.sections[0]!.lines.length).toBeGreaterThanOrEqual(1);

    const bs = await documentHtml(A(), "owner", {
      kind: "balance_sheet",
      id: "2026-12-31",
      language: "ar",
    });
    expect(bs).toContain("الميزانية العمومية");

    await expect(
      documentModel(A(), "owner", { kind: "profit_loss", id: "not-a-range", language: "en" }),
    ).rejects.toThrow();
  });

  it("a receipt voucher never impersonates a payment voucher", { timeout: 300_000 }, async () => {
    const rv = await documentModel(A(), "owner", {
      kind: "receipt_voucher",
      id: receiptTxnId,
      language: "en",
    });
    expect(rv.titleEn).toBe("Receipt voucher");
    expect(rv.recipient?.name).toContain("Coral Marine");
    await expect(
      documentModel(A(), "owner", { kind: "payment_voucher", id: receiptTxnId, language: "en" }),
    ).rejects.toThrow(/payment_voucher/);
  });

  it(
    "VAT working paper: stored data, disclaimer, preparation lane",
    { timeout: 300_000 },
    async () => {
      const model = await documentModel(A(), "owner", {
        kind: "vat_working",
        id: vatReturnId,
        language: "en",
      });
      expect(model.watermark).toBe("draft"); // still a draft return
      expect(model.terms).toMatch(/does not file/i);
      const boxLines = model.sections[0]!.lines;
      expect(boxLines.some((l) => l.position === "1b")).toBe(true);
      // finance.view is not enough for a working paper — the viewer archetype
      // reads statements but not tax preparation.
      await expect(
        documentModel(A(), "viewer", { kind: "vat_working", id: vatReturnId, language: "en" }),
      ).rejects.toThrow(ForbiddenError);
    },
  );
});
