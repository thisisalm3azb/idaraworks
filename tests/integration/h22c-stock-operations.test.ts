/**
 * H22C — receipts, consumption, reservations, transfers and counts.
 *
 * The rule under test throughout: a business event becomes stock only when it
 * genuinely represents stock, and it becomes stock exactly once however many
 * times the path is run.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  postGoodsReceiptToStock,
  postConsumptionToStock,
  reserveStock,
  releaseReservation,
  dispatchTransfer,
  postStockCount,
  previewHistoricalStock,
  reconcileStockBalances,
  NotStockableError,
  StockMovementConflictError,
} from "@/modules/inventory/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
let unitA = "";
let whA = "";
let recvBin = "";
let issueBin = "";
let whB = "";
let binB = "";
let supplierA = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h22c",
});

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h22c-${label}-${run}@example.com`}, '{"full_name":"H22C"}'::jsonb, now(), now())`;
}

async function seedItem(itemType = "inventory", withUnit = true) {
  const id = randomUUID();
  await owner`
    insert into public.item (id, org_id, sku, name, category_key, unit, item_type, base_unit_id)
    values (${id}, ${orgA}, ${"S-" + randomUUID().slice(0, 8)}, 'Item', 'general', 'ea',
            ${itemType}, ${withUnit ? unitA : null})`;
  return id;
}

/** A recorded receipt against a PO line, which is the only route into stock. */
async function seedReceipt(
  lines: Array<{
    itemId: string | null;
    qty: number;
    damaged?: number;
    rejected?: number;
    cost?: number;
  }>,
  opts: { poStatus?: string; grStatus?: string } = {},
) {
  const poId = randomUUID();
  const grId = randomUUID();
  await owner`
    insert into public.purchase_order (id, org_id, reference, supplier_id, status, created_by)
    values (${poId}, ${orgA}, ${"PO-" + randomUUID().slice(0, 8)}, ${supplierA},
            ${opts.poStatus ?? "approved"}, ${userA})`;
  await owner`
    insert into public.goods_receipt (id, org_id, po_id, reference, received_date, status, created_by)
    values (${grId}, ${orgA}, ${poId}, ${"GRN-" + randomUUID().slice(0, 8)}, current_date,
            ${opts.grStatus ?? "recorded"}, ${userA})`;
  const lineIds: string[] = [];
  for (const [i, l] of lines.entries()) {
    const polId = randomUUID();
    const grlId = randomUUID();
    await owner`
      insert into public.purchase_order_line
        (id, org_id, po_id, item_id, item_name, qty, unit, unit_cost_minor, sort)
      values (${polId}, ${orgA}, ${poId}, ${l.itemId}, 'Line', ${l.qty}, 'ea',
              ${l.cost ?? 0}, ${i})`;
    await owner`
      insert into public.goods_receipt_line
        (id, org_id, grn_id, po_line_id, ordered_qty, received_qty, damaged_qty, rejected_qty, sort)
      values (${grlId}, ${orgA}, ${grId}, ${polId}, ${l.qty}, ${l.qty},
              ${l.damaged ?? 0}, ${l.rejected ?? 0}, ${i})`;
    lineIds.push(grlId);
  }
  return { poId, grId, lineIds };
}

async function onHand(itemId: string) {
  const [r] = (await owner`
    select coalesce(sum(qty_delta), 0)::text as q from public.stock_movement
    where org_id = ${orgA} and item_id = ${itemId}`) as unknown as Array<{ q: string }>;
  return Number(r!.q);
}

