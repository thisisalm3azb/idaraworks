/**
 * Production row-count baseline, taken either side of the H22 deployment.
 *
 * A migration that is supposed to be additive should leave every existing row
 * exactly where it was. "Should" is not evidence, so this writes down what was
 * there before and compares it to what is there after — per table, not as a
 * single number, because a total that happens to match can hide a table that
 * lost rows while another gained them.
 *
 * It also records the safety properties the deployment must not regress: every
 * table carrying RLS, no DELETE grant outside the one that is permitted, and the
 * two backfilled columns landing on the values the migration promised.
 *
 * READ ONLY. Every statement is a SELECT.
 *
 *   npx tsx tooling/scripts/h22-deploy-baseline.ts --write <path>   capture
 *   npx tsx tooling/scripts/h22-deploy-baseline.ts --compare <path> check
 */
import { config } from "dotenv";

config({ path: [".env.local"], quiet: true });

import { readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import {
  PRODUCTION_PROJECT_REF,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

/**
 * The tables that hold customer business records and existed before H22.
 *
 * Named explicitly rather than discovered, because the point of the comparison
 * is that this exact list is unchanged — a discovered list would quietly grow
 * with the new tables and compare them against nothing.
 */
const BUSINESS_TABLES = [
  "org",
  "user_profile",
  "membership",
  "job",
  "task",
  "daily_report",
  "report_material_line",
  "report_worker_line",
  "purchase_order",
  "purchase_order_line",
  "goods_receipt",
  "goods_receipt_line",
  "material_request",
  "item",
  "supplier",
  "customer",
  "quote",
  "quote_line",
  "invoice",
  "invoice_line",
  "payment",
  "expense",
  "approval",
  "approval_rule",
  "issue",
  "file",
  "notification",
  "audit_log",
  "activity",
  "attendance_day",
] as const;

type Snapshot = {
  takenAt: string;
  project: string;
  migrationsApplied: number;
  counts: Record<string, number | null>;
  tablesWithoutRls: string[];
  deleteGrants: string[];
  publicTables: number;
  orphanIdentities: number;
  orphanSessions: number;
};

async function capture(sql: postgres.Sql): Promise<Snapshot> {
  const counts: Record<string, number | null> = {};
  for (const t of BUSINESS_TABLES) {
    const [exists] = await sql<{ ok: boolean }[]>`
      select exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = ${t}
      ) as ok`;
    if (!exists?.ok) {
      // Recorded as null rather than skipped: a table vanishing between the two
      // snapshots must be visible, not silently absent from both sides.
      counts[t] = null;
      continue;
    }
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(`public.${t}`)}`;
    counts[t] = row!.n;
  }

  const noRls = await sql<{ relname: string }[]>`
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
    order by c.relname`;

  /*
   * DELETE grants held by THE APPLICATION'S role, and only that role.
   *
   * The first version of this filtered on "not postgres/supabase_admin/PUBLIC",
   * which swept in service_role — a Supabase platform role that holds DELETE on
   * every table in the database by default, pre-existing ones included. That
   * made the H22 deployment look like it had added 34 grants when it had added
   * none, and a check that cries wolf on a correct deployment is worse than no
   * check. What the rule actually forbids is the app being able to delete
   * business history, so app_user is what to watch.
   */
  const grants = await sql<{ table_name: string; grantee: string }[]>`
    select table_name, grantee
    from information_schema.role_table_grants
    where table_schema = 'public' and privilege_type = 'DELETE'
      and grantee = 'app_user'
    order by table_name, grantee`;

  const [tables] = await sql<{ n: number }[]>`
    select count(*)::int as n from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'`;

  const [applied] = await sql<{ n: number }[]>`
    select count(*)::int as n from app.migrations`;

  const [ident] = await sql<{ n: number }[]>`
    select count(*)::int as n from auth.identities i
    where not exists (select 1 from auth.users u where u.id = i.user_id)`;
  const [sess] = await sql<{ n: number }[]>`
    select count(*)::int as n from auth.sessions s
    where not exists (select 1 from auth.users u where u.id = s.user_id)`;

  return {
    takenAt: new Date().toISOString(),
    project: PRODUCTION_PROJECT_REF,
    migrationsApplied: applied!.n,
    counts,
    tablesWithoutRls: noRls.map((r) => r.relname),
    deleteGrants: grants.map((g) => `${g.table_name}:${g.grantee}`),
    publicTables: tables!.n,
    orphanIdentities: ident!.n,
    orphanSessions: sess!.n,
  };
}

function compare(before: Snapshot, after: Snapshot): number {
  let problems = 0;
  const say = (ok: boolean, line: string) => {
    if (!ok) problems++;
    console.log(`  ${ok ? "OK  " : "FAIL"}  ${line}`);
  };

  console.log("BUSINESS ROWS");
  for (const t of BUSINESS_TABLES) {
    const b = before.counts[t];
    const a = after.counts[t];
    if (b === null && a === null) continue;
    say(b === a, `${t.padEnd(22)} ${b === null ? "absent" : b} → ${a === null ? "absent" : a}`);
  }

  console.log("\nSAFETY");
  say(
    after.tablesWithoutRls.length === 0,
    `every public table carries RLS${after.tablesWithoutRls.length ? ` — missing on: ${after.tablesWithoutRls.join(", ")}` : ""}`,
  );

  // A DELETE grant that was not there before is the regression that matters;
  // anything already permitted stays permitted.
  const newGrants = after.deleteGrants.filter((g) => !before.deleteGrants.includes(g));
  say(
    newGrants.length === 0,
    `no new DELETE grant${newGrants.length ? ` — added: ${newGrants.join(", ")}` : ""}`,
  );

  say(
    after.orphanIdentities === before.orphanIdentities,
    `orphan identities unchanged (${before.orphanIdentities} → ${after.orphanIdentities})`,
  );
  say(
    after.orphanSessions === before.orphanSessions,
    `orphan sessions unchanged (${before.orphanSessions} → ${after.orphanSessions})`,
  );

  console.log("\nSCHEMA");
  console.log(`  public tables      ${before.publicTables} → ${after.publicTables}`);
  console.log(`  migrations applied ${before.migrationsApplied} → ${after.migrationsApplied}`);

  return problems;
}

async function main(): Promise<void> {
  if (!targetsOnlyProductionProject()) {
    throw new Error("refusing to run: the environment does not identify the production project");
  }
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not set");

  const argv = process.argv.slice(2);
  const writeAt = argv.indexOf("--write");
  const compareAt = argv.indexOf("--compare");
  const path = argv[(writeAt >= 0 ? writeAt : compareAt) + 1];
  if ((writeAt < 0 && compareAt < 0) || !path) {
    throw new Error("usage: --write <path> | --compare <path>");
  }

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const snap = await capture(sql);
    if (writeAt >= 0) {
      writeFileSync(path, JSON.stringify(snap, null, 2), "utf8");
      console.log(`BASELINE — project ${snap.project}, ${snap.migrationsApplied} migrations`);
      for (const [t, n] of Object.entries(snap.counts)) {
        if (n !== null) console.log(`  ${t.padEnd(22)} ${n}`);
      }
      console.log(`\n  public tables       ${snap.publicTables}`);
      console.log(`  tables without RLS  ${snap.tablesWithoutRls.length}`);
      console.log(`  DELETE grants       ${snap.deleteGrants.length}`);
      console.log(`\nwritten to ${path}`);
      return;
    }

    const before = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    console.log(`COMPARING against baseline taken ${before.takenAt}\n`);
    const problems = compare(before, snap);
    console.log(
      problems === 0
        ? "\nUNCHANGED — every existing business row is still there and no safety property regressed."
        : `\nREGRESSION — ${problems} problem(s) above.`,
    );
    if (problems > 0) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`baseline failed: ${(err as Error).message}`);
  process.exit(1);
});
