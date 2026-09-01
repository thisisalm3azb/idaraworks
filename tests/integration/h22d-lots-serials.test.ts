/**
 * H22D — lot and serial identity, expiry, bills of material, assembly.
 *
 * The claim this slice has to make good on: H22A declared `item.tracking` and
 * said the ledger would enforce it, H22B did not, and `itemCostMethod` returned
 * "specific" for a serialised item while `planCost` ordered layers by date —
 * specific identification in name, first-in-first-out in behaviour.
 *
 * So the tests that matter most here are the ones that would still pass under
 * the old code if the identity were cosmetic: issuing a NAMED unit and checking
 * the cost is that unit's own, and issuing from a batch that is neither oldest
 * nor cheapest and checking the charge follows the goods.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  postMovement,
  postGoodsReceiptToStock,
  allocateAndIssueIn,
  reconcileStockBalances,
  createBom,
  activateBom,
  createAssemblyOrder,
  completeAssembly,
  cancelAssemblyOrder,
  InsufficientStockError,
  StockMovementConflictError,
  TrackingRequiredError,
  BomError,
} from "@/modules/inventory/service";
import {
  createPurchaseOrder,
  submitPurchaseOrder,
  recordGoodsReceipt,
  getPurchaseOrder,
  InvalidSupplyInputError,
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
let binMain = "";
let binSecond = "";
let supplierA = "";

const ctxOf = (userId: string): Ctx => ({
  orgId: orgA,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h22d",
});
const ownerCtx = () => ctxOf(userA);
const procCtx = () => ctxOf(procUser);
const key = () => `k-${randomUUID()}`;

/**
 * A date this many days from the DATABASE's today.
 *
 * Never a calendar literal. An expiry written as "2026-10-01" is issuable until
 * that morning and excluded from every allocation afterwards, so a test pinned
 * to one starts failing on a fixed day for a reason that has nothing to do with
 * the defect it covers — and reads like a real regression when it does.
 */
let today = "";
const soon = (days: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function seedItem(
  tracking: "none" | "lot" | "serial",
  expiryTracked = false,
  costMethod: "fifo" | "weighted_average" | null = null,
) {
  const id = randomUUID();
  await owner`
    insert into public.item
      (id, org_id, sku, name, category_key, unit, item_type, base_unit_id, tracking,
       expiry_tracked, cost_method)
    values (${id}, ${orgA}, ${"S-" + randomUUID().slice(0, 8)}, 'Item', 'general', 'ea',
            'inventory', ${unitA}, ${tracking}, ${expiryTracked}, ${costMethod})`;
  return id;
}

/** Order, approve, receive and book — the whole real path, in one call. */
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
    receivedDate: "2026-08-01",
    lines: [{ poLineId: po!.lines[0]!.id, receivedQty: qty, ...tracking }],
  });
  const posted = await postGoodsReceiptToStock(ownerCtx(), "owner", grn.id);
  return { poId, grnId: grn.id, posted };
}

async function onHandAt(itemId: string, locationId: string) {
  const [r] = (await owner`
    select coalesce(sum(qty_delta), 0)::text as q from public.stock_movement
    where org_id = ${orgA} and item_id = ${itemId} and location_id = ${locationId}`) as unknown as Array<{
    q: string;
  }>;
  return Number(r!.q);
}

async function lotIdFor(itemId: string, code: string) {
  const [r] = (await owner`
    select id::text as id from public.stock_lot
    where org_id = ${orgA} and item_id = ${itemId} and code = ${code}`) as unknown as Array<{
    id: string;
  }>;
  return r?.id ?? null;
}

async function serialIdFor(itemId: string, serialNo: string) {
  const [r] = (await owner`
    select id::text as id from public.stock_serial
    where org_id = ${orgA} and item_id = ${itemId} and serial_no = ${serialNo}`) as unknown as Array<{
    id: string;
  }>;
  return r?.id ?? null;
}

