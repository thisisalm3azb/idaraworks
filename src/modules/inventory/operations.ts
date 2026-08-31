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
import { allocateAndIssueIn } from "./allocate";

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

/**
 * What happened to what arrived.
 *
 * Rejected quantity is deliberately absent: it was refused at the door, so the
 * business never owned it and it never reaches the ledger. The three that remain
 * are all owned — they differ only in where they are allowed to sit.
 */
export type ReceiptDisposition = "accepted" | "damaged" | "quarantine";
const DISPOSITIONS: readonly ReceiptDisposition[] = ["accepted", "damaged", "quarantine"];

/** Where a receipt line's stock goes, and whether it may go anywhere at all. */
type ReceiptTarget = {
  itemId: string;
  unitId: string;
  unitCostMinor: number | null;
  currency: string | null;
  exchangeRate: number | null;
  /** One entry per disposition that actually has a quantity. */
  legs: Array<{ disposition: ReceiptDisposition; qty: number }>;
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
           grl.accepted_qty::text as accepted_qty,
           grl.damaged_qty::text as damaged_qty,
           grl.quarantine_qty::text as quarantine_qty,
           grl.rejected_qty::text as rejected_qty,
           pol.item_id::text as item_id,
           pol.unit_cost_minor,
           -- The ORDER's money, not the organization's money today: an order
           -- placed in dollars is received in dollars at the rate it was
           -- committed at, whatever the base currency has since become.
           po.currency as currency,
           po.exchange_rate::text as exchange_rate,
           po.status as po_status,
           pol.superseded_at,
           i.item_type, i.base_unit_id::text as base_unit_id
    from public.goods_receipt_line grl
    join public.purchase_order_line pol
      on pol.id = grl.po_line_id and pol.org_id = grl.org_id
    join public.purchase_order po on po.id = pol.po_id and po.org_id = pol.org_id
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
   * OWNED stock, split by where it is allowed to sit.
   *
   * received_qty is everything that physically turned up, and the receipt says
   * what became of it. Accepted goods are available. Damaged and quarantined
   * goods are owned — the business paid for them and must be able to see them —
   * but they go to locations ordinary issuing never draws from, so they cannot
   * quietly satisfy a job. Rejected goods were refused at the door and never
   * enter the ledger at all.
   */
  const quantities: Record<ReceiptDisposition, number> = {
    accepted: Number(r.accepted_qty ?? 0),
    damaged: Number(r.damaged_qty ?? 0),
    quarantine: Number(r.quarantine_qty ?? 0),
  };
  const legs = DISPOSITIONS.map((disposition) => ({
    disposition,
    qty: quantities[disposition],
  })).filter((leg) => leg.qty > 0);
  if (legs.length === 0) return null;

  return {
    itemId: r.item_id!,
    unitId: r.base_unit_id!,
    unitCostMinor: r.unit_cost_minor === null ? null : Number(r.unit_cost_minor),
    currency: r.currency ?? null,
    exchangeRate: r.exchange_rate === null ? null : Number(r.exchange_rate),
    legs,
  };
}

export type ReceiptPostResult = {
  lineId: string;
  posted: boolean;
  /** Null when the line legitimately produces no stock, with `skipped` saying why. */
  movementId: string | null;
  skipped: string | null;
  /** What was booked, and where. Empty when the line produced no stock. */
  dispositions: Array<{
    disposition: ReceiptDisposition;
    qty: number;
    locationId: string;
    movementId: string;
    posted: boolean;
  }>;
};