beforeAll(async () => {
  await seedUser(userA, "a");
  orgA = await createOrgForUser(userA, { name: "H22C A", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h22c-operations", run);

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
  recvBin = randomUUID();
  issueBin = randomUUID();
  binB = randomUUID();
  await owner`
    insert into public.stock_location
      (id, org_id, warehouse_id, code, name_en, is_default_receiving, is_default_issue)
    values (${recvBin}, ${orgA}, ${whA}, 'RECV', 'Receiving', true, false),
           (${issueBin}, ${orgA}, ${whA}, 'PICK', 'Picking', false, true),
           (${binB}, ${orgA}, ${whB}, 'SITE1', 'Site bin', false, false)`;
  supplierA = randomUUID();
  await owner`
    insert into public.supplier (id, org_id, name) values (${supplierA}, ${orgA}, 'A Supplier')`;
}, 300_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 180_000);

describe("goods receipts become stock only through a real inventory item", () => {
  it("an inventory line posts good quantity at its order cost", { timeout: 180_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 10, cost: 500 }]);
    const result = await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    expect(result).toHaveLength(1);
    expect(result[0]!.posted).toBe(true);
    expect(await onHand(item)).toBe(10);
  });

  it("a free-text order line creates NO stock", { timeout: 180_000 }, async () => {
    const { grId } = await seedReceipt([{ itemId: null, qty: 4 }]);
    const result = await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    expect(result[0]!.posted).toBe(false);
    expect(result[0]!.skipped).toMatch(/not an inventory item/i);
  });

  it("a service item creates NO stock", { timeout: 180_000 }, async () => {
    const svc = await seedItem("service");
    const { grId } = await seedReceipt([{ itemId: svc, qty: 3, cost: 100 }]);
    const result = await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    expect(result[0]!.posted).toBe(false);
    expect(await onHand(svc)).toBe(0);
  });

  it("damaged and rejected quantities are excluded", { timeout: 180_000 }, async () => {
    const item = await seedItem();
    // 20 arrived; 3 damaged and 2 rejected are not usable stock.
    const { grId } = await seedReceipt([
      { itemId: item, qty: 20, damaged: 3, rejected: 2, cost: 100 },
    ]);
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    expect(await onHand(item), "only the good 15").toBe(15);
  });

  it("a line entirely damaged posts nothing", { timeout: 180_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 5, damaged: 5, cost: 100 }]);
    const result = await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    expect(result[0]!.posted).toBe(false);
    expect(await onHand(item)).toBe(0);
  });

  it("a cancelled purchase order cannot deliver stock", { timeout: 180_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 5, cost: 100 }], {
      poStatus: "cancelled",
    });
    const result = await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    expect(result[0]!.skipped).toMatch(/cancelled/i);
    expect(await onHand(item)).toBe(0);
  });

  it("a cancelled goods receipt is refused outright", { timeout: 180_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 5 }], { grStatus: "cancelled" });
    await expect(postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId)).rejects.toBeInstanceOf(
      NotStockableError,
    );
  });

  it("posting the same receipt twice adds stock once", { timeout: 180_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 7, cost: 250 }]);
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    const again = await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    expect(again[0]!.posted, "the retry posted nothing").toBe(false);
    expect(await onHand(item)).toBe(7);
  });

  it("concurrent posting of one receipt adds stock once", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 9, cost: 100 }]);
    await Promise.allSettled(
      Array.from({ length: 4 }, () => postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId)),
    );
    expect(await onHand(item)).toBe(9);
  });

  it("partial receipts accumulate across separate deliveries", { timeout: 180_000 }, async () => {
    const item = await seedItem();
    const first = await seedReceipt([{ itemId: item, qty: 6, cost: 100 }]);
    const second = await seedReceipt([{ itemId: item, qty: 4, cost: 100 }]);
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", first.grId);
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", second.grId);
    expect(await onHand(item)).toBe(10);
  });
});

