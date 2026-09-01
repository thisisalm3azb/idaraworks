/**
 * Reconciling the balance projection against the ledger (H22B).
 *
 * `stock_balance` is a cache. This recomputes what it SHOULD hold by summing
 * `stock_movement` and reports every difference.
 *
 * It does not repair by default, and that is the important part. A projection
 * that silently corrects itself hides the bug that broke it: the numbers look
 * right again and nobody learns that a posting path is not maintaining them. A
 * mismatch is a defect report, not a chore.
 *
 * Repair exists behind an explicit flag, for the moment after a bug is
 * understood and fixed. It rewrites only the projection, never the ledger.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import { command } from "@/platform/audit";
import type { RoleArchetype } from "@/platform/registries";

export type BalanceDrift = {
  itemId: string;
  itemSku: string;
  warehouseId: string;
  locationId: string;
  /** What the projection claims. */
  storedOnHand: string;
  storedReserved: string;
  /** What the ledger actually sums to. */
  ledgerOnHand: string;
  ledgerReserved: string;
};

/** The same comparison, one grain finer: what each batch should hold. */
export type LotDrift = {
  itemId: string;
  lotId: string;
  lotCode: string;
  locationId: string;
  storedOnHand: string;
  ledgerOnHand: string;
};

/**
 * An item whose cost layers no longer add up to what the ledger charged.
 *
 * Quantity drift and VALUE drift are different failures. A transfer that moves
 * the goods correctly while destroying their value, or rounding that leaks a few
 * minor units per issue, leaves every quantity right and the valuation wrong —
 * so a reconciler that only counts things reports all-clear on exactly the
 * defects that reach the accounts.
 */
export type ValueDrift = {
  itemId: string;
  itemSku: string;
  /** What the open cost layers still hold. */
  layerValueMinor: string;
  /** What the ledger says arrived minus what it says left. */
  ledgerValueMinor: string;
};

export type ReconcileResult = {
  checked: number;
  drift: BalanceDrift[];
  /** Lot-level drift, reported alongside rather than folded in: a batch can be
   * wrong while the item total is right, and that is a different defect. */
  lotDrift: LotDrift[];
  valueDrift: ValueDrift[];
  repaired: boolean;
};

/**
 * Compare every balance row with the ledger.
 *
 * A FULL OUTER JOIN, deliberately: a balance row with no movements behind it is
 * as wrong as movements with no balance row, and an inner join would hide both.
 */
