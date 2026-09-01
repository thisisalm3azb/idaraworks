/**
 * H22F — the chain that makes H22 real: order → receive → stock.
 *
 * Every earlier slice tested its own link and the chain was broken at both
 * joins. H22C's tests built goods receipts with raw SQL, so nothing ever
 * exercised a receipt made the way the product actually makes one; and the
 * product made receipts that could never become stock anyway, because
 *
 *   1. the purchase-order form was FREE TEXT ONLY, so no order line ever
 *      carried an item id, and a receipt against a line with no item is not
 *      an inventory event — it is a description of something that was bought;
 *   2. nothing in the application ever called `postGoodsReceiptToStock`.
 *
 * Both links now exist, so this walks the whole chain through the real module
 * functions the receiving action calls, in order, and looks at the ledger.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { createPurchaseOrder, recordGoodsReceipt } from "@/modules/supply/service";
import { postGoodsReceiptToStock, listStockLevels } from "@/modules/inventory/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
let whA = "";
let recvBin = "";
let unitA = "";
let supplierA = "";
let today = "";

const ctx = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h22f-recv",
});

async function anItem(sku: string) {
  const id = randomUUID();
  await owner`
    insert into public.item
      (id, org_id, sku, name, category_key, unit, item_type, base_unit_id,
       purchase_unit_id, tracking, lifecycle, active)
    values (${id}, ${orgA}, ${sku}, ${"Item " + sku}, 'material', 'EA', 'inventory',
            ${unitA}, ${unitA}, 'none', 'active', true)`;
  return id;
}

/** Straight to approved: this suite is about receiving, not about approval. */
async function anApprovedPo(lines: Array<{ itemId?: string; name: string; qty: number }>) {
  const { id } = await createPurchaseOrder(ctx(), "owner", {
    supplierId: supplierA,
    lines: lines.map((l) => ({
      itemId: l.itemId,
      itemName: l.name,
      qty: l.qty,
      unit: "EA",
      unitCostMinor: 1500,
    })),
  });
  await owner`update public.purchase_order set status = 'approved' where id = ${id}`;
  const poLines = (await owner`
    select id::text as id, item_id::text as item_id from public.purchase_order_line
    where po_id = ${id} order by sort`) as unknown as Array<{ id: string; item_id: string | null }>;
  return { id, poLines };
}

