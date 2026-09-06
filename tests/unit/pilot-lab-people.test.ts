/**
 * H33 — the `people` family, pinned without a database.
 *
 * A fake LabContext records every insert in memory; the HR-service half of the
 * seed is switched off (`seedPeople(ctx, { services: false })`), so what is
 * asserted here is exactly what the seed would write directly, for every
 * company: the dry-run plan matches the writes, every row carries the org,
 * ids are deterministic, no row is born in a state only the service may
 * reach, and the invariants the family claims (persona links, structure from
 * setup, reconciled pay, one instruction each, covered schedules, fake
 * identifiers) hold in the rows themselves.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/*
 * These build a whole company in memory — tens of thousands of rows for the
 * larger profiles — so the 5-second default is a stopwatch on the machine, not
 * on the code. Under full-suite parallel load it fired on the biggest company
 * and looked like a logic failure.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import type { Ctx } from "@/platform/tenancy/ctx";
import { COMPANIES, personaEmail } from "../../tooling/pilot-lab/companies";
import { id as labId } from "../../tooling/pilot-lab/ids";
import type { SetupHandoff } from "../../tooling/pilot-lab/families/setup";
import {
  BORN_LIFECYCLES,
  PERSONA_EMPLOYEES,
  REQUIRED_PERSONA_EMPLOYEES,
  SERVICE_ONLY_EVENTS,
  TABLE_ORDER,
  fakeIdPrefix,
  hourlyOf,
  people,
  planFor,
  seedPeople,
  setupRefsFor,
  type PeopleHandoff,
} from "../../tooling/pilot-lab/families/people";
import type { Company, LabContext, PersonaKey } from "../../tooling/pilot-lab/types";
import { Rng, uuidv5 } from "../../tooling/simulation/rng";
import { SimClock } from "../../tooling/simulation/dates";

type Row = Record<string, unknown>;
type Store = Map<string, Row[]>;

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

/** The setup handoff exactly as setup's deterministic ids would produce it. */
function fakeSetupHandoff(company: Company, id: LabContext["id"]): SetupHandoff {
  const refs = setupRefsFor(company);
  return {
    departments: Object.fromEntries(refs.departments.map((c) => [c, id("setup", "department", c)])),
    costCentres: {},
    positions: Object.fromEntries(
      refs.positions.map((p) => [
        p.key,
        { id: id("setup", "position", p.key), department: p.dept },
      ]),
    ),
    teams: Object.fromEntries(refs.teams.map((t) => [t, id("setup", "team", t)])),
    workLocations: Object.fromEntries(
      refs.workLocations.map((l) => [l, id("setup", "work_location", l)]),
    ),
    shifts: Object.fromEntries(refs.shifts.map((s) => [s, id("setup", "shift", s)])),
    warehouses: {},
    units: {},
    taxCodes: {},
    vatProfile: null,
    glChart: { installed: false, templateVersion: "test", accountsBySystemKey: {} },
    fiscalYears: {},
    fiscalPeriods: [],
    bankAccounts: {},
    payGroups: { activeId: "", periods: {} },
    leaveTypes: {},
    assetCategories: {},
    pipelines: {},
    folders: {},
    establishments: {},
  };
}

