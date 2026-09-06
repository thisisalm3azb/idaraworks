/**
 * H33 Pilot Lab — buying: what the workshop asked for, what was ordered, and
 * what actually turned up.
 *
 * Five tables plus their lines: material requests, purchase orders, goods
 * receipts, and supplier returns. The stock family reads this family's receipts
 * and turns them into movements — this one deliberately posts nothing to the
 * ledger, so the two concerns stay separable and the ledger has exactly one
 * author.
 *
 * ── The arithmetic that has to hold ────────────────────────────────────────
 * A receipt line carries the quantity ordered, what had already arrived before
 * it, and what arrived now split into accepted, damaged and rejected. Those
 * must add up: nothing may be received twice, and the running total across a
 * purchase order's receipts may never exceed what was ordered. A "partially
 * received" order must genuinely have some of it outstanding, and a "received"
 * one must have none. Every one of those is checked by `verify()` rather than
 * assumed, because a lab whose receiving arithmetic is wrong teaches the
 * warehouse the wrong lesson.
 *
 * ── Legal states only ──────────────────────────────────────────────────────
 * `purchase_order_money_defaults` fills currency, base currency and exchange
 * rate at insert and `purchase_order_freeze_money` forbids changing them
 * afterwards, so the rows are written once with their money already correct.
 * Receipt status is draft / recorded / cancelled and nothing else.
 */
import type { Company, Family, FamilyPlan, FamilyReport, LabContext } from "../types";
import type { Rng } from "../../simulation/rng";
import { historyDays, paragraph, pick, sentence, spreadDates, weighted } from "./_shared";

type Row = Record<string, unknown>;

export const SUPPLY_TABLES = [
  "material_request",
  "material_request_line",
  "purchase_order",
  "purchase_order_line",
  "goods_receipt",
  "goods_receipt_line",
  "supplier_return",
  "supplier_return_line",
] as const;
export type SupplyTable = (typeof SUPPLY_TABLES)[number];

export const MR_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "converted",
  "cancelled",
] as const;
export const PO_STATUSES = [
  "draft",
  "approved",
  "sent",
  "partially_received",
  "received",
  "cancelled",
] as const;
export const GRN_STATUSES = ["draft", "recorded", "cancelled"] as const;
export const URGENCIES = ["low", "normal", "high", "urgent"] as const;

const MR_NOTES_EN = [
  "Needed on site before the weekend pour.",
  "Replacement for the batch rejected at inspection.",
  "Top-up for the second-floor fit-out.",
  "Consumables running low in the main store.",
];
const MR_NOTES_AR = [
  "مطلوب في الموقع قبل الصب نهاية الأسبوع.",
  "بديل عن الدفعة المرفوضة عند الفحص.",
  "تعزيز لتشطيبات الطابق الثاني.",
  "المستهلكات على وشك النفاد في المخزن الرئيسي.",
];
const RETURN_REASONS = [
  "Delivered damaged in transit",
  "Wrong specification supplied",
  "Short-dated stock",
  "Surplus to requirement",
];
const DISPOSITIONS = ["return_to_supplier", "scrap", "replace"] as const;

// ── What each family member consumes from the ones before it ────────────────

type MastersHandoff = {
  supplierIds: string[];
  itemIds: string[];
  items: Array<{
    id: string;
    unit: string;
    unitId: string;
    cost: number;
    category: string;
    type?: string;
    tracking?: string;
  }>;
};
type SetupHandoff = {
  warehouses: Record<string, { id: string; receivingLocationId: string }>;
};
type WorkHandoff = { activeJobIds: string[]; jobIds: string[] };

/** How many of each thing a company buys, derived from its profile. */
function shape(company: Company) {
  const p = company.profile;
  const purchaseOrders = p.purchaseOrders;
  return {
    purchaseOrders,
    // Roughly half of all orders begin life as a request from the floor; the
    // rest are raised straight by procurement, which is how it actually works.
    materialRequests: Math.round(purchaseOrders * 0.55),
    supplierReturns: Math.max(3, Math.round(purchaseOrders * 0.02)),
    linesPerOrder: [1, 5] as [number, number],
    linesPerRequest: [1, 4] as [number, number],
  };
}

