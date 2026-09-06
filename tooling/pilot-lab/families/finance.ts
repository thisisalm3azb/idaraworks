/**
 * H33 Pilot Lab — family `finance`: the accountant's half of the lab.
 *
 * Everything else in the lab creates business events; this family creates the
 * accounting a finance person opens the product to do — recurring journal
 * templates, a board-approved budget with a variance to look at, the manual
 * journals a month-end actually needs (accruals, prepayment releases, bank
 * charges, revaluation), bank statements reconciled against the ledger, and
 * VAT returns prepared from the real tax entries.
 *
 * ── Why so much of this goes through the services ──────────────────────────
 * The ledger is guarded by the database, not by convention: `journal_entry` is
 * BORN a draft (`app.journal_entry_born_draft`), lines freeze the moment it
 * posts (`app.journal_line_frozen`), and `app.post_journal_entry` is the only
 * door — it checks the entry balances in both currencies, that no line touches
 * a control account outside a posting rule, and that a fiscal period covers the
 * date AND is open. Bulk-inserting posted rows would mean disabling those
 * guards, which the lab's rules forbid and which would make every number in the
 * Accounting module untrustworthy. So journals are CREATED and POSTED through
 * `createJournalEntry` / `postJournalEntry`, one transaction each, and a
 * progress marker in `app_settings` makes a re-run resume rather than duplicate.
 *
 * ── What is planned and what is not ────────────────────────────────────────
 * `plan()` covers the three tables written in bulk (journal templates and the
 * budget). The service-driven rows — journals, statements, reconciliations,
 * VAT returns — are reported in `counts` after the fact, exactly as the sales
 * family reports its service sample, because their number depends on what the
 * ledger already contains.
 *
 * Nothing is filed with anybody: a VAT return is a working paper, it reaches
 * `locked` at most, and no authority is contacted.
 */
import { createHash } from "node:crypto";
import { CHART_TEMPLATE } from "@/modules/finance/chart";
import type { Check, Family, FamilyPlan, FamilyReport, LabContext } from "../types";

type Row = Record<string, unknown>;

/** Tables this family writes in bulk, and can therefore plan exactly. */
export const FINANCE_TABLES = ["journal_template", "budget", "budget_line"] as const;
export type FinanceTable = (typeof FINANCE_TABLES)[number];

/** Tables it fills through the product's own services; counted, never planned. */
export const FINANCE_SERVICE_TABLES = [
  "journal_entry",
  "journal_line",
  "bank_statement",
  "bank_statement_line",
  "bank_reconciliation",
  "bank_match",
  "tax_return",
] as const;

const PROGRESS_KEY = "h33.finance.service";

/**
 * Switches the service-driven half on. The orchestrator leaves it alone; the
 * unit test turns it off so the family runs with no database at all.
 */
export const financeRuntime = { live: true };

/** System keys of accounts the chart marks as CONTROL — reserved for the rules. */
export const CONTROL_SYSTEM_KEYS: ReadonlySet<string> = new Set(
  CHART_TEMPLATE.filter((a) => a.control && a.systemKey).map((a) => a.systemKey!),
);

/** The accounts a manual journal is allowed to touch. None is a control account. */
export const MANUAL_ACCOUNT_KEYS = [
  "overhead_expense",
  "accrued_expenses",
  "prepaid_expenses",
  "bank_charges",
  "fx_gain",
  "fx_loss",
  "other_income",
] as const;

// ── the month-end pattern ───────────────────────────────────────────────────

type LineSpec = {
  accountKey: string;
  debitMinor: number;
  creditMinor: number;
  description: string;
  costCentreKey?: string;
};

export type JournalSpec = {
  /** Stable key: the progress marker and the idempotency both hang off it. */
  key: string;
  entryDate: string;
  journalKind: string;
  memo: string;
  lines: LineSpec[];
  /** What should happen to it after creation. */
  outcome: "posted" | "draft" | "cancelled" | "reversed";
};

type MonthlySpec = {
  slug: string;
  kind: string;
  memo: string;
  debit: string;
  credit: string;
  /** Amount in minor units, before the per-month variation. */
  base: number;
};

const MONTHLY: MonthlySpec[] = [
  {
    slug: "rent_accrual",
    kind: "accrual",
    memo: "Month-end accrual: premises rent not yet invoiced",
    debit: "overhead_expense",
    credit: "accrued_expenses",
    base: 1_800_00,
  },
  {
    slug: "prepaid_release",
    kind: "adjustment",
    memo: "Release one month of the prepaid insurance premium",
    debit: "overhead_expense",
    credit: "prepaid_expenses",
    base: 640_00,
  },
  {
    slug: "bank_charges",
    kind: "general",
    memo: "Bank charges and transfer fees for the month",
    debit: "bank_charges",
    credit: "accrued_expenses",
    base: 85_00,
  },
  {
    slug: "utilities_accrual",
    kind: "accrual",
    memo: "Month-end accrual: utilities consumed, bill not yet received",
    debit: "overhead_expense",
    credit: "accrued_expenses",
    base: 1_150_00,
  },
];

