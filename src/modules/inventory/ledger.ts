/**
 * The stock ledger (H22B).
 *
 * ONE function posts movements. Everything that changes stock — a receipt, an
 * issue, a transfer, a count correction — goes through `postMovementIn`, so the
 * rules about negative stock, idempotency, cost and balance updating exist in a
 * single place rather than being remembered at each call site.
 *
 * Concurrency rests on locking the BALANCE row, not the item. Two clerks
 * receiving different items never contend; two clerks issuing the same item from
 * the same bin serialise on that one row, which is the smallest correct scope.
 * The lock is taken before the balance is read, so the read-check-write sequence
 * cannot interleave and lose an update or overspend available stock.
 *
 * Cost is decided at post time and frozen. Three methods, per IAS 2.23-25:
 *   specific   — the layer belonging to THIS unit. Mandatory for items that are
 *                not ordinarily interchangeable (serialised, project-segregated).
 *   fifo       — oldest layer first.
 *   weighted   — the running average on the balance row.
 * LIFO is absent: IAS 2.25 permits only FIFO and weighted average, and specific
 * identification is required rather than optional where 2.23 applies.
 */
import { randomUUID } from "node:crypto";
import { sql, type Ctx, type TenantTx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import { command } from "@/platform/audit";
import type { RoleArchetype } from "@/platform/registries";

export class InsufficientStockError extends Error {
  constructor(
    readonly available: string,
    readonly requested: string,
  ) {
    super(`insufficient stock: ${available} available, ${requested} requested`);
    this.name = "InsufficientStockError";
  }
}

export class StockMovementConflictError extends Error {
  constructor(what: string) {
    super(what);
    this.name = "StockMovementConflictError";
  }
}

export class LocationCannotHoldStockError extends Error {
  constructor() {
    super("that location does not hold stock");
    this.name = "LocationCannotHoldStockError";
  }
}

export const COST_METHODS = ["weighted_average", "fifo", "specific"] as const;
export type CostMethod = (typeof COST_METHODS)[number];

/**
 * Movement types that add physical stock, and therefore create a cost layer.
 *
 * `count_correction` is here even though it runs both ways: a count that finds
 * goods the ledger did not know about adds quantity, and quantity with no cost
 * behind it is issued later for nothing. Leaving it out made two spellings of
 * one business fact — "adjust up" and "count found more" — value the same goods
 * differently.
 */
const INBOUND = new Set([
  "opening_balance",
  "goods_receipt",
  "job_return",
  "transfer_in",
  "adjustment_increase",
  "count_correction",
  "assembly_produce",
  "disassembly_produce",
]);

export type PostMovementInput = {
  itemId: string;
  warehouseId: string;
  locationId: string;
  movementType: string;
  /** Physical change. Positive in, negative out, zero for a pure reservation. */
  qtyDelta: string | number;
  /** Promise change. Positive to reserve, negative to release. */
  reservedDelta?: string | number;
  unitId: string;
  /** Required on an inbound movement that should carry cost. */
  unitCostMinor?: number | null;
  currency?: string | null;
  exchangeRate?: number | null;
  effectiveAt?: string;
  sourceType?: string | null;
  sourceId?: string | null;
  /** Same key twice posts once. Callers derive it from the source event. */
  idempotencyKey: string;
  reason?: string | null;
  note?: string | null;
  /**
   * Which batches moved, and how much of each. Quantities are POSITIVE however
   * the movement runs: the ledger signs them to match, so a caller never has to
   * remember which direction it is going.
   *
   * Required for a lot-tracked item and refused for any other, because a batch
   * number on a fungible item is a number nobody can act on.
   */
  lots?: ReadonlyArray<{ lotId: string; qty: number }> | null;
  /** Which serialised units moved. One id per unit; the quantity follows. */
  serialIds?: readonly string[] | null;
  /**
   * The EXACT value arriving, when the caller already knows it to the minor unit.
   *
   * A transfer, an assembly and a disassembly all move value that has already
   * been drawn out of somewhere else. Re-deriving it from a unit cost would round
   * a second time and lose or invent a few minor units on every move; passing the
   * total through means what left one place is precisely what arrives at the next.
   */
  inboundValueMinor?: number | null;
  /**
   * Undo this receipt's own cost layers rather than the oldest open ones. Used
   * where a movement is known to reverse a specific delivery.
   */
  preferLayersFromMovementId?: string | null;
  /**
   * Set ONLY by reverseMovement. The table refuses UPDATE, so a reversal has to
   * name the movement it undoes in the insert itself.
   */
  reversesMovementId?: string | null;
};

export class TrackingRequiredError extends Error {
  constructor(what: string) {
    super(what);
    this.name = "TrackingRequiredError";
  }
}

export type PostedMovement = {
  id: string;
  /** False when an identical key had already posted: the retry did nothing. */
  posted: boolean;
  onHand: string;
  reserved: string;
  /** What the movement was CHARGED, by the item's cost method. */
  costTotalMinor: number | null;
  /**
   * What the cost layers actually gave up.
   *
   * The same as costTotalMinor under FIFO and specific identification, and
   * different under weighted average, which charges the running average while
   * still drawing the layers down. Anything RELOCATING value — a transfer, an
   * assembly, a disassembly — must carry this number, or it credits the
   * destination with a figure the source never lost.
   */
  layerValueMinor: number | null;
};

/** The organization's default cost method, and whether it permits negatives. */
export async function inventoryPolicy(
  tx: TenantTx,
  ctx: Ctx,
): Promise<{ costMethod: CostMethod; allowNegative: boolean }> {
  const rows = (await tx.execute(sql`
    select value from public.app_settings
    where org_id = ${ctx.orgId} and key = 'inventory.policy'
  `)) as unknown as Array<{ value: { costMethod?: string; allowNegative?: boolean } }>;
  const v = rows[0]?.value ?? {};
  const method = (COST_METHODS as readonly string[]).includes(v.costMethod ?? "")
    ? (v.costMethod as CostMethod)
    : "weighted_average";
  return { costMethod: method, allowNegative: v.allowNegative === true };
}

/**
 * Post one movement inside the caller's transaction.
 *
 * Transactional by construction: a transfer posts both legs by calling this
 * twice in one transaction, so a failure leaves neither leg rather than a
 * half-moved quantity.
 */
export async function postMovementIn(
  tx: TenantTx,
  ctx: Ctx,
  input: PostMovementInput,
): Promise<PostedMovement> {
  const qtyDelta = String(input.qtyDelta);
  const reservedDelta = String(input.reservedDelta ?? 0);

  // An identical key posts once. Checked first so a retry is cheap and cannot
  // take the balance lock behind a request that already succeeded.
  const existing = (await tx.execute(sql`
    select id::text as id from public.stock_movement
    where org_id = ${ctx.orgId} and idempotency_key = ${input.idempotencyKey}
  `)) as unknown as Array<{ id: string }>;
  if (existing[0]) {
    const bal = await readBalance(tx, ctx, input);
    return {
      id: existing[0].id,
      posted: false,
      onHand: bal.onHand,
      reserved: bal.reserved,
      costTotalMinor: null,
      layerValueMinor: null,
    };
  }

  /*
   * What identity this item's movements must carry.
   *
   * Checked here as well as by the deferred constraint trigger, because the
   * trigger fires at COMMIT and reports the whole transaction as broken, while a
   * caller that forgot the lot wants to be told which call was wrong.
   */
  const tracking = await itemTracking(tx, ctx, input.itemId);
  const lots = (input.lots ?? []).filter((l) => l.qty !== 0);
  const serialIds = input.serialIds ?? [];
  const moves = Number(qtyDelta) !== 0;
  if (tracking === "none" && (lots.length > 0 || serialIds.length > 0)) {
    throw new TrackingRequiredError("this item is not lot- or serial-tracked");
  }
  if (tracking === "lot" && moves) {
    if (serialIds.length > 0)
      throw new TrackingRequiredError("this item is lot-tracked, not serialised");
    const named = lots.reduce((s, l) => s + l.qty, 0);
    if (Math.abs(named - Math.abs(Number(qtyDelta))) > 1e-9) {
      throw new TrackingRequiredError(
        `this item is lot-tracked: name the lots for all ${Math.abs(Number(qtyDelta))} (named ${named})`,
      );
    }
  }
  if (tracking === "serial" && moves) {
    if (lots.length > 0)
      throw new TrackingRequiredError("this item is serialised, not lot-tracked");
    if (serialIds.length !== Math.abs(Number(qtyDelta))) {
      throw new TrackingRequiredError(
        `this item is serialised: name ${Math.abs(Number(qtyDelta))} unit(s), not ${serialIds.length}`,
      );
    }
    if (new Set(serialIds).size !== serialIds.length) {
      throw new TrackingRequiredError("the same unit is named twice");
    }
  }

  // The location must be a place stock can rest. A movement into a zone that
  // merely groups shelves is almost always a mistake, and one that silently
  // succeeds is a balance nobody can find later.
  const loc = (await tx.execute(sql`
    select can_hold_stock, active from public.stock_location
    where id = ${input.locationId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ can_hold_stock: boolean; active: boolean }>;
  if (!loc[0]) throw new StockMovementConflictError("location not found");
  if (!loc[0].can_hold_stock) throw new LocationCannotHoldStockError();
  if (!loc[0].active && Number(qtyDelta) > 0) {
    throw new StockMovementConflictError("an inactive location cannot receive stock");
  }

  // Take the balance row's lock BEFORE reading it. The insert makes the row
  // exist without disturbing an existing one; the select then blocks any
  // concurrent poster for this exact item/location until this transaction ends.
  await tx.execute(sql`
    insert into public.stock_balance (org_id, item_id, warehouse_id, location_id)
    values (${ctx.orgId}, ${input.itemId}, ${input.warehouseId}, ${input.locationId})
    on conflict do nothing
  `);
  const balRows = (await tx.execute(sql`
    select on_hand::text as on_hand, reserved::text as reserved,
           avg_unit_cost_minor
    from public.stock_balance
    where org_id = ${ctx.orgId} and item_id = ${input.itemId}
      and warehouse_id = ${input.warehouseId} and location_id = ${input.locationId}
    for update
  `)) as unknown as Array<{
    on_hand: string;
    reserved: string;
    avg_unit_cost_minor: string | null;
  }>;
  const before = balRows[0]!;

  const newOnHand = add(before.on_hand, qtyDelta);
  const newReserved = add(before.reserved, reservedDelta);

  // Negative stock is blocked by default. An organization or a single item may
  // permit it, and then it is a visible decision rather than a silent hole.
  if (lt(newOnHand, "0")) {
    const item = (await tx.execute(sql`
      select allow_negative_stock from public.item
      where id = ${input.itemId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<{ allow_negative_stock: boolean }>;
    const policy = await inventoryPolicy(tx, ctx);
    if (!item[0]?.allow_negative_stock && !policy.allowNegative) {
      throw new InsufficientStockError(before.on_hand, String(-Number(qtyDelta)));
    }
  }
  // A promise of stock that is not there is always refused, whatever the
  // negative-stock policy says: reserving is a commitment to someone.
  if (lt(newReserved, "0")) {
    throw new StockMovementConflictError("cannot release more than is reserved");
  }
  if (gt(newReserved, newOnHand) && Number(reservedDelta) > 0) {
    throw new InsufficientStockError(sub(before.on_hand, before.reserved), String(reservedDelta));
  }

  /*
   * Cost. Inbound movements bring their own; outbound movements take theirs from
   * the layers, by the method that applies to this item.
   *
   * A REVERSAL is neither. It is the same goods going the other way, so its cost
   * is whatever the movement it undoes recorded — restored to the very layers
   * that gave it up, or drawn back out of the layer the original created. Which
   * of the two depends only on which way the original went.
   */
  const reversing = input.reversesMovementId ?? null;
  /*
   * DIRECTION decides, not the type's name.
   *
   * Some types run both ways — a count correction adds what a count found and
   * removes what it did not. Keying only on the type would leave a negative
   * count correction relieving no cost at all, which is the mirror of the bug
   * that put count_correction in INBOUND in the first place.
   */
  const inbound = Number(qtyDelta) > 0 && (INBOUND.has(input.movementType) || reversing !== null);
  const baseUnitCost =
    input.unitCostMinor == null
      ? null
      : Math.round(input.unitCostMinor * (input.exchangeRate ?? 1));

  /*
   * Cost is decided BEFORE the movement is written, because the movement cannot
   * be written twice. The ledger refuses UPDATE, so there is no second pass in
   * which to fill in a total: everything the row will ever say has to be known
   * at the moment of the insert.
   *
   * The id is generated here rather than by the database for the same reason —
   * the layer rows that explain the cost reference the movement, so its identity
   * must exist before it does.
   */
  const movementId = randomUUID();
  let costTotal: number | null = null;
  let nextAvg = before.avg_unit_cost_minor === null ? null : Number(before.avg_unit_cost_minor);
  let plan: CostPlan | null = null;
  let restoredValue: number | null = null;

  // Reversing something that went OUT: the goods return to the layers they came
  // from, at the price those layers charged. No new layer, no new price.
  if (reversing !== null && Number(qtyDelta) > 0) {
    restoredValue = await restoreConsumedLayers(tx, ctx, reversing);
    costTotal = restoredValue;
  }

  if (restoredValue === null && inbound && Number(qtyDelta) > 0) {
    const exact = input.inboundValueMinor ?? null;
    if (exact !== null) {
      // The value was already computed exactly by whoever moved it out.
      costTotal = exact;
    } else if (baseUnitCost !== null) {
      costTotal = Math.round(baseUnitCost * Number(qtyDelta));
    }
    if (costTotal !== null) {
      // Moving average: total value over total quantity, both AFTER this receipt.
      // Computed from the balance as it was, so it never re-reads the layers.
      const priorQty = Number(before.on_hand);
      const priorValue = nextAvg === null ? 0 : nextAvg * Math.max(priorQty, 0);
      const nextQty = priorQty + Number(qtyDelta);
      nextAvg = nextQty > 0 ? Math.round((priorValue + costTotal) / nextQty) : nextAvg;
    }
  } else if (Number(qtyDelta) < 0) {
    // Anything REDUCING stock relieves cost, whatever the movement is called.
    plan = await planCost(tx, ctx, {
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      qty: -Number(qtyDelta),
      avgUnitCostMinor: nextAvg,
      // The cost leaving follows the goods leaving. For a tracked item the
      // layers are chosen by the units named, not by the calendar.
      lots: tracking === "lot" ? lots : null,
      serialIds: tracking === "serial" ? serialIds : null,
      // Undoing a receipt takes back THAT receipt's layer, not the oldest one.
      preferLayersFromMovementId: reversing ?? input.preferLayersFromMovementId ?? null,
    });
    costTotal = plan.total;
  }

  await tx.execute(sql`
    insert into public.stock_movement
      (id, org_id, item_id, warehouse_id, location_id, movement_type,
       qty_delta, reserved_delta, unit_id,
       currency, unit_cost_minor, exchange_rate, base_unit_cost_minor, cost_total_minor,
       effective_at, source_type, source_id, idempotency_key,
       reason, note, reverses_movement_id, actor_user_id)
    values (${movementId}, ${ctx.orgId}, ${input.itemId}, ${input.warehouseId},
            ${input.locationId}, ${input.movementType},
            ${qtyDelta}::numeric, ${reservedDelta}::numeric,
            ${input.unitId}, ${input.currency ?? null}, ${input.unitCostMinor ?? null},
            ${input.exchangeRate ?? null}, ${baseUnitCost}, ${costTotal},
            coalesce(${input.effectiveAt ?? null}::timestamptz, now()),
            ${input.sourceType ?? null},
            ${input.sourceId ?? null}, ${input.idempotencyKey},
            ${input.reason ?? null}, ${input.note ?? null},
            ${input.reversesMovementId ?? null}, ${ctx.userId})
  `);

  // What this movement moved, by name. Written before the cost layers, because
  // an inbound tracked movement creates one layer per lot or per unit.
  await writeTrackingDetail(
    tx,
    ctx,
    movementId,
    Number(qtyDelta),
    input.movementType,
    lots,
    serialIds,
  );

  // A reversal restored the original layers; creating another would double the
  // value it just put back.
  if (restoredValue === null && inbound && costTotal !== null && Number(qtyDelta) > 0) {
    /*
     * One layer per thing that can be identified.
     *
     * An untracked receipt is a single layer for the whole quantity. A lot
     * receipt is one layer per lot, so consuming that lot draws down that lot's
     * cost. A serialised receipt is one layer per unit, which is what makes
     * specific identification possible at all: the layer IS the unit.
     */
    const layers: Array<{ qty: number; lotId: string | null; serialId: string | null }> =
      serialIds.length > 0
        ? serialIds.map((serialId) => ({ qty: 1, lotId: null, serialId }))
        : lots.length > 0
          ? lots.map((l) => ({ qty: l.qty, lotId: l.lotId, serialId: null }))
          : [{ qty: Number(qtyDelta), lotId: null, serialId: null }];

    /*
     * The value is split across the layers so the pieces add back to the whole.
     *
     * The last layer takes the remainder rather than its own rounded share, so
     * three lots sharing a cost of 1000 hold 333, 333 and 334 — not three 333s
     * with a fil unaccounted for.
     */
    const totalQty = layers.reduce((s, l) => s + l.qty, 0);
    let valueLeft = costTotal;
    for (const [i, layer] of layers.entries()) {
      const value =
        i === layers.length - 1
          ? valueLeft
          : Math.min(valueLeft, Math.round((costTotal * layer.qty) / totalQty));
      valueLeft -= value;
      await tx.execute(sql`
        insert into public.stock_cost_layer
          (org_id, item_id, warehouse_id, source_movement_id, qty_received, qty_remaining,
           unit_cost_minor, value_remaining_minor, currency, original_unit_cost_minor,
           exchange_rate, received_at, lot_id, serial_id)
        values (${ctx.orgId}, ${input.itemId}, ${input.warehouseId}, ${movementId},
                ${layer.qty}::numeric, ${layer.qty}::numeric,
                ${Math.round(value / layer.qty)}, ${value},
                ${input.currency ?? "AED"}, ${input.unitCostMinor ?? null},
                ${input.exchangeRate ?? 1},
                coalesce(${input.effectiveAt ?? null}::timestamptz, now()),
                ${layer.lotId}, ${layer.serialId})
      `);
    }
  }
  if (plan) await applyCostPlan(tx, ctx, movementId, plan);

  await tx.execute(sql`
    update public.stock_balance
    set on_hand = ${newOnHand}::numeric,
        reserved = ${newReserved}::numeric,
        avg_unit_cost_minor = ${nextAvg},
        last_movement_at = now(),
        updated_at = now()
    where org_id = ${ctx.orgId} and item_id = ${input.itemId}
      and warehouse_id = ${input.warehouseId} and location_id = ${input.locationId}
  `);

  return {
    id: movementId,
    posted: true,
    onHand: newOnHand,
    reserved: newReserved,
    costTotalMinor: costTotal,
    // What actually left the layer pool, which a relocating caller must carry.
    layerValueMinor: restoredValue !== null ? restoredValue : (plan?.layerTotal ?? costTotal),
  };
}

/** How this item's movements must identify what they move. */
async function itemTracking(
  tx: TenantTx,
  ctx: Ctx,
  itemId: string,
): Promise<"none" | "lot" | "serial"> {
  const rows = (await tx.execute(sql`
    select tracking from public.item where id = ${itemId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ tracking: string }>;
  const t = rows[0]?.tracking;
  return t === "lot" || t === "serial" ? t : "none";
}

/**
 * Record what a movement moved, by name, and move the identities with it.
 *
 * Three writes, in one transaction with the movement:
 *   - the detail rows, which are the permanent record and append-only
 *   - stock_lot_balance, so allocation can find a lot without walking history
 *   - the serials themselves, whose location IS their balance
 *
 * The lot projection takes its row lock the same way stock_balance does:
 * insert-then-select-for-update, so two issues drawing on one lot serialise on
 * that lot's row rather than racing to a negative.
 */
async function writeTrackingDetail(
  tx: TenantTx,
  ctx: Ctx,
  movementId: string,
  qtyDelta: number,
  movementType: string,
  lots: ReadonlyArray<{ lotId: string; qty: number }>,
  serialIds: readonly string[],
): Promise<void> {
  const sign = qtyDelta < 0 ? -1 : 1;

  for (const lot of lots) {
    const signed = sign * Math.abs(lot.qty);
    await tx.execute(sql`
      insert into public.stock_movement_lot (org_id, movement_id, lot_id, qty)
      values (${ctx.orgId}, ${movementId}, ${lot.lotId}, ${signed}::numeric)
    `);
  }

  if (lots.length > 0) {
    const m = (await tx.execute(sql`
      select item_id::text as item_id, warehouse_id::text as warehouse_id,
             location_id::text as location_id
      from public.stock_movement where id = ${movementId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, string>>;
    const at = m[0]!;
    for (const lot of lots) {
      const signed = sign * Math.abs(lot.qty);
      await tx.execute(sql`
        insert into public.stock_lot_balance
          (org_id, item_id, warehouse_id, location_id, lot_id)
        values (${ctx.orgId}, ${at.item_id}, ${at.warehouse_id}, ${at.location_id}, ${lot.lotId})
        on conflict do nothing
      `);
      await tx.execute(sql`
        select on_hand from public.stock_lot_balance
        where org_id = ${ctx.orgId} and item_id = ${at.item_id}
          and warehouse_id = ${at.warehouse_id} and location_id = ${at.location_id}
          and lot_id = ${lot.lotId}
        for update
      `);
      await tx.execute(sql`
        update public.stock_lot_balance
        set on_hand = on_hand + ${signed}::numeric,
            last_movement_at = now(), updated_at = now()
        where org_id = ${ctx.orgId} and item_id = ${at.item_id}
          and warehouse_id = ${at.warehouse_id} and location_id = ${at.location_id}
          and lot_id = ${lot.lotId}
      `);
    }
    /*
     * A batch that has run out says so, so allocation stops considering it.
     *
     * Every balance row for these batches is locked first — including the ones
     * in OTHER locations. Without that, a receipt committing into another bin
     * between the check and the write would leave a batch marked depleted while
     * stock of it sits on a shelf, invisible to every issue that follows.
     */
    const lotIds = sql.join(
      lots.map((x) => sql`${x.lotId}::uuid`),
      sql`, `,
    );
    await tx.execute(sql`
      select id from public.stock_lot
      where org_id = ${ctx.orgId} and id in (${lotIds}) for update
    `);
    await tx.execute(sql`
      select lot_id from public.stock_lot_balance
      where org_id = ${ctx.orgId} and lot_id in (${lotIds}) for update
    `);
    await tx.execute(sql`
      update public.stock_lot l
      set status = 'depleted', updated_at = now()
      where l.org_id = ${ctx.orgId}
        and l.id in (${lotIds})
        and l.status = 'active'
        and not exists (
          select 1 from public.stock_lot_balance b
          where b.org_id = l.org_id and b.lot_id = l.id and b.on_hand > 0
        )
    `);
  }

  for (const serialId of serialIds) {
    await tx.execute(sql`
      insert into public.stock_movement_serial (org_id, movement_id, serial_id)
      values (${ctx.orgId}, ${movementId}, ${serialId})
    `);
  }

  if (serialIds.length > 0) {
    const ids = sql.join(
      serialIds.map((x) => sql`${x}::uuid`),
      sql`, `,
    );
    /*
     * A unit arriving IS in the place the movement names; a unit leaving is
     * nowhere, and the constraint on stock_serial enforces exactly that pairing.
     * Locked first, so two issues cannot both claim the same unit.
     */
    await tx.execute(sql`
      select id from public.stock_serial
      where org_id = ${ctx.orgId} and id in (${ids}) for update
    `);
    if (sign > 0) {
      await tx.execute(sql`
        update public.stock_serial s
        set status = 'in_stock', warehouse_id = m.warehouse_id, location_id = m.location_id,
            updated_at = now()
        from public.stock_movement m
        where m.id = ${movementId} and m.org_id = ${ctx.orgId}
          and s.org_id = ${ctx.orgId} and s.id in (${ids})
      `);
    } else {
      await tx.execute(sql`
        update public.stock_serial
        set status = ${departedStatus(movementType)}, warehouse_id = null, location_id = null,
            updated_at = now()
        where org_id = ${ctx.orgId} and id in (${ids})
      `);
    }
  }
}

/**
 * What became of a unit that left.
 *
 * "Issued" is not the same as "sent back to the supplier" or "built into
 * something else", and a serial's status is the one place anybody looks to find
 * out where a unit went. Recording the same word for every departure would make
 * that field useless precisely when it is needed — a recall, a warranty claim, a
 * customer asking where their machine is.
 */
function departedStatus(movementType: string): string {
  switch (movementType) {
    case "supplier_return":
      return "returned";
    case "assembly_consume":
    case "disassembly_consume":
    case "job_consumption":
      return "consumed";
    case "adjustment_decrease":
    case "count_correction":
      return "scrapped";
    default:
      // Issues, transfers out and reversals of a receipt. A transfer's other leg
      // puts the unit back in stock at its new home in the same transaction.
      return "issued";
  }
}

/**
 * Which layers an outbound movement will take, and what that costs.
 *
 * `total` is what the movement is CHARGED — the average under weighted average,
 * the layers' own cost under FIFO and specific identification. `layerTotal` is
 * what the layer pool actually GAVE UP, which is the same thing only under the
 * latter two.
 *
 * They have to be separate. A transfer must put back into the destination
 * exactly what came out of the source pool, and under weighted average the
 * charge is a different number: crediting the destination with the average while
 * debiting the source with the layers invents or destroys the difference on
 * every move. Anything relocating value uses layerTotal; anything reporting cost
 * uses total.
 */
type CostPlan = {
  total: number | null;
  layerTotal: number;
  draws: Array<{ layerId: string; qty: number; valueMinor: number }>;
};

type LayerRow = {
  id: string;
  qty_remaining: string;
  unit_cost_minor: string;
  value_remaining_minor: string;
};

/**
 * Decide what an outbound movement costs, WITHOUT writing anything.
 *
 * Read-only because the total has to be known before the movement row exists,
 * and the movement row cannot be updated afterwards. The layers are locked here
 * (`for update`) so a concurrent issue cannot invalidate the plan between
 * planning and applying: the lock is held to the end of the transaction.
 *
 * FIFO and specific identification both take the cost FROM the layers; they
 * differ only in which layer comes first, which is the ordering. Weighted
 * average charges the running average but still draws the quantity down, so the
 * layers remain a complete history if the method ever changes.
 *
 * When the movement names lots or serials, the layers are chosen BY NAME. That
 * is the difference between specific identification and a first-in-first-out
 * that agrees with it by coincidence: issuing serial 007 draws serial 007's
 * layer, whatever else was received earlier.
 */
async function planCost(
  tx: TenantTx,
  ctx: Ctx,
  args: {
    itemId: string;
    warehouseId: string;
    qty: number;
    avgUnitCostMinor: number | null;
    lots?: ReadonlyArray<{ lotId: string; qty: number }> | null;
    serialIds?: readonly string[] | null;
    /** Undo this receipt's own layers first — see below. */
    preferLayersFromMovementId?: string | null;
  },
): Promise<CostPlan> {
  const method = await itemCostMethod(tx, ctx, args.itemId);
  const draws: CostPlan["draws"] = [];
  let layerTotal = 0;

  /*
   * Take quantity AND the value that goes with it.
   *
   * The last draw on a layer takes everything left rather than a rate times a
   * quantity, so the residues that rounding creates cannot escape. A layer that
   * cost 1000 for 7 units gives up exactly 1000 across however many draws empty
   * it, whatever 1000/7 rounds to on the way.
   */
  const take = (layers: LayerRow[], wanted: number) => {
    let left = wanted;
    for (const layer of layers) {
      if (left <= 0) break;
      const available = Number(layer.qty_remaining);
      const qty = Math.min(left, available);
      const valueLeft = Number(layer.value_remaining_minor);
      const value =
        qty >= available
          ? valueLeft
          : Math.min(valueLeft, Math.round((valueLeft * qty) / available));
      draws.push({ layerId: layer.id, qty, valueMinor: value });
      layerTotal += value;
      left -= qty;
    }
  };

  const COLUMNS = sql`id::text as id, qty_remaining::text as qty_remaining,
                      unit_cost_minor, value_remaining_minor::text as value_remaining_minor`;

  if (args.serialIds && args.serialIds.length > 0) {
    // One layer per unit, so the cost of this issue is the sum of exactly these
    // units' own costs. Nothing else can be drawn.
    const layers = (await tx.execute(sql`
      select ${COLUMNS}
      from public.stock_cost_layer
      where org_id = ${ctx.orgId} and qty_remaining > 0
        and serial_id in (${sql.join(
          args.serialIds.map((s) => sql`${s}::uuid`),
          sql`, `,
        )})
      for update
    `)) as unknown as LayerRow[];
    take(layers, layers.length);
    return { total: layerTotal > 0 ? layerTotal : null, layerTotal, draws };
  }

  if (args.lots && args.lots.length > 0) {
    // Each lot pays for its own quantity, oldest layer of that lot first — a lot
    // can be received more than once. Scoped to the warehouse the goods are
    // leaving: the same batch can sit in two warehouses, and drawing the other
    // one's layer would charge stock that never moved.
    for (const lot of args.lots) {
      const layers = (await tx.execute(sql`
        select ${COLUMNS}
        from public.stock_cost_layer
        where org_id = ${ctx.orgId} and item_id = ${args.itemId}
          and warehouse_id = ${args.warehouseId}
          and lot_id = ${lot.lotId} and qty_remaining > 0
        order by received_at, created_at
        for update
      `)) as unknown as LayerRow[];
      take(layers, Math.abs(lot.qty));
    }
    if (method === "weighted_average") {
      return {
        total: args.avgUnitCostMinor === null ? null : Math.round(args.avgUnitCostMinor * args.qty),
        layerTotal,
        draws,
      };
    }
    return { total: layerTotal > 0 ? layerTotal : null, layerTotal, draws };
  }

  /*
   * Ordinary first-in-first-out, unless this movement undoes a specific receipt.
   *
   * Returning goods to the supplier, or reversing a receipt, must give back the
   * cost THAT delivery brought in — not the oldest open layer, which may belong
   * to a different delivery at a different price. Naming the movement puts its
   * layers first while still falling through to the rest if it is short.
   */
  const preferred = args.preferLayersFromMovementId ?? null;
  const layers = (await tx.execute(sql`
    select ${COLUMNS}
    from public.stock_cost_layer
    where org_id = ${ctx.orgId} and item_id = ${args.itemId}
      and warehouse_id = ${args.warehouseId} and qty_remaining > 0
    order by (source_movement_id = ${preferred}::uuid) desc nulls last, received_at, created_at
    for update
  `)) as unknown as LayerRow[];
  take(layers, args.qty);

  if (method === "weighted_average" && preferred === null) {
    return {
      total: args.avgUnitCostMinor === null ? null : Math.round(args.avgUnitCostMinor * args.qty),
      layerTotal,
      draws,
    };
  }
  // Issuing more than the layers hold is only reachable when negative stock is
  // permitted. The uncosted remainder stays uncosted rather than being guessed.
  return { total: layerTotal > 0 ? layerTotal : null, layerTotal, draws };
}

/** Write the plan: draw the layers down and record what each one gave. */
async function applyCostPlan(
  tx: TenantTx,
  ctx: Ctx,
  movementId: string,
  plan: CostPlan,
): Promise<void> {
  for (const d of plan.draws) {
    await tx.execute(sql`
      update public.stock_cost_layer
      set qty_remaining = qty_remaining - ${d.qty}::numeric,
          value_remaining_minor = value_remaining_minor - ${d.valueMinor},
          depleted_at = case when qty_remaining - ${d.qty}::numeric <= 0 then now() else null end
      where id = ${d.layerId} and org_id = ${ctx.orgId}
    `);
    await tx.execute(sql`
      insert into public.stock_layer_consumption
        (org_id, movement_id, layer_id, qty, unit_cost_minor, value_minor)
      values (${ctx.orgId}, ${movementId}, ${d.layerId}, ${d.qty}::numeric,
              ${d.qty === 0 ? 0 : Math.round(d.valueMinor / d.qty)}, ${d.valueMinor})
    `);
  }
}

/**
 * Put back what a reversed movement took.
 *
 * A reversal is not a fresh receipt: the goods coming back are the same goods,
 * so they return to the layers they left, at the price they left at. Reading
 * stock_layer_consumption means this cannot guess — it restores exactly what the
 * original recorded taking, layer by layer.
 */
async function restoreConsumedLayers(
  tx: TenantTx,
  ctx: Ctx,
  originalMovementId: string,
): Promise<number | null> {
  /*
   * Every draw, in pages.
   *
   * A serialised item gets one layer per unit, so an issue of 1500 units drew
   * 1500 layers. Reading a single capped page would restore some of them and
   * leave the rest depleted while the quantity came back in full — a silent,
   * permanent divergence between the layers and the balance.
   */
  const drawn: Array<{ layer_id: string; qty: string; value_minor: string }> = [];
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    const page = (await tx.execute(sql`
      select layer_id::text as layer_id, qty::text as qty, value_minor::text as value_minor
      from public.stock_layer_consumption
      where movement_id = ${originalMovementId} and org_id = ${ctx.orgId}
      order by layer_id, id
      limit ${PAGE} offset ${offset}
    `)) as unknown as Array<{ layer_id: string; qty: string; value_minor: string }>;
    drawn.push(...page);
    if (page.length < PAGE) break;
  }
  if (drawn.length === 0) return null;

  let total = 0;
  for (const d of drawn) {
    // The EXACT amount the draw took, not a rate re-multiplied — that second
    // rounding is what made a reversal credit a different number from the one
    // the original charged.
    const value = Number(d.value_minor);
    await tx.execute(sql`
      update public.stock_cost_layer
      set qty_remaining = qty_remaining + ${d.qty}::numeric,
          value_remaining_minor = value_remaining_minor + ${value},
          depleted_at = null
      where id = ${d.layer_id} and org_id = ${ctx.orgId}
    `);
    total += value;
  }
  return total;
}

/**
 * The method for this item: its own if set, otherwise the organization's.
 *
 * A serialised item is forced to specific identification regardless, because
 * IAS 2.23 makes it mandatory for items that are not ordinarily interchangeable
 * and a setting cannot make one interchangeable.
 */
async function itemCostMethod(tx: TenantTx, ctx: Ctx, itemId: string): Promise<CostMethod> {
  const rows = (await tx.execute(sql`
    select cost_method, tracking from public.item
    where id = ${itemId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ cost_method: string | null; tracking: string }>;
  if (rows[0]?.tracking === "serial") return "specific";
  if (rows[0]?.cost_method === "fifo") return "fifo";
  if (rows[0]?.cost_method === "weighted_average") return "weighted_average";
  return (await inventoryPolicy(tx, ctx)).costMethod;
}

async function readBalance(
  tx: TenantTx,
  ctx: Ctx,
  where: { itemId: string; warehouseId: string; locationId: string },
): Promise<{ onHand: string; reserved: string }> {
  const rows = (await tx.execute(sql`
    select on_hand::text as on_hand, reserved::text as reserved
    from public.stock_balance
    where org_id = ${ctx.orgId} and item_id = ${where.itemId}
      and warehouse_id = ${where.warehouseId} and location_id = ${where.locationId}
  `)) as unknown as Array<{ on_hand: string; reserved: string }>;
  return { onHand: rows[0]?.on_hand ?? "0", reserved: rows[0]?.reserved ?? "0" };
}

// Decimal arithmetic through Number is safe here: quantities are numeric(20,6)
// and the values a warehouse holds are far inside the 2^53 integer-precision
// range once scaled. The DATABASE does the authoritative arithmetic; these
// helpers only decide whether to refuse before writing.
const add = (a: string, b: string) => String(Number(a) + Number(b));
const sub = (a: string, b: string) => String(Number(a) - Number(b));
const lt = (a: string, b: string) => Number(a) < Number(b);
const gt = (a: string, b: string) => Number(a) > Number(b);

/**
 * Post a movement in its own transaction, with audit.
 *
 * The permission is chosen by what the movement DOES, not by a single blanket
 * "inventory" right: receiving, issuing, transferring and adjusting are separate
 * because the person who books goods in should not be the only check on the
 * person who writes them off.
 */
const ACTION_FOR: Record<string, Parameters<typeof assertCan>[1]> = {
  opening_balance: "inventory.adjust",
  goods_receipt: "inventory.receive",
  supplier_return: "inventory.receive",
  material_issue: "inventory.issue",
  job_consumption: "inventory.issue",
  job_return: "inventory.issue",
  transfer_out: "inventory.transfer",
  transfer_in: "inventory.transfer",
  adjustment_increase: "inventory.adjust",
  adjustment_decrease: "inventory.adjust",
  count_correction: "inventory.count",
  reservation: "inventory.issue",
  reservation_release: "inventory.issue",
  assembly_consume: "inventory.issue",
  assembly_produce: "inventory.receive",
  disassembly_consume: "inventory.issue",
  disassembly_produce: "inventory.receive",
  asset_capitalization: "inventory.receive",
  reversal: "inventory.adjust",
};

export async function postMovement(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: PostMovementInput,
): Promise<PostedMovement> {
  const action = ACTION_FOR[input.movementType];
  if (!action) throw new StockMovementConflictError(`unknown movement type ${input.movementType}`);
  assertCan(archetype, action);

  return command<PostedMovement>(
    ctx,
    {
      audit: (r) => ({
        action: `stock.${input.movementType}`,
        entityType: "stock_movement" as const,
        entityId: r.id,
        summary: r.posted
          ? `${input.movementType} ${input.qtyDelta}`
          : `${input.movementType} ignored as a duplicate`,
      }),
    },
    (tx) => postMovementIn(tx, ctx, input),
  );
}

/**
 * Undo a movement by posting its opposite.
 *
 * Never an edit and never a delete. The original stays exactly as posted, the
 * reversal names it, and the pair nets to zero — which is the property the
 * invariant tests check.
 */
export async function reverseMovement(
  ctx: Ctx,
  archetype: RoleArchetype,
  movementId: string,
  reason: string,
): Promise<PostedMovement> {
  assertCan(archetype, "inventory.adjust");
  if (!reason.trim()) throw new StockMovementConflictError("a reversal needs a reason");

  return command<PostedMovement>(
    ctx,
    {
      audit: (r) => ({
        action: "stock.reversal",
        entityType: "stock_movement" as const,
        entityId: r.id,
        summary: `Reversed movement ${movementId}: ${reason.trim()}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select item_id::text as item_id, warehouse_id::text as warehouse_id,
               location_id::text as location_id, unit_id::text as unit_id,
               qty_delta::text as qty_delta, reserved_delta::text as reserved_delta,
               currency, unit_cost_minor, exchange_rate
        from public.stock_movement
        where id = ${movementId} and org_id = ${ctx.orgId}
      `)) as unknown as Array<Record<string, string | null>>;
      const m = rows[0];
      if (!m) throw new StockMovementConflictError("movement not found");

      /*
       * A reversal moves the same THINGS back, not merely the same quantity.
       *
       * Undoing an issue of batch 24B has to return batch 24B: returning "three
       * units" without saying which batch would leave the ledger balanced and
       * the batches wrong, and for a serialised item there is no such thing as
       * an anonymous unit to return. The identity is read from the movement
       * being undone, so it cannot be mis-stated by the caller.
       */
      const lots = (await tx.execute(sql`
        select lot_id::text as lot_id, abs(qty)::text as qty
        from public.stock_movement_lot
        where movement_id = ${movementId} and org_id = ${ctx.orgId}
        order by lot_id
        limit 500
      `)) as unknown as Array<{ lot_id: string; qty: string }>;
      const serials = (await tx.execute(sql`
        select serial_id::text as serial_id
        from public.stock_movement_serial
        where movement_id = ${movementId} and org_id = ${ctx.orgId}
        order by serial_id
        limit 500
      `)) as unknown as Array<{ serial_id: string }>;

      return postMovementIn(tx, ctx, {
        itemId: m.item_id!,
        warehouseId: m.warehouse_id!,
        locationId: m.location_id!,
        movementType: "reversal",
        qtyDelta: String(-Number(m.qty_delta)),
        reservedDelta: String(-Number(m.reserved_delta)),
        unitId: m.unit_id!,
        unitCostMinor: m.unit_cost_minor === null ? null : Number(m.unit_cost_minor),
        currency: m.currency,
        exchangeRate: m.exchange_rate === null ? null : Number(m.exchange_rate),
        lots: lots.length === 0 ? null : lots.map((l) => ({ lotId: l.lot_id, qty: Number(l.qty) })),
        serialIds: serials.length === 0 ? null : serials.map((s) => s.serial_id),
        idempotencyKey: `reversal:${movementId}`,
        reason: reason.trim(),
        sourceType: "manual",
        sourceId: null,
        reversesMovementId: movementId,
      });
    },
  );
}
