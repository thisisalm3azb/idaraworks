/**
 * Reading stock (H22F).
 *
 * H22A–H22E built the ledger, the costing, the tracking and the register, and
 * gave a person exactly one way to look at any of it: `itemStock`, for one item
 * they already knew the id of. Everything else was writable and invisible.
 *
 * These are the reads the screens need. Every one of them is bounded, keyset
 * paged, organization scoped by both RLS and an explicit predicate, and
 * permission checked before it runs. Keyset rather than OFFSET because stock
 * moves while somebody is paging: an offset skips rows when a movement lands
 * above the cursor, and a stock list that silently omits a line is worse than
 * one that stops early.
 *
 * MONEY IS BEHIND THE COST WALL (F-23). Quantities are operational and everyone
 * with `inventory.view` sees them; value is not, and is nulled for anybody
 * without `ctx.costPrivileged` rather than omitted, so the caller can tell
 * "you may not see this" from "there is nothing here".
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function bound(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

export type StockLevelRow = {
  itemId: string;
  sku: string;
  name: string;
  uom: string;
  onHand: string;
  reserved: string;
  available: string;
  reorderPoint: string | null;
  /** Where it is, when it is in exactly one place; null when spread. */
  soleLocationName: string | null;
  locationCount: number;
  /** Null for anybody outside the cost wall — not zero, and not omitted. */
  valueMinor: number | null;
  currency: string | null;
  /**
   * True when the remaining cost layers are in MORE THAN ONE currency, in which
   * case `valueMinor` is null.
   *
   * Not a nicety. H22C.1 records a layer in the currency the movement was
   * priced in, which may be the supplier's rather than the organization's, and
   * minor units are not interchangeable between currencies — 100 of one is not
   * 100 of another, and three of these currencies have three decimal places
   * rather than two. Adding those columns together produces a number that looks
   * like money and means nothing. So the total is withheld and the reason is
   * said out loud, which is the only honest answer until a valuation slice
   * decides the conversion policy.
   */
  valueIsMixedCurrency: boolean;
};

export type Page<T> = { rows: T[]; nextCursor: string | null; hasMore: boolean };

/**
 * Stock levels across the catalogue, one line per item.
 *
 * Aggregated over locations because the question a person opens this page with
 * is "how much of X do we have", not "how much of X is in bin 4". The item page
 * answers the second one.
 *
 * `lowOnly` compares AVAILABLE against the reorder point, not on-hand: stock
 * already promised to a job is not stock you can use, and a reorder report that
 * counts it reorders too late every time.
 */
