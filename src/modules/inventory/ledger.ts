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

/** Movement types that add physical stock, and therefore create a cost layer. */
const INBOUND = new Set([
  "opening_balance",
  "goods_receipt",
  "job_return",
  "transfer_in",
  "adjustment_increase",
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
   * Set ONLY by reverseMovement. The table refuses UPDATE, so a reversal has to
   * name the movement it undoes in the insert itself.
   */
  reversesMovementId?: string | null;
};

export type PostedMovement = {
  id: string;
  /** False when an identical key had already posted: the retry did nothing. */
  posted: boolean;
  onHand: string;
  reserved: string;
  costTotalMinor: number | null;
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
    };
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

  // Cost. Inbound movements bring their own; outbound movements take theirs from
  // the layers, by the method that applies to this item.
  const inbound = INBOUND.has(input.movementType);
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

  if (inbound && baseUnitCost !== null && Number(qtyDelta) > 0) {
    costTotal = Math.round(baseUnitCost * Number(qtyDelta));
    // Moving average: total value over total quantity, both AFTER this receipt.
    // Computed from the balance as it was, so it never re-reads the layers.
    const priorQty = Number(before.on_hand);
    const priorValue = nextAvg === null ? 0 : nextAvg * Math.max(priorQty, 0);
    const nextQty = priorQty + Number(qtyDelta);
    nextAvg = nextQty > 0 ? Math.round((priorValue + costTotal) / nextQty) : nextAvg;
  } else if (!inbound && Number(qtyDelta) < 0) {
    plan = await planCost(tx, ctx, {
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      qty: -Number(qtyDelta),
      avgUnitCostMinor: nextAvg,
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

  if (inbound && baseUnitCost !== null && Number(qtyDelta) > 0) {
    await tx.execute(sql`
      insert into public.stock_cost_layer
        (org_id, item_id, warehouse_id, source_movement_id, qty_received, qty_remaining,
         unit_cost_minor, currency, original_unit_cost_minor, exchange_rate, received_at)
      values (${ctx.orgId}, ${input.itemId}, ${input.warehouseId}, ${movementId},
              ${qtyDelta}::numeric, ${qtyDelta}::numeric, ${baseUnitCost},
              ${input.currency ?? "AED"}, ${input.unitCostMinor ?? null},
              ${input.exchangeRate ?? 1},
              coalesce(${input.effectiveAt ?? null}::timestamptz, now()))
    `);
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
  };
}

/** Which layers an outbound movement will take, and what that costs. */
type CostPlan = {
  total: number | null;
  draws: Array<{ layerId: string; qty: number; unitCostMinor: number }>;
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
 */
async function planCost(
  tx: TenantTx,
  ctx: Ctx,
  args: { itemId: string; warehouseId: string; qty: number; avgUnitCostMinor: number | null },
): Promise<CostPlan> {
  const method = await itemCostMethod(tx, ctx, args.itemId);

  const layers = (await tx.execute(sql`
    select id::text as id, qty_remaining::text as qty_remaining, unit_cost_minor
    from public.stock_cost_layer
    where org_id = ${ctx.orgId} and item_id = ${args.itemId}
      and warehouse_id = ${args.warehouseId} and qty_remaining > 0
    order by received_at, created_at
    for update
  `)) as unknown as Array<{ id: string; qty_remaining: string; unit_cost_minor: string }>;

  const draws: CostPlan["draws"] = [];
  let left = args.qty;
  let layerTotal = 0;
  for (const layer of layers) {
    if (left <= 0) break;
    const take = Math.min(left, Number(layer.qty_remaining));
    const unit = Number(layer.unit_cost_minor);
    draws.push({ layerId: layer.id, qty: take, unitCostMinor: unit });
    layerTotal += Math.round(unit * take);
    left -= take;
  }

  if (method === "weighted_average") {
    return {
      total: args.avgUnitCostMinor === null ? null : Math.round(args.avgUnitCostMinor * args.qty),
      draws,
    };
  }
  // Issuing more than the layers hold is only reachable when negative stock is
  // permitted. The uncosted remainder stays uncosted rather than being guessed.
  return { total: layerTotal > 0 ? layerTotal : null, draws };
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
          depleted_at = case when qty_remaining - ${d.qty}::numeric <= 0 then now() else null end
      where id = ${d.layerId} and org_id = ${ctx.orgId}
    `);
    await tx.execute(sql`
      insert into public.stock_layer_consumption
        (org_id, movement_id, layer_id, qty, unit_cost_minor)
      values (${ctx.orgId}, ${movementId}, ${d.layerId}, ${d.qty}::numeric, ${d.unitCostMinor})
    `);
  }
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
        idempotencyKey: `reversal:${movementId}`,
        reason: reason.trim(),
        sourceType: "manual",
        sourceId: null,
        reversesMovementId: movementId,
      });
    },
  );
}
