/**
 * H33 Pilot Lab — attendance, leave, claims and payroll, checked without a
 * database.
 *
 * Payroll is the part of a lab a business owner will check by hand, line by
 * line, so the arithmetic is asserted here rather than eyeballed: net is gross
 * minus deductions on every line, a run's totals are its own lines, a payslip
 * matches the line it came from, and no leave balance goes negative.
 */
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { COMPANIES } from "../../tooling/pilot-lab/companies";
import type { Company, LabContext, PersonaKey } from "../../tooling/pilot-lab/types";
import { id as labId } from "../../tooling/pilot-lab/ids";
import { SEED_VERSION } from "../../tooling/pilot-lab/marker";
import { Rng } from "../../tooling/simulation/rng";
import { SimClock } from "../../tooling/simulation/dates";
import {
  hr,
  planHr,
  seedHr,
  HR_TABLES,
  ATTENDANCE_STATUSES,
  LEAVE_STATUSES,
  CLAIM_STATUSES,
  PAY_RUN_STATUSES,
  LEDGER_KINDS,
  CANDIDATE_STAGES,
  DISCIPLINARY_KINDS,
  type HrHandoff,
  type HrTable,
} from "../../tooling/pilot-lab/families/hr";

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

function setupHandoff(company: Company): Record<string, unknown> {
  return {
    leaveTypes: {
      annual: { id: labId(company.key, "leave_type", "annual"), policyId: "" },
      sick: { id: labId(company.key, "leave_type", "sick"), policyId: "" },
    },
    payGroups: { activeId: labId(company.key, "pay_group", "monthly"), periods: {} },
  };
}

function peopleHandoff(company: Company): Record<string, unknown> {
  const employeeIds = Array.from({ length: Math.min(company.profile.employees, 60) }, (_, i) =>
    labId(company.key, "employee", i),
  );
  return {
    personaEmployees: { hr: labId(company.key, "employee", "hr") },
    employeeIds,
    activeEmployeeIds: employeeIds,
  };
}

function fakeCtx(company: Company) {
  const store: Store = {};
  const orgId = labId(company.key, "org");
  const users = Object.fromEntries(
    PERSONAS.map((p) => [p, labId(company.key, "user", p)]),
  ) as Record<PersonaKey, string>;
  const handoffs: Record<string, Record<string, unknown>> = {
    setup: setupHandoff(company),
    people: peopleHandoff(company),
    work: {},
  };
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
      const h = handoffs[family];
      if (!h) throw new Error(`no handoff from family ${family}`);
      return h as T;
    },
    log: () => {},
    dryRun: false,
  };
  return { ctx, store };
}

async function runFor(company: Company) {
  const { ctx, store } = fakeCtx(company);
  const plan = planHr(ctx).expected;
  const report = await seedHr(ctx);
  const rows = (t: HrTable) => store[t] ?? [];
  return { ctx, plan, report, rows, handoff: report.handoff as unknown as HrHandoff };
}

const num = (v: unknown) => Number(v as number);
const paid = COMPANIES.filter((c) => hr.appliesTo(c));

describe("the hr family", () => {
  it("applies where the company runs payroll", () => {
    expect(hr.key).toBe("hr");
    expect(hr.deps).toEqual(expect.arrayContaining(["setup", "people"]));
    for (const c of COMPANIES) expect(hr.appliesTo(c)).toBe(c.profile.enables.payroll);
  });
});

