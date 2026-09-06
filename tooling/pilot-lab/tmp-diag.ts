import { loadLabEnv } from "./guard";
import { openOwner } from "./db";
import { findLabOrg } from "./provision";

async function main() {
  const sql = openOwner(loadLabEnv());
  try {
    const org = await findLabOrg(sql, "tradeline");
    console.log("now", new Date().toISOString(), "tradeline org", org);

    const cps = (await sql`
      select key, (value->>'at') as at
      from public.app_settings
      where org_id = ${org} and key like 'h33.checkpoint.%'
      order by (value->>'at')
    `) as unknown as Array<{ key: string; at: string }>;
    console.log(`checkpoints: ${cps.length}`);
    for (const c of cps.slice(-3)) console.log("  ", c.key, c.at);

    for (const t of [
      "stock_movement",
      "stock_movement_lot",
      "stock_movement_serial",
      "stock_lot",
      "stock_serial",
      "stock_balance",
      "stock_cost_layer",
    ]) {
      const [r] = (await sql.unsafe(
        `select count(*)::int as n from public.${t} where org_id = $1`,
        [org] as never[],
      )) as unknown as Array<{ n: number }>;
      console.log("  rows", t.padEnd(24), r!.n);
    }

    const act = (await sql`
      select pid, state, wait_event_type, wait_event,
             round(extract(epoch from (now() - state_change)))::int as since_state,
             round(extract(epoch from (now() - query_start)))::int as query_secs,
             left(regexp_replace(query, '\\s+', ' ', 'g'), 120) as q
      from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and query <> ''
        and query not like '%pg_stat_activity%'
      order by query_start desc nulls last limit 6
    `) as unknown as Array<Record<string, unknown>>;
    console.log("activity:");
    for (const a of act) console.log("  ", JSON.stringify(a));

    const locks = (await sql`
      select l.pid, l.mode, l.granted, c.relname
      from pg_locks l left join pg_class c on c.oid = l.relation
      where not l.granted
    `) as unknown as Array<Record<string, unknown>>;
    console.log(`ungranted locks: ${locks.length}`);
    for (const l of locks) console.log("  ", JSON.stringify(l));
  } finally {
    await sql.end({ timeout: 5 });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
