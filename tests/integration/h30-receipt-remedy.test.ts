/**
 * H30 LB-2/LB-3 — the PO-002 scenario, and the remedy that closes it.
 *
 * Reproduced from docs/H22-BLOCKER-PO002.md: an organisation with no warehouse
 * receives goods against a purchase order. The receipt saves — it is the record
 * of a lorry that genuinely arrived — and the stock posting throws because there
 * is no default receiving bin. The product then told the user to "check the
 * warehouse setup and receive again", and both halves were wrong: no setup
 * screen existed, and receiving again creates a SECOND receipt rather than
 * replaying the first.
 *
 * These tests hold the whole remedy to account:
 *
 *   1. the failure is reproduced exactly, including that the receipt survives;
 *   2. `receivingReadiness` names what is missing rather than merely failing;
 *   3. the setup path a person can now follow actually fixes it;
 *   4. replaying THE SAME receipt posts it — and replaying again posts nothing
 *      further, which is the property the button's label promises;
 *   5. the second receipt Najolatech created is posted too, without the first
 *      one's quantities being counted twice;
 *   6. a receipt with more lines than can post atomically REFUSES rather than
 *      silently truncating (LB-5).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  postGoodsReceiptToStock,
  createWarehouse,
  createLocation,
  setDefaultReceiving,
  receivingReadiness,
  unpostedReceipts,
  listWarehouses,
  StockMovementConflictError,
} from "@/modules/inventory/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
let unitA = "";
let supplierA = "";

const ctx = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h30-remedy",
});

async function seedItem() {
  const id = randomUUID();
  await owner`
    insert into public.item (id, org_id, sku, name, category_key, unit, item_type, base_unit_id)
    values (${id}, ${orgA}, ${"S-" + randomUUID().slice(0, 8)}, 'Screws SS316', 'general', 'ea',
            'inventory', ${unitA})`;
  return id;
}

/** A recorded receipt against a PO line — the only route into stock. */
async function seedReceipt(
  poId: string,
  lines: Array<{ itemId: string; qty: number }>,
): Promise<{ grId: string }> {
  const grId = randomUUID();
  await owner`
    insert into public.goods_receipt (id, org_id, po_id, reference, received_date, status, created_by)
    values (${grId}, ${orgA}, ${poId}, ${"GRN-" + randomUUID().slice(0, 8)}, current_date,
            'recorded', ${userA})`;
  /*
   * Inserted in ONE statement per table rather than one per line. The 501-line
   * case below is deliberately larger than the posting cap, and a round-trip per
   * row against a remote test project takes minutes — a fixture slow enough to
   * time out teaches nothing about the product.
   */
  const rows = lines.map((l, i) => ({
    polId: randomUUID(),
    grlId: randomUUID(),
    itemId: l.itemId,
    qty: l.qty,
    sort: i,
  }));
  // unnest over parallel arrays: postgres.js serialises a JS array to a real
  // postgres array natively, which a JSON string parameter does not do.
  const polIds = rows.map((r) => r.polId);
  const grlIds = rows.map((r) => r.grlId);
  const itemIds = rows.map((r) => r.itemId);
  const qtys = rows.map((r) => String(r.qty));
  const sorts = rows.map((r) => r.sort);
  await owner`
    insert into public.purchase_order_line
      (id, org_id, po_id, item_id, item_name, qty, unit, unit_cost_minor, sort)
    select p.id, ${orgA}, ${poId}, p.item_id, 'Screws SS316', p.qty, 'ea', 100, p.sort
    from unnest(${polIds}::uuid[], ${itemIds}::uuid[], ${qtys}::numeric[], ${sorts}::int[])
      as p(id, item_id, qty, sort)`;
  await owner`
    insert into public.goods_receipt_line
      (id, org_id, grn_id, po_line_id, ordered_qty, received_qty, accepted_qty, sort)
    select g.id, ${orgA}, ${grId}, g.pol_id, g.qty, g.qty, g.qty, g.sort
    from unnest(${grlIds}::uuid[], ${polIds}::uuid[], ${qtys}::numeric[], ${sorts}::int[])
      as g(id, pol_id, qty, sort)`;
  return { grId };
}

async function seedPo() {
  const poId = randomUUID();
  await owner`
    insert into public.purchase_order (id, org_id, reference, supplier_id, status, created_by)
    values (${poId}, ${orgA}, ${"PO-" + randomUUID().slice(0, 8)}, ${supplierA}, 'approved', ${userA})`;
  return poId;
}

