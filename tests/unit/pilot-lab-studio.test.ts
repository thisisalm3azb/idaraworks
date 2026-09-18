/**
 * H33 Pilot Lab — the `studio` family, pinned without a database.
 *
 * The family's model is pure: every draw comes from the seeded Rng, every id
 * from the deterministic id function, every date from the SimClock. So the
 * whole family can be run against an in-memory insert and every law the
 * contract asks for (families/README.md) can be checked on the rows it would
 * write: plan() equals seed(), org_id on every row, identical rows on a second
 * run, only born states, and the graph invariants the DB CHECKs, unique
 * indexes and the product's own vocabularies enforce.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { H33_BRAND } from "../../tooling/pilot-lab/brand";
import { describe, expect, it, vi } from "vitest";

/*
 * These build a whole company in memory — tens of thousands of rows for the
 * larger profiles — so the 5-second default is a stopwatch on the machine, not
 * on the code. Under full-suite parallel load it fired on the biggest company
 * and looked like a logic failure.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import type { Ctx } from "@/platform/tenancy";
import {
  DEP_KINDS,
  EDGE_TYPES,
  LINKABLE_RECORD_TYPES,
  NODE_TYPES,
  VIEW_KINDS,
} from "@/modules/studio/types";
import { COMPANIES } from "../../tooling/pilot-lab/companies";
import type { Sql } from "../../tooling/pilot-lab/db";
import {
  STUDIO_TABLES,
  buildStudioModel,
  cycleIn,
  readLinkedRecords,
  setStudioServices,
  studio,
  studioServicesEnabled,
  type StudioModel,
} from "../../tooling/pilot-lab/families/studio";
import { id as labId } from "../../tooling/pilot-lab/ids";
import { SEED_VERSION } from "../../tooling/pilot-lab/marker";
import type {
  Company,
  FamilyPlan,
  FamilyReport,
  LabContext,
  PersonaKey,
} from "../../tooling/pilot-lab/types";
import { SimClock } from "../../tooling/simulation/dates";
import { Rng, uuidv5 } from "../../tooling/simulation/rng";

type Row = Record<string, unknown>;
type Store = Map<string, Row[]>;

// ── a fake LabContext: the same seeds, ids and clock as run.ts, no database ──

function fakeHandoffs(company: Company): Record<string, Record<string, unknown>> {
  const u = (s: string) => uuidv5(`test:${company.key}:${s}`);
  const employeeIds = Array.from({ length: 30 }, (_, i) => u(`employee:${i}`));
  const personaEmployees: Partial<Record<PersonaKey, string>> = {
    manager: employeeIds[0]!,
    hr: employeeIds[1]!,
    warehouse: employeeIds[2]!,
    field: employeeIds[3]!,
    restricted: employeeIds[4]!,
  };
  // The shape `work` really hands off: compact tuples, one per job.
  const categories = ["active", "active", "done", "on_hold", "draft", "cancelled"];
  const jobs = Array.from({ length: 40 }, (_, i) => [
    u(`job:${i}`),
    null,
    categories[i % categories.length]!,
    "2025-01-05",
    "2025-04-30",
    i % 2 ? "CONSTR" : "SERVICE",
    i % 3 === 0 ? 1 : 0,
    "manual",
  ]);
  const taskIds = Array.from({ length: 160 }, (_, i) => u(`task:${i}`));
  return {
    setup: { departments: {}, teams: {} },
    people: {
      personaEmployees,
      employeeIds,
      activeEmployeeIds: employeeIds.slice(0, 24),
      byDepartment: {},
      departments: [],
      managers: employeeIds.slice(0, 3),
      teamIds: [],
      workLocationIds: [],
      workPatternIds: { standard: u("wp:s"), rota: u("wp:r"), partTime: u("wp:p") },
      shiftIds: [],
      skillIds: [],
      payComponents: {},
    },
    work: {
      jobs,
      taskIds,
      issueIds: [],
      weekPlanIds: [],
      deductedMaterialReportIds: [],
      deductedMaterialLines: [],
      approvalRuleIds: {},
      jobPresetIds: {},
      referenceSequences: {},
      personaJobs: {},
    },
  };
}

function fakeContext(
  company: Company,
  opts: { dryRun?: boolean } = {},
): {
  ctx: LabContext;
  store: Store;
  log: string[];
  handoffs: Record<string, Record<string, unknown>>;
} {
  const store: Store = new Map();
  const log: string[] = [];
  const orgId = uuidv5(`test:org:${company.key}`);
  const users = Object.fromEntries(
    company.personas.map((p) => [p.key, uuidv5(`test:user:${company.key}:${p.key}`)]),
  ) as Record<PersonaKey, string>;
  const handoffs = fakeHandoffs(company);
  const refuse = () => {
    throw new Error("unit test: there is no database here");
  };
  const ctx: LabContext = {
    brand: H33_BRAND,
    sql: refuse as unknown as Sql,
    admin: {} as unknown as SupabaseClient,
    company,
    orgId,
    users,
    employees: {},
    ctxFor: (persona): Ctx => ({
      orgId,
      userId: users[persona],
      costPrivileged: true,
      pricePrivileged: true,
      requestId: `test-${company.key}-${persona}`,
    }),
    archetypeOf: (persona) => company.personas.find((x) => x.key === persona)!.archetype,
    rng: new Rng(`h33:${SEED_VERSION}:${company.key}`),
    clock: new SimClock(company.history.asOf),
    id: (family, ...ordinal) => labId(company.key, family, ...ordinal),
    insert: async (table, rows) => {
      // The same refusals insertBatch makes before anything is sent.
      if (rows.length === 0) return { attempted: 0, inserted: 0 };
      const columns = Object.keys(rows[0]!);
      if (!columns.includes("org_id")) throw new Error(`${table}: rows must carry org_id`);
      for (const r of rows) {
        if (!r.org_id) throw new Error(`${table}: a row has no org_id`);
        for (const k of Object.keys(r))
          if (!columns.includes(k)) throw new Error(`${table}: ragged row (extra ${k})`);
      }
      if (opts.dryRun) return { attempted: rows.length, inserted: 0 };
      store.set(table, [...(store.get(table) ?? []), ...rows]);
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
    log: (m) => log.push(m),
    dryRun: opts.dryRun ?? false,
  };
  return { ctx, store, log, handoffs };
}

type Run = {
  ctx: LabContext;
  store: Store;
  log: string[];
  handoffs: Record<string, Record<string, unknown>>;
  plan: FamilyPlan;
  report: FamilyReport;
  model: StudioModel;
  rows: (t: string) => Row[];
};
const RUNS = new Map<string, Run>();

/** plan() then seed() with the services off — the pure part of the family, end to end. */
async function runCompany(company: Company): Promise<Run> {
  const cached = RUNS.get(company.key);
  if (cached) return cached;
  setStudioServices(false);
  try {
    const { ctx, store, log, handoffs } = fakeContext(company);
    const plan = studio.plan(ctx);
    const report = await studio.seed(ctx);
    const model = buildStudioModel(ctx);
    const rows = (t: string): Row[] => store.get(t) ?? [];
    const run = { ctx, store, log, handoffs, plan, report, model, rows };
    RUNS.set(company.key, run);
    return run;
  } finally {
    setStudioServices(true);
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const applies = COMPANIES.filter((c) => studio.appliesTo(c));

// ── the family's identity ────────────────────────────────────────────────────

describe("the studio family", () => {
  it("is keyed and depends on setup, people and work", () => {
    expect(studio.key).toBe("studio");
    expect(studio.deps).toEqual(["setup", "people", "work"]);
  });

  it("applies exactly where the profile enables the studio", () => {
    expect(applies.length).toBeGreaterThan(0);
    const c = COMPANIES[0]!;
    const off: Company = {
      ...c,
      profile: { ...c.profile, enables: { ...c.profile.enables, studio: false } },
    };
    expect(studio.appliesTo(off)).toBe(false);
    expect(studio.appliesTo(c)).toBe(c.profile.enables.studio);
  });

  it("leaves the service switch on by default and restores it after a run", async () => {
    await runCompany(applies[0]!);
    expect(studioServicesEnabled()).toBe(true);
  });
});

// ── plan == seed, org_id everywhere, determinism ─────────────────────────────

describe.each(applies)("$key: the dry-run is honest", (company) => {
  it("plan() counts are exactly the rows seed() inserts, per table", async () => {
    const { plan, report, store } = await runCompany(company);
    expect(plan.family).toBe("studio");
    expect(report.family).toBe("studio");
    for (const t of STUDIO_TABLES) {
      expect(store.get(t)?.length ?? 0, t).toBe(plan.expected[t] ?? 0);
      expect(report.counts[t] ?? 0, t).toBe(plan.expected[t] ?? 0);
    }
    // With the services off nothing but the bulk tables is promised or written.
    expect(Object.keys(plan.expected).sort()).toEqual([...STUDIO_TABLES].sort());
    expect([...store.keys()].sort()).toEqual(
      [...STUDIO_TABLES].filter((t) => (plan.expected[t] ?? 0) > 0).sort(),
    );
    expect(plan.expected.studio_plan).toBe(Math.max(1, company.profile.studioPlans));
  });

  it("with the services on, plan() budgets the rows they create and a dry run never calls them", async () => {
    setStudioServices(true);
    const { ctx, store } = fakeContext(company, { dryRun: true });
    const plan = studio.plan(ctx);
    const report = await studio.seed(ctx);
    const model = buildStudioModel(ctx);
    expect(store.size).toBe(0); // dry run: nothing recorded
    expect(plan.expected.studio_edge).toBe(
      model.rows.studio_edge.length + model.serviceRows.studio_edge,
    );
    expect(plan.expected.task_dependency).toBe(model.serviceRows.task_dependency);
    expect(plan.expected.approval).toBe(model.serviceRows.approval);
    expect(model.serviceRows.approval).toBeGreaterThan(0);
    expect(model.serviceRows.studio_edge).toBeGreaterThan(0);
    // the dry-run seed attempted the bulk rows only, and no service transition
    expect(report.counts.studio_edge).toBe(model.rows.studio_edge.length);
    expect(report.counts.approval).toBeUndefined();
    expect(report.counts.task_dependency).toBeUndefined();
  });

  it("every row carries the organisation id", async () => {
    const { store, ctx } = await runCompany(company);
    let n = 0;
    for (const [t, rows] of store) {
      for (const r of rows) {
        expect(r.org_id, t).toBe(ctx.orgId);
        n++;
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  it("a second run produces identical rows (deterministic ids and draws)", async () => {
    const first = await runCompany(company);
    setStudioServices(false);
    try {
      const { ctx, store } = fakeContext(company);
      await studio.seed(ctx);
      for (const t of STUDIO_TABLES) {
        expect(JSON.stringify(store.get(t) ?? []), t).toBe(
          JSON.stringify(first.store.get(t) ?? []),
        );
      }
    } finally {
      setStudioServices(true);
    }
  });

  it("primary keys are unique within every table and are v5 uuids", async () => {
    const { store } = await runCompany(company);
    for (const [t, rows] of store) {
      if (t === "reference_sequence") continue;
      const ids = rows.map((r) => str(r.id));
      expect(new Set(ids).size, t).toBe(ids.length);
      for (const id of ids)
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

// ── only born states ─────────────────────────────────────────────────────────

describe.each(applies)("$key: bulk rows are born, never faked into a later state", (company) => {
  it("plans are active or archived; scenarios are drafts with no applied stamp", async () => {
    const { rows } = await runCompany(company);
    for (const p of rows("studio_plan")) expect(["active", "archived"]).toContain(p.status);
    for (const s of rows("studio_scenario")) {
      expect(s.status).toBe("draft");
      expect(s.applied_at).toBeNull();
      expect(s.applied_by).toBeNull();
    }
  });

  it("edges are live and never claim a canonical task_dependency by hand", async () => {
    const { rows } = await runCompany(company);
    for (const e of rows("studio_edge")) {
      expect(e.task_dependency_id).toBeNull();
      expect(e.removed_at).toBeNull();
      expect(e.removed_by).toBeNull();
    }
    for (const n of rows("studio_node")) expect(n.archived_at).toBeNull();
    for (const v of rows("studio_view")) expect(v.removed_at).toBeNull();
  });

  it("node statuses and priorities are the four the schema allows, and all four statuses occur", async () => {
    const { rows } = await runCompany(company);
    const statuses = new Set<string>();
    for (const n of rows("studio_node")) {
      expect(["proposed", "active", "done", "dropped"]).toContain(n.status);
      expect(["low", "normal", "high", "urgent"]).toContain(n.priority);
      statuses.add(str(n.status));
    }
    expect([...statuses].sort()).toEqual(["active", "done", "dropped", "proposed"]);
  });
});

// ── the graph: what the database CHECKs, and what the product's registries say ──

describe.each(applies)("$key: graph integrity", (company) => {
  it("every node uses a registered type, layer and record link; CHECK constraints hold", async () => {
    const { rows, handoffs, ctx } = await runCompany(company);
    const nodes = rows("studio_node");
    const employees = new Set(handoffs.people!.employeeIds as string[]);
    const jobs = new Set((handoffs.work!.jobs as unknown[][]).map((j) => j[0] as string));
    const tasks = new Set(handoffs.work!.taskIds as string[]);
    const linkTypes = new Set<string>();
    for (const n of nodes) {
      expect(NODE_TYPES as readonly string[]).toContain(n.node_type);
      expect((n.record_type === null) === (n.record_id === null), "link pair").toBe(true);
      if (typeof n.record_type === "string") {
        expect(LINKABLE_RECORD_TYPES as readonly string[]).toContain(n.record_type);
        linkTypes.add(n.record_type);
        const pool = n.record_type === "job" ? jobs : n.record_type === "task" ? tasks : employees;
        expect(pool.has(str(n.record_id)), `${n.record_type} ${n.record_id}`).toBe(true);
      }
      expect(n.amount_minor === null || n.currency !== null, "money").toBe(true);
      if (n.amount_minor !== null) expect(n.currency).toBe(company.currency);
      expect((n.constraint_kind === "none") === (n.constraint_date === null), "constraint").toBe(
        true,
      );
      expect(["none", "start_no_earlier", "finish_no_later"]).toContain(n.constraint_kind);
      expect(str(n.title).length).toBeLessThanOrEqual(300);
      expect(str(n.description).length).toBeLessThanOrEqual(4000);
      expect(str(n.layer_key).length).toBeLessThanOrEqual(40);
      if (n.progress_pct !== null) {
        expect(n.progress_pct as number).toBeGreaterThanOrEqual(0);
        expect(n.progress_pct as number).toBeLessThanOrEqual(100);
      }
      if (n.duration_days !== null) {
        expect(n.duration_days as number).toBeGreaterThanOrEqual(0);
        expect(n.duration_days as number).toBeLessThanOrEqual(3650);
      }
      if (n.estimate_optimistic_days !== null && n.duration_days !== null) {
        expect(n.estimate_optimistic_days as number).toBeLessThanOrEqual(n.duration_days as number);
        expect(n.estimate_pessimistic_days as number).toBeGreaterThanOrEqual(
          n.duration_days as number,
        );
      }
      if (n.assignee_employee_id !== null)
        expect(employees.has(str(n.assignee_employee_id))).toBe(true);
      expect(n.created_by).toBe(ctx.users.manager);
      expect(n.parent_node_id).not.toBe(n.id);
    }
    expect([...linkTypes].sort()).toEqual(["employee", "job", "task"]);
  });

  it("parents, edge endpoints and scenario targets all resolve inside their own plan", async () => {
    const { rows } = await runCompany(company);
    const planOf = new Map<string, string>();
    for (const n of rows("studio_node")) planOf.set(str(n.id), str(n.plan_id));
    for (const n of rows("studio_node")) {
      if (n.parent_node_id === null) continue;
      expect(planOf.get(str(n.parent_node_id)), "parent plan").toBe(n.plan_id);
    }
    const live = new Set<string>();
    for (const e of rows("studio_edge")) {
      expect(planOf.get(str(e.source_node_id)), "source").toBe(e.plan_id);
      expect(planOf.get(str(e.target_node_id)), "target").toBe(e.plan_id);
      expect(e.source_node_id).not.toBe(e.target_node_id);
      expect(EDGE_TYPES as readonly string[]).toContain(e.edge_type);
      expect((e.edge_type === "dependency") === (e.dep_kind !== null), "dep kind").toBe(true);
      if (e.dep_kind !== null) expect(DEP_KINDS as readonly string[]).toContain(e.dep_kind);
      expect(e.lag_days as number).toBeGreaterThanOrEqual(-365);
      expect(e.lag_days as number).toBeLessThanOrEqual(365);
      expect(str(e.label).length).toBeLessThanOrEqual(200);
      const key = `${e.source_node_id}>${e.target_node_id}:${e.edge_type}`;
      expect(live.has(key), `duplicate live edge ${key}`).toBe(false);
      live.add(key);
    }
    const scenarioPlan = new Map<string, string>();
    for (const s of rows("studio_scenario")) scenarioPlan.set(str(s.id), str(s.plan_id));
    const changeKeys = new Set<string>();
    for (const c of rows("studio_scenario_change")) {
      expect(c.target_kind).toBe("node");
      expect(c.record_type).toBeNull();
      expect(planOf.get(str(c.target_id))).toBe(scenarioPlan.get(str(c.scenario_id)));
      const key = `${c.scenario_id}:${c.target_kind}:${c.target_id}:${c.field}`;
      expect(changeKeys.has(key), `duplicate change ${key}`).toBe(false);
      changeKeys.add(key);
    }
  });

  it("dependency logic is acyclic in every plan and mixes FS / SS / FF with lead-lag", async () => {
    const { rows } = await runCompany(company);
    const byPlan = new Map<string, Array<{ source: string; target: string }>>();
    const kinds = new Set<string>();
    let lagged = 0;
    for (const e of rows("studio_edge")) {
      if (e.edge_type !== "dependency") continue;
      const pid = str(e.plan_id);
      byPlan.set(pid, [
        ...(byPlan.get(pid) ?? []),
        { source: str(e.source_node_id), target: str(e.target_node_id) },
      ]);
      kinds.add(str(e.dep_kind));
      if ((e.lag_days as number) > 0) lagged++;
    }
    expect(byPlan.size).toBe(rows("studio_plan").length);
    for (const [pid, es] of byPlan) expect(cycleIn(es), `cycle in ${pid}`).toEqual([]);
    expect([...kinds].sort()).toEqual(["finish_to_finish", "finish_to_start", "start_to_start"]);
    expect(lagged).toBeGreaterThan(0);
  });

  it("one plan crosses 300 nodes and 400 edges; every plan is dense", async () => {
    const { rows, model } = await runCompany(company);
    const nodes = new Map<string, number>();
    const edges = new Map<string, number>();
    for (const n of rows("studio_node"))
      nodes.set(str(n.plan_id), (nodes.get(str(n.plan_id)) ?? 0) + 1);
    for (const e of rows("studio_edge"))
      edges.set(str(e.plan_id), (edges.get(str(e.plan_id)) ?? 0) + 1);
    const flagship = model.plans[0]!.id;
    expect(nodes.get(flagship)).toBeGreaterThan(300);
    expect(edges.get(flagship)).toBeGreaterThan(400);
    for (const p of model.plans) {
      expect(nodes.get(p.id) ?? 0, p.reference).toBeGreaterThanOrEqual(50);
      expect(edges.get(p.id) ?? 0, p.reference).toBeGreaterThan(nodes.get(p.id) ?? 0);
    }
  });
});

// ── the studio documents around each graph ───────────────────────────────────

describe.each(applies)("$key: plans, baselines, versions, scenarios, views", (company) => {
  it("plan references are PLN-nnn, unique, with names in range, and the counter sits past them", async () => {
    const { rows, ctx } = await runCompany(company);
    const plans = rows("studio_plan");
    const refs = plans.map((p) => str(p.reference));
    expect(new Set(refs).size).toBe(refs.length);
    for (const p of plans) {
      expect(p.reference).toMatch(/^PLN-\d{3}$/);
      expect(str(p.name).trim().length).toBeGreaterThan(0);
      expect(str(p.name).length).toBeLessThanOrEqual(200);
      expect(str(p.description).length).toBeLessThanOrEqual(4000);
    }
    if (plans.length >= 3) expect(plans.some((p) => p.status === "archived")).toBe(true);
    expect(plans.some((p) => p.status === "active")).toBe(true);
    const seq = rows("reference_sequence");
    expect(seq).toEqual([
      { org_id: ctx.orgId, scope_key: "studio_plan", next_value: plans.length + 1 },
    ]);
  });

  it("every plan has two frozen baselines, two checkpoints, at least two scenarios and three views", async () => {
    const { rows, model } = await runCompany(company);
    const count = (t: string) => {
      const m = new Map<string, number>();
      for (const r of rows(t)) m.set(str(r.plan_id), (m.get(str(r.plan_id)) ?? 0) + 1);
      return m;
    };
    const b = count("studio_baseline");
    const v = count("studio_version");
    const s = count("studio_scenario");
    const w = count("studio_view");
    for (const p of model.plans) {
      expect(b.get(p.id), `${p.reference} baselines`).toBe(2);
      expect(v.get(p.id), `${p.reference} versions`).toBe(2);
      expect(s.get(p.id) ?? 0, `${p.reference} scenarios`).toBeGreaterThanOrEqual(2);
      expect(w.get(p.id) ?? 0, `${p.reference} views`).toBeGreaterThanOrEqual(3);
    }
    const names = new Set<string>();
    for (const r of rows("studio_baseline")) {
      const key = `${r.plan_id}:${r.name}`;
      expect(names.has(key), "baseline name unique per plan").toBe(false);
      names.add(key);
      expect(str(r.name).length).toBeLessThanOrEqual(120);
    }
    for (const r of rows("studio_version")) expect(str(r.name).length).toBeLessThanOrEqual(120);
    for (const r of rows("studio_view")) {
      expect(VIEW_KINDS as readonly string[]).toContain(r.view_kind);
      expect(str(r.name).length).toBeLessThanOrEqual(120);
      expect(str(r.name).trim().length).toBeGreaterThan(0);
    }
    for (const r of rows("studio_scenario")) {
      expect(str(r.name).length).toBeLessThanOrEqual(200);
      expect(Array.isArray(r.assumptions)).toBe(true);
    }
  });

  it("a baseline snapshot lists exactly the nodes the engine scheduled at capture", async () => {
    const { rows } = await runCompany(company);
    // The same rule verify() applies in SQL against the live rows.
    const schedulable = new Map<string, number>();
    const types = new Set([
      "task",
      "milestone",
      "deliverable",
      "phase",
      "project",
      "initiative",
      "action",
    ]);
    for (const n of rows("studio_node")) {
      if (n.archived_at !== null || n.status === "dropped") continue;
      if (!types.has(str(n.node_type))) continue;
      const dated = n.start_date !== null && n.due_date !== null;
      if (n.node_type !== "milestone" && n.duration_days === null && !dated) continue;
      schedulable.set(str(n.plan_id), (schedulable.get(str(n.plan_id)) ?? 0) + 1);
    }
    for (const b of rows("studio_baseline")) {
      const snap = b.snapshot as Array<{
        nodeId: string;
        start: string;
        finish: string;
        durationDays: number;
      }>;
      expect(snap.length, str(b.name)).toBe(schedulable.get(str(b.plan_id)));
      for (const e of snap) {
        expect(e.start <= e.finish).toBe(true);
        expect(e.durationDays).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("scenario changes are built on the live values, so an apply will not see drift", async () => {
    const { rows, model } = await runCompany(company);
    const node = new Map(rows("studio_node").map((n) => [str(n.id), n]));
    const changes = rows("studio_scenario_change");
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) {
      const n = node.get(str(c.target_id))!;
      expect(["durationDays", "priority"]).toContain(c.field);
      const live = c.field === "durationDays" ? n.duration_days : n.priority;
      expect(c.old_value).toEqual(live);
      expect(c.new_value).not.toEqual(live);
      if (c.field === "durationDays") expect(c.new_value as number).toBeGreaterThanOrEqual(1);
      expect(n.record_type, "a scenario change targets a draft element").toBeNull();
    }
    // the transitions the services will drive, and only on active plans
    for (const p of model.plans) {
      for (const s of p.scenarios) {
        if (s.transition === "apply") {
          expect(p.status).toBe("active");
          expect(s.changes.length).toBeGreaterThan(0);
        }
        if (s.transition === null) expect(s.changes.length).toBe(0);
      }
    }
    expect(model.plans.flatMap((p) => p.scenarios).some((s) => s.transition === "discard")).toBe(
      true,
    );
  });

  it("the flagship's first scenario stores a reproducible Monte Carlo result", async () => {
    const { rows, model } = await runCompany(company);
    const first = rows("studio_scenario").find((s) => s.plan_id === model.plans[0]!.id)!;
    const sim = first.simulation as Record<string, unknown>;
    expect(typeof sim.seed).toBe("number");
    expect(sim.samples).toBe(100);
    expect(sim.finish).toEqual(
      expect.objectContaining({
        p50: expect.any(String),
        p80: expect.any(String),
        p90: expect.any(String),
      }),
    );
    expect(Object.keys(sim.criticality as object).length).toBeGreaterThan(0);
  });
});

// ── realism: what the brief asks to be visible in the product ────────────────

describe.each(applies)("$key: realism", (company) => {
  it("resource conflicts exist (one assignee, two overlapping activities in one plan)", async () => {
    const { rows } = await runCompany(company);
    const byKey = new Map<string, Row[]>();
    for (const n of rows("studio_node")) {
      if (n.assignee_employee_id === null || n.start_date === null || n.status === "dropped")
        continue;
      const k = `${n.plan_id}:${n.assignee_employee_id}`;
      byKey.set(k, [...(byKey.get(k) ?? []), n]);
    }
    let pairs = 0;
    for (const list of byKey.values())
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]!;
          const b = list[j]!;
          if (str(a.start_date) <= str(b.due_date) && str(b.start_date) <= str(a.due_date)) pairs++;
        }
    expect(pairs).toBeGreaterThanOrEqual(rows("studio_plan").length);
  });

  it("delays exist (active work whose due date has passed with progress short of 100)", async () => {
    const { rows, ctx } = await runCompany(company);
    const late = rows("studio_node").filter(
      (n) =>
        n.status === "active" &&
        str(n.due_date) !== "" &&
        str(n.due_date) < ctx.clock.asOf &&
        (n.progress_pct as number) < 100,
    );
    expect(late.length).toBeGreaterThan(0);
  });

  it("dates come from the working calendar, a deadline and a dated constraint exist, and content is bilingual", async () => {
    const { rows, model } = await runCompany(company);
    const nodes = rows("studio_node");
    const sixDay = company.sixDayWeek;
    const gulf = company.country === "SA";
    for (const n of nodes) {
      for (const d of [n.start_date, n.due_date]) {
        if (d === null) continue;
        const dow = new Date(`${d as string}T00:00:00Z`).getUTCDay();
        // the company's weekend: Fri/Sat in the Gulf, Sat/Sun elsewhere; a six-day week works Saturday
        if (gulf) expect(dow, `${d} weekday`).not.toBe(5);
        else expect(dow, `${d} weekday`).not.toBe(0);
        if (!sixDay) expect(dow, `${d} six-day`).not.toBe(6);
      }
    }
    expect(nodes.some((n) => n.deadline_date !== null)).toBe(true);
    expect(nodes.filter((n) => n.constraint_kind === "start_no_earlier").length).toBe(
      model.plans.length,
    );
    const arabic = nodes.filter((n) => /[؀-ۿ]/.test(str(n.title))).length;
    const latin = nodes.filter((n) => /[A-Za-z]/.test(str(n.title))).length;
    expect(arabic).toBeGreaterThan(0);
    expect(latin).toBeGreaterThan(0);
    if (company.languages[0] === "ar") expect(arabic).toBeGreaterThan(latin / 2);
  });

  it("governance registers, resources, strategy and canvas notes all appear in every plan", async () => {
    const { rows, model } = await runCompany(company);
    const per = new Map<string, Set<string>>();
    for (const n of rows("studio_node")) {
      const s = per.get(str(n.plan_id)) ?? new Set<string>();
      s.add(str(n.node_type));
      per.set(str(n.plan_id), s);
    }
    for (const p of model.plans) {
      const s = per.get(p.id)!;
      for (const t of [
        "phase",
        "task",
        "milestone",
        "risk",
        "decision",
        "assumption",
        "issue",
        "action",
        "resource_requirement",
        "budget_allocation",
        "person",
        "objective",
        "key_result",
        "kpi",
        "note",
      ])
        expect(s.has(t), `${p.reference} has ${t}`).toBe(true);
    }
  });

  it("the report hands off small ids only", async () => {
    const { report, model } = await runCompany(company);
    const h = report.handoff as {
      planIds: string[];
      flagshipPlanId: string;
      planByJobId: Record<string, string>;
      appliedScenarioIds: string[];
    };
    expect(h.planIds).toEqual(model.plans.map((p) => p.id));
    expect(h.flagshipPlanId).toBe(model.plans[0]!.id);
    expect(Object.keys(h.planByJobId).length).toBe(
      model.plans.filter((p) => p.kind === "wbs").length,
    );
    expect(h.appliedScenarioIds.length).toBe(model.serviceRows.approval);
    expect(JSON.stringify(report.handoff).length).toBeLessThan(20_000);
  });
});

describe("pagination thresholds", () => {
  it("at least one company writes more than 1,205 studio nodes", async () => {
    const totals = await Promise.all(
      applies.map(async (c) => (await runCompany(c)).rows("studio_node").length),
    );
    expect(Math.max(...totals)).toBeGreaterThan(1205);
  });
});

// ── the pure helpers ─────────────────────────────────────────────────────────

describe("readLinkedRecords", () => {
  it("reads the tuple shape work hands off, ranks projects and live work first, and skips cancelled jobs", () => {
    const company = COMPANIES[0]!;
    const { ctx, handoffs } = fakeContext(company);
    const linked = readLinkedRecords(ctx);
    const tuples = handoffs.work!.jobs as unknown[][];
    const cancelled = new Set(
      tuples.filter((j) => j[2] === "cancelled").map((j) => j[0] as string),
    );
    expect(linked.jobs.length).toBe(tuples.length - cancelled.size);
    for (const j of linked.jobs) expect(cancelled.has(j.id)).toBe(false);
    const rankOf = (id: string) => {
      const t = tuples.find((j) => j[0] === id)!;
      const live = t[2] === "active" || t[2] === "on_hold";
      return (t[6] === 1 ? 0 : 2) + (live ? 0 : 1);
    };
    for (let i = 1; i < linked.jobs.length; i++)
      expect(rankOf(linked.jobs[i - 1]!.id)).toBeLessThanOrEqual(rankOf(linked.jobs[i]!.id));
    expect(linked.unassignedTasks).toEqual(handoffs.work!.taskIds);
    // active employees are preferred; personas are always present
    expect(linked.employees).toEqual(
      expect.arrayContaining(handoffs.people!.activeEmployeeIds as string[]),
    );
    expect(linked.employees.length).toBe((handoffs.people!.activeEmployeeIds as string[]).length);
  });

  it("tolerates a missing handoff by linking nothing rather than crashing", () => {
    const company = COMPANIES[0]!;
    const { ctx } = fakeContext(company);
    const bare: LabContext = {
      ...ctx,
      handoff: () => {
        throw new Error("no handoff");
      },
    };
    const linked = readLinkedRecords(bare);
    expect(linked.jobs).toEqual([]);
    expect(linked.employees).toEqual([]);
    expect(linked.unassignedTasks).toEqual([]);
  });
});

describe("cycleIn", () => {
  it("returns nothing for a DAG and the nodes left in a cycle otherwise", () => {
    expect(
      cycleIn([
        { source: "a", target: "b" },
        { source: "b", target: "c" },
        { source: "a", target: "c" },
      ]),
    ).toEqual([]);
    const cyc = cycleIn([
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "a" },
      { source: "c", target: "d" },
    ]);
    expect(cyc.sort()).toEqual(["a", "b", "c", "d"]);
  });
});