function fakeCtx(company: Company, store: Store, opts: { dryRun?: boolean } = {}): LabContext {
  const orgId = uuidv5(`h33-test:org:${company.key}`);
  const users = Object.fromEntries(
    PERSONAS.map((p) => [p, uuidv5(`h33-test:user:${company.key}:${p}`)]),
  ) as Record<PersonaKey, string>;
  const id: LabContext["id"] = (family, ...ordinal) => labId(company.key, family, ...ordinal);
  const setupHandoff = fakeSetupHandoff(company, id);
  return {
    sql: null as unknown as LabContext["sql"],
    admin: null as unknown as LabContext["admin"],
    company,
    orgId,
    users,
    employees: {},
    ctxFor: (persona): Ctx => {
      const p = company.personas.find((x) => x.key === persona)!;
      const privileged = p.roleKey === "owner" || p.roleKey === "admin" || p.roleKey === "accounts";
      return {
        orgId,
        userId: users[persona],
        costPrivileged: privileged,
        pricePrivileged: privileged,
        requestId: `test-${company.key}-${persona}`,
      };
    },
    archetypeOf: (persona) => company.personas.find((x) => x.key === persona)!.archetype,
    rng: new Rng(`h33:test:${company.key}`),
    clock: new SimClock(company.history.asOf),
    id,
    insert: async (table, rows) => {
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`unsafe table ${table}`);
      if (rows.length === 0) return { attempted: 0, inserted: 0 };
      const columns = Object.keys(rows[0]!).sort();
      if (!columns.includes("org_id")) throw new Error(`${table}: rows must carry org_id`);
      for (const r of rows) {
        if (!r.org_id) throw new Error(`${table}: a row has no org_id`);
        const keys = Object.keys(r).sort();
        if (keys.join(",") !== columns.join(","))
          throw new Error(`${table}: ragged row (${keys.join(",")} vs ${columns.join(",")})`);
      }
      store.set(table, [...(store.get(table) ?? []), ...rows]);
      return { attempted: rows.length, inserted: rows.length };
    },
    // Grouped writes are one transaction live; in memory the tables are
    // simply written in the order given.
    insertGroup: async (entries: Array<{ table: string; rows: Row[]; conflict?: string }>) => {
      const out: Record<string, { attempted: number; inserted: number }> = {};
      for (const e of entries) {
        out[e.table] = { attempted: e.rows.length, inserted: e.rows.length };
        store.set(e.table, [...(store.get(e.table) ?? []), ...e.rows]);
      }
      return out;
    },
    handoff: <T>(family: string): T => {
      if (family !== "setup") throw new Error(`no handoff from family ${family}`);
      return setupHandoff as T;
    },
    log: () => {},
    dryRun: opts.dryRun ?? false,
  };
}

async function seedInMemory(company: Company) {
  const store: Store = new Map();
  const ctx = fakeCtx(company, store);
  const report = await seedPeople(ctx, { services: false });
  const plan = planFor(ctx);
  return { ctx, store, report, plan, handoff: report.handoff as unknown as PeopleHandoff };
}

const rows = (store: Store, table: string): Row[] => store.get(table) ?? [];
const str = (r: Row, k: string) => r[k] as string;

// ── setup.ts as text: the keys people relies on must be the keys setup writes ──

const setupSrc = readFileSync("tooling/pilot-lab/families/setup.ts", "utf8");
function section(constName: string): string {
  const start = setupSrc.indexOf(`const ${constName}`);
  expect(start, `setup.ts declares ${constName}`).toBeGreaterThan(-1);
  const ends = ["\n};", "\n];"].map((t) => setupSrc.indexOf(t, start)).filter((i) => i > -1);
  return setupSrc.slice(start, Math.min(...ends));
}
function companyBlock(sec: string, company: string): string {
  const m = new RegExp(`\\n  ${company}: \\[([^\\]]*)\\]`).exec(sec);
  expect(m, `${company} block`).not.toBeNull();
  return m![1]!;
}
const keysIn = (block: string) => [...block.matchAll(/key: "([a-z0-9_]+)"/g)].map((m) => m[1]!);

describe("people fills the structure setup wrote, never a copy of it", () => {
  it("writes none of setup's structure tables", () => {
    for (const t of ["department", "position", "team", "work_location", "shift", "cost_centre"])
      expect(TABLE_ORDER as string[]).not.toContain(t);
  });

  for (const company of COMPANIES) {
    it(`${company.key}: every setup key people needs exists in setup.ts, and every active team and location is used`, () => {
      const refs = setupRefsFor(company);
      const coreDepts = section("CORE_DEPARTMENTS");
      const companyDepts = companyBlock(section("COMPANY_DEPARTMENTS"), company.key);
      for (const code of refs.departments)
        expect(
          coreDepts.includes(`code: "${code}"`) || companyDepts.includes(`code: "${code}"`),
          `department ${code}`,
        ).toBe(true);
      const corePos = section("CORE_POSITIONS");
      const companyPos = companyBlock(section("COMPANY_POSITIONS"), company.key);
      for (const p of refs.positions) {
        // Prettier may wrap a long spec, so the two fields need not share a line.
        const spec = new RegExp(`key: "${p.key}",\\s*dept: "${p.dept}"`);
        expect(spec.test(corePos) || spec.test(companyPos), `position ${p.key}`).toBe(true);
      }
      // Teams: people's active list is setup's list minus the disbanded legacy crew.
      const teamBlock = companyBlock(section("COMPANY_TEAMS"), company.key);
      expect(refs.teams).toEqual(keysIn(teamBlock));
      // Locations: all of setup's, office first.
      const locBlock = companyBlock(section("COMPANY_LOCATIONS"), company.key);
      expect([...refs.workLocations].sort()).toEqual(keysIn(locBlock).sort());
      // Shifts: each one people schedules is one setup gives this company.
      const shiftBlock = companyBlock(section("COMPANY_SHIFTS"), company.key);
      for (const s of refs.shifts) expect(shiftBlock, `shift ${s}`).toContain(`"${s}"`);
    });
  }
});

