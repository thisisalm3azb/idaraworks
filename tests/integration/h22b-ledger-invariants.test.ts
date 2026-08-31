/**
 * H22B — the stock ledger's invariants, against a real database.
 *
 * These are properties, not examples. A ledger is only a ledger if they hold for
 * every sequence of movements, so each one is asserted after arbitrary activity
 * rather than after one contrived case:
 *
 *   1. on_hand equals the sum of posted qty_delta
 *   2. reserved equals the sum of posted reserved_delta
 *   3. available equals on_hand minus reserved
 *   4. a transfer nets to zero across the organization
 *   5. a reversal plus its original nets to zero
 *   6. the same source event cannot change stock twice
 *   7. the projection equals a recomputation from the ledger
 *
 * Concurrency is tested by racing real calls, not by reasoning about locks.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  postMovement,
  postMovementIn,
  reverseMovement,
  reconcileStockBalances,
  InsufficientStockError,
} from "@/modules/inventory/service";
import { ForbiddenError } from "@/platform/authz";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";
let itemA = "";
let itemFifo = "";
let unitA = "";
let whA = "";
let binA = "";
let binB = "";
let whB = "";
let binOtherOrg = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h22b",
});

const key = () => `k-${randomUUID()}`;

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h22b-${label}-${run}@example.com`}, '{"full_name":"H22B"}'::jsonb, now(), now())`;
}

/** Units, a warehouse and two bins. Written directly: the subject is the ledger. */
async function seedInventory(orgId: string, userId: string) {
  const unit = randomUUID();
  await owner`
    insert into public.unit_of_measure (id, org_id, code, name_en, name_ar, dimension, factor_to_base, is_base)
    values (${unit}, ${orgId}, ${"EA" + randomUUID().slice(0, 4)}, 'Each', 'حبة', 'count', 1, true)`;
  const wh = randomUUID();
  await owner`
    insert into public.warehouse (id, org_id, code, name_en, created_by)
    values (${wh}, ${orgId}, ${"W" + randomUUID().slice(0, 6)}, 'Main store', ${userId})`;
  const bin1 = randomUUID();
  const bin2 = randomUUID();
  await owner`
    insert into public.stock_location (id, org_id, warehouse_id, code, name_en)
    values (${bin1}, ${orgId}, ${wh}, ${"A" + randomUUID().slice(0, 5)}, 'Bin A'),
           (${bin2}, ${orgId}, ${wh}, ${"B" + randomUUID().slice(0, 5)}, 'Bin B')`;
  return { unit, wh, bin1, bin2 };
}

async function seedItem(orgId: string, unitId: string, opts: { costMethod?: string } = {}) {
  const id = randomUUID();
  await owner`
    insert into public.item (id, org_id, sku, name, category_key, unit, base_unit_id, cost_method)
    values (${id}, ${orgId}, ${"SKU-" + randomUUID().slice(0, 8)}, 'Test item',
            'general', 'ea', ${unitId}, ${opts.costMethod ?? null})`;
  return id;
}

/** Sum the ledger directly. The authority every assertion compares against. */
async function ledgerSum(orgId: string, itemId: string) {
  const [r] = (await owner`
    select coalesce(sum(qty_delta), 0)::text as on_hand,
           coalesce(sum(reserved_delta), 0)::text as reserved
    from public.stock_movement where org_id = ${orgId} and item_id = ${itemId}`) as unknown as Array<{
    on_hand: string;
    reserved: string;
  }>;
  return { onHand: Number(r!.on_hand), reserved: Number(r!.reserved) };
}

async function balanceSum(orgId: string, itemId: string) {
  const [r] = (await owner`
    select coalesce(sum(on_hand), 0)::text as on_hand,
           coalesce(sum(reserved), 0)::text as reserved
    from public.stock_balance where org_id = ${orgId} and item_id = ${itemId}`) as unknown as Array<{
    on_hand: string;
    reserved: string;
  }>;
  return { onHand: Number(r!.on_hand), reserved: Number(r!.reserved) };
}