export type FinanceModel = {
  /** Open fiscal periods, oldest first — the only dates a journal may post to. */
  openMonths: Array<{ periodId: string; year: number; periodNo: number; date: string }>;
  journals: JournalSpec[];
  accountKeys: string[];
  bankAccountId: string | null;
  bankGlAccountId: string | null;
  vatPeriods: Array<{ start: string; end: string; lock: boolean }>;
  rows: Record<FinanceTable, Row[]>;
  notes: string[];
  tableCounts: Record<FinanceTable, number>;
  /** Budgets are born draft and promoted after their lines land. */
  budgetStates: Array<{ id: string; status: string; approvedAgo: number | null }>;
  /** setup's system-key → gl_account id map; empty when setup installed no chart. */
  accounts: Record<string, string>;
  costCentres: Record<string, string>;
};

const MODELS = new WeakMap<object, FinanceModel>();

function readHandoff<T>(ctx: LabContext, family: string): T {
  try {
    return (ctx.handoff<T>(family) ?? ({} as T)) as T;
  } catch {
    return {} as T;
  }
}

type SetupHandoff = {
  glChart?: { installed: boolean; accountsBySystemKey?: Record<string, string> };
  fiscalYears?: Record<string, string>;
  fiscalPeriods?: Array<{
    id: string;
    year: number;
    periodNo: number;
    startsOn: string;
    endsOn: string;
    status: string;
  }>;
  bankAccounts?: Record<
    string,
    { id: string; glAccountId: string; kind: string; currency: string }
  >;
  costCentres?: Record<string, string>;
  vatProfile?: { registered: boolean } | null;
};

/** Deterministic variation so the months are not identical to the penny. */
function vary(base: number, i: number): number {
  return base + ((i * 37) % 23) * 100;
}