export async function listStockLevels(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: {
    search?: string;
    warehouseId?: string;
    lowOnly?: boolean;
    inStockOnly?: boolean;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<Page<StockLevelRow>> {
  assertCan(archetype, "inventory.view");
  const limit = bound(opts.limit);
  const search = opts.search?.trim() ?? "";
  const cursor = opts.cursor ?? null;

  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      with agg as (
        select b.item_id,
               sum(b.on_hand) as on_hand,
               sum(b.reserved) as reserved,
               count(distinct b.location_id) as location_count,
               min(l.name_en) as sole_location_name
        from public.stock_balance b
        join public.stock_location l on l.id = b.location_id and l.org_id = b.org_id
        where b.org_id = ${ctx.orgId}
          and (${opts.warehouseId ?? null}::uuid is null
               or b.warehouse_id = ${opts.warehouseId ?? null}::uuid)
          and (b.on_hand <> 0 or b.reserved <> 0)
        group by b.item_id
      ),
      val as (
        /*
         * Value per item AND per currency, then counted. Summing straight to a
         * single total would silently add minor units across currencies; the
         * count is what lets the mapping refuse to report a mixed one.
         *
         * Filtered by the same warehouse as the quantities above, or a
         * warehouse-filtered page would show one bin's stock priced at the
         * whole organization's value.
         */
        select item_id,
               sum(value_remaining_minor) as value_minor,
               min(currency) as currency,
               count(distinct currency) as currency_count
        from public.stock_cost_layer
        where org_id = ${ctx.orgId} and qty_remaining > 0
          and (${opts.warehouseId ?? null}::uuid is null
               or warehouse_id = ${opts.warehouseId ?? null}::uuid)
        group by item_id
      )
      select i.id::text as item_id, i.sku, i.name,
             coalesce(u.code, i.unit) as uom,
             trim_scale(coalesce(agg.on_hand, 0))::text as on_hand,
             trim_scale(coalesce(agg.reserved, 0))::text as reserved,
             trim_scale(coalesce(agg.on_hand, 0) - coalesce(agg.reserved, 0))::text as available,
             trim_scale(i.reorder_point)::text as reorder_point,
             coalesce(agg.location_count, 0)::int as location_count,
             case when coalesce(agg.location_count, 0) = 1 then agg.sole_location_name end
               as sole_location_name,
             val.value_minor::text as value_minor,
             val.currency as currency,
             coalesce(val.currency_count, 0)::int as currency_count
      from public.item i
      left join public.unit_of_measure u on u.id = i.base_unit_id and u.org_id = i.org_id
      left join agg on agg.item_id = i.id
      left join val on val.item_id = i.id
      where i.org_id = ${ctx.orgId} and i.lifecycle = 'active'
        and i.item_type in ('inventory', 'asset', 'kit', 'manufactured')
        and (${search === ""}
             or i.sku ilike ${"%" + search + "%"}
             or i.name ilike ${"%" + search + "%"}
             -- An Arabic name that cannot be searched in Arabic is not a name.
             or coalesce(i.name_ar, '') ilike ${"%" + search + "%"})
        and (${!opts.inStockOnly} or coalesce(agg.on_hand, 0) > 0)
        and (${!opts.lowOnly}
             or (i.reorder_point is not null
                 and coalesce(agg.on_hand, 0) - coalesce(agg.reserved, 0) <= i.reorder_point))
        and (${cursor}::text is null or i.sku > ${cursor}::text)
      order by i.sku
      limit ${limit + 1}
    `)) as unknown as Array<Record<string, string | number | null>>;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      rows: page.map((r) => ({
        itemId: String(r.item_id),
        sku: String(r.sku),
        name: String(r.name),
        uom: String(r.uom),
        onHand: String(r.on_hand),
        reserved: String(r.reserved),
        available: String(r.available),
        reorderPoint: r.reorder_point === null ? null : String(r.reorder_point),
        soleLocationName: r.sole_location_name === null ? null : String(r.sole_location_name),
        locationCount: Number(r.location_count ?? 0),
        valueMinor:
          ctx.costPrivileged &&
          Number(r.currency_count ?? 0) === 1 &&
          r.value_minor !== null &&
          r.value_minor !== undefined
            ? Number(r.value_minor)
            : null,
        currency:
          ctx.costPrivileged && Number(r.currency_count ?? 0) === 1
            ? ((r.currency as string | null) ?? null)
            : null,
        valueIsMixedCurrency: ctx.costPrivileged && Number(r.currency_count ?? 0) > 1,
      })),
      nextCursor: hasMore ? String(page[page.length - 1]!.sku) : null,
      hasMore,
    };
  });
}

export type StockItem = {
  id: string;
  sku: string;
  name: string;
  uom: string;
  tracking: string;
  reorderPoint: string | null;
  costMethod: string;
};

/**
 * One item, as the stock screens need it.
 *
 * Deliberately NOT `masters.listItems`: that read is gated on `catalog.view`,
 * and the set of people who may look at stock is not the set who may look at
 * the product catalogue. Borrowing the other module's read would have quietly
 * given these pages the catalogue's permission — the kind of mistake that shows
 * up as a 404 for the one role that most needed the page.
 *
 * Null for an item in another organization, exactly as for one that does not
 * exist: the caller must not be able to tell those two apart.
 */
export async function getStockItem(
  ctx: Ctx,
  archetype: RoleArchetype,
  itemId: string,
): Promise<StockItem | null> {
  assertCan(archetype, "inventory.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select i.id::text as id, i.sku, i.name,
             coalesce(u.code, i.unit) as uom,
             i.tracking, trim_scale(i.reorder_point)::text as reorder_point, i.cost_method
      from public.item i
      left join public.unit_of_measure u on u.id = i.base_unit_id and u.org_id = i.org_id
      where i.org_id = ${ctx.orgId} and i.id = ${itemId}
      limit 1
    `),
  )) as unknown as Array<Record<string, string | null>>;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id!,
    sku: r.sku!,
    name: r.name!,
    uom: r.uom!,
    tracking: r.tracking!,
    reorderPoint: r.reorder_point ?? null,
    costMethod: r.cost_method!,
  };
}

