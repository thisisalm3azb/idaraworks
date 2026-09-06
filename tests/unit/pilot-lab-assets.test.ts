/**
 * H33 Pilot Lab — the asset register, checked without a database.
 *
 * Two things make this family easy to get wrong and expensive to get wrong.
 * First, `asset_status_transition` is a database trigger: an asset is BORN a
 * draft and every later state has to be walked, so a bulk row that claims to
 * be `disposed` is rejected at insert and takes the whole company's seed down
 * with it. Second, depreciation is arithmetic a finance person will check —
 * a line that carries an asset past cost minus residual is not a rounding
 * quibble, it is a wrong number on a balance sheet.
 *
 * So the tests below assert the born state everywhere, replay every planned
 * status path against `pathTo`, and re-add the depreciation run from its own
 * lines. The service half needs a database; `skipServices` keeps it out.
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
  assets,
  buildAssetsModel,
  pathTo,
  ASSET_TABLES,
  BORN_STATES,
  type AssetStatus,
} from "../../tooling/pilot-lab/families/assets";

type Row = Record<string, unknown>;
type Store = Partial<Record<string, Row[]>>;
type AssetTable = (typeof ASSET_TABLES)[number];

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

const CATEGORY_KEYS = [
  "vehicle",
  "plant",
  "tool",
  "it",
  "furniture",
  "safety",
  "generator",
  "container",
];

function handoffs(company: Company): Record<string, Record<string, unknown>> {
  const warehouses: Record<string, { id: string; locations: Record<string, string> }> = {};
  for (const code of ["MAIN", "SITE"]) {
    const locations: Record<string, string> = {
      [`${code}-RECV`]: labId(company.key, "location", code, "RECV"),
    };
    for (let b = 1; b <= 4; b++)
      locations[`${code}-B${String(b).padStart(2, "0")}`] = labId(
        company.key,
        "location",
        code,
        `B${b}`,
      );
    warehouses[code] = { id: labId(company.key, "warehouse", code), locations };
  }
  const assetCategories: Record<string, string> = {};
  for (const k of CATEGORY_KEYS) assetCategories[k] = labId(company.key, "asset_category", k);
  const personaEmployees: Record<string, string> = {};
  for (const p of PERSONAS) personaEmployees[p] = labId(company.key, "employee", p);
  // work hands jobs over as tuples: [id, customerId, category, start, …].
  const jobs = Array.from({ length: 60 }, (_, i) => [
    labId(company.key, "job", i),
    labId(company.key, "customer", i % 10),
    "active",
    new SimClock(company.history.asOf).dayAgo(900 - i * 12),
    "",
    "",
    0,
    "direct",
  ]);
  return {
    setup: { assetCategories, warehouses },
    people: { personaEmployees, activeEmployeeIds: Object.values(personaEmployees) },
    work: { jobs },
  };
}

function fakeCtx(company: Company) {
  const store: Store = {};
  const orgId = labId(company.key, "org");
  const users = Object.fromEntries(
    PERSONAS.map((p) => [p, labId(company.key, "user", p)]),
  ) as Record<PersonaKey, string>;
  const h = handoffs(company);
  const noDb = () => {
    throw new Error("the unit test has no database");
  };
  const ctx = {
    sql: noDb as unknown as LabContext["sql"],
    admin: {} as unknown as LabContext["admin"],
    company,
    orgId,
    users,
    employees: {},
    ctxFor: (persona: PersonaKey) => ({
      orgId,
      userId: users[persona],
      costPrivileged: true,
      pricePrivileged: true,
      requestId: `test-${company.key}-${persona}`,
    }),
    archetypeOf: (persona: PersonaKey) =>
      company.personas.find((p) => p.key === persona)!.archetype,
    rng: new Rng(`h33:${SEED_VERSION}:${company.key}`),
    clock: new SimClock(company.history.asOf),
    id: (family: string, ...ordinal: Array<string | number>) =>
      labId(company.key, family, ...ordinal),
    insert: async (table: string, rows: Row[]) => {
      if (rows.length === 0) return { attempted: 0, inserted: 0 };
      const columns = Object.keys(rows[0]!);
      for (const r of rows) {
        if (!r.org_id) throw new Error(`${table}: a row has no org_id`);
        for (const k of Object.keys(r))
          if (!columns.includes(k)) throw new Error(`${table}: ragged row (extra ${k})`);
      }
      store[table] = [...(store[table] ?? []), ...rows.map((r) => ({ ...r }))];
      return { attempted: rows.length, inserted: rows.length };
    },
    handoff: <T>(family: string) => {
      const v = h[family];
      if (!v) throw new Error(`no handoff from family ${family}`);
      return v as T;
    },
    log: () => {},
    dryRun: false,
    // The service half drives real transitions; a unit test has no database.
    skipServices: true,
  } as unknown as LabContext;
  return { ctx, store };
}

async function runFor(company: Company) {
  const { ctx, store } = fakeCtx(company);
  const plan = assets.plan(ctx).expected;
  const report = await assets.seed(ctx);
  const rows = (t: AssetTable) => store[t] ?? [];
  return { ctx, plan, report, rows, model: buildAssetsModel(ctx) };
}

const num = (v: unknown) => Number(v as number);
const active = COMPANIES.filter((c) => assets.appliesTo(c));

/** Every transition the asset state machine allows, mirrored from the migration. */
const LEGAL: Record<AssetStatus, AssetStatus[]> = {
  draft: ["in_service", "in_storage", "lost", "retired"],
  in_service: ["in_storage", "under_maintenance", "in_transit", "lost", "retired"],
  in_storage: ["in_service", "under_maintenance", "in_transit", "lost", "retired"],
  under_maintenance: ["in_service", "in_storage", "lost", "retired"],
  in_transit: ["in_service", "in_storage", "lost", "retired"],
  lost: ["in_service", "in_storage", "retired"],
  retired: ["disposed", "in_storage"],
  disposed: [],
};

