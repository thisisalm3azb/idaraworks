/**
 * H33 Pilot Lab — the stock ledger's laws, checked without a database.
 *
 * Everything downstream of stock — the value on the balance sheet, the cost of
 * a job, the reorder screen — is a function of the movements. So the movements
 * and the balances are asserted against each other directly: if a balance ever
 * disagrees with the sum of its own movements, every figure built on it is
 * wrong and no other test would notice.
 */
import { describe, expect, it, vi } from "vitest";
import { H33_BRAND } from "../../tooling/pilot-lab/brand";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { COMPANIES } from "../../tooling/pilot-lab/companies";
import type { Company, LabContext, PersonaKey } from "../../tooling/pilot-lab/types";
import { id as labId } from "../../tooling/pilot-lab/ids";
import { SEED_VERSION } from "../../tooling/pilot-lab/marker";
import { Rng } from "../../tooling/simulation/rng";
import { SimClock } from "../../tooling/simulation/dates";
import {
  stock,
  planStock,
  seedStock,
  STOCK_TABLES,
  MOVEMENT_TYPES,
  type StockHandoff,
  type StockTable,
} from "../../tooling/pilot-lab/families/stock";

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

const WH = ["MAIN", "SITE"];

function setupHandoff(company: Company): Record<string, unknown> {
  const warehouses: Record<string, unknown> = {};
  for (const code of WH) {
    warehouses[code] = {
      id: labId(company.key, "warehouse", code),
      receivingLocationId: labId(company.key, "stock_location", code, "recv"),
      issueLocationId: labId(company.key, "stock_location", code, "issue"),
      locations: { recv: labId(company.key, "stock_location", code, "recv") },
    };
  }
  return { warehouses, units: {} };
}

function items(company: Company) {
  const n = Math.min(company.profile.items, 120);
  return Array.from({ length: n }, (_, i) => ({
    id: labId(company.key, "item", i),
    unit: "pcs",
    unitId: labId(company.key, "unit_of_measure", "pcs"),
    cost: 400 + i * 11,
    category: "materials",
    type: "inventory",
    tracking: i % 20 === 0 ? "serial" : "none",
  }));
}

/** A receipt stream shaped like the supply family's real handoff. */
function supplyHandoff(company: Company): Record<string, unknown> {
  const its = items(company);
  /*
   * Sized to what the supply family really hands over, not to a round number:
   * tradeline raises 1,400 orders, roughly seventy per cent of which are
   * received across about three lines each. Understating it here would let the
   * pagination assertion below pass on a ledger far smaller than the real one.
   */
  const n = Math.min(3000, Math.max(80, Math.round(company.profile.stockMovementsTarget / 6)));
  const receiptLines = Array.from({ length: n }, (_, i) => {
    const item = its[i % its.length]!;
    return {
      grnLineId: labId(company.key, "grn_line", i),
      grnId: labId(company.key, "goods_receipt", Math.floor(i / 3)),
      itemId: item.id,
      unit: item.unit,
      unitCostMinor: item.cost,
      acceptedQty: 5 + (i % 20),
      damagedQty: i % 11 === 0 ? 1 : 0,
      receivedDate: "2025-06-01",
      dayAgo: 100 + (i % 300),
      warehouseKey: WH[i % WH.length]!,
    };
  });
  return { receiptLines };
}

function mastersHandoff(company: Company): Record<string, unknown> {
  const its = items(company);
  return {
    // Keyed by item id, exactly as the masters family hands it over. A list
    // here would hide the shape mismatch a whole-chain dry run caught.
    items: Object.fromEntries(its.map(({ id, ...rest }) => [id, rest])),
    lowStockCandidateItemIds: its.slice(0, 3).map((i) => i.id),
    zeroStockItemIds: its.slice(3, 6).map((i) => i.id),
  };
}

