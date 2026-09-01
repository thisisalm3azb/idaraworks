/**
 * H24J — Tally migration: inspected, mapped by a human, dry-run first,
 * idempotent on approval, and honest about what it will not do.
 *
 * Properties: the same bytes re-uploaded return the SAME batch; nothing posts
 * before a human maps ledgers and runs the dry run; vouchers dated before the
 * books start and unbalanced vouchers are EXCEPTIONS, never postings; the
 * one-event-once index makes re-approval a no-op; the imported totals land in
 * the ledger exactly once.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import {
  installFinanceSetup,
  listAccounts,
  inspectTallyFile,
  mapTallyLedgers,
  dryRunTallyImport,
  approveTallyImport,
  trialBalance,
} from "@/modules/finance/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
let bankAccountId = "";
let salesAccountId = "";

const A = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h24j",
});

// Tally convention: a NEGATIVE amount is a debit. Voucher 2 predates the
// books; voucher 3 does not balance.
const VOUCHERS_XML = `<?xml version="1.0"?>
<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
<TALLYMESSAGE>
 <VOUCHER VCHTYPE="Receipt">
  <DATE>20260510</DATE>
  <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
  <VOUCHERNUMBER>R-101</VOUCHERNUMBER>
  <NARRATION>Charter deposit</NARRATION>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank of Sharjah</LEDGERNAME><AMOUNT>-1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Charter Income</LEDGERNAME><AMOUNT>1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
 </VOUCHER>
</TALLYMESSAGE>
<TALLYMESSAGE>
 <VOUCHER VCHTYPE="Receipt">
  <DATE>20251201</DATE>
  <VOUCHERNUMBER>R-090</VOUCHERNUMBER>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank of Sharjah</LEDGERNAME><AMOUNT>-500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Charter Income</LEDGERNAME><AMOUNT>500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
 </VOUCHER>
</TALLYMESSAGE>
<TALLYMESSAGE>
 <VOUCHER VCHTYPE="Journal">
  <DATE>20260601</DATE>
  <VOUCHERNUMBER>J-007</VOUCHERNUMBER>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank of Sharjah</LEDGERNAME><AMOUNT>-250.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Charter Income</LEDGERNAME><AMOUNT>200.00</AMOUNT></ALLLEDGERENTRIES.LIST>
 </VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

const MASTERS_XML = `<?xml version="1.0"?>
<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
<TALLYMESSAGE><LEDGER NAME="Bank of Sharjah"><PARENT>Bank Accounts</PARENT></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="Charter Income"><PARENT>Sales Accounts</PARENT></LEDGER></TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

const CSV = [
  "date,voucher_no,ledger,debit,credit,narration",
  "2026-07-01,C-1,Bank of Sharjah,300.00,0,fuel refund",
  "2026-07-01,C-1,Charter Income,0,300.00,fuel refund",
].join("\n");

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h24j-${run}@example.invalid`}, '{"full_name":"H24J"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H24J", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h24j", run);
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  await installFinanceSetup(A(), "owner", { booksStartDate: "2026-01-01" });
  const accounts = await listAccounts(A(), "owner");
  bankAccountId = accounts.find((a) => a.systemKey === "bank_default")!.id;
  salesAccountId = accounts.find((a) => a.systemKey === "sales_revenue")!.id;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
}, 240_000);

describe("Tally migration", () => {
  it(
    "guided flow: inspect, dedupe, map, dry-run, approve ONCE, reconcile",
    { timeout: 600_000 },
    async () => {
      // Masters file: parsed, listed, never postable.
      const masters = await inspectTallyFile(A(), "owner", {
        filename: "masters.xml",
        content: MASTERS_XML,
      });
      expect(masters.format).toBe("tally_xml_masters");
      expect(masters.summary.ledgers).toContain("Bank of Sharjah");
      await expect(dryRunTallyImport(A(), "owner", masters.importId)).rejects.toThrow(
        /masters file/,
      );

      // Voucher file: three vouchers, and the SAME bytes return the SAME batch.
      const first = await inspectTallyFile(A(), "owner", {
        filename: "daybook.xml",
        content: VOUCHERS_XML,
      });
      expect(first.format).toBe("tally_xml_vouchers");
      expect(first.summary.voucherCount).toBe(3);
      expect(first.alreadyUploaded).toBe(false);
      const again = await inspectTallyFile(A(), "owner", {
        filename: "daybook-copy.xml",
        content: VOUCHERS_XML,
      });
      expect(again.importId).toBe(first.importId);
      expect(again.alreadyUploaded).toBe(true);

      // Mapping is a human decision, and only to real live accounts.
      await expect(
        mapTallyLedgers(A(), "owner", {
          importId: first.importId,
          map: { "Bank of Sharjah": randomUUID() },
        }),
      ).rejects.toThrow(/unknown account/);
      const mapped = await mapTallyLedgers(A(), "owner", {
        importId: first.importId,
        map: { "Bank of Sharjah": bankAccountId, "Charter Income": salesAccountId },
      });
      expect(mapped.unmapped).toEqual([]);

      // Dry run: one postable, two exceptions with NAMED reasons; totals shown
      // for the human's trial-balance comparison.
      const dry = await dryRunTallyImport(A(), "owner", first.importId);
      expect(dry.postable).toBe(1);
      expect(dry.exceptions).toHaveLength(2);
      expect(dry.exceptions.some((e) => e.reason.includes("books start"))).toBe(true);
      expect(dry.exceptions.some((e) => e.reason.includes("does not balance"))).toBe(true);
      expect(dry.totalDebitMinor).toBe(100_000);
      expect(dry.totalCreditMinor).toBe(100_000);

      // Approve posts exactly once; re-approval is a no-op.
      const imported = await approveTallyImport(A(), "owner", first.importId);
      expect(imported.posted).toBe(1);
      expect(imported.alreadyPosted).toBe(0);
      const rerun = await approveTallyImport(A(), "owner", first.importId);
      expect(rerun.posted).toBe(0);
      expect(rerun.alreadyPosted).toBe(1);
      const entries = await owner`
        select count(*)::int as n from public.journal_entry
        where org_id = ${orgA} and source_type = 'tally_import' and status = 'posted'`;
      expect(entries[0]!.n).toBe(1);

      // The ledger holds the voucher once: 1,000.00 in bank and sales.
      const tb = await trialBalance(A(), "owner", {});
      const bank = tb.rows.find((r) => r.accountId === bankAccountId);
      expect(bank?.debitMinor).toBe(100_000);
      expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
    },
  );

  it(
    "CSV imports through the same gate, and never without a dry run",
    { timeout: 300_000 },
    async () => {
      const csv = await inspectTallyFile(A(), "owner", { filename: "extra.csv", content: CSV });
      expect(csv.format).toBe("csv");
      expect(csv.summary.voucherCount).toBe(1);
      await mapTallyLedgers(A(), "owner", {
        importId: csv.importId,
        map: { "Bank of Sharjah": bankAccountId, "Charter Income": salesAccountId },
      });
      // Approval without a dry run is refused — imports are never a surprise.
      await expect(approveTallyImport(A(), "owner", csv.importId)).rejects.toThrow(/dry run/);
      const dry = await dryRunTallyImport(A(), "owner", csv.importId);
      expect(dry.postable).toBe(1);
      const imported = await approveTallyImport(A(), "owner", csv.importId);
      expect(imported.posted).toBe(1);
    },
  );
});