export function buildFinance(ctx: LabContext): FinanceModel {
  const memoKey = ctx as unknown as object;
  const memo = MODELS.get(memoKey);
  if (memo) return memo;

  const { company, clock, users, orgId } = ctx;
  const setup = readHandoff<SetupHandoff>(ctx, "setup");
  const notes: string[] = [];
  const accounts = setup.glChart?.accountsBySystemKey ?? {};
  const costCentres = setup.costCentres ?? {};

  const rows = Object.fromEntries(FINANCE_TABLES.map((t) => [t, [] as Row[]])) as Record<
    FinanceTable,
    Row[]
  >;
  const push = (t: FinanceTable, r: Row) => rows[t].push(r);
  const ts = (agoDays: number, hour = 10) => clock.tsAgo(agoDays, hour, 0);

  /*
   * A journal can only post into an OPEN period — the posting function refuses
   * anything else, and the lab does not weaken guards to make seeding easier.
   * So the whole month-end pattern is laid out over the periods setup actually
   * left open, and no earlier.
   */
  const periods = (setup.fiscalPeriods ?? [])
    .filter((p) => p.status === "open" && p.startsOn <= company.history.asOf)
    .sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1));
  const openMonths = periods.map((p) => ({
    periodId: p.id,
    year: p.year,
    periodNo: p.periodNo,
    // The 25th, or the as-of when the period is the current one.
    date: p.endsOn <= company.history.asOf ? p.endsOn : company.history.asOf,
  }));
  if (!openMonths.length)
    notes.push("setup left no open fiscal period — no manual journal can be posted");

  const haveAccounts = MANUAL_ACCOUNT_KEYS.every((k) => accounts[k]);
  if (!haveAccounts)
    notes.push("the chart of accounts is missing one of the manual-journal accounts");

  // ── the journals ──────────────────────────────────────────────────────────
  const journals: JournalSpec[] = [];
  if (haveAccounts) {
    const ccKeys = Object.keys(costCentres).sort();
    for (const [mi, m] of openMonths.entries()) {
      for (const [si, s] of MONTHLY.entries()) {
        const amount = vary(s.base, mi * MONTHLY.length + si);
        journals.push({
          key: `${m.year}-${String(m.periodNo).padStart(2, "0")}:${s.slug}`,
          entryDate: m.date,
          journalKind: s.kind,
          memo: s.memo,
          outcome: "posted",
          lines: [
            {
              accountKey: s.debit,
              debitMinor: amount,
              creditMinor: 0,
              description: s.memo,
              costCentreKey: ccKeys[si % Math.max(1, ccKeys.length)],
            },
            { accountKey: s.credit, debitMinor: 0, creditMinor: amount, description: s.memo },
          ],
        });
      }
      // One three-line entry a month, split across cost centres, because a
      // two-line ledger is not a ledger anyone has to read.
      if (ccKeys.length >= 2) {
        const a = vary(920_00, mi);
        const b = vary(680_00, mi + 5);
        journals.push({
          key: `${m.year}-${String(m.periodNo).padStart(2, "0")}:shared_costs`,
          entryDate: m.date,
          journalKind: "adjustment",
          memo: "Allocate shared overhead across cost centres",
          outcome: "posted",
          lines: [
            {
              accountKey: "overhead_expense",
              debitMinor: a,
              creditMinor: 0,
              description: "Shared overhead — first cost centre",
              costCentreKey: ccKeys[0],
            },
            {
              accountKey: "overhead_expense",
              debitMinor: b,
              creditMinor: 0,
              description: "Shared overhead — second cost centre",
              costCentreKey: ccKeys[1],
            },
            {
              accountKey: "accrued_expenses",
              debitMinor: 0,
              creditMinor: a + b,
              description: "Shared overhead accrued",
            },
          ],
        });
      }
    }

    /*
     * The three states a ledger has to be able to show besides "posted": a
     * draft still waiting on someone, a draft that was abandoned, and a posted
     * entry that had to be reversed. Each is placed in the newest open period.
     */
    const last = openMonths[openMonths.length - 1];
    if (last) {
      journals.push({
        key: `${last.year}-${String(last.periodNo).padStart(2, "0")}:pending_review`,
        entryDate: last.date,
        journalKind: "adjustment",
        memo: "Reclassify a miscoded supplier charge — waiting on the manager's review",
        outcome: "draft",
        lines: [
          {
            accountKey: "overhead_expense",
            debitMinor: 430_00,
            creditMinor: 0,
            description: "Reclassification, pending review",
          },
          {
            accountKey: "accrued_expenses",
            debitMinor: 0,
            creditMinor: 430_00,
            description: "Reclassification, pending review",
          },
        ],
      });
      journals.push({
        key: `${last.year}-${String(last.periodNo).padStart(2, "0")}:abandoned`,
        entryDate: last.date,
        journalKind: "general",
        memo: "Duplicate of the utilities accrual — raised in error",
        outcome: "cancelled",
        lines: [
          {
            accountKey: "overhead_expense",
            debitMinor: 1_150_00,
            creditMinor: 0,
            description: "Duplicate accrual",
          },
          {
            accountKey: "accrued_expenses",
            debitMinor: 0,
            creditMinor: 1_150_00,
            description: "Duplicate accrual",
          },
        ],
      });
      journals.push({
        key: `${last.year}-${String(last.periodNo).padStart(2, "0")}:to_reverse`,
        entryDate: last.date,
        journalKind: "revaluation",
        memo: "Foreign balance revaluation — reversed the following day",
        outcome: "reversed",
        lines: [
          {
            accountKey: "fx_loss",
            debitMinor: 275_00,
            creditMinor: 0,
            description: "Revaluation loss on foreign balances",
          },
          {
            accountKey: "accrued_expenses",
            debitMinor: 0,
            creditMinor: 275_00,
            description: "Revaluation loss on foreign balances",
          },
        ],
      });
    }
  }

  // ── recurring journal templates ───────────────────────────────────────────
  const templateSpecs: Array<{
    name: string;
    kind: string;
    memo: string;
    debit: string;
    credit: string;
    amount: number;
    recurrence: "monthly" | "quarterly" | "yearly";
  }> = [
    {
      name: "Monthly rent accrual",
      kind: "accrual",
      memo: "Premises rent for the month",
      debit: "overhead_expense",
      credit: "accrued_expenses",
      amount: 1_800_00,
      recurrence: "monthly",
    },
    {
      name: "Prepaid insurance release",
      kind: "adjustment",
      memo: "One month of the annual premium",
      debit: "overhead_expense",
      credit: "prepaid_expenses",
      amount: 640_00,
      recurrence: "monthly",
    },
    {
      name: "Quarterly audit fee accrual",
      kind: "accrual",
      memo: "Accrue the quarterly audit fee",
      debit: "overhead_expense",
      credit: "accrued_expenses",
      amount: 4_500_00,
      recurrence: "quarterly",
    },
    {
      name: "Annual licence renewal accrual",
      kind: "accrual",
      memo: "Accrue the trade licence renewal",
      debit: "overhead_expense",
      credit: "accrued_expenses",
      amount: 12_000_00,
      recurrence: "yearly",
    },
  ];
  for (const [i, t] of templateSpecs.entries()) {
    const dr = accounts[t.debit];
    const cr = accounts[t.credit];
    push("journal_template", {
      id: ctx.id("journal_template", i),
      org_id: orgId,
      name: t.name,
      journal_kind: t.kind,
      memo: t.memo,
      lines:
        dr && cr
          ? [
              { accountId: dr, debitMinor: t.amount, creditMinor: 0, description: t.memo },
              { accountId: cr, debitMinor: 0, creditMinor: t.amount, description: t.memo },
            ]
          : [],
      recurrence: t.recurrence,
      next_run_on: clock.dayAhead(
        t.recurrence === "monthly" ? 12 : t.recurrence === "quarterly" ? 45 : 200,
      ),
      active: i < 3,
      created_by: users.finance,
      created_at: ts(400, 9),
      updated_at: ts(400, 9),
    });
  }

  // ── budgets ───────────────────────────────────────────────────────────────
  const years = Object.entries(setup.fiscalYears ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const currentYear = years[years.length - 1];
  const priorYear = years[years.length - 2];
  const budgetAccounts = ["overhead_expense", "salary_expense", "sales_revenue", "direct_costs"]
    .map((k) => ({ key: k, id: accounts[k] }))
    .filter((a): a is { key: string; id: string } => Boolean(a.id));
  if (!budgetAccounts.length) notes.push("no budgetable accounts in the chart — no budget written");

  const budgetPlan: Array<{ year: [string, string]; status: string; version: number }> = [];
  if (priorYear) budgetPlan.push({ year: priorYear, status: "locked", version: 1 });
  if (currentYear) budgetPlan.push({ year: currentYear, status: "approved", version: 1 });
  if (currentYear) budgetPlan.push({ year: currentYear, status: "draft", version: 2 });

  const budgetStates: FinanceModel["budgetStates"] = [];
  const ccKeysForBudget = Object.keys(costCentres).sort();
  for (const [bi, b] of budgetPlan.entries()) {
    if (!budgetAccounts.length) break;
    const budgetId = ctx.id("budget", b.year[0], b.version);
    /*
     * Born draft, whatever it is meant to become. `budget_line_frozen` refuses
     * to write a line into any budget that is not a draft — approving one is
     * what freezes its figures — so the status is applied afterwards, by
     * `promoteBudgets`, once every line is in.
     */
    budgetStates.push({
      id: budgetId,
      status: b.status,
      approvedAgo: b.status === "draft" ? null : 300 - bi * 40,
    });
    push("budget", {
      id: budgetId,
      org_id: orgId,
      fiscal_year_id: b.year[1],
      name: `${b.year[0]} operating budget`,
      version: b.version,
      status: "draft",
      approved_by: null,
      approved_at: null,
      created_by: users.finance,
      created_at: ts(340 - bi * 40, 9),
      updated_at: ts(300 - bi * 40, 10),
    });
    for (const [ai, acct] of budgetAccounts.entries()) {
      for (let periodNo = 1; periodNo <= 12; periodNo++) {
        const base =
          acct.key === "sales_revenue"
            ? 180_000_00
            : acct.key === "salary_expense"
              ? 95_000_00
              : acct.key === "direct_costs"
                ? 70_000_00
                : 18_000_00;
        push("budget_line", {
          id: ctx.id("budget_line", b.year[0], b.version, acct.key, periodNo),
          org_id: orgId,
          budget_id: budgetId,
          account_id: acct.id,
          period_no: periodNo,
          amount_minor: base + ((periodNo * 13 + ai * 7) % 11) * 1_000_00,
          job_id: null,
          department_id: null,
          cost_centre_id: ccKeysForBudget.length
            ? costCentres[ccKeysForBudget[ai % ccKeysForBudget.length]!]!
            : null,
          note: periodNo === 1 ? `${acct.key} plan for ${b.year[0]}` : null,
          created_at: ts(340 - bi * 40, 9),
          updated_at: ts(340 - bi * 40, 9),
        });
      }
    }
  }

  // ── VAT periods, for the registered companies only ────────────────────────
  const vatPeriods: FinanceModel["vatPeriods"] = [];
  if (setup.vatProfile?.registered) {
    // The four completed quarters before the as-of, then the current one.
    const asOf = new Date(`${company.history.asOf}T00:00:00.000Z`);
    const q = Math.floor(asOf.getUTCMonth() / 3);
    for (let back = 4; back >= 0; back--) {
      const qi = q - back;
      const year = asOf.getUTCFullYear() + Math.floor(qi / 4);
      const qq = ((qi % 4) + 4) % 4;
      const start = new Date(Date.UTC(year, qq * 3, 1));
      const end = new Date(Date.UTC(year, qq * 3 + 3, 0));
      vatPeriods.push({
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
        lock: back > 0,
      });
    }
  } else {
    notes.push("not VAT registered in this lab — no VAT return is prepared");
  }

  const bank = Object.values(setup.bankAccounts ?? {}).find((b) => b.kind === "bank") ?? null;
  if (!bank) notes.push("setup created no bank account — no statement or reconciliation");

  const tableCounts = Object.fromEntries(FINANCE_TABLES.map((t) => [t, rows[t].length])) as Record<
    FinanceTable,
    number
  >;

  const model: FinanceModel = {
    openMonths,
    journals,
    accountKeys: [...MANUAL_ACCOUNT_KEYS],
    bankAccountId: bank?.id ?? null,
    bankGlAccountId: bank?.glAccountId ?? null,
    vatPeriods,
    rows,
    notes,
    tableCounts,
    budgetStates,
    accounts,
    costCentres,
  };
  MODELS.set(memoKey, model);
  return model;
}

