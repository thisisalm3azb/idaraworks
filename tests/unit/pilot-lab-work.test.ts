/**
 * H33 — the "work" family, pinned without a database.
 *
 * The family's plan is pure and its seed is a function of (company, rng, clock,
 * handoffs), so the whole thing runs here against an in-memory insert: the
 * plan must equal what seed writes, table by table; every row carries the
 * organisation; a second run writes byte-identical rows; no row is in a state
 * the product's own services could not have produced; and the cross-links,
 * reconciliations and pagination thresholds the family claims all hold.
 *
 * The service-driven subset and the labour-cost freeze are switched off
 * (`workFamily({ driveServices: false })`) — they need the real domain services
 * and a database, and they are exercised by the lab's verify mode instead.
 */
import { describe, expect, it, vi } from "vitest";

/*
 * These build a whole company in memory — tens of thousands of rows for the
 * larger profiles — so the 5-second default is a stopwatch on the machine, not
 * on the code. Under full-suite parallel load it fired on the biggest company
 * and looked like a logic failure.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { TEMPLATES } from "@/platform/config/templates";
import { COMPANIES } from "../../tooling/pilot-lab/companies";
import type { Sql } from "../../tooling/pilot-lab/db";
import { id as labId } from "../../tooling/pilot-lab/ids";
import { SEED_VERSION } from "../../tooling/pilot-lab/marker";
import type { Company, LabContext, PersonaKey } from "../../tooling/pilot-lab/types";
import {
  APPROVAL_STATES,
  EXCLUSIVE_TABLES,
  HANDOFF_ACTIVE_JOBS,
  HANDOFF_MAJOR_JOBS,
  ISSUE_STATUSES,
  JOB_CATEGORIES,
  PAGINATION_THRESHOLD,
  REPORT_STATUSES,
  STAGE_STATUSES,
  TASK_STATUSES,
  WEEK_PLAN_STATUSES,
  WORK_TABLES,
  buildModel,
  currentStageOf,
  currentStagePairs,
  templateOf,
  weekReference,
  weekStartOf,
  work,
  workFamily,
  type WorkHandoff,
  type WorkTable,
} from "../../tooling/pilot-lab/families/work";
import { Rng } from "../../tooling/simulation/rng";
import { SimClock } from "../../tooling/simulation/dates";

type Row = Record<string, unknown>;
type Inserted = Partial<Record<WorkTable, Row[]>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARABIC = /[؀-ۿ]/;
const PERSONA_EMPLOYEES: PersonaKey[] = [
  "owner",
  "admin",
  "manager",
  "finance",
  "hr",
  "warehouse",
  "field",
  "restricted",
];
const UNITS = ["pcs", "m", "kg", "ltr", "box", "roll"];

type Fake = {
  ctx: LabContext;
  orgId: string;
  inserted: Inserted;
  statements: Array<{ text: string; params: unknown[] }>;
  begins: number;
  presetIds: Record<string, string>;
  customerIds: Set<string>;
  activeEmployeeIds: Set<string>;
  activeItemIds: Set<string>;
  personaEmployees: Partial<Record<PersonaKey, string>>;
  users: Record<PersonaKey, string>;
};

/** A LabContext with realistic handoffs from setup / people / masters and no database. */
function fakeCtx(company: Company, dryRun = false): Fake {
  const k = company.key;
  const orgId = labId(k, "org");
  const users = Object.fromEntries(
    company.personas.map((p) => [p.key, labId(k, "user", p.key)]),
  ) as Record<PersonaKey, string>;
  const tpl = TEMPLATES[company.templateKey]!;
  const presetIds = Object.fromEntries(
    tpl.presets.map((p) => [p.code, labId(k, "job_preset", p.code)]),
  );
  const employeeIds = Array.from({ length: company.profile.employees }, (_, i) =>
    labId(k, "employee", i),
  );
  const personaEmployees = Object.fromEntries(
    PERSONA_EMPLOYEES.map((p, i) => [p, employeeIds[i]!]),
  ) as Partial<Record<PersonaKey, string>>;
  // A few later hires have left; the personas are all still employed.
  const activeEmployeeIds = employeeIds.filter((_, i) => i < 8 || i % 9 !== 0);
  const customerIds = Array.from({ length: company.profile.customers }, (_, i) =>
    labId(k, "customer", i),
  );
  const itemIds = Array.from({ length: company.profile.items }, (_, i) => labId(k, "item", i));
  const inactiveItemIds = itemIds.filter((_, i) => i % 10 === 7);
  const items = Object.fromEntries(
    itemIds.map((id, i) => [
      id,
      {
        unit: UNITS[i % UNITS.length]!,
        unitId: labId(k, "unit", UNITS[i % UNITS.length]!),
        cost: 100 + (i % 97) * 50,
        price: 200 + (i % 97) * 75,
        category: "materials",
        type: "goods",
        tracking: "none",
      },
    ]),
  );
  const handoffs: Record<string, Record<string, unknown>> = {
    setup: { presetIds, departments: {}, warehouses: {}, units: {} },
    people: {
      personaEmployees,
      employeeIds,
      activeEmployeeIds,
      managers: [personaEmployees.manager],
    },
    masters: { customerIds, itemIds, items, inactiveItemIds, supplierIds: [] },
  };
  const employees: LabContext["employees"] = { ...personaEmployees };

  const inserted: Inserted = {};
  const statements: Fake["statements"] = [];
  const fake: Fake = {
    ctx: null as unknown as LabContext,
    orgId,
    inserted,
    statements,
    begins: 0,
    presetIds,
    customerIds: new Set(customerIds),
    activeEmployeeIds: new Set(activeEmployeeIds),
    activeItemIds: new Set(itemIds.filter((id) => !inactiveItemIds.includes(id))),
    personaEmployees,
    users,
  };
  const sql = (() => {
    throw new Error("a tagged query reached the fake database");
  }) as unknown as Sql;
  Object.assign(sql, {
    unsafe: async (text: string, params: unknown[] = []) => {
      statements.push({ text, params });
      if (/from public\.item\b/.test(text)) {
        const ids = params[1] as string[];
        return ids.map((id, i) => ({ id, name: `Catalogue item ${i + 1} — صنف ${i + 1}` }));
      }
      return [];
    },
    begin: async () => {
      fake.begins++;
      throw new Error("a transaction reached the fake database");
    },
  });
  fake.ctx = {
    sql,
    admin: {} as LabContext["admin"],
    company,
    orgId,
    users,
    employees,
    ctxFor: (persona) => ({
      orgId,
      userId: users[persona],
      costPrivileged: true,
      pricePrivileged: true,
      requestId: `test-${k}-${persona}`,
    }),
    archetypeOf: (persona) => company.personas.find((p) => p.key === persona)!.archetype,
    rng: new Rng(`h33:${SEED_VERSION}:${k}`),
    clock: new SimClock(company.history.asOf),
    id: (family, ...ordinal) => labId(k, family, ...ordinal),
    insert: async (table, rows) => {
      for (const r of rows) {
        if (r.org_id !== orgId) throw new Error(`${table}: a row without the organisation`);
      }
      const list = (inserted[table as WorkTable] ??= []);
      list.push(...rows);
      return { attempted: rows.length, inserted: rows.length };
    },
    handoff: <T>(family: string): T => {
      const h = handoffs[family];
      if (!h) throw new Error(`no handoff from ${family}`);
      return h as T;
    },
    log: () => {},
    dryRun,
  };
  return fake;
}