beforeAll(async () => {
  await seedUser(userA, "a");
  await seedUser(userB, "b");
  orgA = await createOrgForUser(userA, { name: "H22B A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "H22B B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h22b-ledger", run);
  await markFixtureOrg(owner, orgB, "h22b-ledger", run);

  // 'general' must exist as an item category for the direct inserts to be valid
  // against the config guard; the item table itself only checks the key shape.
  const a = await seedInventory(orgA, userA);
  unitA = a.unit;
  whA = a.wh;
  binA = a.bin1;
  binB = a.bin2;
  itemA = await seedItem(orgA, unitA);
  itemFifo = await seedItem(orgA, unitA, { costMethod: "fifo" });

  const b = await seedInventory(orgB, userB);
  whB = b.wh;
  binOtherOrg = b.bin1;
}, 300_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 180_000);

describe("the ledger is the source of truth", () => {
  it("on hand equals the sum of posted movements", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA);
    for (const qty of [10, 5, -3, 20, -7, -1]) {
      await postMovement(ctx, "owner", {
        itemId: item,
        warehouseId: whA,
        locationId: binA,
        movementType: qty > 0 ? "adjustment_increase" : "adjustment_decrease",
        qtyDelta: qty,
        unitId: unitA,
        idempotencyKey: key(),
        reason: "invariant test",
      });
    }
    const ledger = await ledgerSum(orgA, item);
    const balance = await balanceSum(orgA, item);
    expect(ledger.onHand).toBe(24);
    expect(balance.onHand, "the projection must equal the ledger").toBe(ledger.onHand);
  });

  it(
    "reserved tracks its own deltas, and available is the difference",
    { timeout: 180_000 },
    async () => {
      const ctx = ctxOf(orgA, userA);
      const item = await seedItem(orgA, unitA);
      await postMovement(ctx, "owner", {
        itemId: item,
        warehouseId: whA,
        locationId: binA,
        movementType: "adjustment_increase",
        qtyDelta: 30,
        unitId: unitA,
        idempotencyKey: key(),
        reason: "seed",
      });
      await postMovement(ctx, "owner", {
        itemId: item,
        warehouseId: whA,
        locationId: binA,
        movementType: "reservation",
        qtyDelta: 0,
        reservedDelta: 12,
        unitId: unitA,
        idempotencyKey: key(),
      });
      const ledger = await ledgerSum(orgA, item);
      const balance = await balanceSum(orgA, item);
      expect(ledger.onHand).toBe(30);
      expect(ledger.reserved).toBe(12);
      expect(balance.onHand - balance.reserved, "available").toBe(18);

      // Releasing gives it back.
      await postMovement(ctx, "owner", {
        itemId: item,
        warehouseId: whA,
        locationId: binA,
        movementType: "reservation_release",
        qtyDelta: 0,
        reservedDelta: -12,
        unitId: unitA,
        idempotencyKey: key(),
      });
      expect((await balanceSum(orgA, item)).reserved).toBe(0);
    },
  );

  it("a transfer nets to zero across the organization", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA);
    await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "adjustment_increase",
      qtyDelta: 50,
      unitId: unitA,
      idempotencyKey: key(),
      reason: "seed",
    });

    // Both legs in ONE transaction: a failure must leave neither.
    await withCtx(ctx, async (tx) => {
      await postMovementIn(tx, ctx, {
        itemId: item,
        warehouseId: whA,
        locationId: binA,
        movementType: "transfer_out",
        qtyDelta: -20,
        unitId: unitA,
        idempotencyKey: key(),
      });
      await postMovementIn(tx, ctx, {
        itemId: item,
        warehouseId: whA,
        locationId: binB,
        movementType: "transfer_in",
        qtyDelta: 20,
        unitId: unitA,
        idempotencyKey: key(),
      });
    });

    const ledger = await ledgerSum(orgA, item);
    expect(ledger.onHand, "a transfer moves stock, it does not create or destroy it").toBe(50);
    const [a] = (await owner`
      select on_hand::text as q from public.stock_balance
      where org_id = ${orgA} and item_id = ${item} and location_id = ${binA}`) as unknown as Array<{
      q: string;
    }>;
    const [b] = (await owner`
      select on_hand::text as q from public.stock_balance
      where org_id = ${orgA} and item_id = ${item} and location_id = ${binB}`) as unknown as Array<{
      q: string;
    }>;
    expect(Number(a!.q)).toBe(30);
    expect(Number(b!.q)).toBe(20);
  });

  it("a failed transfer leg leaves NEITHER leg", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA);
    await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "adjustment_increase",
      qtyDelta: 5,
      unitId: unitA,
      idempotencyKey: key(),
      reason: "seed",
    });
    await expect(
      withCtx(ctx, async (tx) => {
        await postMovementIn(tx, ctx, {
          itemId: item,
          warehouseId: whA,
          locationId: binA,
          movementType: "transfer_out",
          qtyDelta: -5,
          unitId: unitA,
          idempotencyKey: key(),
        });
        // The destination is another organization's bin: the composite foreign
        // key refuses it, and the whole transaction must roll back.
        await postMovementIn(tx, ctx, {
          itemId: item,
          warehouseId: whA,
          locationId: binOtherOrg,
          movementType: "transfer_in",
          qtyDelta: 5,
          unitId: unitA,
          idempotencyKey: key(),
        });
      }),
    ).rejects.toThrow();
    expect((await ledgerSum(orgA, item)).onHand, "the out leg must not survive").toBe(5);
  });

  it("a reversal and its original net to zero", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA);
    const posted = await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "adjustment_increase",
      qtyDelta: 40,
      unitId: unitA,
      idempotencyKey: key(),
      reason: "seed",
    });
    await reverseMovement(ctx, "owner", posted.id, "entered against the wrong bin");

    expect((await ledgerSum(orgA, item)).onHand).toBe(0);
    expect((await balanceSum(orgA, item)).onHand).toBe(0);

    // The original is untouched: history is added to, never edited.
    const [orig] = (await owner`
      select qty_delta::text as q from public.stock_movement where id = ${posted.id}`) as unknown as Array<{
      q: string;
    }>;
    expect(Number(orig!.q)).toBe(40);
  });

  it("a movement cannot be reversed twice", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA);
    const posted = await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "adjustment_increase",
      qtyDelta: 8,
      unitId: unitA,
      idempotencyKey: key(),
      reason: "seed",
    });
    await reverseMovement(ctx, "owner", posted.id, "first");
    // The second attempt is idempotent on the same key rather than double-undoing.
    const second = await reverseMovement(ctx, "owner", posted.id, "second");
    expect(second.posted).toBe(false);
    expect((await ledgerSum(orgA, item)).onHand, "double reversal would give -8").toBe(0);
  });
});

