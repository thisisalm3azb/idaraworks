/**
 * Stock operations (H22C): the paths that turn business events into ledger
 * movements.
 *
 * Every one of them ends at `postMovementIn`, so the rules about negative stock,
 * idempotency, cost and balances are enforced once rather than re-implemented
 * per operation.
 *
 * The idempotency keys are DERIVED FROM THE SOURCE EVENT, never generated. That
 * is what makes "post this receipt" safe to call twice: the second call computes
 * the same key, finds the movement already there, and does nothing.
 */
import { randomUUID } from "node:crypto";
import { sql, type Ctx, type TenantTx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import { command } from "@/platform/audit";
import type { RoleArchetype } from "@/platform/registries";
import { postMovementIn, StockMovementConflictError, type PostedMovement } from "./ledger";

export class NotStockableError extends Error {
  constructor(why: string) {
    super(why);
    this.name = "NotStockableError";
  }
}

/**
 * Item kinds that hold stock.
 *
 * A service has no quantity to hold. A consumable is expensed on receipt rather
 * than tracked. Posting either into the ledger would create a balance nobody can
 * ever count, so both are refused rather than quietly skipped — the caller
 * learns that its line produced no stock.
 */
const STOCKABLE = new Set(["inventory", "asset", "kit", "manufactured"]);

/** Where a receipt line's stock goes, and whether it may go anywhere at all. */
type ReceiptTarget = {
  itemId: string;
  unitId: string;
  qty: number;
  unitCostMinor: number | null;
  currency: string | null;
  exchangeRate: number | null;
};

/**
 * Resolve a goods-receipt line to the item it actually stocks.
 *
 * goods_receipt_line carries NO item_id and no unit — it records what arrived
 * against a purchase-order LINE, and only that line knows which item was
 * ordered. So the route is receipt line → PO line → item, and every hop can
 * legitimately fail:
 *
 *   - a PO line with no item_id is free text ("site cleaning", "delivery"), and
 *     free text is not stock
 *   - an item that is a service or a consumable does not hold stock
 *   - an item with no base unit cannot state a quantity the ledger can add up
 *
 * Returns null for the first two, because they are ordinary and expected. The
 * third throws, because an inventory item without a unit is a configuration
 * error a warehouse clerk cannot fix by trying again.
 */
async function resolveReceiptTarget(
  tx: TenantTx,
  ctx: Ctx,
  receiptLineId: string,
): Promise<ReceiptTarget | null> {
  const rows = (await tx.execute(sql`
    select grl.received_qty::text as received_qty,
           grl.damaged_qty::text as damaged_qty,
           grl.rejected_qty::text as rejected_qty,
           pol.item_id::text as item_id,
           pol.unit_cost_minor,
           o.base_currency as currency,
           po.status as po_status,
           pol.superseded_at,
           i.item_type, i.base_unit_id::text as base_unit_id
    from public.goods_receipt_line grl
    join public.purchase_order_line pol
      on pol.id = grl.po_line_id and pol.org_id = grl.org_id
    join public.purchase_order po on po.id = pol.po_id and po.org_id = pol.org_id
    join public.org o on o.id = grl.org_id
    left join public.item i on i.id = pol.item_id and i.org_id = pol.org_id
    where grl.id = ${receiptLineId} and grl.org_id = ${ctx.orgId}
  `)) as unknown as Array<Record<string, string | null>>;
  const r = rows[0];
  if (!r) throw new StockMovementConflictError("receipt line not found");

  // A cancelled purchase order cannot deliver stock, and a superseded line was
  // replaced by a revision: neither is a live commitment to receive against.
  if (r.po_status === "cancelled") {
    throw new NotStockableError("the purchase order is cancelled");
  }
  if (r.superseded_at !== null) {
    throw new NotStockableError("that order line was superseded by a revision");
  }

  if (r.item_id === null) return null; // free-text line
  if (!STOCKABLE.has(r.item_type ?? "")) return null; // service or consumable

  if (r.base_unit_id === null) {
    throw new NotStockableError(
      "this item has no base unit, so a received quantity cannot be recorded",
    );
  }

  /*
   * GOOD stock only.
   *
   * received_qty is everything that physically turned up. Damaged and rejected
   * quantities arrived too, but they are not stock the business can sell or
   * use, and adding them would overstate what is available. They are recorded on
   * the receipt line and handled by the supplier-return path.
   */
  const good =
    Number(r.received_qty ?? 0) - Number(r.damaged_qty ?? 0) - Number(r.rejected_qty ?? 0);
  if (good <= 0) return null;

  return {
    itemId: r.item_id!,
    unitId: r.base_unit_id!,
    qty: good,
    unitCostMinor: r.unit_cost_minor === null ? null : Number(r.unit_cost_minor),
    currency: r.currency ?? null,
    // purchase_order carries no currency or rate: purchasing is single-currency
    // today, so a receipt is priced in the organization base currency at rate 1.
    // When multi-currency purchasing arrives, the rate belongs on the order.
    exchangeRate: 1,
  };
}

export type ReceiptPostResult = {
  lineId: string;
  posted: boolean;
  /** Null when the line legitimately produces no stock, with `skipped` saying why. */
  movementId: string | null;
  skipped: string | null;
};

/**
 * Book a recorded goods receipt into stock.
 *
 * Idempotent per receipt LINE: the key is the line's own id, so re-running after
 * a timeout, a retry or a double click posts nothing further. Every line of one
 * receipt posts in a single transaction, so a receipt is booked completely or
 * not at all.
 */
export async function postGoodsReceiptToStock(
  ctx: Ctx,
  archetype: RoleArchetype,
  receiptId: string,
  opts: { locationId?: string } = {},
): Promise<ReceiptPostResult[]> {
  assertCan(archetype, "inventory.receive");

  return command<ReceiptPostResult[]>(
    ctx,
    {
      audit: (r) => ({
        action: "stock.receipt_posted",
        entityType: "stock_movement" as const,
        entityId: undefined,
        summary: `Booked goods receipt into stock (${r.filter((x) => x.posted).length} line(s))`,
      }),
    },
    async (tx) => {
      const header = (await tx.execute(sql`
        select gr.status, po.id::text as po_id
        from public.goods_receipt gr
        join public.purchase_order po on po.id = gr.po_id and po.org_id = gr.org_id
        where gr.id = ${receiptId} and gr.org_id = ${ctx.orgId}
      `)) as unknown as Array<{ status: string; po_id: string }>;
      if (!header[0]) throw new StockMovementConflictError("goods receipt not found");
      if (header[0].status === "cancelled") {
        throw new NotStockableError("a cancelled goods receipt cannot become stock");
      }

      const target = await receivingLocation(tx, ctx, opts.locationId);

      const lines = (await tx.execute(sql`
        select id::text as id from public.goods_receipt_line
        where grn_id = ${receiptId} and org_id = ${ctx.orgId}
        order by sort, created_at
        limit 500
      `)) as unknown as Array<{ id: string }>;

      const out: ReceiptPostResult[] = [];
      for (const line of lines) {
        let resolved: ReceiptTarget | null;
        try {
          resolved = await resolveReceiptTarget(tx, ctx, line.id);
        } catch (err) {
          if (err instanceof NotStockableError) {
            out.push({ lineId: line.id, posted: false, movementId: null, skipped: err.message });
            continue;
          }
          throw err;
        }
        if (!resolved) {
          out.push({
            lineId: line.id,
            posted: false,
            movementId: null,
            skipped: "not an inventory item",
          });
          continue;
        }
        const posted = await postMovementIn(tx, ctx, {
          itemId: resolved.itemId,
          warehouseId: target.warehouseId,
          locationId: target.locationId,
          movementType: "goods_receipt",
          qtyDelta: resolved.qty,
          unitId: resolved.unitId,
          unitCostMinor: resolved.unitCostMinor,
          currency: resolved.currency,
          exchangeRate: resolved.exchangeRate,
          sourceType: "goods_receipt_line",
          sourceId: line.id,
          // Derived from the line, so a retry recomputes it and posts nothing.
          idempotencyKey: `grl:${line.id}`,
        });
        out.push({
          lineId: line.id,
          posted: posted.posted,
          movementId: posted.id,
          skipped: null,
        });
      }
      return out;
    },
  );
}

/** The warehouse and location a receipt lands in. */
async function receivingLocation(
  tx: TenantTx,
  ctx: Ctx,
  explicit?: string,
): Promise<{ warehouseId: string; locationId: string }> {
  if (explicit) {
    const rows = (await tx.execute(sql`
      select warehouse_id::text as warehouse_id from public.stock_location
      where id = ${explicit} and org_id = ${ctx.orgId}
    `)) as unknown as Array<{ warehouse_id: string }>;
    if (!rows[0]) throw new StockMovementConflictError("location not found");
    return { warehouseId: rows[0].warehouse_id, locationId: explicit };
  }
  const rows = (await tx.execute(sql`
    select id::text as id, warehouse_id::text as warehouse_id
    from public.stock_location
    where org_id = ${ctx.orgId} and is_default_receiving and active and can_hold_stock
    limit 1
  `)) as unknown as Array<{ id: string; warehouse_id: string }>;
  if (!rows[0]) {
    throw new StockMovementConflictError(
      "no default receiving location — set one on a warehouse first",
    );
  }
  return { warehouseId: rows[0].warehouse_id, locationId: rows[0].id };
}

/**
 * Take a daily report's material lines out of stock, and charge the job.
 *
 * Idempotent per material LINE. The cost charged is what the LEDGER says the
 * stock cost — the layers consumed — not the item's current catalogue price. A
 * job that used material bought last year is charged last year's price, which is
 * the whole reason cost layers exist.
 */
export async function postConsumptionToStock(
  ctx: Ctx,
  archetype: RoleArchetype,
  reportId: string,
  opts: { locationId?: string } = {},
): Promise<
  Array<{ lineId: string; posted: boolean; costMinor: number | null; skipped: string | null }>
> {
  assertCan(archetype, "inventory.issue");

  return command(
    ctx,
    {
      audit: {
        action: "stock.consumption_posted",
        entityType: "stock_movement",
        entityId: undefined,
        summary: "Booked daily-report material out of stock",
      },
    },
    async (tx) => {
      const report = (await tx.execute(sql`
        select status, job_id::text as job_id from public.daily_report
        where id = ${reportId} and org_id = ${ctx.orgId}
      `)) as unknown as Array<{ status: string; job_id: string }>;
      if (!report[0]) throw new StockMovementConflictError("daily report not found");
      /*
       * Only a SUBMITTED or REVIEWED report consumes stock. A draft is still
       * being written and a returned one was rejected; taking stock for either
       * would move real quantity for an event that has not happened.
       */
      if (!["submitted", "reviewed"].includes(report[0].status)) {
        throw new NotStockableError(`a ${report[0].status} report does not consume stock`);
      }

      const lines = (await tx.execute(sql`
        select rml.id::text as id, rml.item_id::text as item_id, rml.qty::text as qty,
               i.item_type, i.base_unit_id::text as base_unit_id
        from public.report_material_line rml
        left join public.item i on i.id = rml.item_id and i.org_id = rml.org_id
        where rml.report_id = ${reportId} and rml.org_id = ${ctx.orgId}
          and rml.superseded_at is null
        order by rml.sort, rml.created_at
        limit 500
      `)) as unknown as Array<Record<string, string | null>>;

      const out: Array<{
        lineId: string;
        posted: boolean;
        costMinor: number | null;
        skipped: string | null;
      }> = [];
      for (const line of lines) {
        // Free-text material is a real record of what was used and NOT a stock
        // event: nothing in the catalogue corresponds to it.
        if (line.item_id === null) {
          out.push({
            lineId: line.id!,
            posted: false,
            costMinor: null,
            skipped: "free-text material",
          });
          continue;
        }
        if (!STOCKABLE.has(line.item_type ?? "") || line.base_unit_id === null) {
          out.push({
            lineId: line.id!,
            posted: false,
            costMinor: null,
            skipped: "not a stocked item",
          });
          continue;
        }
        const place = await issuingLocation(tx, ctx, line.item_id!, opts.locationId);
        const posted = await postMovementIn(tx, ctx, {
          itemId: line.item_id!,
          warehouseId: place.warehouseId,
          locationId: place.locationId,
          movementType: "job_consumption",
          qtyDelta: -Number(line.qty),
          unitId: line.base_unit_id!,
          sourceType: "report_material_line",
          sourceId: line.id!,
          idempotencyKey: `rml:${line.id}`,
        });
        out.push({
          lineId: line.id!,
          posted: posted.posted,
          costMinor: posted.costTotalMinor,
          skipped: null,
        });
      }
      return out;
    },
  );
}

/**
 * Where to issue an item from.
 *
 * Stock is held per LOCATION, so "issue from the default issue bin" only works
 * when that bin happens to hold the item. Usually it does not: goods are received
 * into a receiving bay and picked from wherever they were put away, and a
 * nominated bin holding none of the item would refuse an issue the warehouse can
 * plainly fulfil.
 *
 * So this picks the place that actually HAS the stock, preferring the default
 * issue location when it qualifies and otherwise the location holding the most.
 * That is a deliberate simplification, not a picking strategy: it does not choose
 * across warehouses, split an issue between bins, or optimise a route. A caller
 * that knows better passes the location explicitly.
 *
 * Falling back to the default issue location when nothing holds the item keeps
 * the resulting error honest — "no stock", from the place a picker would have
 * looked, rather than "no location".
 */
async function issuingLocation(
  tx: TenantTx,
  ctx: Ctx,
  itemId: string,
  explicit?: string,
): Promise<{ warehouseId: string; locationId: string }> {
  if (explicit) {
    const rows = (await tx.execute(sql`
      select warehouse_id::text as warehouse_id from public.stock_location
      where id = ${explicit} and org_id = ${ctx.orgId}
    `)) as unknown as Array<{ warehouse_id: string }>;
    if (!rows[0]) throw new StockMovementConflictError("location not found");
    return { warehouseId: rows[0].warehouse_id, locationId: explicit };
  }

  const holding = (await tx.execute(sql`
    select b.location_id::text as id, b.warehouse_id::text as warehouse_id
    from public.stock_balance b
    join public.stock_location l on l.id = b.location_id and l.org_id = b.org_id
    where b.org_id = ${ctx.orgId} and b.item_id = ${itemId}
      and (b.on_hand - b.reserved) > 0
      and l.active and l.can_hold_stock and l.kind = 'storage'
    order by l.is_default_issue desc, b.on_hand desc
    limit 1
  `)) as unknown as Array<{ id: string; warehouse_id: string }>;
  if (holding[0]) {
    return { warehouseId: holding[0].warehouse_id, locationId: holding[0].id };
  }

  const fallback = (await tx.execute(sql`
    select id::text as id, warehouse_id::text as warehouse_id
    from public.stock_location
    where org_id = ${ctx.orgId} and is_default_issue and active and can_hold_stock
    limit 1
  `)) as unknown as Array<{ id: string; warehouse_id: string }>;
  if (!fallback[0]) {
    throw new StockMovementConflictError(
      "no default issue location — set one on a warehouse first",
    );
  }
  return { warehouseId: fallback[0].warehouse_id, locationId: fallback[0].id };
}

// ── Reservations ────────────────────────────────────────────────────────────

/**
 * Hold stock for a job.
 *
 * Changes AVAILABLE, never on-hand: the goods have not moved and a stocktake
 * would still find them on the shelf. The ledger records the promise as
 * reserved_delta so the two quantities stay separately answerable.
 */
export async function reserveStock(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: {
    itemId: string;
    warehouseId: string;
    locationId: string;
    unitId: string;
    qty: number;
    forJobId?: string | null;
    expiresAt?: string | null;
  },
): Promise<{ reservationId: string; movement: PostedMovement }> {
  assertCan(archetype, "inventory.issue");
  const reservationId = randomUUID();

  return command(
    ctx,
    {
      audit: {
        action: "stock.reserved",
        entityType: "stock_movement",
        entityId: reservationId,
        summary: `Reserved ${input.qty}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        insert into public.stock_reservation
          (id, org_id, item_id, warehouse_id, location_id, unit_id, qty, for_job_id,
           expires_at, created_by)
        values (${reservationId}, ${ctx.orgId}, ${input.itemId}, ${input.warehouseId},
                ${input.locationId}, ${input.unitId}, ${input.qty}::numeric,
                ${input.forJobId ?? null}, ${input.expiresAt ?? null}::timestamptz, ${ctx.userId})
      `);
      const movement = await postMovementIn(tx, ctx, {
        itemId: input.itemId,
        warehouseId: input.warehouseId,
        locationId: input.locationId,
        movementType: "reservation",
        qtyDelta: 0,
        reservedDelta: input.qty,
        unitId: input.unitId,
        idempotencyKey: `resv:${reservationId}`,
      });
      return { reservationId, movement };
    },
  );
}

/** Give a reservation back. The promise ends; nothing physical happens. */
export async function releaseReservation(
  ctx: Ctx,
  archetype: RoleArchetype,
  reservationId: string,
  reason: string,
): Promise<PostedMovement> {
  assertCan(archetype, "inventory.issue");
  return command(
    ctx,
    {
      audit: {
        action: "stock.reservation_released",
        entityType: "stock_movement",
        entityId: reservationId,
        summary: `Released reservation: ${reason}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.stock_reservation
        set status = 'released', released_reason = ${reason}, updated_at = now()
        where id = ${reservationId} and org_id = ${ctx.orgId} and status = 'open'
        returning item_id::text as item_id, warehouse_id::text as warehouse_id,
                  location_id::text as location_id, unit_id::text as unit_id, qty::text as qty
      `)) as unknown as Array<Record<string, string>>;
      const r = rows[0];
      if (!r) throw new StockMovementConflictError("no open reservation with that id");
      return postMovementIn(tx, ctx, {
        itemId: r.item_id!,
        warehouseId: r.warehouse_id!,
        locationId: r.location_id!,
        movementType: "reservation_release",
        qtyDelta: 0,
        reservedDelta: -Number(r.qty),
        unitId: r.unit_id!,
        idempotencyKey: `resv-rel:${reservationId}`,
      });
    },
  );
}

