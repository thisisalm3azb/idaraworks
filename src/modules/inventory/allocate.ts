/**
 * Allocating an issue across locations (H22C.1).
 *
 * Stock lives in bins, and the quantity a job needs is often spread across
 * several. Issuing from one nominated bin refuses work the warehouse can plainly
 * fulfil; issuing from "wherever" is unpredictable and can quietly take stock out
 * of quarantine.
 *
 * So allocation is explicit and deterministic:
 *   1. eligible locations only — active, stock-holding, kind 'storage'
 *   2. the default issue location first, because that is what a picker expects
 *   3. then the location holding the most, then oldest-updated, then by id
 *
 * The tie-breakers matter. Without a total order, two identical requests can
 * allocate differently, which makes a bug unreproducible and a test flaky. The
 * final `location_id` tie-break guarantees the order is total.
 *
 * ALL OR NOTHING: if the eligible locations cannot cover the full quantity,
 * nothing is posted at all. A partial issue that silently takes what it can find
 * leaves a job short and a picker unaware.
 */
import { sql, type Ctx, type TenantTx } from "@/platform/tenancy";
import { InsufficientStockError, postMovementIn, type PostedMovement } from "./ledger";

/** Kinds of place ordinary issuing may draw from. */
const ISSUABLE_KINDS = ["storage"] as const;

export type AllocationLeg = {
  warehouseId: string;
  locationId: string;
  qty: number;
  /** Which batches this leg takes, for a lot-tracked item. */
  lots?: Array<{ lotId: string; qty: number }>;
  /** Which units this leg takes, for a serialised item. */
  serialIds?: string[];
};

export type AllocateInput = {
  itemId: string;
  unitId: string;
  qty: number;
  movementType: string;
  /** Narrow to one warehouse. Absent allocates across the organization. */
  warehouseId?: string | null;
  /**
   * Exact places to draw from, in order, chosen by an authorized caller.
   *
   * Still checked against the same eligibility rules: naming a quarantine bin
   * explicitly does not make it issuable, because the reason it is quarantined
   * has not changed.
   */
  locationIds?: readonly string[] | null;
  /**
   * Widen the kinds of location this may draw from.
   *
   * Ordinary issuing never sees anything but 'storage'. A supplier return of
   * damaged goods must draw from the damaged bin — and that is not a silent
   * exception, it is the disposition the return document names. Anything that
   * widens this must say so explicitly at the call site.
   */
  allowKinds?: readonly string[] | null;
  /**
   * Undo a specific delivery's cost rather than the oldest open layer.
   *
   * A supplier return gives back what THAT delivery brought in. Without this the
   * credit is whatever the warehouse's oldest open layer happens to hold, which
   * may be a different price from a different shipment.
   */
  preferLayersFromMovementId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  /** The base key. Each leg appends its location, so retries stay idempotent. */
  idempotencyKey: string;
  reason?: string | null;
};

/**
 * Work out which locations will supply an issue, without writing anything.
 *
 * Locking each candidate balance row (`for update`) is what makes the plan
 * survive to the posting: a concurrent issue cannot empty a bin between deciding
 * and taking. The locks are held to the end of the caller's transaction.
 */