describe("the ledger is append-only", () => {
  it("refuses UPDATE and DELETE even to the table owner", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA);
    const posted = await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "adjustment_increase",
      qtyDelta: 3,
      unitId: unitA,
      idempotencyKey: key(),
      reason: "seed",
    });
    await expect(
      owner`update public.stock_movement set qty_delta = 999 where id = ${posted.id}`,
    ).rejects.toThrow(/append-only/i);
    await expect(owner`delete from public.stock_movement where id = ${posted.id}`).rejects.toThrow(
      /append-only/i,
    );
  });
});

describe("idempotency and source-event protection", () => {
  it("the same idempotency key posts once", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA);
    const k = key();
    const first = await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "adjustment_increase",
      qtyDelta: 15,
      unitId: unitA,
      idempotencyKey: k,
      reason: "seed",
    });
    const retry = await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "adjustment_increase",
      qtyDelta: 15,
      unitId: unitA,
      idempotencyKey: k,
      reason: "seed",
    });
    expect(retry.posted).toBe(false);
    expect(retry.id).toBe(first.id);
    expect((await ledgerSum(orgA, item)).onHand, "a retry must not double the stock").toBe(15);
  });

  it("concurrent retries of one key still post once", { timeout: 240_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA);
    const k = key();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        postMovement(ctx, "owner", {
          itemId: item,
          warehouseId: whA,
          locationId: binA,
          movementType: "adjustment_increase",
          qtyDelta: 10,
          unitId: unitA,
          idempotencyKey: k,
          reason: "race",
        }),
      ),
    );
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect((await ledgerSum(orgA, item)).onHand, "exactly one posting").toBe(10);
  });
});

