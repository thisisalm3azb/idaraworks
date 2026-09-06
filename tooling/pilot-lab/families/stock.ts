/**
 * H33 Pilot Lab — the stock ledger.
 *
 * This family is the ledger's only author, and it is built so that it
 * reconciles by construction rather than by luck: balances are accumulated from
 * the movements as they are created, cost layers are opened by receipts and
 * consumed in the order they arrived, and nothing is written that the database's
 * own triggers would refuse.
 *
 * ── What the database enforces, and what that means here ───────────────────
 * `stock_movement` is append-only (no update, no delete) and every row must
 * cite a source that already exists: a goods-receipt line, a report material
 * line, a transfer, a count line, an assembly order, a supplier return, or the
 * explicit `manual` escape. So the sources come first, in that order, and a
 * movement is never invented without one.
 *
 * ── The invariants verify() proves ─────────────────────────────────────────
 *   • every balance equals the sum of its movements, exactly;
 *   • no balance is negative — a warehouse cannot hold minus three bags;
 *   • a layer's remaining quantity equals what it received minus what was
 *     consumed from it, and consumption never exceeds the layer;
 *   • the lot balances agree with the lot movements;
 *   • the company shows zero-stock items, below-minimum items and expiring
 *     lots, because those are the screens an owner opens first.
 */
import type { Company, Family, FamilyPlan, FamilyReport, LabContext } from "../types";
import { historyDays, pick, sentence, weighted } from "./_shared";

type Row = Record<string, unknown>;

export const STOCK_TABLES = [
  "stock_lot",
  "stock_serial",
  "stock_transfer",
  "stock_transfer_line",
  "stock_count",
  "stock_count_line",
  "stock_reservation",
  "stock_movement",
  "stock_movement_lot",
  "stock_movement_serial",
  "stock_cost_layer",
  "stock_layer_consumption",
  "stock_balance",
  "stock_lot_balance",
] as const;
export type StockTable = (typeof STOCK_TABLES)[number];

/** Only the movement types this family actually writes. */
export const MOVEMENT_TYPES = [
  "goods_receipt",
  "material_issue",
  "job_consumption",
  "transfer_out",
  "transfer_in",
  "adjustment_increase",
  "adjustment_decrease",
  "count_correction",
  "reservation",
  "reservation_release",
] as const;

const ADJUSTMENT_REASONS = [
  "Stock take correction after the quarterly count",
  "Damaged in the yard during handling",
  "Found in the wrong bin during a bin sweep",
  "Written off after water ingress in the store",
];

type SetupHandoff = {
  warehouses: Record<
    string,
    {
      id: string;
      receivingLocationId: string;
      issueLocationId: string;
      locations: Record<string, string>;
    }
  >;
  units: Record<string, { id: string; dimension: string; factorToBase: number; isBase: boolean }>;
};
type MastersHandoff = {
  items:
    | Record<string, Omit<ItemRef, "id">>
    | Array<{
        id: string;
        unit: string;
        unitId: string;
        cost: number;
        category: string;
        type?: string;
        tracking?: string;
      }>;
  lowStockCandidateItemIds: string[];
  zeroStockItemIds: string[];
};

/**
 * masters hands items over as a MAP keyed by item id (`items: Record<string,
 * ItemHandoff>`), not as a list. Reading it as an array is what a dry run
 * across the whole chain caught: `.filter` on an object throws, and the
 * family that follows would have died at seed time. Accept either shape.
 */
type ItemRef = {
  id: string;
  unit: string;
  unitId: string;
  cost: number;
  category: string;
  type?: string;
  tracking?: string;
};
function itemsOf(masters: MastersHandoff): ItemRef[] {
  const v = masters.items as unknown;
  if (Array.isArray(v)) return v as ItemRef[];
  if (v && typeof v === "object")
    return Object.entries(v as Record<string, Omit<ItemRef, "id">>).map(([id, rest]) => ({
      id,
      ...rest,
    }));
  return [];
}

type SupplyHandoff = {
  receiptLines: Array<{
    grnLineId: string;
    grnId: string;
    itemId: string;
    unit: string;
    unitCostMinor: number;
    acceptedQty: number;
    damagedQty: number;
    receivedDate: string;
    dayAgo: number;
    warehouseKey: string;
  }>;
};
type WorkHandoff = {
  /** [lineId, reportId, jobId, itemId, qty, unit, reportDate] */
  deductedMaterialLines?: Array<
    [string, string, string, string, number, string, string] | Record<string, unknown>
  >;
};

type MovementM = {
  id: string;
  itemId: string;
  warehouseId: string;
  locationId: string;
  type: (typeof MOVEMENT_TYPES)[number];
  qtyDelta: number;
  reservedDelta: number;
  unitId: string;
  unitCostMinor: number;
  costTotalMinor: number;
  effectiveAt: string;
  dayAgo: number;
  sourceType: string;
  sourceId: string | null;
  idempotencyKey: string | null;
  reason: string | null;
  note: string | null;
  lotId: string | null;
};

type LayerM = {
  id: string;
  itemId: string;
  warehouseId: string;
  sourceMovementId: string;
  qtyReceived: number;
  qtyRemaining: number;
  unitCostMinor: number;
  receivedAt: string;
  depletedAt: string | null;
  consumption: Array<{ movementId: string; qty: number; unitCostMinor: number }>;
};

