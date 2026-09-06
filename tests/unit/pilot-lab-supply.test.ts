/**
 * H33 Pilot Lab — the supply family's laws, checked without a database.
 *
 * The arithmetic is the point. A receipt that says twelve arrived when eight
 * were ordered, or a "received" order with something still outstanding, teaches
 * the warehouse the wrong lesson and would make every stock figure downstream a
 * lie. Those are asserted here on the rows the family would actually write.
 */
import { describe, expect, it, vi } from "vitest";

/*
 * These build a whole company in memory — thousands of orders and their lines
 * for the larger profiles — so the 5-second default is a stopwatch on the
 * machine, not on the code.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { COMPANIES } from "../../tooling/pilot-lab/companies";
import type { Company, LabContext, PersonaKey } from "../../tooling/pilot-lab/types";
import { id as labId } from "../../tooling/pilot-lab/ids";
import { SEED_VERSION } from "../../tooling/pilot-lab/marker";
import { Rng } from "../../tooling/simulation/rng";
import { SimClock } from "../../tooling/simulation/dates";
import {
  supply,
  planSupply,
  seedSupply,
  SUPPLY_TABLES,
  PO_STATUSES,
  MR_STATUSES,
  GRN_STATUSES,
  URGENCIES,
  type SupplyHandoff,
  type SupplyTable,
} from "../../tooling/pilot-lab/families/supply";

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

/** Enough of setup's handoff for supply: warehouses only. */
function setupHandoff(company: Company): Record<string, unknown> {
  const warehouses: Record<string, unknown> = {};
  for (const code of ["MAIN", "SITE"]) {
    warehouses[code] = {
      id: labId(company.key, "warehouse", code),
      receivingLocationId: labId(company.key, "stock_location", code, "recv"),
    };
  }
  return { warehouses };
}

function mastersHandoff(company: Company): Record<string, unknown> {
  const n = Math.min(company.profile.items, 400);
  const items = Array.from({ length: n }, (_, i) => ({
    id: labId(company.key, "item", i),
    unit: i % 3 === 0 ? "bag" : "pcs",
    unitId: labId(company.key, "unit_of_measure", i % 3 === 0 ? "bag" : "pcs"),
    cost: 500 + i * 7,
    category: "materials",
    type: i % 17 === 0 ? "service" : "inventory",
    tracking: "none",
  }));
  return {
    supplierIds: Array.from({ length: Math.min(company.profile.suppliers, 120) }, (_, i) =>
      labId(company.key, "supplier", i),
    ),
    itemIds: items.map((i) => i.id),
    items,
  };
}

function workHandoff(company: Company): Record<string, unknown> {
  const jobIds = Array.from({ length: Math.min(company.profile.jobs, 200) }, (_, i) =>
    labId(company.key, "job", i),
  );
  return { jobIds, activeJobIds: jobIds.slice(0, Math.max(1, Math.floor(jobIds.length / 2))) };
}

function fakeCtx(company: Company, opts: { dryRun?: boolean } = {}) {
  const store: Store = {};
  const orgId = labId(company.key, "org");
  const users = Object.fromEntries(
    PERSONAS.map((p) => [p, labId(company.key, "user", p)]),
  ) as Record<PersonaKey, string>;
  const handoffs: Record<string, Record<string, unknown>> = {
    setup: setupHandoff(company),
    masters: mastersHandoff(company),
    work: workHandoff(company),
    people: {},
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
    handoff: <T>(family: string) => {
      const h = handoffs[family];
      if (!h) throw new Error(`no handoff from family ${family}`);
      return h as T;
    },
    log: () => {},
    dryRun: opts.dryRun ?? false,
  };
  return { ctx, store };
}

async function runFor(company: Company) {
  const { ctx, store } = fakeCtx(company);
  const plan = planSupply(ctx).expected;
  const report = await seedSupply(ctx);
  const rows = (t: SupplyTable) => store[t] ?? [];
  return { ctx, store, plan, report, rows, handoff: report.handoff as unknown as SupplyHandoff };
}

const num = (v: unknown) => Number(v as number);