export type MovementRow = {
  id: string;
  movementType: string;
  qtyDelta: string;
  /**
   * The promise, not the movement.
   *
   * A reservation posts qty_delta 0 and reserved_delta +n. Without this the
   * ledger showed every reservation as a movement of zero, which the UI then
   * rendered as "-0" — a line that says nothing happened, about the event that
   * is the whole reason the quantity is unavailable.
   */
  reservedDelta: string;
  effectiveAt: string;
  itemId: string;
  sku: string;
  itemName: string;
  locationName: string;
  warehouseName: string;
  sourceType: string | null;
  sourceId: string | null;
  /** Set on the movement that undoes another, so a reversal reads as one. */
  reversesMovementId: string | null;
  note: string | null;
  valueMinor: number | null;
  currency: string | null;
};

/**
 * The movement history — the ledger, read the way a person reads it.
 *
 * Newest first, keyset paged on (effective_at, id) so a movement posted mid-page
 * cannot push a row past the reader unseen. The ledger is append-only, so what
 * is behind the cursor never changes underneath them.
 */
export async function listMovements(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: {
    itemId?: string;
    locationId?: string;
    warehouseId?: string;
    lotId?: string;
    serialId?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<Page<MovementRow>> {
  assertCan(archetype, "inventory.view");
  const limit = bound(opts.limit);
  /*
   * The cursor is the previous page's last (effective_at, id), as one opaque
   * string, so a caller cannot half-supply it and silently get a different page.
   *
   * The  is load-bearing and was  at first: splitting "" gives
   * [""], not [undefined], so the nullish coalescing never fired and every
   * uncursored call bound the empty string as a timestamptz. Postgres rejected
   * it at bind time, before the guard below could short-circuit — which broke
   * the FIRST page of every movement list, the one case the tests happened to
   * exercise last.
   */
  const [curAtRaw, curIdRaw] = (opts.cursor ?? "").split("|");
  const curAt = curAtRaw || null;
  const curId = curIdRaw || null;
  const hasCursor = curAt !== null && curId !== null;

  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select m.id::text as id, m.movement_type, trim_scale(m.qty_delta)::text as qty_delta,
             trim_scale(m.reserved_delta)::text as reserved_delta,
             m.effective_at::text as effective_at,
             m.item_id::text as item_id, i.sku, i.name as item_name,
             l.name_en as location_name, w.name_en as warehouse_name,
             m.source_type, m.source_id::text as source_id,
             m.reverses_movement_id::text as reverses_movement_id,
             m.note,
             m.cost_total_minor::text as value_minor, m.currency
      from public.stock_movement m
      join public.item i on i.id = m.item_id and i.org_id = m.org_id
      join public.stock_location l on l.id = m.location_id and l.org_id = m.org_id
      join public.warehouse w on w.id = m.warehouse_id and w.org_id = m.org_id
      where m.org_id = ${ctx.orgId}
        and (${opts.itemId ?? null}::uuid is null or m.item_id = ${opts.itemId ?? null}::uuid)
        and (${opts.locationId ?? null}::uuid is null
             or m.location_id = ${opts.locationId ?? null}::uuid)
        and (${opts.warehouseId ?? null}::uuid is null
             or m.warehouse_id = ${opts.warehouseId ?? null}::uuid)
        and (${opts.lotId ?? null}::uuid is null or exists (
              select 1 from public.stock_movement_lot ml
              where ml.movement_id = m.id and ml.org_id = m.org_id
                and ml.lot_id = ${opts.lotId ?? null}::uuid))
        and (${opts.serialId ?? null}::uuid is null or exists (
              select 1 from public.stock_movement_serial ms
              where ms.movement_id = m.id and ms.org_id = m.org_id
                and ms.serial_id = ${opts.serialId ?? null}::uuid))
        and (${!hasCursor}
             or (m.effective_at, m.id) < (${curAt}::timestamptz, ${curId}::uuid))
      order by m.effective_at desc, m.id desc
      limit ${limit + 1}
    `)) as unknown as Array<Record<string, string | null>>;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      rows: page.map((r) => ({
        id: r.id!,
        movementType: r.movement_type!,
        qtyDelta: r.qty_delta!,
        reservedDelta: r.reserved_delta!,
        effectiveAt: r.effective_at!,
        itemId: r.item_id!,
        sku: r.sku!,
        itemName: r.item_name!,
        locationName: r.location_name!,
        warehouseName: r.warehouse_name!,
        sourceType: r.source_type ?? null,
        sourceId: r.source_id ?? null,
        reversesMovementId: r.reverses_movement_id ?? null,
        note: r.note ?? null,
        valueMinor: ctx.costPrivileged && r.value_minor !== null ? Number(r.value_minor) : null,
        currency: ctx.costPrivileged ? (r.currency ?? null) : null,
      })),
      nextCursor: hasMore && last ? `${last.effective_at}|${last.id}` : null,
      hasMore,
    };
  });
}

export type LotRow = {
  id: string;
  code: string;
  expiryDate: string | null;
  status: string;
  onHand: string;
  receivedAt: string | null;
  /**
   * Decided by the DATABASE, against its own current_date.
   *
   * The page first worked this out in JavaScript from the server's UTC clock,
   * which is up to four hours behind the Gulf business day this product is
   * built for — so on the morning a batch expired, the screen still called it
   * good. The date the rest of the system uses is the only one that can be
   * right here.
   */
  expired: boolean;
};

/** The batches of one item that still exist, soonest to expire first. */
export async function listItemLots(
  ctx: Ctx,
  archetype: RoleArchetype,
  itemId: string,
  opts: { limit?: number; includeEmpty?: boolean } = {},
): Promise<LotRow[]> {
  assertCan(archetype, "inventory.view");
  const limit = bound(opts.limit);
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select l.id::text as id, l.code, l.expiry_date::text as expiry_date, l.status,
             trim_scale(coalesce(sum(b.on_hand), 0))::text as on_hand,
             l.received_at::text as received_at,
             (l.expiry_date is not null and l.expiry_date <= current_date) as expired
      from public.stock_lot l
      left join public.stock_lot_balance b on b.lot_id = l.id and b.org_id = l.org_id
      where l.org_id = ${ctx.orgId} and l.item_id = ${itemId}
      group by l.id, l.code, l.expiry_date, l.status, l.received_at
      having ${opts.includeEmpty === true} or coalesce(sum(b.on_hand), 0) > 0
      order by l.expiry_date nulls last, l.code
      limit ${limit}
    `),
  )) as unknown as Array<Record<string, string | boolean | null>>;
  return rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    expiryDate: (r.expiry_date as string | null) ?? null,
    status: String(r.status),
    onHand: String(r.on_hand),
    receivedAt: (r.received_at as string | null) ?? null,
    expired: r.expired === true,
  }));
}