type LineM = {
  id: string;
  itemId: string | null;
  itemName: string;
  qty: number;
  unit: string;
  unitCostMinor: number;
  lineTotalMinor: number;
  sort: number;
  /** Cumulative accepted quantity across every receipt, for verify(). */
  receivedQty: number;
};

type ReceiptM = {
  id: string;
  reference: string;
  status: (typeof GRN_STATUSES)[number];
  receivedDate: string;
  dayAgo: number;
  notes: string | null;
  lines: Array<{
    id: string;
    poLineId: string;
    orderedQty: number;
    previouslyReceived: number;
    receivedQty: number;
    damagedQty: number;
    rejectedQty: number;
    sort: number;
  }>;
};

type OrderM = {
  id: string;
  index: number;
  reference: string;
  status: (typeof PO_STATUSES)[number];
  supplierId: string;
  jobId: string | null;
  mrId: string | null;
  dayAgo: number;
  createdAt: string;
  approvedAt: string | null;
  notes: string | null;
  vatMinor: number;
  totalMinor: number;
  lines: LineM[];
  receipts: ReceiptM[];
};

type RequestM = {
  id: string;
  index: number;
  reference: string;
  status: (typeof MR_STATUSES)[number];
  jobId: string | null;
  urgency: (typeof URGENCIES)[number];
  requiredDate: string;
  dayAgo: number;
  notes: string | null;
  totalMinor: number;
  convertedPoId: string | null;
  lines: Array<{
    id: string;
    itemId: string;
    itemName: string;
    qty: number;
    unit: string;
    estUnitCostMinor: number;
    sort: number;
  }>;
};

type ReturnM = {
  id: string;
  reference: string;
  status: "draft" | "sent";
  supplierId: string;
  reason: string;
  notes: string | null;
  dayAgo: number;
  sentAt: string | null;
  lines: Array<{
    id: string;
    grnLineId: string;
    itemId: string;
    unitId: string;
    qty: number;
    disposition: (typeof DISPOSITIONS)[number];
    sort: number;
  }>;
};

export type SupplyModel = {
  requests: RequestM[];
  orders: OrderM[];
  returns: ReturnM[];
  counts: Record<SupplyTable, number>;
};

export type SupplyHandoff = {
  poIds: string[];
  grnIds: string[];
  /** What the stock family needs to source a receipt movement, without a query. */
  receiptLines: Array<{
    grnLineId: string;
    grnId: string;
    poLineId: string;
    itemId: string;
    unit: string;
    unitCostMinor: number;
    acceptedQty: number;
    damagedQty: number;
    receivedDate: string;
    dayAgo: number;
    warehouseKey: string;
  }>;
  mrIds: string[];
  returnIds: string[];
};

const MODELS = new WeakMap<object, SupplyModel & { handoff: SupplyHandoff }>();

/** Round to a whole minor unit; money never carries a fraction of a fils. */
const minor = (n: number) => Math.round(n);

