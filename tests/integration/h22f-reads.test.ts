/**
 * H22F — the reads the screens are built on.
 *
 * H22A–H22E could write a whole warehouse and show a person almost none of it.
 * These are the reads that closed that gap, and the properties worth testing are
 * the ones a screen quietly depends on and nobody notices when they break:
 *
 *   — every list is BOUNDED and pages without skipping or repeating a row,
 *   — every list is ORGANIZATION SCOPED, including the single-record reads,
 *   — MONEY is nulled outside the cost wall rather than omitted or leaked,
 *   — a permission a role does not hold refuses rather than returning nothing.
 *
 * The last one matters more than it looks: a read that returns an empty list to
 * somebody who may not see it is indistinguishable, on screen, from a warehouse
 * with nothing in it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { ForbiddenError } from "@/platform/authz";
import {
  listStockLevels,
  listMovements,
  listItemLots,
  listItemSerials,
  getStockItem,
  postMovement,
  attentionFeed,
} from "@/modules/inventory/service";
import {
  assetDetail,
  registerAsset,
  setAssetStatus,
  createAssetCategory,
} from "@/modules/assets/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const viewerUser = randomUUID();
const outsiderUser = randomUUID();

let orgA = "";
let orgB = "";
let whA = "";
let binA = "";
let binB = "";
let unitA = "";
let categoryA = "";
let today = "";

const ctxOf = (orgId: string, userId: string, cost = true): Ctx => ({
  orgId,
  userId,
  costPrivileged: cost,
  pricePrivileged: cost,
  requestId: "h22f",
});
const ownerCtx = () => ctxOf(orgA, userA);
/** Same organization, same person — only the cost wall differs. */
const walledCtx = () => ctxOf(orgA, userA, false);
const bCtx = () => ctxOf(orgB, outsiderUser);

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h22f-${label}-${run}@example.com`}, '{"full_name":"H22F"}'::jsonb, now(), now())`;
}

const days = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** A stockable item with a base unit, ready to receive. */
async function anItem(
  sku: string,
  extra: { tracking?: string; reorderPoint?: number; org?: string } = {},
) {
  const id = randomUUID();
  const org = extra.org ?? orgA;
  await owner`
    insert into public.item
      (id, org_id, sku, name, category_key, unit, item_type, base_unit_id,
       tracking, reorder_point, lifecycle, active)
    values (${id}, ${org}, ${sku}, ${"Item " + sku}, 'material', 'pcs', 'inventory',
            ${org === orgA ? unitA : null}, ${extra.tracking ?? "none"},
            ${extra.reorderPoint ?? null}, 'active', true)`;
  return id;
}

/** Stock on the shelf, through the real ledger. */
async function receive(
  itemId: string,
  qty: number,
  opts: { location?: string; unitCostMinor?: number } = {},
) {
  return postMovement(ownerCtx(), "owner", {
    itemId,
    warehouseId: whA,
    locationId: opts.location ?? binA,
    movementType: "goods_receipt",
    qtyDelta: String(qty),
    unitId: unitA,
    currency: "AED",
    unitCostMinor: opts.unitCostMinor ?? 1000,
    idempotencyKey: randomUUID(),
  });
}