export function planFinance(ctx: LabContext): FamilyPlan {
  const m = buildFinance(ctx);
  return { family: "finance", expected: { ...m.tableCounts } };
}

// ── the live half ───────────────────────────────────────────────────────────

type Progress = {
  /** journal spec key → created entry id. */
  journals: Record<string, string>;
  posted: string[];
  cancelled: string[];
  reversed: Record<string, string>;
  statements: Record<string, string>;
  reconciliations: Record<string, string>;
  vat: Record<string, string>;
};
const emptyProgress = (): Progress => ({
  journals: {},
  posted: [],
  cancelled: [],
  reversed: {},
  statements: {},
  reconciliations: {},
  vat: {},
});

async function readProgress(ctx: LabContext): Promise<Progress> {
  const rows = (await ctx.sql`
    select value from public.app_settings where org_id = ${ctx.orgId} and key = ${PROGRESS_KEY}
  `) as unknown as Array<{ value: Progress }>;
  return rows[0]?.value ? { ...emptyProgress(), ...rows[0].value } : emptyProgress();
}
async function writeProgress(ctx: LabContext, p: Progress): Promise<void> {
  await ctx.sql`
    insert into public.app_settings (org_id, key, value)
    values (${ctx.orgId}, ${PROGRESS_KEY}, ${ctx.sql.json(p as never)})
    on conflict (org_id, key) do update set value = excluded.value, updated_at = now()
  `;
}