function buildModel(ctx: LabContext): SupplyModel & { handoff: SupplyHandoff } {
  const memo = MODELS.get(ctx as unknown as object);
  if (memo) return memo;

  const { company, rng, clock } = ctx;
  const masters = ctx.handoff<MastersHandoff>("masters");
  const setup = ctx.handoff<SetupHandoff>("setup");
  const work = ctx.handoff<WorkHandoff>("work");
  const s = shape(company);
  const horizon = historyDays(company);
  const asOf = clock.asOf;

  const warehouseKeys = Object.keys(setup.warehouses);
  const stockItems = masters.items.filter((i) => (i.type ?? "inventory") !== "service");
  const buyable = stockItems.length > 0 ? stockItems : masters.items;
  const suppliers = masters.supplierIds;
  const jobs = work.activeJobIds.length > 0 ? work.activeJobIds : work.jobIds;

  const arabic = company.languages[0] === "ar";
  const noteFor = (r: Rng) =>
    r.chance(0.35) ? (arabic ? pick(r, MR_NOTES_AR) : pick(r, MR_NOTES_EN)) : null;

  // ── Purchase orders ───────────────────────────────────────────────────────
  const poDays = spreadDates(rng, company, s.purchaseOrders);
  const orders: OrderM[] = [];
  for (let i = 0; i < s.purchaseOrders; i++) {
    const dayAgo = poDays[i]!;
    const age = dayAgo / Math.max(1, horizon);
    // Older orders have had time to arrive; the newest are still moving.
    const status = weighted(rng, {
      received: age > 0.25 ? 55 : 8,
      partially_received: 14,
      sent: age > 0.25 ? 8 : 30,
      approved: age > 0.25 ? 5 : 22,
      draft: age > 0.25 ? 3 : 25,
      cancelled: 5,
    }) as OrderM["status"];

    const lineCount = rng.int(s.linesPerOrder[0], s.linesPerOrder[1]);
    const lines: LineM[] = [];
    let subtotal = 0;
    for (let l = 0; l < lineCount; l++) {
      const item = buyable[rng.int(0, buyable.length - 1)]!;
      const qty = rng.int(1, 40);
      // Suppliers quote around the catalogue cost, not exactly at it.
      const unitCostMinor = minor(item.cost * rng.float(0.85, 1.2, 4));
      const lineTotalMinor = minor(qty * unitCostMinor);
      subtotal += lineTotalMinor;
      lines.push({
        id: ctx.id("po_line", i, l),
        itemId: item.id,
        itemName: `Item ${item.id.slice(0, 8)}`,
        qty,
        unit: item.unit,
        unitCostMinor,
        lineTotalMinor,
        sort: l,
        receivedQty: 0,
      });
    }
    const vatRate = company.country === "SA" ? 0.15 : 0.05;
    const vatMinor = minor(subtotal * vatRate);

    const createdAt = clock.tsAgo(dayAgo, rng.int(8, 16), rng.int(0, 59));
    const approved = status !== "draft";
    const approvedAt = approved ? clock.tsAgo(Math.max(0, dayAgo - 1), 10, rng.int(0, 59)) : null;

    orders.push({
      id: ctx.id("purchase_order", i),
      index: i,
      reference: `PO-${String(1000 + i)}`,
      status,
      supplierId: suppliers[rng.int(0, suppliers.length - 1)]!,
      jobId: jobs.length > 0 && rng.chance(0.6) ? jobs[rng.int(0, jobs.length - 1)]! : null,
      mrId: null,
      dayAgo,
      createdAt,
      approvedAt,
      notes: noteFor(rng),
      vatMinor,
      totalMinor: subtotal + vatMinor,
      lines,
      receipts: [],
    });
  }

  // ── Receipts: what actually turned up, and when ───────────────────────────
  let grnSeq = 0;
  let grnLineSeq = 0;
  for (const po of orders) {
    if (po.status !== "received" && po.status !== "partially_received") continue;
    // A received order may have arrived in one lorry or in two.
    const staged = po.status === "received" && rng.chance(0.3);
    const deliveries = po.status === "partially_received" ? 1 : staged ? 2 : 1;

    for (let d = 0; d < deliveries; d++) {
      const last = d === deliveries - 1;
      const receiptDayAgo = Math.max(0, po.dayAgo - (d + 1) * rng.int(2, 10));
      const receiptLines: ReceiptM["lines"] = [];

      for (const line of po.lines) {
        const outstanding = line.qty - line.receivedQty;
        if (outstanding <= 0) continue;
        // The last delivery of a fully received order closes it exactly.
        const wanted =
          po.status === "received" && last
            ? outstanding
            : Math.max(1, Math.floor(outstanding * rng.float(0.35, 0.8, 2)));
        const received = Math.min(outstanding, wanted);
        // A little of what arrives is damaged or refused at the gate.
        const damaged = rng.chance(0.08) ? Math.min(received, rng.int(1, 2)) : 0;
        const rejected = rng.chance(0.05) ? Math.min(received - damaged, rng.int(1, 2)) : 0;
        receiptLines.push({
          id: ctx.id("grn_line", grnLineSeq++),
          poLineId: line.id,
          orderedQty: line.qty,
          previouslyReceived: line.receivedQty,
          receivedQty: received,
          damagedQty: damaged,
          rejectedQty: rejected,
          sort: receiptLines.length,
        });
        // Only what was accepted counts as received against the order.
        line.receivedQty += received - damaged - rejected;
      }
      if (receiptLines.length === 0) continue;

      const idx = grnSeq++;
      po.receipts.push({
        id: ctx.id("goods_receipt", idx),
        reference: `GRN-${String(1000 + idx)}`,
        // A cancelled receipt is rare and never contributes to stock.
        status: rng.chance(0.03) ? "cancelled" : "recorded",
        receivedDate: clock.dayAgo(receiptDayAgo),
        dayAgo: receiptDayAgo,
        notes: rng.chance(0.2) ? sentence(rng, arabic ? "ar" : "en") : null,
        lines: receiptLines,
      });
    }
  }

  // ── Material requests, some of which became those orders ──────────────────
  const mrDays = spreadDates(rng, company, s.materialRequests);
  const requests: RequestM[] = [];
  const convertible = orders.filter((o) => o.status !== "draft" && o.status !== "cancelled");
  let convertCursor = 0;
  for (let i = 0; i < s.materialRequests; i++) {
    const dayAgo = mrDays[i]!;
    const age = dayAgo / Math.max(1, horizon);
    const status = weighted(rng, {
      converted: age > 0.2 ? 45 : 10,
      approved: 16,
      submitted: age > 0.2 ? 8 : 34,
      draft: age > 0.2 ? 6 : 24,
      rejected: 10,
      cancelled: 6,
    }) as RequestM["status"];

    const lineCount = rng.int(s.linesPerRequest[0], s.linesPerRequest[1]);
    const lines: RequestM["lines"] = [];
    let total = 0;
    for (let l = 0; l < lineCount; l++) {
      const item = buyable[rng.int(0, buyable.length - 1)]!;
      const qty = rng.int(1, 25);
      const est = minor(item.cost * rng.float(0.9, 1.15, 4));
      total += minor(qty * est);
      lines.push({
        id: ctx.id("mr_line", i, l),
        itemId: item.id,
        itemName: `Item ${item.id.slice(0, 8)}`,
        qty,
        unit: item.unit,
        estUnitCostMinor: est,
        sort: l,
      });
    }

    // A converted request points at a real order, and that order points back.
    let convertedPoId: string | null = null;
    if (status === "converted" && convertCursor < convertible.length) {
      const po = convertible[convertCursor++]!;
      convertedPoId = po.id;
      po.mrId = ctx.id("material_request", i);
    }

    requests.push({
      id: ctx.id("material_request", i),
      index: i,
      reference: `MR-${String(1000 + i)}`,
      status: convertedPoId === null && status === "converted" ? "approved" : status,
      jobId: jobs.length > 0 ? jobs[rng.int(0, jobs.length - 1)]! : null,
      urgency: weighted(rng, { low: 15, normal: 55, high: 22, urgent: 8 }),
      requiredDate: clock.dayAgo(Math.max(0, dayAgo - rng.int(3, 21))),
      dayAgo,
      notes: noteFor(rng),
      totalMinor: total,
      convertedPoId,
      lines,
    });
  }

  // ── Supplier returns, against receipts that really happened ───────────────
  const returns: ReturnM[] = [];
  const damagedLines = orders.flatMap((o) =>
    o.receipts
      .filter((r) => r.status === "recorded")
      .flatMap((r) =>
        r.lines
          .filter((l) => l.damagedQty > 0 || l.rejectedQty > 0)
          .map((l) => ({ po: o, receipt: r, line: l })),
      ),
  );
  for (let i = 0; i < Math.min(s.supplierReturns, damagedLines.length); i++) {
    const src = damagedLines[i]!;
    const poLine = src.po.lines.find((l) => l.id === src.line.poLineId)!;
    const item = masters.items.find((x) => x.id === poLine.itemId);
    returns.push({
      id: ctx.id("supplier_return", i),
      reference: `SR-${String(1000 + i)}`,
      status: rng.chance(0.7) ? "sent" : "draft",
      supplierId: src.po.supplierId,
      reason: pick(rng, RETURN_REASONS),
      notes: rng.chance(0.5) ? paragraph(rng, arabic ? "ar" : "en", 1) : null,
      dayAgo: Math.max(0, src.receipt.dayAgo - 2),
      sentAt: null,
      lines: [
        {
          id: ctx.id("supplier_return_line", i, 0),
          grnLineId: src.line.id,
          itemId: poLine.itemId!,
          unitId: item?.unitId ?? "",
          qty: Math.max(1, src.line.damagedQty + src.line.rejectedQty),
          disposition: pick(rng, DISPOSITIONS),
          sort: 0,
        },
      ],
    });
  }
  for (const r of returns) {
    r.sentAt = r.status === "sent" ? clock.tsAgo(r.dayAgo, 11, 0) : null;
  }

  // ── Statuses must agree with the arithmetic ───────────────────────────────
  // A "received" order with something still outstanding is a lie the warehouse
  // would act on, so the status follows the numbers rather than the other way.
  for (const po of orders) {
    if (po.status !== "received" && po.status !== "partially_received") continue;
    const outstanding = po.lines.some((l) => l.receivedQty < l.qty);
    po.status = outstanding ? "partially_received" : "received";
  }

  const counts: Record<SupplyTable, number> = {
    material_request: requests.length,
    material_request_line: requests.reduce((n, r) => n + r.lines.length, 0),
    purchase_order: orders.length,
    purchase_order_line: orders.reduce((n, o) => n + o.lines.length, 0),
    goods_receipt: orders.reduce((n, o) => n + o.receipts.length, 0),
    goods_receipt_line: orders.reduce(
      (n, o) => n + o.receipts.reduce((m, r) => m + r.lines.length, 0),
      0,
    ),
    supplier_return: returns.length,
    supplier_return_line: returns.reduce((n, r) => n + r.lines.length, 0),
  };

  const warehouseFor = (i: number) => warehouseKeys[i % Math.max(1, warehouseKeys.length)] ?? "";
  const handoff: SupplyHandoff = {
    poIds: orders.map((o) => o.id),
    grnIds: orders.flatMap((o) => o.receipts.map((r) => r.id)),
    receiptLines: orders.flatMap((o) =>
      o.receipts
        .filter((r) => r.status === "recorded")
        .flatMap((r) =>
          r.lines.map((l) => {
            const poLine = o.lines.find((x) => x.id === l.poLineId)!;
            return {
              grnLineId: l.id,
              grnId: r.id,
              poLineId: l.poLineId,
              itemId: poLine.itemId ?? "",
              unit: poLine.unit,
              unitCostMinor: poLine.unitCostMinor,
              acceptedQty: l.receivedQty - l.damagedQty - l.rejectedQty,
              damagedQty: l.damagedQty,
              receivedDate: r.receivedDate,
              dayAgo: r.dayAgo,
              warehouseKey: warehouseFor(o.index),
            };
          }),
        ),
    ),
    mrIds: requests.map((r) => r.id),
    returnIds: returns.map((r) => r.id),
  };

  void asOf;
  const model = { requests, orders, returns, counts, handoff };
  MODELS.set(ctx as unknown as object, model);
  return model;
}

