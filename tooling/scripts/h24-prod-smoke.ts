/**
 * H24 end-to-end production smoke — one marked fixture, removed in `finally`.
 *
 * Proof that the finance system works on the real database and the real
 * deployed application, through the same module functions the screens call
 * plus the REAL HTTP document route. Every step asserts a property that would
 * be expensive to get wrong; the fixture self-destructs pass or fail.
 *
 * What it walks, in the order a bookkeeper does:
 *   1. books installed (chart + fiscal year + VAT pack + profile)
 *   2. an issued invoice POSTS once (AR / revenue / VAT output)
 *   3. a payment posts, then VOIDS via an explicit linked reversal
 *   4. an expense posts; an expense dated before the books start does NOT
 *   5. a manual journal: draft → posted → immutable AT THE DATABASE
 *      (owner connection, trigger fires) → reversed with links both ways
 *   6. AR open items are right; bill-by-bill allocation neither double-counts
 *      nor over-allocates
 *   7. banking: statement import, evidence-carrying suggestion, accepted
 *      match, completed reconciliation
 *   8. VAT201 working paper: correct boxes, zero control drift; CT workpaper
 *      from ledger accounting income at the verified bracket
 *   9. statements recompute balanced (trial balance, balance sheet identity)
 *  10. EN and AR PDFs from the DEPLOYED route — 200, application/pdf, %PDF
 *  11. viewer role refused for tax papers and posting
 *  12. the release gate: /finance answers not-found while the flag is off
 *      (pass --surfaces=on after enabling to assert the reverse)
 *
 * SAFETY: creates one marked organization and one user; touches nothing
 * else; cleanup runs in `finally`; residue and historical counts verified.
 *
 *   npx tsx tooling/scripts/h24-prod-smoke.ts --confirm=<production phrase>
 */
import { config } from "dotenv";

config({ path: [".env.local"], quiet: true });

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createCustomer } from "@/modules/masters/service";
import { createInvoice, issueInvoice } from "@/modules/invoices/service";
import { recordPayment, voidPayment } from "@/modules/payments/service";
import { createExpense, listExpenseCategories } from "@/modules/expenses/service";
import {
  installFinanceSetup,
  installUaeVatPack,
  setVatProfile,
  listAccounts,
  createJournalEntry,
  postJournalEntry,
  reverseJournalEntry,
  journalEntryDetail,
  trialBalance,
  balanceSheet,
  cashFlowStatement,
  arOpenItems,
  allocatePayment,
  createBankAccount,
  recordMoneyTransaction,
  importBankStatement,
  startReconciliation,
  suggestMatches,
  addMatch,
  completeReconciliation,
  prepareVatReturn,
  prepareCtWorkpaper,
  computeCtWorkpaper,
} from "@/modules/finance/service";
import { documentModel } from "@/modules/documents/service";
import {
  PRODUCTION_PROJECT_REF,
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const BASE = (process.env.PDF_VERIFY_BASE ?? "https://www.idaraworks.com").replace(/\/$/, "");
const MARKER = "smoke.h24";
const RUN = randomUUID().slice(0, 8);

const owner = postgres(process.env.DIRECT_URL!, {
  max: 1,
  connect_timeout: 60,
  onnotice: () => {},
});
let ownerUserId = "";
let orgId = "";
const ownerPassword = `Smoke-${randomUUID()}`;
const ownerEmail = `h24smoke-${RUN}@example.invalid`;

const A = (): Ctx => ({
  orgId,
  userId: ownerUserId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: `h24-smoke-${RUN}`,
});

let checks = 0;
function check(what: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) throw new Error(`FAILED: ${what}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ok: ${what}${detail ? ` (${detail})` : ""}`);
}

