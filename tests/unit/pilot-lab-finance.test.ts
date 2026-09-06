/**
 * H33 Pilot Lab — the finance family, checked without a database.
 *
 * Half of this family runs through the product's services, so what a unit test
 * can prove is the SPECIFICATION it hands them — and that is exactly where the
 * ledger's guards bite. Every journal spec is checked the way
 * `app.post_journal_entry` would check it: at least two lines, each a debit or
 * a credit and never both, debits equal to credits, a date inside a fiscal
 * period setup actually left OPEN, and not one line touching a control account.
 * A spec that fails any of these would abort a company halfway through seeding.
 */
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { COMPANIES } from "../../tooling/pilot-lab/companies";
import type { Company, LabContext, PersonaKey } from "../../tooling/pilot-lab/types";
import { id as labId } from "../../tooling/pilot-lab/ids";
import { SEED_VERSION } from "../../tooling/pilot-lab/marker";
import { Rng } from "../../tooling/simulation/rng";
import { SimClock } from "../../tooling/simulation/dates";
import { CHART_TEMPLATE } from "@/modules/finance/chart";
import { FISCAL_YEARS, periodStatusFor } from "../../tooling/pilot-lab/families/setup";
import {
  finance,
  financeRuntime,
  planFinance,
  seedFinance,
  buildFinance,
  FINANCE_TABLES,
  MANUAL_ACCOUNT_KEYS,
  CONTROL_SYSTEM_KEYS,
  type FinanceTable,
} from "../../tooling/pilot-lab/families/finance";

// No database in a unit test: the service half must stay switched off.
financeRuntime.live = false;

type Row = Record<string, unknown>;
type Store = Partial<Record<string, Row[]>>;

const PERSONAS: PersonaKey[] = [
  "owner",
  "admin",
  "manager",
  "finance",
  "hr",
  "warehouse",
  "field",
  "restricted",
  "auditor",
];

/** The fiscal calendar setup really builds, so open periods are not invented. */
function fiscalHandoff(company: Company) {
  const years: Record<string, string> = {};
  const periods: Array<{
    id: string;
    year: number;
    periodNo: number;
    startsOn: string;
    endsOn: string;
    status: string;
  }> = [];
  for (const y of FISCAL_YEARS) {
    years[String(y)] = labId(company.key, "fiscal_year", y);
    for (let p = 1; p <= 12; p++) {
      const start = new Date(Date.UTC(y, p - 1, 1));
      const end = new Date(Date.UTC(y, p, 0));
      periods.push({
        id: labId(company.key, "fiscal_period", y, p),
        year: y,
        periodNo: p,
        startsOn: start.toISOString().slice(0, 10),
        endsOn: end.toISOString().slice(0, 10),
        status: periodStatusFor(y, p),
      });
    }
  }
  return { years, periods };
}

function handoffs(company: Company): Record<string, Record<string, unknown>> {
  const { years, periods } = fiscalHandoff(company);
  const accountsBySystemKey: Record<string, string> = {};
  for (const a of CHART_TEMPLATE)
    if (a.systemKey) accountsBySystemKey[a.systemKey] = labId(company.key, "gl_account", a.code);
  return {
    setup: {
      glChart: { installed: true, templateVersion: "1", accountsBySystemKey },
      fiscalYears: years,
      fiscalPeriods: periods,
      costCentres: {
        ADMIN: labId(company.key, "cost_centre", "ADMIN"),
        OPS: labId(company.key, "cost_centre", "OPS"),
      },
      bankAccounts: {
        main: {
          id: labId(company.key, "bank_account", "main"),
          glAccountId: accountsBySystemKey.bank_default!,
          kind: "bank",
          currency: company.currency,
        },
      },
      vatProfile:
        company.country === "AE"
          ? { trn: "1", emirate: "DU", periodicity: "quarterly", registered: true }
          : null,
    },
    people: {},
    masters: {},
    work: {},
    sales: {},
    supply: {},
    stock: {},
    hr: {},
    assets: {},
  };
}