const family = workFamily({ driveServices: false });

type Run = Fake & {
  plan: Record<string, number>;
  report: Awaited<ReturnType<typeof family.seed>>;
  handoff: WorkHandoff;
  rows: Record<WorkTable, Row[]>;
};

const RUNS = new Map<string, Promise<Run>>();
function runFor(company: Company): Promise<Run> {
  let p = RUNS.get(company.key);
  if (!p) {
    p = (async () => {
      const fake = fakeCtx(company);
      const plan = family.plan(fake.ctx).expected;
      const report = await family.seed(fake.ctx);
      const rows = Object.fromEntries(
        WORK_TABLES.map((t) => [t, fake.inserted[t] ?? []]),
      ) as Record<WorkTable, Row[]>;
      return { ...fake, plan, report, handoff: report.handoff as WorkHandoff, rows };
    })();
    RUNS.set(company.key, p);
  }
  return p;
}

const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id as string, r]));
const groupBy = <K>(rows: Row[], key: (r: Row) => K) => {
  const out = new Map<K, Row[]>();
  for (const r of rows) {
    const k = key(r);
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return out;
};
const distinct = (rows: Row[], key: (r: Row) => string) => new Set(rows.map(key)).size;

describe("the work family", () => {
  it("is registered under its file name, depends on setup/people/masters and applies to every company", () => {
    expect(work.key).toBe("work");
    expect(work.deps).toEqual(["setup", "people", "masters"]);
    expect(family.key).toBe("work");
    for (const c of COMPANIES) expect(work.appliesTo(c), c.key).toBe(true);
  });

  it("the default family and the service-less one plan the same rows", () => {
    for (const c of COMPANIES) {
      const a = work.plan(fakeCtx(c).ctx).expected;
      const b = family.plan(fakeCtx(c).ctx).expected;
      expect(a, c.key).toEqual(b);
    }
  });

  it("a dry run touches no database at all", async () => {
    const c = COMPANIES[0]!;
    const fake = fakeCtx(c, true);
    const report = await family.seed(fake.ctx);
    expect(fake.statements).toHaveLength(0);
    expect(fake.begins).toBe(0);
    expect(report.notes?.join(" ")).toMatch(/dry run/);
    expect(Object.values(report.counts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("week helpers follow the product's Monday-week and ISO-week reference", () => {
    expect(weekStartOf("2026-09-05")).toBe("2026-08-31"); // a Saturday → its Monday
    expect(weekStartOf("2026-08-31")).toBe("2026-08-31");
    expect(weekReference("2026-08-31", 0)).toBe("WP-2026-W36");
    expect(weekReference("2026-08-31", 2)).toBe("WP-2026-W36-R2");
    expect(weekReference("2024-12-30", 0)).toBe("WP-2025-W01");
  });
});

for (const company of COMPANIES) {
  describe(`work for ${company.key}`, () => {
    it("plan() counts equal the rows seed() inserts, table by table, and nothing else is written", async () => {
      const r = await runFor(company);
      expect(Object.keys(r.plan).sort()).toEqual([...WORK_TABLES].sort());
      expect(Object.keys(r.inserted).sort()).toEqual([...WORK_TABLES].sort());
      for (const t of WORK_TABLES) {
        expect(r.rows[t].length, t).toBe(r.plan[t]);
        expect(r.report.counts[t], t).toBe(r.plan[t]);
      }
      const total = Object.values(r.plan).reduce((a, b) => a + b, 0);
      // Substantial, but scaled: the lab as a whole plans ~200,000 rows
      // against a 300 MB ceiling, and this family is the largest share of it.
      expect(total).toBeGreaterThan(3_000);
      expect(r.report.notes?.join(" ")).toMatch(/switched off/);
    });

    it("every row carries the organisation and a deterministic v5 id", async () => {
      const r = await runFor(company);
      for (const t of WORK_TABLES) {
        for (const row of r.rows[t]) {
          expect(row.org_id).toBe(r.orgId);
          if (t !== "job_crew" && t !== "reference_sequence") expect(row.id).toMatch(UUID);
        }
        // Primary keys never repeat inside a table.
        if (t === "job_crew")
          expect(distinct(r.rows[t], (x) => `${x.job_id}:${x.employee_id}`)).toBe(r.rows[t].length);
        else if (t === "reference_sequence")
          expect(distinct(r.rows[t], (x) => String(x.scope_key))).toBe(r.rows[t].length);
        else expect(distinct(r.rows[t], (x) => String(x.id))).toBe(r.rows[t].length);
      }
      // Ids are also unique across tables (one namespace per family/ordinal).
      const all = WORK_TABLES.flatMap((t) => r.rows[t].map((x) => x.id).filter(Boolean));
      expect(new Set(all).size).toBe(all.length);
    });

    it("two runs write identical rows and identical plans", async () => {
      const r = await runFor(company);
      const again = fakeCtx(company);
      const plan2 = family.plan(again.ctx).expected;
      const report2 = await family.seed(again.ctx);
      expect(plan2).toEqual(r.plan);
      for (const t of WORK_TABLES)
        expect(JSON.stringify(again.inserted[t] ?? []), t).toBe(JSON.stringify(r.rows[t]));
      expect(JSON.stringify(report2.handoff)).toBe(JSON.stringify(r.report.handoff));
      expect(again.statements).toEqual(r.statements);
    });

    it("the only database statements are the current-stage close and one bounded item-name read", async () => {
      const r = await runFor(company);
      const model = buildModel(r.ctx);
      const pairs = currentStagePairs(model);
      const updates = r.statements.filter((s) =>
        /update public\.job j set current_stage_id/.test(s.text),
      );
      const reads = r.statements.filter((s) => /from public\.item\b/.test(s.text));
      expect(updates).toHaveLength(Math.ceil(pairs.length / 2000));
      expect(updates.reduce((n, s) => n + (s.params[0] as string[]).length, 0)).toBe(pairs.length);
      expect(reads).toHaveLength(1);
      expect((reads[0]!.params[1] as string[]).length).toBe(r.activeItemIds.size);
      expect(r.statements).toHaveLength(updates.length + reads.length);
      expect(r.begins).toBe(0);
    });

    it("jobs: legal categories, template status keys, reasons where the product demands them, a real status mix", async () => {
      const r = await runFor(company);
      const tpl = templateOf(company);
      const catOf = new Map<string, string>();
      for (const s of TEMPLATES[company.templateKey]!.status_sets.job.statuses)
        catOf.set(s.status_key, s.semantic_category);
      const jobs = r.rows.job;
      expect(jobs.length).toBe(company.profile.jobs);
      const seen = new Set<string>();
      for (const j of jobs) {
        const cat = j.status_category as string;
        expect(JOB_CATEGORIES).toContain(cat);
        expect(catOf.get(j.status_key as string), `status key ${j.status_key}`).toBe(cat);
        seen.add(cat);
        if (cat === "on_hold") expect(j.on_hold_reason).toBeTruthy();
        else expect(j.on_hold_reason).toBeNull();
        if (cat === "cancelled") expect(j.cancellation_reason).toBeTruthy();
        else expect(j.cancellation_reason).toBeNull();
        if (cat === "done") expect(j.completed_date).toBeTruthy();
        else expect(j.completed_date).toBeNull();
        if (j.archived) {
          expect(["done", "cancelled"]).toContain(cat);
          expect(j.archived_at).toBeTruthy();
          expect(j.archived_by).toBeTruthy();
        } else expect(j.archived_at).toBeNull();
        expect((j.name as string).length).toBeGreaterThan(0);
        expect((j.name as string).length).toBeLessThanOrEqual(160);
        expect(["low", "normal", "high", "urgent"]).toContain(j.priority);
        expect(["direct", "quotation", "opportunity"]).toContain(j.origin);
        expect(j.kind).toBe("project");
        expect(Object.values(r.presetIds)).toContain(j.preset_id);
        if (j.customer_id !== null) expect(r.customerIds.has(j.customer_id as string)).toBe(true);
        expect(Object.values(r.users)).toContain(j.manager_user_id);
        expect([r.users.field, r.users.restricted]).toContain(j.foreman_user_id);
        expect((j.start_date as string) <= (j.due_date as string)).toBe(true);
        expect((j.created_at as string) <= (j.updated_at as string)).toBe(true);
        expect(j.current_stage_id).toBeNull(); // closed after the stage rows exist
        expect(Array.isArray(j.billing_points)).toBe(true);
        if (j.selling_price_minor !== null)
          expect(j.selling_price_minor as number).toBeGreaterThan(0);
      }
      expect([...seen].sort()).toEqual([...JOB_CATEGORIES].sort());
      // References are unique, follow the template's pattern, and the sequences sit past them.
      expect(distinct(jobs, (j) => String(j.reference))).toBe(jobs.length);
      const refRe = tpl.pattern.pattern.includes("{preset_code}")
        ? /^[A-Z0-9]{1,8}-\d{4}-\d{3,}$/
        : /^WO-\d{4}-\d{4,}$/;
      for (const j of jobs) expect(j.reference).toMatch(refRe);
      const model = buildModel(r.ctx);
      const maxSeq = new Map<string, number>();
      for (const j of model.jobs) maxSeq.set(j.scope, Math.max(maxSeq.get(j.scope) ?? 0, j.seq));
      const seqRows = new Map(r.rows.reference_sequence.map((s) => [s.scope_key, s.next_value]));
      expect(seqRows.size).toBe(maxSeq.size);
      for (const [scope, max] of maxSeq) expect(seqRows.get(scope), scope).toBe(max + 1);
      // Names are bilingual across the company.
      expect(jobs.some((j) => ARABIC.test(j.name as string))).toBe(true);
      expect(jobs.some((j) => !ARABIC.test(j.name as string))).toBe(true);
      // Nothing pretends to be a real business.
      for (const j of jobs) expect((j.name as string).toLowerCase()).not.toContain("najolatech");
    });

    it("stages: one snapshot per template stage, weights sum to 100, preset skips honoured, current stage derived", async () => {
      const r = await runFor(company);
      const tpl = TEMPLATES[company.templateKey]!;
      const model = buildModel(r.ctx);
      const presetByCode = new Map(tpl.presets.map((p) => [p.code, p]));
      const stagesByJob = groupBy(r.rows.job_stage, (s) => s.job_id as string);
      const pairs = new Map(currentStagePairs(model));
      expect(r.rows.job_stage.length).toBe(r.rows.job.length * tpl.stage_template.stages.length);
      for (const m of model.jobs) {
        const stages = stagesByJob.get(m.id)!;
        expect(stages).toHaveLength(tpl.stage_template.stages.length);
        expect(stages.reduce((a, s) => a + (s.weight as number), 0)).toBe(100);
        expect(distinct(stages, (s) => String(s.stage_key))).toBe(stages.length);
        const skipped = new Set(presetByCode.get(m.presetCode)!.default_skipped_stage_keys);
        for (const s of stages) {
          expect(STAGE_STATUSES).toContain(s.status);
          if (skipped.has(s.stage_key as string)) expect(s.status).toBe("skipped");
          else expect(s.status).not.toBe("skipped");
          if (s.status === "completed") {
            expect(s.started_at).toBeTruthy();
            expect(s.completed_at).toBeTruthy();
            expect((s.started_at as string) <= (s.completed_at as string)).toBe(true);
          }
          if (s.status === "in_progress") {
            expect(s.started_at).toBeTruthy();
            expect(s.completed_at).toBeNull();
          }
          if (s.status === "not_started") expect(s.started_at).toBeNull();
          if (s.completion_requested_by) expect(s.status).toBe("in_progress");
          expect(s.name).toEqual(
            tpl.stage_template.stages.find((t) => t.stage_key === s.stage_key)!.names,
          );
        }
        const live = stages.filter((s) => s.status === "in_progress" || s.status === "not_started");
        const expected = currentStageOf(
          stages.map((s) => ({
            id: s.id as string,
            status: s.status as string,
            sort: s.sort as number,
          })),
        );
        if (live.length) expect(pairs.get(m.id)).toBe(expected!.id);
        else expect(pairs.has(m.id)).toBe(false);
        // Draft work has not started; done work has finished every live stage.
        if (m.category === "draft") for (const s of live) expect(s.status).toBe("not_started");
        if (m.category === "done") expect(live).toHaveLength(0);
        // At most one stage is in progress at a time.
        expect(stages.filter((s) => s.status === "in_progress").length).toBeLessThanOrEqual(1);
      }
    });

    it("crew: distinct active employees per job, the foreman persona's employee first", async () => {
      const r = await runFor(company);
      const model = buildModel(r.ctx);
      const crewByJob = groupBy(r.rows.job_crew, (c) => c.job_id as string);
      for (const m of model.jobs) {
        const crew = crewByJob.get(m.id) ?? [];
        expect(crew).toHaveLength(m.crew.length);
        if (!crew.length) continue;
        expect(distinct(crew, (c) => String(c.employee_id))).toBe(crew.length);
        for (const c of crew) {
          expect(r.activeEmployeeIds.has(c.employee_id as string)).toBe(true);
          if (c.removed_at) expect(c.removed_by).toBeTruthy();
          else expect(c.removed_by).toBeNull();
        }
        expect(crew[0]!.employee_id).toBe(r.personaEmployees[m.foremanPersona]);
      }
      expect(r.rows.job_crew.length).toBeGreaterThan(company.profile.projects * 2);
    });

    it("tasks: legal statuses with explanations, dependencies inside the job, readiness follows the edges, allocations on open steps", async () => {
      const r = await runFor(company);
      const jobs = byId(r.rows.job);
      const stages = byId(r.rows.job_stage);
      const tasks = byId(r.rows.task);
      const jobCat = (jobId: string) => jobs.get(jobId)!.status_category as string;
      const seen = new Set<string>();
      for (const t of r.rows.task) {
        expect(TASK_STATUSES).toContain(t.status);
        seen.add(t.status as string);
        expect(jobs.has(t.job_id as string)).toBe(true);
        if (t.stage_id) expect(stages.get(t.stage_id as string)!.job_id).toBe(t.job_id);
        if (t.assignee_employee_id)
          expect(r.activeEmployeeIds.has(t.assignee_employee_id as string)).toBe(true);
        if (t.status === "blocked") expect(t.blocked_reason).toBeTruthy();
        else expect(t.blocked_reason).toBeNull();
        if (t.status === "completed") expect(t.completed_at).toBeTruthy();
        else {
          expect(t.completed_at).toBeNull();
          expect(t.actual_minutes).toBeNull();
        }
        expect(["low", "normal", "high", "urgent"]).toContain(t.priority);
        expect(t.constraint_kind).toBe("none");
        expect(t.constraint_date).toBeNull();
        expect(t.parent_task_id).toBeNull();
        expect((t.title as string).length).toBeLessThanOrEqual(200);
        if (jobCat(t.job_id as string) === "draft") expect(t.status).toBe("pending");
        if (jobCat(t.job_id as string) === "done")
          expect(["completed", "cancelled"]).toContain(t.status);
      }
      expect(seen.size).toBeGreaterThanOrEqual(5);
      expect(seen.has("awaiting_approval")).toBe(true);
      for (const d of r.rows.task_dependency) {
        const down = tasks.get(d.task_id as string)!;
        const up = tasks.get(d.depends_on_task_id as string)!;
        expect(down).toBeTruthy();
        expect(up).toBeTruthy();
        expect(down.job_id).toBe(up.job_id);
        expect(d.task_id).not.toBe(d.depends_on_task_id);
        expect(d.kind).toBe("finish_to_start");
        expect(d.lag_days as number).toBeGreaterThanOrEqual(0);
        const upDone = up.status === "completed" || up.status === "cancelled";
        if (
          ["ready", "in_progress", "completed", "awaiting_approval"].includes(down.status as string)
        )
          expect(
            upDone,
            `task ${down.id} is ${down.status} behind an unfinished prerequisite`,
          ).toBe(true);
      }
      expect(distinct(r.rows.task_dependency, (d) => `${d.task_id}:${d.depends_on_task_id}`)).toBe(
        r.rows.task_dependency.length,
      );
      for (const a of r.rows.task_allocation) {
        const t = tasks.get(a.task_id as string)!;
        expect(t).toBeTruthy();
        expect(["completed", "cancelled"]).not.toContain(t.status);
        expect(a.share_pct as number).toBeGreaterThanOrEqual(1);
        expect(a.share_pct as number).toBeLessThanOrEqual(100);
        expect(r.activeEmployeeIds.has(a.employee_id as string)).toBe(true);
        expect(a.removed_at).toBeNull();
      }
      expect(distinct(r.rows.task_allocation, (a) => `${a.task_id}:${a.employee_id}`)).toBe(
        r.rows.task_allocation.length,
      );
      expect(r.rows.task_dependency.length).toBeGreaterThan(0);
      expect(r.rows.task_allocation.length).toBeGreaterThan(0);
    });

    it("approvals: one task-completion rule, every approval mirrors its task, decided states name a decider, rejections a note", async () => {
      const r = await runFor(company);
      const rules = r.rows.approval_rule;
      expect(rules).toHaveLength(1);
      expect(rules[0]!.subject_type).toBe("task_completion");
      expect(rules[0]!.condition_kind).toBe("always");
      expect(rules[0]!.active).toBe(true);
      const tasks = byId(r.rows.task);
      const pendingBySubject = new Map<string, number>();
      for (const a of r.rows.approval) {
        expect(APPROVAL_STATES).toContain(a.state);
        expect(a.subject_type).toBe("task_completion");
        expect(a.rule_id).toBe(rules[0]!.id);
        const t = tasks.get(a.subject_id as string)!;
        expect(t).toBeTruthy();
        expect(t.requires_approval).toBe(true);
        expect(a.requested_by).not.toBe(a.decided_by);
        if (a.state === "pending" || a.state === "withdrawn") {
          expect(a.decided_by).toBeNull();
          expect(a.decided_at).toBeNull();
        } else {
          expect(a.decided_by).toBeTruthy();
        }
        if (a.state === "rejected") expect(a.decision_note).toBeTruthy();
        if (a.state === "approved") expect(t.status).toBe("completed");
        if (a.state === "pending") {
          expect(t.status).toBe("awaiting_approval");
          pendingBySubject.set(
            a.subject_id as string,
            (pendingBySubject.get(a.subject_id as string) ?? 0) + 1,
          );
        }
        if (a.state === "superseded") expect(t.status).toBe("cancelled");
        expect((a.subject_summary as { title: string }).title).toBe(t.title);
      }
      for (const t of r.rows.task)
        if (t.status === "awaiting_approval") expect(pendingBySubject.get(t.id as string)).toBe(1);
      expect(distinct(r.rows.approval, (a) => String(a.subject_id))).toBe(r.rows.approval.length);
      const states = new Set(r.rows.approval.map((a) => a.state as string));
      expect(states.has("pending")).toBe(true);
      expect(states.has("approved")).toBe(true);
    });

    it("daily reports: one per job-day, reviewer/return fields agree with status, lines reconcile with the catalogue and the cost wall", async () => {
      const r = await runFor(company);
      const jobs = byId(r.rows.job);
      const stages = byId(r.rows.job_stage);
      const reports = byId(r.rows.daily_report);
      expect(distinct(r.rows.daily_report, (x) => `${x.job_id}:${x.report_date}`)).toBe(
        r.rows.daily_report.length,
      );
      expect(distinct(r.rows.daily_report, (x) => String(x.idempotency_key))).toBe(
        r.rows.daily_report.length,
      );
      const statuses = new Set<string>();
      for (const d of r.rows.daily_report) {
        expect(REPORT_STATUSES).toContain(d.status);
        statuses.add(d.status as string);
        const job = jobs.get(d.job_id as string)!;
        expect(job).toBeTruthy();
        expect(job.status_category).not.toBe("draft");
        expect((d.report_date as string) >= (job.start_date as string)).toBe(true);
        expect((d.report_date as string) <= company.history.asOf).toBe(true);
        expect(d.submitted_by).toBe(job.foreman_user_id);
        if (d.status === "draft") expect(d.submitted_at).toBeNull();
        else expect(d.submitted_at).toBeTruthy();
        if (d.status === "reviewed") {
          expect(d.reviewed_by).toBeTruthy();
          expect(d.reviewed_at).toBeTruthy();
        } else {
          expect(d.reviewed_by).toBeNull();
          expect(d.reviewed_at).toBeNull();
        }
        if (d.status === "returned") {
          expect(d.returned_by).toBeTruthy();
          expect(d.return_reason).toBeTruthy();
        } else expect(d.return_reason).toBeNull();
        expect((d.idempotency_key as string).length).toBeGreaterThanOrEqual(8);
        expect((d.summary as string).length).toBeGreaterThan(0);
      }
      expect([...statuses].sort()).toEqual([...REPORT_STATUSES].sort());
      for (const w of r.rows.report_work_line) {
        const rep = reports.get(w.report_id as string)!;
        expect(rep).toBeTruthy();
        if (w.stage_id) {
          const st = stages.get(w.stage_id as string)!;
          expect(st.job_id).toBe(rep.job_id);
          expect(st.stage_key).toBe(w.stage_key);
          expect(["completed", "in_progress"]).toContain(st.status);
        }
        expect(w.superseded_at).toBeNull();
      }
      const labourByReport = groupBy(r.rows.report_labour_line, (l) => l.report_id as string);
      for (const [reportId, lines] of labourByReport) {
        expect(reports.has(reportId)).toBe(true);
        expect(distinct(lines, (l) => String(l.employee_id))).toBe(lines.length);
        for (const l of lines) {
          expect(r.activeEmployeeIds.has(l.employee_id as string)).toBe(true);
          expect(l.normal_hours as number).toBeGreaterThan(0);
          expect(l.normal_hours as number).toBeLessThanOrEqual(24);
          expect(l.ot_hours as number).toBeGreaterThanOrEqual(0);
          expect(l.ot_hours as number).toBeLessThanOrEqual(24);
        }
      }
      // Every report reports labour (the product's cost wall freezes from these lines).
      for (const d of r.rows.daily_report) expect(labourByReport.has(d.id as string)).toBe(true);
      let deducted = 0;
      for (const m of r.rows.report_material_line) {
        const rep = reports.get(m.report_id as string)!;
        expect(rep).toBeTruthy();
        expect(m.qty as number).toBeGreaterThan(0);
        expect((m.item_name as string).length).toBeGreaterThan(0);
        expect((m.unit as string).length).toBeLessThanOrEqual(16);
        expect(["catalog", "manual", "none"]).toContain(m.cost_source);
        if (m.item_id) {
          expect(r.activeItemIds.has(m.item_id as string)).toBe(true);
          expect(m.cost_source).toBe("catalog");
          expect(m.item_name).toMatch(/^Catalogue item/);
        } else {
          expect(m.cost_source).not.toBe("catalog");
          expect(m.deducted_from_inventory).toBe(false);
          if (m.cost_source === "manual") expect(m.unit_cost_minor as number).toBeGreaterThan(0);
          else expect(m.unit_cost_minor).toBeNull();
        }
        expect(m.cost_only).toBe(!m.deducted_from_inventory);
        if (m.deducted_from_inventory) {
          deducted++;
          expect(m.item_id).toBeTruthy();
          expect(["submitted", "reviewed"]).toContain(rep.status);
        }
      }
      if (company.profile.enables.stock) {
        expect(r.rows.report_material_line.length).toBeGreaterThan(0);
        expect(deducted).toBeGreaterThan(0);
      } else expect(r.rows.report_material_line).toHaveLength(0);
    });

    it("issues: job-linked and organisation-wide, resolved ones name a resolver, comments and activity point at real records", async () => {
      const r = await runFor(company);
      const jobs = byId(r.rows.job);
      const tasks = byId(r.rows.task);
      const issues = byId(r.rows.issue);
      let orgWide = 0;
      const statuses = new Set<string>();
      for (const q of r.rows.issue) {
        expect(ISSUE_STATUSES).toContain(q.status);
        statuses.add(q.status as string);
        if (q.job_id === null) orgWide++;
        else expect(jobs.has(q.job_id as string)).toBe(true);
        if (q.status === "resolved" || q.status === "closed") {
          expect(q.resolved_by).toBeTruthy();
          expect(q.resolved_at).toBeTruthy();
        } else {
          expect(q.resolved_by).toBeNull();
          expect(q.resolved_at).toBeNull();
        }
        expect(["low", "medium", "high", "critical"]).toContain(q.severity);
        if (q.assignee_employee_id)
          expect(r.activeEmployeeIds.has(q.assignee_employee_id as string)).toBe(true);
        expect(Object.values(r.users)).toContain(q.raised_by);
      }
      expect(orgWide).toBe(15);
      expect([...statuses].sort()).toEqual([...ISSUE_STATUSES].sort());
      const resolve = (type: unknown, id: unknown) =>
        type === "job"
          ? jobs.has(id as string)
          : type === "task"
            ? tasks.has(id as string)
            : issues.has(id as string);
      for (const c of r.rows.comment) {
        expect(["job", "task", "issue"]).toContain(c.entity_type);
        expect(
          resolve(c.entity_type, c.entity_id),
          `comment on ${c.entity_type} ${c.entity_id}`,
        ).toBe(true);
        expect(Object.values(r.users)).toContain(c.author_user_id);
        expect((c.body as string).length).toBeGreaterThan(0);
        expect(c.deleted_at).toBeNull();
      }
      for (const a of r.rows.activity) {
        expect(["job", "task", "issue"]).toContain(a.entity_type);
        expect(resolve(a.entity_type, a.entity_id)).toBe(true);
        expect(["created", "moved", "raised", "commented"]).toContain(a.verb);
        expect((a.summary as string).length).toBeGreaterThan(0);
      }
      // Every job was "created", every non-draft job "moved", every comment echoed.
      const verbsByJob = groupBy(
        r.rows.activity.filter((a) => a.entity_type === "job"),
        (a) => a.entity_id as string,
      );
      for (const j of r.rows.job) {
        const verbs = (verbsByJob.get(j.id as string) ?? []).map((a) => a.verb);
        expect(verbs).toContain("created");
        if (j.status_category !== "draft") expect(verbs).toContain("moved");
      }
      expect(r.rows.activity.filter((a) => a.verb === "commented")).toHaveLength(
        r.rows.comment.length,
      );
    });

    it("weekly plans: one live plan per week, issued ones carry issuer and date, revisions name a revised original, jobs resolve", async () => {
      const r = await runFor(company);
      const plans = byId(r.rows.week_plan);
      const jobs = byId(r.rows.job);
      expect(distinct(r.rows.week_plan, (w) => String(w.reference))).toBe(r.rows.week_plan.length);
      const live = r.rows.week_plan.filter((w) => w.status === "draft" || w.status === "issued");
      expect(distinct(live, (w) => String(w.week_start))).toBe(live.length);
      const statuses = new Set<string>();
      for (const w of r.rows.week_plan) {
        expect(WEEK_PLAN_STATUSES).toContain(w.status);
        statuses.add(w.status as string);
        expect(weekStartOf(w.week_start as string)).toBe(w.week_start);
        expect((w.week_end as string) >= (w.week_start as string)).toBe(true);
        expect(w.created_by).toBe(r.users.manager);
        if (w.status === "draft") {
          expect(w.issued_at).toBeNull();
          expect(w.issued_by).toBeNull();
          expect(w.issuer_snapshot).toBeNull();
        } else {
          expect(w.issued_at).toBeTruthy();
          expect(w.issued_by).toBeTruthy();
          expect((w.issuer_snapshot as { legalName: string }).legalName).toBe(company.legalNameEn);
          expect((w.issuer_snapshot as { trn: string }).trn).toMatch(
            company.country === "SA" ? /^399999/ : /^1999/,
          );
        }
        if (w.status === "cancelled") expect(w.cancelled_reason).toBeTruthy();
        else expect(w.cancelled_reason).toBeNull();
        if (w.revision_of_id) {
          expect(w.revision_reason).toBeTruthy();
          const original = plans.get(w.revision_of_id as string)!;
          expect(original.status).toBe("revised");
          expect(original.week_start).toBe(w.week_start);
          expect(w.reference).toBe(`${original.reference}-R1`);
        } else expect(w.revision_reason).toBeNull();
      }
      expect([...statuses].sort()).toEqual([...WEEK_PLAN_STATUSES].sort());
      for (const w of r.rows.week_plan.filter((w) => w.status === "revised"))
        expect(r.rows.week_plan.some((x) => x.revision_of_id === w.id)).toBe(true);
      // The revised originals were written before their revisions (the FK order the seed uses).
      const order = r.rows.week_plan.map((w) => w.id);
      for (const w of r.rows.week_plan)
        if (w.revision_of_id)
          expect(order.indexOf(w.revision_of_id as string)).toBeLessThan(
            order.indexOf(w.id as string),
          );
      expect(distinct(r.rows.week_plan_job, (x) => `${x.week_plan_id}:${x.job_id}`)).toBe(
        r.rows.week_plan_job.length,
      );
      for (const wj of r.rows.week_plan_job) {
        expect(plans.has(wj.week_plan_id as string)).toBe(true);
        const j = jobs.get(wj.job_id as string)!;
        expect(j).toBeTruthy();
        expect(j.status_category).not.toBe("draft");
        expect(wj.removed_at).toBeNull();
      }
      expect(r.rows.week_plan.length).toBeGreaterThanOrEqual(60);
      expect(r.rows.week_plan_job.length).toBeGreaterThan(r.rows.week_plan.length * 5);
    });

    it("the handoff names every id a later family needs and nothing it cannot resolve", async () => {
      const r = await runFor(company);
      const h = r.handoff;
      const ids = (t: WorkTable) => r.rows[t].map((x) => x.id as string);
      expect(h.jobIds).toEqual(ids("job"));
      expect(h.taskIds).toEqual(ids("task"));
      expect(h.reportIds).toEqual(ids("daily_report"));
      expect(h.issueIds.slice().sort()).toEqual(ids("issue").sort());
      // Compared as a set, not a sequence: a revision names its original, so the
      // family inserts originals before revisions while the handoff lists plans
      // in model order. Both orders are correct; only the membership must match.
      expect(h.weekPlanIds.slice().sort()).toEqual(ids("week_plan").sort());
      expect(h.jobs).toHaveLength(r.rows.job.length);
      const jobs = byId(r.rows.job);
      for (const j of h.jobs) {
        const row = jobs.get(j.id)!;
        expect(row.reference).toBe(j.reference);
        expect(row.customer_id).toBe(j.customerId);
        expect(row.status_category).toBe(j.category);
      }
      const openIds = new Set(
        r.rows.job
          .filter(
            (j) => !j.archived && j.status_category !== "done" && j.status_category !== "cancelled",
          )
          .map((j) => j.id as string),
      );
      expect(h.activeJobIds.length).toBeLessThanOrEqual(HANDOFF_ACTIVE_JOBS);
      expect(h.majorJobIds.length).toBeLessThanOrEqual(HANDOFF_MAJOR_JOBS);
      expect(h.activeJobIds.length).toBeGreaterThan(0);
      expect(h.majorJobIds.length).toBeGreaterThan(0);
      for (const id of [...h.activeJobIds, ...h.majorJobIds]) expect(openIds.has(id)).toBe(true);
      expect(Object.keys(h.taskIdsByJob).sort()).toEqual([...h.majorJobIds].sort());
      const taskSet = new Set(h.taskIds);
      for (const list of Object.values(h.taskIdsByJob))
        for (const t of list) expect(taskSet.has(t)).toBe(true);
      expect(h.personaJobs.field!.length).toBeGreaterThan(0);
      expect(h.personaJobs.restricted!.length).toBeGreaterThan(0);
      for (const id of [...h.personaJobs.field!, ...h.personaJobs.restricted!])
        expect(openIds.has(id)).toBe(true);
      expect(h.approvalRuleIds).toEqual({ task_completion: r.rows.approval_rule[0]!.id });
      expect(h.jobPresetIds).toEqual(r.presetIds);
      expect(h.referenceSequences).toEqual(
        Object.fromEntries(r.rows.reference_sequence.map((s) => [s.scope_key, s.next_value])),
      );
      const deductedRows = r.rows.report_material_line.filter(
        (m) => m.deducted_from_inventory === true,
      );
      expect(h.deductedMaterialLines).toHaveLength(deductedRows.length);
      const reports = byId(r.rows.daily_report);
      for (const [lineId, reportId, jobId, itemId, qty, unit, date] of h.deductedMaterialLines) {
        const rep = reports.get(reportId)!;
        expect(rep.job_id).toBe(jobId);
        expect(rep.report_date).toBe(date);
        expect(r.activeItemIds.has(itemId)).toBe(true);
        expect(qty).toBeGreaterThan(0);
        expect(unit.length).toBeGreaterThan(0);
        expect(deductedRows.some((m) => m.id === lineId)).toBe(true);
      }
      expect(new Set(h.deductedMaterialReportIds).size).toBe(
        new Set(deductedRows.map((m) => m.report_id)).size,
      );
    });

    it("dates stay inside the company's history and nothing lands in the future", async () => {
      const r = await runFor(company);
      const from = company.history.from;
      const asOf = company.history.asOf;
      const tomorrow = new Date(Date.parse(asOf + "T00:00:00Z") + 86_400_000).toISOString();
      for (const t of WORK_TABLES) {
        for (const row of r.rows[t]) {
          for (const col of [
            "created_at",
            "updated_at",
            "submitted_at",
            "reviewed_at",
            "returned_at",
            "resolved_at",
            "completed_at",
            "started_at",
            "issued_at",
            "archived_at",
            "decided_at",
          ]) {
            const v = row[col];
            if (typeof v !== "string") continue;
            expect(v >= from, `${t}.${col} ${v} before history`).toBe(true);
            expect(v < tomorrow, `${t}.${col} ${v} in the future`).toBe(true);
          }
        }
      }
      // A spread across the whole history, not a pile-up at the end.
      const years = new Set(r.rows.job.map((j) => (j.created_at as string).slice(0, 4)));
      expect(years.size).toBeGreaterThanOrEqual(3);
    });
  });
}

describe("pagination and budget across the five companies", () => {
  it("facilico carries the paginated job book, and the rest stay substantial", async () => {
    const runs = await Promise.all(COMPANIES.map((c) => runFor(c)));
    const facilico = runs[COMPANIES.findIndex((c) => c.key === "facilico")]!;
    expect(facilico.plan.job).toBeGreaterThan(PAGINATION_THRESHOLD);
    expect(facilico.plan.task).toBeGreaterThan(PAGINATION_THRESHOLD);
    /*
     * Only facilico is required past the pagination threshold on jobs. An
     * earlier profile put EVERY company past it, and the arithmetic of that
     * choice — five companies x >1,205 jobs x stages x tasks x reports — planned
     * 197,000 rows in this family alone, against a 150,000-row budget for the
     * WHOLE lab. The rule is one company past the boundary on each paginated
     * surface; the others stay substantial.
     */
    for (const r of runs) expect(r.plan.job).toBeGreaterThan(150);
  });

  it("the family's total stays inside its share of the 150k-row budget and reports per-company totals", async () => {
    const runs = await Promise.all(COMPANIES.map((c) => runFor(c)));
    const totals: Record<string, number> = {};
    let grand = 0;
    for (const [i, r] of runs.entries()) {
      const total = Object.values(r.plan).reduce((a, b) => a + b, 0);
      totals[COMPANIES[i]!.key] = total;
      grand += total;
    }
    console.log(`work family planned rows per company: ${JSON.stringify(totals)} total=${grand}`);
    expect(grand).toBeLessThan(70_000);
    expect(grand).toBeGreaterThan(25_000);
    for (const t of EXCLUSIVE_TABLES) expect(WORK_TABLES).toContain(t);
  });
});