async function cleanup(): Promise<void> {
  if (!orgId) return;
  const tables = (await owner`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
    table_name: string;
  }>;
  await owner.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    for (const t of tables) {
      await tx.unsafe(`delete from public.${t.table_name} where org_id = $1`, [orgId]);
    }
    await tx.unsafe(`delete from public.org where id = $1`, [orgId]);
    if (ownerUserId) {
      await tx.unsafe(`delete from public.sign_in_log where user_id = $1`, [ownerUserId]);
      await tx.unsafe(`delete from public.user_profile where id = $1`, [ownerUserId]);
      // Sessions, refresh tokens and identities FIRST: deleting auth.users
      // alone leaves them orphaned on this instance — the exact residue
      // prod-health flags as a safety regression (learned from H23's runs).
      await tx.unsafe(`delete from auth.refresh_tokens where user_id = $1::text`, [ownerUserId]);
      await tx.unsafe(`delete from auth.sessions where user_id = $1`, [ownerUserId]);
      await tx.unsafe(`delete from auth.identities where user_id = $1`, [ownerUserId]);
      await tx.unsafe(`delete from auth.users where id = $1`, [ownerUserId]);
    }
  });
  const residue = (await owner`
    select
      (select count(*) from public.org where id = ${orgId}) +
      (select count(*) from public.app_settings where org_id = ${orgId}) +
      (select count(*) from public.journal_entry where org_id = ${orgId}) +
      (select count(*) from auth.users where id = ${ownerUserId || randomUUID()}) +
      (select count(*) from auth.identities where user_id = ${ownerUserId || randomUUID()}) +
      (select count(*) from auth.sessions where user_id = ${ownerUserId || randomUUID()})
      as n`) as unknown as Array<{ n: string }>;
  console.log(`cleanup: residue rows = ${residue[0]!.n} (must be 0)`);
  if (Number(residue[0]!.n) !== 0) throw new Error("RESIDUE LEFT — investigate immediately");
}

/** Sign the owner in against the deployed Supabase and build the SSR cookie. */
async function ownerCookie(): Promise<string> {
  const { createClient } = await import("@supabase/supabase-js");
  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await anon.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  if (error || !data.session) throw new Error(`owner sign-in failed: ${error?.message}`);
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];
  const value = "base64-" + Buffer.from(JSON.stringify(data.session), "utf8").toString("base64url");
  const CHUNK = 3180;
  if (value.length <= CHUNK) return `sb-${ref}-auth-token=${value}`;
  const parts: string[] = [];
  for (let i = 0; i * CHUNK < value.length; i++) {
    parts.push(`sb-${ref}-auth-token.${i}=${value.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
  return parts.join("; ");
}

async function fetchPdf(cookie: string, path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    head: buf.subarray(0, 5).toString("latin1"),
    bytes: buf.length,
  };
}

async function main(): Promise<void> {
  const confirmArg = process.argv
    .find((a) => a.startsWith("--confirm="))
    ?.slice("--confirm=".length);
  const surfaces = process.argv.includes("--surfaces=on") ? "on" : "off";
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    console.error("Refusing: environment does not point exclusively at production.");
    for (const p of target.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (confirmArg !== productionMigrationPhrase()) {
    console.error(`Refusing: pass --confirm=${productionMigrationPhrase()}`);
    process.exit(1);
  }
  const probe = (await owner`select current_database() as db`) as unknown as Array<{ db: string }>;
  console.log(
    `H24 production smoke against ${PRODUCTION_PROJECT_REF} (db=${probe[0]!.db}), run ${RUN}`,
  );

  const before = (await owner`
    select (select count(*) from public.org) as orgs,
           (select count(*) from public.invoice) as invoices,
           (select count(*) from public.payment) as payments,
           (select count(*) from public.expense) as expenses,
           (select count(*) from public.journal_entry) as entries`) as unknown as Array<
    Record<string, string>
  >;

  try {
    // ── fixture ────────────────────────────────────────────────────────────
    const { createClient } = await import("@supabase/supabase-js");
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    const created = await admin.auth.admin.createUser({
      email: ownerEmail,
      password: ownerPassword,
      email_confirm: true,
      user_metadata: { full_name: "H24 Smoke" },
    });
    if (created.error || !created.data.user)
      throw new Error(`createUser: ${created.error?.message}`);
    ownerUserId = created.data.user.id;
    await owner`
      insert into public.user_profile (id, full_name, locale)
      values (${ownerUserId}, 'H24 Smoke', 'en') on conflict (id) do nothing`;
    orgId = await createOrgForUser(ownerUserId, {
      name: `H24 Smoke ${RUN}`,
      country: "AE",
      baseCurrency: "AED",
    });
    await owner`
      insert into public.app_settings (org_id, key, value)
      values (${orgId}, ${MARKER}, ${JSON.stringify({ run: RUN })}::jsonb)`;
    await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
    console.log(`fixture org ${orgId}`);

    // ── 1. the books install ───────────────────────────────────────────────
    await installFinanceSetup(A(), "owner", { booksStartDate: "2026-01-01" });
    await installUaeVatPack(A(), "owner");
    await setVatProfile(A(), "owner", {
      trn: "100000000000003",
      emirate: "DXB",
      periodicity: "quarterly",
      registered: true,
    });
    const accounts = await listAccounts(A(), "owner");
    check("chart installed with system accounts", accounts.length >= 30, `${accounts.length}`);

    // ── 2. an issued invoice posts once ────────────────────────────────────
    const customer = await createCustomer(A(), "owner", { name: `Smoke Marine ${RUN}` });
    const inv = await createInvoice(A(), "owner", {
      customerId: customer.id,
      lines: [{ description: "Refit", qty: 1, unit: "job", unitPriceMinor: 200_000, vatRate: 5 }],
    });
    await issueInvoice(A(), "owner", inv.id);
    const invEntry = (await owner`
      select id::text as id, status, total_debit_minor::text as td from public.journal_entry
      where org_id = ${orgId} and source_type = 'invoice' and source_id = ${inv.id}`) as unknown as Array<
      Record<string, string>
    >;
    check(
      "invoice posted once (AR 210,000)",
      invEntry.length === 1 &&
        invEntry[0]!.status === "posted" &&
        Number(invEntry[0]!.td) === 210_000,
    );

    // ── 3. a payment posts, then voids via a linked reversal ───────────────
    const pay1 = await recordPayment(A(), "owner", {
      invoiceId: inv.id,
      customerId: customer.id,
      method: "bank_transfer",
      paymentDate: "2026-09-01",
      amountMinor: 50_000,
    });
    await voidPayment(A(), "owner", pay1.id, "smoke reversal proof");
    const reversal = (await owner`
      select count(*)::int as n from public.journal_entry
      where org_id = ${orgId} and source_id = ${pay1.id} and status in ('posted', 'reversed')`) as unknown as Array<{
      n: number;
    }>;
    check("voided payment left original + linked reversal", reversal[0]!.n === 2);

    const pay2 = await recordPayment(A(), "owner", {
      invoiceId: inv.id,
      customerId: customer.id,
      method: "bank_transfer",
      paymentDate: "2026-09-01",
      amountMinor: 100_000,
    });

    // ── 4. expenses respect the books-start gate ───────────────────────────
    const cats = await listExpenseCategories(A());
    const categoryKey = cats.find((c) => c.costingMapping === "overhead")?.key ?? cats[0]!.key;
    await createExpense(A(), "owner", {
      categoryKey,
      description: "Smoke dockage",
      expenseDate: "2026-06-10",
      amountMinor: 30_000,
      vatAmountMinor: 1_500,
    });
    const preBooks = await createExpense(A(), "owner", {
      categoryKey,
      description: "Smoke pre-books",
      expenseDate: "2025-06-10",
      amountMinor: 9_999,
      vatAmountMinor: 0,
    });
    const preEntry = (await owner`
      select count(*)::int as n from public.journal_entry
      where org_id = ${orgId} and source_id = ${preBooks.id}`) as unknown as Array<{ n: number }>;
    check("pre-books expense did NOT post (D7)", preEntry[0]!.n === 0);

    // ── 5. manual journal: draft → post → immutable → reversed ─────────────
    // Non-control accounts only: an ordinary journal touching a control
    // account is exactly what app.post_journal_entry refuses (proven above
    // by an earlier run of this very smoke).
    const misc = accounts.find((a) => a.systemKey === "overhead_expense")!.id;
    const accrual = accounts.find((a) => a.systemKey === "accrued_expenses")!.id;
    const je = await createJournalEntry(A(), "owner", {
      entryDate: "2026-09-01",
      memo: "smoke manual entry",
      lines: [
        { accountId: misc, debitMinor: 5_000, creditMinor: 0 },
        { accountId: accrual, debitMinor: 0, creditMinor: 5_000 },
      ],
    });
    await postJournalEntry(A(), "owner", je.id);
    let frozen = false;
    try {
      await owner`update public.journal_entry set memo = 'tampered' where id = ${je.id}`;
    } catch {
      frozen = true;
    }
    check("posted entry immutable at the database (owner connection)", frozen);
    const rev = await reverseJournalEntry(A(), "owner", {
      entryId: je.id,
      date: "2026-09-01",
      memo: "smoke reversal",
    });
    const revDetail = await journalEntryDetail(A(), "owner", rev.reversalId);
    check("reversal links both ways", revDetail.reversesEntryId === je.id);

    // ── 6. AR open items + bill-by-bill allocation ─────────────────────────
    let open = await arOpenItems(A(), "owner", {});
    check(
      "AR outstanding = 210,000 − 100,000",
      open.length === 1 && open[0]!.outstandingMinor === 110_000,
      `${open[0]?.outstandingMinor}`,
    );
    await allocatePayment(A(), "owner", {
      paymentId: pay2.id,
      allocations: [{ invoiceId: inv.id, amountMinor: 100_000 }],
    });
    open = await arOpenItems(A(), "owner", {});
    check(
      "allocation neither double-counts nor over-allocates",
      open.length === 1 && open[0]!.outstandingMinor === 110_000,
      `${open[0]?.outstandingMinor}`,
    );

    // ── 7. banking: import, suggest with evidence, match, complete ─────────
    const bank = await createBankAccount(A(), "owner", {
      name: `Smoke bank ${RUN}`,
      glCode: "1029",
    });
    await recordMoneyTransaction(A(), "owner", {
      kind: "receipt",
      bankAccountId: bank.id,
      partyKind: "customer",
      customerId: customer.id,
      txnDate: "2026-09-01",
      amountMinor: 25_000,
      memo: "smoke receipt",
    });
    const imported = await importBankStatement(A(), "owner", {
      bankAccountId: bank.id,
      label: "Smoke statement",
      fileText: "smoke,2026-09-01,25000",
      rows: [{ date: "2026-09-01", description: "smoke inbound", amountMinor: 25_000 }],
    });
    check("statement imported one line", imported.imported === 1);
    const recon = await startReconciliation(A(), "owner", {
      bankAccountId: bank.id,
      label: "Smoke recon",
    });
    const suggestions = await suggestMatches(A(), "owner", bank.id);
    check(
      "suggestion carries evidence, never auto-applies",
      suggestions.length >= 1 && suggestions[0]!.evidence.length > 0,
      suggestions[0]?.evidence,
    );
    await addMatch(A(), "owner", {
      reconciliationId: recon.id,
      statementLineId: suggestions[0]!.statementLineId,
      journalLineId: suggestions[0]!.journalLineId,
      amountMinor: 25_000,
    });
    const done = await completeReconciliation(A(), "owner", recon.id);
    check("reconciliation completed with the accepted match", done.matched === 1);

    // ── 8. tax working papers ──────────────────────────────────────────────
    const vat = await prepareVatReturn(A(), "owner", {
      periodStart: "2026-07-01",
      periodEnd: "2026-09-30",
    });
    const w = vat.working;
    check(
      "VAT201 box 1b = 200,000 / 10,000",
      w.boxes["1b"]?.baseMinor === 200_000 && w.boxes["1b"]?.taxMinor === 10_000,
    );
    check(
      "VAT control drift is zero",
      w.reconciliation.outputDriftMinor === 0 && w.reconciliation.inputDriftMinor === 0,
    );
    const ct = await prepareCtWorkpaper(A(), "owner", {
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
    });
    const ctc = await computeCtWorkpaper(A(), "owner", ct.returnId);
    check(
      "CT workpaper: ledger income, 0% below the bracket",
      ctc.taxMinor === 0 && ctc.accountingIncomeMinor > 0,
      `${ctc.accountingIncomeMinor}`,
    );

    // ── 9. statements recompute balanced ───────────────────────────────────
    const tb = await trialBalance(A(), "owner", {});
    check("trial balance balances", tb.totalDebitMinor === tb.totalCreditMinor);
    const bs = await balanceSheet(A(), "owner", { asOf: "2026-12-31" });
    check("balance sheet identity holds", bs.balancedMinor === 0);
    const cf = await cashFlowStatement(A(), "owner", { from: "2026-01-01", to: "2026-12-31" });
    check(
      "cash-flow groups sum to the cash movement",
      cf.operatingMinor + cf.investingMinor + cf.financingMinor === cf.netChangeMinor,
    );

    // ── 10. EN and AR PDFs from the DEPLOYED route ─────────────────────────
    const cookie = await ownerCookie();
    for (const [label, path] of [
      [
        "journal voucher EN",
        `/api/o/${orgId}/documents/journal_voucher/${je.id}?format=pdf&lang=en`,
      ],
      [
        "journal voucher AR",
        `/api/o/${orgId}/documents/journal_voucher/${je.id}?format=pdf&lang=ar`,
      ],
      ["trial balance EN", `/api/o/${orgId}/documents/trial_balance/2026-12-31?format=pdf&lang=en`],
      [
        "VAT working AR",
        `/api/o/${orgId}/documents/vat_working/${vat.returnId}?format=pdf&lang=ar`,
      ],
    ] as const) {
      const pdf = await fetchPdf(cookie, path);
      check(
        `${label} PDF from deployed route`,
        pdf.status === 200 && pdf.type.includes("application/pdf") && pdf.head === "%PDF-",
        `${pdf.status} ${pdf.type} ${pdf.bytes}b`,
      );
    }

    // ── 11. role separation ────────────────────────────────────────────────
    let viewerTaxRefused = false;
    try {
      await documentModel(A(), "viewer", {
        kind: "vat_working",
        id: vat.returnId,
        language: "en",
      });
    } catch {
      viewerTaxRefused = true;
    }
    check("viewer refused tax working papers", viewerTaxRefused);
    let viewerPostRefused = false;
    try {
      await createJournalEntry(A(), "viewer", {
        entryDate: "2026-09-01",
        lines: [
          { accountId: misc, debitMinor: 100, creditMinor: 0 },
          { accountId: accrual, debitMinor: 0, creditMinor: 100 },
        ],
      });
    } catch {
      viewerPostRefused = true;
    }
    check("viewer refused posting", viewerPostRefused);

    // ── 12. the release gate on the deployed app ───────────────────────────
    const gate = await fetch(`${BASE}/o/${orgId}/finance`, {
      headers: { cookie },
      redirect: "manual",
    });
    const gateBody = await gate.text();
    const showsNotFound = gateBody.includes("404") || gateBody.includes("could not be found");
    const showsFinance = gateBody.includes("Finance overview") || gateBody.includes("نظرة مالية");
    if (surfaces === "off") {
      check(
        "finance surfaces hidden while the flag is unset",
        (gate.status === 404 || (gate.status === 200 && showsNotFound)) && !showsFinance,
        `${gate.status} notFound=${showsNotFound} leaks=${showsFinance}`,
      );
    } else {
      check(
        "finance surfaces visible with the flag on",
        gate.status === 200 && showsFinance,
        `${gate.status} shows=${showsFinance}`,
      );
    }

    console.log(`\nALL ${checks} CHECKS PASSED (surfaces=${surfaces})`);
  } finally {
    await cleanup();
    const after = (await owner`
      select (select count(*) from public.org) as orgs,
             (select count(*) from public.invoice) as invoices,
             (select count(*) from public.payment) as payments,
             (select count(*) from public.expense) as expenses,
             (select count(*) from public.journal_entry) as entries`) as unknown as Array<
      Record<string, string>
    >;
    const same = JSON.stringify(before[0]) === JSON.stringify(after[0]);
    console.log(
      `historical counts intact: ${same} (before=${JSON.stringify(before[0])} after=${JSON.stringify(after[0])})`,
    );
    if (!same) process.exitCode = 1;
    await owner.end();
    await closeAppDb();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