async function planUntrackedAllocation(
  tx: TenantTx,
  ctx: Ctx,
  input: AllocateInput,
): Promise<AllocationLeg[]> {
  const explicit = input.locationIds ?? null;
  const kinds = (input.allowKinds ?? ISSUABLE_KINDS) as readonly string[];

  /*
   * Built as an explicit list rather than `= any(${array})`.
   *
   * The driver flattens a JS array into one parameter per element, so a
   * single-element array renders as `any(($1))` — which happens to work — and an
   * empty one renders as `any(())`, which is a syntax error. Writing the list out
   * behaves the same at every length.
   */
  const kindList = sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  );
  const locationFilter =
    explicit === null
      ? sql`true`
      : explicit.length === 0
        ? // The caller named a set of places and that set is empty, so nothing
          // is eligible. Saying `false` here reaches the all-or-nothing check
          // below with an honest shortfall.
          sql`false`
        : sql`b.location_id in (${sql.join(
            explicit.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;

  const rows = (await tx.execute(sql`
    select b.location_id::text as location_id, b.warehouse_id::text as warehouse_id,
           (b.on_hand - b.reserved)::text as available,
           l.is_default_issue, b.updated_at
    from public.stock_balance b
    join public.stock_location l on l.id = b.location_id and l.org_id = b.org_id
    where b.org_id = ${ctx.orgId}
      and b.item_id = ${input.itemId}
      and (b.on_hand - b.reserved) > 0
      -- Never quarantine, damaged, receiving, dispatch or transit unless the
      -- caller named that kind on purpose. Those hold stock the business owns
      -- but must not casually issue.
      and l.kind in (${kindList})
      and l.active
      and l.can_hold_stock
      and (${input.warehouseId ?? null}::uuid is null
           or b.warehouse_id = ${input.warehouseId ?? null}::uuid)
      and ${locationFilter}
    order by l.is_default_issue desc, (b.on_hand - b.reserved) desc, b.updated_at, b.location_id
    for update of b
  `)) as unknown as Array<Record<string, string | boolean>>;

  /*
   * An explicit request is honoured IN THE ORDER GIVEN.
   *
   * The caller named those places for a reason — a picker walking a route, or a
   * supervisor emptying a bin deliberately — and reordering them by size would
   * quietly ignore that.
   */
  const ordered = explicit
    ? explicit
        .map((id) => rows.find((r) => r.location_id === id))
        .filter((r): r is Record<string, string | boolean> => Boolean(r))
    : rows;

  const legs: AllocationLeg[] = [];
  let left = input.qty;
  for (const row of ordered) {
    if (left <= 0) break;
    const available = Number(row.available);
    if (available <= 0) continue;
    const take = Math.min(left, available);
    legs.push({
      warehouseId: String(row.warehouse_id),
      locationId: String(row.location_id),
      qty: take,
    });
    left -= take;
  }

  if (left > 0) {
    // All or nothing. The message reports what the ELIGIBLE locations hold, not
    // the organization's total, so a picker is not sent looking for stock that
    // is sitting in quarantine.
    const eligible = ordered.reduce((s, r) => s + Number(r.available), 0);
    throw new InsufficientStockError(String(eligible), String(input.qty));
  }

  return legs;
}

/**
 * Work out which locations, batches or units will supply an issue.
 *
 * For an untracked item the answer is locations. For a tracked one it is
 * batches or units, and the locations fall out of where those are — which is
 * the only way first-expiry-first-out can be true across a warehouse rather
 * than merely within whichever bin happened to be chosen first.
 */
export async function planAllocation(
  tx: TenantTx,
  ctx: Ctx,
  input: AllocateInput,
): Promise<AllocationLeg[]> {
  const tracking = await itemTracking(tx, ctx, input.itemId);
  if (tracking === "lot") return planLotAllocation(tx, ctx, input);
  if (tracking === "serial") return planSerialAllocation(tx, ctx, input);
  return planUntrackedAllocation(tx, ctx, input);
}

/** How this item's movements must identify what they move. */
async function itemTracking(
  tx: TenantTx,
  ctx: Ctx,
  itemId: string,
): Promise<"none" | "lot" | "serial"> {
  const rows = (await tx.execute(sql`
    select tracking, expiry_tracked from public.item
    where id = ${itemId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ tracking: string }>;
  const t = rows[0]?.tracking;
  return t === "lot" || t === "serial" ? t : "none";
}

/** The eligibility filters every allocation shares, as SQL fragments. */
function eligibility(ctx: Ctx, input: AllocateInput) {
  const kinds = (input.allowKinds ?? ISSUABLE_KINDS) as readonly string[];
  const explicit = input.locationIds ?? null;
  return {
    explicit,
    kindList: sql.join(
      kinds.map((k) => sql`${k}`),
      sql`, `,
    ),
    locationFilter:
      explicit === null
        ? sql`true`
        : explicit.length === 0
          ? sql`false`
          : sql`l.id in (${sql.join(
              explicit.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`,
    warehouse: sql`(${input.warehouseId ?? null}::uuid is null
                    or l.warehouse_id = ${input.warehouseId ?? null}::uuid)`,
  };
}

/**
 * Allocate a batch-tracked item, batch first.
 *
 * FEFO — first expiry, first out — is the rule wherever an expiry exists,
 * because the alternative is watching the oldest stock expire on the shelf while
 * newer stock is issued in front of it. Ordering by expiry ACROSS the eligible
 * bins is what makes that true: choosing bins first and then batches within them
 * would issue a bin's newest stock ahead of another bin's nearly-expired stock,
 * which is precisely the outcome FEFO exists to prevent.
 *
 * Batches with no expiry sort after those that have one and fall back to the
 * order they arrived in. An expired batch is never issued, and neither is one
 * that is quarantined or recalled: a recall is a decision somebody made about
 * goods that are physically present, and physical presence is exactly what makes
 * it dangerous to ignore.
 */
