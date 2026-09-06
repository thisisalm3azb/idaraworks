/**
 * H33 Pilot Lab — the `setup` family, pinned without a database.
 *
 * The family has a pure half (`planSetup`) and a service half (`runServices`).
 * This test drives the pure half through the real `seed` against an in-memory
 * insert with the service half switched off, and checks every law the family
 * claims: the plan equals what the seed writes, every row carries org_id, ids
 * are deterministic, nothing is born in a terminal state, and every structural
 * invariant (one default receiving bay per warehouse, one base unit per
 * dimension, one active pay group, one default pipeline, …) holds for all five
 * companies. Any attempt to touch a database fails the test.
 */
import { describe, expect, it, vi } from "vitest";

/*
 * These build a whole company in memory — tens of thousands of rows for the
 * larger profiles — so the 5-second default is a stopwatch on the machine, not
 * on the code. Under full-suite parallel load it fired on the biggest company
 * and looked like a logic failure.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { DEFAULT_PIPELINE_STAGES } from "@/modules/crm/sales";
import { CHART_TEMPLATE } from "@/modules/finance/chart";
import { MAX_STEPS, TOUR_KEYS } from "@/modules/guidedtour/tours";
import { COMPANIES } from "../../tooling/pilot-lab/companies";
import { id as labId } from "../../tooling/pilot-lab/ids";
import { SEED_VERSION } from "../../tooling/pilot-lab/marker";
import type { Company, LabContext, PersonaKey } from "../../tooling/pilot-lab/types";
import { iban } from "../../tooling/pilot-lab/families/_shared";
import {
  FISCAL_YEARS,
  expectedCounts,
  monthSpans,
  periodStatusFor,
  planSetup,
  seedSetup,
  setup,
  type SetupBlueprint,
  type SetupHandoff,
} from "../../tooling/pilot-lab/families/setup";
import { Rng, uuidv5 } from "../../tooling/simulation/rng";
import { SimClock } from "../../tooling/simulation/dates";

type Row = Record<string, unknown>;

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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ARABIC = /[؀-ۿ]/;
const CHART_CODES = new Set(CHART_TEMPLATE.map((a) => a.code));

/** What `run.ts` hands a family, minus the database: inserts are recorded, SQL refuses. */
function fakeCtx(company: Company, opts: { dryRun?: boolean } = {}) {
  const orgId = uuidv5(`h33:unit:${company.key}:org`);
  const users = Object.fromEntries(
    PERSONAS.map((p) => [p, uuidv5(`h33:unit:${company.key}:user:${p}`)]),
  ) as Record<PersonaKey, string>;
  const inserts: Array<{ table: string; rows: Row[]; conflict: string | undefined }> = [];
  const logs: string[] = [];
  const dbCalls: string[] = [];
  const refuse = (what: string) => {
    dbCalls.push(what);
    throw new Error(`the unit test has no database (${what})`);
  };
  const sql = Object.assign(() => refuse("sql"), { unsafe: () => refuse("sql.unsafe") });
  const ctx: LabContext = {
    sql: sql as unknown as LabContext["sql"],
    admin: new Proxy({}, { get: () => refuse("admin") }) as LabContext["admin"],
    company,
    orgId,
    users,
    employees: {},
    ctxFor: (persona) => ({
      orgId,
      userId: users[persona],
      costPrivileged: true,
      pricePrivileged: true,
      requestId: `h33-unit-${company.key}-${persona}`,
    }),
    archetypeOf: (persona) => company.personas.find((p) => p.key === persona)!.archetype,
    rng: new Rng(`h33:${SEED_VERSION}:${company.key}`),
    clock: new SimClock(company.history.asOf),
    id: (family, ...ordinal) => labId(company.key, family, ...ordinal),
    insert: async (table, rows, conflict) => {
      // The same refusals as insertBatch, plus "no missing columns" — a JSON row
      // short of a column would silently become NULL in json_populate_recordset.
      if (rows.length === 0) return { attempted: 0, inserted: 0 };
      const columns = Object.keys(rows[0]!);
      if (!columns.includes("org_id")) throw new Error(`${table}: rows must carry org_id`);
      for (const r of rows) {
        if (!r.org_id) throw new Error(`${table}: a row has no org_id`);
        for (const k of Object.keys(r))
          if (!columns.includes(k)) throw new Error(`${table}: ragged row (extra ${k})`);
        for (const c of columns)
          if (!(c in r)) throw new Error(`${table}: ragged row (missing ${c})`);
      }
      inserts.push({ table, rows: rows.map((r) => ({ ...r })), conflict });
      return { attempted: rows.length, inserted: opts.dryRun ? 0 : rows.length };
    },
    handoff: (family) => {
      throw new Error(`no handoff from family ${family} (setup declares no dependencies)`);
    },
    log: (m) => logs.push(m),
    dryRun: opts.dryRun ?? false,
  };
  return { ctx, inserts, logs, dbCalls, orgId, users };
}