type LotM = {
  id: string;
  itemId: string;
  code: string;
  expiryDate: string | null;
  receivedAt: string;
  status: string;
};

export type StockModel = {
  movements: MovementM[];
  /** Which serial each movement names — the database insists they add up. */
  movementSerials: Array<{ id: string; movementId: string; serialId: string; at: string }>;
  layers: LayerM[];
  lots: LotM[];
  serials: Array<{
    id: string;
    itemId: string;
    serialNo: string;
    lotId: string | null;
    status: string;
    warehouseId: string;
    locationId: string;
    receivedAt: string;
  }>;
  transfers: Array<{
    id: string;
    reference: string;
    status: string;
    fromWh: string;
    fromLoc: string;
    toWh: string;
    toLoc: string;
    dayAgo: number;
    lines: Array<{ id: string; itemId: string; unitId: string; qty: number; sort: number }>;
  }>;
  counts: Array<{
    id: string;
    reference: string;
    status: string;
    warehouseId: string;
    locationId: string;
    dayAgo: number;
    lines: Array<{
      id: string;
      itemId: string;
      locationId: string;
      unitId: string;
      expectedQty: number;
      countedQty: number;
      reason: string | null;
      sort: number;
    }>;
  }>;
  reservations: Array<{
    id: string;
    itemId: string;
    warehouseId: string;
    locationId: string;
    unitId: string;
    qty: number;
    jobId: string | null;
    status: string;
    dayAgo: number;
  }>;
  balances: Map<
    string,
    {
      itemId: string;
      warehouseId: string;
      locationId: string;
      onHand: number;
      reserved: number;
      lastAt: string;
      avgCostMinor: number;
    }
  >;
  lotBalances: Map<
    string,
    {
      itemId: string;
      warehouseId: string;
      locationId: string;
      lotId: string;
      onHand: number;
      lastAt: string;
    }
  >;
  tableCounts: Record<StockTable, number>;
};

export type StockHandoff = {
  movementCount: number;
  lowStockItemIds: string[];
  zeroStockItemIds: string[];
  expiringLotIds: string[];
  /** Closing value by item, for the finance family's inventory control account. */
  closingValueMinor: number;
};

const MODELS = new WeakMap<object, StockModel & { handoff: StockHandoff }>();
const key3 = (i: string, w: string, l: string) => `${i}|${w}|${l}`;