/** Apply each budget's real status once its lines are in. One round trip. */
async function promoteBudgets(ctx: LabContext, m: FinanceModel): Promise<number> {
  const promote = m.budgetStates.filter((b) => b.status !== "draft");
  if (!promote.length) return 0;
  const rows = promote.map((b) => ({
    id: b.id,
    status: b.status,
    approved_at: ctx.clock.tsAgo(b.approvedAgo ?? 0, 10, 0),
  }));
  const res = await ctx.sql.unsafe(
    `update public.budget b
        set status = v.status, approved_by = $3, approved_at = v.approved_at
       from json_to_recordset($1::text::json)
            as v(id uuid, status text, approved_at timestamptz)
      where b.id = v.id and b.org_id = $2`,
    [JSON.stringify(rows), ctx.orgId, ctx.users.owner] as never[],
  );
  return res.count ?? rows.length;
}

type Outcome = { counts: Record<string, number>; failures: string[] };

/** Drive the ledger, the bank and the tax pack through the product's services. */
async function driveFinance(ctx: LabContext, m: FinanceModel): Promise<Outcome> {
  const out: Outcome = { counts: {}, failures: [] };
  const bump = (t: string, n = 1) => (out.counts[t] = (out.counts[t] ?? 0) + n);
  const fail = (step: string, e: unknown) =>
    out.failures.push(`${step}: ${e instanceof Error ? e.message : String(e)}`);

  const ledger = await import("@/modules/finance/ledger");
  const banking = await import("@/modules/finance/banking");
  const tax = await import("@/modules/finance/tax");
  const fin = ctx.ctxFor("finance");
  const arche = ctx.archetypeOf("finance");
  const p = await readProgress(ctx);
  const { clock } = ctx;

  // ── journals ────────────────────────────────────────────────────────────
  for (const spec of m.journals) {
    try {
      if (!p.journals[spec.key]) {
        const r = await ledger.createJournalEntry(fin, arche, {
          entryDate: spec.entryDate,
          journalKind: spec.journalKind,
          memo: spec.memo,
          lines: spec.lines.map((l) => ({
            accountId: m.accounts[l.accountKey]!,
            description: l.description,
            debitMinor: l.debitMinor,
            creditMinor: l.creditMinor,
            // undefined, never null: the input schema takes an optional uuid.
            costCentreId: l.costCentreKey
              ? (m.costCentres[l.costCentreKey] ?? undefined)
              : undefined,
          })),
        });
        p.journals[spec.key] = r.id;
        bump("journal_entry");
        bump("journal_line", spec.lines.length);
        await writeProgress(ctx, p);
      }
      const id = p.journals[spec.key]!;
      if (spec.outcome === "draft") continue;
      if (spec.outcome === "cancelled") {
        if (!p.cancelled.includes(spec.key)) {
          await ledger.cancelDraftJournal(fin, arche, id);
          p.cancelled.push(spec.key);
          await writeProgress(ctx, p);
        }
        continue;
      }
      if (!p.posted.includes(spec.key)) {
        await ledger.postJournalEntry(fin, arche, id);
        p.posted.push(spec.key);
        await writeProgress(ctx, p);
      }
      if (spec.outcome === "reversed" && !p.reversed[spec.key]) {
        const r = await ledger.reverseJournalEntry(fin, arche, {
          entryId: id,
          date: spec.entryDate,
          memo: "Reversal of the revaluation raised the previous day",
        });
        p.reversed[spec.key] = r.reversalId;
        bump("journal_entry");
        bump("journal_line", spec.lines.length);
        await writeProgress(ctx, p);
      }
    } catch (e) {
      fail(`journal ${spec.key}`, e);
    }
  }

  // ── bank statements, built from what the ledger actually shows ──────────
  if (m.bankAccountId && m.bankGlAccountId) {
    try {
      const glRows = (await ctx.sql`
        select l.id::text as id, e.entry_date::text as d,
               (l.debit_minor - l.credit_minor)::int as signed_minor, e.entry_no
        from public.journal_line l
        join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
        where l.org_id = ${ctx.orgId} and l.account_id = ${m.bankGlAccountId}
          and e.status = 'posted'
        order by e.entry_date desc
        limit 60
      `) as unknown as Array<{ id: string; d: string; signed_minor: number; entry_no: string }>;

      /*
       * A statement whose every line matches the ledger teaches a reviewer
       * nothing. Two thirds mirror real postings so the matcher finds them;
       * the rest are the things a bank statement really carries that the
       * ledger has not seen yet — charges, interest, an unidentified deposit.
       */
      const mirrored = glRows.slice(0, 24);
      const label = `Statement to ${clock.dayAgo(1)}`;
      const lines = [
        ...mirrored.map((g, i) => ({
          date: g.d,
          description: `Ledger movement ${g.entry_no}`,
          amountMinor: g.signed_minor,
          externalRef: `REF${String(i + 1).padStart(6, "0")}`,
        })),
        {
          date: clock.dayAgo(20),
          description: "Account maintenance fee",
          amountMinor: -35_00,
          externalRef: "FEE000001",
        },
        {
          date: clock.dayAgo(12),
          description: "Credit interest",
          amountMinor: 12_00,
          externalRef: "INT000001",
        },
        {
          date: clock.dayAgo(6),
          description: "Unidentified deposit — pending investigation",
          amountMinor: 4_500_00,
          externalRef: "DEP000001",
        },
      ].filter((l) => l.amountMinor !== 0);

      const fileText = lines.map((l) => `${l.date},${l.description},${l.amountMinor}`).join("\n");
      const fileHash = createHash("sha256").update(fileText).digest("hex");
      const existing = (await ctx.sql`
        select id::text as id from public.bank_statement
        where org_id = ${ctx.orgId} and bank_account_id = ${m.bankAccountId}
          and file_hash = ${fileHash}
      `) as unknown as Array<{ id: string }>;
      let statementId = existing[0]?.id ?? p.statements[fileHash] ?? null;
      if (!statementId && lines.length) {
        const r = await banking.importBankStatement(fin, arche, {
          bankAccountId: m.bankAccountId,
          label,
          fileText,
          rows: lines,
        });
        statementId = r.statementId;
        p.statements[fileHash] = statementId;
        bump("bank_statement");
        bump("bank_statement_line", r.imported);
        await writeProgress(ctx, p);
      }

      if (statementId) {
        const recKey = `rec:${fileHash}`;
        let recId = p.reconciliations[recKey] ?? null;
        if (!recId) {
          const r = await banking.startReconciliation(fin, arche, {
            bankAccountId: m.bankAccountId,
            label: `Reconciliation — ${label}`,
          });
          recId = r.id;
          p.reconciliations[recKey] = recId;
          bump("bank_reconciliation");
          await writeProgress(ctx, p);
        }
        // Only the suggestions the product itself makes are confirmed; nothing
        // is matched that the matcher would not have offered.
        const suggestions = await banking.suggestMatches(fin, arche, m.bankAccountId);
        for (const s of suggestions.filter((x) => x.confidence === "exact").slice(0, 20)) {
          try {
            const [line] = (await ctx.sql`
              select amount_minor::int as amount from public.bank_statement_line
              where org_id = ${ctx.orgId} and id = ${s.statementLineId}
            `) as unknown as Array<{ amount: number }>;
            if (!line) continue;
            await banking.addMatch(fin, arche, {
              reconciliationId: recId,
              statementLineId: s.statementLineId,
              journalLineId: s.journalLineId,
              amountMinor: line.amount,
            });
            bump("bank_match");
          } catch (e) {
            fail("bank match", e);
          }
        }
        // The reconciliation is deliberately left in progress: unmatched lines
        // are exactly what a pilot should be able to see and work through.
      }
    } catch (e) {
      fail("bank statement", e);
    }
  }

  // ── VAT working papers ──────────────────────────────────────────────────
  for (const period of m.vatPeriods) {
    const key = `${period.start}..${period.end}`;
    try {
      let returnId = p.vat[key] ?? null;
      if (!returnId) {
        const r = await tax.prepareVatReturn(fin, arche, {
          periodStart: period.start,
          periodEnd: period.end,
        });
        returnId = r.returnId;
        p.vat[key] = returnId;
        bump("tax_return");
        await writeProgress(ctx, p);
      }
      if (period.lock) {
        // draft → under_review → locked. A working paper, never a filing.
        await tax.setReturnStatus(fin, arche, { returnId, status: "under_review" });
        await tax.setReturnStatus(ctx.ctxFor("owner"), ctx.archetypeOf("owner"), {
          returnId,
          status: "locked",
        });
      }
    } catch (e) {
      fail(`vat return ${key}`, e);
    }
  }

  return out;
}

