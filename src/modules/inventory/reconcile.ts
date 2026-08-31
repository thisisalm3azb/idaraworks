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

export type ReconcileResult = {
  checked: number;
  drift: BalanceDrift[];
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

  if (!opts.repair || drift.length === 0) {
    return { checked: rows.length, drift, repaired: false };
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
        summary: `Rebuilt ${drift.length} stock balance row(s) from the ledger`,
      },
    },
    async (tx) => {
      for (const d of drift) {
        await tx.execute(sql`
          insert into public.stock_balance
            (org_id, item_id, warehouse_id, location_id, on_hand, reserved, updated_at)
          values (${ctx.orgId}, ${d.itemId}, ${d.warehouseId}, ${d.locationId},
                  ${d.ledgerOnHand}::numeric, ${d.ledgerReserved}::numeric, now())
          on conflict (org_id, item_id, warehouse_id, location_id) do update
            set on_hand = excluded.on_hand,
                reserved = excluded.reserved,
                updated_at = now()
        `);
      }
    },
  );

  return { checked: rows.length, drift, repaired: true };
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
             b.on_hand::text as on_hand, b.reserved::text as reserved,
             (b.on_hand - b.reserved)::text as available
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
