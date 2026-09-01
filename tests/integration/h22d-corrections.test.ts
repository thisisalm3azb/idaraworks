/**
 * H22D corrections — the paths an adversarial audit proved were broken.
 *
 * 0088 made the ledger refuse a movement that does not say which batch or unit
 * it moved. That check was right and it broke four paths that had no way to
 * supply the answer: transfers, stock counts, assembly output and disassembly
 * output. Each is exercised here through the service a person would call, since
 * "it throws at commit" is exactly the failure the original tests missed by
 * seeding every fixture as untracked.
 *
 * The rest are cost conservation: a transfer that destroyed the value it moved,
 * a reversal that gave stock back with no cost behind it, and rounding that
 * leaked a few minor units on every build.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  postMovement,
  reverseMovement,
  postGoodsReceiptToStock,
  allocateAndIssueIn,
  dispatchTransfer,
  postStockCount,
  reserveStock,
  sendSupplierReturn,
  reconcileStockBalances,
  createBom,
  activateBom,
  createAssemblyOrder,
  completeAssembly,
  BomError,
} from "@/modules/inventory/service";
import {
  createPurchaseOrder,
  submitPurchaseOrder,
  recordGoodsReceipt,
  getPurchaseOrder,
} from "@/modules/supply/service";
import { createApprovalRule, decideApproval } from "@/modules/approvals/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const procUser = randomUUID();
let orgA = "";
let unitA = "";
let whA = "";
let whB = "";
let binA = "";
let binB = "";
let supplierA = "";

const ctxOf = (userId: string): Ctx => ({
  orgId: orgA,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h22dc",
});
const ownerCtx = () => ctxOf(userA);
const procCtx = () => ctxOf(procUser);
const key = () => `k-${randomUUID()}`;

async function seedItem(
  tracking: "none" | "lot" | "serial",
  costMethod: "fifo" | "weighted_average" | null = "fifo",
) {
  const id = randomUUID();
  await owner`
    insert into public.item
      (id, org_id, sku, name, category_key, unit, item_type, base_unit_id, tracking, cost_method)
    values (${id}, ${orgA}, ${"S-" + randomUUID().slice(0, 8)}, 'Item', 'general', 'ea',
            'inventory', ${unitA}, ${tracking}, ${costMethod})`;
  return id;
}

async function receive(
  itemId: string,
  qty: number,
  unitCostMinor: number,
  tracking: {
    lots?: Array<{ lotCode: string; qty: number; expiryDate?: string }>;
    serials?: Array<{ serialNo: string }>;
  } = {},
) {
  const { id: poId } = await createPurchaseOrder(procCtx(), "procurement", {
    supplierId: supplierA,
    lines: [{ itemId, itemName: "Ordered", qty, unit: "ea", unitCostMinor }],
  });
  const { approvalId } = await submitPurchaseOrder(procCtx(), "procurement", poId);
  await decideApproval(ownerCtx(), "owner", { approvalId, decision: "approved" });
  const po = await getPurchaseOrder(procCtx(), "procurement", poId);
  const grn = await recordGoodsReceipt(procCtx(), "procurement", {
    poId,
    receivedDate: "2026-08-05",
    lines: [{ poLineId: po!.lines[0]!.id, receivedQty: qty, ...tracking }],
  });
  const posted = await postGoodsReceiptToStock(ownerCtx(), "owner", grn.id);
  return { poId, grnId: grn.id, grlId: posted[0]!.lineId, posted };
}

async function qtyAt(itemId: string, locationId: string) {
  const [r] = (await owner`
    select coalesce(sum(qty_delta), 0)::text as q from public.stock_movement
    where org_id = ${orgA} and item_id = ${itemId} and location_id = ${locationId}`) as unknown as Array<{
    q: string;
  }>;
  return Number(r!.q);
}

/** Everything the ledger says this item is worth, across every movement. */
async function ledgerValue(itemId: string) {
  const [r] = (await owner`
    select coalesce(sum(
      case when qty_delta > 0 then cost_total_minor else -cost_total_minor end
    ), 0)::text as v
    from public.stock_movement
    where org_id = ${orgA} and item_id = ${itemId} and cost_total_minor is not null`) as unknown as Array<{
    v: string;
  }>;
  return Number(r!.v);
}

/** What the open cost layers say is left. */
async function layerValue(itemId: string) {
  const [r] = (await owner`
    select coalesce(sum(value_remaining_minor), 0)::text as v
    from public.stock_cost_layer where org_id = ${orgA} and item_id = ${itemId}`) as unknown as Array<{
    v: string;
  }>;
  return Number(r!.v);
}

async function lotIdFor(itemId: string, code: string) {
  const [r] = (await owner`
    select id::text as id from public.stock_lot
    where org_id = ${orgA} and item_id = ${itemId} and code = ${code}`) as unknown as Array<{
    id: string;
  }>;
  return r?.id ?? null;
}