describe("material consumption reduces stock and charges the job", () => {
  async function seedReport(itemId: string | null, qty: number, status = "submitted") {
    const jobId = randomUUID();
    const reportId = randomUUID();
    await owner`
      insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
      values (${jobId}, ${orgA}, ${"J-" + randomUUID().slice(0, 8)}, 'Job', 'active', 'active', ${userA})`;
    await owner`
      insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by)
      values (${reportId}, ${orgA}, ${jobId}, current_date, 'work', ${status}, ${userA})`;
    const lineId = randomUUID();
    await owner`
      insert into public.report_material_line (id, org_id, report_id, item_id, item_name, qty, unit)
      values (${lineId}, ${orgA}, ${reportId}, ${itemId}, 'Material', ${qty}, 'ea')`;
    return { jobId, reportId, lineId };
  }

  it("charges the ledger cost, not the catalogue price", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    // Receive at 500 minor each, then raise the catalogue price to prove the
    // charge comes from the stock, not the price list.
    const { grId } = await seedReceipt([{ itemId: item, qty: 10, cost: 500 }]);
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    await owner`update public.item set unit_cost_minor = 99999 where id = ${item}`;

    const { reportId } = await seedReport(item, 4);
    const result = await postConsumptionToStock(ctxOf(orgA, userA), "owner", reportId);
    expect(result[0]!.posted).toBe(true);
    expect(result[0]!.costMinor, "4 at the 500 it actually cost").toBe(2000);
    expect(await onHand(item)).toBe(6);
  });

  it("is traceable through the LEDGER, not a duplicate flag", { timeout: 180_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 5, cost: 100 }]);
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    const { reportId, lineId } = await seedReport(item, 2);
    await postConsumptionToStock(ctxOf(orgA, userA), "owner", reportId);

    // The movement carrying this line's id IS the record that it was deducted.
    // report_material_line.deducted_from_inventory is deliberately not written:
    // a second copy of that fact could disagree with the ledger, and 0031
    // rightly forbids editing a reviewed report's lines at all.
    const [mv] = (await owner`
      select qty_delta::text as q from public.stock_movement
      where org_id = ${orgA} and source_type = 'report_material_line'
        and source_id = ${lineId}`) as unknown as Array<{ q: string }>;
    expect(mv, "the ledger records the deduction").toBeTruthy();
    expect(Number(mv!.q)).toBe(-2);
  });

  it("is idempotent across retries", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 20, cost: 100 }]);
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    const { reportId } = await seedReport(item, 5);
    await postConsumptionToStock(ctxOf(orgA, userA), "owner", reportId);
    await postConsumptionToStock(ctxOf(orgA, userA), "owner", reportId);
    expect(await onHand(item), "consumed once").toBe(15);
  });

  it("free-text material consumes nothing", { timeout: 180_000 }, async () => {
    const { reportId } = await seedReport(null, 3);
    const result = await postConsumptionToStock(ctxOf(orgA, userA), "owner", reportId);
    expect(result[0]!.posted).toBe(false);
    expect(result[0]!.skipped).toMatch(/free-text/i);
  });

  it("a draft report does not consume stock", { timeout: 180_000 }, async () => {
    const item = await seedItem();
    const { reportId } = await seedReport(item, 1, "draft");
    await expect(
      postConsumptionToStock(ctxOf(orgA, userA), "owner", reportId),
    ).rejects.toBeInstanceOf(NotStockableError);
  });
});

describe("reservations change available, never on hand", () => {
  it("holds stock without moving it, and gives it back", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 30, cost: 100 }]);
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);

    const { reservationId } = await reserveStock(ctxOf(orgA, userA), "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: recvBin,
      unitId: unitA,
      qty: 12,
    });
    const [bal] = (await owner`
      select on_hand::text as on_hand, reserved::text as reserved
      from public.stock_balance where org_id = ${orgA} and item_id = ${item}
        and location_id = ${recvBin}`) as unknown as Array<{ on_hand: string; reserved: string }>;
    expect(Number(bal!.on_hand), "the goods have not moved").toBe(30);
    expect(Number(bal!.reserved)).toBe(12);
    expect(await onHand(item), "the ledger's physical total is unchanged").toBe(30);

    await releaseReservation(ctxOf(orgA, userA), "owner", reservationId, "job cancelled");
    const [after] = (await owner`
      select reserved::text as reserved from public.stock_balance
      where org_id = ${orgA} and item_id = ${item} and location_id = ${recvBin}`) as unknown as Array<{
      reserved: string;
    }>;
    expect(Number(after!.reserved)).toBe(0);
  });

  it("releasing twice is refused rather than double-releasing", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 10, cost: 100 }]);
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    const { reservationId } = await reserveStock(ctxOf(orgA, userA), "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: recvBin,
      unitId: unitA,
      qty: 5,
    });
    await releaseReservation(ctxOf(orgA, userA), "owner", reservationId, "first");
    await expect(
      releaseReservation(ctxOf(orgA, userA), "owner", reservationId, "second"),
    ).rejects.toBeInstanceOf(StockMovementConflictError);
  });
});