describe("concurrency", () => {
  it("simultaneous receipts never lose quantity", { timeout: 240_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA);
    const n = 8;
    await Promise.all(
      Array.from({ length: n }, () =>
        postMovement(ctx, "owner", {
          itemId: item,
          warehouseId: whA,
          locationId: binA,
          movementType: "adjustment_increase",
          qtyDelta: 5,
          unitId: unitA,
          idempotencyKey: key(),
          reason: "concurrent receipt",
        }),
      ),
    );
    expect((await balanceSum(orgA, item)).onHand, "no lost update").toBe(5 * n);
    expect((await ledgerSum(orgA, item)).onHand).toBe(5 * n);
  });

  it("simultaneous issues cannot overspend the same stock", { timeout: 240_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA);
    await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "adjustment_increase",
      qtyDelta: 10,
      unitId: unitA,
      idempotencyKey: key(),
      reason: "seed",
    });
    // Ten racers each want 2 from a stock of 10: exactly five may win.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        postMovement(ctx, "owner", {
          itemId: item,
          warehouseId: whA,
          locationId: binA,
          movementType: "material_issue",
          qtyDelta: -2,
          unitId: unitA,
          idempotencyKey: key(),
        }),
      ),
    );
    const won = results.filter((r) => r.status === "fulfilled").length;
    expect(won).toBe(5);
    const after = await balanceSum(orgA, item);
    expect(after.onHand, "stock never goes below zero").toBe(0);
    expect(after.onHand).toBe((await ledgerSum(orgA, item)).onHand);
  });
});

describe("negative stock", () => {
  it("is refused by default", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA);
    await expect(
      postMovement(ctx, "owner", {
        itemId: item,
        warehouseId: whA,
        locationId: binA,
        movementType: "material_issue",
        qtyDelta: -1,
        unitId: unitA,
        idempotencyKey: key(),
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect((await ledgerSum(orgA, item)).onHand).toBe(0);
  });

  it("is permitted for an item that explicitly allows it", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA);
    await owner`update public.item set allow_negative_stock = true where id = ${item}`;
    await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "material_issue",
      qtyDelta: -4,
      unitId: unitA,
      idempotencyKey: key(),
      reason: "approved override",
    });
    expect((await balanceSum(orgA, item)).onHand).toBe(-4);
  });

  it("reserving more than exists is always refused", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA);
    await owner`update public.item set allow_negative_stock = true where id = ${item}`;
    await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "adjustment_increase",
      qtyDelta: 3,
      unitId: unitA,
      idempotencyKey: key(),
      reason: "seed",
    });
    await expect(
      postMovement(ctx, "owner", {
        itemId: item,
        warehouseId: whA,
        locationId: binA,
        movementType: "reservation",
        qtyDelta: 0,
        reservedDelta: 10,
        unitId: unitA,
        idempotencyKey: key(),
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });
});