/** The rows, in the order the foreign keys demand. */
function toRows(ctx: LabContext, m: SupplyModel): Record<SupplyTable, Row[]> {
  const org = ctx.orgId;
  const creator = ctx.users.warehouse;
  const rows = Object.fromEntries(SUPPLY_TABLES.map((t) => [t, [] as Row[]])) as Record<
    SupplyTable,
    Row[]
  >;

  for (const r of m.requests) {
    rows.material_request.push({
      id: r.id,
      org_id: org,
      reference: r.reference,
      job_id: r.jobId,
      status: r.status,
      urgency: r.urgency,
      required_date: r.requiredDate,
      total_minor: r.totalMinor,
      notes: r.notes,
      created_by: creator,
      converted_po_id: r.convertedPoId,
      created_at: ctx.clock.tsAgo(r.dayAgo, 9, 0),
      updated_at: ctx.clock.tsAgo(r.dayAgo, 9, 0),
    });
    for (const l of r.lines) {
      rows.material_request_line.push({
        id: l.id,
        org_id: org,
        mr_id: r.id,
        item_id: l.itemId,
        item_name: l.itemName,
        qty: l.qty,
        unit: l.unit,
        est_unit_cost_minor: l.estUnitCostMinor,
        sort: l.sort,
        superseded_at: null,
        created_at: ctx.clock.tsAgo(r.dayAgo, 9, 0),
      });
    }
  }

  for (const o of m.orders) {
    rows.purchase_order.push({
      id: o.id,
      org_id: org,
      reference: o.reference,
      supplier_id: o.supplierId,
      job_id: o.jobId,
      mr_id: o.mrId,
      status: o.status,
      vat_minor: o.vatMinor,
      total_minor: o.totalMinor,
      pdf_file_id: null,
      notes: o.notes,
      created_by: creator,
      approved_at: o.approvedAt,
      created_at: o.createdAt,
      updated_at: o.createdAt,
    });
    for (const l of o.lines) {
      rows.purchase_order_line.push({
        id: l.id,
        org_id: org,
        po_id: o.id,
        item_id: l.itemId,
        item_name: l.itemName,
        qty: l.qty,
        unit: l.unit,
        unit_cost_minor: l.unitCostMinor,
        line_total_minor: l.lineTotalMinor,
        sort: l.sort,
        superseded_at: null,
        created_at: o.createdAt,
      });
    }
    for (const r of o.receipts) {
      rows.goods_receipt.push({
        id: r.id,
        org_id: org,
        reference: r.reference,
        po_id: o.id,
        job_id: o.jobId,
        status: r.status,
        received_date: r.receivedDate,
        notes: r.notes,
        created_by: creator,
        created_at: ctx.clock.tsAgo(r.dayAgo, 11, 0),
        updated_at: ctx.clock.tsAgo(r.dayAgo, 11, 0),
      });
      for (const l of r.lines) {
        rows.goods_receipt_line.push({
          id: l.id,
          org_id: org,
          grn_id: r.id,
          po_line_id: l.poLineId,
          ordered_qty: l.orderedQty,
          previously_received: l.previouslyReceived,
          received_qty: l.receivedQty,
          damaged_qty: l.damagedQty,
          rejected_qty: l.rejectedQty,
          sort: l.sort,
          created_at: ctx.clock.tsAgo(r.dayAgo, 11, 0),
        });
      }
    }
  }

  for (const r of m.returns) {
    rows.supplier_return.push({
      id: r.id,
      org_id: org,
      reference: r.reference,
      supplier_id: r.supplierId,
      status: r.status,
      reason: r.reason,
      notes: r.notes,
      sent_at: r.sentAt,
      sent_by: r.status === "sent" ? creator : null,
      created_by: creator,
      created_at: ctx.clock.tsAgo(r.dayAgo, 12, 0),
      updated_at: ctx.clock.tsAgo(r.dayAgo, 12, 0),
    });
    for (const l of r.lines) {
      rows.supplier_return_line.push({
        id: l.id,
        org_id: org,
        return_id: r.id,
        goods_receipt_line_id: l.grnLineId,
        item_id: l.itemId,
        unit_id: l.unitId === "" ? null : l.unitId,
        qty: l.qty,
        disposition: l.disposition,
        sort: l.sort,
        created_at: ctx.clock.tsAgo(r.dayAgo, 12, 0),
      });
    }
  }

  return rows;
}