describe("the assets family", () => {
  it("is declared correctly", () => {
    expect(assets.key).toBe("assets");
    expect(assets.deps).toEqual(expect.arrayContaining(["setup", "people", "work"]));
    for (const c of COMPANIES) expect(assets.appliesTo(c)).toBe(c.profile.enables.assets);
  });

  it("plans a walkable path to every status the register uses", () => {
    // `disposed` is the disposal service's own last hop; everything else is
    // reached by walking states the trigger allows, starting from draft.
    for (const target of Object.keys(LEGAL) as AssetStatus[]) {
      const path = pathTo(target);
      let at: AssetStatus = "draft";
      for (const step of path) {
        expect(LEGAL[at], `${at} → ${step}`).toContain(step);
        at = step;
      }
      if (target === "draft") expect(path).toEqual([]);
      else if (target === "disposed") expect(at).toBe("retired");
      else expect(at).toBe(target);
    }
  });

  it("is born in the state the database insists on", () => {
    expect(BORN_STATES.asset).toBe("draft");
    expect(BORN_STATES.asset_disposal).toBe("submitted");
    expect(BORN_STATES.approval).toBe("pending");
  });
});

for (const company of active) {
  describe(`assets for ${company.key}`, () => {
    it("plans exactly the rows it writes", async () => {
      const r = await runFor(company);
      for (const t of ASSET_TABLES) {
        const want = r.plan[t] ?? 0;
        if (t === "reference_sequence") expect(r.rows(t).length).toBeGreaterThanOrEqual(want);
        else expect(r.rows(t).length, t).toBe(want);
      }
      expect(r.rows("asset").length).toBe(company.profile.assets);
    });

    it("is deterministic", async () => {
      const a = await runFor(company);
      const b = await runFor(company);
      for (const t of ASSET_TABLES)
        expect(a.rows(t).map((x) => x.id ?? x.scope_key)).toEqual(
          b.rows(t).map((x) => x.id ?? x.scope_key),
        );
    });

    it("carries org_id everywhere and never repeats an id", async () => {
      const r = await runFor(company);
      const seen = new Set<string>();
      for (const t of ASSET_TABLES)
        for (const row of r.rows(t)) {
          expect(row.org_id, t).toBe(r.ctx.orgId);
          if (row.id === undefined) continue;
          const id = String(row.id);
          expect(seen.has(id), `${t} ${id}`).toBe(false);
          seen.add(id);
        }
    });

    it("inserts every asset as a draft, whatever it later becomes", async () => {
      const r = await runFor(company);
      // The bulk insert cannot claim a later state: the state-machine trigger
      // rejects it, and the whole company's seed dies with the statement.
      for (const a of r.rows("asset")) {
        expect(a.status, String(a.asset_no)).toBe("draft");
        expect(a.retired_at).toBeNull();
        expect(a.disposed_at).toBeNull();
        expect(a.custodian_user_id).toBeNull();
      }
      // And the plan for where each one ends up is reachable from draft.
      for (const spec of r.model.assets) {
        let at: AssetStatus = "draft";
        for (const step of pathTo(spec.final)) {
          expect(LEGAL[at], `${spec.assetNo}: ${at} → ${step}`).toContain(step);
          at = step;
        }
      }
    });

    it("moves non-sample assets only through transitions the trigger allows", async () => {
      const r = await runFor(company);
      for (const [from, to, ids] of r.model.statusMoves) {
        expect(LEGAL[from], `${from} → ${to}`).toContain(to);
        expect(ids.length, `${from} → ${to} moves something`).toBeGreaterThan(0);
      }
      // Every non-sample asset's final state is represented by the moves.
      const moved = new Set(r.model.statusMoves.flatMap(([, , ids]) => ids));
      for (const a of r.model.assets)
        if (!a.sample && a.final !== "draft") expect(moved.has(a.id), a.assetNo).toBe(true);
    });

    it("shows a register with a spread of statuses and conditions", async () => {
      const r = await runFor(company);
      const finals = new Set(r.model.assets.map((a) => a.final));
      for (const s of ["in_service", "in_storage", "under_maintenance", "retired"])
        expect(finals, s).toContain(s);
      const conditions = new Set(r.rows("asset").map((a) => String(a.condition)));
      expect(conditions.size).toBeGreaterThanOrEqual(3);
      // Asset numbers are unique and follow one series.
      const nos = r.rows("asset").map((a) => String(a.asset_no));
      expect(new Set(nos).size).toBe(nos.length);
    });

    it("costs an asset consistently, or not at all", async () => {
      const r = await runFor(company);
      for (const a of r.rows("asset")) {
        const cost = a.acquisition_cost_minor;
        // Cost, currency, rate and base cost stand or fall together.
        expect((cost === null) === (a.currency === null), String(a.asset_no)).toBe(true);
        expect((cost === null) === (a.base_acquisition_cost_minor === null)).toBe(true);
        if (cost === null) continue;
        // A donation is acquired at no cost; nothing else is free.
        expect(num(cost)).toBeGreaterThanOrEqual(0);
        if (num(cost) === 0) expect(a.acquisition_source).toBe("donation");
        // A residual above cost would make the depreciable amount negative.
        if (a.residual_value_minor !== null)
          expect(num(a.residual_value_minor), String(a.asset_no)).toBeLessThanOrEqual(num(cost));
        if (a.useful_life_months !== null) expect(num(a.useful_life_months)).toBeGreaterThan(0);
        if (a.warranty_end_on !== null)
          expect(String(a.warranty_end_on) >= String(a.warranty_start_on)).toBe(true);
        expect(String(a.depreciation_start_on ?? a.acquired_on) >= String(a.acquired_on)).toBe(
          true,
        );
      }
    });

    it("adds a depreciation run up from its own lines", async () => {
      const r = await runFor(company);
      const runs = r.rows("asset_depreciation_run");
      const lines = r.rows("asset_depreciation_line");
      if (!runs.length) {
        expect(lines).toEqual([]);
        return;
      }
      const byRun = new Map<string, Row[]>();
      for (const l of lines) {
        const k = String(l.run_id);
        byRun.set(k, [...(byRun.get(k) ?? []), l]);
      }
      const byAsset = new Map(r.rows("asset").map((a) => [String(a.id), a]));
      for (const run of runs) {
        const own = byRun.get(String(run.id)) ?? [];
        expect(own.length, `run ${run.reference} has lines`).toBeGreaterThan(0);
        const sum = own.reduce((n, l) => n + num(l.amount_minor), 0);
        expect(num(run.total_minor), `run ${run.reference}`).toBe(sum);
        expect(String(run.period_end) >= String(run.period_start)).toBe(true);
        // One line per asset: a run that charges an asset twice double-counts.
        const ids = own.map((l) => String(l.asset_id));
        expect(new Set(ids).size).toBe(ids.length);
        for (const l of own) {
          const a = byAsset.get(String(l.asset_id));
          expect(a, "a line names an asset in the register").toBeDefined();
          expect(num(l.amount_minor), "a charge is never negative").toBeGreaterThanOrEqual(0);
          /*
           * The depreciable amount is the BASE cost less residual — the same
           * expression the product's own depreciation run uses
           * (coalesce(base_acquisition_cost_minor, acquisition_cost_minor)),
           * so a foreign-currency asset depreciates in the books' currency.
           */
          const cost =
            a!.base_acquisition_cost_minor !== null
              ? num(a!.base_acquisition_cost_minor)
              : a!.acquisition_cost_minor !== null
                ? num(a!.acquisition_cost_minor)
                : null;
          const residual = a!.residual_value_minor === null ? 0 : num(a!.residual_value_minor);
          if (cost === null) continue;
          expect(
            num(l.accumulated_after_minor),
            `${a!.asset_no} depreciated past base cost less residual`,
          ).toBeLessThanOrEqual(cost - residual);
          // And no single month charges more than the straight-line amount.
          const life = a!.useful_life_months === null ? null : num(a!.useful_life_months);
          if (life)
            expect(num(l.amount_minor), `${a!.asset_no} monthly charge`).toBeLessThanOrEqual(
              Math.floor((cost - residual) / life),
            );
        }
      }
    });

    it("pairs every disposal with the approval that decides it", async () => {
      const r = await runFor(company);
      const disposals = r.rows("asset_disposal");
      const approvals = r.rows("approval");
      if (!disposals.length) return;
      const assetIds = new Set(r.rows("asset").map((a) => String(a.id)));
      for (const d of disposals) {
        expect(assetIds.has(String(d.asset_id))).toBe(true);
        // Born submitted: the decision belongs to the approval, not the insert.
        expect(d.status).toBe(BORN_STATES.asset_disposal);
        expect(d.decided_by).toBeNull();
        expect(d.decided_at).toBeNull();
        expect(String(d.reference).length).toBeGreaterThan(0);
      }
      for (const a of approvals) {
        // The approval table carries its lifecycle in `state`, not `status`.
        expect(a.state).toBe(BORN_STATES.approval);
        expect(a.decided_at).toBeNull();
        expect(a.subject_type).toBe("asset_disposal");
      }
      // Every disposal has exactly one approval waiting on it.
      expect(approvals.length).toBe(disposals.length);
      const refs = disposals.map((d) => String(d.reference));
      expect(new Set(refs).size).toBe(refs.length);
    });

    it("keeps custody, inspection and maintenance rows attached to real assets", async () => {
      const r = await runFor(company);
      const assetIds = new Set(r.rows("asset").map((a) => String(a.id)));
      for (const t of [
        "asset_assignment",
        "asset_inspection",
        "asset_maintenance_plan",
        "asset_maintenance_event",
        "asset_downtime",
      ] as const)
        for (const row of r.rows(t)) expect(assetIds.has(String(row.asset_id)), t).toBe(true);

      // A maintenance event's plan belongs to the same asset.
      const plans = new Map(r.rows("asset_maintenance_plan").map((p) => [String(p.id), p]));
      for (const e of r.rows("asset_maintenance_event")) {
        if (e.plan_id === null) continue;
        const plan = plans.get(String(e.plan_id));
        expect(plan, String(e.id)).toBeDefined();
        expect(plan!.asset_id).toBe(e.asset_id);
      }
      // Downtime that has ended ended after it started.
      for (const d of r.rows("asset_downtime")) {
        if (d.ended_at === null) continue;
        expect(Date.parse(String(d.ended_at))).toBeGreaterThanOrEqual(
          Date.parse(String(d.started_at)),
        );
      }
      // An inspection's next due date is after the inspection itself.
      for (const i of r.rows("asset_inspection"))
        if (i.next_due_on !== null)
          expect(String(i.next_due_on) > String(i.inspected_on), String(i.id)).toBe(true);
    });

    it("orders custody events per asset and never leaves one without an actor", async () => {
      const r = await runFor(company);
      const byAsset = new Map<string, Row[]>();
      for (const a of r.rows("asset_assignment")) {
        const k = String(a.asset_id);
        byAsset.set(k, [...(byAsset.get(k) ?? []), a]);
      }
      for (const [assetId, events] of byAsset) {
        const sorted = events
          .slice()
          .sort((a, b) => Date.parse(String(a.effective_at)) - Date.parse(String(b.effective_at)));
        for (let i = 1; i < sorted.length; i++)
          expect(
            Date.parse(String(sorted[i]!.effective_at)),
            `${assetId} custody runs forwards`,
          ).toBeGreaterThanOrEqual(Date.parse(String(sorted[i - 1]!.effective_at)));
        for (const e of sorted) {
          expect(e.recorded_by, "someone recorded it").toBeTruthy();
          expect(String(e.event).length).toBeGreaterThan(0);
        }
      }
    });

    it("advances its reference sequences past the bulk", async () => {
      const r = await runFor(company);
      const seq = new Map(
        r.rows("reference_sequence").map((s) => [String(s.scope_key), num(s.next_value)]),
      );
      expect(seq.get("asset") ?? 0).toBeGreaterThan(r.rows("asset").length);
      for (const [, next] of seq) expect(next).toBeGreaterThan(0);
      for (const s of r.model.sequences)
        expect(seq.get(s.scope), s.scope).toBeGreaterThanOrEqual(s.next);
    });

    it("dates the register in the past", async () => {
      const r = await runFor(company);
      const limit = Date.parse(`${company.history.asOf}T23:59:59.999Z`);
      // Forward-looking by design: the next service due, a warranty that has
      // not run out, and depreciation that starts the month after acquisition.
      const futureOk = new Set(["next_due_on", "warranty_end_on", "depreciation_start_on"]);
      for (const t of ASSET_TABLES)
        for (const row of r.rows(t))
          for (const [k, v] of Object.entries(row)) {
            if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) continue;
            if (!/_(at|on)$/.test(k) || futureOk.has(k)) continue;
            expect(Date.parse(v), `${t}.${k} = ${v}`).toBeLessThanOrEqual(limit);
          }
    });

    it("hands on the ids later families need", async () => {
      const r = await runFor(company);
      const h = r.report.handoff as { assetIds: string[]; liveAssetIds?: string[] };
      expect(h.assetIds.length).toBe(company.profile.assets);
      expect(new Set(h.assetIds).size).toBe(h.assetIds.length);
    });
  });
}