/**
 * Book a recorded goods receipt into stock.
 *
 * Idempotent per receipt line AND DISPOSITION: the key is the line's own id plus
 * the disposition, so re-running after a timeout, a retry or a double click posts
 * nothing further, while the accepted and damaged halves of one line remain two
 * distinct facts. Every line of one receipt posts in a single transaction, so a
 * receipt is booked completely or not at all.
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

      const accepted = await receivingLocation(tx, ctx, opts.locationId);

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
            out.push({
              lineId: line.id,
              posted: false,
              movementId: null,
              skipped: err.message,
              dispositions: [],
            });
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
            dispositions: [],
          });
          continue;
        }

        const booked: ReceiptPostResult["dispositions"] = [];
        for (const leg of resolved.legs) {
          // Accepted goods honour the caller's chosen bin; damaged and
          // quarantined goods go where their kind says they must, so nobody has
          // to remember the rule at the receiving desk.
          const place =
            leg.disposition === "accepted"
              ? accepted
              : await dispositionLocation(tx, ctx, leg.disposition, accepted.warehouseId);
          const posted = await postMovementIn(tx, ctx, {
            itemId: resolved.itemId,
            warehouseId: place.warehouseId,
            locationId: place.locationId,
            movementType: "goods_receipt",
            qtyDelta: leg.qty,
            unitId: resolved.unitId,
            unitCostMinor: resolved.unitCostMinor,
            currency: resolved.currency,
            exchangeRate: resolved.exchangeRate,
            sourceType: "goods_receipt_line",
            sourceId: line.id,
            // Derived from the line and the disposition, so a retry recomputes
            // both keys and posts nothing.
            idempotencyKey: `grl:${line.id}:${leg.disposition}`,
          });
          booked.push({
            disposition: leg.disposition,
            qty: leg.qty,
            locationId: place.locationId,
            movementId: posted.id,
            posted: posted.posted,
          });
        }

        out.push({
          lineId: line.id,
          // True when anything new landed. A retry books nothing and says so.
          posted: booked.some((b) => b.posted),
          movementId: booked[0]?.movementId ?? null,
          skipped: null,
          dispositions: booked,
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
  Array<{
    lineId: string;
    posted: boolean;
    costMinor: number | null;
    /** How many locations the quantity came from. */
    locations: number;
    skipped: string | null;
  }>
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
        locations: number;
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
            locations: 0,
            skipped: "free-text material",
          });
          continue;
        }
        if (!STOCKABLE.has(line.item_type ?? "") || line.base_unit_id === null) {
          out.push({
            lineId: line.id!,
            posted: false,
            costMinor: null,
            locations: 0,
            skipped: "not a stocked item",
          });
          continue;
        }
        /*
         * Allocated ACROSS locations, not taken from one nominated bin.
         *
         * A job's material is usually spread over several places, and the whole
         * quantity either comes out or none of it does. Every leg posts in this
         * transaction, so a shortfall at the third bin cannot leave the first
         * two already taken.
         */
        const { legs, movements } = await allocateAndIssueIn(tx, ctx, {
          itemId: line.item_id!,
          unitId: line.base_unit_id!,
          qty: Number(line.qty),
          movementType: "job_consumption",
          locationIds: opts.locationId ? [opts.locationId] : null,
          sourceType: "report_material_line",
          sourceId: line.id!,
          idempotencyKey: `rml:${line.id}`,
        });
        const costed = movements.filter((m) => m.costTotalMinor !== null);
        out.push({
          lineId: line.id!,
          posted: movements.some((m) => m.posted),
          costMinor:
            costed.length === 0 ? null : costed.reduce((s, m) => s + (m.costTotalMinor ?? 0), 0),
          locations: legs.length,
          skipped: null,
        });
      }
      return out;
    },
  );
}

/**
 * The location a given disposition belongs in.
 *
 * Damaged and quarantined stock is OWNED but not available: it sits in a
 * location whose `kind` excludes it from ordinary issuing, so nothing has to
 * remember the rule at each call site.
 *
 * The bin is created on first use rather than demanded up front. A clerk
 * recording three damaged units should not be blocked by a warehouse that was
 * never configured for damage, and refusing the whole receipt would either lose
 * the record or push the clerk to book the damaged units as good. Creating it
 * asserts nothing that is not already true: the organization owns damaged goods,
 * so it has somewhere to put them.
 */
