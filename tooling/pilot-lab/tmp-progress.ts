import { loadLabEnv } from "./guard";
import { openOwner } from "./db";
import { COMPANIES } from "./companies";
import { findLabOrg } from "./provision";

async function main() {
  const sql = openOwner(loadLabEnv());
  try {
    const parts: string[] = [];
    let done = 0;
    let rows = 0;
    for (const c of COMPANIES) {
      const org = await findLabOrg(sql, c.key);
      if (!org) {
        parts.push(`${c.key}:-`);
        continue;
      }
      const [cp] = (await sql`
        select count(*)::int as n from public.app_settings
        where org_id = ${org} and key like 'h33.checkpoint.%'
      `) as unknown as Array<{ n: number }>;
      const [r] = (await sql`
        select (select count(*)::int from public.stock_movement where org_id = ${org})
             + (select count(*)::int from public.doc_event where org_id = ${org})
             + (select count(*)::int from public.job where org_id = ${org})
             + (select count(*)::int from public.attendance where org_id = ${org}) as n
      `) as unknown as Array<{ n: number }>;
      parts.push(`${c.key}:${cp!.n}/15(${r!.n})`);
      if (cp!.n === 15) done++;
      rows += r!.n;
    }
    const [size] = (await sql`
      select round(pg_database_size(current_database()) / 1048576.0)::int as mb
    `) as unknown as Array<{ mb: number }>;
    const tag = done === COMPANIES.length ? " ALL 5 COMPLETE" : "";
    console.log(`${parts.join(" ")} db=${size!.mb}MB marker=${rows}${tag}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
main().catch((e) => {
  console.log(`ERROR ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0);
});
