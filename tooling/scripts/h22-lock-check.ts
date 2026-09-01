/**
 * Lock-contention check, run in the seconds before a migration.
 *
 * The adversarial pre-flight audit raised this and it is the risk that does not
 * show up in any data check: `migrate.ts` wraps each migration file in ONE
 * transaction and sets no `lock_timeout`. So a migration's lock footprint is the
 * UNION of every statement in the file, held until the last one commits — and
 * 0084, 0089 and 0091 each take ACCESS EXCLUSIVE or SHARE ROW EXCLUSIVE on
 * tables the live application is reading and writing.
 *
 * If anything is already holding a conflicting lock, the migration does not
 * fail. It QUEUES — and a queued ACCESS EXCLUSIVE request blocks every reader
 * that arrives behind it. That is how a schema change nobody thought was risky
 * stalls a whole application on a table it barely touches.
 *
 * `idle in transaction` is the usual culprit and the one an age filter misses:
 * a session doing nothing at all, holding its locks indefinitely.
 *
 * READ ONLY.
 *
 *   npx tsx tooling/scripts/h22-lock-check.ts
 */
import { config } from "dotenv";

config({ path: [".env.local"], quiet: true });

import postgres from "postgres";
import { targetsOnlyProductionProject } from "../../tests/integration/guard-env";

/** Every pre-existing table the nine pending migrations lock. */
const TOUCHED = [
  "goods_receipt_line", // 0084 ACCESS EXCLUSIVE, 0087 ACCESS EXCLUSIVE
  "material_request_line", // 0084 ACCESS EXCLUSIVE
  "item", // 0084 ACCESS EXCLUSIVE, FK parent thereafter
  "purchase_order", // 0087 ACCESS EXCLUSIVE
  "approval", // 0091 ACCESS EXCLUSIVE (subject-type CHECK swap)
  "approval_rule", // 0091 ACCESS EXCLUSIVE
  "org", // SHARE ROW EXCLUSIVE via every new FK
  "user_profile", // SHARE ROW EXCLUSIVE via every new created_by FK
  "supplier", // SHARE ROW EXCLUSIVE via new FKs
  "job", // SHARE ROW EXCLUSIVE via new FKs
  "task", // SHARE ROW EXCLUSIVE via new FKs
  "daily_report", // SHARE ROW EXCLUSIVE via new FKs
  "goods_receipt", // SHARE ROW EXCLUSIVE via new FKs
  "purchase_order_line", // SHARE ROW EXCLUSIVE via new FKs
] as const;

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
  const sql = postgres(process.env.DIRECT_URL!, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const blockers = await sql<
      Array<{
        pid: number | null;
        usename: string | null;
        application_name: string | null;
        state: string | null;
        locked_table: string;
        mode: string;
        granted: boolean;
        xact_age: string | null;
        query: string | null;
      }>
    >`
      select a.pid,
             coalesce(a.usename, '(prepared xact)') as usename,
             a.application_name,
             a.state,
             c.relname::text as locked_table,
             l.mode,
             l.granted,
             date_trunc('second', now() - a.xact_start)::text as xact_age,
             left(regexp_replace(coalesce(a.query, ''), '\\s+', ' ', 'g'), 120) as query
      from pg_locks l
      join pg_class c on c.oid = l.relation
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'relation'
        and n.nspname = 'public'
        and c.relname = any(${TOUCHED as unknown as string[]})
        and (l.pid is distinct from pg_backend_pid())
        and (
          -- Holds its locks while doing nothing at all.
          a.state like 'idle in transaction%'
          -- Or has run long enough to outlast any sensible lock wait.
          or (a.xact_start is not null and a.xact_start < now() - interval '5 seconds')
          -- Or is itself already waiting, so the migration would queue behind it.
          or not l.granted
          -- Or a prepared transaction: no backend, never clears on its own.
          or a.pid is null
        )
      order by a.xact_start nulls first, a.pid`;

    const [conns] = await sql<Array<{ total: number; active: number; idle_tx: number }>>`
      select count(*)::int as total,
             count(*) filter (where state = 'active')::int as active,
             count(*) filter (where state like 'idle in transaction%')::int as idle_tx
      from pg_stat_activity where datname = current_database()`;

    console.log("LOCK CHECK — tables the pending migrations will lock\n");
    console.log(
      `  connections   ${conns!.total} total, ${conns!.active} active, ${conns!.idle_tx} idle in transaction`,
    );

    if (blockers.length === 0) {
      console.log("  blockers      none\n");
      console.log("CLEAR — nothing holds a conflicting lock. Safe to migrate now.");
      return;
    }

    console.log(`  blockers      ${blockers.length}\n`);
    for (const b of blockers) {
      console.log(
        `  pid ${b.pid ?? "-"} ${b.usename} ${b.state ?? ""} — ${b.mode}${b.granted ? "" : " (WAITING)"} on ${b.locked_table}, age ${b.xact_age ?? "?"}`,
      );
      if (b.query) console.log(`      ${b.query}`);
    }
    console.log("\nBLOCKED — the migration would queue behind these and stall readers behind it.");
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`lock check failed: ${(err as Error).message}`);
  process.exit(1);
});