async function dispositionLocation(
  tx: TenantTx,
  ctx: Ctx,
  disposition: ReceiptDisposition,
  warehouseId?: string,
): Promise<{ warehouseId: string; locationId: string }> {
  if (disposition === "accepted") return receivingLocation(tx, ctx);

  const kind = disposition;
  const find = sql`
    select id::text as id, warehouse_id::text as warehouse_id
    from public.stock_location
    where org_id = ${ctx.orgId} and kind = ${kind} and active and can_hold_stock
      and (${warehouseId ?? null}::uuid is null or warehouse_id = ${warehouseId ?? null}::uuid)
    order by created_at, id
    limit 1
  `;
  const found = (await tx.execute(find)) as unknown as Array<{ id: string; warehouse_id: string }>;
  if (found[0]) return { warehouseId: found[0].warehouse_id, locationId: found[0].id };

  const home =
    warehouseId ??
    (
      (await tx.execute(sql`
        select id::text as id from public.warehouse
        where org_id = ${ctx.orgId} and active
        order by created_at, id
        limit 1
      `)) as unknown as Array<{ id: string }>
    )[0]?.id;
  if (!home) {
    throw new StockMovementConflictError(
      `no warehouse exists, so ${kind} goods have nowhere to go`,
    );
  }

  const code = kind === "damaged" ? "DAMAGED" : "QUARANTINE";
  const created = (await tx.execute(sql`
    insert into public.stock_location
      (org_id, warehouse_id, code, name_en, name_ar, kind, can_hold_stock, active)
    values (${ctx.orgId}, ${home}, ${code},
            ${kind === "damaged" ? "Damaged goods" : "Quarantine"},
            ${kind === "damaged" ? "بضائع تالفة" : "الحجر"},
            ${kind}, true, true)
    -- A concurrent receipt may have created it a moment ago; either way the
    -- select below finds exactly one.
    on conflict do nothing
    returning id::text as id, warehouse_id::text as warehouse_id
  `)) as unknown as Array<{ id: string; warehouse_id: string }>;
  if (created[0]) return { warehouseId: created[0].warehouse_id, locationId: created[0].id };

  const raced = (await tx.execute(find)) as unknown as Array<{ id: string; warehouse_id: string }>;
  if (!raced[0]) {
    throw new StockMovementConflictError(`could not open a ${kind} location`);
  }
  return { warehouseId: raced[0].warehouse_id, locationId: raced[0].id };
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

// ── Supplier returns ────────────────────────────────────────────────────────

/**
 * Send goods back to the supplier.
 *
 * Every line names the RECEIPT LINE it reverses, so a partial return stays
 * connected to the delivery it came from and the eligible quantity can be
 * checked against what was actually received rather than against a running
 * total nobody can audit.
 *
 * The cost leaving is the cost that arrived: the movement consumes the layers
 * the receipt created, so returning goods bought at last year's price credits
 * last year's price rather than today's average.
 */
export async function sendSupplierReturn(
  ctx: Ctx,
  archetype: RoleArchetype,
  returnId: string,
): Promise<{ lines: number; totalQty: string }> {
  assertCan(archetype, "inventory.receive");

  return command(
    ctx,
    {
      audit: (r: { lines: number; totalQty: string }) => ({
        action: "stock.supplier_return_sent",
        entityType: "stock_movement" as const,
        entityId: returnId,
        summary: `Returned ${r.totalQty} to the supplier across ${r.lines} line(s)`,
      }),
    },
    async (tx) => {
      const head = (await tx.execute(sql`
        update public.supplier_return
        set status = 'sent', sent_at = now(), sent_by = ${ctx.userId}, updated_at = now()
        where id = ${returnId} and org_id = ${ctx.orgId} and status = 'draft'
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      // Refusing here is what makes a duplicate return impossible: only a draft
      // can be sent, and sending moves it out of draft in the same statement.
      if (!head[0]) {
        throw new StockMovementConflictError("no draft supplier return with that id");
      }

      const lines = (await tx.execute(sql`
        select srl.id::text as id, srl.goods_receipt_line_id::text as grl_id,
               srl.item_id::text as item_id, srl.unit_id::text as unit_id,
               srl.qty::text as qty, srl.disposition,
               grl.accepted_qty::text as accepted_qty,
               grl.damaged_qty::text as damaged_qty,
               grl.quarantine_qty::text as quarantine_qty,
               grl.returned_qty::text as returned_qty
        from public.supplier_return_line srl
        join public.goods_receipt_line grl
          on grl.id = srl.goods_receipt_line_id and grl.org_id = srl.org_id
        where srl.return_id = ${returnId} and srl.org_id = ${ctx.orgId}
        order by srl.sort
        limit 500
        for update of grl
      `)) as unknown as Array<Record<string, string>>;
      if (lines.length === 0) {
        throw new StockMovementConflictError("the return has no lines");
      }

      let total = 0;
      for (const line of lines) {
        /*
         * Eligibility is checked against the DISPOSITION being returned.
         *
         * Rejected quantity is not eligible at all: it was refused at the door
         * and never entered the ledger, so there is nothing to send back. What
         * can go back is what the business actually took ownership of.
         */
        const owned =
          line.disposition === "accepted"
            ? Number(line.accepted_qty)
            : line.disposition === "damaged"
              ? Number(line.damaged_qty)
              : Number(line.quarantine_qty);
        const alreadyReturned = Number(line.returned_qty);
        const wanted = Number(line.qty);
        if (wanted > owned - alreadyReturned) {
          throw new StockMovementConflictError(
            `cannot return ${wanted}: only ${owned - alreadyReturned} of that receipt line remains eligible`,
          );
        }

        /*
         * Where the goods physically leave from.
         *
         * Accepted goods were put away and could be anywhere, so allocation
         * finds them across the ordinary issuable bins. Damaged and quarantined
         * goods are in their own bin by construction, and drawing from a kind
         * ordinary issuing refuses is exactly what this document authorizes —
         * named explicitly, never assumed.
         */
        const disposition = line.disposition as ReceiptDisposition;
        const place =
          disposition === "accepted" ? null : await dispositionLocation(tx, ctx, disposition);
        await allocateAndIssueIn(tx, ctx, {
          itemId: line.item_id!,
          unitId: line.unit_id!,
          qty: wanted,
          movementType: "supplier_return",
          locationIds: place ? [place.locationId] : null,
          allowKinds: place ? [disposition] : null,
          sourceType: "supplier_return_line",
          sourceId: line.id!,
          idempotencyKey: `sret:${line.id}`,
        });

        // Keep the receipt line's running total, so the next return sees what is
        // left without re-deriving it from the ledger.
        await tx.execute(sql`
          update public.goods_receipt_line
          set returned_qty = returned_qty + ${wanted}::numeric
          where id = ${line.grl_id} and org_id = ${ctx.orgId}
        `);
        total += wanted;
      }
      return { lines: lines.length, totalQty: String(total) };
    },
  );
}