/** Run the family the way run.ts does — plan, then seed on the same context. */
async function run(company: Company) {
  const f = fakeCtx(company);
  const plan = setup.plan(f.ctx);
  const report = await seedSetup(f.ctx, { services: false });
  const rows: Record<string, Row[]> = {};
  for (const i of f.inserts) rows[i.table] = [...(rows[i.table] ?? []), ...i.rows];
  const direct: Record<string, number> = {};
  for (const [t, r] of Object.entries(rows)) direct[t] = r.length;
  const blueprint = planSetup(fakeCtx(company).ctx);
  const handoff = report.handoff as unknown as SetupHandoff;
  return { ...f, plan, report, rows, direct, blueprint, handoff };
}

type Run = Awaited<ReturnType<typeof run>>;
const RUNS = new Map<string, Promise<Run>>();
const runFor = (c: Company) => {
  let r = RUNS.get(c.key);
  if (!r) {
    r = run(c);
    RUNS.set(c.key, r);
  }
  return r;
};

const byId = (rows: Row[] | undefined) => new Map((rows ?? []).map((r) => [String(r.id), r]));
const count = (rows: Row[] | undefined, pred: (r: Row) => boolean) =>
  (rows ?? []).filter(pred).length;

describe("setup family — identity and registration", () => {
  it("is keyed 'setup', depends on nothing, and applies to every company", () => {
    expect(setup.key).toBe("setup");
    expect(setup.deps).toEqual([]);
    for (const c of COMPANIES) expect(setup.appliesTo(c), c.key).toBe(true);
    expect(typeof setup.verify).toBe("function");
  });
});