beforeAll(async () => {
  const [clock] = (await owner`select current_date::text as d`) as unknown as Array<{ d: string }>;
  today = clock!.d;

  for (const [id, label] of [
    [userA, "owner"],
    [viewerUser, "viewer"],
    [outsiderUser, "out"],
  ] as const) {
    await seedUser(id, label);
  }

  orgA = await createOrgForUser(userA, { name: "H22F A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(outsiderUser, {
    name: "H22F B",
    country: "AE",
    baseCurrency: "AED",
  });
  await markFixtureOrg(owner, orgA, "h22f", run);
  await markFixtureOrg(owner, orgB, "h22f-b", run);
  await owner`
    insert into public.membership (user_id, org_id, role_key) values (${viewerUser}, ${orgA}, 'viewer')`;

  unitA = randomUUID();
  await owner`
    insert into public.unit_of_measure
      (id, org_id, code, name_en, name_ar, dimension, factor_to_base, is_base)
    values (${unitA}, ${orgA}, 'pcs', 'Pieces', 'قطع', 'count', 1, true)`;

  whA = randomUUID();
  await owner`
    insert into public.warehouse (id, org_id, code, name_en, created_by)
    values (${whA}, ${orgA}, 'MAIN', 'Main', ${userA})`;
  binA = randomUUID();
  binB = randomUUID();
  await owner`
    insert into public.stock_location
      (id, org_id, warehouse_id, code, name_en, kind, is_default_receiving)
    values (${binA}, ${orgA}, ${whA}, 'STORE', 'Store', 'storage', true),
           (${binB}, ${orgA}, ${whA}, 'BAY', 'Bay two', 'storage', false)`;

  categoryA = (
    await createAssetCategory(ownerCtx(), "owner", {
      code: "PLANT",
      nameEn: "Plant",
      nameAr: "آلات",
    })
  ).id;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, viewerUser, outsiderUser]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 300_000);

