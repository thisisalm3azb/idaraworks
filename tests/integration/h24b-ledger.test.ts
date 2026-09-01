/**
 * H24B — the ledger invariants a screen can never prove.
 *
 * Everything here attacks the database on purpose: unbalanced entries, wrong
 * orgs, closed periods, double posting, tampering with posted rows — and
 * expects the DATABASE to refuse, not the UI.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, sql, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  createAccount,
  createFiscalYear,
  setPeriodStatus,
  createJournalEntry,
  postJournalEntry,
  reverseJournalEntry,
  cancelDraftJournal,
  postFromSourceIn,
  trialBalance,
  ledgerReconciliation,
} from "@/modules/finance/ledger";
import { command } from "@/platform/audit";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

/** Drizzle wraps DB errors; the real message lives down the cause chain. */
async function expectRefusal(p: Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    let m = "";
    let e: unknown = err;
    while (e) {
      m += " " + String((e as Error).message ?? e);
      e = (e as { cause?: unknown }).cause;
    }
    expect(m).toMatch(re);
    return;
  }
  throw new Error(`expected refusal matching ${re}`);
}

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";
let cash = "";
let revenue = "";
let vatOut = "";
let orgBAccount = "";

const ctxOf = (org: string, userId: string): Ctx => ({
  orgId: org,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h24b",
});
const A = () => ctxOf(orgA, userA);
const B2 = () => ctxOf(orgA, userB); // second user, same org