function workHandoff(company: Company): Record<string, unknown> {
  const its = items(company);
  const lines = Array.from({ length: Math.min(200, its.length * 2) }, (_, i) => {
    const item = its[i % its.length]!;
    return [
      labId(company.key, "report_material_line", i),
      labId(company.key, "daily_report", i),
      labId(company.key, "job", i),
      item.id,
      2,
      "pcs",
      "2025-09-01",
    ] as [string, string, string, string, number, string, string];
  });
  return { deductedMaterialLines: lines };
}

function fakeCtx(company: Company) {
  const store: Store = {};
  const orgId = labId(company.key, "org");
  const users = Object.fromEntries(
    PERSONAS.map((p) => [p, labId(company.key, "user", p)]),
  ) as Record<PersonaKey, string>;
  const handoffs: Record<string, Record<string, unknown>> = {
    setup: setupHandoff(company),
    masters: mastersHandoff(company),
    supply: supplyHandoff(company),
    work: workHandoff(company),
  };
  const noDb = () => {
    throw new Error("the unit test has no database");
  };
  const ctx: LabContext = {
    brand: H33_BRAND,
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
  const plan = planStock(ctx).expected;
  const report = await seedStock(ctx);
  const rows = (t: StockTable) => store[t] ?? [];
  return { ctx, plan, report, rows, handoff: report.handoff as unknown as StockHandoff };
}

const num = (v: unknown) => Number(v as number);
const stocked = COMPANIES.filter((c) => stock.appliesTo(c));

describe("the stock family", () => {
  it("applies only where the company keeps stock", () => {
    expect(stock.key).toBe("stock");
    expect(stock.deps).toEqual(expect.arrayContaining(["setup", "masters", "work", "supply"]));
    for (const c of COMPANIES) expect(stock.appliesTo(c)).toBe(c.profile.enables.stock);
  });
});

for (const company of stocked) {
  describe(`stock for ${company.key}`, () => {
    it("plans exactly the rows it writes", async () => {
      const r = await runFor(company);
      for (const t of STOCK_TABLES) expect(r.rows(t).length, t).toBe(r.plan[t]);
    });

    it("every row carries the organisation", async () => {
      const r = await runFor(company);
      for (const t of STOCK_TABLES)
        for (const row of r.rows(t)) expect(row.org_id, t).toBe(r.ctx.orgId);
    });

    it("is idempotent: two runs produce identical rows", async () => {
      const a = await runFor(company);
      const b = await runFor(company);
      for (const t of STOCK_TABLES)
        expect(JSON.stringify(a.rows(t)), t).toBe(JSON.stringify(b.rows(t)));
    });

    it("EVERY balance equals the sum of its own movements", async () => {
      const r = await runFor(company);
      const summed = new Map<string, number>();
      const reserved = new Map<string, number>();
      for (const m of r.rows("stock_movement")) {
        const k = `${m.item_id}|${m.warehouse_id}|${m.location_id}`;
        summed.set(k, (summed.get(k) ?? 0) + num(m.qty_delta));
        reserved.set(k, (reserved.get(k) ?? 0) + num(m.reserved_delta));
      }
      expect(r.rows("stock_balance").length).toBeGreaterThan(0);
      for (const b of r.rows("stock_balance")) {
        const k = `${b.item_id}|${b.warehouse_id}|${b.location_id}`;
        expect(num(b.on_hand), `on_hand for ${k}`).toBeCloseTo(summed.get(k) ?? 0, 6);
        expect(num(b.reserved), `reserved for ${k}`).toBeCloseTo(reserved.get(k) ?? 0, 6);
      }
      // And no balance exists that no movement produced.
      expect(r.rows("stock_balance").length).toBe(summed.size);
    });

    it("no warehouse holds a negative quantity", async () => {
      const r = await runFor(company);
      for (const b of r.rows("stock_balance")) {
        expect(num(b.on_hand), `${b.item_id}`).toBeGreaterThanOrEqual(0);
        expect(num(b.reserved), `${b.item_id} reserved`).toBeGreaterThanOrEqual(0);
      }
    });

    it("cost layers reconcile: remaining equals received minus consumed", async () => {
      const r = await runFor(company);
      const consumed = new Map<string, number>();
      for (const c of r.rows("stock_layer_consumption")) {
        const k = c.layer_id as string;
        consumed.set(k, (consumed.get(k) ?? 0) + num(c.qty));
        expect(num(c.qty), "a consumption is positive").toBeGreaterThan(0);
      }
      expect(r.rows("stock_cost_layer").length).toBeGreaterThan(0);
      for (const l of r.rows("stock_cost_layer")) {
        const used = consumed.get(l.id as string) ?? 0;
        expect(num(l.qty_remaining), `layer ${l.id}`).toBeCloseTo(num(l.qty_received) - used, 6);
        expect(num(l.qty_remaining)).toBeGreaterThanOrEqual(-1e-9);
        expect(used, "never consumed past what it received").toBeLessThanOrEqual(
          num(l.qty_received) + 1e-9,
        );
      }
    });

    it("every consumption cites a movement that exists", async () => {
      const r = await runFor(company);
      const ids = new Set(r.rows("stock_movement").map((m) => m.id as string));
      for (const c of r.rows("stock_layer_consumption"))
        expect(ids.has(c.movement_id as string), `${c.movement_id}`).toBe(true);
      for (const l of r.rows("stock_cost_layer"))
        expect(ids.has(l.source_movement_id as string), `${l.source_movement_id}`).toBe(true);
    });

    it("every movement is a legal type citing a source that exists", async () => {
      const r = await runFor(company);
      const grnLines = new Set(
        (supplyHandoff(company).receiptLines as Array<{ grnLineId: string }>).map(
          (l) => l.grnLineId,
        ),
      );
      const transfers = new Set(r.rows("stock_transfer").map((t) => t.id as string));
      const countLines = new Set(r.rows("stock_count_line").map((l) => l.id as string));
      const reportLines = new Set(
        (workHandoff(company).deductedMaterialLines as Array<string[]>).map((l) => l[0]!),
      );

      expect(r.rows("stock_movement").length).toBeGreaterThan(0);
      for (const m of r.rows("stock_movement")) {
        expect(MOVEMENT_TYPES as readonly string[]).toContain(m.movement_type);
        const st = m.source_type as string;
        expect([
          "goods_receipt_line",
          "report_material_line",
          "stock_transfer",
          "stock_count_line",
          "manual",
        ]).toContain(st);
        if (st === "manual") continue;
        const id = m.source_id as string;
        expect(id, `${st} needs a source id`).toBeTruthy();
        if (st === "goods_receipt_line") expect(grnLines.has(id), id).toBe(true);
        if (st === "stock_transfer") expect(transfers.has(id), id).toBe(true);
        if (st === "stock_count_line") expect(countLines.has(id), id).toBe(true);
        if (st === "report_material_line") expect(reportLines.has(id), id).toBe(true);
      }
    });

    it("a receipt movement carries the idempotency key that stops it posting twice", async () => {
      const r = await runFor(company);
      const receipts = r
        .rows("stock_movement")
        .filter((m) => m.source_type === "goods_receipt_line");
      expect(receipts.length).toBeGreaterThan(0);
      const keys = new Set<string>();
      for (const m of receipts) {
        const k = m.idempotency_key as string;
        expect(k, "receipt movements are keyed").toBeTruthy();
        expect(keys.has(k), `duplicate key ${k}`).toBe(false);
        keys.add(k);
      }
    });

    it("transfers move stock out of one warehouse and into another, in pairs", async () => {
      const r = await runFor(company);
      const out = r.rows("stock_movement").filter((m) => m.movement_type === "transfer_out");
      const into = r.rows("stock_movement").filter((m) => m.movement_type === "transfer_in");
      expect(out.length).toBe(into.length);
      for (const t of r.rows("stock_transfer")) {
        const o = out.filter((m) => m.source_id === t.id);
        const i = into.filter((m) => m.source_id === t.id);
        expect(o.length, `${t.reference} out`).toBe(1);
        expect(i.length, `${t.reference} in`).toBe(1);
        expect(num(o[0]!.qty_delta)).toBe(-num(i[0]!.qty_delta));
        expect(o[0]!.warehouse_id).not.toBe(i[0]!.warehouse_id);
      }
    });

    it("a reservation promises stock without moving any", async () => {
      const r = await runFor(company);
      for (const m of r.rows("stock_movement")) {
        if (m.movement_type === "reservation" || m.movement_type === "reservation_release") {
          expect(num(m.qty_delta), "a reservation moves nothing physically").toBe(0);
          expect(num(m.reserved_delta)).not.toBe(0);
        }
      }
    });

    it("lot balances agree with the lot movements", async () => {
      const r = await runFor(company);
      const byLot = new Map<string, number>();
      for (const ml of r.rows("stock_movement_lot")) {
        const k = ml.lot_id as string;
        // The link table calls it `qty`; the movement calls it `qty_delta`.
        byLot.set(k, (byLot.get(k) ?? 0) + num(ml.qty));
      }
      for (const b of r.rows("stock_lot_balance")) {
        expect(num(b.on_hand), `lot ${b.lot_id}`).toBeCloseTo(
          byLot.get(b.lot_id as string) ?? 0,
          6,
        );
        expect(num(b.on_hand)).toBeGreaterThanOrEqual(0);
      }
    });

    it("nothing is dated after the company's as-of date", async () => {
      const r = await runFor(company);
      const asOf = `${company.history.asOf}T23:59:59.999Z`;
      for (const m of r.rows("stock_movement")) {
        expect(String(m.effective_at) <= asOf, `effective_at ${m.effective_at}`).toBe(true);
        expect(String(m.recorded_at) <= asOf, `recorded_at ${m.recorded_at}`).toBe(true);
        /*
         * created_at is NOT asserted, and is not written: the row really was
         * created now, whatever date the stock moved on, and the tracking
         * triggers refuse to attach units to a movement whose row predates the
         * transaction. The business dates above are the ones that must stay in
         * the past.
         */
        expect(m.created_at, "created_at is left to the database").toBeUndefined();
      }
    });

    it("the shelves show what an owner would open the screen for", async () => {
      const r = await runFor(company);
      expect(r.handoff.movementCount).toBe(r.rows("stock_movement").length);
      expect(r.handoff.closingValueMinor).toBeGreaterThan(0);
      // Zero-stock or low-stock items exist, and every id named is real.
      const balanced = new Set(r.rows("stock_balance").map((b) => b.item_id as string));
      for (const id of [...r.handoff.lowStockItemIds, ...r.handoff.zeroStockItemIds])
        expect(balanced.has(id), id).toBe(true);
      const lots = new Set(r.rows("stock_lot").map((l) => l.id as string));
      for (const id of r.handoff.expiringLotIds) expect(lots.has(id), id).toBe(true);
    });

    it("the closing value equals what the layers still hold", async () => {
      const r = await runFor(company);
      const value = r
        .rows("stock_cost_layer")
        .reduce((n, l) => n + num(l.qty_remaining) * num(l.unit_cost_minor), 0);
      expect(r.handoff.closingValueMinor).toBeCloseTo(value, 6);
    });
  });
}

describe("stock across the companies that keep it", () => {
  it("one company's movement ledger passes the pagination boundary", async () => {
    const runs = await Promise.all(stocked.map((c) => runFor(c)));
    const max = Math.max(...runs.map((r) => r.rows("stock_movement").length));
    expect(max).toBeGreaterThan(1205);
  });

  it("stays inside its share of the row budget", async () => {
    const runs = await Promise.all(stocked.map((c) => runFor(c)));
    const totals: Record<string, number> = {};
    let grand = 0;
    for (const [i, r] of runs.entries()) {
      const n = Object.values(r.plan).reduce((a, b) => a + b, 0);
      totals[stocked[i]!.key] = n;
      grand += n;
    }
    console.log(`stock planned rows per company: ${JSON.stringify(totals)} total=${grand}`);
    expect(grand).toBeLessThan(45_000);
  });
});