describe("the people family", () => {
  it("is registered under its key, depends on setup, and applies to every company", () => {
    expect(people.key).toBe("people");
    expect(people.deps).toEqual(["setup"]);
    for (const c of COMPANIES) expect(people.appliesTo(c)).toBe(true);
  });

  for (const company of COMPANIES) {
    describe(company.key, () => {
      it("plan() counts exactly the rows seed() inserts, per table, and the dry-run agrees", async () => {
        const { ctx, store } = await seedInMemory(company);
        const planned = people.plan(ctx).expected;
        const written = Object.fromEntries([...store].map(([t, r]) => [t, r.length]));
        expect(written).toEqual(planned);
        for (const t of Object.keys(planned)) expect(planned[t]).toBeGreaterThan(0);
        // A dry-run context (no writes) plans the same numbers.
        const dry = fakeCtx(company, new Map(), { dryRun: true });
        expect(people.plan(dry).expected).toEqual(planned);
      });

      it("every row carries the org id and the tables come in foreign-key order", async () => {
        const { ctx, store } = await seedInMemory(company);
        for (const [t, rs] of store)
          for (const r of rs) expect(r.org_id, `${t} org_id`).toBe(ctx.orgId);
        expect([...store.keys()]).toEqual(TABLE_ORDER.filter((t) => store.has(t)));
      });

      it("ids are deterministic: two runs produce identical rows", async () => {
        const a = await seedInMemory(company);
        const b = await seedInMemory(company);
        expect([...a.store.keys()]).toEqual([...b.store.keys()]);
        for (const t of a.store.keys()) expect(a.store.get(t)).toEqual(b.store.get(t));
        expect(a.handoff).toEqual(b.handoff);
        const ids = rows(a.store, "employee").map((r) => str(r, "id"));
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids)
          expect(id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
      });

      it("no row is born in a state only the HR service may reach", async () => {
        const { store, plan } = await seedInMemory(company);
        for (const e of rows(store, "employee")) {
          expect(BORN_LIFECYCLES).toContain(e.lifecycle);
          expect(e.active).toBe(e.lifecycle === "active");
          for (const k of ["end_date", "notice_date", "final_working_date"])
            expect(e, `employee.${k} is the service's`).not.toHaveProperty(k);
        }
        for (const c of rows(store, "employee_contract")) {
          expect(c.status).toBe("draft");
          for (const k of ["issued_at", "accepted_at", "accepted_channel"])
            expect(c, `contract.${k} is the service's`).not.toHaveProperty(k);
        }
        for (const ev of rows(store, "employee_event"))
          expect(SERVICE_ONLY_EVENTS, `event ${ev.event}`).not.toContain(ev.event);
        for (const c of rows(store, "employee_compensation")) expect(c.superseded_at).toBeNull();
        // The chains the service will be asked to make are legal from `active`.
        const legal: Record<string, string[]> = {
          active: ["suspended", "notice", "terminated"],
          suspended: ["active", "terminated"],
          notice: ["active", "terminated"],
          terminated: ["archived"],
        };
        const born = new Map(
          rows(store, "employee").map((e) => [str(e, "id"), str(e, "lifecycle")]),
        );
        for (const t of plan.transitions) {
          expect(born.get(t.employeeId)).toBe("active");
          let at: string = t.from;
          for (const s of t.steps) {
            expect(legal[at], `${at} → ${s.to}`).toContain(s.to);
            if (s.to === "terminated") expect(s.endDate).toBeTruthy();
            at = s.to;
          }
          expect(plan.finalLifecycle[t.employeeId]).toBe(at);
        }
        for (const [id, final] of Object.entries(plan.finalLifecycle))
          if (!plan.transitions.some((t) => t.employeeId === id)) expect(born.get(id)).toBe(final);
        // The service event budget is exactly one event per step, issue and acceptance.
        expect(plan.serviceEventCount).toBe(
          plan.transitions.reduce((a, t) => a + t.steps.length, 0) +
            plan.contractActions.reduce((a, c) => a + 1 + (c.accept ? 1 : 0), 0),
        );
        for (const c of plan.contractActions) expect(born.get(c.employeeId)).toBe("active");
      });

      it("the personas are employees linked to their logins; the handoff names them", async () => {
        const { ctx, store, handoff } = await seedInMemory(company);
        const emp = rows(store, "employee");
        expect(emp).toHaveLength(company.profile.employees);
        expect(handoff.employeeIds).toEqual(emp.map((e) => str(e, "id")));
        for (const persona of REQUIRED_PERSONA_EMPLOYEES) {
          const id = handoff.personaEmployees[persona];
          expect(id, persona).toBeTruthy();
          const row = emp.find((e) => e.id === id)!;
          expect(row.user_id).toBe(ctx.users[persona]);
          expect(row.lifecycle).toBe("active");
          expect(row.email).toBe(personaEmail(company.key, persona));
          expect(handoff.activeEmployeeIds).toContain(id);
        }
        expect(Object.keys(handoff.personaEmployees).sort()).toEqual([...PERSONA_EMPLOYEES].sort());
        expect(ctx.employees).toEqual(handoff.personaEmployees);
        const linked = emp.filter((e) => e.user_id !== null).map((e) => str(e, "user_id"));
        expect(new Set(linked).size).toBe(linked.length);
        expect(linked).not.toContain(ctx.users.auditor);
      });

      it("structure agrees with setup: positions in their departments, cost centres, crews, locations", async () => {
        const { ctx, store, handoff } = await seedInMemory(company);
        const setup = ctx.handoff<SetupHandoff>("setup");
        const deptCode = new Map(Object.entries(setup.departments).map(([c, id]) => [id, c]));
        const emp = rows(store, "employee");
        const empIds = new Set(emp.map((e) => str(e, "id")));
        for (const e of emp) {
          const code = deptCode.get(str(e, "department_id"));
          expect(code, "department from setup").toBeTruthy();
          const pos = Object.values(setup.positions).find((p) => p.id === e.position_id);
          expect(pos, "position from setup").toBeTruthy();
          expect(pos!.department).toBe(code);
          expect(e.cost_centre).toBe(`CC-${code}`);
          expect(Object.values(setup.workLocations)).toContain(e.work_location_id);
          if (e.team_id !== null) expect(Object.values(setup.teams)).toContain(e.team_id);
          if (e.manager_employee_id !== null) {
            expect(empIds.has(str(e, "manager_employee_id"))).toBe(true);
            expect(e.manager_employee_id).not.toBe(e.id);
          }
          expect(handoff.byDepartment[code!]).toContain(e.id);
        }
        expect(emp.filter((e) => e.manager_employee_id === null)).toHaveLength(1);
        expect(emp.find((e) => e.manager_employee_id === null)!.id).toBe(
          handoff.personaEmployees.owner,
        );
        // Every active setup team has members; restricted and field sit on different crews.
        for (const [key, id] of Object.entries(setup.teams))
          expect(
            emp.some((e) => e.team_id === id),
            `team ${key} has members`,
          ).toBe(true);
        expect(handoff.teamIds).toEqual(Object.values(setup.teams));
        const crew = (p: PersonaKey) =>
          emp.find((e) => e.id === handoff.personaEmployees[p])!.team_id;
        expect(crew("restricted")).toBeTruthy();
        expect(crew("field")).toBeTruthy();
        expect(crew("restricted")).not.toBe(crew("field"));
        // Heads: one per staffed department, and the managers list is heads + the ops manager.
        for (const [code, headId] of Object.entries(handoff.headOfDepartment)) {
          const head = emp.find((e) => e.id === headId)!;
          expect(deptCode.get(str(head, "department_id"))).toBe(code);
          expect(handoff.managers).toContain(headId);
        }
        expect(handoff.managers).toContain(handoff.personaEmployees.manager);
        const nos = emp.map((e) => str(e, "employee_no"));
        expect(new Set(nos).size).toBe(nos.length);
      });

      it("pay reconciles: terms equal the current compensation row, hourly = salary / 208", async () => {
        const { ctx, store } = await seedInMemory(company);
        const comp = rows(store, "employee_compensation");
        const terms = rows(store, "employee_terms");
        const asOf = ctx.clock.asOf;
        const byEmp = new Map<string, Row[]>();
        for (const c of comp) {
          expect(c.hourly_cost_minor).toBe(hourlyOf(c.salary_minor as number));
          expect(c.salary_minor as number).toBeGreaterThan(0);
          (
            byEmp.get(str(c, "employee_id")) ??
            byEmp.set(str(c, "employee_id"), []).get(str(c, "employee_id"))!
          ).push(c);
        }
        for (const e of rows(store, "employee")) {
          const history = byEmp.get(str(e, "id")) ?? [];
          expect(history.length, "at least the hire row").toBeGreaterThan(0);
          expect(history[0]!.reason).toBe("hire");
          expect(history[0]!.effective_date).toBe(e.hire_date);
          const dates = history.map((h) => str(h, "effective_date"));
          expect(new Set(dates).size, "one live row per effective date").toBe(dates.length);
          const current = history
            .filter((h) => str(h, "effective_date") <= asOf)
            .sort((a, b) => str(b, "effective_date").localeCompare(str(a, "effective_date")))[0];
          const t = terms.find((x) => x.employee_id === e.id);
          if (!current) {
            expect(t, "a future hire has no terms yet").toBeUndefined();
            expect(e.lifecycle).toBe("draft");
            expect(str(e, "hire_date") > asOf).toBe(true);
          } else {
            expect(t, "terms row").toBeTruthy();
            expect(t!.salary_minor).toBe(current.salary_minor);
            expect(t!.hourly_cost_minor).toBe(current.hourly_cost_minor);
            expect(t!.ot_rate).toBe(current.ot_rate);
          }
        }
        expect(terms).toHaveLength(
          rows(store, "employee").filter((e) => str(e, "hire_date") <= asOf).length,
        );
      });

      it("side tables cross-link: one instruction each, contracts per employee, skills and components resolve", async () => {
        const { ctx, store, handoff } = await seedInMemory(company);
        const emp = rows(store, "employee");
        const empIds = new Set(emp.map((e) => str(e, "id")));
        const has = (table: string) => new Set(rows(store, table).map((r) => str(r, "id")));
        const skills = has("skill");
        const components = has("pay_component_def");
        const patterns = has("work_pattern");
        const setup = ctx.handoff<SetupHandoff>("setup");
        const shifts = new Set(Object.values(setup.shifts));

        const instr = rows(store, "employee_payment_instruction");
        expect(instr.map((i) => i.employee_id).sort()).toEqual([...empIds].sort());
        for (const i of instr) {
          expect(i.active).toBe(true);
          if (i.method === "cash") expect(i.iban).toBeNull();
          else expect(str(i, "iban")).toMatch(new RegExp(`^${company.country}00 0000 `));
          if (i.method === "wps") expect(str(i, "wps_person_id").length).toBeLessThanOrEqual(14);
        }
        const contracts = rows(store, "employee_contract");
        expect(contracts.map((c) => c.employee_id).sort()).toEqual([...empIds].sort());
        const nos = contracts.map((c) => str(c, "contract_no"));
        expect(new Set(nos).size).toBe(nos.length);
        for (const c of contracts) {
          const e = emp.find((x) => x.id === c.employee_id)!;
          expect(c.start_date).toBe(e.hire_date);
          if (c.end_date !== null) expect(str(c, "end_date") >= str(c, "start_date")).toBe(true);
          expect(c.probation_months as number).toBeGreaterThanOrEqual(0);
          expect(c.probation_months as number).toBeLessThanOrEqual(6);
        }
        for (const s of rows(store, "employee_skill")) {
          expect(empIds.has(str(s, "employee_id"))).toBe(true);
          expect(skills.has(str(s, "skill_id"))).toBe(true);
          expect(Number.isInteger(s.level)).toBe(true);
          expect(s.level as number).toBeGreaterThanOrEqual(1);
          expect(s.level as number).toBeLessThanOrEqual(5);
        }
        const live = rows(store, "employee_skill").map((s) => `${s.employee_id}:${s.skill_id}`);
        expect(new Set(live).size, "one live row per employee and skill").toBe(live.length);
        expect(handoff.skillIds).toEqual([...skills]);
        for (const p of rows(store, "employee_pay_component")) {
          expect(empIds.has(str(p, "employee_id"))).toBe(true);
          expect(components.has(str(p, "component_id"))).toBe(true);
          expect(p.effective_to).toBeNull();
        }
        expect(Object.values(handoff.payComponents).sort()).toEqual([...components].sort());
        for (const h of rows(store, "employee_hr")) {
          expect(empIds.has(str(h, "employee_id"))).toBe(true);
          expect(str(h, "id_number").startsWith(fakeIdPrefix(company))).toBe(true);
          expect(str(h, "passport_number")).toMatch(/^P00\d{6}$/);
        }
        for (const ev of rows(store, "employee_event")) {
          expect(empIds.has(str(ev, "employee_id"))).toBe(true);
          expect(ev.detail).not.toHaveProperty("salary_minor");
        }
        expect(rows(store, "employee_event").filter((e) => e.event === "created")).toHaveLength(
          emp.length,
        );
        for (const s of rows(store, "schedule_assignment")) {
          const targets = [s.employee_id, s.team_id, s.work_location_id].filter((x) => x !== null);
          expect(targets, "exactly one target").toHaveLength(1);
          expect(s.pattern_id !== null || s.shift_id !== null).toBe(true);
          if (s.pattern_id !== null) expect(patterns.has(str(s, "pattern_id"))).toBe(true);
          if (s.shift_id !== null) expect(shifts.has(str(s, "shift_id"))).toBe(true);
          if (s.employee_id !== null) expect(empIds.has(str(s, "employee_id"))).toBe(true);
        }
        const scheduled = rows(store, "schedule_assignment");
        for (const id of Object.values(setup.teams))
          expect(
            scheduled.some((s) => s.team_id === id),
            "team scheduled",
          ).toBe(true);
        for (const id of Object.values(setup.workLocations))
          expect(
            scheduled.some((s) => s.work_location_id === id),
            "location scheduled",
          ).toBe(true);
        expect(rows(store, "work_pattern").filter((p) => p.is_default)).toHaveLength(1);
        expect(handoff.workPatternIds).toEqual({
          standard: rows(store, "work_pattern")[0]!.id,
          rota: rows(store, "work_pattern")[1]!.id,
          partTime: rows(store, "work_pattern")[2]!.id,
        });
        for (const d of rows(store, "manager_delegation")) {
          expect(empIds.has(str(d, "from_employee_id"))).toBe(true);
          expect(empIds.has(str(d, "to_employee_id"))).toBe(true);
          expect(d.from_employee_id).not.toBe(d.to_employee_id);
          expect(str(d, "ends_on") >= str(d, "starts_on")).toBe(true);
          expect(d.ended_early_at).toBeNull();
          expect(handoff.managers).toContain(d.from_employee_id);
        }
        expect(rows(store, "manager_delegation").length).toBeGreaterThan(0);
      });

      it("identities are fake and the history is coherent", async () => {
        const { ctx, store } = await seedInMemory(company);
        const asOf = ctx.clock.asOf;
        const from = company.history.from;
        for (const e of rows(store, "employee")) {
          expect(str(e, "email")).toMatch(/@[a-z.-]+\.invalid$/);
          expect(str(e, "phone")).toMatch(/^\+9(71|66) 50 000 \d{4}$/);
          expect(str(e, "nationality")).toMatch(/^[A-Z]{2}$/);
          expect(["citizen", "resident", "work_permit", "visitor", "other"]).toContain(
            e.residency_status,
          );
          expect(str(e, "name_ar")).toMatch(/[؀-ۿ]/);
          expect(str(e, "created_at") >= `${from}T00:00:00`).toBe(true);
          expect(str(e, "created_at") <= `${asOf}T23:59:59`).toBe(true);
          if (e.lifecycle === "active") expect(str(e, "hire_date") <= asOf).toBe(true);
          if (e.confirmation_date !== null)
            expect(str(e, "confirmation_date")).toBe(e.probation_end_date);
        }
        const hires = rows(store, "employee").map((e) => str(e, "hire_date"));
        expect(
          hires.some((h) => h < from),
          "some staff predate the software",
        ).toBe(true);
        expect(
          hires.some((h) => h >= from && h <= asOf),
          "some were hired during history",
        ).toBe(true);
      });
    });
  }

  it("across the five companies the lifecycle mix reaches every state the guard allows", async () => {
    const finals = new Set<string>();
    for (const c of COMPANIES) {
      const { plan } = await seedInMemory(c);
      for (const l of Object.values(plan.finalLifecycle)) finals.add(l);
    }
    expect([...finals].sort()).toEqual(
      ["active", "archived", "draft", "notice", "suspended", "terminated"].sort(),
    );
  });
});