describe("transfers post both sides atomically", () => {
  async function seedTransfer(itemId: string, qty: number) {
    const id = randomUUID();
    await owner`
      insert into public.stock_transfer
        (id, org_id, reference, from_warehouse_id, from_location_id,
         to_warehouse_id, to_location_id, created_by)
      values (${id}, ${orgA}, ${"TR-" + randomUUID().slice(0, 8)}, ${whA}, ${recvBin},
              ${whB}, ${binB}, ${userA})`;
    await owner`
      insert into public.stock_transfer_line (org_id, transfer_id, item_id, unit_id, qty)
      values (${orgA}, ${id}, ${itemId}, ${unitA}, ${qty})`;
    return id;
  }

  it(
    "moves stock between warehouses without changing the total",
    { timeout: 240_000 },
    async () => {
      const item = await seedItem();
      const { grId } = await seedReceipt([{ itemId: item, qty: 40, cost: 100 }]);
      await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);

      const transferId = await seedTransfer(item, 15);
      await dispatchTransfer(ctxOf(orgA, userA), "owner", transferId);

      expect(await onHand(item), "a transfer neither creates nor destroys").toBe(40);
      const rows = (await owner`
      select location_id::text as loc, on_hand::text as q from public.stock_balance
      where org_id = ${orgA} and item_id = ${item} order by q`) as unknown as Array<{
        loc: string;
        q: string;
      }>;
      const byLoc = Object.fromEntries(rows.map((r) => [r.loc, Number(r.q)]));
      expect(byLoc[recvBin]).toBe(25);
      expect(byLoc[binB]).toBe(15);
    },
  );

  it("a transfer with insufficient stock moves NOTHING", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 3, cost: 100 }]);
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    const transferId = await seedTransfer(item, 99);
    await expect(dispatchTransfer(ctxOf(orgA, userA), "owner", transferId)).rejects.toThrow();
    expect(await onHand(item), "neither leg survived").toBe(3);
    // And the header did not silently move on.
    const [t] = (await owner`
      select status from public.stock_transfer where id = ${transferId}`) as unknown as Array<{
      status: string;
    }>;
    expect(t!.status).toBe("draft");
  });

  it("dispatching twice moves stock once", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 20, cost: 100 }]);
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    const transferId = await seedTransfer(item, 8);
    await dispatchTransfer(ctxOf(orgA, userA), "owner", transferId);
    await expect(dispatchTransfer(ctxOf(orgA, userA), "owner", transferId)).rejects.toBeInstanceOf(
      StockMovementConflictError,
    );
    expect(await onHand(item)).toBe(20);
  });
});

describe("stock counts create reviewed adjustments", () => {
  async function seedCount(itemId: string, counted: number, opts: { reason?: string } = {}) {
    const id = randomUUID();
    await owner`
      insert into public.stock_count (id, org_id, reference, warehouse_id, status, created_by)
      values (${id}, ${orgA}, ${"SC-" + randomUUID().slice(0, 8)}, ${whA}, 'review', ${userA})`;
    await owner`
      insert into public.stock_count_line
        (org_id, count_id, item_id, location_id, unit_id, counted_qty, variance_reason)
      values (${orgA}, ${id}, ${itemId}, ${recvBin}, ${unitA}, ${counted},
              ${opts.reason ?? null})`;
    return id;
  }

  it("posts the DIFFERENCE as a correction movement", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 50, cost: 100 }]);
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);

    // Counted 47: three are missing.
    const countId = await seedCount(item, 47, { reason: "breakage found on the shelf" });
    await owner`update public.stock_count set reviewed_by = ${userA}, reviewed_at = now() where id = ${countId}`;
    const result = await postStockCount(ctxOf(orgA, userA), "owner", countId);

    expect(result.corrections).toBe(1);
    expect(await onHand(item), "the ledger, not the balance, was corrected").toBe(47);
    const [mv] = (await owner`
      select qty_delta::text as q, reason from public.stock_movement
      where org_id = ${orgA} and item_id = ${item} and movement_type = 'count_correction'`) as unknown as Array<{
      q: string;
      reason: string;
    }>;
    expect(Number(mv!.q)).toBe(-3);
    expect(mv!.reason).toMatch(/breakage/i);
  });

  it("refuses to post a variance with no reason", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 10, cost: 100 }]);
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    const countId = await seedCount(item, 8);
    await owner`update public.stock_count set reviewed_by = ${userA}, reviewed_at = now() where id = ${countId}`;
    await expect(postStockCount(ctxOf(orgA, userA), "owner", countId)).rejects.toThrow(/reason/i);
    expect(await onHand(item), "nothing changed").toBe(10);
  });

  it("refuses to post a count that nobody reviewed", { timeout: 180_000 }, async () => {
    const item = await seedItem();
    const countId = await seedCount(item, 5, { reason: "found extra" });
    await expect(postStockCount(ctxOf(orgA, userA), "owner", countId)).rejects.toThrow(/reviewed/i);
  });

  it("an accurate count posts no movement at all", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    const { grId } = await seedReceipt([{ itemId: item, qty: 12, cost: 100 }]);
    await postGoodsReceiptToStock(ctxOf(orgA, userA), "owner", grId);
    const countId = await seedCount(item, 12);
    await owner`update public.stock_count set reviewed_by = ${userA}, reviewed_at = now() where id = ${countId}`;
    const result = await postStockCount(ctxOf(orgA, userA), "owner", countId);
    expect(result.corrections).toBe(0);
    expect(result.unchanged).toBe(1);
  });
});