// ── Transfers ───────────────────────────────────────────────────────────────

/**
 * Move stock between two places, posting BOTH legs in one transaction.
 *
 * Atomic by construction rather than by compensation: there is no window in
 * which the quantity has left the source and not arrived at the destination, so
 * there is nothing to reconcile if the process dies mid-way.
 */
export async function dispatchTransfer(
  ctx: Ctx,
  archetype: RoleArchetype,
  transferId: string,
): Promise<{ moved: number }> {
  assertCan(archetype, "inventory.transfer");
  return command(
    ctx,
    {
      audit: (r: { moved: number }) => ({
        action: "stock.transfer_dispatched",
        entityType: "stock_movement" as const,
        entityId: transferId,
        summary: `Transferred ${r.moved} line(s)`,
      }),
    },
    async (tx) => {
      const head = (await tx.execute(sql`
        update public.stock_transfer
        set status = 'received', dispatched_at = now(), dispatched_by = ${ctx.userId},
            received_at = now(), received_by = ${ctx.userId}, updated_at = now()
        where id = ${transferId} and org_id = ${ctx.orgId} and status in ('draft', 'in_transit')
        returning from_warehouse_id::text as fw, from_location_id::text as fl,
                  to_warehouse_id::text as tw, to_location_id::text as tl
      `)) as unknown as Array<Record<string, string>>;
      const t = head[0];
      if (!t) throw new StockMovementConflictError("no open transfer with that id");

      const lines = (await tx.execute(sql`
        select id::text as id, item_id::text as item_id, unit_id::text as unit_id,
               qty::text as qty
        from public.stock_transfer_line
        where transfer_id = ${transferId} and org_id = ${ctx.orgId}
        order by sort limit 500
      `)) as unknown as Array<Record<string, string>>;
      if (lines.length === 0) throw new StockMovementConflictError("the transfer has no lines");

      for (const line of lines) {
        await postMovementIn(tx, ctx, {
          itemId: line.item_id!,
          warehouseId: t.fw!,
          locationId: t.fl!,
          movementType: "transfer_out",
          qtyDelta: -Number(line.qty),
          unitId: line.unit_id!,
          sourceType: "stock_transfer",
          sourceId: transferId,
          idempotencyKey: `xfer-out:${line.id}`,
        });
        await postMovementIn(tx, ctx, {
          itemId: line.item_id!,
          warehouseId: t.tw!,
          locationId: t.tl!,
          movementType: "transfer_in",
          qtyDelta: Number(line.qty),
          unitId: line.unit_id!,
          sourceType: "stock_transfer",
          sourceId: transferId,
          idempotencyKey: `xfer-in:${line.id}`,
        });
      }
      return { moved: lines.length };
    },
  );
}