describe("costing", () => {
  it("weighted average charges the running average", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA, { costMethod: "weighted_average" });
    // 10 at 100, then 10 at 200 → average 150.
    await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "goods_receipt",
      qtyDelta: 10,
      unitId: unitA,
      unitCostMinor: 100,
      currency: "AED",
      exchangeRate: 1,
      idempotencyKey: key(),
    });
    await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "goods_receipt",
      qtyDelta: 10,
      unitId: unitA,
      unitCostMinor: 200,
      currency: "AED",
      exchangeRate: 1,
      idempotencyKey: key(),
    });
    const issue = await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "material_issue",
      qtyDelta: -4,
      unitId: unitA,
      idempotencyKey: key(),
    });
    expect(issue.costTotalMinor, "4 at the 150 average").toBe(600);
  });

  it("FIFO charges the oldest layer first", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    await postMovement(ctx, "owner", {
      itemId: itemFifo,
      warehouseId: whA,
      locationId: binA,
      movementType: "goods_receipt",
      qtyDelta: 10,
      unitId: unitA,
      unitCostMinor: 100,
      currency: "AED",
      exchangeRate: 1,
      effectiveAt: "2026-01-01T00:00:00Z",
      idempotencyKey: key(),
    });
    await postMovement(ctx, "owner", {
      itemId: itemFifo,
      warehouseId: whA,
      locationId: binA,
      movementType: "goods_receipt",
      qtyDelta: 10,
      unitId: unitA,
      unitCostMinor: 200,
      currency: "AED",
      exchangeRate: 1,
      effectiveAt: "2026-02-01T00:00:00Z",
      idempotencyKey: key(),
    });
    // 12 out: 10 from the 100 layer, 2 from the 200 layer = 1000 + 400.
    const issue = await postMovement(ctx, "owner", {
      itemId: itemFifo,
      warehouseId: whA,
      locationId: binA,
      movementType: "material_issue",
      qtyDelta: -12,
      unitId: unitA,
      idempotencyKey: key(),
    });
    expect(issue.costTotalMinor).toBe(1400);

    // And the trail says which layers, not just a total.
    const consumed = (await owner`
      select qty::text as qty, unit_cost_minor from public.stock_layer_consumption
      where org_id = ${orgA} and movement_id = ${issue.id} order by unit_cost_minor`) as unknown as Array<{
      qty: string;
      unit_cost_minor: string;
    }>;
    expect(consumed).toHaveLength(2);
    expect(Number(consumed[0]!.qty)).toBe(10);
    expect(Number(consumed[0]!.unit_cost_minor)).toBe(100);
    expect(Number(consumed[1]!.qty)).toBe(2);
    expect(Number(consumed[1]!.unit_cost_minor)).toBe(200);
  });

  it("a foreign-currency receipt freezes its base cost", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const item = await seedItem(orgA, unitA, { costMethod: "fifo" });
    // 100 USD at 3.6725 → 367 minor in base.
    await postMovement(ctx, "owner", {
      itemId: item,
      warehouseId: whA,
      locationId: binA,
      movementType: "goods_receipt",
      qtyDelta: 1,
      unitId: unitA,
      unitCostMinor: 100,
      currency: "USD",
      exchangeRate: 3.6725,
      idempotencyKey: key(),
    });
    const [layer] = (await owner`
      select unit_cost_minor, original_unit_cost_minor, currency, exchange_rate::text as rate
      from public.stock_cost_layer where org_id = ${orgA} and item_id = ${item}`) as unknown as Array<
      Record<string, string>
    >;
    expect(Number(layer!.unit_cost_minor), "base currency").toBe(367);
    expect(Number(layer!.original_unit_cost_minor), "as invoiced").toBe(100);
    expect(layer!.currency).toBe("USD");
    expect(Number(layer!.rate)).toBeCloseTo(3.6725, 4);
  });
});