describe("stock levels", () => {
  it("aggregates over locations and reports where it is", { timeout: 240_000 }, async () => {
    const item = await anItem(`AGG-${run}`);
    await receive(item, 6, { location: binA });
    await receive(item, 4, { location: binB });

    const { rows } = await listStockLevels(ownerCtx(), "owner", { search: `AGG-${run}` });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.onHand)).toBe(10);
    expect(rows[0]!.locationCount).toBe(2);
    // Two bins means no single place to name — the page says "2 locations".
    expect(rows[0]!.soleLocationName).toBeNull();

    const one = await anItem(`ONE-${run}`);
    await receive(one, 3, { location: binB });
    const single = await listStockLevels(ownerCtx(), "owner", { search: `ONE-${run}` });
    expect(single.rows[0]!.soleLocationName).toBe("Bay two");
  });

  it("pages by cursor without skipping or repeating a row", { timeout: 240_000 }, async () => {
    const prefix = `PAGE-${run}`;
    for (let i = 1; i <= 5; i++) {
      const id = await anItem(`${prefix}-${String(i).padStart(2, "0")}`);
      await receive(id, i);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listStockLevels(ownerCtx(), "owner", { search: prefix, limit: 2, cursor });
      seen.push(...page.rows.map((r) => r.sku));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size, "a row was served twice").toBe(5);
    expect([...seen].sort()).toEqual(seen); // keyset order held
  });

  it(
    "counts reservations against the reorder point, not on-hand",
    { timeout: 240_000 },
    async () => {
      /*
       * The distinction the whole reorder feature rests on. Ten on the shelf with
       * eight promised to a job is NOT ten available, and a reorder report that
       * says otherwise reorders after the shortage rather than before it.
       */
      const item = await anItem(`LOW-${run}`, { reorderPoint: 5 });
      await receive(item, 10);
      const before = await listStockLevels(ownerCtx(), "owner", {
        search: `LOW-${run}`,
        lowOnly: true,
      });
      expect(before.rows, "ten on hand against a five point is not low").toHaveLength(0);

      await postMovement(ownerCtx(), "owner", {
        itemId: item,
        warehouseId: whA,
        locationId: binA,
        movementType: "reservation",
        qtyDelta: "0",
        reservedDelta: "8",
        unitId: unitA,
        idempotencyKey: randomUUID(),
      });

      const after = await listStockLevels(ownerCtx(), "owner", {
        search: `LOW-${run}`,
        lowOnly: true,
      });
      expect(after.rows, "two available against a five point IS low").toHaveLength(1);
      expect(Number(after.rows[0]!.available)).toBe(2);
      expect(Number(after.rows[0]!.onHand)).toBe(10);
    },
  );

  it("nulls value outside the cost wall and shows it inside", { timeout: 240_000 }, async () => {
    const item = await anItem(`WALL-${run}`);
    await receive(item, 4, { unitCostMinor: 2500 });

    const privileged = await listStockLevels(ownerCtx(), "owner", { search: `WALL-${run}` });
    expect(privileged.rows[0]!.valueMinor).toBe(10_000);
    expect(privileged.rows[0]!.currency).toBe("AED");

    const walled = await listStockLevels(walledCtx(), "owner", { search: `WALL-${run}` });
    // The quantity is operational and stays; only the money goes.
    expect(walled.rows[0]!.available).toBe(privileged.rows[0]!.available);
    expect(walled.rows[0]!.valueMinor).toBeNull();
    expect(walled.rows[0]!.currency).toBeNull();
  });

  it("refuses a role without the permission instead of returning nothing", async () => {
    // An empty list reads as "there is no stock". A refusal reads as "not yours
    // to see". Those are different facts and the caller must be able to tell.
    await expect(listStockLevels(ownerCtx(), "viewer", {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listMovements(ownerCtx(), "viewer", {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("never shows another organization's stock", { timeout: 240_000 }, async () => {
    const mine = await anItem(`TEN-${run}`);
    await receive(mine, 7);
    const theirs = await listStockLevels(bCtx(), "owner", {});
    expect(theirs.rows.map((r) => r.sku)).not.toContain(`TEN-${run}`);
  });
});

describe("one item", () => {
  it("is not found across a tenancy boundary", { timeout: 240_000 }, async () => {
    const item = await anItem(`XORG-${run}`);
    expect(await getStockItem(ownerCtx(), "owner", item)).not.toBeNull();
    // Null, exactly as for an id that never existed — the caller learns nothing.
    expect(await getStockItem(bCtx(), "owner", item)).toBeNull();
    expect(await getStockItem(ownerCtx(), "owner", randomUUID())).toBeNull();
  });

  it("shows the ledger newest-first and pages it", { timeout: 240_000 }, async () => {
    const item = await anItem(`HIST-${run}`);
    for (let i = 0; i < 4; i++) await receive(item, 1);

    const page = await listMovements(ownerCtx(), "owner", { itemId: item, limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const rest = await listMovements(ownerCtx(), "owner", {
      itemId: item,
      limit: 10,
      cursor: page.nextCursor!,
    });
    const ids = [...page.rows, ...rest.rows].map((m) => m.id);
    expect(new Set(ids).size, "the cursor served a row twice").toBe(4);
    // Descending by the moment it happened.
    const times = [...page.rows, ...rest.rows].map((m) => m.effectiveAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("keeps a movement's cost behind the wall", { timeout: 240_000 }, async () => {
    const item = await anItem(`MCOST-${run}`);
    await receive(item, 2, { unitCostMinor: 5000 });
    const seen = await listMovements(ownerCtx(), "owner", { itemId: item });
    expect(seen.rows[0]!.valueMinor).toBe(10_000);
    const hidden = await listMovements(walledCtx(), "owner", { itemId: item });
    expect(hidden.rows[0]!.valueMinor).toBeNull();
    expect(hidden.rows[0]!.currency).toBeNull();
    expect(hidden.rows[0]!.qtyDelta, "the quantity is not money").toBe(seen.rows[0]!.qtyDelta);
  });

  it(
    "lists batches soonest-expiring first and hides empty ones",
    { timeout: 240_000 },
    async () => {
      const item = await anItem(`LOT-${run}`, { tracking: "lot" });
      const lotLate = randomUUID();
      const lotSoon = randomUUID();
      const lotGone = randomUUID();
      await owner`
      insert into public.stock_lot (id, org_id, item_id, code, expiry_date, created_by)
      values (${lotLate}, ${orgA}, ${item}, ${"L-LATE-" + run}, ${days(90)}, ${userA}),
             (${lotSoon}, ${orgA}, ${item}, ${"L-SOON-" + run}, ${days(5)}, ${userA}),
             (${lotGone}, ${orgA}, ${item}, ${"L-GONE-" + run}, ${days(2)}, ${userA})`;
      for (const [lot, qty] of [
        [lotLate, 5],
        [lotSoon, 3],
      ] as const) {
        await postMovement(ownerCtx(), "owner", {
          itemId: item,
          warehouseId: whA,
          locationId: binA,
          movementType: "goods_receipt",
          qtyDelta: String(qty),
          unitId: unitA,
          currency: "AED",
          unitCostMinor: 1000,
          lots: [{ lotId: lot, qty }],
          idempotencyKey: randomUUID(),
        });
      }

      const lots = await listItemLots(ownerCtx(), "owner", item);
      expect(lots.map((l) => l.code)).toEqual([`L-SOON-${run}`, `L-LATE-${run}`]);
      // A batch with nothing left is history, not stock — off the shelf list.
      expect(lots.map((l) => l.code)).not.toContain(`L-GONE-${run}`);
      const withEmpty = await listItemLots(ownerCtx(), "owner", item, { includeEmpty: true });
      expect(withEmpty.map((l) => l.code)).toContain(`L-GONE-${run}`);
    },
  );

  it("bounds and pages individual units", { timeout: 240_000 }, async () => {
    const item = await anItem(`SER-${run}`, { tracking: "serial" });
    for (let i = 1; i <= 4; i++) {
      await owner`
        insert into public.stock_serial
          (org_id, item_id, serial_no, status, warehouse_id, location_id, created_by)
        values (${orgA}, ${item}, ${`SN-${run}-${i}`}, 'in_stock', ${whA}, ${binA}, ${userA})`;
    }
    const first = await listItemSerials(ownerCtx(), "owner", item, { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const next = await listItemSerials(ownerCtx(), "owner", item, {
      limit: 10,
      cursor: first.nextCursor!,
    });
    expect(new Set([...first.rows, ...next.rows].map((s) => s.serialNo)).size).toBe(4);

    const found = await listItemSerials(ownerCtx(), "owner", item, { search: `SN-${run}-3` });
    expect(found.rows).toHaveLength(1);
  });

  it("caps a caller who asks for more than the maximum", { timeout: 240_000 }, async () => {
    // A page size is a promise about the largest response this can produce.
    // Honouring `limit: 100000` would make every bound in the module decorative.
    const page = await listStockLevels(ownerCtx(), "owner", { limit: 100_000 });
    expect(page.rows.length).toBeLessThanOrEqual(200);
  });
});

describe("one asset", () => {
  it(
    "resolves names, not identifiers, and stops at the tenancy line",
    { timeout: 240_000 },
    async () => {
      const a = await registerAsset(ownerCtx(), "owner", {
        nameEn: "Excavator",
        nameAr: "حفارة",
        categoryId: categoryA,
        acquisitionCostMinor: 750_000,
        currency: "AED",
        warehouseId: whA,
        locationId: binA,
      });
      await setAssetStatus(ownerCtx(), "owner", a.id, "in_service");

      const detail = await assetDetail(ownerCtx(), "owner", a.id);
      expect(detail!.asset.assetNo).toBe(a.assetNo);
      expect(detail!.asset.categoryName).toBe("Plant");
      expect(detail!.asset.locationName).toBe("Store");
      expect(detail!.asset.warehouseName).toBe("Main");
      expect(detail!.asset.acquisitionCostMinor).toBe(750_000);

      // Another organization gets null, the same answer as a made-up id.
      expect(await assetDetail(bCtx(), "owner", a.id)).toBeNull();
      expect(await assetDetail(ownerCtx(), "owner", randomUUID())).toBeNull();
    },
  );

  it(
    "redacts cost outside the wall but keeps the record readable",
    { timeout: 240_000 },
    async () => {
      const a = await registerAsset(ownerCtx(), "owner", {
        nameEn: "Compressor",
        categoryId: categoryA,
        acquisitionCostMinor: 120_000,
        residualValueMinor: 12_000,
        usefulLifeMonths: 60,
        currency: "AED",
      });
      const walled = await assetDetail(walledCtx(), "owner", a.id);
      expect(walled!.asset.acquisitionCostMinor).toBeNull();
      expect(walled!.asset.residualValueMinor).toBeNull();
      expect(walled!.asset.currency).toBeNull();
      // Useful life is not money: H24 needs it and it tells nobody what was paid.
      expect(walled!.asset.usefulLifeMonths).toBe(60);
      expect(walled!.asset.nameEn).toBe("Compressor");
    },
  );

  it("refuses a role without assets.view", async () => {
    await expect(assetDetail(ownerCtx(), "viewer", randomUUID())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("the attention feed", () => {
  it("says what is wrong in facts, not in English sentences", { timeout: 240_000 }, async () => {
    /*
     * The feed used to return finished English prose, which made every Arabic
     * reader's inbox English no matter what the catalogue said. It now returns
     * the numbers and the page does the wording, so this asserts on the shape:
     * a row carries a kind and its variables, and no sentence at all.
     */
    const item = await anItem(`ATT-${run}`, { reorderPoint: 5 });
    await receive(item, 1);

    const feed = await attentionFeed(ownerCtx(), "owner");
    const row = feed.items.find((i) => i.vars.sku === `ATT-${run}`);
    expect(row, "stock under its reorder point did not reach the feed").toBeDefined();
    expect(row!.kind).toBe("stock_below_reorder");
    expect(row!.entityType).toBe("item");
    expect(row!.entityId).toBe(item);
    expect(row!.vars.reorderPoint).toBe("5");
    expect(Object.keys(row!)).not.toContain("title");
    expect(Object.keys(row!)).not.toContain("detail");
  });

  it("is organization scoped", { timeout: 240_000 }, async () => {
    const feed = await attentionFeed(bCtx(), "owner");
    expect(feed.items.some((i) => String(i.vars.sku ?? "").includes(run))).toBe(false);
  });

  it("refuses a role that may not see stock", async () => {
    await expect(attentionFeed(ownerCtx(), "viewer")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

/**
 * The second audit pass: each of these covers a fix, and each fix was for a
 * defect that produced a PLAUSIBLE wrong answer rather than an error. Those are
 * the ones that survive review, so they are the ones that need a test naming
 * exactly what went wrong.
 */
describe("what the audit found", () => {
  it("refuses to total a value held in more than one currency", { timeout: 240_000 }, async () => {
    /*
     * A cost layer records the currency the movement was priced in, which since
     * H22C.1 may be the supplier's rather than the organization's. Summing
     * `value_remaining_minor` across those layers adds minor units that are not
     * the same size — and three of the supported currencies have three decimal
     * places rather than two. The result looked exactly like money.
     */
    const item = await anItem(`MIX-${run}`);
    await receive(item, 2, { unitCostMinor: 1000 }); // AED
    await postMovement(ownerCtx(), "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "goods_receipt",
      qtyDelta: "3",
      unitId: unitA,
      currency: "USD",
      unitCostMinor: 900,
      exchangeRate: 3.6725,
      idempotencyKey: randomUUID(),
    });

    const { rows } = await listStockLevels(ownerCtx(), "owner", { search: `MIX-${run}` });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valueIsMixedCurrency, "two currencies were not noticed").toBe(true);
    expect(rows[0]!.valueMinor, "a meaningless total was reported anyway").toBeNull();
    expect(rows[0]!.currency).toBeNull();
    // The QUANTITY is unaffected: it was never the ambiguous part.
    expect(Number(rows[0]!.onHand)).toBe(5);
  });

  it(
    "prices a warehouse-filtered page from that warehouse only",
    { timeout: 240_000 },
    async () => {
      /*
       * The value CTE was not filtered by warehouse while the quantity CTE was, so
       * narrowing to one warehouse showed that warehouse's stock at the whole
       * organization's value — a number that is right for a page nobody asked for.
       */
      const other = randomUUID();
      await owner`
      insert into public.warehouse (id, org_id, code, name_en, created_by)
      values (${other}, ${orgA}, ${"W2-" + run}, 'Second', ${userA})`;
      const otherBin = randomUUID();
      await owner`
      insert into public.stock_location (id, org_id, warehouse_id, code, name_en, kind)
      values (${otherBin}, ${orgA}, ${other}, ${"B2-" + run}, 'Second bay', 'storage')`;

      const item = await anItem(`WH-${run}`);
      await receive(item, 2, { location: binA, unitCostMinor: 1000 }); // 2 000 here
      await postMovement(ownerCtx(), "owner", {
        itemId: item,
        warehouseId: other,
        locationId: otherBin,
        movementType: "goods_receipt",
        qtyDelta: "5",
        unitId: unitA,
        currency: "AED",
        unitCostMinor: 1000,
        idempotencyKey: randomUUID(),
      });

      const everywhere = await listStockLevels(ownerCtx(), "owner", { search: `WH-${run}` });
      expect(Number(everywhere.rows[0]!.onHand)).toBe(7);
      expect(everywhere.rows[0]!.valueMinor).toBe(7000);

      const justMain = await listStockLevels(ownerCtx(), "owner", {
        search: `WH-${run}`,
        warehouseId: whA,
      });
      expect(Number(justMain.rows[0]!.onHand)).toBe(2);
      expect(justMain.rows[0]!.valueMinor, "priced the whole organization").toBe(2000);
    },
  );

  it(
    "shows a reservation as the promise it is, not a movement of zero",
    { timeout: 240_000 },
    async () => {
      // A reservation posts qty_delta 0 and reserved_delta +n, so a line reading
      // only the quantity rendered "−0" for the event that makes stock unusable.
      const item = await anItem(`RES-${run}`);
      await receive(item, 9);
      await postMovement(ownerCtx(), "owner", {
        itemId: item,
        warehouseId: whA,
        locationId: binA,
        movementType: "reservation",
        qtyDelta: "0",
        reservedDelta: "4",
        unitId: unitA,
        idempotencyKey: randomUUID(),
      });

      const { rows } = await listMovements(ownerCtx(), "owner", { itemId: item });
      const reservation = rows.find((m) => m.movementType === "reservation");
      expect(reservation, "the reservation is not in the ledger view").toBeDefined();
      expect(Number(reservation!.qtyDelta)).toBe(0);
      expect(reservation!.reservedDelta, "nothing to render but a zero").toBe("4");
    },
  );

  it("lets the database decide what has expired", { timeout: 240_000 }, async () => {
    /*
     * This was computed in JavaScript from the server's UTC clock, which is up
     * to four hours behind the Gulf business day — so for the first hours of the
     * day a batch expired, the screen still called it good. The date the rest of
     * the system compares against is the only one that can be right.
     */
    const item = await anItem(`EXP-${run}`, { tracking: "lot" });
    const past = randomUUID();
    const future = randomUUID();
    await owner`
      insert into public.stock_lot (id, org_id, item_id, code, expiry_date, created_by)
      values (${past}, ${orgA}, ${item}, ${"L-PAST-" + run}, ${days(-1)}, ${userA}),
             (${future}, ${orgA}, ${item}, ${"L-FUT-" + run}, ${days(30)}, ${userA})`;
    for (const lot of [past, future]) {
      await postMovement(ownerCtx(), "owner", {
        itemId: item,
        warehouseId: whA,
        locationId: binA,
        movementType: "goods_receipt",
        qtyDelta: "1",
        unitId: unitA,
        currency: "AED",
        unitCostMinor: 100,
        lots: [{ lotId: lot, qty: 1 }],
        idempotencyKey: randomUUID(),
      });
    }

    const lots = await listItemLots(ownerCtx(), "owner", item);
    const byCode = new Map(lots.map((l) => [l.code, l]));
    expect(byCode.get(`L-PAST-${run}`)!.expired).toBe(true);
    expect(byCode.get(`L-FUT-${run}`)!.expired).toBe(false);
  });

  it("finds an item by its Arabic name", { timeout: 240_000 }, async () => {
    // A name that cannot be searched in the language it is written in is not
    // a name. The catalogue stores name_ar and the search ignored it.
    const id = randomUUID();
    await owner`
      insert into public.item
        (id, org_id, sku, name, name_ar, category_key, unit, item_type, base_unit_id,
         tracking, lifecycle, active)
      values (${id}, ${orgA}, ${"AR-" + run}, ${"Steel plate " + run}, ${"لوح فولاذ " + run},
              'material', 'pcs', 'inventory', ${unitA}, 'none', 'active', true)`;
    await receive(id, 3);

    const found = await listStockLevels(ownerCtx(), "owner", { search: "لوح فولاذ" });
    expect(found.rows.map((r) => r.sku)).toContain(`AR-${run}`);
  });
});
