/**
 * H22C.1 — foreign-currency purchasing, multi-location issuing, and receipt
 * disposition with supplier returns.
 *
 * The three things H22C left open, each tested at the point where getting it
 * wrong would be silent: a rate that defaults to 1, an issue that takes what it
 * can find, and damaged goods that quietly become sellable stock.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  planAllocation,
  allocateAndIssueIn,
  postMovement,
  sendSupplierReturn,
  reconcileStockBalances,
  InsufficientStockError,
  StockMovementConflictError,
  postConsumptionToStock,
  postGoodsReceiptToStock,
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
/** A second person, so the owner is approving someone else's order. */
const procUser = randomUUID();
let orgA = "";
let unitA = "";
let whA = "";
let binMain = "";
let binSecond = "";
let binQuarantine = "";
let binDamaged = "";
let supplierA = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h22c1",
});

const key = () => `k-${randomUUID()}`;

async function seedItem() {
  const id = randomUUID();
  await owner`
    insert into public.item (id, org_id, sku, name, category_key, unit, item_type, base_unit_id)
    values (${id}, ${orgA}, ${"S-" + randomUUID().slice(0, 8)}, 'Item', 'general', 'ea',
            'inventory', ${unitA})`;
  return id;
}

/** Put a known quantity in a known bin. */
async function stockIn(itemId: string, locationId: string, qty: number, cost = 100) {
  await postMovement(ctxOf(orgA, userA), "owner", {
    itemId,
    warehouseId: whA,
    locationId,
    movementType: "adjustment_increase",
    qtyDelta: qty,
    unitId: unitA,
    unitCostMinor: cost,
    currency: "AED",
    exchangeRate: 1,
    idempotencyKey: key(),
    reason: "seed",
  });
}

async function onHandAt(itemId: string, locationId: string) {
  const [r] = (await owner`
    select coalesce(sum(qty_delta), 0)::text as q from public.stock_movement
    where org_id = ${orgA} and item_id = ${itemId} and location_id = ${locationId}`) as unknown as Array<{
    q: string;
  }>;
  return Number(r!.q);
}