// ── Stock counts ────────────────────────────────────────────────────────────

/**
 * Post a REVIEWED count as corrections.
 *
 * The count never rewrites a balance. It posts count_correction movements for
 * the difference between what was counted and what the ledger says, and the
 * balance changes because the ledger did — the only way it is ever allowed to.
 *
 * A variance needs a reason. "The number was wrong" is not an explanation, and a
 * count that silently adjusts stock teaches nobody why it drifted.
 */
export async function postStockCount(
  ctx: Ctx,
  archetype: RoleArchetype,
  countId: string,
): Promise<{ corrections: number; unchanged: number }> {
  assertCan(archetype, "inventory.count");
  return command(
    ctx,
    {
      audit: (r: { corrections: number; unchanged: number }) => ({
        action: "stock.count_posted",
        entityType: "stock_movement" as const,
        entityId: countId,
        summary: `Posted stock count: ${r.corrections} correction(s), ${r.unchanged} unchanged`,
      }),
    },
    async (tx) => {
      const head = (await tx.execute(sql`
        select status, reviewed_by::text as reviewed_by, warehouse_id::text as warehouse_id
        from public.stock_count
        where id = ${countId} and org_id = ${ctx.orgId} for update
      `)) as unknown as Array<Record<string, string | null>>;
      const c = head[0];
      if (!c) throw new StockMovementConflictError("stock count not found");
      if (c.status !== "review") {
        throw new StockMovementConflictError(
          `only a count in review can be posted (this one is ${c.status})`,
        );
      }
      if (!c.reviewed_by) {
        throw new StockMovementConflictError("a count must be reviewed before it is posted");
      }

      const lines = (await tx.execute(sql`
        select scl.id::text as id, scl.item_id::text as item_id,
               scl.location_id::text as location_id, scl.unit_id::text as unit_id,
               scl.counted_qty::text as counted_qty, scl.variance_reason,
               coalesce(sb.on_hand, 0)::text as on_hand
        from public.stock_count_line scl
        left join public.stock_balance sb
          on sb.org_id = scl.org_id and sb.item_id = scl.item_id
         and sb.location_id = scl.location_id
        where scl.count_id = ${countId} and scl.org_id = ${ctx.orgId}
          and scl.counted_qty is not null
        order by scl.sort limit 1000
      `)) as unknown as Array<Record<string, string | null>>;

      let corrections = 0;
      let unchanged = 0;
      for (const line of lines) {
        const delta = Number(line.counted_qty) - Number(line.on_hand);
        if (delta === 0) {
          unchanged++;
          continue;
        }
        if (!line.variance_reason || !line.variance_reason.trim()) {
          throw new StockMovementConflictError(
            "every variance needs a reason before the count can be posted",
          );
        }
        await postMovementIn(tx, ctx, {
          itemId: line.item_id!,
          warehouseId: c.warehouse_id!,
          locationId: line.location_id!,
          movementType: "count_correction",
          qtyDelta: delta,
          unitId: line.unit_id!,
          sourceType: "stock_count_line",
          sourceId: line.id!,
          idempotencyKey: `count:${line.id}`,
          reason: line.variance_reason.trim(),
        });
        corrections++;
      }

      await tx.execute(sql`
        update public.stock_count set status = 'posted', posted_at = now(), updated_at = now()
        where id = ${countId} and org_id = ${ctx.orgId}
      `);
      return { corrections, unchanged };
    },
  );
}