async function onHand(itemId: string) {
  const [r] = (await owner`
    select coalesce(sum(qty_delta), 0)::text as q from public.stock_movement
    where org_id = ${orgA} and item_id = ${itemId}`) as unknown as Array<{ q: string }>;
  return Number(r!.q);
}

async function movementCount(itemId: string) {
  const [r] = (await owner`
    select count(*)::int as n from public.stock_movement
    where org_id = ${orgA} and item_id = ${itemId}`) as unknown as Array<{ n: number }>;
  return r!.n;
}

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h30-remedy-${run}@example.com`}, '{"full_name":"H30"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H30 Remedy", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h30-receipt-remedy", run);

  unitA = randomUUID();
  await owner`
    insert into public.unit_of_measure
      (id, org_id, code, name_en, name_ar, dimension, factor_to_base, is_base)
    values (${unitA}, ${orgA}, 'EA', 'Each', 'حبة', 'count', 1, true)`;
  supplierA = randomUUID();
  await owner`
    insert into public.supplier (id, org_id, name)
    values (${supplierA}, ${orgA}, 'Fasteners Co')`;
}, 60_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await closeAppDb();
  await owner.end({ timeout: 5 });
});

describe("the PO-002 failure, reproduced", () => {
  it("an organisation with no warehouse cannot receive, and says exactly why", async () => {
    const before = await receivingReadiness(ctx());
    expect(before.ok).toBe(false);
    expect(before.warehouses).toBe(0);
    // Not a status code — the key names the missing thing, and the UI renders it.
    expect(before.missingKey).toBe("stock.setup.missing_warehouse");
  });

  it("the receipt survives the posting failure — the lorry did arrive", async () => {
    const item = await seedItem();
    const poId = await seedPo();
    const { grId } = await seedReceipt(poId, [{ itemId: item, qty: 20 }]);

    await expect(postGoodsReceiptToStock(ctx(), "owner", grId)).rejects.toThrow(
      StockMovementConflictError,
    );

    const [gr] = (await owner`
      select status from public.goods_receipt where id = ${grId}`) as unknown as Array<{
      status: string;
    }>;
    expect(gr!.status).toBe("recorded");
    expect(await onHand(item)).toBe(0);
  });
});

describe("the remedy", () => {
  it("creating a warehouse makes the organisation able to receive, in one step", async () => {
    // The receiving bay is created with the warehouse by default, because a
    // warehouse without one is the exact state that caused the defect.
    const { warehouseId, locationId } = await createWarehouse(ctx(), "owner", {
      code: "main",
      nameEn: "Main Store",
    });
    expect(warehouseId).toBeTruthy();
    expect(locationId).toBeTruthy();

    const after = await receivingReadiness(ctx());
    expect(after.ok).toBe(true);
    expect(after.missingKey).toBeNull();
  });

  it("replaying the SAME receipt posts it, and replaying again posts nothing further", async () => {
    const item = await seedItem();
    const poId = await seedPo();
    const { grId } = await seedReceipt(poId, [{ itemId: item, qty: 20 }]);

    const first = await postGoodsReceiptToStock(ctx(), "owner", grId);
    expect(first.filter((r) => r.posted)).toHaveLength(1);
    expect(await onHand(item)).toBe(20);
    const movementsAfterFirst = await movementCount(item);

    // The property the button's label promises: safe to press more than once.
    const second = await postGoodsReceiptToStock(ctx(), "owner", grId);
    expect(second.filter((r) => r.posted)).toHaveLength(0);
    expect(await onHand(item)).toBe(20);
    expect(await movementCount(item)).toBe(movementsAfterFirst);

    // And a third time, because a user who is unsure presses twice.
    await postGoodsReceiptToStock(ctx(), "owner", grId);
    expect(await onHand(item)).toBe(20);
    expect(await movementCount(item)).toBe(movementsAfterFirst);
  });

  it("Najolatech's two receipts both post, and neither is counted twice", async () => {
    // The real shape of PO-002: 20 received, then 14 received a minute later as
    // a SEPARATE receipt. Any correction must post both and total exactly 34.
    const item = await seedItem();
    const poId = await seedPo();
    const { grId: grn1 } = await seedReceipt(poId, [{ itemId: item, qty: 20 }]);
    const { grId: grn2 } = await seedReceipt(poId, [{ itemId: item, qty: 14 }]);

    await postGoodsReceiptToStock(ctx(), "owner", grn1);
    await postGoodsReceiptToStock(ctx(), "owner", grn2);
    expect(await onHand(item)).toBe(34);

    // Replaying both again changes nothing.
    await postGoodsReceiptToStock(ctx(), "owner", grn1);
    await postGoodsReceiptToStock(ctx(), "owner", grn2);
    expect(await onHand(item)).toBe(34);
  });
});

describe("finding what needs the remedy", () => {
  it("lists receipts that were recorded but never reached the ledger", async () => {
    const item = await seedItem();
    const poId = await seedPo();
    const { grId } = await seedReceipt(poId, [{ itemId: item, qty: 7 }]);

    const before = await unpostedReceipts(ctx(), "owner", { poId });
    expect(before).toHaveLength(1);
    expect(before[0]!.receiptId).toBe(grId);
    expect(before[0]!.postedLines).toBe(0);
    expect(before[0]!.stockableLines).toBe(1);

    await postGoodsReceiptToStock(ctx(), "owner", grId);

    // Once posted it drops off the list, so the remedy does not nag forever.
    expect(await unpostedReceipts(ctx(), "owner", { poId })).toHaveLength(0);
  });

  it("a receipt of only services is never reported as a problem", async () => {
    const serviceId = randomUUID();
    await owner`
      insert into public.item (id, org_id, sku, name, category_key, unit, item_type)
      values (${serviceId}, ${orgA}, ${"SVC-" + randomUUID().slice(0, 8)}, 'Delivery', 'general',
              'ea', 'service')`;
    const poId = await seedPo();
    await seedReceipt(poId, [{ itemId: serviceId, qty: 1 }]);

    // Nothing about it can ever become stock, so it is not an outstanding task.
    expect(await unpostedReceipts(ctx(), "owner", { poId })).toHaveLength(0);
  });
});

describe("setup guards", () => {
  it("a duplicate warehouse code is refused with a key the UI can render", async () => {
    await expect(
      createWarehouse(ctx(), "owner", { code: "MAIN", nameEn: "Another" }),
    ).rejects.toMatchObject({ messageKey: "stock.setup.duplicate_code" });
  });

  it("a location that cannot hold stock cannot become the receiving default", async () => {
    const { warehouses } = await listWarehouses(ctx(), "owner");
    const wh = warehouses[0]!;
    const { locationId } = await createLocation(ctx(), "owner", {
      warehouseId: wh.id,
      code: "ZONE",
      nameEn: "Zone marker",
      kind: "storage",
      canHoldStock: false,
    });
    await expect(setDefaultReceiving(ctx(), "owner", locationId)).rejects.toMatchObject({
      messageKey: "stock.setup.cannot_hold",
    });
  });

  it("a role without inventory.adjust cannot create a warehouse", async () => {
    // Hiding the button is never the control; the module refuses on its own.
    await expect(
      createWarehouse(ctx(), "foreman", { code: "NOPE", nameEn: "Should not exist" }),
    ).rejects.toThrow();
  });

  it("setting the receiving default moves it rather than creating a second one", async () => {
    const { warehouses } = await listWarehouses(ctx(), "owner");
    const wh = warehouses[0]!;
    const { locationId } = await createLocation(ctx(), "owner", {
      warehouseId: wh.id,
      code: "BAY2",
      nameEn: "Second bay",
      kind: "receiving",
    });
    await setDefaultReceiving(ctx(), "owner", locationId);

    const [r] = (await owner`
      select count(*)::int as n from public.stock_location
      where org_id = ${orgA} and warehouse_id = ${wh.id}
        and is_default_receiving and active and can_hold_stock`) as unknown as Array<{ n: number }>;
    expect(r!.n).toBe(1);
  });
});

describe("LB-5 — a receipt too large to post refuses rather than truncating", () => {
  it("does not silently post only the first 500 lines", async () => {
    const item = await seedItem();
    const poId = await seedPo();
    const lines = Array.from({ length: 501 }, () => ({ itemId: item, qty: 1 }));
    const { grId } = await seedReceipt(poId, lines);

    await expect(postGoodsReceiptToStock(ctx(), "owner", grId)).rejects.toThrow(
      /more than 500 lines/,
    );
    // Nothing partial was left behind: the whole receipt posts or none of it does.
    expect(await onHand(item)).toBe(0);
  }, 120_000);
});