async function planLotAllocation(
  tx: TenantTx,
  ctx: Ctx,
  input: AllocateInput,
): Promise<AllocationLeg[]> {
  const e = eligibility(ctx, input);
  const rows = (await tx.execute(sql`
    select b.lot_id::text as lot_id, b.location_id::text as location_id,
           b.warehouse_id::text as warehouse_id,
           (b.on_hand - b.reserved)::text as available,
           lot.expiry_date, lot.received_at
    from public.stock_lot_balance b
    join public.stock_location l on l.id = b.location_id and l.org_id = b.org_id
    join public.stock_lot lot on lot.id = b.lot_id and lot.org_id = b.org_id
    where b.org_id = ${ctx.orgId} and b.item_id = ${input.itemId}
      and (b.on_hand - b.reserved) > 0
      and l.kind in (${e.kindList}) and l.active and l.can_hold_stock
      and ${e.warehouse} and ${e.locationFilter}
      and lot.status = 'active'
      -- Expiry is a fact about today, not about what somebody remembered to
      -- mark. A batch past its date is out, marked or not.
      and (lot.expiry_date is null or lot.expiry_date >= current_date)
    order by lot.expiry_date asc nulls last, lot.received_at, lot.id,
             l.is_default_issue desc, b.location_id
    for update of b
  `)) as unknown as Array<Record<string, string | boolean | null>>;

  const byLocation = new Map<string, AllocationLeg>();
  let left = input.qty;
  for (const row of rows) {
    if (left <= 0) break;
    const available = Number(row.available);
    if (available <= 0) continue;
    const take = Math.min(left, available);
    const locationId = String(row.location_id);
    const leg = byLocation.get(locationId) ?? {
      warehouseId: String(row.warehouse_id),
      locationId,
      qty: 0,
      lots: [],
    };
    leg.qty += take;
    leg.lots!.push({ lotId: String(row.lot_id), qty: take });
    byLocation.set(locationId, leg);
    left -= take;
  }
  if (left > 0) {
    // What is ISSUABLE, not what is present: expired and recalled stock sitting
    // on the shelf makes the total look healthy and cannot fill an order.
    const issuable = rows.reduce((s, r) => s + Number(r.available), 0);
    throw new InsufficientStockError(String(issuable), String(input.qty));
  }

  /*
   * Quantity-level reservations still bind.
   *
   * A reservation promises a quantity, not a batch — stock_lot_balance.reserved
   * is never written, so reading only the batch rows would hand out stock
   * somebody has already been promised and make every reservation on a
   * batch-tracked item decorative.
   */
  await assertNotPromisedAway(tx, ctx, input);
  return [...byLocation.values()];
}

/** Refuse an issue that would eat into what is already promised to someone. */
async function assertNotPromisedAway(tx: TenantTx, ctx: Ctx, input: AllocateInput): Promise<void> {
  const e = eligibility(ctx, input);
  const rows = (await tx.execute(sql`
    select coalesce(sum(b.on_hand), 0)::text as on_hand,
           coalesce(sum(b.reserved), 0)::text as reserved
    from public.stock_balance b
    join public.stock_location l on l.id = b.location_id and l.org_id = b.org_id
    where b.org_id = ${ctx.orgId} and b.item_id = ${input.itemId}
      and l.kind in (${e.kindList}) and l.active and l.can_hold_stock
      and ${e.warehouse} and ${e.locationFilter}
  `)) as unknown as Array<{ on_hand: string; reserved: string }>;
  const available = Number(rows[0]?.on_hand ?? 0) - Number(rows[0]?.reserved ?? 0);
  if (available < input.qty) {
    throw new InsufficientStockError(String(Math.max(available, 0)), String(input.qty));
  }
}

/**
 * Allocate a serialised item, unit by unit.
 *
 * Oldest first, then by serial number, so two identical requests pick the same
 * units. A unit is in exactly one place, so its own row is both the balance and
 * the lock — and a unit whose batch has expired or been recalled is not issuable
 * however healthy the count looks.
 */
async function planSerialAllocation(
  tx: TenantTx,
  ctx: Ctx,
  input: AllocateInput,
): Promise<AllocationLeg[]> {
  const e = eligibility(ctx, input);
  if (!Number.isInteger(input.qty)) {
    throw new InsufficientStockError("0", String(input.qty));
  }
  const wanted = input.qty;
  const rows = (await tx.execute(sql`
    select s.id::text as id, s.location_id::text as location_id,
           l.warehouse_id::text as warehouse_id
    from public.stock_serial s
    join public.stock_location l on l.id = s.location_id and l.org_id = s.org_id
    left join public.stock_lot lot on lot.id = s.lot_id and lot.org_id = s.org_id
    where s.org_id = ${ctx.orgId} and s.item_id = ${input.itemId}
      -- 'reserved' is deliberately excluded: a unit promised to someone is not
      -- available to promise again, and for a serialised item that promise is
      -- about a specific unit rather than a quantity.
      and s.status = 'in_stock'
      and l.kind in (${e.kindList}) and l.active and l.can_hold_stock
      and ${e.warehouse} and ${e.locationFilter}
      and (lot.id is null
           or (lot.status = 'active'
               and (lot.expiry_date is null or lot.expiry_date >= current_date)))
    order by s.received_at, s.serial_no
    limit ${wanted}
    for update of s
  `)) as unknown as Array<Record<string, string>>;

  if (rows.length < wanted) {
    throw new InsufficientStockError(String(rows.length), String(wanted));
  }

  /*
   * Quantity-level reservations still bind.
   *
   * A serialised item can be reserved without naming a unit — someone promised
   * "two of these" to a job. Those two are not available to anybody else, so
   * only what is left after the promise may be issued. Without this the
   * reservation is a number nobody enforces.
   */
  await assertNotPromisedAway(tx, ctx, input);
  const byLocation = new Map<string, AllocationLeg>();
  for (const row of rows) {
    const locationId = row.location_id!;
    const leg = byLocation.get(locationId) ?? {
      warehouseId: row.warehouse_id!,
      locationId,
      qty: 0,
      serialIds: [],
    };
    leg.qty += 1;
    leg.serialIds!.push(row.id!);
    byLocation.set(locationId, leg);
  }
  return [...byLocation.values()];
}

