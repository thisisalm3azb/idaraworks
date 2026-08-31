/**
 * Historical reconciliation preview (H22C).
 *
 * Production holds receipts and material consumption recorded BEFORE a stock
 * ledger existed. Those rows are real history and must not be reinterpreted.
 *
 * This module is READ-ONLY. It reports what the historical records would imply
 * about opening stock, how confident that reading is, and exactly which records
 * cannot be reconciled at all. It creates no movement, no balance and no opening
 * position. Converting history into stock is a separate, explicitly authorised
 * act — because guessing wrong writes a number a business will trust.
 *
 * The rules it applies are the same ones the live posting paths apply, so the
 * preview cannot promise stock that the real path would refuse.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";

export type HistoricalPosition = {
  itemId: string;
  sku: string;
  itemName: string;
  /** Good quantity received historically (received less damaged and rejected). */
  receivedQty: string;
  /** Quantity consumed by submitted or reviewed daily reports. */
  consumedQty: string;
  /** received - consumed. What an opening balance WOULD be, if imported. */
  impliedOnHand: string;
  /** Movements already posted for this item, which an import must not double. */
  alreadyPostedQty: string;
  /**
   * How much of this can be trusted.
   *   high   — every source row resolved to this item with a quantity and a cost
   *   medium — resolved, but at least one row had no cost to carry forward
   *   low    — the implied position is negative, so the records disagree
   */
  confidence: "high" | "medium" | "low";
  /** Where the numbers came from, so a reviewer can check rather than believe. */
  receiptLines: number;
  consumptionLines: number;
  costedReceiptLines: number;
};

export type UnreconcilableRecord = {
  kind: "receipt_line" | "material_line";
  recordId: string;
  reason: string;
  reference: string | null;
  qty: string | null;
};

export type HistoricalPreview = {
  generatedAt: string;
  positions: HistoricalPosition[];
  unreconcilable: UnreconcilableRecord[];
  totals: {
    itemsWithPosition: number;
    receiptLinesScanned: number;
    consumptionLinesScanned: number;
    unreconcilableCount: number;
  };
  /** Always false here. Stated in the payload so a caller cannot assume otherwise. */
  applied: false;
};

/**
 * What the historical records imply, without changing anything.
 *
 * Bounded: 1,000 positions and 500 unreconcilable records. An organization with
 * more than that has a data problem to look at before an import, not a longer
 * report to scroll.
 */