beforeAll(async () => {
  const [clock] = (await owner`select current_date::text as d`) as unknown as Array<{ d: string }>;
  today = clock!.d;

  for (const [id, label] of [
    [userA, "owner"],
    [procUser, "proc"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h22d-${label}-${run}@example.com`}, '{"full_name":"H22D"}'::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H22D", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h22d", run);
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
  await owner`
    insert into public.warehouse (id, org_id, code, name_en, created_by)
    values (${whA}, ${orgA}, 'MAIN', 'Main', ${userA})`;
  binMain = randomUUID();
  binSecond = randomUUID();
  await owner`
    insert into public.stock_location
      (id, org_id, warehouse_id, code, name_en, kind, is_default_receiving, is_default_issue)
    values (${binMain}, ${orgA}, ${whA}, 'A1', 'Bin A1', 'storage', true, true),
           (${binSecond}, ${orgA}, ${whA}, 'A2', 'Bin A2', 'storage', false, false)`;
  supplierA = randomUUID();
  await owner`
    insert into public.supplier (id, org_id, name) values (${supplierA}, ${orgA}, 'Supplier')`;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA, procUser]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 300_000);

describe("the ledger refuses a movement that does not say what it moved", () => {
  it("a lot-tracked item cannot move anonymously", { timeout: 240_000 }, async () => {
    const item = await seedItem("lot");
    await expect(
      postMovement(ownerCtx(), "owner", {
        itemId: item,
        warehouseId: whA,
        locationId: binMain,
        movementType: "adjustment_increase",
        qtyDelta: 5,
        unitId: unitA,
        idempotencyKey: key(),
        reason: "no batch named",
      }),
    ).rejects.toBeInstanceOf(TrackingRequiredError);
    expect(await onHandAt(item, binMain), "nothing was posted").toBe(0);
  });

  it("a serialised item cannot move anonymously", { timeout: 240_000 }, async () => {
    const item = await seedItem("serial");
    await expect(
      postMovement(ownerCtx(), "owner", {
        itemId: item,
        warehouseId: whA,
        locationId: binMain,
        movementType: "adjustment_increase",
        qtyDelta: 2,
        unitId: unitA,
        idempotencyKey: key(),
      }),
    ).rejects.toBeInstanceOf(TrackingRequiredError);
  });

  it("an untracked item cannot claim a batch it does not have", { timeout: 240_000 }, async () => {
    const plain = await seedItem("none");
    const tracked = await seedItem("lot");
    await receive(tracked, 5, 100, { lots: [{ lotCode: "L1", qty: 5 }] });
    const strayLot = await lotIdFor(tracked, "L1");
    await expect(
      postMovement(ownerCtx(), "owner", {
        itemId: plain,
        warehouseId: whA,
        locationId: binMain,
        movementType: "adjustment_increase",
        qtyDelta: 1,
        unitId: unitA,
        lots: [{ lotId: strayLot!, qty: 1 }],
        idempotencyKey: key(),
      }),
    ).rejects.toBeInstanceOf(TrackingRequiredError);
  });

  it("the batches named must add up to the quantity moved", { timeout: 240_000 }, async () => {
    const item = await seedItem("lot");
    await receive(item, 10, 100, { lots: [{ lotCode: "ADD", qty: 10 }] });
    const lot = await lotIdFor(item, "ADD");
    await expect(
      postMovement(ownerCtx(), "owner", {
        itemId: item,
        warehouseId: whA,
        locationId: binMain,
        movementType: "adjustment_decrease",
        qtyDelta: -4,
        unitId: unitA,
        // Says four left, names three.
        lots: [{ lotId: lot!, qty: 3 }],
        idempotencyKey: key(),
      }),
    ).rejects.toBeInstanceOf(TrackingRequiredError);
  });

  it("a serialised item moves in whole units", { timeout: 240_000 }, async () => {
    const item = await seedItem("serial");
    await receive(item, 2, 100, { serials: [{ serialNo: "W1" }, { serialNo: "W2" }] });
    const s1 = await serialIdFor(item, "W1");
    await expect(
      postMovement(ownerCtx(), "owner", {
        itemId: item,
        warehouseId: whA,
        locationId: binMain,
        movementType: "adjustment_decrease",
        qtyDelta: -0.5,
        unitId: unitA,
        serialIds: [s1!],
        idempotencyKey: key(),
      }),
    ).rejects.toBeInstanceOf(TrackingRequiredError);
  });
});

describe("receiving a tracked item records what the label said", () => {
  it("refuses to record a lot-tracked delivery with no batch", { timeout: 240_000 }, async () => {
    const item = await seedItem("lot");
    await expect(receive(item, 5, 100)).rejects.toBeInstanceOf(InvalidSupplyInputError);
  });

  it(
    "refuses a batch split that does not match the disposition",
    { timeout: 240_000 },
    async () => {
      const item = await seedItem("lot");
      // 10 arrived, but the batches only account for 7.
      await expect(
        receive(item, 10, 100, { lots: [{ lotCode: "SHORT", qty: 7 }] }),
      ).rejects.toThrow(/batches account for 7/i);
    },
  );

  it("refuses a serial list that does not match the count", { timeout: 240_000 }, async () => {
    const item = await seedItem("serial");
    await expect(
      receive(item, 3, 100, { serials: [{ serialNo: "X1" }, { serialNo: "X2" }] }),
    ).rejects.toThrow(/2 serial number\(s\) were recorded/i);
  });

  it("creates the batch on POSTING, not on recording", { timeout: 300_000 }, async () => {
    const item = await seedItem("lot");
    const { id: poId } = await createPurchaseOrder(procCtx(), "procurement", {
      supplierId: supplierA,
      lines: [{ itemId: item, itemName: "Ordered", qty: 6, unit: "ea", unitCostMinor: 100 }],
    });
    const { approvalId } = await submitPurchaseOrder(procCtx(), "procurement", poId);
    await decideApproval(ownerCtx(), "owner", { approvalId, decision: "approved" });
    const po = await getPurchaseOrder(procCtx(), "procurement", poId);
    const grn = await recordGoodsReceipt(procCtx(), "procurement", {
      poId,
      receivedDate: "2026-08-02",
      lines: [
        {
          poLineId: po!.lines[0]!.id,
          receivedQty: 6,
          lots: [{ lotCode: "LATER", qty: 6, expiryDate: soon(300) }],
        },
      ],
    });
    // Recorded but not posted: the document says the batch, stock does not.
    expect(await lotIdFor(item, "LATER"), "no batch before posting").toBeNull();

    await postGoodsReceiptToStock(ownerCtx(), "owner", grn.id);
    const lot = await lotIdFor(item, "LATER");
    expect(lot, "the batch exists once the goods do").not.toBeNull();
    const [row] = (await owner`
      select expiry_date::text as expiry, status from public.stock_lot where id = ${lot}`) as unknown as Array<{
      expiry: string;
      status: string;
    }>;
    expect(row!.expiry).toBe(soon(300));
    expect(row!.status).toBe("active");
    expect(await onHandAt(item, binMain)).toBe(6);
  });

  it("registers each serialised unit where it landed", { timeout: 300_000 }, async () => {
    const item = await seedItem("serial");
    await receive(item, 3, 250, {
      serials: [{ serialNo: "SN-1" }, { serialNo: "SN-2" }, { serialNo: "SN-3" }],
    });
    const rows = (await owner`
      select serial_no, status, location_id::text as location_id
      from public.stock_serial where org_id = ${orgA} and item_id = ${item}
      order by serial_no`) as unknown as Array<Record<string, string>>;
    expect(rows.map((r) => r.serial_no)).toEqual(["SN-1", "SN-2", "SN-3"]);
    expect(rows.every((r) => r.status === "in_stock")).toBe(true);
    expect(rows.every((r) => r.location_id === binMain)).toBe(true);
    expect(await onHandAt(item, binMain)).toBe(3);
  });

  it("refuses a unit that is already in stock", { timeout: 300_000 }, async () => {
    const item = await seedItem("serial");
    await receive(item, 1, 100, { serials: [{ serialNo: "DUP-1" }] });
    await expect(
      receive(item, 1, 100, { serials: [{ serialNo: "DUP-1" }] }),
    ).rejects.toBeInstanceOf(StockMovementConflictError);
  });

  it("a second delivery of the same batch is the same batch", { timeout: 300_000 }, async () => {
    const item = await seedItem("lot");
    await receive(item, 4, 100, { lots: [{ lotCode: "SAME", qty: 4 }] });
    await receive(item, 6, 100, { lots: [{ lotCode: "SAME", qty: 6 }] });
    const rows = (await owner`
      select count(*)::int as n from public.stock_lot
      where org_id = ${orgA} and item_id = ${item} and code = 'SAME'`) as unknown as Array<{
      n: number;
    }>;
    expect(rows[0]!.n, "one batch, two deliveries").toBe(1);
    expect(await onHandAt(item, binMain)).toBe(10);
  });
});

describe("issuing follows expiry, not arrival", () => {
  it("takes the batch that expires first", { timeout: 300_000 }, async () => {
    const item = await seedItem("lot", true);
    // OLD arrives first but expires later; NEW arrives second and expires sooner.
    await receive(item, 10, 100, { lots: [{ lotCode: "OLD", qty: 10, expiryDate: soon(500) }] });
    await receive(item, 10, 100, { lots: [{ lotCode: "NEW", qty: 10, expiryDate: soon(90) }] });

    const ctx = ownerCtx();
    const { legs } = await withCtx(ctx, (tx) =>
      allocateAndIssueIn(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 6,
        movementType: "material_issue",
        idempotencyKey: key(),
      }),
    );
    const newLot = await lotIdFor(item, "NEW");
    expect(legs[0]!.lots, "first expiry, first out").toEqual([{ lotId: newLot, qty: 6 }]);
  });

  it("never issues an expired batch", { timeout: 300_000 }, async () => {
    const item = await seedItem("lot", true);
    await receive(item, 8, 100, { lots: [{ lotCode: "GONE", qty: 8, expiryDate: soon(120) }] });
    // Time passes. The date is what decides, not a status somebody remembered.
    await owner`
      update public.stock_lot set expiry_date = current_date - 1
      where org_id = ${orgA} and item_id = ${item} and code = 'GONE'`;

    const ctx = ownerCtx();
    await expect(
      withCtx(ctx, (tx) =>
        allocateAndIssueIn(tx, ctx, {
          itemId: item,
          unitId: unitA,
          qty: 1,
          movementType: "material_issue",
          idempotencyKey: key(),
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await onHandAt(item, binMain), "the expired stock is still there, just unissuable").toBe(
      8,
    );
  });

  it("never issues a recalled batch", { timeout: 300_000 }, async () => {
    const item = await seedItem("lot");
    await receive(item, 5, 100, { lots: [{ lotCode: "BAD", qty: 5 }] });
    await receive(item, 5, 100, { lots: [{ lotCode: "GOOD", qty: 5 }] });
    await owner`
      update public.stock_lot set status = 'recalled'
      where org_id = ${orgA} and item_id = ${item} and code = 'BAD'`;

    const ctx = ownerCtx();
    const { legs } = await withCtx(ctx, (tx) =>
      allocateAndIssueIn(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 5,
        movementType: "material_issue",
        idempotencyKey: key(),
      }),
    );
    const good = await lotIdFor(item, "GOOD");
    expect(legs[0]!.lots).toEqual([{ lotId: good, qty: 5 }]);

    // And the recalled five cannot be reached even though the bin holds ten.
    await expect(
      withCtx(ctx, (tx) =>
        allocateAndIssueIn(tx, ctx, {
          itemId: item,
          unitId: unitA,
          qty: 1,
          movementType: "material_issue",
          idempotencyKey: key(),
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it("spans batches when one is not enough", { timeout: 300_000 }, async () => {
    const item = await seedItem("lot", true);
    await receive(item, 4, 100, { lots: [{ lotCode: "F1", qty: 4, expiryDate: soon(60) }] });
    await receive(item, 9, 100, { lots: [{ lotCode: "F2", qty: 9, expiryDate: soon(400) }] });
    const ctx = ownerCtx();
    const { legs } = await withCtx(ctx, (tx) =>
      allocateAndIssueIn(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 7,
        movementType: "material_issue",
        idempotencyKey: key(),
      }),
    );
    expect(legs[0]!.lots).toEqual([
      { lotId: await lotIdFor(item, "F1"), qty: 4 },
      { lotId: await lotIdFor(item, "F2"), qty: 3 },
    ]);
  });
});

describe("cost follows the goods, which is what specific identification means", () => {
  it("issuing a NAMED unit charges that unit's own cost", { timeout: 300_000 }, async () => {
    const item = await seedItem("serial");
    // The cheap one arrives FIRST. Under first-in-first-out the charge would be
    // 100 whichever unit went out, so this is the test that tells the two apart.
    await receive(item, 1, 100, { serials: [{ serialNo: "CHEAP" }] });
    await receive(item, 1, 900, { serials: [{ serialNo: "DEAR" }] });

    const dear = await serialIdFor(item, "DEAR");
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
    // Allocation picks oldest-first, so it took CHEAP: cost 100, not an average.
    expect(movements[0]!.costTotalMinor).toBe(100);

    // Now take the expensive one deliberately and prove the charge follows it.
    const posted = await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binMain,
      movementType: "material_issue",
      qtyDelta: -1,
      unitId: unitA,
      serialIds: [dear!],
      idempotencyKey: key(),
    });
    expect(posted.costTotalMinor, "the dear unit costs what the dear unit cost").toBe(900);
  });

  it(
    "under FIFO a batch is charged at ITS cost, not the oldest one's",
    { timeout: 300_000 },
    async () => {
      const item = await seedItem("lot", true, "fifo");
      // Cheap batch arrives first but expires last; dear batch expires first, so
      // FEFO picks the dear one — and the charge must follow the goods, not the
      // calendar. Under a blind first-in-first-out this would charge 200.
      await receive(item, 5, 200, { lots: [{ lotCode: "C", qty: 5, expiryDate: soon(500) }] });
      await receive(item, 5, 800, { lots: [{ lotCode: "D", qty: 5, expiryDate: soon(30) }] });

      const ctx = ownerCtx();
      const { movements, legs } = await withCtx(ctx, (tx) =>
        allocateAndIssueIn(tx, ctx, {
          itemId: item,
          unitId: unitA,
          qty: 3,
          movementType: "material_issue",
          idempotencyKey: key(),
        }),
      );
      expect(legs[0]!.lots![0]!.lotId).toBe(await lotIdFor(item, "D"));
      expect(movements[0]!.costTotalMinor, "3 at the dear batch's 800").toBe(2400);
    },
  );

  it(
    "under weighted average the charge is the average, as the standard requires",
    { timeout: 300_000 },
    async () => {
      /*
       * Batch tracking does not make an item non-interchangeable — two batches of
       * the same medicine are the same medicine, and the batch exists for recall
       * and expiry, not because the units differ in nature. So IAS 2.25 still
       * permits weighted average here, and the charge is the average even though
       * the LAYERS drawn are the picked batch's own.
       */
      const item = await seedItem("lot", true, "weighted_average");
      await receive(item, 5, 200, { lots: [{ lotCode: "WA-C", qty: 5, expiryDate: soon(500) }] });
      await receive(item, 5, 800, { lots: [{ lotCode: "WA-D", qty: 5, expiryDate: soon(30) }] });

      const ctx = ownerCtx();
      const { movements, legs } = await withCtx(ctx, (tx) =>
        allocateAndIssueIn(tx, ctx, {
          itemId: item,
          unitId: unitA,
          qty: 3,
          movementType: "material_issue",
          idempotencyKey: key(),
        }),
      );
      // FEFO still governs which goods physically leave.
      expect(legs[0]!.lots![0]!.lotId).toBe(await lotIdFor(item, "WA-D"));
      // (5x200 + 5x800) / 10 = 500 each.
      expect(movements[0]!.costTotalMinor, "3 at the running average of 500").toBe(1500);
    },
  );

  it("the layers drawn are the layers of the batch that left", { timeout: 300_000 }, async () => {
    const item = await seedItem("lot", true);
    await receive(item, 5, 200, { lots: [{ lotCode: "L-KEEP", qty: 5, expiryDate: soon(900) }] });
    await receive(item, 5, 800, { lots: [{ lotCode: "L-GO", qty: 5, expiryDate: soon(10) }] });
    const ctx = ownerCtx();
    await withCtx(ctx, (tx) =>
      allocateAndIssueIn(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 5,
        movementType: "material_issue",
        idempotencyKey: key(),
      }),
    );
    const rows = (await owner`
      select l.lot_id::text as lot_id, l.qty_remaining::text as remaining
      from public.stock_cost_layer l
      where l.org_id = ${orgA} and l.item_id = ${item}
      order by l.unit_cost_minor`) as unknown as Array<{ lot_id: string; remaining: string }>;
    const keep = await lotIdFor(item, "L-KEEP");
    const go = await lotIdFor(item, "L-GO");
    const byLot = new Map(rows.map((r) => [r.lot_id, Number(r.remaining)]));
    expect(byLot.get(keep!), "the kept batch is untouched").toBe(5);
    expect(byLot.get(go!), "the batch that left is drawn to nothing").toBe(0);
  });
});

describe("a batch that runs out says so", () => {
  it("is marked depleted, and stops being offered", { timeout: 300_000 }, async () => {
    const item = await seedItem("lot");
    await receive(item, 3, 100, { lots: [{ lotCode: "EMPTY", qty: 3 }] });
    const ctx = ownerCtx();
    await withCtx(ctx, (tx) =>
      allocateAndIssueIn(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 3,
        movementType: "material_issue",
        idempotencyKey: key(),
      }),
    );
    const [row] = (await owner`
      select status from public.stock_lot
      where org_id = ${orgA} and item_id = ${item} and code = 'EMPTY'`) as unknown as Array<{
      status: string;
    }>;
    expect(row!.status).toBe("depleted");
  });
});

describe("the batch projection is reconcilable", () => {
  it("reports lot drift rather than repairing it", { timeout: 300_000 }, async () => {
    const item = await seedItem("lot");
    await receive(item, 7, 100, { lots: [{ lotCode: "DRIFT", qty: 7 }] });
    const lot = await lotIdFor(item, "DRIFT");

    const clean = await reconcileStockBalances(ownerCtx(), "owner");
    expect(clean.lotDrift, "nothing wrong to begin with").toEqual([]);

    // Corrupt the projection behind the ledger's back.
    await owner`
      update public.stock_lot_balance set on_hand = 999
      where org_id = ${orgA} and lot_id = ${lot}`;

    const dirty = await reconcileStockBalances(ownerCtx(), "owner");
    const found = dirty.lotDrift.find((d) => d.lotId === lot);
    expect(found, "the drift is reported").toBeDefined();
    expect(Number(found!.storedOnHand)).toBe(999);
    expect(Number(found!.ledgerOnHand), "the ledger is the truth").toBe(7);

    const [still] = (await owner`
      select on_hand::text as q from public.stock_lot_balance
      where org_id = ${orgA} and lot_id = ${lot}`) as unknown as Array<{ q: string }>;
    expect(Number(still!.q), "and NOT silently corrected").toBe(999);

    // Explicit repair rewrites the projection from the ledger, never the reverse.
    const repaired = await reconcileStockBalances(ownerCtx(), "owner", { repair: true });
    expect(repaired.repaired).toBe(true);
    const [fixed] = (await owner`
      select on_hand::text as q from public.stock_lot_balance
      where org_id = ${orgA} and lot_id = ${lot}`) as unknown as Array<{ q: string }>;
    expect(Number(fixed!.q)).toBe(7);
  });
});

describe("bills of material are versioned, never edited", () => {
  it("activating a new version archives the old one", { timeout: 300_000 }, async () => {
    const parent = await seedItem("none");
    const partA = await seedItem("none");
    const partB = await seedItem("none");

    const v1 = await createBom(ownerCtx(), "owner", {
      itemId: parent,
      unitId: unitA,
      lines: [{ componentItemId: partA, qtyPer: 2, unitId: unitA }],
    });
    expect(v1.version).toBe(1);
    await activateBom(ownerCtx(), "owner", v1.id);

    const v2 = await createBom(ownerCtx(), "owner", {
      itemId: parent,
      unitId: unitA,
      lines: [
        { componentItemId: partA, qtyPer: 3, unitId: unitA },
        { componentItemId: partB, qtyPer: 1, unitId: unitA },
      ],
    });
    expect(v2.version).toBe(2);
    const activated = await activateBom(ownerCtx(), "owner", v2.id);
    expect(activated.replaced, "the old one was retired, not overwritten").toBe(v1.id);

    const rows = (await owner`
      select version, status from public.bom
      where org_id = ${orgA} and item_id = ${parent} order by version`) as unknown as Array<{
      version: number;
      status: string;
    }>;
    expect(rows.map((r) => `${r.version}:${r.status}`)).toEqual(["1:archived", "2:active"]);
  });

  it("nothing is made of itself", { timeout: 240_000 }, async () => {
    const item = await seedItem("none");
    await expect(
      createBom(ownerCtx(), "owner", {
        itemId: item,
        unitId: unitA,
        lines: [{ componentItemId: item, qtyPer: 1, unitId: unitA }],
      }),
    ).rejects.toBeInstanceOf(BomError);
  });

  it("a longer cycle is refused too", { timeout: 300_000 }, async () => {
    const a = await seedItem("none");
    const b = await seedItem("none");
    // B is made from A, and is active.
    const bomB = await createBom(ownerCtx(), "owner", {
      itemId: b,
      unitId: unitA,
      lines: [{ componentItemId: a, qtyPer: 1, unitId: unitA }],
    });
    await activateBom(ownerCtx(), "owner", bomB.id);
    // Now try to make A from B, which can never be resolved.
    await expect(
      createBom(ownerCtx(), "owner", {
        itemId: a,
        unitId: unitA,
        lines: [{ componentItemId: b, qtyPer: 1, unitId: unitA }],
      }),
    ).rejects.toBeInstanceOf(BomError);
  });

  it("refuses to name the same component twice", { timeout: 240_000 }, async () => {
    const parent = await seedItem("none");
    const part = await seedItem("none");
    await expect(
      createBom(ownerCtx(), "owner", {
        itemId: parent,
        unitId: unitA,
        lines: [
          { componentItemId: part, qtyPer: 1, unitId: unitA },
          { componentItemId: part, qtyPer: 2, unitId: unitA },
        ],
      }),
    ).rejects.toBeInstanceOf(BomError);
  });

  it("an archived recipe cannot come back", { timeout: 300_000 }, async () => {
    const parent = await seedItem("none");
    const part = await seedItem("none");
    const v1 = await createBom(ownerCtx(), "owner", {
      itemId: parent,
      unitId: unitA,
      lines: [{ componentItemId: part, qtyPer: 1, unitId: unitA }],
    });
    await activateBom(ownerCtx(), "owner", v1.id);
    const v2 = await createBom(ownerCtx(), "owner", {
      itemId: parent,
      unitId: unitA,
      lines: [{ componentItemId: part, qtyPer: 2, unitId: unitA }],
    });
    await activateBom(ownerCtx(), "owner", v2.id);
    await expect(activateBom(ownerCtx(), "owner", v1.id)).rejects.toBeInstanceOf(BomError);
  });
});

describe("making and unmaking", () => {
  async function recipe(parent: string, parts: Array<{ id: string; qtyPer: number }>) {
    const bom = await createBom(ownerCtx(), "owner", {
      itemId: parent,
      unitId: unitA,
      lines: parts.map((p) => ({ componentItemId: p.id, qtyPer: p.qtyPer, unitId: unitA })),
    });
    await activateBom(ownerCtx(), "owner", bom.id);
    return bom.id;
  }

  it("the parent is worth what went into it", { timeout: 600_000 }, async () => {
    const parent = await seedItem("none");
    const partA = await seedItem("none");
    const partB = await seedItem("none");
    await recipe(parent, [
      { id: partA, qtyPer: 2 },
      { id: partB, qtyPer: 3 },
    ]);
    await receive(partA, 20, 150);
    await receive(partB, 30, 40);

    const order = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 5,
      warehouseId: whA,
    });
    expect(order.lines).toBe(2);
    const result = await completeAssembly(ownerCtx(), "owner", order.id);

    // 10 of A at 150 = 1500, 15 of B at 40 = 600.
    expect(result.consumedCostMinor).toBe(2100);
    expect(result.producedQty).toBe(5);
    expect(await onHandAt(partA, binMain), "20 - 10").toBe(10);
    expect(await onHandAt(partB, binMain), "30 - 15").toBe(15);
    expect(await onHandAt(parent, binMain)).toBe(5);

    const [made] = (await owner`
      select unit_cost_minor::text as unit_cost, cost_total_minor::text as total
      from public.stock_movement
      where org_id = ${orgA} and item_id = ${parent} and movement_type = 'assembly_produce'`) as unknown as Array<
      Record<string, string>
    >;
    expect(Number(made!.unit_cost), "2100 over 5").toBe(420);
    expect(Number(made!.total)).toBe(2100);
  });

  it("scrap is issued on top of what ends up in the product", { timeout: 600_000 }, async () => {
    const parent = await seedItem("none");
    const part = await seedItem("none");
    const bom = await createBom(ownerCtx(), "owner", {
      itemId: parent,
      unitId: unitA,
      lines: [{ componentItemId: part, qtyPer: 10, unitId: unitA, scrapPct: 10 }],
    });
    await activateBom(ownerCtx(), "owner", bom.id);
    await receive(part, 50, 10);

    const order = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 2,
      warehouseId: whA,
    });
    const [line] = (await owner`
      select qty::text as qty from public.assembly_order_line
      where org_id = ${orgA} and order_id = ${order.id}`) as unknown as Array<{ qty: string }>;
    // 10 per unit x 2 = 20, plus 10% expected loss.
    expect(Number(line!.qty)).toBe(22);
  });

  it("a build cannot happen twice", { timeout: 600_000 }, async () => {
    const parent = await seedItem("none");
    const part = await seedItem("none");
    await recipe(parent, [{ id: part, qtyPer: 1 }]);
    await receive(part, 10, 100);

    const order = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 3,
      warehouseId: whA,
    });
    await completeAssembly(ownerCtx(), "owner", order.id);
    await expect(completeAssembly(ownerCtx(), "owner", order.id)).rejects.toBeInstanceOf(
      StockMovementConflictError,
    );
    expect(await onHandAt(part, binMain), "3 consumed, once").toBe(7);
    expect(await onHandAt(parent, binMain)).toBe(3);
  });

  it("a build that cannot be supplied posts nothing", { timeout: 600_000 }, async () => {
    const parent = await seedItem("none");
    const partA = await seedItem("none");
    const partB = await seedItem("none");
    await recipe(parent, [
      { id: partA, qtyPer: 1 },
      { id: partB, qtyPer: 1 },
    ]);
    // The first component is there, the second is not.
    await receive(partA, 10, 100);

    const order = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 4,
      warehouseId: whA,
    });
    await expect(completeAssembly(ownerCtx(), "owner", order.id)).rejects.toBeInstanceOf(
      InsufficientStockError,
    );
    expect(await onHandAt(partA, binMain), "the first component was NOT taken").toBe(10);
    expect(await onHandAt(parent, binMain)).toBe(0);
    const [status] = (await owner`
      select status from public.assembly_order where id = ${order.id}`) as unknown as Array<{
      status: string;
    }>;
    expect(status!.status, "and the order did not complete").toBe("draft");
  });

  it("taking a thing apart neither creates nor destroys value", { timeout: 600_000 }, async () => {
    const parent = await seedItem("none");
    const partA = await seedItem("none");
    const partB = await seedItem("none");
    await recipe(parent, [
      { id: partA, qtyPer: 1 },
      { id: partB, qtyPer: 1 },
    ]);
    await receive(partA, 10, 300);
    await receive(partB, 10, 100);

    const build = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 4,
      warehouseId: whA,
    });
    const made = await completeAssembly(ownerCtx(), "owner", build.id);
    expect(made.consumedCostMinor).toBe(4 * 300 + 4 * 100);

    const teardown = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 2,
      warehouseId: whA,
      direction: "disassemble",
    });
    const undone = await completeAssembly(ownerCtx(), "owner", teardown.id);
    expect(undone.direction).toBe("disassemble");
    // 2 parents at 400 each came out of stock.
    expect(undone.consumedCostMinor).toBe(800);

    expect(await onHandAt(parent, binMain), "4 built, 2 taken apart").toBe(2);
    expect(await onHandAt(partA, binMain), "10 - 4 + 2").toBe(8);
    expect(await onHandAt(partB, binMain)).toBe(8);

    // Scoped to THIS teardown: an org-wide sum would silently absorb any other
    // disassembly in the fixture and read as a value-conservation failure.
    const [back] = (await owner`
      select coalesce(sum(m.cost_total_minor), 0)::text as total
      from public.stock_movement m
      join public.assembly_order_line l on l.id = m.source_id and l.org_id = m.org_id
      where m.org_id = ${orgA} and m.movement_type = 'disassembly_produce'
        and l.order_id = ${teardown.id}`) as unknown as Array<{
      total: string;
    }>;
    expect(Number(back!.total), "what left the parent is what entered the parts").toBe(800);
  });

  it("only a draft can be cancelled", { timeout: 600_000 }, async () => {
    const parent = await seedItem("none");
    const part = await seedItem("none");
    await recipe(parent, [{ id: part, qtyPer: 1 }]);
    await receive(part, 5, 100);

    const cancellable = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 1,
      warehouseId: whA,
    });
    await cancelAssemblyOrder(ownerCtx(), "owner", cancellable.id);
    await expect(completeAssembly(ownerCtx(), "owner", cancellable.id)).rejects.toBeInstanceOf(
      StockMovementConflictError,
    );

    const done = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 1,
      warehouseId: whA,
    });
    await completeAssembly(ownerCtx(), "owner", done.id);
    await expect(cancelAssemblyOrder(ownerCtx(), "owner", done.id)).rejects.toBeInstanceOf(
      StockMovementConflictError,
    );
  });

  it("a build of a lot-tracked component honours expiry", { timeout: 600_000 }, async () => {
    const parent = await seedItem("none");
    const part = await seedItem("lot", true);
    await recipe(parent, [{ id: part, qtyPer: 2 }]);
    await receive(part, 10, 100, { lots: [{ lotCode: "B-OLD", qty: 10, expiryDate: soon(500) }] });
    await receive(part, 10, 100, { lots: [{ lotCode: "B-SOON", qty: 10, expiryDate: soon(30) }] });

    const order = await createAssemblyOrder(ownerCtx(), "owner", {
      itemId: parent,
      qty: 3,
      warehouseId: whA,
    });
    await completeAssembly(ownerCtx(), "owner", order.id);

    const expiringFirst = await lotIdFor(part, "B-SOON");
    const [drawn] = (await owner`
      select coalesce(sum(ml.qty), 0)::text as q
      from public.stock_movement_lot ml
      join public.stock_movement m on m.id = ml.movement_id and m.org_id = ml.org_id
      where ml.org_id = ${orgA} and ml.lot_id = ${expiringFirst}
        and m.movement_type = 'assembly_consume'`) as unknown as Array<{ q: string }>;
    expect(Number(drawn!.q), "6 taken from the batch expiring first").toBe(-6);
  });
});

describe("the whole thing still reconciles", () => {
  it("no drift in either projection", { timeout: 600_000 }, async () => {
    const result = await reconcileStockBalances(ownerCtx(), "owner");
    expect(result.drift).toEqual([]);
    expect(result.lotDrift).toEqual([]);
  });
});
