/** READ-ONLY hosted inventory: every org + whether it is a protected production org.
 * Used to scope S7 synthetic-data cleanup without ever touching Alpha Marine / TESTING. */
import "./load-env";
import postgres from "postgres";

const PROTECTED = new Set(["Alpha Marine", "TESTING"]);

async function main() {
  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  try {
    const orgs = (await sql`
      select o.id::text as id, o.name, o.created_at::text as created_at
      from public.org o order by o.created_at`) as unknown as Array<{
      id: string;
      name: string;
      created_at: string;
    }>;
    console.log(`ORGS: ${orgs.length}`);
    for (const o of orgs) {
      const tag = PROTECTED.has(o.name) ? "PROTECTED" : "synthetic";
      console.log(`  [${tag}] ${o.id}  ${JSON.stringify(o.name)}  ${o.created_at}`);
    }
    // S7 table totals across the whole DB (should be 0 once synthetic data is gone).
    for (const tbl of ["digest", "ai_interaction", "customer_update", "share_token"] as const) {
      const [r] = (await sql.unsafe(
        `select count(*)::int as n from public.${tbl}`,
      )) as unknown as Array<{ n: number }>;
      console.log(`  S7 table ${tbl}: ${r!.n}`);
    }
    // Exception rows carrying the S7 rule keys anywhere in the DB.
    const [ex] = (await sql`
      select count(*)::int as n from public.exception
      where rule_key in ('margin_drift','late_po','late_supplier','unusual_expense','document_expiry')`) as unknown as Array<{
      n: number;
    }>;
    console.log(`  exception rows with S7 rule_keys: ${ex!.n}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