beforeAll(async () => {
  const [clock] = (await owner`select current_date::text as d`) as unknown as Array<{ d: string }>;
  today = clock!.d;
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h22f-recv-${run}@example.com`}, '{"full_name":"H22F"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H22F R", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h22f-receiving", run);

  unitA = randomUUID();
  await owner`
    insert into public.unit_of_measure
      (id, org_id, code, name_en, name_ar, dimension, factor_to_base, is_base)
    values (${unitA}, ${orgA}, 'EA', 'Each', 'حبة', 'count', 1, true)`;
  whA = randomUUID();
  await owner`
    insert into public.warehouse (id, org_id, code, name_en, created_by)
    values (${whA}, ${orgA}, 'MAIN', 'Main', ${userA})`;
  recvBin = randomUUID();
  await owner`
    insert into public.stock_location
      (id, org_id, warehouse_id, code, name_en, kind, is_default_receiving)
    values (${recvBin}, ${orgA}, ${whA}, 'RECV', 'Receiving', 'storage', true)`;
  supplierA = randomUUID();
  await owner`
    insert into public.supplier (id, org_id, name) values (${supplierA}, ${orgA}, 'Supplier')`;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 300_000);

describe("order, receive, and the stock is there", () => {
  it("a receipt made the real way becomes stock", { timeout: 300_000 }, async () => {
    const item = await anItem(`CHAIN-${run}`);
    const { id: poId, poLines } = await anApprovedPo([
      { itemId: item, name: "Steel plate", qty: 8 },
    ]);
    expect(poLines[0]!.item_id, "the order line lost its item").toBe(item);

    // Exactly what the receiving action does, in the same order.
    const grn = await recordGoodsReceipt(ctx(), "owner", {
      poId,
      receivedDate: today,
      lines: [{ poLineId: poLines[0]!.id, receivedQty: 8 }],
    });
    const posted = await postGoodsReceiptToStock(ctx(), "owner", grn.id);
    expect(posted.filter((p) => p.posted)).toHaveLength(1);

    const { rows } = await listStockLevels(ctx(), "owner", { search: `CHAIN-${run}` });
    expect(rows, "the goods arrived and the warehouse never heard").toHaveLength(1);
    expect(Number(rows[0]!.onHand)).toBe(8);
    expect(rows[0]!.soleLocationName).toBe("Receiving");
    // Priced at what the order said it cost, not at some later guess.
    expect(rows[0]!.valueMinor).toBe(12_000);
  });

  it("posting the same receipt twice does not double the stock", { timeout: 300_000 }, async () => {
    /*
     * The receiving action posts AFTER the receipt is committed, so a person who
     * hits receive again after a posting failure runs this path twice. Posting
     * is idempotent under an advisory lock; this is the assertion that says so.
     */
    const item = await anItem(`TWICE-${run}`);
    const { id: poId, poLines } = await anApprovedPo([{ itemId: item, name: "Bolt", qty: 5 }]);
    const grn = await recordGoodsReceipt(ctx(), "owner", {
      poId,
      receivedDate: today,
      lines: [{ poLineId: poLines[0]!.id, receivedQty: 5 }],
    });

    await postGoodsReceiptToStock(ctx(), "owner", grn.id);
    const second = await postGoodsReceiptToStock(ctx(), "owner", grn.id);
    // The second run reports the line, and books nothing new.
    expect(second).toHaveLength(1);

    const { rows } = await listStockLevels(ctx(), "owner", { search: `TWICE-${run}` });
    expect(Number(rows[0]!.onHand), "the receipt was booked twice").toBe(5);
  });

  it(
    "a free-text line still orders and receives, and creates no stock",
    { timeout: 300_000 },
    async () => {
      /*
       * The other half of the fix. A business orders things that are not and never
       * will be catalogue items — a day of scaffolding hire, a delivery charge.
       * Those must keep working exactly as before and must not invent stock.
       */
      const { id: poId, poLines } = await anApprovedPo([{ name: "Crane hire, one day", qty: 1 }]);
      expect(poLines[0]!.item_id).toBeNull();

      const grn = await recordGoodsReceipt(ctx(), "owner", {
        poId,
        receivedDate: today,
        lines: [{ poLineId: poLines[0]!.id, receivedQty: 1 }],
      });
      const posted = await postGoodsReceiptToStock(ctx(), "owner", grn.id);
      expect(posted).toHaveLength(1);
      expect(posted[0]!.posted).toBe(false);
      // And it says WHY, rather than failing or silently doing nothing.
      expect(posted[0]!.skipped).toBeTruthy();

      const counted = (await owner`
      select count(*)::int as n from public.stock_movement where org_id = ${orgA}
        and source_type = 'goods_receipt_line' and source_id = ${poLines[0]!.id}`) as unknown as Array<{
        n: number;
      }>;
      expect(counted[0]!.n).toBe(0);
    },
  );
});

describe("the receiving action is actually wired to the ledger", () => {
  it("calls the poster", async () => {
    /*
     * A source assertion, deliberately.
     *
     * The defect this whole file exists for was not a wrong behaviour — it was
     * an ABSENT CALL. Every module function passed its own tests; the receiving
     * action simply never invoked the one that books stock, and no behavioural
     * test can see a call that was never written. Deleting it again should fail
     * something, so this is that something.
     */
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/app/(app)/o/[orgId]/purchase-orders/actions.ts", "utf8");
    expect(src, "the receiving action no longer books stock").toContain("postGoodsReceiptToStock");
    // And the release gate is still on it, so this cannot switch itself on.
    expect(src).toContain("stockSurfacesEnabled()");
  });
});