export async function previewHistoricalStock(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<HistoricalPreview> {
  // Reading historical cost is reading money, so this needs the valuation right
  // rather than merely the stock one.
  assertCan(archetype, "inventory.view");
  assertCan(archetype, "valuation.view");

  const positions = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      with receipts as (
        select pol.item_id,
               sum(greatest(grl.received_qty - grl.damaged_qty - grl.rejected_qty, 0)) as qty,
               count(*) as lines,
               count(*) filter (where pol.unit_cost_minor > 0) as costed
        from public.goods_receipt_line grl
        join public.purchase_order_line pol
          on pol.id = grl.po_line_id and pol.org_id = grl.org_id
        join public.purchase_order po on po.id = pol.po_id and po.org_id = pol.org_id
        join public.goods_receipt gr on gr.id = grl.grn_id and gr.org_id = grl.org_id
        where grl.org_id = ${ctx.orgId}
          and pol.item_id is not null
          and pol.superseded_at is null
          and po.status <> 'cancelled'
          and gr.status = 'recorded'
        group by pol.item_id
      ),
      consumed as (
        select rml.item_id,
               sum(rml.qty) as qty,
               count(*) as lines
        from public.report_material_line rml
        join public.daily_report dr on dr.id = rml.report_id and dr.org_id = rml.org_id
        where rml.org_id = ${ctx.orgId}
          and rml.item_id is not null
          and rml.superseded_at is null
          and dr.status in ('submitted', 'reviewed')
        group by rml.item_id
      ),
      posted as (
        select item_id, sum(qty_delta) as qty
        from public.stock_movement where org_id = ${ctx.orgId}
        group by item_id
      )
      select i.id::text as item_id, i.sku, i.name as item_name, i.item_type,
             coalesce(r.qty, 0)::text as received_qty,
             coalesce(c.qty, 0)::text as consumed_qty,
             (coalesce(r.qty, 0) - coalesce(c.qty, 0))::text as implied_on_hand,
             coalesce(p.qty, 0)::text as already_posted,
             coalesce(r.lines, 0)::int as receipt_lines,
             coalesce(c.lines, 0)::int as consumption_lines,
             coalesce(r.costed, 0)::int as costed_receipt_lines
      from public.item i
      left join receipts r on r.item_id = i.id
      left join consumed c on c.item_id = i.id
      left join posted p on p.item_id = i.id
      where i.org_id = ${ctx.orgId}
        and (r.item_id is not null or c.item_id is not null)
      order by i.sku
      limit 1000
    `),
  )) as unknown as Array<Record<string, string | number>>;

  const unreconcilable = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      -- Receipt lines that cannot become stock, each with the specific reason.
      select 'receipt_line' as kind, grl.id::text as record_id, gr.reference,
             grl.received_qty::text as qty,
             case
               when pol.item_id is null then 'the order line is free text, with no catalogue item'
               when i.item_type not in ('inventory','asset','kit','manufactured')
                 then 'the item is a ' || i.item_type || ', which does not hold stock'
               when i.base_unit_id is null then 'the item has no base unit of measure'
               when po.status = 'cancelled' then 'the purchase order was cancelled'
               when pol.superseded_at is not null then 'the order line was superseded by a revision'
               when gr.status <> 'recorded' then 'the goods receipt is ' || gr.status
               else 'unknown'
             end as reason
      from public.goods_receipt_line grl
      join public.purchase_order_line pol on pol.id = grl.po_line_id and pol.org_id = grl.org_id
      join public.purchase_order po on po.id = pol.po_id and po.org_id = pol.org_id
      join public.goods_receipt gr on gr.id = grl.grn_id and gr.org_id = grl.org_id
      left join public.item i on i.id = pol.item_id and i.org_id = pol.org_id
      where grl.org_id = ${ctx.orgId}
        and (pol.item_id is null
             or i.item_type not in ('inventory','asset','kit','manufactured')
             or i.base_unit_id is null
             or po.status = 'cancelled'
             or pol.superseded_at is not null
             or gr.status <> 'recorded')

      union all

      -- Material lines that cannot become stock.
      select 'material_line' as kind, rml.id::text as record_id, rml.item_name as reference,
             rml.qty::text as qty,
             case
               when rml.item_id is null then 'free-text material with no catalogue item'
               when i.base_unit_id is null then 'the item has no base unit of measure'
               when i.item_type not in ('inventory','asset','kit','manufactured')
                 then 'the item is a ' || i.item_type || ', which does not hold stock'
               when dr.status not in ('submitted','reviewed') then 'the daily report is ' || dr.status
               else 'unknown'
             end as reason
      from public.report_material_line rml
      join public.daily_report dr on dr.id = rml.report_id and dr.org_id = rml.org_id
      left join public.item i on i.id = rml.item_id and i.org_id = rml.org_id
      where rml.org_id = ${ctx.orgId}
        and rml.superseded_at is null
        and (rml.item_id is null
             or i.base_unit_id is null
             or i.item_type not in ('inventory','asset','kit','manufactured')
             or dr.status not in ('submitted','reviewed'))
      limit 500
    `),
  )) as unknown as Array<Record<string, string>>;

  const mapped: HistoricalPosition[] = positions.map((p) => {
    const implied = Number(p.implied_on_hand);
    const receiptLines = Number(p.receipt_lines);
    const costed = Number(p.costed_receipt_lines);
    // Negative implied stock means the records contradict each other: more was
    // consumed than was ever received. That is a data question, not a rounding
    // one, so it is called out rather than clamped to zero.
    const confidence: HistoricalPosition["confidence"] =
      implied < 0 ? "low" : costed === receiptLines && receiptLines > 0 ? "high" : "medium";
    return {
      itemId: String(p.item_id),
      sku: String(p.sku),
      itemName: String(p.item_name),
      receivedQty: String(p.received_qty),
      consumedQty: String(p.consumed_qty),
      impliedOnHand: String(p.implied_on_hand),
      alreadyPostedQty: String(p.already_posted),
      confidence,
      receiptLines,
      consumptionLines: Number(p.consumption_lines),
      costedReceiptLines: costed,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    positions: mapped,
    unreconcilable: unreconcilable.map((u) => ({
      kind: u.kind as UnreconcilableRecord["kind"],
      recordId: u.record_id!,
      reason: u.reason!,
      reference: u.reference ?? null,
      qty: u.qty ?? null,
    })),
    totals: {
      itemsWithPosition: mapped.length,
      receiptLinesScanned: mapped.reduce((s, p) => s + p.receiptLines, 0),
      consumptionLinesScanned: mapped.reduce((s, p) => s + p.consumptionLines, 0),
      unreconcilableCount: unreconcilable.length,
    },
    applied: false,
  };
}
