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
 * Kinds of location a TRANSFER may move stock out of.
 *
 * Wider than ordinary issuing on purpose: releasing goods from quarantine,
 * moving damaged stock to a returns area and emptying a receiving bay are all
 * transfers, and all of them start somewhere ordinary issuing must never touch.
 * The transfer document is the authorization; the destination is where the
 * goods become issuable again, or not.
 */
const TRANSFERABLE_KINDS = [
  "storage",
  "receiving",
  "dispatch",
  "quarantine",
  "damaged",
  "returns",
  "transit",
] as const;

/**
 * What this item is worth on average, anywhere it is held.
 *
 * The fallback when a count finds stock in a bin that has never held any: the
 * location has no average of its own, but the organization plainly knows what
 * the item costs. Null when it has never been costed at all, and then the
 * correction stays uncosted rather than guessing.
 */
async function itemAverageCost(tx: TenantTx, ctx: Ctx, itemId: string): Promise<number | null> {
  const rows = (await tx.execute(sql`
    select round(sum(avg_unit_cost_minor * on_hand) / nullif(sum(on_hand), 0))::text as avg
    from public.stock_balance
    where org_id = ${ctx.orgId} and item_id = ${itemId}
      and avg_unit_cost_minor is not null and on_hand > 0
  `)) as unknown as Array<{ avg: string | null }>;
  const avg = rows[0]?.avg;
  return avg === null || avg === undefined ? null : Number(avg);
}

/** The organization's own money, for movements that create no new price. */
async function baseCurrency(tx: TenantTx, ctx: Ctx): Promise<string> {
  const rows = (await tx.execute(sql`
    select base_currency from public.org where id = ${ctx.orgId}
  `)) as unknown as Array<{ base_currency: string }>;
  return rows[0]?.base_currency ?? "AED";
}

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
  tracking: "none" | "lot" | "serial";
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
           i.item_type, i.base_unit_id::text as base_unit_id, i.tracking
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
    tracking: r.tracking === "lot" || r.tracking === "serial" ? r.tracking : "none",
    legs,
  };
}

/**
 * Turn what the delivery note said into ledger identity.
 *
 * The receipt recorded "lot 24B, 40 units, expires April". This is where that
 * becomes a `stock_lot` the ledger can reference — at POSTING, so a receipt that
 * is never posted, or is cancelled, leaves no phantom batch in the catalogue.
 *
 * A lot code that already exists is reused rather than duplicated: the second
 * delivery of lot 24B is the same batch, and giving it a second row would split
 * its history and its expiry.
 */
