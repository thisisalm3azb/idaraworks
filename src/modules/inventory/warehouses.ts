/**
 * H30 LB-2 — warehouses and stock locations as something a person can create.
 *
 * The schema for both has existed since H22A, complete with row-level security
 * and column-scoped grants. What never existed was any way to USE it: no module
 * function, no screen. So an organisation could receive goods against a purchase
 * order, watch the receipt save, and never see stock — because `receivingLocation`
 * found no default receiving bin and threw. The banner then advised checking
 * "the warehouse setup", which pointed at a page that did not exist.
 *
 * That is exactly what happened to Najolatech (docs/H22-BLOCKER-PO002.md): 34
 * units received across two receipts, zero stock movements, no warehouse, and
 * nothing in the product to fix it with.
 *
 * This module closes that gap and adds the diagnostic the remedy needs:
 * `receivingReadiness()` answers "can this organisation receive stock at all,
 * and if not, precisely what is missing".
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import { command } from "@/platform/audit";
import type { RoleArchetype } from "@/platform/registries";

export class WarehouseSetupError extends Error {
  constructor(
    message: string,
    /** A message key the UI renders; the English text is only a developer aid. */
    public readonly messageKey: string,
  ) {
    super(message);
    this.name = "WarehouseSetupError";
  }
}

export type WarehouseRow = {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  city: string | null;
  active: boolean;
  locations: LocationRow[];
};

export type LocationRow = {
  id: string;
  warehouseId: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  kind: string;
  canHoldStock: boolean;
  active: boolean;
  isDefaultReceiving: boolean;
  isDefaultIssue: boolean;
};

/** Location kinds a person may choose. Mirrors the table's own check constraint. */
export const LOCATION_KINDS = [
  "storage",
  "receiving",
  "dispatch",
  "quarantine",
  "damaged",
  "returns",
  "transit",
] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/**
 * Every warehouse with its locations.
 *
 * Bounded by design rather than paged: a warehouse is a physical building and an
 * organisation that has 200 of them has a different problem. The cap is stated
 * so a reader knows the list is complete rather than silently truncated, and it
 * is checked — a caller at the limit is told, not left guessing.
 */
export const WAREHOUSE_LIST_CAP = 200;