export async function reconcileStockBalances(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { repair?: boolean } = {},
): Promise<ReconcileResult> {
  assertCan(archetype, "inventory.view");
  if (opts.repair) assertCan(archetype, "inventory.adjust");

  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      with ledger as (
        select item_id, warehouse_id, location_id,
               sum(qty_delta) as on_hand,
               sum(reserved_delta) as reserved
        from public.stock_movement
        where org_id = ${ctx.orgId}
        group by item_id, warehouse_id, location_id
      )
      select
        coalesce(b.item_id, l.item_id)::text as item_id,
        coalesce(b.warehouse_id, l.warehouse_id)::text as warehouse_id,
        coalesce(b.location_id, l.location_id)::text as location_id,
        i.sku as item_sku,
        coalesce(b.on_hand, 0)::text as stored_on_hand,
        coalesce(b.reserved, 0)::text as stored_reserved,
        coalesce(l.on_hand, 0)::text as ledger_on_hand,
        coalesce(l.reserved, 0)::text as ledger_reserved
      from public.stock_balance b
      full outer join ledger l
        on l.item_id = b.item_id
       and l.warehouse_id = b.warehouse_id
       and l.location_id = b.location_id
      left join public.item i
        on i.id = coalesce(b.item_id, l.item_id) and i.org_id = ${ctx.orgId}
      where b.org_id = ${ctx.orgId} or b.org_id is null
      order by i.sku
    `),
  )) as unknown as Array<Record<string, string>>;

  const drift: BalanceDrift[] = [];
  for (const r of rows) {
    const same =
      Number(r.stored_on_hand) === Number(r.ledger_on_hand) &&
      Number(r.stored_reserved) === Number(r.ledger_reserved);
    if (same) continue;
    drift.push({
      itemId: r.item_id!,
      itemSku: r.item_sku ?? "(unknown)",
      warehouseId: r.warehouse_id!,
      locationId: r.location_id!,
      storedOnHand: r.stored_on_hand!,
      storedReserved: r.stored_reserved!,
      ledgerOnHand: r.ledger_on_hand!,
      ledgerReserved: r.ledger_reserved!,
    });
  }

  /*
   * Batches, compared the same way.
   *
   * A lot balance can be wrong while the item's total is right — two batches
   * that offset each other still add up — so folding this into the row above
   * would let exactly the mistakes that matter for recall and expiry disappear
   * into a correct-looking total.
   */
  const lotRows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      with ledger as (
        select m.item_id, m.location_id, ml.lot_id, sum(ml.qty) as on_hand
        from public.stock_movement_lot ml
        join public.stock_movement m on m.id = ml.movement_id and m.org_id = ml.org_id
        where ml.org_id = ${ctx.orgId}
        group by m.item_id, m.location_id, ml.lot_id
      )
      select
        coalesce(b.item_id, l.item_id)::text as item_id,
        coalesce(b.location_id, l.location_id)::text as location_id,
        coalesce(b.lot_id, l.lot_id)::text as lot_id,
        lot.code as lot_code,
        coalesce(b.on_hand, 0)::text as stored_on_hand,
        coalesce(l.on_hand, 0)::text as ledger_on_hand
      from public.stock_lot_balance b
      full outer join ledger l
        on l.item_id = b.item_id and l.location_id = b.location_id and l.lot_id = b.lot_id
      left join public.stock_lot lot
        on lot.id = coalesce(b.lot_id, l.lot_id) and lot.org_id = ${ctx.orgId}
      where b.org_id = ${ctx.orgId} or b.org_id is null
      order by lot.code
    `),
  )) as unknown as Array<Record<string, string>>;

  const lotDrift: LotDrift[] = [];
  for (const r of lotRows) {
    if (Number(r.stored_on_hand) === Number(r.ledger_on_hand)) continue;
    lotDrift.push({
      itemId: r.item_id!,
      lotId: r.lot_id!,
      lotCode: r.lot_code ?? "(unknown)",
      locationId: r.location_id!,
      storedOnHand: r.stored_on_hand!,
      ledgerOnHand: r.ledger_on_hand!,
    });
  }

  /*
   * Does the valuation still tie out?
   *
   * Restricted to FIFO and specific identification, where the identity actually
   * holds: what the layers have left must equal what came in minus what went
   * out. Weighted average deliberately charges the running average while drawing
   * the batch's own layers, so the two legitimately differ there and asserting
   * otherwise would report a defect on correct behaviour.
   */
  const valueRows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      with method as (
        select i.id, i.sku,
               coalesce(
                 case when i.tracking = 'serial' then 'specific' else i.cost_method end,
                 (select coalesce(s.value ->> 'costMethod', 'weighted_average')
                  from public.app_settings s
                  where s.org_id = ${ctx.orgId} and s.key = 'inventory.policy')
               ) as effective
        from public.item i
        where i.org_id = ${ctx.orgId}
      ),
      layers as (
        select item_id, sum(value_remaining_minor) as v
        from public.stock_cost_layer where org_id = ${ctx.orgId}
        group by item_id
      ),
      moved as (
        select item_id,
               sum(case when qty_delta > 0 then cost_total_minor else -cost_total_minor end) as v
        from public.stock_movement
        where org_id = ${ctx.orgId} and cost_total_minor is not null
        group by item_id
      )
      select m.id::text as item_id, m.sku as item_sku,
             coalesce(l.v, 0)::text as layer_value,
             coalesce(mv.v, 0)::text as ledger_value
      from method m
      left join layers l on l.item_id = m.id
      left join moved mv on mv.item_id = m.id
      where m.effective in ('fifo', 'specific')
        and coalesce(l.v, 0) <> coalesce(mv.v, 0)
      order by m.sku
    `),
  )) as unknown as Array<Record<string, string>>;

  const valueDrift: ValueDrift[] = valueRows.map((r) => ({
    itemId: r.item_id!,
    itemSku: r.item_sku ?? "(unknown)",
    layerValueMinor: r.layer_value!,
    ledgerValueMinor: r.ledger_value!,
  }));

  if (!opts.repair || (drift.length === 0 && lotDrift.length === 0)) {
    return {
      checked: rows.length + lotRows.length,
      drift,
      lotDrift,
      valueDrift,
      repaired: false,
    };
  }

  // Explicit repair. The ledger is the authority, so the projection is rewritten
  // from it — never the other way round.
  await command(
    ctx,
    {
      audit: {
        action: "stock.balance_repair",
        entityType: "stock_movement",
        entityId: undefined,
        summary: `Rebuilt ${drift.length} stock balance row(s) and ${lotDrift.length} batch row(s) from the ledger`,
      },
    },
    async (tx) => {
      /*
       * Recomputed from the ledger HERE, not written from the earlier read.
       *
       * The comparison above ran in its own read-only transaction; movements
       * posted since would be silently undone by writing those stale numbers
       * back. So the repair re-derives each row inside this transaction, behind
       * the same balance-row lock the posting path takes, and the value it
       * writes is the ledger's as of now.
       */
      for (const d of drift) {
        await tx.execute(sql`
          insert into public.stock_balance (org_id, item_id, warehouse_id, location_id)
          values (${ctx.orgId}, ${d.itemId}, ${d.warehouseId}, ${d.locationId})
          on conflict do nothing
        `);
        await tx.execute(sql`
          select on_hand from public.stock_balance
          where org_id = ${ctx.orgId} and item_id = ${d.itemId}
            and warehouse_id = ${d.warehouseId} and location_id = ${d.locationId}
          for update
        `);
        await tx.execute(sql`
          update public.stock_balance b
          set on_hand = coalesce(l.on_hand, 0), reserved = coalesce(l.reserved, 0),
              updated_at = now()
          from (
            select sum(qty_delta) as on_hand, sum(reserved_delta) as reserved
            from public.stock_movement
            where org_id = ${ctx.orgId} and item_id = ${d.itemId}
              and warehouse_id = ${d.warehouseId} and location_id = ${d.locationId}
          ) l
          where b.org_id = ${ctx.orgId} and b.item_id = ${d.itemId}
            and b.warehouse_id = ${d.warehouseId} and b.location_id = ${d.locationId}
        `);
      }
      for (const d of lotDrift) {
        await tx.execute(sql`
          insert into public.stock_lot_balance
            (org_id, item_id, warehouse_id, location_id, lot_id)
          select ${ctx.orgId}, ${d.itemId}, loc.warehouse_id, ${d.locationId}, ${d.lotId}
          from public.stock_location loc
          where loc.id = ${d.locationId} and loc.org_id = ${ctx.orgId}
          on conflict do nothing
        `);
        await tx.execute(sql`
          select on_hand from public.stock_lot_balance
          where org_id = ${ctx.orgId} and item_id = ${d.itemId}
            and location_id = ${d.locationId} and lot_id = ${d.lotId}
          for update
        `);
        await tx.execute(sql`
          update public.stock_lot_balance b
          set on_hand = coalesce(l.qty, 0), updated_at = now()
          from (
            select sum(ml.qty) as qty
            from public.stock_movement_lot ml
            join public.stock_movement m on m.id = ml.movement_id and m.org_id = ml.org_id
            where ml.org_id = ${ctx.orgId} and ml.lot_id = ${d.lotId}
              and m.item_id = ${d.itemId} and m.location_id = ${d.locationId}
          ) l
          where b.org_id = ${ctx.orgId} and b.item_id = ${d.itemId}
            and b.location_id = ${d.locationId} and b.lot_id = ${d.lotId}
        `);
      }
    },
  );

  return { checked: rows.length + lotRows.length, drift, lotDrift, valueDrift, repaired: true };
}

/**
 * Stock on hand, available and reserved for one item across its locations.
 *
 * Reads the projection, because that is what it is for. Anything that must be
 * exactly right rather than fast reads the ledger through the reconciler.
 */
export async function itemStock(
  ctx: Ctx,
  archetype: RoleArchetype,
  itemId: string,
): Promise<
  Array<{
    warehouseId: string;
    warehouseName: string;
    locationId: string;
    locationName: string;
    onHand: string;
    reserved: string;
    available: string;
  }>
> {
  assertCan(archetype, "inventory.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select b.warehouse_id::text as warehouse_id, w.name_en as warehouse_name,
             b.location_id::text as location_id, l.name_en as location_name,
             trim_scale(b.on_hand)::text as on_hand, trim_scale(b.reserved)::text as reserved,
             trim_scale(b.on_hand - b.reserved)::text as available
      from public.stock_balance b
      join public.warehouse w on w.id = b.warehouse_id and w.org_id = b.org_id
      join public.stock_location l on l.id = b.location_id and l.org_id = b.org_id
      where b.org_id = ${ctx.orgId} and b.item_id = ${itemId}
        and (b.on_hand <> 0 or b.reserved <> 0)
      order by w.name_en, l.name_en
      limit 500
    `),
  )) as unknown as Array<Record<string, string>>;
  return rows.map((r) => ({
    warehouseId: r.warehouse_id!,
    warehouseName: r.warehouse_name!,
    locationId: r.location_id!,
    locationName: r.location_name!,
    onHand: r.on_hand!,
    reserved: r.reserved!,
    available: r.available!,
  }));
}