export type SerialRow = {
  id: string;
  serialNo: string;
  status: string;
  locationName: string | null;
};

/**
 * The individually-tracked units of one item.
 *
 * Bounded and searchable, because "which serials do we hold" is a question with
 * an unbounded answer for anybody who tracks small parts individually.
 */
export async function listItemSerials(
  ctx: Ctx,
  archetype: RoleArchetype,
  itemId: string,
  opts: { search?: string; status?: string; cursor?: string; limit?: number } = {},
): Promise<Page<SerialRow>> {
  assertCan(archetype, "inventory.view");
  const limit = bound(opts.limit);
  const search = opts.search?.trim() ?? "";
  const cursor = opts.cursor ?? null;
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select s.id::text as id, s.serial_no, s.status, l.name_en as location_name
      from public.stock_serial s
      left join public.stock_location l on l.id = s.location_id and l.org_id = s.org_id
      where s.org_id = ${ctx.orgId} and s.item_id = ${itemId}
        and (${opts.status ?? null}::text is null or s.status = ${opts.status ?? null})
        and (${search === ""} or s.serial_no ilike ${"%" + search + "%"})
        and (${cursor}::text is null or s.serial_no > ${cursor}::text)
      order by s.serial_no
      limit ${limit + 1}
    `)) as unknown as Array<Record<string, string | null>>;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      rows: page.map((r) => ({
        id: r.id!,
        serialNo: r.serial_no!,
        status: r.status!,
        locationName: r.location_name ?? null,
      })),
      nextCursor: hasMore ? page[page.length - 1]!.serial_no! : null,
      hasMore,
    };
  });
}