export async function seedFinance(ctx: LabContext): Promise<FamilyReport> {
  const m = buildFinance(ctx);
  const counts: Record<string, number> = {};
  for (const table of FINANCE_TABLES) {
    const r = await ctx.insert(table, m.rows[table]);
    counts[table] = r.attempted;
    if (m.rows[table].length) ctx.log(`${table}: ${r.attempted} rows`);
  }
  const notes = [...m.notes];
  if (!ctx.dryRun && financeRuntime.live) {
    const promoted = await promoteBudgets(ctx, m);
    if (promoted) ctx.log(`budget: ${promoted} promoted out of draft`);
    const svc = await driveFinance(ctx, m);
    for (const [t, n] of Object.entries(svc.counts)) counts[t] = (counts[t] ?? 0) + n;
    ctx.log(
      `services: ${svc.counts.journal_entry ?? 0} journals, ${svc.counts.bank_match ?? 0} bank matches, ${svc.counts.tax_return ?? 0} VAT returns`,
    );
    if (svc.failures.length)
      notes.push(
        `${svc.failures.length} finance service calls failed: ${svc.failures.slice(0, 3).join(" | ")}`,
      );
  } else {
    notes.push("service half skipped (dry run or offline)");
  }
  return {
    family: "finance",
    counts,
    handoff: { openMonths: m.openMonths.length, journalSpecs: m.journals.length },
    notes,
  };
}