describe.each(COMPANIES.map((c) => [c.key, c] as const))("setup family — %s", (_key, company) => {
  it("plan() equals what seed() writes plus what the services would add, per table", async () => {
    const r = await runFor(company);
    const seeded: Record<string, number> = { ...r.direct };
    for (const [t, n] of Object.entries(r.blueprint.service)) seeded[t] = (seeded[t] ?? 0) + n;
    expect(r.plan.expected).toEqual(seeded);
    expect(r.plan.expected).toEqual(expectedCounts(r.blueprint));
    // The report counts exactly the direct writes; the skipped services are named.
    expect(r.report.counts).toEqual(r.direct);
    expect(r.report.notes?.some((n) => n.includes("services skipped"))).toBe(true);
    // Service tables are never written directly.
    for (const t of Object.keys(r.blueprint.service)) expect(r.rows[t], t).toBeUndefined();
    expect(Object.keys(r.blueprint.service).sort()).toEqual(
      [
        "app_settings",
        "bank_account",
        "fiscal_period",
        "fiscal_year",
        "gl_account",
        ...(company.country === "AE" ? ["tax_code"] : []),
      ].sort(),
    );
  });

  it("never touches the database, in seed or in dry-run", async () => {
    const r = await runFor(company);
    expect(r.dbCalls).toEqual([]);
    const dry = fakeCtx(company, { dryRun: true });
    const report = await setup.seed(dry.ctx);
    expect(dry.dbCalls).toEqual([]);
    expect(report.counts).toEqual(r.direct);
    expect(report.notes?.some((n) => n.includes("dry-run"))).toBe(true);
    expect(dry.logs.length).toBeGreaterThan(0);
  });

  it("writes each table in one batched insert, in foreign-key order", async () => {
    const r = await runFor(company);
    const tables = r.inserts.map((i) => i.table);
    expect(new Set(tables).size).toBe(tables.length);
    const before = (a: string, b: string) => {
      if (!tables.includes(a) || !tables.includes(b)) return;
      expect(tables.indexOf(a), `${a} before ${b}`).toBeLessThan(tables.indexOf(b));
    };
    before("department", "position");
    before("warehouse", "stock_location");
    before("pay_group", "pay_period");
    before("leave_type", "leave_policy");
    before("crm_pipeline", "pipeline_stage");
    before("establishment", "establishment_registration");
    // Singletons refresh; everything else is idempotent by id.
    for (const i of r.inserts) {
      if (["org_branding", "org_app_brand", "onboarding_state"].includes(i.table))
        expect(i.conflict, i.table).toMatch(/^on conflict \(org_id(, user_id)?\) do update set /);
      else expect(i.conflict, i.table).toBe("nothing");
    }
  });

  it("every row carries the organisation, and every id is a unique v5 uuid", async () => {
    const r = await runFor(company);
    for (const [table, rows] of Object.entries(r.rows)) {
      expect(rows.length, table).toBeGreaterThan(0);
      const ids = new Set<string>();
      for (const row of rows) {
        expect(row.org_id, table).toBe(r.orgId);
        if ("id" in row) {
          expect(String(row.id), table).toMatch(UUID_RE);
          expect(ids.has(String(row.id)), `${table} duplicate id`).toBe(false);
          ids.add(String(row.id));
        }
        for (const k of ["created_by", "manager_user_id", "user_id"])
          if (k in row && row[k] != null)
            expect(Object.values(r.users), `${table}.${k}`).toContain(row[k]);
      }
    }
  });

  it("is deterministic: a second run produces identical rows and handoff", async () => {
    const a = await runFor(company);
    const b = await run(company);
    expect(b.rows).toEqual(a.rows);
    expect(b.handoff).toEqual(a.handoff);
    expect(b.plan).toEqual(a.plan);
  });

  it("no row is born in a terminal or service-owned state", async () => {
    const r = await runFor(company);
    const forbiddenKeys = [
      "posted_at",
      "finalized",
      "issued_snapshot_id",
      "closed_at",
      "verified_at",
    ];
    const forbiddenStatus = new Set([
      "posted",
      "finalized",
      "issued",
      "terminated",
      "disposed",
      "locked",
      "soft_closed",
    ]);
    for (const [table, rows] of Object.entries(r.rows))
      for (const row of rows) {
        for (const k of forbiddenKeys) expect(k in row, `${table}.${k}`).toBe(false);
        if (typeof row.status === "string")
          expect(forbiddenStatus.has(row.status), `${table}.status=${row.status}`).toBe(false);
      }
    expect(r.rows.fiscal_year).toBeUndefined();
    expect(r.rows.fiscal_period).toBeUndefined();
    expect(r.rows.gl_account).toBeUndefined();
    expect(r.rows.bank_account).toBeUndefined();
    expect(r.rows.tenant_host).toBeUndefined();
    expect(r.rows.establishment_pack_adoption).toBeUndefined();
  });

  it("departments, cost centres, positions, teams, locations and shifts are coherent", async () => {
    const r = await runFor(company);
    const depts = byId(r.rows.department);
    const codes = new Set<string>();
    for (const d of r.rows.department!) {
      expect(String(d.name_en).length).toBeLessThanOrEqual(120);
      expect(String(d.name_ar)).toMatch(ARABIC);
      expect(String(d.code).length).toBeLessThanOrEqual(24);
      expect(codes.has(String(d.code))).toBe(false);
      codes.add(String(d.code));
      if (d.parent_id) {
        expect(depts.has(String(d.parent_id))).toBe(true);
        expect(d.parent_id).not.toBe(d.id);
      }
      expect(d.cost_centre).toBe(`CC-${d.code}`);
      expect(r.handoff.departments[String(d.code)]).toBe(d.id);
    }
    expect(count(r.rows.department, (d) => d.active === false)).toBe(1);
    // One cost centre per department, same code, parents mirrored.
    const centres = new Map(r.rows.cost_centre!.map((c) => [String(c.code), c]));
    expect(centres.size).toBe(r.rows.department!.length);
    for (const d of r.rows.department!) {
      const c = centres.get(String(d.cost_centre));
      expect(c, String(d.cost_centre)).toBeDefined();
      expect(String(c!.code).length).toBeLessThanOrEqual(20);
      expect(r.handoff.costCentres[String(c!.code)]).toBe(c!.id);
    }
    for (const p of r.rows.position!) {
      expect(depts.has(String(p.department_id)), String(p.name_en)).toBe(true);
      expect(String(p.grade)).toMatch(/^G[1-6]$/);
    }
    expect(Object.keys(r.handoff.positions).length).toBe(r.rows.position!.length);
    for (const t of r.rows.team!) {
      expect(["trade", "line"]).toContain(t.kind);
      expect(String(t.name).length).toBeLessThanOrEqual(80);
    }
    expect(count(r.rows.team, (t) => t.active === false)).toBe(1);
    expect(r.rows.team!.length).toBeGreaterThanOrEqual(4);
    for (const l of r.rows.work_location!) {
      expect(l.country).toBe(company.country);
      expect(String(l.address).length).toBeLessThanOrEqual(400);
      expect(String(l.address)).toMatch(ARABIC);
      expect(String(l.address)).toContain("Fictional");
    }
    expect(r.rows.work_location!.length).toBeGreaterThanOrEqual(3);
    for (const s of r.rows.shift!) {
      expect(String(s.starts_at)).toMatch(/^\d{2}:\d{2}$/);
      expect(String(s.ends_at)).toMatch(/^\d{2}:\d{2}$/);
      expect(Number(s.break_minutes)).toBeGreaterThanOrEqual(0);
      expect(Number(s.break_minutes)).toBeLessThanOrEqual(480);
    }
    expect(count(r.rows.shift, (s) => s.active === true)).toBeGreaterThanOrEqual(1);
    expect(Object.keys(r.handoff.shifts).length).toBe(r.rows.shift!.length);
  });

  it("warehouses have location trees with one receiving bay and one issue bin each; units have one base per dimension", async () => {
    const r = await runFor(company);
    expect(company.profile.enables.stock).toBe(true);
    const whs = r.rows.warehouse!;
    const expectedWarehouses: Record<string, number> = {
      gulfbuild: 3,
      tradeline: 3,
      saudimfg: 3,
      consult: 1,
      facilico: 3,
    };
    expect(whs.length).toBe(expectedWarehouses[company.key]);
    const whCodes = whs.map((w) => String(w.code));
    if (company.key === "gulfbuild")
      expect(whCodes.filter((c) => c.startsWith("SITE-")).length).toBe(2);
    if (company.key === "facilico") expect(whCodes).toContain("SPARE");
    if (company.key === "tradeline") expect(whCodes).toEqual(["JAFZ", "SHJ", "AUH"]);
    for (const w of whs) {
      expect(String(w.email)).toMatch(/@example\.invalid$/);
      expect(String(w.phone)).toMatch(/^\+9(71|66) 50 000 \d{4}$/);
      expect(w.manager_user_id).toBe(r.users.warehouse);
      const h = r.handoff.warehouses[String(w.code)]!;
      expect(h.id).toBe(w.id);
      const locs = r.rows.stock_location!.filter((l) => l.warehouse_id === w.id);
      expect(locs.length).toBeGreaterThanOrEqual(6);
      const codes = new Set(locs.map((l) => String(l.code)));
      expect(codes.size).toBe(locs.length);
      const recv = locs.filter((l) => l.is_default_receiving === true);
      const issue = locs.filter((l) => l.is_default_issue === true);
      expect(recv.length).toBe(1);
      expect(issue.length).toBe(1);
      expect(recv[0]!.kind).toBe("receiving");
      expect(recv[0]!.can_hold_stock).toBe(true);
      expect(issue[0]!.kind).toBe("storage");
      expect(issue[0]!.can_hold_stock).toBe(true);
      expect(h.receivingLocationId).toBe(recv[0]!.id);
      expect(h.issueLocationId).toBe(issue[0]!.id);
      expect(Object.keys(h.locations).length).toBe(locs.length);
      const locIds = byId(locs);
      for (const l of locs) {
        expect([
          "storage",
          "receiving",
          "dispatch",
          "quarantine",
          "damaged",
          "returns",
          "transit",
        ]).toContain(l.kind);
        expect(String(l.code).length).toBeLessThanOrEqual(24);
        expect(String(l.name_en).length).toBeLessThanOrEqual(120);
        if (l.parent_id) {
          expect(
            locIds.has(String(l.parent_id)),
            `parent of ${String(l.code)} in same warehouse`,
          ).toBe(true);
          expect(locIds.get(String(l.parent_id))!.can_hold_stock).toBe(false);
        }
        if (l.is_default_receiving || l.is_default_issue) expect(l.can_hold_stock).toBe(true);
      }
      expect(locs.some((l) => l.kind === "quarantine")).toBe(true);
    }
    const units = r.rows.unit_of_measure!;
    const dims = new Map<string, Row[]>();
    for (const u of units) {
      expect(["count", "mass", "volume", "length", "area", "time"]).toContain(u.dimension);
      expect(Number(u.factor_to_base)).toBeGreaterThan(0);
      expect(u.is_base).toBe(Number(u.factor_to_base) === 1);
      expect(String(u.code).length).toBeLessThanOrEqual(16);
      expect(String(u.name_ar)).toMatch(ARABIC);
      dims.set(String(u.dimension), [...(dims.get(String(u.dimension)) ?? []), u]);
      expect(r.handoff.units[String(u.code)]?.id).toBe(u.id);
    }
    expect(dims.size).toBe(6);
    for (const [dim, list] of dims) {
      expect(list.filter((u) => u.is_base).length, dim).toBe(1);
      expect(list.length, `${dim} has conversions`).toBeGreaterThanOrEqual(2);
    }
    expect(new Set(units.map((u) => u.code)).size).toBe(units.length);
  });

  it("tax: the UAE pack and profile come from the service; Saudi codes are custom and unlabelled", async () => {
    const r = await runFor(company);
    if (company.country === "AE") {
      expect(r.rows.tax_code).toBeUndefined();
      expect(r.blueprint.service.tax_code).toBe(5);
      expect(r.blueprint.service.app_settings).toBe(2);
      expect(r.handoff.vatProfile).not.toBeNull();
      expect(r.handoff.vatProfile!.trn).toMatch(/^1999\d{11}$/);
      expect(["AUH", "DXB", "SHJ", "AJM", "UAQ", "RAK", "FUJ"]).toContain(
        r.handoff.vatProfile!.emirate,
      );
      expect(["monthly", "quarterly"]).toContain(r.handoff.vatProfile!.periodicity);
      expect(r.handoff.vatProfile!.registered).toBe(true);
    } else {
      expect(r.blueprint.service.tax_code).toBeUndefined();
      expect(r.blueprint.service.app_settings).toBe(1);
      expect(r.handoff.vatProfile).toBeNull();
      const codes = r.rows.tax_code!;
      expect(codes.length).toBe(4);
      for (const t of codes) {
        expect(t.is_custom).toBe(true);
        expect(t.pack_version).toBeNull();
        expect(t.jurisdiction).toBe("SA");
        expect(["standard", "zero_rated", "exempt", "out_of_scope", "reverse_charge"]).toContain(
          t.treatment,
        );
        expect(Number(t.rate_percent)).toBeLessThanOrEqual(100);
        expect(r.handoff.taxCodes[String(t.code)]).toBe(t.id);
      }
      expect(codes.map((t) => t.treatment)).toEqual([
        "standard",
        "zero_rated",
        "exempt",
        "out_of_scope",
      ]);
    }
  });

  it("fiscal calendar 2023–2026: the services create 4 years × 12 periods; 2023–24 locked, 2025 mixed, 2026 open", async () => {
    const r = await runFor(company);
    expect(r.blueprint.service.fiscal_year).toBe(4);
    expect(r.blueprint.service.fiscal_period).toBe(48);
    expect(r.blueprint.periodPlan.length).toBe(48);
    expect(FISCAL_YEARS).toEqual([2023, 2024, 2025, 2026]);
    const by = (y: number) =>
      r.blueprint.periodPlan.filter((p) => p.year === y).map((p) => p.status);
    expect(new Set(by(2023))).toEqual(new Set(["locked"]));
    expect(new Set(by(2024))).toEqual(new Set(["locked"]));
    expect(new Set(by(2025))).toEqual(new Set(["locked", "soft_closed", "open"]));
    expect(new Set(by(2026))).toEqual(new Set(["open"]));
    // Monotone within 2025: once open, never closed again later in the year.
    const s2025 = by(2025);
    const rank = { locked: 0, soft_closed: 1, open: 2 } as const;
    for (let i = 1; i < s2025.length; i++)
      expect(rank[s2025[i]!]).toBeGreaterThanOrEqual(rank[s2025[i - 1]!]);
    for (const p of r.blueprint.periodPlan)
      expect(p.status).toBe(periodStatusFor(p.year, p.periodNo));
    // The chart and the bank GL accounts are the whole gl_account plan.
    expect(r.blueprint.service.gl_account).toBe(
      CHART_TEMPLATE.length + r.blueprint.bankAccounts.length,
    );
    expect(r.handoff.glChart.installed).toBe(false);
    expect(r.handoff.glChart.templateVersion).toMatch(/^core-\d{4}-\d{2}-\d{2}$/);
  });

  it("bank accounts: three specs on fresh GL codes with structurally invalid IBANs", async () => {
    const r = await runFor(company);
    const banks = r.blueprint.bankAccounts;
    expect(banks.length).toBe(3);
    expect(r.blueprint.service.bank_account).toBe(3);
    expect(new Set(banks.map((b) => b.name)).size).toBe(3);
    expect(new Set(banks.map((b) => b.glCode)).size).toBe(3);
    for (const b of banks) {
      expect(["bank", "cash", "petty_cash", "card_clearing"]).toContain(b.kind);
      expect(CHART_CODES.has(b.glCode), `${b.glCode} not a template code`).toBe(false);
      expect(b.name.length).toBeLessThanOrEqual(120);
      if (b.ibanIndex) {
        expect(iban(company, b.ibanIndex)).toMatch(
          company.country === "SA" ? /^SA00 0000 / : /^AE00 0000 /,
        );
        expect(b.bankName).toContain("fictional");
      } else {
        expect(b.bankName === null || b.bankName.includes("fictional")).toBe(true);
      }
    }
    expect(banks.filter((b) => b.kind === "petty_cash").length).toBe(1);
    expect(banks.filter((b) => b.cheques).length).toBe(1);
  });

  it("payroll: one active pay group and contiguous monthly periods from the first month to as-of", async () => {
    const r = await runFor(company);
    expect(company.profile.enables.payroll).toBe(true);
    const groups = r.rows.pay_group!;
    expect(groups.filter((g) => g.active === true).length).toBe(1);
    expect(groups.length).toBe(2);
    for (const g of groups) {
      expect(["monthly", "weekly", "biweekly", "custom"]).toContain(g.frequency);
      expect([1, 5, 10, 25, 50, 100]).toContain(g.rounding_minor);
    }
    const active = groups.find((g) => g.active === true)!;
    expect(r.handoff.payGroups.activeId).toBe(active.id);
    const periods = r.rows.pay_period!;
    const spans = monthSpans(company.history.from, company.history.asOf);
    expect(periods.length).toBe(spans.length);
    expect(periods.length).toBeGreaterThanOrEqual(25);
    for (let i = 0; i < periods.length; i++) {
      const p = periods[i]!;
      expect(p.pay_group_id).toBe(active.id);
      expect(String(p.period_start)).toBe(spans[i]!.start);
      expect(String(p.period_end)).toBe(spans[i]!.end);
      expect(String(p.period_end) >= String(p.period_start)).toBe(true);
      if (i > 0) {
        const prev = new Date(`${periods[i - 1]!.period_end}T00:00:00Z`).getTime();
        expect(new Date(`${p.period_start}T00:00:00Z`).getTime() - prev).toBe(86_400_000);
      }
      expect(r.handoff.payGroups.periods[String(p.period_start).slice(0, 7)]).toBe(p.id);
    }
    expect(String(periods[0]!.period_start)).toBe(company.history.from.slice(0, 7) + "-01");
    expect(String(periods[periods.length - 1]!.period_end) >= company.history.asOf).toBe(true);
    expect(new Set(periods.map((p) => `${p.period_start}|${p.period_end}`)).size).toBe(
      periods.length,
    );
  });

  it("leave: every type has exactly one active v1 policy with legal numbers; the Saudi company adds Hajj", async () => {
    const r = await runFor(company);
    const types = r.rows.leave_type!;
    const policies = r.rows.leave_policy!;
    expect(types.length).toBe(company.country === "SA" ? 7 : 6);
    expect(policies.length).toBe(types.length);
    const typeIds = byId(types);
    for (const t of types) {
      expect(String(t.key)).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
      expect(["working_days", "calendar_days"]).toContain(t.count_basis);
      const label = t.label as { en: string; ar: string };
      expect(label.ar).toMatch(ARABIC);
      const mine = policies.filter((p) => p.leave_type_id === t.id && p.active === true);
      expect(mine.length, String(t.key)).toBe(1);
      expect(mine[0]!.version).toBe(1);
      expect(r.handoff.leaveTypes[String(t.key)]).toEqual({ id: t.id, policyId: mine[0]!.id });
    }
    for (const p of policies) {
      expect(typeIds.has(String(p.leave_type_id))).toBe(true);
      expect(["annual_fixed", "monthly_accrual", "none"]).toContain(p.accrual_basis);
      if (p.annual_days != null) {
        expect(Number(p.annual_days)).toBeGreaterThanOrEqual(0);
        expect(Number(p.annual_days)).toBeLessThanOrEqual(365);
      }
      if (p.monthly_accrual_days != null)
        expect(Number(p.monthly_accrual_days)).toBeLessThanOrEqual(31);
      if (p.carryover_cap_days != null)
        expect(Number(p.carryover_cap_days)).toBeGreaterThanOrEqual(0);
      expect(p.created_by).toBe(r.users.hr);
    }
    const annual = policies.find(
      (p) => p.leave_type_id === types.find((t) => t.key === "annual")!.id,
    )!;
    expect(Number(annual.annual_days)).toBe(company.country === "SA" ? 21 : 30);
    expect(types.some((t) => t.key === "hajj")).toBe(company.country === "SA");
    expect(types.some((t) => t.key === "unpaid" && t.paid === false)).toBe(true);
  });

  it("asset categories form a tree with legal depreciation defaults", async () => {
    const r = await runFor(company);
    expect(company.profile.enables.assets).toBe(true);
    const cats = r.rows.asset_category!;
    const ids = byId(cats);
    expect(new Set(cats.map((c) => c.code)).size).toBe(cats.length);
    for (const c of cats) {
      expect(String(c.code).length).toBeLessThanOrEqual(32);
      if (c.parent_id) {
        expect(ids.has(String(c.parent_id)), String(c.code)).toBe(true);
        expect(c.parent_id).not.toBe(c.id);
      }
      if (c.default_useful_life_months != null)
        expect(Number(c.default_useful_life_months)).toBeGreaterThan(0);
      if (c.default_residual_pct != null) {
        expect(Number(c.default_residual_pct)).toBeGreaterThanOrEqual(0);
        expect(Number(c.default_residual_pct)).toBeLessThan(100);
      }
      expect(r.handoff.assetCategories[String(c.code)]).toBe(c.id);
    }
    expect(cats.filter((c) => c.parent_id).length).toBeGreaterThanOrEqual(4);
    expect(count(cats, (c) => c.active === false)).toBe(1);
    if (company.key === "gulfbuild" || company.key === "saudimfg")
      expect(cats.some((c) => c.code === "PLANT")).toBe(true);
  });

  it("CRM: one default pipeline carrying the product's stage keys; every stage attached; won and lost per pipeline", async () => {
    const r = await runFor(company);
    expect(company.profile.enables.revenue).toBe(true);
    const pipelines = r.rows.crm_pipeline!;
    const stages = r.rows.pipeline_stage!;
    expect(pipelines.filter((p) => p.is_default === true).length).toBe(1);
    const dflt = pipelines.find((p) => p.is_default === true)!;
    expect(dflt.key).toBe("default");
    const defaultStages = stages
      .filter((s) => s.pipeline_id === dflt.id)
      .sort((a, b) => Number(a.sort) - Number(b.sort));
    expect(defaultStages.map((s) => s.key)).toEqual(DEFAULT_PIPELINE_STAGES.map((s) => s.key));
    expect(defaultStages.map((s) => s.category)).toEqual(
      DEFAULT_PIPELINE_STAGES.map((s) => s.category),
    );
    const pipelineIds = byId(pipelines);
    expect(new Set(stages.map((s) => s.key)).size).toBe(stages.length);
    for (const s of stages) {
      expect(pipelineIds.has(String(s.pipeline_id)), String(s.key)).toBe(true);
      expect(String(s.key)).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
      expect(["open", "won", "lost"]).toContain(s.category);
      expect(Array.isArray(s.requirements)).toBe(true);
      if (s.default_probability != null) {
        expect(Number(s.default_probability)).toBeGreaterThanOrEqual(0);
        expect(Number(s.default_probability)).toBeLessThanOrEqual(100);
      }
      if (s.max_age_days != null) expect(Number(s.max_age_days)).toBeGreaterThanOrEqual(1);
      if (s.category !== "open") expect(s.requirements).toEqual([]);
    }
    for (const p of pipelines) {
      expect(String(p.key)).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
      expect(["new_business", "expansion", "renewal", "custom"]).toContain(p.kind);
      const mine = stages.filter((s) => s.pipeline_id === p.id);
      expect(mine.filter((s) => s.category === "won").length, String(p.key)).toBe(1);
      expect(mine.filter((s) => s.category === "lost").length, String(p.key)).toBe(1);
      expect(mine.filter((s) => s.category === "open").length).toBeGreaterThanOrEqual(2);
      const h = r.handoff.pipelines[String(p.key)]!;
      expect(h.id).toBe(p.id);
      expect(Object.keys(h.stages).length).toBe(mine.length);
      for (const s of mine)
        expect(h.stages[String(s.key)]).toEqual({ id: s.id, category: s.category });
    }
    const extra: Record<string, number> = {
      gulfbuild: 1,
      tradeline: 2,
      saudimfg: 1,
      consult: 2,
      facilico: 2,
    };
    expect(pipelines.length).toBe(extra[company.key]);
  });

  it("document folders form a tree with one archived branch and company-specific operations folders", async () => {
    const r = await runFor(company);
    expect(company.profile.enables.docstudio).toBe(true);
    const folders = r.rows.doc_folder!;
    const ids = byId(folders);
    for (const f of folders) {
      expect(String(f.name).trim().length).toBeGreaterThan(0);
      expect(String(f.name).length).toBeLessThanOrEqual(120);
      if (f.parent_id) expect(ids.has(String(f.parent_id))).toBe(true);
      expect(f.created_by).toBe(r.users.admin);
    }
    expect(count(folders, (f) => f.archived_at != null)).toBe(1);
    expect(count(folders, (f) => f.parent_id == null)).toBe(5);
    expect(Object.keys(r.handoff.folders).length).toBe(folders.length);
    expect(r.handoff.folders["ops"]).toBeDefined();
    expect(Object.keys(r.handoff.folders).filter((k) => k.startsWith("ops/")).length).toBe(2);
    if (company.languages[0] === "ar")
      for (const f of folders) expect(String(f.name)).toMatch(ARABIC);
  });

  it("FX rate book: three foreign currencies into the base, quarterly from the first day", async () => {
    const r = await runFor(company);
    const rates = r.rows.currency_rate!;
    const from = new Set(rates.map((x) => x.from_currency));
    expect(from.size).toBe(3);
    expect(from.has(company.currency)).toBe(false);
    for (const x of rates) {
      expect(x.to_currency).toBe(company.currency);
      expect(Number(x.rate)).toBeGreaterThan(0);
      expect(["manual", "import"]).toContain(x.source);
      expect(x.created_by).toBe(r.users.finance);
    }
    expect(
      new Set(rates.map((x) => `${x.from_currency}|${x.to_currency}|${x.effective_at}`)).size,
    ).toBe(rates.length);
    const first = rates.map((x) => String(x.effective_at)).sort()[0]!;
    expect(first.slice(0, 10)).toBe(company.history.from);
    const usd = rates.filter((x) => x.from_currency === "USD");
    expect(new Set(usd.map((x) => x.rate)).size).toBe(1); // pegged
    expect(usd.length).toBeGreaterThanOrEqual(12);
  });

  it("establishments exist only for the Saudi company: one primary, unverified, no pack, fake registrations", async () => {
    const r = await runFor(company);
    if (!company.profile.enables.establishment) {
      expect(r.rows.establishment).toBeUndefined();
      expect(r.rows.establishment_registration).toBeUndefined();
      expect(r.handoff.establishments).toEqual({});
      return;
    }
    const est = r.rows.establishment!;
    expect(est.length).toBe(2);
    expect(est.filter((e) => e.is_primary === true).length).toBe(1);
    for (const e of est) {
      expect(String(e.code)).toMatch(/^[A-Z0-9][A-Z0-9_-]{0,23}$/);
      expect(e.pack_key).toBeNull();
      expect(e.verification_state).toBe("unverified");
      expect(e.status).toBe("active");
      expect(e.country).toBe("SA");
      expect(e.base_currency).toBe("SAR");
      expect(String(e.legal_name)).toContain("fictional");
      expect(String(e.legal_name_local)).toMatch(ARABIC);
      expect(r.handoff.establishments[String(e.code)]).toBe(e.id);
    }
    const ids = byId(est);
    const regs = r.rows.establishment_registration!;
    expect(regs.length).toBe(4);
    for (const g of regs) {
      expect(ids.has(String(g.establishment_id))).toBe(true);
      expect([
        "tax_registration",
        "commercial_registration",
        "payroll_establishment",
        "national_id",
        "other",
      ]).toContain(g.kind);
      expect(g.verification_state).toBe("unverified");
      expect(String(g.value).length).toBeLessThanOrEqual(80);
    }
    const vat = regs.find((g) => g.identifier_key === "vat_number")!;
    expect(String(vat.value)).toMatch(/^399999\d{8}3$/);
    expect(new Set(regs.map((g) => `${g.establishment_id}|${g.identifier_key}`)).size).toBe(
      regs.length,
    );
  });

  it("branding and app identity carry the company colour and claim no tenant host", async () => {
    const r = await runFor(company);
    const [b] = r.rows.org_branding!;
    expect(b!.accent_color).toBe(company.brandColor);
    expect(String(b!.footer_details).length).toBeLessThanOrEqual(500);
    expect(String(b!.footer_details)).toContain("Fictional");
    expect(String(b!.display_name).length).toBeLessThanOrEqual(120);
    const [a] = r.rows.org_app_brand!;
    expect(a!.brand_color).toBe(company.brandColor);
    expect(String(a!.background_color)).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(String(a!.app_name).length).toBeLessThanOrEqual(60);
    expect(String(a!.app_short_name).length).toBeGreaterThanOrEqual(1);
    expect(String(a!.app_short_name).length).toBeLessThanOrEqual(12);
    expect(String(a!.app_description).length).toBeLessThanOrEqual(300);
    expect(a!.default_locale).toBe(company.languages[0]);
    expect(r.rows.org_branding!.length).toBe(1);
    expect(r.rows.org_app_brand!.length).toBe(1);
    expect(r.rows.tenant_host).toBeUndefined();
  });

  it("onboarding: field completed, restricted skipped, hr in progress at step 2; nobody else", async () => {
    const r = await runFor(company);
    const ob = r.rows.onboarding_state!;
    expect(ob.length).toBe(3);
    const of = (p: PersonaKey) => ob.find((x) => x.user_id === r.users[p]);
    expect(of("field")).toMatchObject({ status: "completed", tour_key: "field" });
    expect(of("field")!.completed_at).not.toBeNull();
    expect(of("restricted")).toMatchObject({ status: "skipped", tour_key: "field" });
    expect(of("restricted")!.dismissed_at).not.toBeNull();
    expect(of("hr")).toMatchObject({ status: "in_progress", step_index: 2, tour_key: "owner" });
    for (const x of ob) {
      expect(["new", "welcomed", "in_progress", "completed", "skipped"]).toContain(x.status);
      expect(TOUR_KEYS).toContain(x.tour_key);
      expect(Number(x.step_index)).toBeLessThanOrEqual(MAX_STEPS);
      expect(Number(x.tour_version)).toBeGreaterThanOrEqual(1);
    }
    expect(new Set(ob.map((x) => x.user_id)).size).toBe(3);
  });

  it("the handoff names every id a later family needs, and stays small", async () => {
    const r = await runFor(company);
    const h = r.handoff;
    expect(Object.keys(h.departments).length).toBe(r.rows.department!.length);
    expect(Object.keys(h.teams).length).toBe(r.rows.team!.length);
    expect(Object.keys(h.workLocations).length).toBe(r.rows.work_location!.length);
    expect(Object.keys(h.warehouses).length).toBe(r.rows.warehouse!.length);
    expect(Object.keys(h.units).length).toBe(r.rows.unit_of_measure!.length);
    expect(h.units["pcs"]).toMatchObject({ dimension: "count", factorToBase: 1, isBase: true });
    expect(h.fiscalYears).toEqual({});
    expect(h.fiscalPeriods).toEqual([]);
    expect(h.bankAccounts).toEqual({});
    expect(h.glChart.accountsBySystemKey).toEqual({});
    expect(JSON.stringify(h).length).toBeLessThan(64 * 1024);
    expect(Object.keys(r.plan.expected).length).toBeGreaterThanOrEqual(24);
  });

  it("all bulk rows are dated at the start of the company's history, in the past", async () => {
    const r = await runFor(company);
    const from = new Date(`${company.history.from}T00:00:00Z`).getTime();
    const asOf = new Date(`${company.history.asOf}T23:59:59Z`).getTime();
    for (const [table, rows] of Object.entries(r.rows))
      for (const row of rows)
        if (typeof row.created_at === "string") {
          const t = Date.parse(row.created_at);
          expect(t, `${table}.created_at`).toBeGreaterThanOrEqual(from);
          expect(t, `${table}.created_at`).toBeLessThanOrEqual(asOf);
        }
  });
});