export function planSupply(ctx: LabContext): FamilyPlan {
  const m = buildModel(ctx);
  return { family: "supply", expected: { ...m.counts } };
}

export async function seedSupply(ctx: LabContext): Promise<FamilyReport> {
  const m = buildModel(ctx);
  const rows = toRows(ctx, m);
  const counts: Record<string, number> = {};
  for (const table of SUPPLY_TABLES) {
    const r = await ctx.insert(table, rows[table]);
    counts[table] = r.attempted;
    ctx.log(`${table}: ${r.attempted} rows`);
  }
  return {
    family: "supply",
    counts,
    handoff: m.handoff as unknown as Record<string, unknown>,
    notes: [
      `${m.handoff.receiptLines.length} accepted receipt lines for the stock ledger`,
      "nothing posted to stock here: the stock family is the ledger's only author",
    ],
  };
}

export const supply: Family = {
  key: "supply",
  deps: ["setup", "people", "masters", "work"],
  appliesTo: () => true,
  plan: planSupply,
  seed: seedSupply,
  async verify(ctx) {
    const m = buildModel(ctx);
    const checks = [];

    const plan = planSupply(ctx).expected;
    const actual: Record<string, number> = {};
    for (const t of SUPPLY_TABLES) {
      const rows = (await ctx.sql.unsafe(
        `select count(*)::int as n from public."${t}" where org_id = $1`,
        [ctx.orgId],
      )) as unknown as Array<{ n: number }>;
      actual[t] = rows[0]?.n ?? 0;
    }
    checks.push({
      name: "row counts match the plan",
      ok: SUPPLY_TABLES.every((t) => actual[t] === plan[t]),
      detail: SUPPLY_TABLES.map((t) => `${t} ${actual[t]}/${plan[t]}`).join(" "),
    });

    // Receiving arithmetic: nothing arrives twice, nothing exceeds the order.
    let overReceived = 0;
    let badSplit = 0;
    for (const o of m.orders) {
      for (const l of o.lines) if (l.receivedQty > l.qty) overReceived++;
      for (const r of o.receipts) {
        for (const rl of r.lines) {
          if (rl.damagedQty + rl.rejectedQty > rl.receivedQty) badSplit++;
          if (rl.previouslyReceived + rl.receivedQty > rl.orderedQty + 0.001) overReceived++;
        }
      }
    }
    checks.push({
      name: "no line is received beyond what was ordered",
      ok: overReceived === 0,
      detail: `${overReceived} over-received`,
    });
    checks.push({
      name: "damaged plus rejected never exceeds what arrived",
      ok: badSplit === 0,
      detail: `${badSplit} impossible splits`,
    });

    const received = m.orders.filter((o) => o.status === "received");
    const partial = m.orders.filter((o) => o.status === "partially_received");
    checks.push({
      name: "a received order has nothing outstanding, a partial one does",
      ok:
        received.every((o) => o.lines.every((l) => l.receivedQty >= l.qty)) &&
        partial.every((o) => o.lines.some((l) => l.receivedQty < l.qty)),
      detail: `${received.length} received, ${partial.length} partial`,
    });

    // Money: the order total is its lines plus VAT, to the fils.
    const badMoney = m.orders.filter((o) => {
      const sub = o.lines.reduce((n, l) => n + l.lineTotalMinor, 0);
      return sub + o.vatMinor !== o.totalMinor;
    }).length;
    checks.push({
      name: "every order total is its lines plus VAT",
      ok: badMoney === 0,
      detail: `${badMoney} orders disagree`,
    });

    // Every converted request names an order, and that order names it back.
    const converted = m.requests.filter((r) => r.status === "converted");
    const mutual = converted.every((r) => {
      const po = m.orders.find((o) => o.id === r.convertedPoId);
      return po !== undefined && po.mrId === r.id;
    });
    checks.push({
      name: "a converted request and its order point at each other",
      ok: mutual,
      detail: `${converted.length} converted`,
    });

    // Returns cite a receipt line that really carried damage.
    const returnsOk = m.returns.every((r) =>
      r.lines.every((l) =>
        m.orders.some((o) =>
          o.receipts.some((g) =>
            g.lines.some((gl) => gl.id === l.grnLineId && gl.damagedQty + gl.rejectedQty > 0),
          ),
        ),
      ),
    );
    checks.push({
      name: "every return cites a receipt line that was damaged or refused",
      ok: returnsOk,
      detail: `${m.returns.length} returns`,
    });

    // Every status in the vocabulary is present, so the screens have something.
    const poStates = new Set(m.orders.map((o) => o.status));
    const mrStates = new Set(m.requests.map((r) => r.status));
    checks.push({
      name: "orders and requests show a real spread of states",
      ok: poStates.size >= 4 && mrStates.size >= 4,
      detail: `${[...poStates].sort().join(",")} | ${[...mrStates].sort().join(",")}`,
    });

    return checks;
  },
};
