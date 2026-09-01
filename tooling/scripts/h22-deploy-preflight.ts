/**
 * H22 deployment pre-flight — READ ONLY.
 *
 * Two of the pending migrations do something the rest do not: they backfill and
 * then CONSTRAIN rows that already exist in production. Everything else in H22
 * creates new tables and columns, which cannot fail on data nobody has written
 * yet. These two can, and a CHECK that fails halfway through a deploy leaves the
 * schema in a state nobody designed.
 *
 *   0087 sets goods_receipt_line.accepted_qty from what already arrived, then
 *        demands accepted + damaged + rejected + quarantine = received.
 *        A historical line where damaged + rejected already exceeds received
 *        would be clamped to zero and then fail that check.
 *
 *   0087 also sets purchase_order.currency from the organization's base
 *        currency and makes it NOT NULL, which needs every order to belong to an
 *        organization that has one.
 *
 * So this asks production, before touching it, whether those two statements can
 * succeed — and prints the rows that would stop them if they cannot.
 *
 * It never writes. Every statement is a SELECT.
 *
 *   npx tsx tooling/scripts/h22-deploy-preflight.ts
 */
import { config } from "dotenv";

config({ path: [".env.local"], quiet: true });

import postgres from "postgres";
import {
  PRODUCTION_PROJECT_REF,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

async function main(): Promise<void> {
  /*
   * The guard, written the way it must be read.
   *
   * This said  for its first few runs.
   * That function returns a VERDICT OBJECT, never a boolean, so the negation was
   * always false and the guard never once fired — a safety check that cannot
   * fail, in a script whose whole justification is that it is careful. It only
   * ever reached production because .env.local happens to point there.
   */
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    console.error("Refusing to run: this environment does not identify the production project.");
    for (const p of target.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not set");

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  let failures = 0;
  try {
    console.log(`H22 DEPLOY PRE-FLIGHT — project ${PRODUCTION_PROJECT_REF}\n`);

    // 1. Would the disposition CHECK hold once accepted_qty is backfilled?
    const badDisposition = await sql`
      select gl.id::text as id, gr.reference,
             gl.received_qty::text as received,
             gl.damaged_qty::text as damaged,
             gl.rejected_qty::text as rejected
      from public.goods_receipt_line gl
      join public.goods_receipt gr on gr.id = gl.grn_id and gr.org_id = gl.org_id
      where greatest(gl.received_qty - gl.damaged_qty - gl.rejected_qty, 0)
            + gl.damaged_qty + gl.rejected_qty <> gl.received_qty
      limit 50`;
    if (badDisposition.length === 0) {
      console.log("  0087 disposition check   OK — every existing receipt line will satisfy it");
    } else {
      failures++;
      console.log(`  0087 disposition check   ${badDisposition.length} LINE(S) WOULD FAIL:`);
      for (const r of badDisposition) {
        console.log(
          `      ${r.reference} line ${r.id}: received ${r.received}, damaged ${r.damaged}, rejected ${r.rejected}`,
        );
      }
    }

    // 2. Would purchase_order.currency be NOT NULL for every existing order?
    const noBase = await sql`
      select po.id::text as id, po.reference
      from public.purchase_order po
      join public.org o on o.id = po.org_id
      where o.base_currency is null
      limit 50`;
    if (noBase.length === 0) {
      console.log("  0087 order currency      OK — every order's organization has a base currency");
    } else {
      failures++;
      console.log(`  0087 order currency      ${noBase.length} ORDER(S) WOULD FAIL:`);
      for (const r of noBase) console.log(`      ${r.reference} (${r.id})`);
    }

    // 3. The currency must also be one the new CHECK accepts.
    const oddCurrency = await sql`
      select distinct o.base_currency
      from public.org o
      where o.base_currency is not null
        and o.base_currency not in ('AED','SAR','QAR','KWD','BHD','OMR','USD','EUR')`;
    if (oddCurrency.length === 0) {
      console.log("  0087 currency vocabulary OK — every base currency is in the allowed set");
    } else {
      failures++;
      console.log(
        `  0087 currency vocabulary UNSUPPORTED: ${oddCurrency.map((r) => r.base_currency).join(", ")}`,
      );
    }

    // 4. Nothing H22 owns should exist yet. If it does, a partial deploy happened.
    const already = await sql`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('stock_movement', 'stock_lot', 'asset', 'bom')`;
    if (already.length === 0) {
      console.log("  H22 tables               OK — none present, this is a clean first apply");
    } else {
      failures++;
      console.log(
        `  H22 tables               ALREADY PRESENT: ${already.map((r) => r.table_name).join(", ")}`,
      );
    }

    console.log(
      failures === 0
        ? "\nCLEAR — the pending migrations have nothing in this database that can stop them."
        : `\nBLOCKED — ${failures} condition(s) would fail. Do not deploy until each is resolved.`,
    );
    if (failures > 0) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`pre-flight failed: ${(err as Error).message}`);
  process.exit(1);
});