for (const company of paid) {
  describe(`hr for ${company.key}`, () => {
    it("plans exactly the rows it writes", async () => {
      const r = await runFor(company);
      for (const t of HR_TABLES) expect(r.rows(t).length, t).toBe(r.plan[t]);
    });

    it("every row carries the organisation and a unique id", async () => {
      const r = await runFor(company);
      for (const t of HR_TABLES) {
        const seen = new Set<string>();
        for (const row of r.rows(t)) {
          expect(row.org_id, t).toBe(r.ctx.orgId);
          const id = row.id as string;
          expect(seen.has(id), `${t} duplicate ${id}`).toBe(false);
          seen.add(id);
        }
      }
    });

    it("is idempotent: two runs produce identical rows", async () => {
      const a = await runFor(company);
      const b = await runFor(company);
      for (const t of HR_TABLES)
        expect(JSON.stringify(a.rows(t)), t).toBe(JSON.stringify(b.rows(t)));
    });

    it("uses only legal statuses", async () => {
      const r = await runFor(company);
      for (const a of r.rows("attendance"))
        expect(ATTENDANCE_STATUSES as readonly string[]).toContain(a.status);
      for (const l of r.rows("leave_request"))
        expect(LEAVE_STATUSES as readonly string[]).toContain(l.status);
      for (const l of r.rows("leave_ledger"))
        expect(LEDGER_KINDS as readonly string[]).toContain(l.kind);
      for (const c of r.rows("expense_claim"))
        expect(CLAIM_STATUSES as readonly string[]).toContain(c.status);
      for (const p of r.rows("pay_run"))
        expect(PAY_RUN_STATUSES as readonly string[]).toContain(p.status);
      for (const c of r.rows("candidate"))
        expect(CANDIDATE_STAGES as readonly string[]).toContain(c.stage);
      for (const d of r.rows("disciplinary_record"))
        expect(DISCIPLINARY_KINDS as readonly string[]).toContain(d.kind);
      for (const e of r.rows("attendance_event"))
        expect(["in", "out", "break_start", "break_end"]).toContain(e.kind);
    });

    it("payroll arithmetic: net is gross minus deductions, everywhere", async () => {
      const r = await runFor(company);
      expect(r.rows("pay_run_line").length).toBeGreaterThan(0);
      for (const l of r.rows("pay_run_line"))
        expect(num(l.net_minor), `line ${l.id}`).toBe(num(l.gross_minor) - num(l.deduction_minor));

      const byRun = new Map<string, { g: number; d: number; n: number; e: number }>();
      for (const l of r.rows("pay_run_line")) {
        const k = l.pay_run_id as string;
        const t = byRun.get(k) ?? { g: 0, d: 0, n: 0, e: 0 };
        t.g += num(l.gross_minor);
        t.d += num(l.deduction_minor);
        t.n += num(l.net_minor);
        t.e += num(l.employer_minor);
        byRun.set(k, t);
      }
      for (const run of r.rows("pay_run")) {
        const t = byRun.get(run.id as string)!;
        expect(num(run.gross_total_minor), `${run.reference} gross`).toBe(t.g);
        expect(num(run.deduction_total_minor), `${run.reference} deductions`).toBe(t.d);
        expect(num(run.net_total_minor), `${run.reference} net`).toBe(t.n);
        expect(num(run.employer_total_minor), `${run.reference} employer`).toBe(t.e);
      }
    });

    it("a payslip exists only for a finalized run and matches its line", async () => {
      const r = await runFor(company);
      const runs = new Map(r.rows("pay_run").map((x) => [x.id as string, x]));
      const lines = new Map(r.rows("pay_run_line").map((x) => [x.id as string, x]));
      expect(r.rows("payslip").length).toBeGreaterThan(0);
      for (const s of r.rows("payslip")) {
        const run = runs.get(s.pay_run_id as string)!;
        expect(run.status, "payslips only exist for finalized runs").toBe("finalized");
        const line = lines.get(s.pay_run_line_id as string)!;
        expect(num(s.net_minor), `slip ${s.slip_no}`).toBe(num(line.net_minor));
        expect(s.employee_id).toBe(line.employee_id);
        expect(s.issued_at, "an issued slip carries its date").toBeTruthy();
      }
      // And an unfinalized run has none at all.
      const unfinalized = r.rows("pay_run").filter((x) => x.status !== "finalized");
      expect(unfinalized.length, "some runs are still moving").toBeGreaterThan(0);
      for (const run of unfinalized)
        expect(
          r.rows("payslip").some((s) => s.pay_run_id === run.id),
          `${run.reference}`,
        ).toBe(false);
    });

    it("the reversal mirrors the run it reverses", async () => {
      const r = await runFor(company);
      const reversals = r.rows("pay_run").filter((x) => x.run_kind === "reversal");
      expect(reversals.length).toBeGreaterThan(0);
      const byId = new Map(r.rows("pay_run").map((x) => [x.id as string, x]));
      for (const rev of reversals) {
        const target = byId.get(rev.reverses_run_id as string)!;
        expect(target, "a reversal names a real run").toBeTruthy();
        /*
         * The amounts MATCH, they are not negated. Payroll keeps every figure
         * non-negative — gross, deductions and employer cost, on the run and
         * on every line, with net fixed at gross minus deductions — so the
         * sign lives in run_kind and reverses_run_id, not in the money. A
         * negative payslip is not a thing payroll produces.
         */
        expect(num(rev.gross_total_minor)).toBe(num(target.gross_total_minor));
        expect(num(rev.net_total_minor)).toBe(num(target.net_total_minor));
        expect(num(rev.employer_total_minor)).toBeGreaterThanOrEqual(0);
        expect(rev.reverses_run_id).toBe(target.id);
        expect(target.run_kind).not.toBe("reversal");
      }
    });

    it("no leave balance is negative, and every approval consumed it once", async () => {
      const r = await runFor(company);
      const bal = new Map<string, number>();
      for (const l of r.rows("leave_ledger")) {
        const k = `${l.employee_id}|${l.leave_type_id}`;
        bal.set(k, (bal.get(k) ?? 0) + num(l.days));
      }
      for (const [k, v] of bal) expect(v, `balance ${k}`).toBeGreaterThanOrEqual(-1e-9);

      const approved = r.rows("leave_request").filter((l) => l.status === "approved");
      const consumed = r.rows("leave_ledger").filter((l) => l.kind === "request");
      expect(consumed.length).toBe(approved.length);
      const ids = new Set(approved.map((l) => l.id as string));
      for (const c of consumed)
        expect(ids.has(c.leave_request_id as string), "a consumption names its request").toBe(true);
      // Nothing that was not approved consumed anything.
      for (const l of r.rows("leave_request"))
        if (l.status !== "approved")
          expect(
            consumed.some((c) => c.leave_request_id === l.id),
            `${l.status} request consumed leave`,
          ).toBe(false);
    });

    it("every claim total is the sum of its own lines", async () => {
      const r = await runFor(company);
      const byClaim = new Map<string, number>();
      for (const l of r.rows("expense_claim_line")) {
        const k = l.claim_id as string;
        byClaim.set(k, (byClaim.get(k) ?? 0) + num(l.amount_minor));
        expect(num(l.amount_minor)).toBeGreaterThan(0);
      }
      expect(r.rows("expense_claim").length).toBeGreaterThan(0);
      for (const c of r.rows("expense_claim")) {
        expect(num(c.total_minor), `${c.reference}`).toBe(byClaim.get(c.id as string) ?? 0);
        expect(num(c.base_total_minor)).toBe(num(c.total_minor));
      }
    });

    it("attendance covers working days only, with a real spread of statuses", async () => {
      const r = await runFor(company);
      const rows = r.rows("attendance");
      expect(rows.length).toBeGreaterThan(0);
      const statuses = new Set(rows.map((a) => a.status as string));
      expect(statuses.size, [...statuses].join(",")).toBeGreaterThanOrEqual(4);
      for (const a of rows) {
        const dow = new Date(`${a.attendance_date}T00:00:00Z`).getUTCDay();
        expect(dow, "nobody is marked present on a Friday").not.toBe(5);
        if (!company.sixDayWeek) expect(dow, "five-day week has no Saturday").not.toBe(6);
      }
      // One employee cannot be marked twice on one day.
      const seen = new Set<string>();
      for (const a of rows) {
        const k = `${a.employee_id}|${a.attendance_date}`;
        expect(seen.has(k), `duplicate attendance ${k}`).toBe(false);
        seen.add(k);
      }
    });

    it("nothing is dated after the company's as-of date", async () => {
      const r = await runFor(company);
      const asOf = `${company.history.asOf}T23:59:59.999Z`;
      for (const t of HR_TABLES)
        for (const row of r.rows(t))
          for (const col of ["created_at", "updated_at", "finalized_at", "issued_at", "at"]) {
            const v = row[col];
            if (typeof v !== "string") continue;
            expect(v <= asOf, `${t}.${col} ${v}`).toBe(true);
          }
    });

    it("hands finance exactly the finalized runs it must post", async () => {
      const r = await runFor(company);
      const finalized = r.rows("pay_run").filter((x) => x.status === "finalized");
      expect(r.handoff.finalizedPayRunIds.length).toBe(finalized.length);
      const byId = new Map(finalized.map((x) => [x.id as string, x]));
      for (const t of r.handoff.payrollTotals) {
        const run = byId.get(t.runId)!;
        expect(run, `${t.runId} is finalized`).toBeTruthy();
        expect(t.net).toBe(num(run.net_total_minor));
        expect(t.gross).toBe(num(run.gross_total_minor));
      }
      expect(r.handoff.attendanceCount).toBe(r.rows("attendance").length);
    });
  });
}

describe("hr across the companies that run payroll", () => {
  it("one company's attendance passes the pagination boundary", async () => {
    const runs = await Promise.all(paid.map((c) => runFor(c)));
    const max = Math.max(...runs.map((r) => r.rows("attendance").length));
    expect(max).toBeGreaterThan(1205);
  });

  it("stays inside its share of the row budget", async () => {
    const runs = await Promise.all(paid.map((c) => runFor(c)));
    const totals: Record<string, number> = {};
    let grand = 0;
    for (const [i, r] of runs.entries()) {
      const n = Object.values(r.plan).reduce((a, b) => a + b, 0);
      totals[paid[i]!.key] = n;
      grand += n;
    }
    console.log(`hr planned rows per company: ${JSON.stringify(totals)} total=${grand}`);
    expect(grand).toBeLessThan(60_000);
  });
});