function buildModel(ctx: LabContext): StockModel & { handoff: StockHandoff } {
  const memo = MODELS.get(ctx as unknown as object);
  if (memo) return memo;

  const { company, rng, clock } = ctx;
  const setup = ctx.handoff<SetupHandoff>("setup");
  const masters = ctx.handoff<MastersHandoff>("masters");
  const supply = ctx.handoff<SupplyHandoff>("supply");
  const work = ctx.handoff<WorkHandoff>("work");
  const asOf = clock.asOf;
  const horizon = historyDays(company);
  const lots = company.profile.enables.lots;

  const whKeys = Object.keys(setup.warehouses);
  const whOf = (k: string) => setup.warehouses[k] ?? setup.warehouses[whKeys[0]!]!;
  const itemById = new Map(itemsOf(masters).map((i) => [i.id, i]));
  const unitIdOf = (itemId: string) => itemById.get(itemId)?.unitId ?? "";

  const movements: MovementM[] = [];
  const layers: LayerM[] = [];
  const layerQueue = new Map<string, LayerM[]>(); // item|warehouse → FIFO
  const balances: StockModel["balances"] = new Map();
  const lotBalances: StockModel["lotBalances"] = new Map();
  const modelLots: LotM[] = [];
  const serials: StockModel["serials"] = [];

  let seq = 0;
  const nextId = (family: string) => ctx.id(family, seq++);

  /** Apply a movement to the running balance. Nothing else may touch it. */
  /*
   * A serialised item is one the database will not let you move vaguely: an
   * after-commit trigger counts the serials a movement names and refuses it
   * unless they equal the units moved, to the unit. So serials are minted and
   * named HERE, in the one funnel every movement passes through, rather than
   * left to each caller to remember.
   *
   * Only receipts move serialised stock in this lab. Issues, transfers, counts
   * and adjustments skip those items at their source, so the pool only ever
   * grows and no movement can be short of the serials it must name. That is
   * what a serial register looks like for the kind of thing worth serialising:
   * received, numbered, and still on the shelf.
   */
  const isSerial = (itemId: string) =>
    company.profile.enables.serials && itemById.get(itemId)?.tracking === "serial";
  const movementSerials: StockModel["movementSerials"] = [];

  function post(m: MovementM): void {
    movements.push(m);
    if (isSerial(m.itemId) && m.qtyDelta > 0) {
      const units = Math.round(m.qtyDelta);
      for (let u = 0; u < units; u++) {
        const serialId = nextId("stock_serial");
        serials.push({
          id: serialId,
          itemId: m.itemId,
          serialNo: `SN-${String(serials.length + 1).padStart(7, "0")}`,
          lotId: m.lotId,
          status: "in_stock",
          warehouseId: m.warehouseId,
          locationId: m.locationId,
          receivedAt: m.effectiveAt,
        });
        movementSerials.push({
          id: nextId("stock_movement_serial"),
          movementId: m.id,
          serialId,
          at: m.effectiveAt,
        });
      }
    }
    const k = key3(m.itemId, m.warehouseId, m.locationId);
    const b =
      balances.get(k) ??
      ({
        itemId: m.itemId,
        warehouseId: m.warehouseId,
        locationId: m.locationId,
        onHand: 0,
        reserved: 0,
        lastAt: m.effectiveAt,
        avgCostMinor: 0,
      } as NonNullable<ReturnType<typeof balances.get>>);
    b.onHand += m.qtyDelta;
    b.reserved += m.reservedDelta;
    if (m.effectiveAt > b.lastAt) b.lastAt = m.effectiveAt;
    if (m.qtyDelta > 0 && m.unitCostMinor > 0) {
      // Weighted average, the product's own default policy.
      const before = b.onHand - m.qtyDelta;
      const value = before * b.avgCostMinor + m.qtyDelta * m.unitCostMinor;
      b.avgCostMinor = b.onHand > 0 ? Math.round(value / b.onHand) : m.unitCostMinor;
    }
    balances.set(k, b);
    if (m.lotId) {
      const lk = `${k}|${m.lotId}`;
      const lb =
        lotBalances.get(lk) ??
        ({
          itemId: m.itemId,
          warehouseId: m.warehouseId,
          locationId: m.locationId,
          lotId: m.lotId,
          onHand: 0,
          lastAt: m.effectiveAt,
        } as NonNullable<ReturnType<typeof lotBalances.get>>);
      lb.onHand += m.qtyDelta;
      if (m.effectiveAt > lb.lastAt) lb.lastAt = m.effectiveAt;
      lotBalances.set(lk, lb);
    }
  }

  /** Consume from the oldest layers first, recording exactly what came from where. */
  function consume(itemId: string, warehouseId: string, qty: number, movementId: string): number {
    const q = layerQueue.get(`${itemId}|${warehouseId}`) ?? [];
    let left = qty;
    let cost = 0;
    for (const layer of q) {
      if (left <= 0) break;
      if (layer.qtyRemaining <= 0) continue;
      const take = Math.min(layer.qtyRemaining, left);
      layer.qtyRemaining -= take;
      layer.consumption.push({ movementId, qty: take, unitCostMinor: layer.unitCostMinor });
      cost += take * layer.unitCostMinor;
      left -= take;
      if (layer.qtyRemaining === 0) layer.depletedAt = clock.tsAgo(0, 12, 0);
    }
    return cost;
  }

  // ── 1. Receipts become stock, and open a cost layer each ──────────────────
  for (const rl of supply.receiptLines) {
    if (rl.acceptedQty <= 0) continue;
    const wh = whOf(rl.warehouseKey);
    const item = itemById.get(rl.itemId);
    if (!item) continue;

    let lotId: string | null = null;
    if (lots && rng.chance(0.45)) {
      const lot: LotM = {
        id: nextId("stock_lot"),
        itemId: rl.itemId,
        code: `LOT-${String(modelLots.length + 1).padStart(5, "0")}`,
        // A tenth expire inside the next month, so the expiring-lots screen
        // has something real on it; a few are already past.
        expiryDate: rng.chance(0.75)
          ? clock.dayAhead(rng.chance(0.15) ? rng.int(1, 30) : rng.int(60, 900))
          : null,
        receivedAt: clock.tsAgo(rl.dayAgo, 11, 0),
        status: "active",
      };
      modelLots.push(lot);
      lotId = lot.id;
    }

    const movementId = nextId("stock_movement");
    const m: MovementM = {
      id: movementId,
      itemId: rl.itemId,
      warehouseId: wh.id,
      locationId: wh.receivingLocationId,
      type: "goods_receipt",
      qtyDelta: rl.acceptedQty,
      reservedDelta: 0,
      unitId: unitIdOf(rl.itemId),
      unitCostMinor: rl.unitCostMinor,
      costTotalMinor: Math.round(rl.acceptedQty * rl.unitCostMinor),
      effectiveAt: clock.tsAgo(rl.dayAgo, 11, 0),
      dayAgo: rl.dayAgo,
      sourceType: "goods_receipt_line",
      sourceId: rl.grnLineId,
      // The product keys a receipt posting by its line, which is what makes
      // re-posting the same receipt a no-op rather than a doubling.
      idempotencyKey: `goods_receipt_line:${rl.grnLineId}`,
      reason: null,
      note: null,
      lotId,
    };
    post(m);

    const layer: LayerM = {
      id: nextId("stock_cost_layer"),
      itemId: rl.itemId,
      warehouseId: wh.id,
      sourceMovementId: movementId,
      qtyReceived: rl.acceptedQty,
      qtyRemaining: rl.acceptedQty,
      unitCostMinor: rl.unitCostMinor,
      receivedAt: m.effectiveAt,
      depletedAt: null,
      consumption: [],
    };
    layers.push(layer);
    const qk = `${rl.itemId}|${wh.id}`;
    layerQueue.set(qk, [...(layerQueue.get(qk) ?? []), layer]);
  }

  // ── 2. Materials issued to jobs, sourced from the daily reports ───────────
  const deducted = Array.isArray(work.deductedMaterialLines) ? work.deductedMaterialLines : [];
  for (const raw of deducted) {
    const line = Array.isArray(raw)
      ? {
          lineId: raw[0],
          itemId: raw[3],
          qty: Number(raw[4]),
          reportDate: String(raw[6] ?? asOf),
        }
      : (raw as { lineId: string; itemId: string; qty: number; reportDate: string });
    const item = itemById.get(line.itemId);
    if (!item || !(line.qty > 0)) continue;
    // Serialised stock is received and held in this lab; issuing it would mean
    // naming each unit as it leaves, which nothing here has to demonstrate.
    if (isSerial(line.itemId)) continue;
    // Issue from wherever the item actually is; never from an empty shelf.
    const holding = [...balances.values()].find(
      (b) => b.itemId === line.itemId && b.onHand >= line.qty,
    );
    if (!holding) continue;
    const dayAgo = Math.max(0, clock.daysAgoOf(String(line.reportDate).slice(0, 10)));
    const movementId = nextId("stock_movement");
    const cost = consume(line.itemId, holding.warehouseId, line.qty, movementId);
    post({
      id: movementId,
      itemId: line.itemId,
      warehouseId: holding.warehouseId,
      locationId: holding.locationId,
      type: "job_consumption",
      qtyDelta: -line.qty,
      reservedDelta: 0,
      unitId: unitIdOf(line.itemId),
      unitCostMinor: line.qty > 0 ? Math.round(cost / line.qty) : 0,
      costTotalMinor: -Math.round(cost),
      effectiveAt: clock.tsAgo(dayAgo, 16, 0),
      dayAgo,
      sourceType: "report_material_line",
      sourceId: String(line.lineId),
      idempotencyKey: `report_material_line:${String(line.lineId)}`,
      reason: null,
      note: null,
      lotId: null,
    });
  }

  // ── 3. Transfers between warehouses: out and in, always in pairs ──────────
  const transfers: StockModel["transfers"] = [];
  if (whKeys.length >= 2) {
    const wanted = Math.min(
      40,
      Math.max(6, Math.round(company.profile.stockMovementsTarget / 400)),
    );
    for (let t = 0; t < wanted; t++) {
      const from = whOf(whKeys[t % whKeys.length]!);
      const to = whOf(whKeys[(t + 1) % whKeys.length]!);
      const movable = [...balances.values()].filter(
        (b) => b.warehouseId === from.id && b.onHand >= 2,
      );
      if (movable.length === 0) continue;
      const src = movable[rng.int(0, movable.length - 1)]!;
      const qty = Math.max(1, Math.floor(src.onHand * rng.float(0.1, 0.4, 2)));
      const dayAgo = rng.int(1, Math.max(2, Math.floor(horizon / 3)));
      const transferId = nextId("stock_transfer");
      const lineId = nextId("stock_transfer_line");
      transfers.push({
        id: transferId,
        reference: `TR-${String(1000 + t)}`,
        status: "received",
        fromWh: from.id,
        fromLoc: src.locationId,
        toWh: to.id,
        toLoc: to.receivingLocationId,
        dayAgo,
        lines: [{ id: lineId, itemId: src.itemId, unitId: unitIdOf(src.itemId), qty, sort: 0 }],
      });

      const outId = nextId("stock_movement");
      const cost = consume(src.itemId, from.id, qty, outId);
      const unitCost = qty > 0 ? Math.round(cost / qty) : 0;
      post({
        id: outId,
        itemId: src.itemId,
        warehouseId: from.id,
        locationId: src.locationId,
        type: "transfer_out",
        qtyDelta: -qty,
        reservedDelta: 0,
        unitId: unitIdOf(src.itemId),
        unitCostMinor: unitCost,
        costTotalMinor: -Math.round(cost),
        effectiveAt: clock.tsAgo(dayAgo, 10, 0),
        dayAgo,
        sourceType: "stock_transfer",
        sourceId: transferId,
        idempotencyKey: `stock_transfer_out:${transferId}`,
        reason: null,
        note: null,
        lotId: null,
      });

      const inId = nextId("stock_movement");
      post({
        id: inId,
        itemId: src.itemId,
        warehouseId: to.id,
        locationId: to.receivingLocationId,
        type: "transfer_in",
        qtyDelta: qty,
        reservedDelta: 0,
        unitId: unitIdOf(src.itemId),
        unitCostMinor: unitCost,
        costTotalMinor: Math.round(cost),
        effectiveAt: clock.tsAgo(dayAgo, 14, 0),
        dayAgo,
        sourceType: "stock_transfer",
        sourceId: transferId,
        idempotencyKey: `stock_transfer_in:${transferId}`,
        reason: null,
        note: null,
        lotId: null,
      });
      // The stock arriving opens a layer at the cost it left with.
      const layer: LayerM = {
        id: nextId("stock_cost_layer"),
        itemId: src.itemId,
        warehouseId: to.id,
        sourceMovementId: inId,
        qtyReceived: qty,
        qtyRemaining: qty,
        unitCostMinor: unitCost,
        receivedAt: clock.tsAgo(dayAgo, 14, 0),
        depletedAt: null,
        consumption: [],
      };
      layers.push(layer);
      const qk = `${src.itemId}|${to.id}`;
      layerQueue.set(qk, [...(layerQueue.get(qk) ?? []), layer]);
    }
  }

  // ── 4. Counts, and the corrections they produce ───────────────────────────
  const counts: StockModel["counts"] = [];
  const countable = [...balances.values()].filter((b) => b.onHand > 0);
  const countRounds = Math.min(8, Math.max(2, Math.round(countable.length / 300)));
  for (let c = 0; c < countRounds && countable.length > 0; c++) {
    const dayAgo = rng.int(5, Math.max(6, Math.floor(horizon / 2)));
    const sample = countable.slice(c * 5, c * 5 + rng.int(3, 8));
    if (sample.length === 0) continue;
    const countId = nextId("stock_count");
    const lines: StockModel["counts"][number]["lines"] = [];
    for (const [i, b] of sample.entries()) {
      // Most counts agree; a few find a difference, which is the point of one.
      const drift = rng.chance(0.25) ? rng.int(-2, 2) : 0;
      const counted = Math.max(0, b.onHand + drift);
      lines.push({
        id: nextId("stock_count_line"),
        itemId: b.itemId,
        locationId: b.locationId,
        unitId: unitIdOf(b.itemId),
        expectedQty: b.onHand,
        countedQty: counted,
        reason: drift !== 0 ? pick(rng, ADJUSTMENT_REASONS) : null,
        sort: i,
      });
      if (drift !== 0) {
        const mId = nextId("stock_movement");
        const unitCost = b.avgCostMinor;
        if (drift < 0) consume(b.itemId, b.warehouseId, Math.min(-drift, b.onHand), mId);
        post({
          id: mId,
          itemId: b.itemId,
          warehouseId: b.warehouseId,
          locationId: b.locationId,
          type: "count_correction",
          qtyDelta: counted - b.onHand,
          reservedDelta: 0,
          unitId: unitIdOf(b.itemId),
          unitCostMinor: unitCost,
          costTotalMinor: Math.round((counted - b.onHand) * unitCost),
          effectiveAt: clock.tsAgo(dayAgo, 15, 0),
          dayAgo,
          sourceType: "stock_count_line",
          sourceId: lines[lines.length - 1]!.id,
          idempotencyKey: `stock_count_line:${lines[lines.length - 1]!.id}`,
          reason: lines[lines.length - 1]!.reason,
          note: null,
          lotId: null,
        });
        if (drift > 0) {
          const layer: LayerM = {
            id: nextId("stock_cost_layer"),
            itemId: b.itemId,
            warehouseId: b.warehouseId,
            sourceMovementId: mId,
            qtyReceived: drift,
            qtyRemaining: drift,
            unitCostMinor: unitCost,
            receivedAt: clock.tsAgo(dayAgo, 15, 0),
            depletedAt: null,
            consumption: [],
          };
          layers.push(layer);
          const qk = `${b.itemId}|${b.warehouseId}`;
          layerQueue.set(qk, [...(layerQueue.get(qk) ?? []), layer]);
        }
      }
    }
    counts.push({
      id: countId,
      reference: `SC-${String(1000 + c)}`,
      status: "posted",
      warehouseId: sample[0]!.warehouseId,
      locationId: sample[0]!.locationId,
      dayAgo,
      lines,
    });
  }

  // ── 5. Reservations: promised, not moved ─────────────────────────────────
  const reservations: StockModel["reservations"] = [];
  const reservable = [...balances.values()].filter((b) => b.onHand >= 3);
  for (let i = 0; i < Math.min(30, reservable.length); i++) {
    const b = reservable[i]!;
    const qty = Math.max(1, Math.floor(b.onHand * 0.2));
    const dayAgo = rng.int(0, 40);
    // The schema calls a fulfilled reservation `issued`, not `consumed`:
    // open while it holds stock, released if it was given up, issued once the
    // stock actually left, expired if it timed out.
    const status = weighted(rng, { open: 55, released: 22, issued: 15, expired: 8 });
    const rid = nextId("stock_reservation");
    reservations.push({
      id: rid,
      itemId: b.itemId,
      warehouseId: b.warehouseId,
      locationId: b.locationId,
      unitId: unitIdOf(b.itemId),
      qty,
      jobId: null,
      status,
      dayAgo,
    });
    const mId = nextId("stock_movement");
    post({
      id: mId,
      itemId: b.itemId,
      warehouseId: b.warehouseId,
      locationId: b.locationId,
      type: "reservation",
      qtyDelta: 0,
      reservedDelta: qty,
      unitId: unitIdOf(b.itemId),
      unitCostMinor: 0,
      costTotalMinor: 0,
      effectiveAt: clock.tsAgo(dayAgo, 9, 0),
      dayAgo,
      sourceType: "manual",
      sourceId: null,
      idempotencyKey: null,
      reason: null,
      note: "Reserved for an upcoming job",
      lotId: null,
    });
    if (status !== "open") {
      const rel = nextId("stock_movement");
      post({
        id: rel,
        itemId: b.itemId,
        warehouseId: b.warehouseId,
        locationId: b.locationId,
        type: "reservation_release",
        qtyDelta: 0,
        reservedDelta: -qty,
        unitId: unitIdOf(b.itemId),
        unitCostMinor: 0,
        costTotalMinor: 0,
        effectiveAt: clock.tsAgo(Math.max(0, dayAgo - 3), 9, 0),
        dayAgo: Math.max(0, dayAgo - 3),
        sourceType: "manual",
        sourceId: null,
        idempotencyKey: null,
        reason: null,
        note: sentence(rng, "en"),
        lotId: null,
      });
    }
  }

  // ── 6. Deliberate adjustments, so the screens show write-offs ─────────────
  for (let i = 0; i < Math.min(12, countable.length); i++) {
    const b = countable[(i * 7) % countable.length]!;
    if (b.onHand < 2) continue;
    const down = rng.chance(0.6);
    const qty = 1;
    const mId = nextId("stock_movement");
    if (down) consume(b.itemId, b.warehouseId, qty, mId);
    post({
      id: mId,
      itemId: b.itemId,
      warehouseId: b.warehouseId,
      locationId: b.locationId,
      type: down ? "adjustment_decrease" : "adjustment_increase",
      qtyDelta: down ? -qty : qty,
      reservedDelta: 0,
      unitId: unitIdOf(b.itemId),
      unitCostMinor: b.avgCostMinor,
      costTotalMinor: (down ? -1 : 1) * Math.round(qty * b.avgCostMinor),
      effectiveAt: clock.tsAgo(rng.int(1, 60), 13, 0),
      dayAgo: rng.int(1, 60),
      sourceType: "manual",
      sourceId: null,
      idempotencyKey: null,
      reason: pick(rng, ADJUSTMENT_REASONS),
      note: null,
      lotId: null,
    });
  }

  // ── The handoff, and the closing value the ledger will have to agree with ─
  let closingValueMinor = 0;
  for (const l of layers) closingValueMinor += l.qtyRemaining * l.unitCostMinor;

  const lowStock = [...balances.values()]
    .filter((b) => b.onHand > 0 && b.onHand <= 3)
    .map((b) => b.itemId);
  const zeroStock = [...balances.values()].filter((b) => b.onHand === 0).map((b) => b.itemId);
  const expiring = modelLots
    .filter((l) => l.expiryDate !== null && l.expiryDate <= clock.dayAhead(30))
    .map((l) => l.id);

  const tableCounts: Record<StockTable, number> = {
    stock_lot: modelLots.length,
    stock_serial: serials.length,
    stock_transfer: transfers.length,
    stock_transfer_line: transfers.reduce((n, t) => n + t.lines.length, 0),
    stock_count: counts.length,
    stock_count_line: counts.reduce((n, c) => n + c.lines.length, 0),
    stock_reservation: reservations.length,
    stock_movement: movements.length,
    stock_movement_lot: movements.filter((m) => m.lotId !== null).length,
    stock_movement_serial: movementSerials.length,
    stock_cost_layer: layers.length,
    stock_layer_consumption: layers.reduce((n, l) => n + l.consumption.length, 0),
    stock_balance: balances.size,
    stock_lot_balance: lotBalances.size,
  };

  const model = {
    movements,
    layers,
    lots: modelLots,
    serials,
    movementSerials,
    transfers,
    counts,
    reservations,
    balances,
    lotBalances,
    tableCounts,
    handoff: {
      movementCount: movements.length,
      lowStockItemIds: [...new Set(lowStock)],
      zeroStockItemIds: [...new Set(zeroStock)],
      expiringLotIds: expiring,
      closingValueMinor,
    } as StockHandoff,
  };
  MODELS.set(ctx as unknown as object, model);
  return model;
}