beforeAll(async () => {
  for (const [id, l] of [
    [userA, "a"],
    [userB, "b"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h24b-${l}-${run}@example.invalid`}, '{"full_name":"H24B"}'::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H24B A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "H24B B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h24b", run);
  await markFixtureOrg(owner, orgB, "h24b", run);
  await owner`
    insert into public.membership (user_id, org_id, role_key)
    values (${userB}, ${orgA}, 'accounts')`;

  await createFiscalYear(A(), "owner", {
    label: "FY2026",
    startsOn: "2026-01-01",
    endsOn: "2026-12-31",
  });
  cash = (
    await createAccount(A(), "owner", {
      code: "1000",
      nameEn: "Cash on hand",
      nameAr: "النقد",
      accountType: "asset",
    })
  ).id;
  revenue = (
    await createAccount(A(), "owner", {
      code: "4000",
      nameEn: "Revenue",
      nameAr: "الإيرادات",
      accountType: "income",
    })
  ).id;
  vatOut = (
    await createAccount(A(), "owner", {
      code: "2100",
      nameEn: "VAT output",
      accountType: "liability",
      isControl: true,
      controlKind: "tax",
    })
  ).id;
  orgBAccount = (
    await createAccount(ctxOf(orgB, userB), "owner", {
      code: "1000",
      nameEn: "Org B cash",
      accountType: "asset",
    })
  ).id;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB]);
  await owner.end();
  await closeAppDb();
}, 240_000);

describe("posting invariants live in the database", () => {
  it(
    "a balanced entry posts; an unbalanced one CANNOT, even by direct SQL",
    { timeout: 120_000 },
    async () => {
      const ok = await createJournalEntry(A(), "owner", {
        entryDate: "2026-03-10",
        memo: "Cash sale",
        lines: [
          { accountId: cash, debitMinor: 10_500 },
          { accountId: revenue, creditMinor: 10_500 },
        ],
      });
      await postJournalEntry(A(), "owner", ok.id);
      const posted = await owner`
      select status, period_id, total_debit_minor from public.journal_entry where id = ${ok.id}`;
      expect(posted[0]!.status).toBe("posted");
      expect(posted[0]!.period_id).not.toBeNull();
      expect(Number(posted[0]!.total_debit_minor)).toBe(10_500);

      const bad = await createJournalEntry(A(), "owner", {
        entryDate: "2026-03-10",
        lines: [
          { accountId: cash, debitMinor: 5_000 },
          { accountId: revenue, creditMinor: 4_999 },
        ],
      });
      await expectRefusal(postJournalEntry(A(), "owner", bad.id), /unbalanced/i);
      // Direct SQL flip — the entry guard refuses outside the posting function,
      // even for the table owner.
      await expectRefusal(
        owner`update public.journal_entry set status = 'posted' where id = ${bad.id}`,
        /posting functions/,
      );
      // And an entry cannot be BORN posted.
      await expectRefusal(
        owner`
      insert into public.journal_entry
        (org_id, entry_no, entry_date, currency, base_currency, status, created_by)
      values (${orgA}, ${"HACK-" + run}, '2026-03-10', 'AED', 'AED', 'posted', ${userA})
    `,
        /created as a draft/,
      );
    },
  );

  it("cross-organization accounts cannot mix (composite FK)", { timeout: 120_000 }, async () => {
    await expect(
      createJournalEntry(A(), "owner", {
        entryDate: "2026-03-11",
        lines: [
          { accountId: orgBAccount, debitMinor: 1_000 },
          { accountId: revenue, creditMinor: 1_000 },
        ],
      }),
    ).rejects.toThrow();
  });

  it("closed and missing periods refuse postings", { timeout: 120_000 }, async () => {
    const feb = await owner`
      select id::text as id from public.fiscal_period
      where org_id = ${orgA} and starts_on = '2026-02-01'`;
    await setPeriodStatus(A(), "owner", { periodId: feb[0]!.id, status: "locked" });
    const inFeb = await createJournalEntry(A(), "owner", {
      entryDate: "2026-02-15",
      lines: [
        { accountId: cash, debitMinor: 100 },
        { accountId: revenue, creditMinor: 100 },
      ],
    });
    await expectRefusal(postJournalEntry(A(), "owner", inFeb.id), /locked|closed/i);

    const noPeriod = await createJournalEntry(A(), "owner", {
      entryDate: "2031-01-05",
      lines: [
        { accountId: cash, debitMinor: 100 },
        { accountId: revenue, creditMinor: 100 },
      ],
    });
    await expectRefusal(postJournalEntry(A(), "owner", noPeriod.id), /no fiscal period/i);
    await cancelDraftJournal(A(), "owner", noPeriod.id);
    const st = await owner`select status from public.journal_entry where id = ${noPeriod.id}`;
    expect(st[0]!.status).toBe("cancelled");
  });

  it(
    "control accounts refuse ordinary journals and accept posting rules",
    { timeout: 120_000 },
    async () => {
      const direct = await createJournalEntry(A(), "owner", {
        entryDate: "2026-03-12",
        lines: [
          { accountId: cash, debitMinor: 500 },
          { accountId: vatOut, creditMinor: 500 },
        ],
      });
      await expectRefusal(postJournalEntry(A(), "owner", direct.id), /control accounts/);

      const viaRule = await command(
        A(),
        {
          audit: {
            action: "finance.journal.post",
            entityType: "journal_entry",
            entityId: randomUUID(),
            summary: "test rule",
          },
        },
        (tx) =>
          postFromSourceIn(tx, A(), {
            sourceType: "invoice",
            sourceId: randomUUID(),
            eventKey: "test:control",
            ruleKey: "test.control",
            ruleVersion: "t1",
            journalKind: "sales",
            entryDate: "2026-03-12",
            currency: "AED",
            exchangeRate: 1,
            controlOk: true,
            lines: [
              { accountId: cash, debitMinor: 500 },
              { accountId: vatOut, creditMinor: 500 },
            ],
          }),
      );
      expect(viaRule.alreadyPosted).toBe(false);
    },
  );

  it(
    "one source event posts ONCE across retries and two concurrent users",
    { timeout: 300_000 },
    async () => {
      const sourceId = randomUUID();
      const post = (ctx: Ctx) =>
        command(
          ctx,
          {
            audit: {
              action: "finance.journal.post",
              entityType: "journal_entry",
              entityId: sourceId,
              summary: "race",
            },
          },
          (tx) =>
            postFromSourceIn(tx, ctx, {
              sourceType: "invoice",
              sourceId,
              eventKey: "issued",
              ruleKey: "test.race",
              ruleVersion: "t1",
              journalKind: "sales",
              entryDate: "2026-03-13",
              currency: "AED",
              exchangeRate: 1,
              lines: [
                { accountId: cash, debitMinor: 7_777 },
                { accountId: revenue, creditMinor: 7_777 },
              ],
            }),
        );
      const [r1, r2] = await Promise.all([post(A()), post(B2())]);
      expect([r1.alreadyPosted, r2.alreadyPosted].filter((x) => x)).toHaveLength(1);
      expect(r1.entryId === r2.entryId).toBe(true);
      // Retry after the fact: same entry again.
      const r3 = await post(A());
      expect(r3.alreadyPosted).toBe(true);
      expect(r3.entryId).toBe(r1.entryId);
      const count = await owner`
      select count(*)::int as n from public.journal_entry
      where org_id = ${orgA} and source_id = ${sourceId} and status = 'posted'`;
      expect(count[0]!.n).toBe(1);
    },
  );

  it(
    "reversal mirrors exactly and refuses locked dates; posted rows are immutable",
    { timeout: 120_000 },
    async () => {
      const e = await createJournalEntry(A(), "owner", {
        entryDate: "2026-04-05",
        memo: "To be reversed",
        lines: [
          { accountId: cash, debitMinor: 4_242 },
          { accountId: revenue, creditMinor: 4_242 },
        ],
      });
      await postJournalEntry(A(), "owner", e.id);

      // Reversing into the locked February is refused.
      await expectRefusal(
        reverseJournalEntry(A(), "owner", { entryId: e.id, date: "2026-02-20", memo: "bad date" }),
        /open period/,
      );

      const rev = await reverseJournalEntry(A(), "owner", {
        entryId: e.id,
        date: "2026-04-06",
        memo: "wrong amount",
      });
      const lines = await owner`
      select debit_minor::int as d, credit_minor::int as c, account_id::text as a
      from public.journal_line where entry_id = ${rev.reversalId} order by line_no`;
      expect(lines).toEqual([
        { d: 0, c: 4_242, a: cash },
        { d: 4_242, c: 0, a: revenue },
      ]);
      const orig = await owner`
      select status, reversed_by_entry_id::text as rb from public.journal_entry where id = ${e.id}`;
      expect(orig[0]!.status).toBe("reversed");
      expect(orig[0]!.rb).toBe(rev.reversalId);
      // A reversed entry cannot be reversed again.
      await expectRefusal(
        reverseJournalEntry(A(), "owner", { entryId: e.id, date: "2026-04-07", memo: "again" }),
        /only a posted/i,
      );

      // Immutability: no path updates or deletes posted lines — not the app user,
      // not even the table owner.
      await expectRefusal(
        owner`update public.journal_line set debit_minor = 1, credit_minor = 0 where entry_id = ${e.id}`,
        /cannot change/,
      );
      await expectRefusal(
        owner`delete from public.journal_line where entry_id = ${e.id}`,
        /cannot change/,
      );
      await expect(owner`delete from public.journal_entry where id = ${e.id}`).rejects.toThrow();
      await expectRefusal(
        withCtx(A(), (tx) =>
          tx.execute(sql`update public.journal_entry set memo = 'tampered' where id = ${e.id}`),
        ),
        /immutable/,
      );
    },
  );

  it(
    "the trial balance recomputes from lines and reconciliation reports (not repairs) corruption",
    { timeout: 120_000 },
    async () => {
      const tb = await trialBalance(A(), "owner", {});
      expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
      expect(tb.totalDebitMinor).toBeGreaterThan(0);
      const clean = await ledgerReconciliation(A(), "owner");
      expect(clean.drift).toHaveLength(0);

      // Simulate storage-level corruption (replica mode bypasses the guards —
      // something no application path can do) and prove it is REPORTED.
      const victim = await owner`
      select id::text as id from public.journal_entry
      where org_id = ${orgA} and status = 'posted' limit 1`;
      await owner.begin(async (tx) => {
        await tx.unsafe("set local session_replication_role = replica");
        await tx.unsafe(
          `update public.journal_entry set total_debit_minor = total_debit_minor + 1 where id = $1`,
          [victim[0]!.id],
        );
      });
      const dirty = await ledgerReconciliation(A(), "owner");
      expect(dirty.drift.length).toBe(1);
      expect(dirty.drift[0]!.kind).toBe("totals_mismatch");
      // Put the truth back the same way (test hygiene).
      await owner.begin(async (tx) => {
        await tx.unsafe("set local session_replication_role = replica");
        await tx.unsafe(
          `update public.journal_entry set total_debit_minor = total_debit_minor - 1 where id = $1`,
          [victim[0]!.id],
        );
      });
    },
  );
});
