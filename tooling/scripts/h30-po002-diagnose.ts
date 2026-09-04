/**
 * H30 — why PO-002 does not appear in the unposted-receipts list.
 *
 * Read-only. Written because the H30 smoke expected to find it and did not, and
 * a remedy that cannot see the case it was built for is not a remedy.
 */
import "./load-env";
import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  try {
    const rows = (await sql`
      select
        o.name as org,
        po.reference as po,
        gr.reference as grn,
        gr.status as grn_status,
        i.name as item,
        i.item_type,
        i.base_unit_id is null as base_unit_missing,
        grl.received_qty::text as received,
        (select count(*)::int from public.stock_movement sm
          where sm.org_id = grl.org_id
            and sm.idempotency_key like 'grl:' || grl.id::text || ':%') as movements
      from public.goods_receipt_line grl
      join public.goods_receipt gr on gr.id = grl.grn_id and gr.org_id = grl.org_id
      join public.purchase_order po on po.id = gr.po_id and po.org_id = gr.org_id
      join public.org o on o.id = grl.org_id
      left join public.purchase_order_line pol
        on pol.id = grl.po_line_id and pol.org_id = grl.org_id
      left join public.item i on i.id = pol.item_id and i.org_id = pol.org_id
      order by o.name, po.reference, gr.reference
    `) as unknown as Array<Record<string, unknown>>;

    console.log(`goods receipt lines in production: ${rows.length}\n`);
    for (const r of rows) {
      console.log(
        `${String(r.org).padEnd(14)} ${String(r.po).padEnd(10)} ${String(r.grn).padEnd(10)} ` +
          `qty=${String(r.received).padEnd(6)} item=${String(r.item ?? "(none)").padEnd(16)} ` +
          `type=${String(r.item_type ?? "-").padEnd(12)} base_unit_missing=${r.base_unit_missing} ` +
          `movements=${r.movements}`,
      );
    }

    const [units] = (await sql`
      select count(*)::int as n from public.unit_of_measure`) as unknown as Array<{ n: number }>;
    const [items] = (await sql`
      select count(*)::int as n from public.item where base_unit_id is null`) as unknown as Array<{
      n: number;
    }>;
    console.log(`\nunit_of_measure rows in the whole database: ${units!.n}`);
    console.log(`items with no base unit:                    ${items!.n}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
