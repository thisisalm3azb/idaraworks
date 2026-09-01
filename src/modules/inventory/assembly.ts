/**
 * Bills of material, and the act of making or unmaking something (H22D).
 *
 * Two rules shape everything here.
 *
 * A RECIPE IS VERSIONED, NEVER EDITED. Everything ever built from a bill of
 * material references it, so changing one in place restates history. Activating
 * a new version archives the old one, and an assembly order copies its
 * components at creation so a revision mid-build cannot change what was
 * actually consumed.
 *
 * THE PARENT COSTS WHAT WENT INTO IT. An assembled item is valued at the cost of
 * the components the ledger actually drew — not a standard, not a price list.
 * Conversion costs (labour, machine time, overhead) are NOT included, because
 * this system does not record them; IAS 2.12 would add them if it did, and
 * calling the result "cost of conversion" while omitting the conversion would be
 * the kind of quiet overstatement that turns into a restatement later.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import { command } from "@/platform/audit";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import type { RoleArchetype } from "@/platform/registries";
import { postMovementIn, StockMovementConflictError } from "./ledger";
import { allocateAndIssueIn } from "./allocate";

export class BomError extends Error {
  constructor(why: string) {
    super(why);
    this.name = "BomError";
  }
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** How an item's movements must identify what they move. */
async function itemTracking(
  tx: TenantTx,
  ctx: Ctx,
  itemId: string,
): Promise<"none" | "lot" | "serial"> {
  const rows = (await tx.execute(sql`
    select tracking from public.item where id = ${itemId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ tracking: string }>;
  const t = rows[0]?.tracking;
  return t === "lot" || t === "serial" ? t : "none";
}

/**
 * Open a batch, or find the one already open under that code.
 *
 * Assembly MINTS identity where a receipt merely records it: the thing being
 * created did not exist until now, so nothing external can tell us its batch
 * number.
 */
async function openLot(
  tx: TenantTx,
  ctx: Ctx,
  itemId: string,
  code: string,
  dates: { manufacturedOn?: string | null; expiryDate?: string | null } = {},
): Promise<string> {
  await tx.execute(sql`
    insert into public.stock_lot
      (org_id, item_id, code, manufactured_on, expiry_date, created_by)
    values (${ctx.orgId}, ${itemId}, ${code}, ${dates.manufacturedOn ?? null}::date,
            ${dates.expiryDate ?? null}::date, ${ctx.userId})
    on conflict (org_id, item_id, code) do nothing
  `);
  const found = (await tx.execute(sql`
    select id::text as id, status, expiry_date::text as expiry_date
    from public.stock_lot
    where org_id = ${ctx.orgId} and item_id = ${itemId} and code = ${code}
    for update
  `)) as unknown as Array<{ id: string; status: string; expiry_date: string | null }>;
  if (!found[0]) throw new BomError(`could not open batch ${code}`);
  const lot = found[0];

  /*
   * A batch somebody took a DECISION about is not a place to put new production.
   *
   * Reusing a recalled or quarantined code would tag today's output as recalled
   * goods, and reusing an expired one produces stock that is born unissuable —
   * in both cases silently, because the ledger only ever checks quantities.
   * 'depleted' is different: that is a batch that simply ran out, and more of it
   * arriving is the ordinary case.
   */
  if (lot.status !== "active" && lot.status !== "depleted") {
    throw new BomError(
      `batch ${code} is ${lot.status}; new production cannot be added to it until that is reversed`,
    );
  }
  if (dates.expiryDate && lot.expiry_date && dates.expiryDate !== lot.expiry_date) {
    throw new BomError(
      `batch ${code} already expires ${lot.expiry_date}, but this order says ${dates.expiryDate}`,
    );
  }
  await tx.execute(sql`
    update public.stock_lot
    set status = case when status = 'depleted' then 'active' else status end,
        -- An existing batch missing a date takes the one this order states.
        expiry_date = coalesce(expiry_date, ${dates.expiryDate ?? null}::date),
        manufactured_on = coalesce(manufactured_on, ${dates.manufacturedOn ?? null}::date),
        updated_at = now()
    where id = ${lot.id} and org_id = ${ctx.orgId}
  `);
  return lot.id;
}

/** Register newly made units. A unit that already exists in stock is refused. */
async function openSerials(
  tx: TenantTx,
  ctx: Ctx,
  itemId: string,
  serialNos: readonly string[],
  at: { warehouseId: string; locationId: string },
  lotId: string | null,
): Promise<string[]> {
  const ids: string[] = [];
  for (const serialNo of serialNos) {
    const existing = (await tx.execute(sql`
      select id::text as id, status from public.stock_serial
      where org_id = ${ctx.orgId} and item_id = ${itemId} and serial_no = ${serialNo}
      for update
    `)) as unknown as Array<{ id: string; status: string }>;
    if (existing[0]) {
      if (existing[0].status === "in_stock" || existing[0].status === "reserved") {
        throw new BomError(`unit ${serialNo} is already in stock, so it cannot be made again`);
      }
      ids.push(existing[0].id);
      continue;
    }
    const created = (await tx.execute(sql`
      insert into public.stock_serial
        (org_id, item_id, serial_no, lot_id, status, warehouse_id, location_id, created_by)
      values (${ctx.orgId}, ${itemId}, ${serialNo}, ${lotId}, 'in_stock',
              ${at.warehouseId}, ${at.locationId}, ${ctx.userId})
      returning id::text as id
    `)) as unknown as Array<{ id: string }>;
    ids.push(created[0]!.id);
  }
  return ids;
}

// ── Bills of material ───────────────────────────────────────────────────────
const BomLineInput = z.object({
  componentItemId: z.string().uuid(),
  qtyPer: z.number().positive().max(1_000_000_000),
  unitId: z.string().uuid(),
  scrapPct: z.number().min(0).max(99.999).optional().default(0),
});
export const CreateBomInput = z.object({
  itemId: z.string().uuid(),
  outputQty: z.number().positive().max(1_000_000_000).optional().default(1),
  unitId: z.string().uuid(),
  notes: z.string().trim().max(2000).optional(),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  lines: z.array(BomLineInput).min(1).max(200),
});

/**
 * Write a new recipe, as a draft.
 *
 * The version number is the next one for this item, so two people drafting at
 * once get two versions rather than one overwriting the other.
 */
export async function createBom(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string; version: number }> {
  assertCan(archetype, "inventory.adjust");
  const data = CreateBomInput.parse(input);
  const id = randomUUID();

  return command<{ id: string; version: number }>(
    ctx,
    {
      audit: (r) => ({
        action: "inventory.bom_created",
        entityType: "item" as const,
        entityId: data.itemId,
        summary: `Drafted bill of material v${r.version} with ${data.lines.length} component(s)`,
      }),
    },
    async (tx) => {
      const components = new Set(data.lines.map((l) => l.componentItemId));
      if (components.size !== data.lines.length) {
        throw new BomError("the same component appears twice");
      }
      if (components.has(data.itemId)) {
        throw new BomError("an item cannot be a component of itself");
      }
      // A component that needs the parent, at any depth, is a recipe that can
      // never be built. Walked here because the depth is unbounded.
      for (const component of components) {
        if (await needsItem(tx, ctx, component, data.itemId, 0)) {
          throw new BomError(
            "that component is itself built from this item, which cannot be resolved",
          );
        }
      }

      const next = (await tx.execute(sql`
        select coalesce(max(version), 0) + 1 as version from public.bom
        where org_id = ${ctx.orgId} and item_id = ${data.itemId}
      `)) as unknown as Array<{ version: number }>;
      const version = Number(next[0]!.version);

      await tx.execute(sql`
        insert into public.bom
          (id, org_id, item_id, version, status, output_qty, unit_id, notes, effective_from,
           created_by)
        values (${id}, ${ctx.orgId}, ${data.itemId}, ${version}, 'draft', ${data.outputQty},
                ${data.unitId}, ${data.notes ?? null}, ${data.effectiveFrom ?? null}::date,
                ${ctx.userId})
      `);
      for (const [i, l] of data.lines.entries()) {
        await tx.execute(sql`
          insert into public.bom_line
            (org_id, bom_id, component_item_id, qty_per, unit_id, scrap_pct, sort)
          values (${ctx.orgId}, ${id}, ${l.componentItemId}, ${l.qtyPer}, ${l.unitId},
                  ${l.scrapPct}, ${i})
        `);
      }
      return { id, version };
    },
  );
}

/** Does `itemId` require `needle`, at any depth, through active recipes? */
async function needsItem(
  tx: TenantTx,
  ctx: Ctx,
  itemId: string,
  needle: string,
  depth: number,
): Promise<boolean> {
  // A recipe nested twenty deep is a data problem, not a manufacturing one, and
  // stopping is better than recursing forever on a cycle that predates this check.
  if (depth > 20) return false;
  const rows = (await tx.execute(sql`
    select bl.component_item_id::text as id
    from public.bom b
    join public.bom_line bl on bl.bom_id = b.id and bl.org_id = b.org_id
    where b.org_id = ${ctx.orgId} and b.item_id = ${itemId} and b.status = 'active'
    limit 200
  `)) as unknown as Array<{ id: string }>;
  for (const row of rows) {
    if (row.id === needle) return true;
    if (await needsItem(tx, ctx, row.id, needle, depth + 1)) return true;
  }
  return false;
}

/**
 * Put a recipe in force, retiring the one it replaces.
 *
 * Both halves in one statement each, and one transaction: there is never a
 * moment with two active recipes for an item, nor one with none because the
 * archive succeeded and the activation did not.
 */
export async function activateBom(
  ctx: Ctx,
  archetype: RoleArchetype,
  bomId: string,
): Promise<{ id: string; replaced: string | null }> {
  assertCan(archetype, "inventory.adjust");

  return command<{ id: string; replaced: string | null }>(
    ctx,
    {
      audit: (r) => ({
        action: "inventory.bom_activated",
        entityType: "item" as const,
        entityId: bomId,
        summary: r.replaced
          ? `Activated a bill of material, archiving the previous one`
          : `Activated a bill of material`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select item_id::text as item_id, status from public.bom
        where id = ${bomId} and org_id = ${ctx.orgId} for update
      `)) as unknown as Array<{ item_id: string; status: string }>;
      const bom = rows[0];
      if (!bom) throw new BomError("no such bill of material");
      if (bom.status === "archived") throw new BomError("an archived recipe cannot be reactivated");
      if (bom.status === "active") return { id: bomId, replaced: null };

      const lines = (await tx.execute(sql`
        select component_item_id::text as id from public.bom_line
        where bom_id = ${bomId} and org_id = ${ctx.orgId}
        limit 200
      `)) as unknown as Array<{ id: string }>;
      if (lines.length === 0) {
        throw new BomError("a recipe with no components cannot be activated");
      }

      /*
       * The cycle check belongs HERE, not only at drafting.
       *
       * Drafting checks against the recipes in force at the time, which is the
       * right thing to tell someone early — but two drafts can each be innocent
       * on their own and form a cycle the moment both are activated. Activation
       * is where a recipe starts being resolvable, so activation is where it has
       * to be resolvable.
       */
      for (const line of lines) {
        if (line.id === bom.item_id) throw new BomError("an item cannot be a component of itself");
        if (await needsItem(tx, ctx, line.id, bom.item_id, 0)) {
          throw new BomError(
            "activating this would make an item depend on itself through its components",
          );
        }
      }

      const replaced = (await tx.execute(sql`
        update public.bom set status = 'archived', archived_at = now(), updated_at = now()
        where org_id = ${ctx.orgId} and item_id = ${bom.item_id} and status = 'active'
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      await tx.execute(sql`
        update public.bom set status = 'active', updated_at = now()
        where id = ${bomId} and org_id = ${ctx.orgId}
      `);
      return { id: bomId, replaced: replaced[0]?.id ?? null };
    },
  );
}

// ── Assembly and disassembly ────────────────────────────────────────────────
export const CreateAssemblyInput = z.object({
  itemId: z.string().uuid(),
  qty: z.number().positive().max(1_000_000_000),
  warehouseId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  direction: z.enum(["assemble", "disassemble"]).optional().default("assemble"),
  notes: z.string().trim().max(2000).optional(),
  /**
   * What the output will be called, for a tracked item.
   *
   * A batch made today is a new batch and its units get new serial numbers;
   * neither can be derived, so both are stated when the build is PLANNED. Asked
   * for up front rather than at completion, because discovering the gap halfway
   * through would leave the components consumed and the product unrecordable.
   */
  outputLotCode: z.string().trim().min(1).max(64).optional(),
  outputManufacturedOn: DATE.optional(),
  outputExpiryDate: DATE.optional(),
  outputSerialNos: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
  /** For a disassembly: the batch each recovered component goes into. */
  componentLotCodes: z.record(z.string().uuid(), z.string().trim().min(1).max(64)).optional(),
  componentSerialNos: z
    .record(z.string().uuid(), z.array(z.string().trim().min(1).max(64)).max(500))
    .optional(),
});

/**
 * Plan one build, freezing the recipe into it.
 *
 * The component quantities are computed once, here, from the active recipe:
 * qty_per scaled by how many the order makes, plus the expected scrap. Copying
 * them onto the order is what makes a later revision of the recipe harmless.
 */
export async function createAssemblyOrder(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string; reference: string; lines: number }> {
  assertCan(archetype, "inventory.adjust");
  const data = CreateAssemblyInput.parse(input);
  const id = randomUUID();

  return command<{ id: string; reference: string; lines: number }>(
    ctx,
    {
      audit: (r) => ({
        action: `inventory.${data.direction}_planned`,
        entityType: "stock_movement" as const,
        entityId: id,
        summary: `${data.direction === "assemble" ? "Assembly" : "Disassembly"} ${r.reference}: ${data.qty} from ${r.lines} component(s)`,
      }),
    },
    async (tx) => {
      const bomRows = (await tx.execute(sql`
        select id::text as id, output_qty::text as output_qty, unit_id::text as unit_id
        from public.bom
        where org_id = ${ctx.orgId} and item_id = ${data.itemId} and status = 'active'
      `)) as unknown as Array<{ id: string; output_qty: string; unit_id: string }>;
      const bom = bomRows[0];
      if (!bom) throw new BomError("this item has no active bill of material");

      const lines = (await tx.execute(sql`
        select component_item_id::text as item_id, qty_per::text as qty_per,
               unit_id::text as unit_id, scrap_pct::text as scrap_pct, sort
        from public.bom_line
        where bom_id = ${bom.id} and org_id = ${ctx.orgId}
        order by sort, component_item_id
        limit 200
      `)) as unknown as Array<Record<string, string | number>>;
      if (lines.length === 0) throw new BomError("the active recipe has no components");

      /*
       * Whatever this order will PRODUCE has to be identifiable before it starts.
       *
       * Assembling makes the parent; disassembling makes the components. Either
       * way, if the thing produced is tracked, somebody has to say what it will
       * be called — and they have to say it now, while this is still a plan. A
       * build that discovers the gap at completion has already consumed its
       * inputs and cannot record its output.
       */
      const produced =
        data.direction === "assemble"
          ? [{ itemId: data.itemId, qty: data.qty, lineIndex: null as number | null }]
          : lines.map((l, i) => ({
              itemId: String(l.item_id),
              qty: Number(l.qty_per) * (data.qty / Number(bom.output_qty)),
              lineIndex: i,
            }));

      for (const p of produced) {
        const tracking = await itemTracking(tx, ctx, p.itemId);
        if (tracking === "none") continue;
        if (tracking === "lot") {
          const code =
            p.lineIndex === null
              ? data.outputLotCode
              : (data.componentLotCodes?.[p.itemId] ?? data.outputLotCode);
          if (!code) {
            throw new BomError(
              p.lineIndex === null
                ? "this item is batch-tracked: say which batch the build will produce"
                : "a recovered component is batch-tracked: say which batch it goes into",
            );
          }
        } else {
          const serials =
            p.lineIndex === null
              ? (data.outputSerialNos ?? [])
              : (data.componentSerialNos?.[p.itemId] ?? []);
          /*
           * Whole units FIRST, then the count.
           *
           * Comparing against a ROUNDED quantity let 0.4 units through against
           * an empty serial list — both round to zero — so an order producing a
           * fraction of a serialised thing was accepted naming nothing, and the
           * check that was supposed to stop it never ran.
           */
          if (!Number.isInteger(p.qty)) {
            throw new BomError(
              `this item is serialised, so it is made in whole units, not ${p.qty}`,
            );
          }
          if (serials.length !== p.qty) {
            throw new BomError(
              `this item is serialised: name ${p.qty} unit number(s), not ${serials.length}`,
            );
          }
        }
      }

      const seq = await allocateReference(tx, ctx, "assembly_order", 1);
      const reference = formatRef(data.direction === "assemble" ? "ASM" : "DIS", seq);
      const batches = data.qty / Number(bom.output_qty);

      await tx.execute(sql`
        insert into public.assembly_order
          (id, org_id, reference, direction, item_id, bom_id, qty, unit_id, warehouse_id,
           location_id, notes, created_by, output_lot_code, output_manufactured_on,
           output_expiry_date)
        values (${id}, ${ctx.orgId}, ${reference}, ${data.direction}, ${data.itemId}, ${bom.id},
                ${data.qty}, ${bom.unit_id}, ${data.warehouseId}, ${data.locationId ?? null},
                ${data.notes ?? null}, ${ctx.userId}, ${data.outputLotCode ?? null},
                ${data.outputManufacturedOn ?? null}::date, ${data.outputExpiryDate ?? null}::date)
      `);
      for (const s of data.outputSerialNos ?? []) {
        await tx.execute(sql`
          insert into public.assembly_order_serial (org_id, order_id, order_line_id, serial_no)
          values (${ctx.orgId}, ${id}, null, ${s})
        `);
      }
      for (const [i, l] of lines.entries()) {
        /*
         * Scrap is what the process is expected to lose, so ASSEMBLING issues it
         * on top of what ends up in the product. DISASSEMBLING recovers what is
         * physically inside the thing — adding a scrap allowance there would
         * create material out of nothing, which is exactly what taking something
         * apart cannot do.
         */
        const net = Number(l.qty_per) * batches;
        const qty = data.direction === "assemble" ? net * (1 + Number(l.scrap_pct) / 100) : net;
        const lineId = randomUUID();
        await tx.execute(sql`
          insert into public.assembly_order_line
            (id, org_id, order_id, component_item_id, qty, unit_id, sort, output_lot_code)
          values (${lineId}, ${ctx.orgId}, ${id}, ${l.item_id}, ${qty}, ${l.unit_id}, ${i},
                  ${data.componentLotCodes?.[String(l.item_id)] ?? null})
        `);
        for (const s of data.componentSerialNos?.[String(l.item_id)] ?? []) {
          await tx.execute(sql`
            insert into public.assembly_order_serial (org_id, order_id, order_line_id, serial_no)
            values (${ctx.orgId}, ${id}, ${lineId}, ${s})
          `);
        }
      }
      return { id, reference, lines: lines.length };
    },
  );
}

export type AssemblyResult = {
  orderId: string;
  direction: "assemble" | "disassemble";
  consumedCostMinor: number | null;
  producedQty: number;
  movements: number;
};

/**
 * Do it: consume one side, produce the other.
 *
 * The status guard is the whole duplicate protection, in one statement — only a
 * draft can complete, and completing moves it out of draft in the same update
 * that claims it, so a second call finds nothing to do rather than building
 * twice.
 *
 * Assembling and disassembling are the same act in opposite directions, so they
 * share the code. The two sides are NOT symmetrical, though, and pretending they
 * were is what makes tracked items unbuildable:
 *
 *   - the side that is CONSUMED goes through ordinary allocation, which finds
 *     the batches and units to take and honours expiry, recall and location
 *     eligibility exactly as a job issue does
 *   - the side that is PRODUCED did not exist until now, so nothing can be
 *     looked up. Its identity is MINTED from what the order said it would make,
 *     which is why a tracked output has to be named while the build is still a
 *     plan.
 */
export async function completeAssembly(
  ctx: Ctx,
  archetype: RoleArchetype,
  orderId: string,
): Promise<AssemblyResult> {
  assertCan(archetype, "inventory.adjust");

  return command<AssemblyResult>(
    ctx,
    {
      audit: (r) => ({
        action: `inventory.${r.direction}_completed`,
        entityType: "stock_movement" as const,
        entityId: orderId,
        summary: `${r.direction === "assemble" ? "Assembled" : "Disassembled"} ${r.producedQty} across ${r.movements} movement(s)`,
      }),
    },
    async (tx) => {
      const claimed = (await tx.execute(sql`
        update public.assembly_order
        set status = 'completed', completed_at = now(), completed_by = ${ctx.userId},
            updated_at = now()
        where id = ${orderId} and org_id = ${ctx.orgId} and status = 'draft'
        returning direction, reference, item_id::text as item_id, qty::text as qty,
                  unit_id::text as unit_id, warehouse_id::text as warehouse_id,
                  location_id::text as location_id, output_lot_code,
                  output_manufactured_on::text as output_manufactured_on,
                  output_expiry_date::text as output_expiry_date
      `)) as unknown as Array<Record<string, string | null>>;
      const order = claimed[0];
      if (!order) throw new StockMovementConflictError("no draft assembly order with that id");
      const direction = order.direction as "assemble" | "disassemble";
      const qty = Number(order.qty);

      const lines = (await tx.execute(sql`
        select id::text as id, component_item_id::text as item_id, qty::text as qty,
               unit_id::text as unit_id, output_lot_code
        from public.assembly_order_line
        where order_id = ${orderId} and org_id = ${ctx.orgId}
        order by sort, component_item_id
        limit 200
      `)) as unknown as Array<Record<string, string | null>>;
      if (lines.length === 0) throw new BomError("the order has no components");

      /** The unit numbers this order said it would produce, by line (null = parent). */
      const plannedSerials = (await tx.execute(sql`
        select order_line_id::text as order_line_id, serial_no
        from public.assembly_order_serial
        where order_id = ${orderId} and org_id = ${ctx.orgId}
        order by sort, serial_no
        limit 1000
      `)) as unknown as Array<{ order_line_id: string | null; serial_no: string }>;
      const serialsFor = (lineId: string | null) =>
        plannedSerials.filter((s) => s.order_line_id === lineId).map((s) => s.serial_no);

      const target = order.location_id
        ? { warehouseId: order.warehouse_id!, locationId: order.location_id }
        : await defaultBuildLocation(tx, ctx, order.warehouse_id!);

      let movements = 0;
      let consumed = 0;
      let anyCosted = false;

      if (direction === "assemble") {
        // Components out, through ordinary allocation, so every rule about
        // expiry, quarantine and batch selection applies to a build exactly as
        // it applies to a job.
        for (const line of lines) {
          const { legs, movements: posted } = await allocateAndIssueIn(tx, ctx, {
            itemId: line.item_id!,
            unitId: line.unit_id!,
            qty: Number(line.qty),
            movementType: "assembly_consume",
            warehouseId: order.warehouse_id,
            sourceType: "assembly_order_line",
            sourceId: line.id!,
            idempotencyKey: `asm:${line.id}`,
          });
          movements += legs.length;
          for (const m of posted) {
            if (m.layerValueMinor !== null) {
              consumed += m.layerValueMinor;
              anyCosted = true;
            }
          }
        }

        /*
         * The parent arrives valued at EXACTLY what went into it.
         *
         * Passing the total rather than a per-unit cost is what keeps the value
         * whole: 2100 across 4 units is 525 each, but 2100 across 3 is not
         * three 700s, and re-deriving the total from a rounded unit cost is how
         * a few fils per build turn into a stock valuation nobody can tie out.
         */
        const output = await mintOutputIdentity(tx, ctx, {
          itemId: order.item_id!,
          qty,
          lotCode: order.output_lot_code ?? null,
          manufacturedOn: order.output_manufactured_on ?? null,
          expiryDate: order.output_expiry_date ?? null,
          serialNos: serialsFor(null),
          at: target,
          what: "the item being built",
        });
        await postMovementIn(tx, ctx, {
          itemId: order.item_id!,
          warehouseId: target.warehouseId,
          locationId: target.locationId,
          movementType: "assembly_produce",
          qtyDelta: qty,
          unitId: order.unit_id!,
          inboundValueMinor: anyCosted ? consumed : null,
          unitCostMinor: anyCosted ? Math.round(consumed / qty) : null,
          currency: await baseCurrency(tx, ctx),
          exchangeRate: 1,
          lots: output.lots,
          serialIds: output.serialIds,
          sourceType: "assembly_order",
          sourceId: orderId,
          idempotencyKey: `asm:${orderId}:produce`,
        });
        movements += 1;
        return {
          orderId,
          direction,
          consumedCostMinor: anyCosted ? consumed : null,
          producedQty: qty,
          movements,
        };
      }

      // Disassembly: the parent goes, the components come back.
      const { movements: outMovements, legs } = await allocateAndIssueIn(tx, ctx, {
        itemId: order.item_id!,
        unitId: order.unit_id!,
        qty,
        movementType: "disassembly_consume",
        warehouseId: order.warehouse_id,
        sourceType: "assembly_order",
        sourceId: orderId,
        idempotencyKey: `dis:${orderId}:consume`,
      });
      movements += legs.length;
      for (const m of outMovements) {
        if (m.layerValueMinor !== null) {
          consumed += m.layerValueMinor;
          anyCosted = true;
        }
      }

      /*
       * Where the parent's cost goes.
       *
       * Taking apart a thing does not create or destroy value, so the cost that
       * left the parent is spread across what came out of it, in proportion to
       * quantity. Proportion by quantity rather than by each component's own
       * market cost is a deliberate choice: the alternative needs a price for
       * every component, and where one is missing the shortfall silently
       * disappears into the ones that have prices.
       */
      const totalQty = lines.reduce((s, l) => s + Number(l.qty), 0);
      const currency = await baseCurrency(tx, ctx);
      let valueLeft = consumed;
      for (const [i, line] of lines.entries()) {
        // The last component takes the remainder, so the shares add back to what
        // the parent was worth instead of leaving a few minor units nowhere.
        const share = !anyCosted
          ? null
          : i === lines.length - 1
            ? valueLeft
            : Math.min(valueLeft, Math.round((consumed * Number(line.qty)) / totalQty));
        if (share !== null) valueLeft -= share;

        const output = await mintOutputIdentity(tx, ctx, {
          itemId: line.item_id!,
          qty: Number(line.qty),
          // A part recovered from a teardown is not the batch it was built from:
          // its history now includes having been inside something else.
          lotCode: line.output_lot_code ?? `${order.reference}-REC`,
          manufacturedOn: null,
          expiryDate: null,
          serialNos: serialsFor(line.id!),
          at: target,
          what: "a recovered component",
        });
        await postMovementIn(tx, ctx, {
          itemId: line.item_id!,
          warehouseId: target.warehouseId,
          locationId: target.locationId,
          movementType: "disassembly_produce",
          qtyDelta: Number(line.qty),
          unitId: line.unit_id!,
          inboundValueMinor: share,
          unitCostMinor: share === null ? null : Math.round(share / Number(line.qty)),
          currency,
          exchangeRate: 1,
          lots: output.lots,
          serialIds: output.serialIds,
          sourceType: "assembly_order_line",
          sourceId: line.id!,
          idempotencyKey: `dis:${line.id}:produce`,
        });
        movements += 1;
      }
      return {
        orderId,
        direction,
        consumedCostMinor: anyCosted ? consumed : null,
        producedQty: totalQty,
        movements,
      };
    },
  );
}

/**
 * Give the thing that was just made an identity the ledger can hold.
 *
 * Receiving RECORDS identity that came printed on a box; making it MINTS it,
 * because until this moment the thing did not exist. The order said what it
 * would be called when it was still a plan, so nothing is invented here — this
 * only turns those words into rows.
 */
async function mintOutputIdentity(
  tx: TenantTx,
  ctx: Ctx,
  args: {
    itemId: string;
    qty: number;
    lotCode: string | null;
    manufacturedOn: string | null;
    expiryDate: string | null;
    serialNos: string[];
    at: { warehouseId: string; locationId: string };
    what: string;
  },
): Promise<{ lots: Array<{ lotId: string; qty: number }> | null; serialIds: string[] | null }> {
  const tracking = await itemTracking(tx, ctx, args.itemId);
  if (tracking === "none") return { lots: null, serialIds: null };

  if (tracking === "lot") {
    if (!args.lotCode) {
      throw new BomError(`${args.what} is batch-tracked but the order names no batch`);
    }
    const lotId = await openLot(tx, ctx, args.itemId, args.lotCode, {
      manufacturedOn: args.manufacturedOn,
      expiryDate: args.expiryDate,
    });
    return { lots: [{ lotId, qty: args.qty }], serialIds: null };
  }

  if (!Number.isInteger(args.qty)) {
    throw new BomError(`${args.what} is serialised, so it comes in whole units, not ${args.qty}`);
  }
  if (args.serialNos.length !== args.qty) {
    throw new BomError(
      `${args.what} is serialised: the order names ${args.serialNos.length} unit(s) for a quantity of ${args.qty}`,
    );
  }
  const serialIds = await openSerials(tx, ctx, args.itemId, args.serialNos, args.at, null);
  return { lots: null, serialIds };
}

/** Cancel a build that has not happened. A completed one is reversed, not cancelled. */
export async function cancelAssemblyOrder(
  ctx: Ctx,
  archetype: RoleArchetype,
  orderId: string,
): Promise<{ id: string }> {
  assertCan(archetype, "inventory.adjust");
  return command<{ id: string }>(
    ctx,
    {
      audit: {
        action: "inventory.assembly_cancelled",
        entityType: "stock_movement",
        entityId: orderId,
        summary: "Cancelled an assembly order",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.assembly_order
        set status = 'cancelled', cancelled_at = now(), updated_at = now()
        where id = ${orderId} and org_id = ${ctx.orgId} and status = 'draft'
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) {
        throw new StockMovementConflictError(
          "only a draft assembly order can be cancelled; a completed one is reversed",
        );
      }
      return { id: orderId };
    },
  );
}

/** Where a finished thing goes when the order did not say. */
async function defaultBuildLocation(
  tx: TenantTx,
  ctx: Ctx,
  warehouseId: string,
): Promise<{ warehouseId: string; locationId: string }> {
  const rows = (await tx.execute(sql`
    select id::text as id from public.stock_location
    where org_id = ${ctx.orgId} and warehouse_id = ${warehouseId}
      and active and can_hold_stock and kind = 'storage'
    order by is_default_receiving desc, created_at, id
    limit 1
  `)) as unknown as Array<{ id: string }>;
  if (!rows[0]) {
    throw new StockMovementConflictError("that warehouse has nowhere to put what is made");
  }
  return { warehouseId, locationId: rows[0].id };
}

async function baseCurrency(tx: TenantTx, ctx: Ctx): Promise<string> {
  const rows = (await tx.execute(sql`
    select base_currency from public.org where id = ${ctx.orgId}
  `)) as unknown as Array<{ base_currency: string }>;
  return rows[0]?.base_currency ?? "AED";
}

/** Read one bill of material with its components. Bounded: recipes are small. */
export async function getBom(
  ctx: Ctx,
  archetype: RoleArchetype,
  bomId: string,
): Promise<{
  id: string;
  itemId: string;
  version: number;
  status: string;
  outputQty: string;
  lines: Array<{ componentItemId: string; qtyPer: string; scrapPct: string }>;
} | null> {
  assertCan(archetype, "inventory.view");
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, item_id::text as item_id, version, status,
             output_qty::text as output_qty
      from public.bom where id = ${bomId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, string | number>>;
    const b = rows[0];
    if (!b) return null;
    const lines = (await tx.execute(sql`
      select component_item_id::text as component_item_id, qty_per::text as qty_per,
             scrap_pct::text as scrap_pct
      from public.bom_line where bom_id = ${bomId} and org_id = ${ctx.orgId}
      order by sort, component_item_id
      limit 200
    `)) as unknown as Array<Record<string, string>>;
    return {
      id: String(b.id),
      itemId: String(b.item_id),
      version: Number(b.version),
      status: String(b.status),
      outputQty: String(b.output_qty),
      lines: lines.map((l) => ({
        componentItemId: l.component_item_id!,
        qtyPer: l.qty_per!,
        scrapPct: l.scrap_pct!,
      })),
    };
  });
}