describe("setup family — across companies", () => {
  it("row ids never collide between companies", async () => {
    const seen = new Map<string, string>();
    for (const c of COMPANIES) {
      const r = await runFor(c);
      for (const rows of Object.values(r.rows))
        for (const row of rows)
          if ("id" in row) {
            const id = String(row.id);
            expect(seen.get(id), `${id} in ${c.key} and ${seen.get(id)}`).toBeUndefined();
            seen.set(id, c.key);
          }
    }
  });

  it("every company is structurally different (its own departments, warehouses and pipelines)", async () => {
    const signatures = new Set<string>();
    for (const c of COMPANIES) {
      const r = await runFor(c);
      signatures.add(
        [
          r.rows.department!.map((d) => d.code).join(","),
          r.rows.warehouse!.map((w) => w.code).join(","),
          r.rows.crm_pipeline!.map((p) => p.key).join(","),
        ].join("|"),
      );
    }
    expect(signatures.size).toBe(COMPANIES.length);
  });

  it("the blueprint's service plan is consistent with the count it reports", async () => {
    for (const c of COMPANIES) {
      const r = await runFor(c);
      const b: SetupBlueprint = r.blueprint;
      const total = Object.values(b.service).reduce((a, n) => a + n, 0);
      expect(total).toBe(4 + 48 + CHART_TEMPLATE.length + 3 + 3 + (c.country === "AE" ? 5 + 2 : 1));
    }
  });
});
