/**
 * What is actually in the test database, before migrations touch it?
 *
 * Loads ONLY `.env.test.local` / `.env.test`, asserts the connection points at
 * the test project, and reports every non-system schema and table with its row
 * count. Read-only. Prints no credential values.
 *
 *   npx tsx tooling/scripts/inspect-test-db.ts
 */
import { config } from "dotenv";
import postgres from "postgres";
import {
  assertNotProduction,
  targetsOnlyTestProject,
  TEST_PROJECT_REF,
} from "../../tests/integration/guard-env";

config({ path: [".env.test.local", ".env.test"], quiet: true });

async function main() {
  // Two independent gates before a single byte crosses the wire.
  assertNotProduction();
  const target = targetsOnlyTestProject();
  if (!target.ok) {
    console.error("Refusing to connect — the environment does not point only at the test project:");
    for (const p of target.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`target project: ${target.refs.join(", ")} (expected ${TEST_PROJECT_REF})\n`);

  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  try {
    // Prove at the server which database and host we actually reached.
    const who = await sql`
      select current_database() as db, current_user as usr,
             inet_server_addr()::text as server, version() as version`;
    console.log(`connected: db=${who[0]!.db} user=${who[0]!.usr}`);
    console.log(`postgres:  ${String(who[0]!.version).split(" on ")[0]}\n`);

    const schemas = await sql`
      select nspname as schema, count(c.oid)::int as tables
      from pg_namespace n
      left join pg_class c on c.relnamespace = n.oid and c.relkind = 'r'
      where nspname not like 'pg_%' and nspname <> 'information_schema'
      group by nspname order by nspname`;
    console.log("schemas present:");
    for (const s of schemas) console.log(`  ${String(s.schema).padEnd(22)} ${s.tables} table(s)`);

    const publicTables = await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`;
    console.log(`\npublic tables: ${publicTables.length}`);

    // If the app schema already exists, count what is in the tables that would
    // hold real data. A fresh project has none of these.
    let orgs: number | null = null;
    if (publicTables.some((t) => t.table_name === "org")) {
      const r = await sql`select count(*)::int as n from public.org`;
      orgs = r[0]!.n;
      console.log(`organizations already present: ${orgs}`);
    }

    const authUsers = await sql`
      select count(*)::int as n from auth.users`.catch(() => [{ n: -1 }]);
    console.log(
      `auth users already present: ${authUsers[0]!.n === -1 ? "auth schema absent" : authUsers[0]!.n}`,
    );

    const clean = (orgs === null || orgs === 0) && authUsers[0]!.n <= 0;
    console.log(
      `\n${clean ? "EMPTY — no application data present." : "NOT EMPTY — inspect before migrating."}`,
    );
    process.exitCode = clean ? 0 : 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