export async function listWarehouses(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<{ warehouses: WarehouseRow[]; truncated: boolean }> {
  assertCan(archetype, "inventory.view");
  const rows = await withCtx(
    ctx,
    async (tx) =>
      (await tx.execute(sql`
    select
      w.id::text as w_id, w.code as w_code, w.name_en as w_name_en, w.name_ar as w_name_ar,
      w.city as w_city, w.active as w_active,
      l.id::text as l_id, l.code as l_code, l.name_en as l_name_en, l.name_ar as l_name_ar,
      l.kind as l_kind, l.can_hold_stock as l_can_hold, l.active as l_active,
      l.is_default_receiving as l_recv, l.is_default_issue as l_issue
    from public.warehouse w
    left join public.stock_location l on l.warehouse_id = w.id and l.org_id = w.org_id
    where w.org_id = ${ctx.orgId}
    order by w.created_at, w.id, l.code
    limit ${WAREHOUSE_LIST_CAP * 50}
  `)) as unknown as Array<Record<string, unknown>>,
  );

  const byId = new Map<string, WarehouseRow>();
  for (const r of rows) {
    const id = r.w_id as string;
    let w = byId.get(id);
    if (!w) {
      w = {
        id,
        code: r.w_code as string,
        nameEn: r.w_name_en as string,
        nameAr: (r.w_name_ar as string | null) ?? null,
        city: (r.w_city as string | null) ?? null,
        active: r.w_active as boolean,
        locations: [],
      };
      byId.set(id, w);
    }
    if (r.l_id) {
      w.locations.push({
        id: r.l_id as string,
        warehouseId: id,
        code: r.l_code as string,
        nameEn: r.l_name_en as string,
        nameAr: (r.l_name_ar as string | null) ?? null,
        kind: r.l_kind as string,
        canHoldStock: r.l_can_hold as boolean,
        active: r.l_active as boolean,
        isDefaultReceiving: r.l_recv as boolean,
        isDefaultIssue: r.l_issue as boolean,
      });
    }
  }
  const warehouses = [...byId.values()];
  return {
    warehouses: warehouses.slice(0, WAREHOUSE_LIST_CAP),
    truncated: warehouses.length > WAREHOUSE_LIST_CAP,
  };
}

/**
 * Whether this organisation can receive goods into stock, and what is missing.
 *
 * This is the question the goods-receipt failure could not answer. `ok` is true
 * only when `receivingLocation()` in operations.ts would succeed: an active
 * location that can hold stock and is marked as the default receiving bin.
 */
export type ReceivingReadiness = {
  ok: boolean;
  warehouses: number;
  locations: number;
  /** Stockable items that cannot post because they carry no base unit. */
  itemsWithoutBaseUnit: number;
  /** A message key naming the first thing missing, or null when nothing is. */
  missingKey: string | null;
};

export async function receivingReadiness(ctx: Ctx): Promise<ReceivingReadiness> {
  const [row] = await withCtx(
    ctx,
    async (tx) =>
      (await tx.execute(sql`
    select
      (select count(*)::int from public.warehouse
        where org_id = ${ctx.orgId} and active) as warehouses,
      (select count(*)::int from public.stock_location
        where org_id = ${ctx.orgId} and active) as locations,
      (select count(*)::int from public.stock_location l
         join public.warehouse w on w.id = l.warehouse_id and w.org_id = l.org_id
        where l.org_id = ${ctx.orgId}
          and l.is_default_receiving and l.active and l.can_hold_stock) as receiving,
      (select count(*)::int from public.item
        where org_id = ${ctx.orgId}
          and item_type in ('inventory', 'asset', 'kit', 'manufactured')
          and base_unit_id is null) as no_base_unit
  `)) as unknown as Array<{
        warehouses: number;
        locations: number;
        receiving: number;
        no_base_unit: number;
      }>,
  );

  const warehouses = row?.warehouses ?? 0;
  const locations = row?.locations ?? 0;
  const receiving = row?.receiving ?? 0;
  const itemsWithoutBaseUnit = row?.no_base_unit ?? 0;

  /*
   * H30 LB-7 — the SECOND cause of PO-002, which docs/H22-BLOCKER-PO002.md did
   * not name.
   *
   * A warehouse is necessary and not sufficient. `resolveReceiptTarget` also
   * skips any line whose item has no `base_unit_id`, quietly, as "not an
   * inventory item". Production holds ZERO unit_of_measure rows and all 35 items
   * have a null base unit, so every goods receipt in the database would have
   * failed to post even with a perfectly configured warehouse — and the failure
   * would have looked like a shrug rather than a problem.
   *
   * Reported last, because a person should fix the warehouse first; but reported,
   * which is the whole point.
   */
  const missingKey =
    warehouses === 0
      ? "stock.setup.missing_warehouse"
      : locations === 0
        ? "stock.setup.missing_location"
        : receiving === 0
          ? "stock.setup.missing_receiving"
          : itemsWithoutBaseUnit > 0
            ? "stock.setup.missing_base_unit"
            : null;

  return { ok: missingKey === null, warehouses, locations, itemsWithoutBaseUnit, missingKey };
}

function cleanCode(raw: string, what: string): string {
  const code = raw.trim().toUpperCase();
  if (code.length < 1 || code.length > 24) {
    throw new WarehouseSetupError(`${what} code must be 1-24 characters`, "stock.setup.bad_code");
  }
  return code;
}

function cleanName(raw: string, what: string): string {
  const name = raw.trim();
  if (name.length < 1 || name.length > 120) {
    throw new WarehouseSetupError(`${what} name must be 1-120 characters`, "stock.setup.bad_name");
  }
  return name;
}

function optional(raw: string | null | undefined, max: number): string | null {
  const v = (raw ?? "").trim();
  if (v.length === 0) return null;
  return v.slice(0, max);
}

export type CreateWarehouseInput = {
  code: string;
  nameEn: string;
  nameAr?: string | null;
  city?: string | null;
  /**
   * Create a receiving bay and make it the default in one step.
   *
   * Default TRUE, deliberately. The whole defect was an organisation with a
   * warehouse and no receiving bin, and nobody sets out to create one. A person
   * creating their first warehouse wants to be able to receive goods into it;
   * making them perform a second, separate, easily-missed step to get there is
   * how PO-002 happened.
   */
  withReceivingBay?: boolean;
};

export async function createWarehouse(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: CreateWarehouseInput,
): Promise<{ warehouseId: string; locationId: string | null }> {
  assertCan(archetype, "inventory.adjust");
  const code = cleanCode(input.code, "warehouse");
  const nameEn = cleanName(input.nameEn, "warehouse");
  const nameAr = optional(input.nameAr, 120);
  const city = optional(input.city, 80);
  const withBay = input.withReceivingBay !== false;

  return command<{ warehouseId: string; locationId: string | null }>(
    ctx,
    {
      audit: (r) => ({
        action: "stock.warehouse_created",
        entityType: "warehouse" as const,
        entityId: r.warehouseId,
        summary: `Created warehouse ${code} (${nameEn})${r.locationId ? " with a receiving bay" : ""}`,
      }),
    },
    async (tx) => {
      const dup = (await tx.execute(sql`
        select 1 from public.warehouse where org_id = ${ctx.orgId} and code = ${code}
      `)) as unknown as unknown[];
      if (dup.length > 0) {
        throw new WarehouseSetupError(
          `a warehouse with code ${code} already exists`,
          "stock.setup.duplicate_code",
        );
      }

      const [w] = (await tx.execute(sql`
        insert into public.warehouse (org_id, code, name_en, name_ar, city, created_by)
        values (${ctx.orgId}, ${code}, ${nameEn}, ${nameAr}, ${city}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const warehouseId = w!.id;

      if (!withBay) return { warehouseId, locationId: null };

      const [l] = (await tx.execute(sql`
        insert into public.stock_location
          (org_id, warehouse_id, code, name_en, kind, can_hold_stock, is_default_receiving)
        values (${ctx.orgId}, ${warehouseId}, 'RECV', 'Receiving', 'receiving', true, true)
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { warehouseId, locationId: l!.id };
    },
  );
}

export type CreateLocationInput = {
  warehouseId: string;
  code: string;
  nameEn: string;
  nameAr?: string | null;
  kind: LocationKind;
  canHoldStock?: boolean;
};

export async function createLocation(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: CreateLocationInput,
): Promise<{ locationId: string }> {
  assertCan(archetype, "inventory.adjust");
  const code = cleanCode(input.code, "location");
  const nameEn = cleanName(input.nameEn, "location");
  const nameAr = optional(input.nameAr, 120);
  if (!LOCATION_KINDS.includes(input.kind)) {
    throw new WarehouseSetupError(`unknown location kind ${input.kind}`, "stock.setup.bad_kind");
  }
  const canHold = input.canHoldStock !== false;

  return command<{ locationId: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "stock.location_created",
        entityType: "stock_location" as const,
        entityId: r.locationId,
        summary: `Created stock location ${code} (${nameEn})`,
      }),
    },
    async (tx) => {
      const owned = (await tx.execute(sql`
        select 1 from public.warehouse
        where id = ${input.warehouseId} and org_id = ${ctx.orgId}
      `)) as unknown as unknown[];
      if (owned.length === 0) {
        throw new WarehouseSetupError("warehouse not found", "stock.setup.no_warehouse");
      }
      const dup = (await tx.execute(sql`
        select 1 from public.stock_location
        where warehouse_id = ${input.warehouseId} and code = ${code} and org_id = ${ctx.orgId}
      `)) as unknown as unknown[];
      if (dup.length > 0) {
        throw new WarehouseSetupError(
          `a location with code ${code} already exists in this warehouse`,
          "stock.setup.duplicate_code",
        );
      }
      const [l] = (await tx.execute(sql`
        insert into public.stock_location
          (org_id, warehouse_id, code, name_en, name_ar, kind, can_hold_stock)
        values (${ctx.orgId}, ${input.warehouseId}, ${code}, ${nameEn}, ${nameAr},
                ${input.kind}, ${canHold})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { locationId: l!.id };
    },
  );
}

/**
 * Make one location the warehouse's default receiving bin.
 *
 * The unique index allows at most one per warehouse among active,
 * stock-holding locations, so the previous default is cleared in the same
 * transaction rather than relying on the caller to remember.
 */
export async function setDefaultReceiving(
  ctx: Ctx,
  archetype: RoleArchetype,
  locationId: string,
): Promise<void> {
  assertCan(archetype, "inventory.adjust");
  await command<void>(
    ctx,
    {
      audit: () => ({
        action: "stock.default_receiving_set",
        entityType: "stock_location" as const,
        entityId: locationId,
        summary: "Set the default receiving location",
      }),
    },
    async (tx) => {
      const [loc] = (await tx.execute(sql`
        select warehouse_id::text as warehouse_id, can_hold_stock, active
        from public.stock_location
        where id = ${locationId} and org_id = ${ctx.orgId}
      `)) as unknown as Array<{ warehouse_id: string; can_hold_stock: boolean; active: boolean }>;
      if (!loc) throw new WarehouseSetupError("location not found", "stock.setup.no_location");
      if (!loc.can_hold_stock || !loc.active) {
        throw new WarehouseSetupError(
          "a location that cannot hold stock cannot be the receiving default",
          "stock.setup.cannot_hold",
        );
      }
      await tx.execute(sql`
        update public.stock_location
        set is_default_receiving = false, updated_at = now()
        where org_id = ${ctx.orgId} and warehouse_id = ${loc.warehouse_id}
          and is_default_receiving and id <> ${locationId}
      `);
      await tx.execute(sql`
        update public.stock_location
        set is_default_receiving = true, updated_at = now()
        where id = ${locationId} and org_id = ${ctx.orgId}
      `);
    },
  );
}

/**
 * Goods receipts that were RECORDED but never reached the stock ledger.
 *
 * This is the question the old failure banner could not ask. It told the user to
 * "receive again", which creates a NEW receipt — a different document, with
 * different line ids, and therefore different idempotency keys. Posting is
 * idempotent per receipt LINE, so "receive again" does not replay the failed
 * posting; it books a second delivery that never happened, or (as at Najolatech)
 * fails identically and leaves two unposted receipts instead of one.
 *
 * A line counts as posted when a stock movement carries its derived key
 * `grl:<lineId>:<disposition>`. Lines that can never post — a service, a
 * consumable, a line with no inventory item — are excluded, so a receipt made
 * entirely of them is not reported as a problem forever.
 */
export type UnpostedReceipt = {
  receiptId: string;
  reference: string;
  receivedDate: string;
  poId: string;
  poReference: string;
  stockableLines: number;
  postedLines: number;
  /** Lines that cannot post at all until their item is given a base unit. */
  blockedLines: number;
};

export async function unpostedReceipts(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { poId?: string; limit?: number } = {},
): Promise<UnpostedReceipt[]> {
  assertCan(archetype, "inventory.view");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const poFilter = opts.poId ?? null;
  return await withCtx(
    ctx,
    async (tx) =>
      (await tx.execute(sql`
    with stockable as (
      /*
       * A receipt line names no item of its own; it points at the purchase
       * order line, which is where the catalogue item lives.
       *
       * H30 LB-7: a null base_unit_id is deliberately NOT excluded here, though
       * the poster requires one. A line whose item has no base unit can never
       * post, and excluding it made the one case this diagnostic exists for --
       * PO-002 -- invisible to it. A thing that cannot happen is exactly what
       * the person needs to be told, so blockedLines counts them separately and
       * the remedy can say which problem it is.
       */
      select grl.id, grl.grn_id, (i.base_unit_id is null) as no_base_unit
      from public.goods_receipt_line grl
      join public.purchase_order_line pol
        on pol.id = grl.po_line_id and pol.org_id = grl.org_id
      join public.item i on i.id = pol.item_id and i.org_id = pol.org_id
      where grl.org_id = ${ctx.orgId}
        and i.item_type in ('inventory', 'asset', 'kit', 'manufactured')
    ),
    posted as (
      select s.id
      from stockable s
      where exists (
        select 1 from public.stock_movement sm
        where sm.org_id = ${ctx.orgId}
          and sm.idempotency_key like 'grl:' || s.id::text || ':%'
      )
    )
    select
      gr.id::text as "receiptId",
      gr.reference as "reference",
      to_char(gr.received_date, 'YYYY-MM-DD') as "receivedDate",
      gr.po_id::text as "poId",
      po.reference as "poReference",
      count(s.id)::int as "stockableLines",
      count(p.id)::int as "postedLines",
      count(*) filter (where s.no_base_unit)::int as "blockedLines"
    from public.goods_receipt gr
    join public.purchase_order po on po.id = gr.po_id and po.org_id = gr.org_id
    join stockable s on s.grn_id = gr.id
    left join posted p on p.id = s.id
    where gr.org_id = ${ctx.orgId}
      and gr.status <> 'cancelled'
      and (${poFilter}::uuid is null or gr.po_id = ${poFilter}::uuid)
    group by gr.id, gr.reference, gr.received_date, gr.po_id, po.reference
    having count(p.id) < count(s.id)
    order by gr.received_date desc, gr.created_at desc
    limit ${limit}
  `)) as unknown as UnpostedReceipt[],
  );
}

/**
 * H30 LB-7 — create a unit of measure, and optionally adopt it as the base unit
 * for every stock item that has none.
 *
 * The second half is the part that matters. A unit nobody attaches to an item
 * changes nothing: `resolveReceiptTarget` reads the ITEM's `base_unit_id`, and
 * production has 35 items with a null one and no units at all. Creating a unit
 * and then asking a person to open 35 item records one at a time is a remedy in
 * name only.
 *
 * `adoptAsBaseUnit` therefore fills the gap in one statement — and only the gap:
 * it touches solely items that are stockable by type AND currently have no base
 * unit, so it can never overwrite a unit somebody chose.
 */
export async function createUnit(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: {
    code: string;
    nameEn: string;
    nameAr?: string | null;
    adoptAsBaseUnit?: boolean;
  },
): Promise<{ unitId: string; itemsUpdated: number }> {
  assertCan(archetype, "inventory.adjust");
  /*
   * A unit's own limits, not a warehouse's: `unit_of_measure.code` is capped at
   * 16 characters and `name_ar` is NOT NULL. Both were found by the integration
   * test rather than by reading — an English-only user would have met a raw
   * constraint violation on a form that asked for the Arabic name optionally.
   *
   * A blank Arabic name falls back to the English one rather than refusing.
   * "EA" is the same word in both languages more often than not, and an
   * organisation that cares can rename it; a hard requirement here would block
   * the remedy on a translation nobody has.
   */
  const code = cleanCode(input.code, "unit").slice(0, 16);
  if (code.length === 0) {
    throw new WarehouseSetupError("unit code must not be empty", "stock.setup.bad_code");
  }
  const nameEn = cleanName(input.nameEn, "unit").slice(0, 60);
  const nameAr = (optional(input.nameAr, 60) ?? nameEn).slice(0, 60);

  return command<{ unitId: string; itemsUpdated: number }>(
    ctx,
    {
      audit: (r) => ({
        action: "stock.unit_created",
        entityType: "unit_of_measure" as const,
        entityId: r.unitId,
        summary:
          `Created unit ${code} (${nameEn})` +
          (r.itemsUpdated > 0 ? `, adopted as the base unit for ${r.itemsUpdated} item(s)` : ""),
      }),
    },
    async (tx) => {
      const dup = (await tx.execute(sql`
        select 1 from public.unit_of_measure where org_id = ${ctx.orgId} and code = ${code}
      `)) as unknown as unknown[];
      if (dup.length > 0) {
        throw new WarehouseSetupError(
          `a unit with code ${code} already exists`,
          "stock.setup.duplicate_unit",
        );
      }
      /*
       * Exactly one base unit per dimension per organisation, enforced by a
       * partial unique index, so "convert to base" is never ambiguous. The
       * FIRST count unit becomes the base; a later one is an ordinary unit at
       * the same scale. Found by the integration test — inserting every unit as
       * a base worked once and then violated the index for ever after.
       */
      const existingBase = (await tx.execute(sql`
        select 1 from public.unit_of_measure
        where org_id = ${ctx.orgId} and dimension = 'count' and is_base and active
      `)) as unknown as unknown[];
      const isBase = existingBase.length === 0;

      const [u] = (await tx.execute(sql`
        insert into public.unit_of_measure
          (org_id, code, name_en, name_ar, dimension, factor_to_base, is_base)
        values (${ctx.orgId}, ${code}, ${nameEn}, ${nameAr}, 'count', 1, ${isBase})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const unitId = u!.id;

      if (input.adoptAsBaseUnit === false) return { unitId, itemsUpdated: 0 };

      const updated = (await tx.execute(sql`
        update public.item
        set base_unit_id = ${unitId}, updated_at = now()
        where org_id = ${ctx.orgId}
          and item_type in ('inventory', 'asset', 'kit', 'manufactured')
          and base_unit_id is null
        returning id
      `)) as unknown as unknown[];
      return { unitId, itemsUpdated: updated.length };
    },
  );
}

/** Rename a warehouse. Create-only setup is a trap: a typo would be permanent. */
export async function renameWarehouse(
  ctx: Ctx,
  archetype: RoleArchetype,
  warehouseId: string,
  input: { nameEn: string; nameAr?: string | null; city?: string | null },
): Promise<void> {
  assertCan(archetype, "inventory.adjust");
  const nameEn = cleanName(input.nameEn, "warehouse");
  const nameAr = optional(input.nameAr, 120);
  const city = optional(input.city, 80);
  await command<void>(
    ctx,
    {
      audit: () => ({
        action: "stock.warehouse_renamed",
        entityType: "warehouse" as const,
        entityId: warehouseId,
        summary: `Renamed warehouse to ${nameEn}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.warehouse
        set name_en = ${nameEn}, name_ar = ${nameAr}, city = ${city}, updated_at = now()
        where id = ${warehouseId} and org_id = ${ctx.orgId}
        returning id
      `)) as unknown as unknown[];
      if (rows.length === 0) {
        throw new WarehouseSetupError("warehouse not found", "stock.setup.no_warehouse");
      }
    },
  );
}