function fakeCtx(company: Company, overrides: Record<string, Record<string, unknown>> = {}) {
  const store: Store = {};
  const orgId = labId(company.key, "org");
  const users = Object.fromEntries(
    PERSONAS.map((p) => [p, labId(company.key, "user", p)]),
  ) as Record<PersonaKey, string>;
  const h = { ...handoffs(company), ...overrides };
  const noDb = () => {
    throw new Error("the unit test has no database");
  };
  const ctx: LabContext = {
    sql: noDb as unknown as LabContext["sql"],
    admin: {} as unknown as LabContext["admin"],
    company,
    orgId,
    users,
    employees: {},
    ctxFor: (persona) => ({
      orgId,
      userId: users[persona],
      costPrivileged: true,
      pricePrivileged: true,
      requestId: `test-${company.key}-${persona}`,
    }),
    archetypeOf: (persona) => company.personas.find((p) => p.key === persona)!.archetype,
    rng: new Rng(`h33:${SEED_VERSION}:${company.key}`),
    clock: new SimClock(company.history.asOf),
    id: (family, ...ordinal) => labId(company.key, family, ...ordinal),
    insert: async (table, rows) => {
      if (rows.length === 0) return { attempted: 0, inserted: 0 };
      const columns = Object.keys(rows[0]!);
      if (!columns.includes("org_id")) throw new Error(`${table}: rows must carry org_id`);
      for (const r of rows) {
        if (!r.org_id) throw new Error(`${table}: a row has no org_id`);
        for (const k of Object.keys(r))
          if (!columns.includes(k)) throw new Error(`${table}: ragged row (extra ${k})`);
      }
      store[table] = [...(store[table] ?? []), ...rows.map((r) => ({ ...r }))];
      return { attempted: rows.length, inserted: rows.length };
    },
    // Grouped writes are one transaction live; in memory the tables are
    // simply written in the order given.
    insertGroup: async (entries: Array<{ table: string; rows: Row[]; conflict?: string }>) => {
      const out: Record<string, { attempted: number; inserted: number }> = {};
      for (const e of entries) out[e.table] = await ctx.insert(e.table, e.rows, e.conflict);
      return out;
    },
    handoff: <T>(family: string) => {
      const v = h[family];
      if (!v) throw new Error(`no handoff from family ${family}`);
      return v as T;
    },
    log: () => {},
    dryRun: false,
  };
  return { ctx, store };
}

async function runFor(company: Company, overrides?: Record<string, Record<string, unknown>>) {
  const { ctx, store } = fakeCtx(company, overrides);
  const plan = planFinance(ctx).expected;
  const report = await seedFinance(ctx);
  const rows = (t: FinanceTable) => store[t] ?? [];
  return { ctx, plan, report, rows, model: buildFinance(ctx) };
}

const ts = (v: unknown) => Date.parse(String(v));

describe("the finance family", () => {
  it("is declared correctly and runs last", () => {
    expect(finance.key).toBe("finance");
    // The ledger it reconciles against is written by everyone before it.
    for (const d of ["setup", "sales", "supply", "stock", "hr", "assets"])
      expect(finance.deps, d).toContain(d);
    for (const c of COMPANIES) expect(finance.appliesTo(c)).toBe(true);
  });

  it("never nominates a control account for a manual journal", () => {
    // The posting function refuses a control account outside a posting rule;
    // this is the same rule, enforced before a row is ever built.
    for (const k of MANUAL_ACCOUNT_KEYS) expect(CONTROL_SYSTEM_KEYS.has(k), k).toBe(false);
    // And the set really is populated from the chart, not empty by accident.
    expect(CONTROL_SYSTEM_KEYS.size).toBeGreaterThan(3);
    expect(CONTROL_SYSTEM_KEYS.has("ar_control")).toBe(true);
    expect(CONTROL_SYSTEM_KEYS.has("bank_default")).toBe(true);
  });

  it("says so rather than guessing when setup left nothing to work with", async () => {
    const c = COMPANIES[0]!;
    const r = await runFor(c, {
      setup: { glChart: { installed: false }, fiscalPeriods: [], fiscalYears: {} },
    });
    expect(r.model.journals).toEqual([]);
    expect(r.rows("budget")).toEqual([]);
    expect(r.report.notes?.join(" ")).toMatch(/no open fiscal period/i);
    expect(r.report.notes?.join(" ")).toMatch(/missing one of the manual-journal accounts/i);
  });
});