export const finance: Family = {
  key: "finance",
  // Last in the chain: the ledger it reconciles against is written by everyone
  // before it.
  deps: ["setup", "people", "masters", "work", "sales", "supply", "stock", "hr", "assets"],
  appliesTo: () => true,
  plan: planFinance,
  seed: seedFinance,

  async verify(ctx): Promise<Check[]> {
    const m = buildFinance(ctx);
    const org = ctx.orgId;
    const checks: Check[] = [];
    const count = async (table: string, where = ""): Promise<number> => {
      const [r] = (await ctx.sql.unsafe(
        `select count(*)::int as n from public.${table} where org_id = $1 ${where}`,
        [org] as never[],
      )) as unknown as Array<{ n: number }>;
      return r!.n;
    };
    const violators = async (name: string, sqlText: string) => {
      const [r] = (await ctx.sql.unsafe(sqlText, [org] as never[])) as unknown as Array<{
        n: number;
      }>;
      checks.push({ name, ok: r!.n === 0, detail: `${r!.n} violating rows` });
    };

    for (const t of FINANCE_TABLES) {
      const n = await count(t);
      checks.push({
        name: `count ${t}`,
        ok: n === m.tableCounts[t],
        detail: `${n} live vs ${m.tableCounts[t]} planned`,
      });
    }

    // ── the ledger's own arithmetic ────────────────────────────────────────
    await violators(
      "every posted entry balances in the transaction currency",
      `select count(*)::int as n from public.journal_entry e
       where e.org_id = $1 and e.status in ('posted','reversed')
         and e.total_debit_minor <> e.total_credit_minor`,
    );
    await violators(
      "every posted entry balances in the base currency",
      `select count(*)::int as n from public.journal_entry e
       where e.org_id = $1 and e.status in ('posted','reversed')
         and e.base_total_debit_minor <> e.base_total_credit_minor`,
    );
    await violators(
      "an entry's totals equal the sum of its lines",
      `select count(*)::int as n from public.journal_entry e
       join lateral (select coalesce(sum(debit_minor),0) d, coalesce(sum(credit_minor),0) c
                     from public.journal_line l
                     where l.entry_id = e.id and l.org_id = e.org_id) s on true
       where e.org_id = $1 and e.status in ('posted','reversed')
         and (e.total_debit_minor <> s.d or e.total_credit_minor <> s.c)`,
    );
    await violators(
      "no posted entry sits in a closed period",
      `select count(*)::int as n from public.journal_entry e
       join public.fiscal_period p on p.id = e.period_id and p.org_id = e.org_id
       where e.org_id = $1 and e.status = 'posted' and p.status = 'locked'`,
    );
    await violators(
      "no draft carries posting metadata",
      `select count(*)::int as n from public.journal_entry
       where org_id = $1 and status = 'draft'
         and (posted_at is not null or posted_by is not null or period_id is not null)`,
    );
    await violators(
      "every line is a debit or a credit, never both and never neither",
      `select count(*)::int as n from public.journal_line
       where org_id = $1 and not ((debit_minor > 0 and credit_minor = 0)
                                  or (credit_minor > 0 and debit_minor = 0))`,
    );

    const trial = (await ctx.sql.unsafe(
      `select coalesce(sum(l.debit_minor),0)::bigint as d, coalesce(sum(l.credit_minor),0)::bigint as c
       from public.journal_line l
       join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
       where l.org_id = $1 and e.status in ('posted','reversed')`,
      [org] as never[],
    )) as unknown as Array<{ d: string; c: string }>;
    checks.push({
      name: "the whole trial balance nets to zero",
      ok: String(trial[0]!.d) === String(trial[0]!.c),
      detail: `debits ${trial[0]!.d} vs credits ${trial[0]!.c}`,
    });

    // ── the ledger has something to look at ────────────────────────────────
    const posted = await count("journal_entry", `and status = 'posted'`);
    checks.push({
      name: "the ledger has posted entries",
      ok: posted > 0,
      detail: `${posted} posted`,
    });
    for (const [label, where] of [
      ["a draft", `and status = 'draft'`],
      ["a cancelled entry", `and status = 'cancelled'`],
      ["a reversal", `and reverses_entry_id is not null`],
    ] as const) {
      const n = await count("journal_entry", where);
      checks.push({ name: `the ledger shows ${label}`, ok: n > 0, detail: `${n} rows` });
    }

    // ── bank and tax ───────────────────────────────────────────────────────
    if (m.bankAccountId) {
      const lines = await count("bank_statement_line");
      const matches = await count("bank_match", `and voided_at is null`);
      checks.push({
        name: "a bank statement was imported",
        ok: lines > 0,
        detail: `${lines} statement lines`,
      });
      checks.push({
        name: "the reconciliation matched something and left something unmatched",
        ok: matches > 0 && matches < lines,
        detail: `${matches} matched of ${lines}`,
      });
      await violators(
        "every match ties a statement line to a ledger line on the bank account",
        `select count(*)::int as n from public.bank_match m
         join public.journal_line l on l.id = m.journal_line_id and l.org_id = m.org_id
         join public.bank_account b on b.org_id = m.org_id
         where m.org_id = $1 and b.gl_account_id is distinct from l.account_id`,
      );
    }
    if (m.vatPeriods.length) {
      const returns = await count("tax_return");
      const locked = await count("tax_return", `and status = 'locked'`);
      checks.push({ name: "VAT returns were prepared", ok: returns > 0, detail: `${returns}` });
      checks.push({
        name: "closed VAT periods are locked and the current one is not",
        ok: locked > 0 && locked < returns,
        detail: `${locked} locked of ${returns}`,
      });
    }

    return checks;
  },
};