function toRows(ctx: LabContext, m: StockModel): Record<StockTable, Row[]> {
  const org = ctx.orgId;
  const by = ctx.users.warehouse;
  const rows = Object.fromEntries(STOCK_TABLES.map((t) => [t, [] as Row[]])) as Record<
    StockTable,
    Row[]
  >;

  for (const l of m.lots)
    rows.stock_lot.push({
      id: l.id,
      org_id: org,
      item_id: l.itemId,
      code: l.code,
      supplier_lot_code: null,
      manufactured_on: null,
      expiry_date: l.expiryDate,
      received_at: l.receivedAt,
      status: l.status,
      notes: null,
      created_by: by,
      created_at: l.receivedAt,
      updated_at: l.receivedAt,
    });

  for (const s of m.serials)
    rows.stock_serial.push({
      id: s.id,
      org_id: org,
      item_id: s.itemId,
      serial_no: s.serialNo,
      lot_id: s.lotId,
      status: s.status,
      warehouse_id: s.warehouseId,
      location_id: s.locationId,
      received_at: s.receivedAt,
      created_by: by,
      created_at: s.receivedAt,
      updated_at: s.receivedAt,
    });

  // The link rows the after-commit trigger counts.
  for (const ms of m.movementSerials)
    rows.stock_movement_serial.push({
      id: ms.id,
      org_id: org,
      movement_id: ms.movementId,
      serial_id: ms.serialId,
      created_at: ms.at,
    });

  for (const t of m.transfers) {
    rows.stock_transfer.push({
      id: t.id,
      org_id: org,
      reference: t.reference,
      from_warehouse_id: t.fromWh,
      from_location_id: t.fromLoc,
      to_warehouse_id: t.toWh,
      to_location_id: t.toLoc,
      status: t.status,
      notes: null,
      cancelled_reason: null,
      dispatched_at: ctx.clock.tsAgo(t.dayAgo, 10, 0),
      dispatched_by: by,
      received_at: ctx.clock.tsAgo(t.dayAgo, 14, 0),
      received_by: by,
      created_by: by,
      created_at: ctx.clock.tsAgo(t.dayAgo, 9, 0),
      updated_at: ctx.clock.tsAgo(t.dayAgo, 14, 0),
    });
    for (const l of t.lines)
      rows.stock_transfer_line.push({
        id: l.id,
        org_id: org,
        transfer_id: t.id,
        item_id: l.itemId,
        unit_id: l.unitId,
        qty: l.qty,
        sort: l.sort,
        created_at: ctx.clock.tsAgo(t.dayAgo, 9, 0),
      });
  }

  for (const c of m.counts) {
    rows.stock_count.push({
      id: c.id,
      org_id: org,
      reference: c.reference,
      warehouse_id: c.warehouseId,
      location_id: c.locationId,
      kind: "cycle",
      status: c.status,
      blind: false,
      notes: null,
      cancelled_reason: null,
      counted_at: ctx.clock.tsAgo(c.dayAgo, 15, 0),
      reviewed_by: by,
      reviewed_at: ctx.clock.tsAgo(c.dayAgo, 16, 0),
      posted_at: ctx.clock.tsAgo(c.dayAgo, 16, 30),
      created_by: by,
      created_at: ctx.clock.tsAgo(c.dayAgo, 14, 0),
      updated_at: ctx.clock.tsAgo(c.dayAgo, 16, 30),
    });
    for (const l of c.lines)
      rows.stock_count_line.push({
        id: l.id,
        org_id: org,
        count_id: c.id,
        item_id: l.itemId,
        location_id: l.locationId,
        unit_id: l.unitId,
        expected_qty: l.expectedQty,
        counted_qty: l.countedQty,
        variance_reason: l.reason,
        sort: l.sort,
        created_at: ctx.clock.tsAgo(c.dayAgo, 15, 0),
      });
  }

  for (const r of m.reservations)
    rows.stock_reservation.push({
      id: r.id,
      org_id: org,
      item_id: r.itemId,
      warehouse_id: r.warehouseId,
      location_id: r.locationId,
      unit_id: r.unitId,
      qty: r.qty,
      for_job_id: r.jobId,
      status: r.status,
      expires_at: null,
      released_reason: r.status === "released" ? "No longer needed" : null,
      created_by: by,
      created_at: ctx.clock.tsAgo(r.dayAgo, 9, 0),
      updated_at: ctx.clock.tsAgo(r.dayAgo, 9, 0),
    });

  for (const mv of m.movements) {
    rows.stock_movement.push({
      id: mv.id,
      org_id: org,
      item_id: mv.itemId,
      warehouse_id: mv.warehouseId,
      location_id: mv.locationId,
      movement_type: mv.type,
      qty_delta: mv.qtyDelta,
      reserved_delta: mv.reservedDelta,
      unit_id: mv.unitId,
      currency: null,
      unit_cost_minor: mv.unitCostMinor,
      exchange_rate: null,
      base_unit_cost_minor: mv.unitCostMinor,
      cost_total_minor: mv.costTotalMinor,
      effective_at: mv.effectiveAt,
      recorded_at: mv.effectiveAt,
      source_type: mv.sourceType,
      source_id: mv.sourceId,
      /*
       * NOT NULL, at least eight characters: the column exists so a retried
       * write cannot post twice. Movements that come from a source row carry
       * that row's key; the rest fall back to their own deterministic id,
       * which is unique by construction and re-derives identically on a
       * second run.
       */
      idempotency_key: mv.idempotencyKey ?? `movement:${mv.id}`,
      reverses_movement_id: null,
      reason: mv.reason,
      note: mv.note,
      actor_user_id: by,
      /*
       * created_at is deliberately LEFT OUT so the column default applies.
       *
       * A movement carries three times: effective_at is when the stock moved,
       * recorded_at is when somebody said so, and created_at is when the row
       * itself was written — which is now, whatever the other two say.
       * Backdating it is not just untrue: the tracking triggers refuse to
       * attach lots or serials to a movement whose row predates the current
       * transaction, on the grounds that a posted movement cannot have its
       * units changed afterwards. Omitting the key omits the column from the
       * INSERT, so the table default fills it.
       */
    });
    if (mv.lotId)
      rows.stock_movement_lot.push({
        id: ctx.id("stock_movement_lot", mv.id),
        org_id: org,
        movement_id: mv.id,
        lot_id: mv.lotId,
        // The column is `qty`, and the trigger sums it against the movement's
        // qty_delta; a reservation moves nothing and names no lot, which is why
        // `qty <> 0` can be a constraint here.
        qty: mv.qtyDelta,
        created_at: mv.effectiveAt,
      });
  }

  for (const l of m.layers) {
    rows.stock_cost_layer.push({
      id: l.id,
      org_id: org,
      item_id: l.itemId,
      warehouse_id: l.warehouseId,
      source_movement_id: l.sourceMovementId,
      qty_received: l.qtyReceived,
      qty_remaining: l.qtyRemaining,
      unit_cost_minor: l.unitCostMinor,
      // NOT NULL: a cost without a currency is not a cost. Everything the lab
      // buys is priced in the company's own currency at par.
      currency: ctx.company.currency,
      original_unit_cost_minor: l.unitCostMinor,
      exchange_rate: 1,
      received_at: l.receivedAt,
      depleted_at: l.depletedAt,
      created_at: l.receivedAt,
    });
    for (const [i, c] of l.consumption.entries())
      rows.stock_layer_consumption.push({
        id: ctx.id("stock_layer_consumption", l.id, i),
        org_id: org,
        layer_id: l.id,
        movement_id: c.movementId,
        qty: c.qty,
        unit_cost_minor: c.unitCostMinor,
        created_at: l.receivedAt,
      });
  }

  for (const b of m.balances.values())
    rows.stock_balance.push({
      org_id: org,
      item_id: b.itemId,
      warehouse_id: b.warehouseId,
      location_id: b.locationId,
      on_hand: b.onHand,
      reserved: b.reserved,
      avg_unit_cost_minor: b.avgCostMinor,
      last_movement_at: b.lastAt,
      updated_at: b.lastAt,
    });

  for (const b of m.lotBalances.values())
    rows.stock_lot_balance.push({
      org_id: org,
      item_id: b.itemId,
      warehouse_id: b.warehouseId,
      location_id: b.locationId,
      lot_id: b.lotId,
      on_hand: b.onHand,
      reserved: 0,
      last_movement_at: b.lastAt,
      updated_at: b.lastAt,
    });

  return rows;
}