describe("historical reconciliation is a preview and nothing else", () => {
  it("reports implied positions without creating any stock", { timeout: 240_000 }, async () => {
    const item = await seedItem();
    // History: received 100, consumed 30, with NO stock movements posted.
    const { grId } = await seedReceipt([{ itemId: item, qty: 100, cost: 400 }]);
    const jobId = randomUUID();
    const reportId = randomUUID();
    await owner`
      insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
      values (${jobId}, ${orgA}, ${"HJ-" + randomUUID().slice(0, 8)}, 'Job', 'active', 'active', ${userA})`;
    await owner`
      insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by)
      values (${reportId}, ${orgA}, ${jobId}, current_date, 'work', 'submitted', ${userA})`;
    await owner`
      insert into public.report_material_line (org_id, report_id, item_id, item_name, qty, unit)
      values (${orgA}, ${reportId}, ${item}, 'Material', 30, 'ea')`;

    const before = await onHand(item);
    const preview = await previewHistoricalStock(ctxOf(orgA, userA), "owner");
    const position = preview.positions.find((p) => p.itemId === item);

    expect(position, "the item must appear").toBeTruthy();
    expect(Number(position!.receivedQty)).toBe(100);
    expect(Number(position!.consumedQty)).toBe(30);
    expect(Number(position!.impliedOnHand)).toBe(70);
    expect(preview.applied, "a preview never applies").toBe(false);
    expect(await onHand(item), "no stock was created").toBe(before);
    expect(grId).toBeTruthy();
  });

  it("names records it cannot reconcile, with the reason", { timeout: 240_000 }, async () => {
    await seedReceipt([{ itemId: null, qty: 5 }]);
    const preview = await previewHistoricalStock(ctxOf(orgA, userA), "owner");
    const freeText = preview.unreconcilable.find((u) => /free text|free-text/i.test(u.reason));
    expect(freeText, "a free-text line must be listed as unreconcilable").toBeTruthy();
    expect(preview.totals.unreconcilableCount).toBeGreaterThan(0);
  });

  it("flags a contradictory position as low confidence", { timeout: 240_000 }, async () => {
    // Consumed without ever receiving: the records disagree.
    const item = await seedItem();
    const jobId = randomUUID();
    const reportId = randomUUID();
    await owner`
      insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
      values (${jobId}, ${orgA}, ${"CJ-" + randomUUID().slice(0, 8)}, 'Job', 'active', 'active', ${userA})`;
    await owner`
      insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by)
      values (${reportId}, ${orgA}, ${jobId}, current_date, 'work', 'submitted', ${userA})`;
    await owner`
      insert into public.report_material_line (org_id, report_id, item_id, item_name, qty, unit)
      values (${orgA}, ${reportId}, ${item}, 'Material', 12, 'ea')`;

    const preview = await previewHistoricalStock(ctxOf(orgA, userA), "owner");
    const position = preview.positions.find((p) => p.itemId === item);
    expect(Number(position!.impliedOnHand)).toBe(-12);
    expect(position!.confidence, "more consumed than received is not trustworthy").toBe("low");
  });

  it("requires valuation permission, because it reads cost", { timeout: 180_000 }, async () => {
    // A foreman may see stock but not what it is worth.
    await expect(previewHistoricalStock(ctxOf(orgA, userA), "foreman")).rejects.toThrow();
  });
});

describe("the projection stays reconcilable through every operation", () => {
  it(
    "reports no drift after receipts, issues, transfers and counts",
    { timeout: 300_000 },
    async () => {
      const result = await reconcileStockBalances(ctxOf(orgA, userA), "owner");
      expect(result.drift, "every H22C path maintained its projection").toEqual([]);
    },
  );
});