beforeAll(async () => {
  for (const [id, label] of [
    [userA, "owner"],
    [procUser, "proc"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h22dc-${label}-${run}@example.com`}, '{"full_name":"H22DC"}'::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H22DC", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h22d-corrections", run);
  await owner`
    insert into public.membership (user_id, org_id, role_key)
    values (${procUser}, ${orgA}, 'procurement')`;
  await createApprovalRule(ownerCtx(), "owner", {
    subjectType: "purchase_order",
    conditionKind: "always",
    assignedRole: "owner",
  });

  unitA = randomUUID();
  await owner`
    insert into public.unit_of_measure (id, org_id, code, name_en, name_ar, dimension, factor_to_base, is_base)
    values (${unitA}, ${orgA}, 'EA', 'Each', 'حبة', 'count', 1, true)`;
  whA = randomUUID();
  whB = randomUUID();
  await owner`
    insert into public.warehouse (id, org_id, code, name_en, created_by)
    values (${whA}, ${orgA}, 'MAIN', 'Main', ${userA}),
           (${whB}, ${orgA}, 'SITE', 'Site', ${userA})`;
  binA = randomUUID();
  binB = randomUUID();
  await owner`
    insert into public.stock_location
      (id, org_id, warehouse_id, code, name_en, kind, is_default_receiving, is_default_issue)
    values (${binA}, ${orgA}, ${whA}, 'A1', 'Bin A1', 'storage', true, true),
           (${binB}, ${orgA}, ${whB}, 'B1', 'Bin B1', 'storage', true, true)`;
  supplierA = randomUUID();
  await owner`
    insert into public.supplier (id, org_id, name) values (${supplierA}, ${orgA}, 'Supplier')`;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA, procUser]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 300_000);

async function transfer(itemId: string, qty: number) {
  const id = randomUUID();
  await owner`
    insert into public.stock_transfer
      (id, org_id, reference, from_warehouse_id, from_location_id, to_warehouse_id,
       to_location_id, status, created_by)
    values (${id}, ${orgA}, ${"TR-" + randomUUID().slice(0, 8)}, ${whA}, ${binA}, ${whB},
            ${binB}, 'draft', ${userA})`;
  await owner`
    insert into public.stock_transfer_line (org_id, transfer_id, item_id, unit_id, qty)
    values (${orgA}, ${id}, ${itemId}, ${unitA}, ${qty})`;
  return id;
}

describe("a transfer moves the goods AND their value", () => {
  it("conserves value across warehouses", { timeout: 300_000 }, async () => {
    const item = await seedItem("none");
    await receive(item, 10, 700);
    const before = await ledgerValue(item);
    expect(before, "10 at 700").toBe(7000);

    await dispatchTransfer(ownerCtx(), "owner", await transfer(item, 4));

    expect(await qtyAt(item, binA)).toBe(6);
    expect(await qtyAt(item, binB)).toBe(4);
    // Nothing was bought or sold, so nothing about the value changed.
    expect(await ledgerValue(item), "value survived the move").toBe(7000);
    expect(await layerValue(item), "and the layers agree").toBe(7000);

    /*
     * Per WAREHOUSE, because the org-wide totals cancel for any equal pair —
     * including two nulls. planCost picks layers by warehouse, so value stranded
     * at the source would leave the next issue at the destination uncosted while
     * both org-wide assertions above stayed green.
     */
    const valueAt = async (warehouseId: string) => {
      const [r] = (await owner`
        select coalesce(sum(value_remaining_minor), 0)::text as v
        from public.stock_cost_layer
        where org_id = ${orgA} and item_id = ${item} and warehouse_id = ${warehouseId}`) as unknown as Array<{
        v: string;
      }>;
      return Number(r!.v);
    };
    expect(await valueAt(whA), "6 of the 10 stayed").toBe(4200);
    expect(await valueAt(whB), "and 4 arrived, worth 4 of them").toBe(2800);
  });

  it(
    "can move a batch-tracked item at all, and says which batch",
    { timeout: 300_000 },
    async () => {
      const item = await seedItem("lot");
      await receive(item, 9, 200, { lots: [{ lotCode: "T-1", qty: 9 }] });

      await dispatchTransfer(ownerCtx(), "owner", await transfer(item, 5));

      expect(await qtyAt(item, binB)).toBe(5);
      const lot = await lotIdFor(item, "T-1");
      const [arrived] = (await owner`
      select coalesce(sum(ml.qty), 0)::text as q
      from public.stock_movement_lot ml
      join public.stock_movement m on m.id = ml.movement_id and m.org_id = ml.org_id
      where ml.org_id = ${orgA} and ml.lot_id = ${lot} and m.location_id = ${binB}`) as unknown as Array<{
        q: string;
      }>;
      expect(Number(arrived!.q), "the batch arrived, by name").toBe(5);
      expect(await ledgerValue(item), "9 at 200, still").toBe(1800);
    },
  );

  it("can move a serialised item, and the unit changes address", { timeout: 300_000 }, async () => {
    const item = await seedItem("serial");
    await receive(item, 2, 500, { serials: [{ serialNo: "TS-1" }, { serialNo: "TS-2" }] });

    await dispatchTransfer(ownerCtx(), "owner", await transfer(item, 1));

    const rows = (await owner`
      select serial_no, status, location_id::text as location_id
      from public.stock_serial where org_id = ${orgA} and item_id = ${item}
      order by serial_no`) as unknown as Array<Record<string, string>>;
    expect(rows[0]!.status).toBe("in_stock");
    expect(rows[0]!.location_id, "the moved unit lives in the other warehouse now").toBe(binB);
    expect(rows[1]!.location_id).toBe(binA);
    expect(await ledgerValue(item)).toBe(1000);
  });
});

describe("counting a tracked item", () => {
  async function countOf(
    itemId: string,
    line: { countedQty: number; lotId?: string; serialId?: string; reason?: string },
  ) {
    const countId = randomUUID();
    await owner`
      insert into public.stock_count
        (id, org_id, reference, warehouse_id, status, reviewed_by, reviewed_at, created_by)
      values (${countId}, ${orgA}, ${"SC-" + randomUUID().slice(0, 8)}, ${whA}, 'review',
              ${userA}, now(), ${userA})`;
    await owner`
      insert into public.stock_count_line
        (org_id, count_id, item_id, location_id, unit_id, counted_qty, variance_reason,
         lot_id, serial_id)
      values (${orgA}, ${countId}, ${itemId}, ${binA}, ${unitA}, ${line.countedQty},
              ${line.reason ?? "recount"}, ${line.lotId ?? null}, ${line.serialId ?? null})`;
    return countId;
  }

  it("refuses a count line that does not name the batch", { timeout: 300_000 }, async () => {
    const item = await seedItem("lot");
    await receive(item, 10, 100, { lots: [{ lotCode: "C-1", qty: 10 }] });
    const countId = await countOf(item, { countedQty: 8 });
    await expect(postStockCount(ownerCtx(), "owner", countId)).rejects.toThrow(/name the batch/i);
    expect(await qtyAt(item, binA), "nothing was corrected").toBe(10);
  });

  it("posts a correction against the batch that was counted", { timeout: 300_000 }, async () => {
    const item = await seedItem("lot");
    await receive(item, 10, 100, { lots: [{ lotCode: "C-2", qty: 10 }] });
    const lot = await lotIdFor(item, "C-2");
    const countId = await countOf(item, { countedQty: 8, lotId: lot!, reason: "two broken" });

    const result = await postStockCount(ownerCtx(), "owner", countId);
    expect(result.corrections).toBe(1);
    expect(await qtyAt(item, binA)).toBe(8);
    const [lotBal] = (await owner`
      select on_hand::text as q from public.stock_lot_balance
      where org_id = ${orgA} and lot_id = ${lot}`) as unknown as Array<{ q: string }>;
    expect(Number(lotBal!.q), "the batch is short, not the item in general").toBe(8);
  });

  it("refuses a batch named on an untracked item", { timeout: 300_000 }, async () => {
    const plain = await seedItem("none");
    const tracked = await seedItem("lot");
    await receive(plain, 5, 100);
    await receive(tracked, 5, 100, { lots: [{ lotCode: "C-3", qty: 5 }] });
    const stray = await lotIdFor(tracked, "C-3");
    const countId = await countOf(plain, { countedQty: 4, lotId: stray! });
    await expect(postStockCount(ownerCtx(), "owner", countId)).rejects.toThrow(/not tracked/i);
  });
});

describe("building something that is itself tracked", () => {
  async function recipe(parent: string, parts: Array<{ id: string; qtyPer: number }>) {
    const bom = await createBom(ownerCtx(), "owner", {
      itemId: parent,
      unitId: unitA,
      lines: parts.map((p) => ({ componentItemId: p.id, qtyPer: p.qtyPer, unitId: unitA })),
    });
    await activateBom(ownerCtx(), "owner", bom.id);
    return bom.id;
  }

  it(
    "refuses to plan a batch-tracked build with no batch named",
    { timeout: 300_000 },
    async () => {
      const parent = await seedItem("lot");
      const part = await seedItem("none");
      await recipe(parent, [{ id: part, qtyPer: 1 }]);
      await receive(part, 10, 100);
      await expect(
        createAssemblyOrder(ownerCtx(), "owner", { itemId: parent, qty: 3, warehouseId: whA }),
      ).rejects.toBeInstanceOf(BomError);
    },
  );

  it("makes a batch-tracked parent into the batch it named", { timeout: 600_000 }, async () => {
    const parent = await seedItem("lot");
    const part = await seedItem("none");
    await recipe(parent, [{ id: part, qtyPer: 2 }]);
    await receive(part, 20, 150);

    const order = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 4,
      warehouseId: whA,
      outputLotCode: "BUILD-24A",
      outputExpiryDate: "2028-05-01",
    });
    const result = await completeAssembly(ownerCtx(), "owner", order.id);
    expect(result.consumedCostMinor, "8 of the part at 150").toBe(1200);

    const lot = await lotIdFor(parent, "BUILD-24A");
    expect(lot, "the batch it said it would make").not.toBeNull();
    const [bal] = (await owner`
      select on_hand::text as q from public.stock_lot_balance
      where org_id = ${orgA} and lot_id = ${lot}`) as unknown as Array<{ q: string }>;
    expect(Number(bal!.q)).toBe(4);
    expect(await ledgerValue(parent), "worth what went into it").toBe(1200);
  });

  it("makes a serialised parent into the units it named", { timeout: 600_000 }, async () => {
    const parent = await seedItem("serial");
    const part = await seedItem("none");
    await recipe(parent, [{ id: part, qtyPer: 1 }]);
    await receive(part, 10, 900);

    const order = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 3,
      warehouseId: whA,
      outputSerialNos: ["MADE-1", "MADE-2", "MADE-3"],
    });
    await completeAssembly(ownerCtx(), "owner", order.id);

    const rows = (await owner`
      select serial_no, status from public.stock_serial
      where org_id = ${orgA} and item_id = ${parent} order by serial_no`) as unknown as Array<{
      serial_no: string;
      status: string;
    }>;
    expect(rows.map((r) => r.serial_no)).toEqual(["MADE-1", "MADE-2", "MADE-3"]);
    expect(rows.every((r) => r.status === "in_stock")).toBe(true);
  });

  it(
    "refuses a serialised build whose unit numbers do not match the quantity",
    { timeout: 300_000 },
    async () => {
      const parent = await seedItem("serial");
      const part = await seedItem("none");
      await recipe(parent, [{ id: part, qtyPer: 1 }]);
      await expect(
        createAssemblyOrder(ownerCtx(), "owner", {
          itemId: parent,
          qty: 3,
          warehouseId: whA,
          outputSerialNos: ["ONLY-1"],
        }),
      ).rejects.toBeInstanceOf(BomError);
    },
  );

  it("takes apart into a batch-tracked component", { timeout: 600_000 }, async () => {
    const parent = await seedItem("none");
    const part = await seedItem("lot");
    await recipe(parent, [{ id: part, qtyPer: 1 }]);
    await receive(part, 10, 400, { lots: [{ lotCode: "ORIG", qty: 10 }] });

    const build = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 4,
      warehouseId: whA,
    });
    await completeAssembly(ownerCtx(), "owner", build.id);

    const teardown = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 2,
      warehouseId: whA,
      direction: "disassemble",
      componentLotCodes: { [part]: "RECOVERED" },
    });
    await completeAssembly(ownerCtx(), "owner", teardown.id);

    // A recovered part is NOT the batch it was built from: its history now
    // includes having been inside something else.
    const recovered = await lotIdFor(part, "RECOVERED");
    expect(recovered).not.toBeNull();
    const [bal] = (await owner`
      select on_hand::text as q from public.stock_lot_balance
      where org_id = ${orgA} and lot_id = ${recovered}`) as unknown as Array<{ q: string }>;
    expect(Number(bal!.q)).toBe(2);
  });

  it("gives the parent exactly what the components cost", { timeout: 600_000 }, async () => {
    const parent = await seedItem("none");
    const part = await seedItem("none");
    await recipe(parent, [{ id: part, qtyPer: 1 }]);
    // Divides evenly, so this proves the plumbing, not the rounding — the layer
    // that does not divide is exercised separately below.
    await receive(part, 7, 143);

    const order = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 3,
      warehouseId: whA,
    });
    const result = await completeAssembly(ownerCtx(), "owner", order.id);
    // 3 of the part at 143 = 429, and the parent must be worth exactly that.
    expect(result.consumedCostMinor).toBe(429);
    expect(await ledgerValue(parent), "not 428, not 430").toBe(429);
    expect(await layerValue(parent)).toBe(429);
    expect(await layerValue(part), "4 of 7 left, at their share of 1001").toBe(1001 - 429);
  });
});

describe("a reversal puts back exactly what was taken", () => {
  it("restores the layers an issue drew, at their price", { timeout: 300_000 }, async () => {
    const item = await seedItem("none");
    await receive(item, 10, 250);
    expect(await layerValue(item)).toBe(2500);

    const ctx = ownerCtx();
    const { movements } = await withCtx(ctx, (tx) =>
      allocateAndIssueIn(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 4,
        movementType: "material_issue",
        idempotencyKey: key(),
      }),
    );
    expect(movements[0]!.costTotalMinor).toBe(1000);
    expect(await layerValue(item), "1500 left in the layers").toBe(1500);

    const undone = await reverseMovement(ctx, "owner", movements[0]!.id, "issued in error");
    expect(undone.costTotalMinor, "the reversal credits what the issue charged").toBe(1000);
    expect(await qtyAt(item, binA)).toBe(10);
    expect(await layerValue(item), "and the value came back to the layers").toBe(2500);
    expect(await ledgerValue(item), "net: still 10 at 250").toBe(2500);
  });

  it("reverses a movement of a batch-tracked item", { timeout: 300_000 }, async () => {
    const item = await seedItem("lot");
    await receive(item, 6, 300, { lots: [{ lotCode: "R-1", qty: 6 }] });
    const ctx = ownerCtx();
    const { movements } = await withCtx(ctx, (tx) =>
      allocateAndIssueIn(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 2,
        movementType: "material_issue",
        idempotencyKey: key(),
      }),
    );
    await reverseMovement(ctx, "owner", movements[0]!.id, "wrong job");

    expect(await qtyAt(item, binA)).toBe(6);
    const lot = await lotIdFor(item, "R-1");
    const [bal] = (await owner`
      select on_hand::text as q from public.stock_lot_balance
      where org_id = ${orgA} and lot_id = ${lot}`) as unknown as Array<{ q: string }>;
    expect(Number(bal!.q), "the batch got its units back, not some anonymous quantity").toBe(6);
  });

  it(
    "reverses a movement of a serialised item, and the unit returns",
    { timeout: 300_000 },
    async () => {
      const item = await seedItem("serial");
      await receive(item, 2, 800, { serials: [{ serialNo: "RS-1" }, { serialNo: "RS-2" }] });
      const ctx = ownerCtx();
      const { movements } = await withCtx(ctx, (tx) =>
        allocateAndIssueIn(tx, ctx, {
          itemId: item,
          unitId: unitA,
          qty: 1,
          movementType: "material_issue",
          idempotencyKey: key(),
        }),
      );
      await reverseMovement(ctx, "owner", movements[0]!.id, "returned unused");

      const rows = (await owner`
      select serial_no, status, location_id::text as location_id from public.stock_serial
      where org_id = ${orgA} and item_id = ${item} order by serial_no`) as unknown as Array<
        Record<string, string>
      >;
      expect(
        rows.every((r) => r.status === "in_stock"),
        "both units are back",
      ).toBe(true);
      expect(rows.every((r) => r.location_id === binA)).toBe(true);
      expect(await layerValue(item), "and both are worth 800 again").toBe(1600);
    },
  );
});

describe("a supplier return credits the price that delivery arrived at", () => {
  it("gives back the second shipment's cost, not the first's", { timeout: 600_000 }, async () => {
    const item = await seedItem("none");
    // Two deliveries at different prices. The oldest open layer is the cheap one.
    await receive(item, 5, 100);
    const dear = await receive(item, 5, 900);

    const returnId = randomUUID();
    await owner`
      insert into public.supplier_return (id, org_id, reference, supplier_id, reason, created_by)
      values (${returnId}, ${orgA}, ${"SR-" + randomUUID().slice(0, 8)}, ${supplierA},
              'wrong specification', ${userA})`;
    await owner`
      insert into public.supplier_return_line
        (org_id, return_id, goods_receipt_line_id, item_id, unit_id, qty, disposition)
      values (${orgA}, ${returnId}, ${dear.grlId}, ${item}, ${unitA}, 2, 'accepted')`;

    await sendSupplierReturn(ownerCtx(), "owner", returnId);

    const [mv] = (await owner`
      select cost_total_minor::text as cost from public.stock_movement
      where org_id = ${orgA} and item_id = ${item} and movement_type = 'supplier_return'`) as unknown as Array<{
      cost: string;
    }>;
    expect(Number(mv!.cost), "2 at the 900 THAT delivery cost").toBe(1800);
  });
});

describe("the database refuses what the application must never do", () => {
  it("will not let a movement name another item's batch", { timeout: 300_000 }, async () => {
    const mine = await seedItem("lot");
    const theirs = await seedItem("lot");
    await receive(mine, 5, 100, { lots: [{ lotCode: "MINE", qty: 5 }] });
    await receive(theirs, 5, 100, { lots: [{ lotCode: "THEIRS", qty: 5 }] });
    const wrongLot = await lotIdFor(theirs, "THEIRS");

    await expect(
      postMovement(ownerCtx(), "owner", {
        itemId: mine,
        warehouseId: whA,
        locationId: binA,
        movementType: "adjustment_increase",
        qtyDelta: 1,
        unitId: unitA,
        lots: [{ lotId: wrongLot!, qty: 1 }],
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(/different item/i);
  });

  it(
    "will not let batch detail be added to a movement already posted",
    { timeout: 300_000 },
    async () => {
      const item = await seedItem("lot");
      await receive(item, 4, 100, { lots: [{ lotCode: "SEALED", qty: 4 }] });
      const lot = await lotIdFor(item, "SEALED");
      const [mv] = (await owner`
      select id::text as id from public.stock_movement
      where org_id = ${orgA} and item_id = ${item} limit 1`) as unknown as Array<{ id: string }>;

      // A separate transaction, after the fact — which the completeness check that
      // fires on the movement's own insert would never see.
      await expect(
        owner`insert into public.stock_movement_lot (org_id, movement_id, lot_id, qty)
            values (${orgA}, ${mv!.id}, ${lot}, 99)`,
      ).rejects.toThrow(/already posted/i);
    },
  );

  it("will not let an active recipe be edited", { timeout: 300_000 }, async () => {
    const parent = await seedItem("none");
    const part = await seedItem("none");
    const bom = await createBom(ownerCtx(), "owner", {
      itemId: parent,
      unitId: unitA,
      lines: [{ componentItemId: part, qtyPer: 2, unitId: unitA }],
    });
    // A draft may still be corrected — read it back, because an UPDATE that
    // matches no rows resolves just as happily as one that changed something.
    await owner`update public.bom set output_qty = 5 where id = ${bom.id}`;
    const [draft] = (await owner`
      select output_qty::text as q from public.bom where id = ${bom.id}`) as unknown as Array<{
      q: string;
    }>;
    expect(Number(draft!.q), "the draft really was editable").toBe(5);

    await activateBom(ownerCtx(), "owner", bom.id);
    await expect(owner`update public.bom set output_qty = 9 where id = ${bom.id}`).rejects.toThrow(
      /cannot be changed/i,
    );
    await expect(
      owner`update public.bom_line set qty_per = 99 where bom_id = ${bom.id}`,
    ).rejects.toThrow(/cannot be changed/i);
  });

  it(
    "refuses a cycle that only appears when both recipes are activated",
    { timeout: 300_000 },
    async () => {
      const a = await seedItem("none");
      const b = await seedItem("none");
      // Two innocent drafts: neither sees the other, because neither is active.
      const bomB = await createBom(ownerCtx(), "owner", {
        itemId: b,
        unitId: unitA,
        lines: [{ componentItemId: a, qtyPer: 1, unitId: unitA }],
      });
      const bomA = await createBom(ownerCtx(), "owner", {
        itemId: a,
        unitId: unitA,
        lines: [{ componentItemId: b, qtyPer: 1, unitId: unitA }],
      });
      await activateBom(ownerCtx(), "owner", bomB.id);
      // Now the second one would close the loop.
      await expect(activateBom(ownerCtx(), "owner", bomA.id)).rejects.toBeInstanceOf(BomError);
    },
  );
});

describe("a unit can be received again once it has left", () => {
  it("accepts a returned unit and gives it a fresh cost", { timeout: 600_000 }, async () => {
    const item = await seedItem("serial");
    await receive(item, 1, 500, { serials: [{ serialNo: "BOOMERANG" }] });
    const ctx = ownerCtx();
    await withCtx(ctx, (tx) =>
      allocateAndIssueIn(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 1,
        movementType: "material_issue",
        idempotencyKey: key(),
      }),
    );
    // Bought back at a different price. 0088 claimed a unit is received once,
    // which is false; what must not happen is two OPEN layers for one unit.
    await receive(item, 1, 300, { serials: [{ serialNo: "BOOMERANG" }] });

    const layers = (await owner`
      select value_remaining_minor::text as v, qty_remaining::text as q
      from public.stock_cost_layer
      where org_id = ${orgA} and item_id = ${item} order by created_at`) as unknown as Array<
      Record<string, string>
    >;
    expect(layers.length, "two receipts, two layers").toBe(2);
    expect(layers.filter((l) => Number(l.q) > 0).length, "only one of them open").toBe(1);
    expect(await layerValue(item), "worth what it cost the second time").toBe(300);
  });
});

describe("reserving the same thing twice", () => {
  it("holds the stock once when the caller supplies a key", { timeout: 300_000 }, async () => {
    const item = await seedItem("none");
    await receive(item, 10, 100);
    const k = randomUUID();
    const first = await reserveStock(ownerCtx(), "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      unitId: unitA,
      qty: 3,
      idempotencyKey: k,
    });
    expect(first.movement.posted).toBe(true);
    const second = await reserveStock(ownerCtx(), "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      unitId: unitA,
      qty: 3,
      idempotencyKey: k,
    });
    expect(second.movement.posted, "the double click reserved nothing further").toBe(false);

    const [bal] = (await owner`
      select reserved::text as r from public.stock_balance
      where org_id = ${orgA} and item_id = ${item} and location_id = ${binA}`) as unknown as Array<{
      r: string;
    }>;
    expect(Number(bal!.r), "3 held, not 6").toBe(3);
  });
});

describe("concurrent issues with one key", () => {
  it("post once, however many arrive together", { timeout: 600_000 }, async () => {
    const item = await seedItem("none");
    await receive(item, 20, 100);
    const ctx = ownerCtx();
    const k = key();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        withCtx(ctx, (tx) =>
          allocateAndIssueIn(tx, ctx, {
            itemId: item,
            unitId: unitA,
            qty: 4,
            movementType: "material_issue",
            idempotencyKey: k,
          }),
        ),
      ),
    );
    expect(
      results.every((r) => r.status === "fulfilled"),
      "none of them errored",
    ).toBe(true);
    expect(await qtyAt(item, binA), "4 issued, exactly once").toBe(16);
  });
});

describe("value survives arithmetic that does not divide", () => {
  /*
   * A layer whose value is NOT a whole multiple of its quantity.
   *
   * This is the only shape that can catch the rounding leak, and a plain receipt
   * can never produce it: value = unit cost x quantity always divides. It has to
   * be built — two receipts at different prices consumed into one assembly — and
   * the earlier version of this test used 1001 across 7, which divides exactly
   * and therefore passed under the very bug it was written to catch.
   */
  async function sevenWorth786() {
    const parent = await seedItem("none", "fifo");
    const part = await seedItem("none", "fifo");
    const bom = await createBom(ownerCtx(), "owner", {
      itemId: parent,
      unitId: unitA,
      lines: [{ componentItemId: part, qtyPer: 1, unitId: unitA }],
    });
    await activateBom(ownerCtx(), "owner", bom.id);
    await receive(part, 5, 100);
    await receive(part, 5, 143);

    const order = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 7,
      warehouseId: whA,
    });
    const built = await completeAssembly(ownerCtx(), "owner", order.id);
    // 5 at 100 then 2 at 143 = 786 across 7 units. 786/7 = 112.28...
    expect(built.consumedCostMinor).toBe(786);
    expect(await layerValue(parent)).toBe(786);
    return parent;
  }

  it("three uneven draws give back exactly what the layer held", { timeout: 900_000 }, async () => {
    const parent = await sevenWorth786();
    const ctx = ownerCtx();
    let charged = 0;
    for (const qty of [3, 3, 1]) {
      const { movements } = await withCtx(ctx, (tx) =>
        allocateAndIssueIn(tx, ctx, {
          itemId: parent,
          unitId: unitA,
          qty,
          movementType: "material_issue",
          idempotencyKey: key(),
        }),
      );
      charged += movements.reduce((s, m) => s + (m.costTotalMinor ?? 0), 0);
    }
    // At a rate of round(786/7) = 112 this would be 336 + 336 + 112 = 784.
    expect(charged, "every fils that was in the layer came out of it").toBe(786);
    expect(await layerValue(parent), "and nothing is stranded").toBe(0);
  });

  it("a reversal credits the same number the issue charged", { timeout: 900_000 }, async () => {
    const parent = await sevenWorth786();
    const ctx = ownerCtx();
    const { movements } = await withCtx(ctx, (tx) =>
      allocateAndIssueIn(tx, ctx, {
        itemId: parent,
        unitId: unitA,
        qty: 2,
        movementType: "material_issue",
        idempotencyKey: key(),
      }),
    );
    const charged = movements[0]!.costTotalMinor!;
    // round(786 x 2/7) = 225, which is not 2 x any whole rate.
    expect(charged).toBe(225);

    const undone = await reverseMovement(ctx, "owner", movements[0]!.id, "issued in error");
    expect(undone.costTotalMinor, "not 226, which a rate of 113 would give").toBe(225);
    expect(await layerValue(parent), "the layer is whole again").toBe(786);
  });

  it(
    "a transfer under weighted average moves the value that left",
    { timeout: 600_000 },
    async () => {
      /*
       * The case the first version of these tests could not see, because its
       * fixture forced FIFO while the organization's default is weighted average.
       * Under the average the CHARGE and what the LAYERS gave up are different
       * numbers, and crediting the destination with the charge invented value.
       */
      const item = await seedItem("none", "weighted_average");
      await receive(item, 1, 100);
      await receive(item, 1, 300);
      expect(await layerValue(item), "two layers, 400 between them").toBe(400);

      await dispatchTransfer(ownerCtx(), "owner", await transfer(item, 1));

      expect(await layerValue(item), "still 400 — a transfer buys nothing").toBe(400);
      const [atSource] = (await owner`
      select coalesce(sum(value_remaining_minor), 0)::text as v from public.stock_cost_layer
      where org_id = ${orgA} and item_id = ${item} and warehouse_id = ${whA}`) as unknown as Array<{
        v: string;
      }>;
      const [atDest] = (await owner`
      select coalesce(sum(value_remaining_minor), 0)::text as v from public.stock_cost_layer
      where org_id = ${orgA} and item_id = ${item} and warehouse_id = ${whB}`) as unknown as Array<{
        v: string;
      }>;
      // FIFO within the source picks the 100 layer, so 100 moves and 300 stays.
      expect(Number(atSource!.v), "the dearer layer stayed put").toBe(300);
      expect(Number(atDest!.v), "and exactly what left arrived").toBe(100);
    },
  );
});

describe("the database enforces tracking, not just the application", () => {
  /*
   * Every earlier tracking test goes through postMovementIn, which refuses in
   * TypeScript before any SQL runs — so the deferred constraint trigger that is
   * this slice's headline claim was never actually exercised. Delete the trigger
   * and those tests all stay green. These do not.
   */
  it("refuses at COMMIT a lot-tracked movement naming no batch", { timeout: 300_000 }, async () => {
    const item = await seedItem("lot");
    await receive(item, 5, 100, { lots: [{ lotCode: "DB-1", qty: 5 }] });

    await expect(
      owner.begin(async (tx) => {
        await tx`insert into public.stock_movement
                   (org_id, item_id, warehouse_id, location_id, movement_type, qty_delta,
                    unit_id, idempotency_key, actor_user_id)
                 values (${orgA}, ${item}, ${whA}, ${binA}, 'adjustment_increase', 3,
                         ${unitA}, ${"raw-" + randomUUID()}, ${userA})`;
      }),
    ).rejects.toThrow(/lots account for/i);
  });

  it("refuses at COMMIT batches that do not add up", { timeout: 300_000 }, async () => {
    const item = await seedItem("lot");
    await receive(item, 5, 100, { lots: [{ lotCode: "DB-2", qty: 5 }] });
    const lot = await lotIdFor(item, "DB-2");
    const movementId = randomUUID();

    await expect(
      owner.begin(async (tx) => {
        await tx`insert into public.stock_movement
                   (id, org_id, item_id, warehouse_id, location_id, movement_type, qty_delta,
                    unit_id, idempotency_key, actor_user_id)
                 values (${movementId}, ${orgA}, ${item}, ${whA}, ${binA}, 'adjustment_increase', 4,
                         ${unitA}, ${"raw-" + randomUUID()}, ${userA})`;
        // Says four arrived, names three.
        await tx`insert into public.stock_movement_lot (org_id, movement_id, lot_id, qty)
                 values (${orgA}, ${movementId}, ${lot}, 3)`;
      }),
    ).rejects.toThrow(/lots account for/i);
  });

  it("refuses at COMMIT a fraction of a serialised unit", { timeout: 300_000 }, async () => {
    const item = await seedItem("serial");
    await receive(item, 2, 100, { serials: [{ serialNo: "DB-S1" }, { serialNo: "DB-S2" }] });
    const [s1] = (await owner`
      select id::text as id from public.stock_serial
      where org_id = ${orgA} and item_id = ${item} and serial_no = 'DB-S1'`) as unknown as Array<{
      id: string;
    }>;
    const movementId = randomUUID();

    await expect(
      owner.begin(async (tx) => {
        await tx`insert into public.stock_movement
                   (id, org_id, item_id, warehouse_id, location_id, movement_type, qty_delta,
                    unit_id, idempotency_key, actor_user_id)
                 values (${movementId}, ${orgA}, ${item}, ${whA}, ${binA}, 'adjustment_decrease',
                         -1.5, ${unitA}, ${"raw-" + randomUUID()}, ${userA})`;
        await tx`insert into public.stock_movement_serial (org_id, movement_id, serial_id)
                 values (${orgA}, ${movementId}, ${s1!.id})`;
      }),
    ).rejects.toThrow(/whole units/i);
  });

  it(
    "refuses at COMMIT a movement naming lots on an untracked item",
    { timeout: 300_000 },
    async () => {
      const plain = await seedItem("none");
      const tracked = await seedItem("lot");
      await receive(plain, 5, 100);
      await receive(tracked, 5, 100, { lots: [{ lotCode: "DB-3", qty: 5 }] });
      const lot = await lotIdFor(tracked, "DB-3");
      const movementId = randomUUID();

      await expect(
        owner.begin(async (tx) => {
          await tx`insert into public.stock_movement
                   (id, org_id, item_id, warehouse_id, location_id, movement_type, qty_delta,
                    unit_id, idempotency_key, actor_user_id)
                 values (${movementId}, ${orgA}, ${plain}, ${whA}, ${binA}, 'adjustment_increase',
                         1, ${unitA}, ${"raw-" + randomUUID()}, ${userA})`;
          await tx`insert into public.stock_movement_lot (org_id, movement_id, lot_id, qty)
                 values (${orgA}, ${movementId}, ${lot}, 1)`;
        }),
      ).rejects.toThrow(/not tracked that way|different item/i);
    },
  );
});

describe("a promise is kept", () => {
  it("reserved units are not handed to the next issue", { timeout: 600_000 }, async () => {
    const item = await seedItem("serial");
    await receive(item, 3, 100, {
      serials: [{ serialNo: "P-1" }, { serialNo: "P-2" }, { serialNo: "P-3" }],
    });
    await reserveStock(ownerCtx(), "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      unitId: unitA,
      qty: 2,
      idempotencyKey: randomUUID(),
    });

    const ctx = ownerCtx();
    // One is free; asking for two would eat into what was promised.
    await expect(
      withCtx(ctx, (tx) =>
        allocateAndIssueIn(tx, ctx, {
          itemId: item,
          unitId: unitA,
          qty: 2,
          movementType: "material_issue",
          idempotencyKey: key(),
        }),
      ),
    ).rejects.toThrow(/insufficient stock/i);

    const { legs } = await withCtx(ctx, (tx) =>
      allocateAndIssueIn(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 1,
        movementType: "material_issue",
        idempotencyKey: key(),
      }),
    );
    expect(legs[0]!.serialIds).toHaveLength(1);
  });

  it("a reserved batch quantity is not issued away", { timeout: 600_000 }, async () => {
    const item = await seedItem("lot");
    await receive(item, 10, 100, { lots: [{ lotCode: "PROM", qty: 10 }] });
    await reserveStock(ownerCtx(), "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      unitId: unitA,
      qty: 7,
      idempotencyKey: randomUUID(),
    });

    const ctx = ownerCtx();
    await expect(
      withCtx(ctx, (tx) =>
        allocateAndIssueIn(tx, ctx, {
          itemId: item,
          unitId: unitA,
          qty: 5,
          movementType: "material_issue",
          idempotencyKey: key(),
        }),
      ),
    ).rejects.toThrow(/insufficient stock/i);
  });
});

describe("a count that finds stock values it", () => {
  it(
    "gives found goods the cost the organization already believes",
    { timeout: 600_000 },
    async () => {
      const item = await seedItem("none", "fifo");
      await receive(item, 10, 250);
      const countId = randomUUID();
      await owner`
      insert into public.stock_count
        (id, org_id, reference, warehouse_id, status, reviewed_by, reviewed_at, created_by)
      values (${countId}, ${orgA}, ${"SC-" + randomUUID().slice(0, 8)}, ${whA}, 'review',
              ${userA}, now(), ${userA})`;
      await owner`
      insert into public.stock_count_line
        (org_id, count_id, item_id, location_id, unit_id, counted_qty, variance_reason)
      values (${orgA}, ${countId}, ${item}, ${binA}, ${unitA}, 12, 'two found behind the rack')`;

      await postStockCount(ownerCtx(), "owner", countId);
      expect(await qtyAt(item, binA)).toBe(12);
      // 2 more at the 250 the organization already carries them at.
      expect(await layerValue(item), "found stock is worth something").toBe(3000);
      expect(await ledgerValue(item)).toBe(3000);
    },
  );
});

describe("everything still reconciles", () => {
  it("no drift in quantity, batch or VALUE", { timeout: 600_000 }, async () => {
    const result = await reconcileStockBalances(ownerCtx(), "owner");
    expect(result.drift).toEqual([]);
    expect(result.lotDrift).toEqual([]);
    /*
     * The one that matters most here. Every quantity can be right while the
     * valuation is wrong — a transfer that destroys value, a reversal that
     * credits a different number, rounding that leaks — and a reconciler
     * comparing only counts reports all-clear on exactly those.
     */
    expect(result.valueDrift).toEqual([]);
  });
});