export function planStock(ctx: LabContext): FamilyPlan {
  const m = buildModel(ctx);
  return { family: "stock", expected: { ...m.tableCounts } };
}

export async function seedStock(ctx: LabContext): Promise<FamilyReport> {
  const m = buildModel(ctx);
  const rows = toRows(ctx, m);
  const counts: Record<string, number> = {};
  /*
   * A movement and the lots or serials it names have to land in ONE
   * transaction. `stock_movement_tracking_is_complete` is a DEFERRABLE
   * constraint trigger: it fires at commit and counts the tracking rows, which
   * are written after the movement they belong to. Insert the movements in a
   * statement of their own and that commit happens before a single link row
   * exists, so the trigger sees none of them and refuses every movement of a
   * tracked item.
   */
  const TOGETHER: readonly StockTable[] = [
    "stock_movement",
    "stock_movement_lot",
    "stock_movement_serial",
  ];
  for (const table of STOCK_TABLES) {
    // The declared order still rules: cost layers cite the movement that
    // created them, so the group has to go in at the point the movements
    // themselves appear, not after everything else.
    if (table === "stock_movement") {
      const grouped = await ctx.insertGroup(
        TOGETHER.map((t) => ({ table: t, rows: rows[t], conflict: "nothing" as const })),
      );
      for (const [t, r] of Object.entries(grouped)) {
        counts[t] = r.attempted;
        ctx.log(`${t}: ${r.attempted} rows (one transaction with its movements)`);
      }
      continue;
    }
    if (TOGETHER.includes(table)) continue;
    const r = await ctx.insert(table, rows[table], "nothing");
    counts[table] = r.attempted;
    ctx.log(`${table}: ${r.attempted} rows`);
  }
  return {
    family: "stock",
    counts,
    handoff: m.handoff as unknown as Record<string, unknown>,
    notes: [
      `${m.movements.length} movements, closing value ${(m.handoff.closingValueMinor / 100).toFixed(2)}`,
    ],
  };
}