async function identitiesForReceipt(
  tx: TenantTx,
  ctx: Ctx,
  args: {
    receiptLineId: string;
    itemId: string;
    tracking: "none" | "lot" | "serial";
    disposition: ReceiptDisposition;
    warehouseId: string;
    locationId: string;
  },
): Promise<{ lots: Array<{ lotId: string; qty: number }> | null; serialIds: string[] | null }> {
  if (args.tracking === "none") return { lots: null, serialIds: null };

  if (args.tracking === "lot") {
    const recorded = (await tx.execute(sql`
      select lot_code, supplier_lot_code, manufactured_on, expiry_date, qty::text as qty
      from public.goods_receipt_line_lot
      where org_id = ${ctx.orgId} and grl_id = ${args.receiptLineId}
        and disposition = ${args.disposition}
      order by lot_code
      limit 200
    `)) as unknown as Array<Record<string, string | null>>;
    if (recorded.length === 0) {
      throw new NotStockableError(
        "this item is lot-tracked but the receipt recorded no batch numbers",
      );
    }

    const lots: Array<{ lotId: string; qty: number }> = [];
    for (const row of recorded) {
      await tx.execute(sql`
        insert into public.stock_lot
          (org_id, item_id, code, supplier_lot_code, manufactured_on, expiry_date, created_by)
        values (${ctx.orgId}, ${args.itemId}, ${row.lot_code}, ${row.supplier_lot_code},
                ${row.manufactured_on}::date, ${row.expiry_date}::date, ${ctx.userId})
        on conflict (org_id, item_id, code) do nothing
      `);
      const found = (await tx.execute(sql`
        select id::text as id, expiry_date::text as expiry_date, status
        from public.stock_lot
        where org_id = ${ctx.orgId} and item_id = ${args.itemId} and code = ${row.lot_code}
        for update
      `)) as unknown as Array<{ id: string; expiry_date: string | null; status: string }>;
      if (!found[0]) throw new StockMovementConflictError(`could not open batch ${row.lot_code}`);
      const lot = found[0];

      /*
       * A second delivery of the same batch may carry a different expiry — and
       * that is a contradiction, not an update. Two deliveries claiming
       * different dates for one batch means the batch numbers collide or the
       * label is wrong, and quietly keeping the first date would put stock on
       * the shelf that expires earlier than the system believes.
       */
      if (row.expiry_date && lot.expiry_date && row.expiry_date !== lot.expiry_date) {
        throw new StockMovementConflictError(
          `batch ${row.lot_code} already expires ${lot.expiry_date}, but this delivery says ${row.expiry_date}`,
        );
      }
      if (row.expiry_date && !lot.expiry_date) {
        // The batch existed without a date and this delivery supplies one.
        await tx.execute(sql`
          update public.stock_lot
          set expiry_date = ${row.expiry_date}::date,
              manufactured_on = coalesce(manufactured_on, ${row.manufactured_on}::date),
              updated_at = now()
          where id = ${lot.id} and org_id = ${ctx.orgId}
        `);
      }

      /*
       * A batch that had run out is receivable again: the same code arriving a
       * second time is a second delivery of that batch. Quarantined, recalled or
       * expired is different — somebody decided those, and more stock arriving
       * does not undo the decision.
       */
      if (lot.status !== "active" && lot.status !== "depleted") {
        throw new StockMovementConflictError(
          `batch ${row.lot_code} is ${lot.status}; receiving into it needs that decision reversed first`,
        );
      }
      await tx.execute(sql`
        update public.stock_lot set status = 'active', updated_at = now()
        where id = ${lot.id} and org_id = ${ctx.orgId} and status = 'depleted'
      `);
      lots.push({ lotId: lot.id, qty: Number(row.qty) });
    }
    return { lots, serialIds: null };
  }

  const recorded = (await tx.execute(sql`
    select s.serial_no, s.lot_code
    from public.goods_receipt_line_serial s
    where s.org_id = ${ctx.orgId} and s.grl_id = ${args.receiptLineId}
      and s.disposition = ${args.disposition}
    order by s.serial_no
    limit 500
  `)) as unknown as Array<{ serial_no: string; lot_code: string | null }>;
  if (recorded.length === 0) {
    throw new NotStockableError(
      "this item is serialised but the receipt recorded no serial numbers",
    );
  }

  /*
   * A serialised unit may also carry a batch, and the delivery note says so.
   *
   * Linking it is what lets a recall reach the units: without it, quarantining
   * the batch leaves every serialised unit from that batch still issuable, and
   * the expiry check on a serial's lot has nothing to check.
   */
  const lotIdByCode = new Map<string, string>();
  for (const code of new Set(recorded.map((r) => r.lot_code).filter(Boolean) as string[])) {
    await tx.execute(sql`
      insert into public.stock_lot (org_id, item_id, code, created_by)
      values (${ctx.orgId}, ${args.itemId}, ${code}, ${ctx.userId})
      on conflict (org_id, item_id, code) do nothing
    `);
    const found = (await tx.execute(sql`
      select id::text as id from public.stock_lot
      where org_id = ${ctx.orgId} and item_id = ${args.itemId} and code = ${code}
    `)) as unknown as Array<{ id: string }>;
    if (found[0]) lotIdByCode.set(code, found[0].id);
  }

  const serialIds: string[] = [];
  for (const row of recorded) {
    const lotId = row.lot_code ? (lotIdByCode.get(row.lot_code) ?? null) : null;
    const existing = (await tx.execute(sql`
      select id::text as id, status from public.stock_serial
      where org_id = ${ctx.orgId} and item_id = ${args.itemId} and serial_no = ${row.serial_no}
      for update
    `)) as unknown as Array<{ id: string; status: string }>;
    if (existing[0]) {
      /*
       * A unit cannot arrive while it is already here.
       *
       * Either the same delivery was recorded twice or two suppliers used the
       * same number, and both are things a storekeeper must resolve rather than
       * have the system pick a winner.
       */
      if (existing[0].status === "in_stock" || existing[0].status === "reserved") {
        throw new StockMovementConflictError(
          `unit ${row.serial_no} is already in stock, so it cannot be received again`,
        );
      }
      // A unit coming back belongs to whatever batch this delivery says it does.
      if (lotId) {
        await tx.execute(sql`
          update public.stock_serial set lot_id = ${lotId}, updated_at = now()
          where id = ${existing[0].id} and org_id = ${ctx.orgId}
        `);
      }
      serialIds.push(existing[0].id);
      continue;
    }
    const created = (await tx.execute(sql`
      insert into public.stock_serial
        (org_id, item_id, serial_no, lot_id, status, warehouse_id, location_id, created_by)
      values (${ctx.orgId}, ${args.itemId}, ${row.serial_no}, ${lotId}, 'in_stock',
              ${args.warehouseId}, ${args.locationId}, ${ctx.userId})
      returning id::text as id
    `)) as unknown as Array<{ id: string }>;
    serialIds.push(created[0]!.id);
  }
  return { lots: null, serialIds };
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
          const idempotencyKey = `grl:${line.id}:${leg.disposition}`;

          /*
           * One poster at a time for this line and disposition.
           *
           * The check below is a read, and two concurrent posts of the same
           * receipt both pass it — then both try to register the same serial
           * numbers, and the loser surfaces a raw unique-constraint violation
           * instead of the quiet no-op a retry is supposed to be.
           */
          await tx.execute(sql`
            select pg_advisory_xact_lock(hashtextextended(${`${ctx.orgId}:${idempotencyKey}`}, 0))
          `);

          /*
           * Asked before any identity is created.
           *
           * Creating a batch or registering a serial is a WRITE, and postMovementIn
           * only discovers a duplicate after those writes would already have
           * happened. On a retry that means a serial found "already in stock" —
           * which is an error the first time and a false alarm the second.
           */
          const done = (await tx.execute(sql`
            select id::text as id from public.stock_movement
            where org_id = ${ctx.orgId} and idempotency_key = ${idempotencyKey}
          `)) as unknown as Array<{ id: string }>;
          if (done[0]) {
            booked.push({
              disposition: leg.disposition,
              qty: leg.qty,
              locationId: place.locationId,
              movementId: done[0].id,
              posted: false,
            });
            continue;
          }

          const identity = await identitiesForReceipt(tx, ctx, {
            receiptLineId: line.id,
            itemId: resolved.itemId,
            tracking: resolved.tracking,
            disposition: leg.disposition,
            warehouseId: place.warehouseId,
            locationId: place.locationId,
          });

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
            lots: identity.lots,
            serialIds: identity.serialIds,
            // Derived from the line and the disposition, so a retry recomputes
            // both keys and posts nothing.
            idempotencyKey,
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
    /**
     * The caller's own key for this request.
     *
     * Without one, every call mints a fresh reservation id and therefore a fresh
     * idempotency key, so a double-clicked "reserve" holds the stock twice and
     * nothing anywhere can tell. Supplying a key — a request id, a form
     * submission id — makes the second attempt a no-op.
     */
    idempotencyKey?: string | null;
  },
): Promise<{ reservationId: string; movement: PostedMovement }> {
  assertCan(archetype, "inventory.issue");
  const reservationId = randomUUID();
  const key = input.idempotencyKey ? `resv:${input.idempotencyKey}` : `resv:${reservationId}`;

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
      /*
       * A caller-supplied key means the same request twice reserves once.
       *
       * Checked before the reservation row is written, because writing it and
       * then discovering the movement was a duplicate would leave a reservation
       * holding nothing — visible in every list, backed by no promise.
       */
      if (input.idempotencyKey) {
        const prior = (await tx.execute(sql`
          select m.id::text as id, r.id::text as reservation_id
          from public.stock_movement m
          left join public.stock_reservation r
            on r.org_id = m.org_id and r.item_id = m.item_id
           and r.location_id = m.location_id and r.qty = m.reserved_delta
          where m.org_id = ${ctx.orgId} and m.idempotency_key = ${key}
          limit 1
        `)) as unknown as Array<{ id: string; reservation_id: string | null }>;
        if (prior[0]) {
          return {
            reservationId: prior[0].reservation_id ?? reservationId,
            movement: {
              id: prior[0].id,
              posted: false,
              onHand: "0",
              reserved: "0",
              costTotalMinor: null,
              layerValueMinor: null,
            },
          };
        }
      }

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
        idempotencyKey: key,
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
      const currency = await baseCurrency(tx, ctx);

      for (const line of lines) {
        /*
         * Out through ordinary allocation, so the batches and units that leave
         * are chosen by the same rules as any other issue — and so a tracked
         * item can be transferred at all, which it could not when both legs were
         * posted blind.
         *
         * Transfers may draw from ANY kind of location, not just storage:
         * releasing goods from quarantine to a picking bin is a transfer, and
         * so is moving damaged stock to a returns area. That is named here
         * rather than assumed, because ordinary issuing must never do it.
         */
        const { legs, movements } = await allocateAndIssueIn(tx, ctx, {
          itemId: line.item_id!,
          unitId: line.unit_id!,
          qty: Number(line.qty),
          movementType: "transfer_out",
          warehouseId: t.fw,
          locationIds: [t.fl!],
          allowKinds: TRANSFERABLE_KINDS,
          sourceType: "stock_transfer",
          sourceId: transferId,
          idempotencyKey: `xfer-out:${line.id}`,
        });

        /*
         * In at exactly the value that went out.
         *
         * Moving goods between two of your own bins changes nothing about what
         * they cost. Posting the arrival with no cost — which is what happened
         * before — drew the value out of the source layers and gave the
         * destination quantity with nothing behind it, so every transfer quietly
         * destroyed the value of what it moved.
         */
        for (const [i, leg] of legs.entries()) {
          const out = movements[i]!;
          await postMovementIn(tx, ctx, {
            itemId: line.item_id!,
            warehouseId: t.tw!,
            locationId: t.tl!,
            movementType: "transfer_in",
            qtyDelta: leg.qty,
            unitId: line.unit_id!,
            // What the SOURCE layers gave up, not what the movement was charged:
            // under weighted average those differ, and crediting the charge would
            // invent or destroy the difference on every transfer.
            inboundValueMinor: out.layerValueMinor,
            currency,
            exchangeRate: 1,
            lots: leg.lots ?? null,
            serialIds: leg.serialIds ?? null,
            sourceType: "stock_transfer",
            sourceId: transferId,
            idempotencyKey: `xfer-in:${line.id}@${leg.locationId}`,
          });
        }
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

      /*
       * Every line, in pages.
       *
       * A full-warehouse count runs to thousands of lines. Reading the first
       * thousand and then marking the whole count posted would drop the rest
       * silently — their variances never corrected, their missing reasons never
       * challenged — and the count would look complete.
       */
      const lines: Array<Record<string, string | null>> = [];
      const PAGE = 500;
      for (let offset = 0; ; offset += PAGE) {
        const page = (await tx.execute(sql`
          select scl.id::text as id, scl.item_id::text as item_id,
                 scl.location_id::text as location_id, scl.unit_id::text as unit_id,
                 scl.counted_qty::text as counted_qty, scl.variance_reason,
                 scl.lot_id::text as lot_id, scl.serial_id::text as serial_id,
                 i.tracking,
                 coalesce(
                   case
                     when scl.serial_id is not null then
                       (select case when s.status in ('in_stock', 'reserved')
                                     and s.location_id = scl.location_id
                                   then 1 else 0 end
                        from public.stock_serial s
                        where s.id = scl.serial_id and s.org_id = scl.org_id)
                     when scl.lot_id is not null then
                       (select lb.on_hand from public.stock_lot_balance lb
                        where lb.org_id = scl.org_id and lb.item_id = scl.item_id
                          and lb.location_id = scl.location_id and lb.lot_id = scl.lot_id)
                     else sb.on_hand
                   end, 0)::text as on_hand
          from public.stock_count_line scl
          join public.item i on i.id = scl.item_id and i.org_id = scl.org_id
          left join public.stock_balance sb
            on sb.org_id = scl.org_id and sb.item_id = scl.item_id
           and sb.location_id = scl.location_id
          where scl.count_id = ${countId} and scl.org_id = ${ctx.orgId}
            and scl.counted_qty is not null
          order by scl.sort, scl.id
          limit ${PAGE} offset ${offset}
        `)) as unknown as Array<Record<string, string | null>>;
        lines.push(...page);
        if (page.length < PAGE) break;
      }

      let corrections = 0;
      let unchanged = 0;
      for (const line of lines) {
        /*
         * Re-read what the ledger says, holding the row.
         *
         * The page above was an unlocked bulk read taken before any of this
         * posted. A movement committed in between would make the delta stale,
         * and a correction computed from a stale balance does not correct — it
         * overshoots by exactly whatever moved. Locking here means the delta and
         * the posting see the same number.
         */
        /*
         * The identity rules come FIRST, before the delta shortcut.
         *
         * A batch-tracked line naming no batch, whose counted quantity happens
         * to equal the location's total, is exactly the "40 of which batch?"
         * case this refuses — and putting the check after `delta === 0` let it
         * through whenever the count agreed with the books, which is most of the
         * time.
         */
        const tracking = line.tracking ?? "none";
        if (tracking === "lot" && !line.lot_id) {
          throw new StockMovementConflictError(
            "this item is counted by batch: every count line must name the batch it counted",
          );
        }
        if (tracking === "serial" && !line.serial_id) {
          throw new StockMovementConflictError(
            "this item is counted by unit: every count line must name the unit it counted",
          );
        }
        if (tracking === "none" && (line.lot_id || line.serial_id)) {
          throw new StockMovementConflictError(
            "this item is not tracked by batch or unit, so a count line cannot name one",
          );
        }

        const held = line.serial_id
          ? ((await tx.execute(sql`
              select case when status in ('in_stock', 'reserved') and location_id = ${line.location_id}
                          then 1 else 0 end::text as on_hand,
                     case when status in ('in_stock', 'reserved')
                               and location_id is distinct from ${line.location_id}
                          then 1 else 0 end::text as elsewhere
              from public.stock_serial
              where id = ${line.serial_id} and org_id = ${ctx.orgId}
              for update
            `)) as unknown as Array<{ on_hand: string; elsewhere?: string }>)
          : line.lot_id
            ? ((await tx.execute(sql`
                select on_hand::text as on_hand from public.stock_lot_balance
                where org_id = ${ctx.orgId} and item_id = ${line.item_id}
                  and location_id = ${line.location_id} and lot_id = ${line.lot_id}
                for update
              `)) as unknown as Array<{ on_hand: string; elsewhere?: string }>)
            : ((await tx.execute(sql`
                select on_hand::text as on_hand from public.stock_balance
                where org_id = ${ctx.orgId} and item_id = ${line.item_id}
                  and location_id = ${line.location_id}
                for update
              `)) as unknown as Array<{ on_hand: string; elsewhere?: string }>);
        /*
         * A unit found here that the books place somewhere ELSE is a misplaced
         * unit, not a found one.
         *
         * Posting +1 where it was counted, with no -1 where it supposedly is,
         * would put one physical unit on the books twice — and reconcile would
         * report no drift, because the phantom is in the ledger itself. Moving
         * it is a transfer, which is a different document with a different
         * authorization.
         */
        if (line.serial_id && Number(held[0]?.elsewhere ?? 0) === 1) {
          throw new StockMovementConflictError(
            "that unit is recorded in another location: move it with a transfer, not a count",
          );
        }

        const delta = Number(line.counted_qty) - Number(held[0]?.on_hand ?? 0);
        if (delta === 0) {
          unchanged++;
          continue;
        }
        if (!line.variance_reason || !line.variance_reason.trim()) {
          throw new StockMovementConflictError(
            "every variance needs a reason before the count can be posted",
          );
        }
        if (tracking === "serial" && Math.abs(delta) !== 1) {
          throw new StockMovementConflictError(
            "a serialised unit is either there or it is not; a count line records one unit",
          );
        }

        /*
         * Stock a count FINDS has to be worth something.
         *
         * The goods are real and the business owns them, so adding quantity with
         * no cost behind it means they are issued later for nothing. Valued at
         * what the organization already believes this item is worth in this
         * place — the running average — because a count discovers quantity, not
         * a price. Where there is no average yet, the correction stays uncosted
         * rather than inventing one.
         */
        let foundAtCost: number | null = null;
        if (delta > 0) {
          const avg = (await tx.execute(sql`
            select avg_unit_cost_minor from public.stock_balance
            where org_id = ${ctx.orgId} and item_id = ${line.item_id}
              and location_id = ${line.location_id}
          `)) as unknown as Array<{ avg_unit_cost_minor: string | null }>;
          const here = avg[0]?.avg_unit_cost_minor;
          foundAtCost =
            here === null || here === undefined
              ? await itemAverageCost(tx, ctx, line.item_id!)
              : Number(here);
        }

        await postMovementIn(tx, ctx, {
          itemId: line.item_id!,
          warehouseId: c.warehouse_id!,
          locationId: line.location_id!,
          movementType: "count_correction",
          qtyDelta: delta,
          unitId: line.unit_id!,
          unitCostMinor: foundAtCost,
          currency: foundAtCost === null ? null : await baseCurrency(tx, ctx),
          exchangeRate: foundAtCost === null ? null : 1,
          lots: line.lot_id ? [{ lotId: line.lot_id, qty: Math.abs(delta) }] : null,
          serialIds: line.serial_id ? [line.serial_id] : null,
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

        /*
         * Credit the price this delivery arrived at.
         *
         * The receipt posted one movement per disposition under a key derived
         * from the line, so the layer this return should give back is findable
         * exactly. Without naming it the return would draw the warehouse's
         * oldest open layer, which is a different shipment at a different price
         * — and the doc comment above would be a story rather than a fact.
         */
        const receiptMovement = (await tx.execute(sql`
          select id::text as id from public.stock_movement
          where org_id = ${ctx.orgId}
            and idempotency_key = ${`grl:${line.grl_id}:${disposition}`}
        `)) as unknown as Array<{ id: string }>;

        await allocateAndIssueIn(tx, ctx, {
          itemId: line.item_id!,
          unitId: line.unit_id!,
          qty: wanted,
          movementType: "supplier_return",
          locationIds: place ? [place.locationId] : null,
          allowKinds: place ? [disposition] : null,
          preferLayersFromMovementId: receiptMovement[0]?.id ?? null,
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
