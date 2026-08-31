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
export async function planAllocation(
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
    limit 100
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
        // Per LEG, so a retry of the same issue recomputes the same keys and
        // posts nothing, while two legs of one issue never collide.
        idempotencyKey: `${input.idempotencyKey}@${leg.locationId}`,
        reason: input.reason ?? null,
      }),
    );
  }
  return { legs, movements };
}