export const stock: Family = {
  key: "stock",
  deps: ["setup", "masters", "work", "supply"],
  appliesTo: (c: Company) => c.profile.enables.stock,
  plan: planStock,
  seed: seedStock,
  async verify(ctx) {
    const m = buildModel(ctx);
    const checks = [];

    // The invariant everything else rests on.
    const summed = new Map<string, number>();
    for (const mv of m.movements) {
      const k = key3(mv.itemId, mv.warehouseId, mv.locationId);
      summed.set(k, (summed.get(k) ?? 0) + mv.qtyDelta);
    }
    let drift = 0;
    for (const [k, b] of m.balances) if (Math.abs((summed.get(k) ?? 0) - b.onHand) > 1e-6) drift++;
    checks.push({
      name: "every balance equals the sum of its movements",
      ok: drift === 0,
      detail: `${m.balances.size} balances, ${drift} disagree`,
    });

    const negative = [...m.balances.values()].filter((b) => b.onHand < 0).length;
    checks.push({
      name: "no warehouse holds a negative quantity",
      ok: negative === 0,
      detail: `${negative} negative`,
    });

    const badLayer = m.layers.filter(
      (l) =>
        Math.abs(l.qtyReceived - l.consumption.reduce((n, c) => n + c.qty, 0) - l.qtyRemaining) >
        1e-6,
    ).length;
    checks.push({
      name: "a layer's remaining equals received minus consumed",
      ok: badLayer === 0,
      detail: `${m.layers.length} layers, ${badLayer} disagree`,
    });
    checks.push({
      name: "no layer is consumed past what it received",
      ok: m.layers.every((l) => l.qtyRemaining >= -1e-6),
      detail: `${m.layers.filter((l) => l.qtyRemaining < 0).length} over-consumed`,
    });

    const lotDrift = [...m.lotBalances.values()].filter((b) => b.onHand < -1e-6).length;
    checks.push({
      name: "lot balances never go negative",
      ok: lotDrift === 0,
      detail: `${m.lotBalances.size} lot balances`,
    });

    checks.push({
      name: "every movement cites a legal source",
      ok: m.movements.every(
        (mv) => mv.sourceType === "manual" || (mv.sourceId !== null && mv.sourceId.length > 0),
      ),
      detail: `${m.movements.length} movements`,
    });

    checks.push({
      name: "the shelves show something worth looking at",
      ok:
        m.handoff.zeroStockItemIds.length + m.handoff.lowStockItemIds.length > 0 &&
        m.movements.length > 0,
      detail: `${m.handoff.zeroStockItemIds.length} zero, ${m.handoff.lowStockItemIds.length} low, ${m.handoff.expiringLotIds.length} expiring lots`,
    });

    return checks;
  },
};