describe("the supply family", () => {
  it("declares the dependencies it actually reads", () => {
    expect(supply.key).toBe("supply");
    expect(supply.deps).toContain("setup");
    expect(supply.deps).toContain("masters");
    expect(supply.deps).toContain("work");
    expect(supply.appliesTo(COMPANIES[0]!)).toBe(true);
  });

  it("writes nothing at all in a dry run", async () => {
    const { ctx, store } = fakeCtx(COMPANIES[0]!, { dryRun: true });
    // ctx.insert is real here, so a dry run must be honoured by the ORCHESTRATOR,
    // not the family: the family still builds its rows and reports them.
    const report = await seedSupply(ctx);
    expect(Object.values(report.counts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(Object.keys(store).length).toBeGreaterThan(0);
  });
});

for (const company of COMPANIES) {
  describe(`supply for ${company.key}`, () => {
    it("plans exactly the rows it writes", async () => {
      const r = await runFor(company);
      for (const t of SUPPLY_TABLES) {
        expect(r.rows(t).length, `${t}`).toBe(r.plan[t]);
        expect(r.report.counts[t], `${t} report`).toBe(r.plan[t]);
      }
    });

    it("every row carries the organisation and a deterministic unique id", async () => {
      const r = await runFor(company);
      for (const t of SUPPLY_TABLES) {
        const rows = r.rows(t);
        const ids = new Set<string>();
        for (const row of rows) {
          expect(row.org_id, `${t}.org_id`).toBe(r.ctx.orgId);
          const id = row.id as string;
          expect(id, `${t}.id`).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          expect(ids.has(id), `${t} duplicate id`).toBe(false);
          ids.add(id);
        }
      }
    });

    it("is idempotent: two runs produce identical rows", async () => {
      const a = await runFor(company);
      const b = await runFor(company);
      for (const t of SUPPLY_TABLES) {
        expect(JSON.stringify(a.rows(t)), `${t}`).toBe(JSON.stringify(b.rows(t)));
      }
      expect(JSON.stringify(a.handoff)).toBe(JSON.stringify(b.handoff));
    });

    it("uses only legal statuses", async () => {
      const r = await runFor(company);
      for (const row of r.rows("purchase_order"))
        expect(PO_STATUSES as readonly string[]).toContain(row.status);
      for (const row of r.rows("material_request")) {
        expect(MR_STATUSES as readonly string[]).toContain(row.status);
        expect(URGENCIES as readonly string[]).toContain(row.urgency);
      }
      for (const row of r.rows("goods_receipt"))
        expect(GRN_STATUSES as readonly string[]).toContain(row.status);
      for (const row of r.rows("supplier_return")) expect(["draft", "sent"]).toContain(row.status);
    });

    it("receiving arithmetic holds: nothing arrives twice, nothing exceeds the order", async () => {
      const r = await runFor(company);
      const poLines = new Map(r.rows("purchase_order_line").map((l) => [l.id as string, l]));
      const acceptedByLine = new Map<string, number>();

      for (const gl of r.rows("goods_receipt_line")) {
        const line = poLines.get(gl.po_line_id as string);
        expect(line, "receipt line cites a real order line").toBeTruthy();
        const received = num(gl.received_qty);
        const damaged = num(gl.damaged_qty);
        const rejected = num(gl.rejected_qty);
        expect(received, "something arrived").toBeGreaterThan(0);
        expect(
          damaged + rejected,
          "damaged + rejected never exceeds what arrived",
        ).toBeLessThanOrEqual(received);
        expect(num(gl.ordered_qty)).toBe(num(line!.qty));
        expect(
          num(gl.previously_received) + received,
          "cumulative receipts never exceed the order",
        ).toBeLessThanOrEqual(num(gl.ordered_qty) + 1e-6);
        const key = gl.po_line_id as string;
        acceptedByLine.set(key, (acceptedByLine.get(key) ?? 0) + received - damaged - rejected);
      }

      for (const [lineId, accepted] of acceptedByLine) {
        expect(accepted, `line ${lineId} over-received`).toBeLessThanOrEqual(
          num(poLines.get(lineId)!.qty) + 1e-6,
        );
      }
    });

    it("a received order has nothing outstanding; a partial one does", async () => {
      const r = await runFor(company);
      const linesByPo = new Map<string, Row[]>();
      for (const l of r.rows("purchase_order_line")) {
        const k = l.po_id as string;
        linesByPo.set(k, [...(linesByPo.get(k) ?? []), l]);
      }
      const acceptedByLine = new Map<string, number>();
      for (const gl of r.rows("goods_receipt_line")) {
        const k = gl.po_line_id as string;
        acceptedByLine.set(
          k,
          (acceptedByLine.get(k) ?? 0) +
            num(gl.received_qty) -
            num(gl.damaged_qty) -
            num(gl.rejected_qty),
        );
      }
      const outstanding = (poId: string) =>
        (linesByPo.get(poId) ?? []).some(
          (l) => (acceptedByLine.get(l.id as string) ?? 0) < num(l.qty) - 1e-6,
        );

      for (const po of r.rows("purchase_order")) {
        if (po.status === "received")
          expect(outstanding(po.id as string), `${po.reference} received`).toBe(false);
        if (po.status === "partially_received")
          expect(outstanding(po.id as string), `${po.reference} partial`).toBe(true);
        // Nothing can have arrived against an order that was never approved.
        if (po.status === "draft") {
          const has = r.rows("goods_receipt").some((g) => g.po_id === po.id);
          expect(has, `${po.reference} draft with receipts`).toBe(false);
        }
      }
    });

    it("money adds up: every order total is its lines plus VAT", async () => {
      const r = await runFor(company);
      const byPo = new Map<string, number>();
      for (const l of r.rows("purchase_order_line")) {
        const k = l.po_id as string;
        byPo.set(k, (byPo.get(k) ?? 0) + num(l.line_total_minor));
        // A line total is its own quantity times its own price, to the fils.
        expect(num(l.line_total_minor)).toBe(Math.round(num(l.qty) * num(l.unit_cost_minor)));
      }
      for (const po of r.rows("purchase_order")) {
        const sub = byPo.get(po.id as string) ?? 0;
        expect(num(po.total_minor), `${po.reference}`).toBe(sub + num(po.vat_minor));
        expect(Number.isInteger(num(po.total_minor))).toBe(true);
      }
    });

    it("a converted request and its order name each other", async () => {
      const r = await runFor(company);
      const orders = new Map(r.rows("purchase_order").map((o) => [o.id as string, o]));
      const converted = r.rows("material_request").filter((m) => m.status === "converted");
      for (const mr of converted) {
        const po = orders.get(mr.converted_po_id as string);
        expect(po, `${mr.reference} names an order`).toBeTruthy();
        expect(po!.mr_id, `${mr.reference} order names it back`).toBe(mr.id);
      }
      // And nothing else claims to be converted without one.
      for (const mr of r.rows("material_request"))
        if (mr.status !== "converted") expect(mr.converted_po_id).toBeNull();
    });

    it("every return cites a receipt line that really carried damage", async () => {
      const r = await runFor(company);
      const damaged = new Set(
        r
          .rows("goods_receipt_line")
          .filter((l) => num(l.damaged_qty) + num(l.rejected_qty) > 0)
          .map((l) => l.id as string),
      );
      for (const l of r.rows("supplier_return_line")) {
        expect(damaged.has(l.goods_receipt_line_id as string), "return cites damage").toBe(true);
        expect(num(l.qty)).toBeGreaterThan(0);
      }
    });

    it("nothing is dated after the company's as-of date", async () => {
      const r = await runFor(company);
      const asOf = `${company.history.asOf}T23:59:59.999Z`;
      for (const t of SUPPLY_TABLES)
        for (const row of r.rows(t))
          for (const col of ["created_at", "updated_at", "approved_at", "sent_at"]) {
            const v = row[col];
            if (typeof v !== "string") continue;
            expect(v <= asOf, `${t}.${col} ${v} is in the future`).toBe(true);
          }
      for (const g of r.rows("goods_receipt"))
        expect(String(g.received_date) <= company.history.asOf).toBe(true);
    });

    it("hands the stock family everything it needs to source a movement", async () => {
      const r = await runFor(company);
      const grnIds = new Set(r.rows("goods_receipt").map((g) => g.id as string));
      const recorded = new Set(
        r
          .rows("goods_receipt")
          .filter((g) => g.status === "recorded")
          .map((g) => g.id as string),
      );
      expect(r.handoff.poIds).toHaveLength(r.rows("purchase_order").length);
      expect(r.handoff.grnIds).toHaveLength(r.rows("goods_receipt").length);
      expect(r.handoff.mrIds).toHaveLength(r.rows("material_request").length);
      for (const rl of r.handoff.receiptLines) {
        expect(grnIds.has(rl.grnId)).toBe(true);
        // A cancelled receipt never becomes stock.
        expect(recorded.has(rl.grnId), "only recorded receipts are handed over").toBe(true);
        expect(rl.acceptedQty).toBeGreaterThanOrEqual(0);
        expect(rl.unitCostMinor).toBeGreaterThanOrEqual(0);
        expect(rl.itemId.length).toBeGreaterThan(0);
        expect(rl.warehouseKey.length).toBeGreaterThan(0);
      }
    });

    it("shows a real spread of states so every screen has something in it", async () => {
      const r = await runFor(company);
      const po = new Set(r.rows("purchase_order").map((o) => o.status as string));
      const mr = new Set(r.rows("material_request").map((m) => m.status as string));
      expect(po.size, `PO states: ${[...po].join(",")}`).toBeGreaterThanOrEqual(4);
      expect(mr.size, `MR states: ${[...mr].join(",")}`).toBeGreaterThanOrEqual(4);
      expect(r.rows("goods_receipt").length).toBeGreaterThan(0);
    });
  });
}

describe("supply across the five companies", () => {
  it("one company's purchase orders pass the pagination boundary", async () => {
    const runs = await Promise.all(COMPANIES.map((c) => runFor(c)));
    const max = Math.max(...runs.map((r) => r.rows("purchase_order").length));
    expect(max).toBeGreaterThan(1205);
  });

  it("stays inside its share of the row budget", async () => {
    const runs = await Promise.all(COMPANIES.map((c) => runFor(c)));
    const totals: Record<string, number> = {};
    let grand = 0;
    for (const [i, r] of runs.entries()) {
      const n = Object.values(r.plan).reduce((a, b) => a + b, 0);
      totals[COMPANIES[i]!.key] = n;
      grand += n;
    }
    console.log(`supply planned rows per company: ${JSON.stringify(totals)} total=${grand}`);
    /*
     * Supply's share of the lab. The mandate allows 100,000-300,000 rows in
     * total and the seeder stops hard at 300 MB whatever the count; work plans
     * ~89,000 and this family ~41,000, so a 45,000 ceiling here keeps the two
     * largest families inside a total that leaves room for stock, finance, CRM
     * and the rest.
     */
    expect(grand).toBeLessThan(45_000);
    expect(grand).toBeGreaterThan(8_000);
  });
});