/**
 * Post an issue across however many locations it takes.
 *
 * Every leg posts in the CALLER'S transaction, so the whole issue is one atomic
 * act: either all the legs land or none of them do. A failure on the third bin
 * cannot leave the first two already taken.
 */
export async function allocateAndIssueIn(
  tx: TenantTx,
  ctx: Ctx,
  input: AllocateInput,
): Promise<{ legs: AllocationLeg[]; movements: PostedMovement[] }> {
  /*
   * Two callers with the same key must not both proceed.
   *
   * The check below is a read, and a read cannot exclude anything: two retries
   * arriving together both see no prior movement, both allocate — and because
   * each leg's key embeds the bin it happened to pick, two different bins
   * produce two different keys and the unique index never fires. The issue
   * happens twice.
   *
   * A transaction-scoped advisory lock on the key closes that: the second caller
   * waits, and by the time it looks the first has committed its movements. The
   * lock costs nothing when there is no contention and is released with the
   * transaction whatever happens.
   */
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${`${ctx.orgId}:${input.idempotencyKey}`}, 0))
  `);

  /*
   * Has this issue already happened?
   *
   * Asked BEFORE allocating, because allocation is not idempotent on its own:
   * the first attempt took the stock, so a retry sees less of it and would
   * either fail with a misleading shortfall or — worse — allocate from a
   * different bin, whose per-leg key differs, and issue the same quantity twice.
   *
   * The legs of one issue all begin with the caller's key, so their existence is
   * the record that the work is done.
   */
  const already = (await tx.execute(sql`
    select m.id::text as id, m.location_id::text as location_id,
           m.warehouse_id::text as warehouse_id, (- m.qty_delta)::text as qty,
           m.cost_total_minor,
           coalesce(b.on_hand, 0)::text as on_hand,
           coalesce(b.reserved, 0)::text as reserved
    from public.stock_movement m
    left join public.stock_balance b
      on b.org_id = m.org_id and b.item_id = m.item_id and b.location_id = m.location_id
    where m.org_id = ${ctx.orgId}
      and starts_with(m.idempotency_key, ${`${input.idempotencyKey}@`})
    order by m.created_at, m.id
    -- Generous: an issue spanning more bins than this would be extraordinary, and
    -- truncating the replay would under-report both the legs and the cost.
    limit 500
  `)) as unknown as Array<Record<string, string | number | null>>;
  if (already.length > 0) {
    return {
      legs: already.map((m) => ({
        warehouseId: String(m.warehouse_id),
        locationId: String(m.location_id),
        qty: Number(m.qty),
      })),
      movements: already.map((m) => ({
        id: String(m.id),
        posted: false,
        onHand: String(m.on_hand),
        reserved: String(m.reserved),
        costTotalMinor: m.cost_total_minor === null ? null : Number(m.cost_total_minor),
        layerValueMinor: m.cost_total_minor === null ? null : Number(m.cost_total_minor),
      })),
    };
  }

  const legs = await planAllocation(tx, ctx, input);
  const movements: PostedMovement[] = [];
  for (const leg of legs) {
    movements.push(
      await postMovementIn(tx, ctx, {
        itemId: input.itemId,
        warehouseId: leg.warehouseId,
        locationId: leg.locationId,
        movementType: input.movementType,
        qtyDelta: -leg.qty,
        unitId: input.unitId,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        lots: leg.lots ?? null,
        serialIds: leg.serialIds ?? null,
        preferLayersFromMovementId: input.preferLayersFromMovementId ?? null,
        // Per LEG, so a retry of the same issue recomputes the same keys and
        // posts nothing, while two legs of one issue never collide.
        idempotencyKey: `${input.idempotencyKey}@${leg.locationId}`,
        reason: input.reason ?? null,
      }),
    );
  }
  return { legs, movements };
}