describe("reconciliation reports drift rather than hiding it", () => {
  it("finds no drift after ordinary activity", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const result = await reconcileStockBalances(ctx, "owner");
    expect(result.drift, "every posting maintained its projection").toEqual([]);
  });

  it(
    "detects a projection that has been corrupted, and does not fix it silently",
    { timeout: 180_000 },
    async () => {
      const ctx = ctxOf(orgA, userA);
      const item = await seedItem(orgA, unitA);
      await postMovement(ctx, "owner", {
        itemId: item,
        warehouseId: whA,
        locationId: binA,
        movementType: "adjustment_increase",
        qtyDelta: 12,
        unitId: unitA,
        idempotencyKey: key(),
        reason: "seed",
      });
      // Corrupt the cache behind the service's back.
      await owner`
      update public.stock_balance set on_hand = 999
      where org_id = ${orgA} and item_id = ${item} and location_id = ${binA}`;

      const found = await reconcileStockBalances(ctx, "owner");
      const drift = found.drift.find((d) => d.itemId === item);
      expect(drift, "the drift must be reported").toBeTruthy();
      expect(Number(drift!.storedOnHand)).toBe(999);
      expect(Number(drift!.ledgerOnHand)).toBe(12);
      expect(found.repaired, "a read must not repair").toBe(false);
      // Still wrong, deliberately: the report is the point.
      expect((await balanceSum(orgA, item)).onHand).toBe(999);

      // Repair only when asked, and only from the ledger.
      const fixed = await reconcileStockBalances(ctx, "owner", { repair: true });
      expect(fixed.repaired).toBe(true);
      expect((await balanceSum(orgA, item)).onHand).toBe(12);
      expect((await reconcileStockBalances(ctx, "owner")).drift).toEqual([]);
    },
  );
});

describe("isolation and permissions", () => {
  it(
    "another organization's location cannot receive this org's stock",
    { timeout: 180_000 },
    async () => {
      const ctx = ctxOf(orgA, userA);
      await expect(
        postMovement(ctx, "owner", {
          itemId: itemA,
          warehouseId: whB,
          locationId: binOtherOrg,
          movementType: "adjustment_increase",
          qtyDelta: 1,
          unitId: unitA,
          idempotencyKey: key(),
          reason: "cross-org",
        }),
      ).rejects.toThrow();
    },
  );

  it("a role without the action is refused", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    // A foreman may issue but may not adjust.
    await expect(
      postMovement(ctx, "foreman", {
        itemId: itemA,
        warehouseId: whA,
        locationId: binA,
        movementType: "adjustment_increase",
        qtyDelta: 1,
        unitId: unitA,
        idempotencyKey: key(),
        reason: "not allowed",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // And a viewer may not issue.
    await expect(
      postMovement(ctx, "viewer", {
        itemId: itemA,
        warehouseId: whA,
        locationId: binA,
        movementType: "material_issue",
        qtyDelta: -1,
        unitId: unitA,
        idempotencyKey: key(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a source reference must exist in THIS organization", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    await expect(
      postMovement(ctx, "owner", {
        itemId: itemA,
        warehouseId: whA,
        locationId: binA,
        movementType: "goods_receipt",
        qtyDelta: 1,
        unitId: unitA,
        sourceType: "goods_receipt_line",
        sourceId: randomUUID(),
        idempotencyKey: key(),
      }),
      // drizzle wraps the driver error, so the trigger's own message is on the
      // cause rather than the surface. Asserting the CAUSE keeps this a test of
      // the database guard rather than of the wrapper's phrasing.
    ).rejects.toSatisfy((e: unknown) => {
      const text = String((e as { cause?: unknown }).cause ?? e);
      return /no goods_receipt_line in this organization/i.test(text);
    });
  });

  it("a location that cannot hold stock is refused", { timeout: 180_000 }, async () => {
    const ctx = ctxOf(orgA, userA);
    const zone = randomUUID();
    await owner`
      insert into public.stock_location (id, org_id, warehouse_id, code, name_en, can_hold_stock)
      values (${zone}, ${orgA}, ${whA}, ${"Z" + randomUUID().slice(0, 5)}, 'Zone', false)`;
    await expect(
      postMovement(ctx, "owner", {
        itemId: itemA,
        warehouseId: whA,
        locationId: zone,
        movementType: "adjustment_increase",
        qtyDelta: 1,
        unitId: unitA,
        idempotencyKey: key(),
        reason: "into a zone",
      }),
    ).rejects.toThrow(/does not hold stock/i);
  });
});