beforeAll(async () => {
  for (const [id, label] of [
    [userA, "owner"],
    [procUser, "proc"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h22c1-${label}-${run}@example.com`}, '{"full_name":"H22C1"}'::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H22C1", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h22c1", run);
  await owner`
    insert into public.membership (user_id, org_id, role_key)
    values (${procUser}, ${orgA}, 'procurement')`;
  // Purchase orders route to the owner, so the buyer never decides their own.
  await createApprovalRule(ctxOf(orgA, userA), "owner", {
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
  binQuarantine = randomUUID();
  binDamaged = randomUUID();
  await owner`
    insert into public.stock_location
      (id, org_id, warehouse_id, code, name_en, kind, is_default_receiving, is_default_issue)
    values (${binMain}, ${orgA}, ${whA}, 'A1', 'Bin A1', 'storage', true, true),
           (${binSecond}, ${orgA}, ${whA}, 'A2', 'Bin A2', 'storage', false, false),
           (${binQuarantine}, ${orgA}, ${whA}, 'QUAR', 'Quarantine', 'quarantine', false, false),
           (${binDamaged}, ${orgA}, ${whA}, 'DMG', 'Damaged', 'damaged', false, false)`;
  supplierA = randomUUID();
  await owner`
    insert into public.supplier (id, org_id, name) values (${supplierA}, ${orgA}, 'Supplier')`;
}, 300_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA, procUser]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 180_000);

describe("a purchase order states its currency and an audited rate", () => {
  const newPo = (currency: string, rate: number | null, source: string) =>
    owner`
      insert into public.purchase_order
        (org_id, reference, supplier_id, created_by, currency, base_currency,
         exchange_rate, rate_date, rate_source, total_minor, base_total_minor)
      values (${orgA}, ${"PO-" + randomUUID().slice(0, 8)}, ${supplierA}, ${userA},
              ${currency}, 'AED', ${rate}, current_date, ${source}, 10000,
              ${rate === null ? 10000 : Math.round(10000 * rate)})`;

  it("accepts a same-currency order at rate 1", { timeout: 120_000 }, async () => {
    await expect(newPo("AED", 1, "same_currency")).resolves.toBeDefined();
  });

  it("accepts a foreign order with a real rate", { timeout: 120_000 }, async () => {
    await expect(newPo("USD", 3.6725, "manual")).resolves.toBeDefined();
  });

  it("REFUSES a foreign order silently defaulted to rate 1", { timeout: 120_000 }, async () => {
    // The whole point: "we forgot the rate" must not look like "the rate is one".
    await expect(newPo("USD", 1, "manual")).rejects.toThrow(/purchase_order_rate_ck/i);
  });

  it("refuses a same-currency order at any rate but 1", { timeout: 120_000 }, async () => {
    await expect(newPo("AED", 3.6725, "manual")).rejects.toThrow(/purchase_order_rate_ck/i);
  });

  it("refuses a foreign order with no rate at all", { timeout: 120_000 }, async () => {
    await expect(newPo("USD", null, "manual")).rejects.toThrow();
  });

  it("refuses a legacy interpretation of a foreign currency", { timeout: 120_000 }, async () => {
    // 'legacy_base' means "written before currencies existed, read as base".
    // Attaching it to a foreign currency would be inventing history.
    await expect(newPo("USD", 3.6725, "legacy_base")).rejects.toThrow(
      /purchase_order_legacy_same_ck/i,
    );
  });

  it("existing orders were interpreted, not converted", { timeout: 120_000 }, async () => {
    const [row] = (await owner`
      select currency, base_currency, exchange_rate::text as rate, rate_source
      from public.purchase_order where org_id = ${orgA} and rate_source = 'legacy_base'
      limit 1`) as unknown as Array<Record<string, string>>;
    // This org has no pre-migration orders, so absence is the correct result and
    // the assertion is that nothing was invented for it.
    expect(row === undefined || row.currency === row.base_currency).toBe(true);
  });

  it("freezes currency and rate once the order leaves draft", { timeout: 120_000 }, async () => {
    const poId = randomUUID();
    await owner`
      insert into public.purchase_order
        (id, org_id, reference, supplier_id, created_by, currency, base_currency,
         exchange_rate, rate_date, rate_source, total_minor, base_total_minor)
      values (${poId}, ${orgA}, ${"PO-" + randomUUID().slice(0, 8)}, ${supplierA}, ${userA},
              'USD', 'AED', 3.6725, current_date, 'manual', 10000, 36725)`;
    // A draft may still be corrected.
    await expect(
      owner`update public.purchase_order set exchange_rate = 3.68 where id = ${poId}`,
    ).resolves.toBeDefined();
    await owner`update public.purchase_order set status = 'approved' where id = ${poId}`;
    // Once issued it is part of what the supplier was told.
    await expect(
      owner`update public.purchase_order set exchange_rate = 4.0 where id = ${poId}`,
    ).rejects.toThrow(/cannot change|revision/i);
    await expect(
      owner`update public.purchase_order set currency = 'EUR' where id = ${poId}`,
    ).rejects.toThrow(/cannot change|revision/i);
  });
});

describe("issuing allocates across locations", () => {
  it("splits a quantity across bins, preferring the default", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    await stockIn(item, binMain, 6);
    await stockIn(item, binSecond, 10);

    const ctx = ctxOf(orgA, userA);
    const { legs } = await withCtx(ctx, (tx) =>
      allocateAndIssueIn(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 12,
        movementType: "material_issue",
        idempotencyKey: key(),
      }),
    );
    expect(legs).toHaveLength(2);
    // The default issue bin goes first, then the rest comes from the other.
    expect(legs[0]!.locationId).toBe(binMain);
    expect(legs[0]!.qty).toBe(6);
    expect(legs[1]!.locationId).toBe(binSecond);
    expect(legs[1]!.qty).toBe(6);
    expect(await onHandAt(item, binMain)).toBe(0);
    expect(await onHandAt(item, binSecond)).toBe(4);
  });

  it("fails with NO movement when the total is short", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    await stockIn(item, binMain, 3);
    await stockIn(item, binSecond, 4);

    const ctx = ctxOf(orgA, userA);
    await expect(
      withCtx(ctx, (tx) =>
        allocateAndIssueIn(tx, ctx, {
          itemId: item,
          unitId: unitA,
          qty: 20,
          movementType: "material_issue",
          idempotencyKey: key(),
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    // All or nothing: the bins it COULD have taken from are untouched.
    expect(await onHandAt(item, binMain)).toBe(3);
    expect(await onHandAt(item, binSecond)).toBe(4);
  });

  it("never draws from quarantine or damaged locations", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    await stockIn(item, binMain, 2);
    await stockIn(item, binQuarantine, 50);
    await stockIn(item, binDamaged, 50);

    const ctx = ctxOf(orgA, userA);
    // 2 available in storage; the 100 in quarantine and damaged do not count.
    await expect(
      withCtx(ctx, (tx) =>
        allocateAndIssueIn(tx, ctx, {
          itemId: item,
          unitId: unitA,
          qty: 10,
          movementType: "material_issue",
          idempotencyKey: key(),
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await onHandAt(item, binQuarantine), "quarantine untouched").toBe(50);
    expect(await onHandAt(item, binDamaged), "damaged untouched").toBe(50);
  });

  it(
    "naming a quarantine bin explicitly does not make it issuable",
    { timeout: 240_000 },
    async () => {
      const item = await seedItem();
      await stockIn(item, binQuarantine, 20);
      const ctx = ctxOf(orgA, userA);
      await expect(
        withCtx(ctx, (tx) =>
          allocateAndIssueIn(tx, ctx, {
            itemId: item,
            unitId: unitA,
            qty: 5,
            movementType: "material_issue",
            locationIds: [binQuarantine],
            idempotencyKey: key(),
          }),
        ),
      ).rejects.toBeInstanceOf(InsufficientStockError);
      expect(await onHandAt(item, binQuarantine)).toBe(20);
    },
  );

  it("honours an explicit location list, in the order given", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    await stockIn(item, binMain, 10);
    await stockIn(item, binSecond, 10);
    const ctx = ctxOf(orgA, userA);
    // Second bin named FIRST: the caller's order wins over the default.
    const { legs } = await withCtx(ctx, (tx) =>
      allocateAndIssueIn(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 12,
        movementType: "material_issue",
        locationIds: [binSecond, binMain],
        idempotencyKey: key(),
      }),
    );
    expect(legs[0]!.locationId).toBe(binSecond);
    expect(legs[0]!.qty).toBe(10);
    expect(legs[1]!.locationId).toBe(binMain);
    expect(legs[1]!.qty).toBe(2);
  });

  it("concurrent allocations cannot oversell the same bins", { timeout: 300_000 }, async () => {
    const item = await seedItem();
    await stockIn(item, binMain, 5);
    await stockIn(item, binSecond, 5);
    const ctx = ctxOf(orgA, userA);
    // Six racers want 4 each from a total of 10: at most two can win.
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        withCtx(ctx, (tx) =>
          allocateAndIssueIn(tx, ctx, {
            itemId: item,
            unitId: unitA,
            qty: 4,
            movementType: "material_issue",
            idempotencyKey: key(),
          }),
        ),
      ),
    );
    const won = results.filter((r) => r.status === "fulfilled").length;
    expect(won).toBeLessThanOrEqual(2);
    const total = (await onHandAt(item, binMain)) + (await onHandAt(item, binSecond));
    expect(total, "never negative, never oversold").toBe(10 - won * 4);
    expect(total).toBeGreaterThanOrEqual(0);
  });

  it("a retry of the same issue posts nothing further", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    await stockIn(item, binMain, 4);
    await stockIn(item, binSecond, 4);
    const ctx = ctxOf(orgA, userA);
    const k = key();
    const once = await withCtx(ctx, (tx) =>
      allocateAndIssueIn(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 6,
        movementType: "material_issue",
        idempotencyKey: k,
      }),
    );
    expect(once.legs).toHaveLength(2);
    const twice = await withCtx(ctx, (tx) =>
      allocateAndIssueIn(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 6,
        movementType: "material_issue",
        idempotencyKey: k,
      }),
    );
    expect(
      twice.movements.every((m) => !m.posted),
      "the retry posted nothing",
    ).toBe(true);
    const total = (await onHandAt(item, binMain)) + (await onHandAt(item, binSecond));
    expect(total).toBe(2);
  });

  it("planning is deterministic for identical requests", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    await stockIn(item, binMain, 7);
    await stockIn(item, binSecond, 7);
    const ctx = ctxOf(orgA, userA);
    const a = await withCtx(ctx, (tx) =>
      planAllocation(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 9,
        movementType: "material_issue",
        idempotencyKey: key(),
      }),
    );
    const b = await withCtx(ctx, (tx) =>
      planAllocation(tx, ctx, {
        itemId: item,
        unitId: unitA,
        qty: 9,
        movementType: "material_issue",
        idempotencyKey: key(),
      }),
    );
    expect(a).toEqual(b);
  });
});

describe("a real job consumption spanning two bins", () => {
  /*
   * Driven through postConsumptionToStock rather than through the allocator.
   *
   * Testing the mechanism instead of the path is what let a one-movement-per-
   * event assumption survive: exercised directly, allocation splits correctly;
   * exercised through consumption, the second bin's movement carries the same
   * source line as the first, and only the real path finds out whether the
   * database allows that.
   */
  async function seedReport(itemId: string, qty: number) {
    const jobId = randomUUID();
    const reportId = randomUUID();
    const lineId = randomUUID();
    await owner`
      insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
      values (${jobId}, ${orgA}, ${"J-" + randomUUID().slice(0, 8)}, 'Job', 'active', 'active', ${userA})`;
    await owner`
      insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by)
      values (${reportId}, ${orgA}, ${jobId}, current_date, 'work', 'submitted', ${userA})`;
    await owner`
      insert into public.report_material_line (id, org_id, report_id, item_id, item_name, qty, unit)
      values (${lineId}, ${orgA}, ${reportId}, ${itemId}, 'Material', ${qty}, 'ea')`;
    return { jobId, reportId, lineId };
  }

  it("takes from both bins and charges both costs", { timeout: 300_000 }, async () => {
    const item = await seedItem();
    await stockIn(item, binMain, 5, 200);
    await stockIn(item, binSecond, 5, 300);

    const { reportId } = await seedReport(item, 8);
    const result = await postConsumptionToStock(ctxOf(orgA, userA), "owner", reportId);
    expect(result[0]!.posted).toBe(true);
    expect(result[0]!.locations, "it took two bins to cover 8").toBe(2);
    // 5 at 200 from the default bin, then 3 at 300 from the other.
    expect(result[0]!.costMinor).toBe(5 * 200 + 3 * 300);
    expect(await onHandAt(item, binMain)).toBe(0);
    expect(await onHandAt(item, binSecond)).toBe(2);
  });

  it("a retried consumption takes nothing further", { timeout: 300_000 }, async () => {
    const item = await seedItem();
    await stockIn(item, binMain, 4, 100);
    await stockIn(item, binSecond, 4, 100);
    const { reportId } = await seedReport(item, 6);
    await postConsumptionToStock(ctxOf(orgA, userA), "owner", reportId);
    const again = await postConsumptionToStock(ctxOf(orgA, userA), "owner", reportId);
    expect(again[0]!.posted, "the retry posted nothing").toBe(false);
    expect(again[0]!.costMinor, "and still reports what it cost").toBe(600);
    const left = (await onHandAt(item, binMain)) + (await onHandAt(item, binSecond));
    expect(left).toBe(2);
  });
});

describe("receipt disposition keeps unusable stock out of the available pool", () => {
  it("the four dispositions must add up to what arrived", { timeout: 120_000 }, async () => {
    const poId = randomUUID();
    const grId = randomUUID();
    const polId = randomUUID();
    await owner`
      insert into public.purchase_order
        (id, org_id, reference, supplier_id, created_by, currency, base_currency,
         exchange_rate, rate_date, rate_source, total_minor, base_total_minor)
      values (${poId}, ${orgA}, ${"PO-" + randomUUID().slice(0, 8)}, ${supplierA}, ${userA},
              'AED', 'AED', 1, current_date, 'same_currency', 1000, 1000)`;
    await owner`
      insert into public.goods_receipt (id, org_id, po_id, reference, received_date, created_by)
      values (${grId}, ${orgA}, ${poId}, ${"GRN-" + randomUUID().slice(0, 8)}, current_date, ${userA})`;
    await owner`
      insert into public.purchase_order_line (id, org_id, po_id, item_name, qty, unit)
      values (${polId}, ${orgA}, ${poId}, 'Line', 10, 'ea')`;
    // 10 arrived but the split claims 11.
    await expect(
      owner`
        insert into public.goods_receipt_line
          (org_id, grn_id, po_line_id, ordered_qty, received_qty, accepted_qty,
           damaged_qty, rejected_qty, quarantine_qty)
        values (${orgA}, ${grId}, ${polId}, 10, 10, 8, 2, 1, 0)`,
    ).rejects.toThrow(/disposition_ck/i);
  });
});

describe("supplier returns reverse the right quantity at the right cost", () => {
  async function seedReceiptWithDisposition(
    itemId: string,
    accepted: number,
    damaged: number,
    rejected: number,
    cost: number,
  ) {
    const poId = randomUUID();
    const grId = randomUUID();
    const polId = randomUUID();
    const grlId = randomUUID();
    const received = accepted + damaged + rejected;
    await owner`
      insert into public.purchase_order
        (id, org_id, reference, supplier_id, created_by, currency, base_currency,
         exchange_rate, rate_date, rate_source, total_minor, base_total_minor)
      values (${poId}, ${orgA}, ${"PO-" + randomUUID().slice(0, 8)}, ${supplierA}, ${userA},
              'AED', 'AED', 1, current_date, 'same_currency', 1000, 1000)`;
    await owner`
      insert into public.goods_receipt (id, org_id, po_id, reference, received_date, created_by)
      values (${grId}, ${orgA}, ${poId}, ${"GRN-" + randomUUID().slice(0, 8)}, current_date, ${userA})`;
    await owner`
      insert into public.purchase_order_line
        (id, org_id, po_id, item_id, item_name, qty, unit, unit_cost_minor)
      values (${polId}, ${orgA}, ${poId}, ${itemId}, 'Line', ${received}, 'ea', ${cost})`;
    await owner`
      insert into public.goods_receipt_line
        (id, org_id, grn_id, po_line_id, ordered_qty, received_qty, accepted_qty,
         damaged_qty, rejected_qty, quarantine_qty)
      values (${grlId}, ${orgA}, ${grId}, ${polId}, ${received}, ${received}, ${accepted},
              ${damaged}, ${rejected}, 0)`;
    return { grId, grlId };
  }

  async function seedReturn(grlId: string, itemId: string, qty: number, disposition = "accepted") {
    const id = randomUUID();
    await owner`
      insert into public.supplier_return (id, org_id, reference, supplier_id, reason, created_by)
      values (${id}, ${orgA}, ${"SR-" + randomUUID().slice(0, 8)}, ${supplierA},
              'wrong specification', ${userA})`;
    await owner`
      insert into public.supplier_return_line
        (org_id, return_id, goods_receipt_line_id, item_id, unit_id, qty, disposition)
      values (${orgA}, ${id}, ${grlId}, ${itemId}, ${unitA}, ${qty}, ${disposition})`;
    return id;
  }

  it("reduces stock and stays traceable to the receipt line", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    const { grlId } = await seedReceiptWithDisposition(item, 20, 0, 0, 500);
    await stockIn(item, binMain, 20, 500);

    const returnId = await seedReturn(grlId, item, 5);
    const result = await sendSupplierReturn(ctxOf(orgA, userA), "owner", returnId);
    expect(result.lines).toBe(1);
    expect(await onHandAt(item, binMain)).toBe(15);

    const [grl] = (await owner`
      select returned_qty::text as q from public.goods_receipt_line where id = ${grlId}`) as unknown as Array<{
      q: string;
    }>;
    expect(Number(grl!.q), "the receipt line records what went back").toBe(5);
  });

  it("refuses a duplicate send of the same return", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    const { grlId } = await seedReceiptWithDisposition(item, 10, 0, 0, 100);
    await stockIn(item, binMain, 10);
    const returnId = await seedReturn(grlId, item, 3);
    await sendSupplierReturn(ctxOf(orgA, userA), "owner", returnId);
    await expect(sendSupplierReturn(ctxOf(orgA, userA), "owner", returnId)).rejects.toBeInstanceOf(
      StockMovementConflictError,
    );
    expect(await onHandAt(item, binMain), "returned once").toBe(7);
  });

  it("refuses returning more than the receipt line holds", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    const { grlId } = await seedReceiptWithDisposition(item, 4, 0, 0, 100);
    await stockIn(item, binMain, 4);
    const returnId = await seedReturn(grlId, item, 9);
    await expect(sendSupplierReturn(ctxOf(orgA, userA), "owner", returnId)).rejects.toThrow(
      /eligible/i,
    );
    expect(await onHandAt(item, binMain), "nothing left").toBe(4);
  });

  it("partial returns accumulate against the same receipt line", { timeout: 300_000 }, async () => {
    const item = await seedItem();
    const { grlId } = await seedReceiptWithDisposition(item, 10, 0, 0, 100);
    await stockIn(item, binMain, 10);
    await sendSupplierReturn(ctxOf(orgA, userA), "owner", await seedReturn(grlId, item, 3));
    await sendSupplierReturn(ctxOf(orgA, userA), "owner", await seedReturn(grlId, item, 4));
    const [grl] = (await owner`
      select returned_qty::text as q from public.goods_receipt_line where id = ${grlId}`) as unknown as Array<{
      q: string;
    }>;
    expect(Number(grl!.q)).toBe(7);
    // And the eighth is refused, because only 3 remain eligible.
    await expect(
      sendSupplierReturn(ctxOf(orgA, userA), "owner", await seedReturn(grlId, item, 8)),
    ).rejects.toThrow(/eligible/i);
  });

  it(
    "rejected quantity was never owned, so it cannot be returned",
    { timeout: 240_000 },
    async () => {
      const item = await seedItem();
      // 10 arrived: 6 accepted, 4 rejected at the door.
      const { grlId } = await seedReceiptWithDisposition(item, 6, 0, 4, 100);
      await stockIn(item, binMain, 6);
      // Trying to send back 8 exceeds the 6 that were actually accepted.
      await expect(
        sendSupplierReturn(ctxOf(orgA, userA), "owner", await seedReturn(grlId, item, 8)),
      ).rejects.toThrow(/eligible/i);
    },
  );
});

describe("the real receiving path, from ordering to the ledger", () => {
  /*
   * Driven end to end through the services a buyer and a storekeeper actually
   * use: create the order, submit it, approve it, record what turned up, book it
   * into stock. Every earlier test in this file reaches the database directly,
   * which is fine for proving a rule but proves nothing about whether the path a
   * person takes reaches that rule at all.
   */
  const procCtx = (): Ctx => ctxOf(orgA, procUser);

  async function orderedAndApproved(
    itemId: string,
    qty: number,
    unitCostMinor: number,
    money: { currency?: string; exchangeRate?: number } = {},
  ) {
    const { id: poId } = await createPurchaseOrder(procCtx(), "procurement", {
      supplierId: supplierA,
      lines: [{ itemId, itemName: "Ordered", qty, unit: "ea", unitCostMinor }],
      ...money,
    });
    const { approvalId } = await submitPurchaseOrder(procCtx(), "procurement", poId);
    await decideApproval(ctxOf(orgA, userA), "owner", { approvalId, decision: "approved" });
    const po = await getPurchaseOrder(procCtx(), "procurement", poId);
    return { poId, poLineId: po!.lines[0]!.id };
  }

  it("carries a foreign order's own money into the movement", { timeout: 300_000 }, async () => {
    const item = await seedItem();
    // 10 at $5.00, with a rate a person entered.
    const { poId, poLineId } = await orderedAndApproved(item, 10, 500, {
      currency: "USD",
      exchangeRate: 3.6725,
    });
    const grn = await recordGoodsReceipt(procCtx(), "procurement", {
      poId,
      receivedDate: "2026-07-20",
      lines: [{ poLineId, receivedQty: 10 }],
    });
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grn.id);

    const [mv] = (await owner`
      select currency, exchange_rate::text as rate, unit_cost_minor::text as unit_cost,
             base_unit_cost_minor::text as base_cost, qty_delta::text as qty
      from public.stock_movement
      where org_id = ${orgA} and item_id = ${item} and movement_type = 'goods_receipt'`) as unknown as Array<
      Record<string, string>
    >;
    expect(mv!.currency, "the dollars it was bought in").toBe("USD");
    expect(Number(mv!.rate), "the rate the buyer entered, not 1").toBe(3.6725);
    expect(Number(mv!.unit_cost)).toBe(500);
    // 500 cents × 3.6725 = 1836.25 fils, rounded to the dirham's minor unit.
    expect(Number(mv!.base_cost), "valued in the organization's money").toBe(1836);
    expect(Number(mv!.qty)).toBe(10);
  });

  it("refuses a foreign order with no rate, in words a buyer can act on", async () => {
    const item = await seedItem();
    await expect(
      createPurchaseOrder(procCtx(), "procurement", {
        supplierId: supplierA,
        currency: "USD",
        lines: [{ itemId: item, itemName: "Ordered", qty: 1, unit: "ea", unitCostMinor: 100 }],
      }),
    ).rejects.toThrow(/needs the AED per USD rate/i);
  });

  it("refuses a foreign order priced at a rate of 1", async () => {
    const item = await seedItem();
    await expect(
      createPurchaseOrder(procCtx(), "procurement", {
        supplierId: supplierA,
        currency: "USD",
        exchangeRate: 1,
        lines: [{ itemId: item, itemName: "Ordered", qty: 1, unit: "ea", unitCostMinor: 100 }],
      }),
    ).rejects.toThrow(/rate of 1 says/i);
  });

  it("sends a recorded split to three different places", { timeout: 300_000 }, async () => {
    const item = await seedItem();
    const { poId, poLineId } = await orderedAndApproved(item, 20, 100);
    // 20 turned up: 12 good, 3 broken, 4 held for inspection, 1 refused outright.
    const grn = await recordGoodsReceipt(procCtx(), "procurement", {
      poId,
      receivedDate: "2026-07-21",
      lines: [{ poLineId, receivedQty: 20, damagedQty: 3, quarantineQty: 4, rejectedQty: 1 }],
    });
    const posted = await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grn.id);
    expect(posted[0]!.dispositions.map((d) => `${d.disposition}:${d.qty}`)).toEqual([
      "accepted:12",
      "damaged:3",
      "quarantine:4",
    ]);

    const byKind = async (kind: string) => {
      const [r] = (await owner`
        select coalesce(sum(m.qty_delta), 0)::text as q
        from public.stock_movement m
        join public.stock_location l on l.id = m.location_id and l.org_id = m.org_id
        where m.org_id = ${orgA} and m.item_id = ${item} and l.kind = ${kind}`) as unknown as Array<{
        q: string;
      }>;
      return Number(r!.q);
    };
    expect(await byKind("storage"), "only the good 12 are issuable").toBe(12);
    expect(await byKind("damaged")).toBe(3);
    expect(await byKind("quarantine")).toBe(4);

    // And the issuable pool really is 12: asking for 13 fails.
    const ctx = ctxOf(orgA, userA);
    await expect(
      withCtx(ctx, (tx) =>
        allocateAndIssueIn(tx, ctx, {
          itemId: item,
          unitId: unitA,
          qty: 13,
          movementType: "material_issue",
          idempotencyKey: key(),
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it("refuses a split that claims more than arrived", { timeout: 300_000 }, async () => {
    const item = await seedItem();
    const { poId, poLineId } = await orderedAndApproved(item, 5, 100);
    await expect(
      recordGoodsReceipt(procCtx(), "procurement", {
        poId,
        receivedDate: "2026-07-22",
        lines: [{ poLineId, receivedQty: 5, damagedQty: 4, quarantineQty: 3 }],
      }),
    ).rejects.toThrow(/cannot exceed what was received/i);
  });

  it("a receipt booked twice adds stock once", { timeout: 300_000 }, async () => {
    const item = await seedItem();
    const { poId, poLineId } = await orderedAndApproved(item, 8, 100);
    const grn = await recordGoodsReceipt(procCtx(), "procurement", {
      poId,
      receivedDate: "2026-07-23",
      lines: [{ poLineId, receivedQty: 8, damagedQty: 2 }],
    });
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grn.id);
    const again = await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grn.id);
    expect(again[0]!.posted, "the retry posted nothing").toBe(false);
    expect(again[0]!.dispositions.every((d) => !d.posted)).toBe(true);
    const [r] = (await owner`
      select coalesce(sum(qty_delta), 0)::text as q from public.stock_movement
      where org_id = ${orgA} and item_id = ${item}`) as unknown as Array<{ q: string }>;
    expect(Number(r!.q), "6 good and 2 damaged, once").toBe(8);
  });
});

describe("the projection survives all of it", () => {
  it("reconciles with no drift", { timeout: 300_000 }, async () => {
    const result = await reconcileStockBalances(ctxOf(orgA, userA), "owner");
    expect(result.drift).toEqual([]);
  });
});