for (const company of COMPANIES) {
  describe(`finance for ${company.key}`, () => {
    it("plans exactly the rows it writes in bulk", async () => {
      const r = await runFor(company);
      for (const t of FINANCE_TABLES) expect(r.rows(t).length, t).toBe(r.plan[t]);
      for (const t of FINANCE_TABLES) expect(r.report.counts[t], t).toBe(r.plan[t]);
    });

    it("is deterministic", async () => {
      const a = await runFor(company);
      const b = await runFor(company);
      for (const t of FINANCE_TABLES)
        expect(a.rows(t).map((x) => x.id)).toEqual(b.rows(t).map((x) => x.id));
      expect(a.model.journals.map((j) => j.key)).toEqual(b.model.journals.map((j) => j.key));
    });

    it("carries org_id everywhere and never repeats an id", async () => {
      const r = await runFor(company);
      const seen = new Set<string>();
      for (const t of FINANCE_TABLES)
        for (const row of r.rows(t)) {
          expect(row.org_id, t).toBe(r.ctx.orgId);
          const id = String(row.id);
          expect(seen.has(id), `${t} ${id}`).toBe(false);
          seen.add(id);
        }
    });

    // ── the journal specs, checked the way the posting function checks them ──
    it("writes journals only into periods setup left open", async () => {
      const r = await runFor(company);
      const open = new Map(
        (
          r.ctx.handoff<{ fiscalPeriods: Array<Record<string, unknown>> }>("setup").fiscalPeriods ??
          []
        )
          .filter((p) => p.status === "open")
          .map((p) => [String(p.startsOn).slice(0, 7), p]),
      );
      expect(r.model.journals.length).toBeGreaterThan(0);
      for (const j of r.model.journals) {
        expect(open.has(j.entryDate.slice(0, 7)), `${j.key} on ${j.entryDate}`).toBe(true);
        expect(j.entryDate <= company.history.asOf, `${j.key} is not in the future`).toBe(true);
      }
    });

    it("balances every journal and puts each line on exactly one side", async () => {
      const r = await runFor(company);
      for (const j of r.model.journals) {
        expect(j.lines.length, `${j.key} needs at least two lines`).toBeGreaterThanOrEqual(2);
        let debit = 0;
        let credit = 0;
        for (const l of j.lines) {
          const isDebit = l.debitMinor > 0;
          const isCredit = l.creditMinor > 0;
          expect(isDebit !== isCredit, `${j.key}: one side only`).toBe(true);
          expect(Number.isInteger(l.debitMinor) && Number.isInteger(l.creditMinor)).toBe(true);
          debit += l.debitMinor;
          credit += l.creditMinor;
        }
        expect(debit, `${j.key} debits vs credits`).toBe(credit);
        expect(debit, `${j.key} is not a zero entry`).toBeGreaterThan(0);
      }
    });

    it("touches no control account and no account outside the chart", async () => {
      const r = await runFor(company);
      const known = new Set(Object.keys(r.model.accounts));
      for (const j of r.model.journals)
        for (const l of j.lines) {
          expect(CONTROL_SYSTEM_KEYS.has(l.accountKey), `${j.key} → ${l.accountKey}`).toBe(false);
          expect(known.has(l.accountKey), `${j.key} → ${l.accountKey}`).toBe(true);
          expect(MANUAL_ACCOUNT_KEYS as readonly string[]).toContain(l.accountKey);
        }
    });

    it("gives the ledger a draft, a cancellation and a reversal to show", async () => {
      const r = await runFor(company);
      const outcomes = new Set(r.model.journals.map((j) => j.outcome));
      for (const o of ["posted", "draft", "cancelled", "reversed"])
        expect(outcomes, o).toContain(o);
      // Exactly one of each of the three exceptional states — a lab full of
      // cancellations would misrepresent the product.
      for (const o of ["draft", "cancelled", "reversed"])
        expect(r.model.journals.filter((j) => j.outcome === o).length, o).toBe(1);
    });

    it("keeps every journal key unique, so the progress marker cannot collide", async () => {
      const r = await runFor(company);
      const keys = r.model.journals.map((j) => j.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(k).toMatch(/^\d{4}-\d{2}:[a-z_]+$/);
    });

    // ── the bulk rows ──────────────────────────────────────────────────────
    it("writes recurring templates that carry a balanced pair of lines", async () => {
      const r = await runFor(company);
      const templates = r.rows("journal_template");
      expect(templates.length).toBe(4);
      const names = templates.map((t) => String(t.name));
      expect(new Set(names).size).toBe(names.length);
      for (const t of templates) {
        // journal_template_recurrence_ck
        expect((t.recurrence === null) === (t.next_run_on === null)).toBe(true);
        const lines = t.lines as Array<{ debitMinor: number; creditMinor: number }>;
        expect(lines.length).toBe(2);
        expect(lines.reduce((n, l) => n + l.debitMinor, 0)).toBe(
          lines.reduce((n, l) => n + l.creditMinor, 0),
        );
        expect(String(t.name).trim().length).toBeGreaterThan(0);
        expect(String(t.name).length).toBeLessThanOrEqual(120);
      }
      // A retired template, so the list is not uniformly active.
      expect(templates.some((t) => t.active === false)).toBe(true);
      // next_run_on is ahead of today: a recurring template that is overdue
      // by construction would read as a bug.
      for (const t of templates)
        expect(String(t.next_run_on) > company.history.asOf, String(t.name)).toBe(true);
    });

    it("writes budgets whose lines cover every period of the year", async () => {
      const r = await runFor(company);
      const budgets = r.rows("budget");
      const lines = r.rows("budget_line");
      expect(budgets.length).toBeGreaterThanOrEqual(2);
      // budget_name_uq is (org, fiscal_year, name, version).
      const keys = budgets.map((b) => `${b.fiscal_year_id}|${b.name}|${b.version}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const b of budgets) {
        expect(["draft", "approved", "locked"]).toContain(String(b.status));
        expect(b.approved_at, "approval comes after the lines").toBeNull();
        expect(b.approved_by).toBeNull();
      }
      /*
       * Every budget is INSERTED as a draft, whatever it is meant to become:
       * budget_line_frozen refuses to write a line into a budget that is not a
       * draft, because approving one is what freezes its figures. The status a
       * budget ends up with is applied afterwards, so it is the model that
       * carries the mix, not the inserted rows.
       */
      for (const b of budgets) expect(b.status, String(b.name)).toBe("draft");
      const intended = new Set(r.model.budgetStates.map((x) => x.status));
      expect(intended.has("approved"), "a budget to work against").toBe(true);
      expect(intended.has("draft"), "and a draft next to it").toBe(true);
      expect(intended.has("locked"), "and a closed year").toBe(true);
      // Whatever they become, they are all promoted from the same starting point.
      expect(r.model.budgetStates.length).toBe(budgets.length);

      const budgetIds = new Set(budgets.map((b) => String(b.id)));
      const perBudget = new Map<string, Set<string>>();
      for (const l of lines) {
        expect(budgetIds.has(String(l.budget_id))).toBe(true);
        const n = Number(l.period_no);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(13);
        expect(Number.isInteger(Number(l.amount_minor))).toBe(true);
        const k = String(l.budget_id);
        const seen = perBudget.get(k) ?? new Set<string>();
        const cell = `${l.account_id}|${l.period_no}`;
        expect(seen.has(cell), cell).toBe(false);
        seen.add(cell);
        perBudget.set(k, seen);
      }
      // Twelve periods for each account in each budget: no month is blank.
      for (const [id, cells] of perBudget) {
        const accounts = new Set([...cells].map((c) => c.split("|")[0]));
        expect(cells.size, id).toBe(accounts.size * 12);
      }
      expect(lines.length).toBe(budgets.length * 4 * 12);
    });

    it("prepares VAT working papers only where the company is registered", async () => {
      const r = await runFor(company);
      const registered = company.country === "AE";
      if (!registered) {
        expect(r.model.vatPeriods).toEqual([]);
        expect(r.report.notes?.join(" ")).toMatch(/not VAT registered/i);
        return;
      }
      expect(r.model.vatPeriods.length).toBe(5);
      for (const p of r.model.vatPeriods) {
        expect(p.end >= p.start, "tax_return_span_ck").toBe(true);
        expect(p.start).toMatch(/^\d{4}-\d{2}-01$/);
      }
      // Four closed quarters are locked, the current one is left open.
      expect(r.model.vatPeriods.filter((p) => p.lock).length).toBe(4);
      expect(r.model.vatPeriods[r.model.vatPeriods.length - 1]!.lock).toBe(false);
      // The quarters run forwards and do not overlap.
      for (let i = 1; i < r.model.vatPeriods.length; i++)
        expect(r.model.vatPeriods[i]!.start > r.model.vatPeriods[i - 1]!.end).toBe(true);
    });

    it("names the bank account it will reconcile", async () => {
      const r = await runFor(company);
      expect(r.model.bankAccountId).toBeTruthy();
      expect(r.model.bankGlAccountId).toBeTruthy();
      // The reconciliation matches against the bank's own GL account, which is
      // a control account — only the posting rules may write to it, which is
      // exactly why the manual journals stay away from it.
      expect(r.model.bankGlAccountId).toBe(r.model.accounts.bank_default);
    });

    it("writes nothing outside its own tables while offline", async () => {
      const r = await runFor(company);
      const written = Object.keys(r.report.counts);
      for (const t of written) expect(FINANCE_TABLES as readonly string[]).toContain(t);
      expect(r.report.notes?.join(" ")).toMatch(/service half skipped/i);
    });
  });
}
