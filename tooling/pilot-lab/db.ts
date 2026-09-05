/**
 * H33 Pilot Lab — the database side of the seeder.
 *
 * One owner connection (DIRECT_URL, guarded), batched writes, a size probe, and
 * nothing else. Row-level security does not apply to the owner role, which is
 * why every write goes through `insertBatch` with an explicit org_id in every
 * row and why the marker is checked before any of it runs.
 *
 * ── Batching without per-column typing ──────────────────────────────────────
 * `json_populate_recordset(null::public.<table>, $1::json)` casts a JSON array
 * into the table's own row type, so a family can hand over plain objects and
 * the database does the typing — dates, numerics, jsonb, enums. One statement
 * per 2,000 rows keeps each call well under the pooler's limits and, measured
 * from this machine, moves ~3,000 rows a second.
 */
import postgres from "postgres";
import type { LabEnv } from "./guard";

export type Sql = ReturnType<typeof postgres>;

export function openOwner(env: LabEnv): Sql {
  return postgres(env.directUrl, { max: 1, onnotice: () => {}, connect_timeout: 60 });
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`refusing unsafe identifier: ${name}`);
  return name;
}

export const BATCH = 2000;

export type InsertResult = { attempted: number; inserted: number };

/**
 * Insert rows in batches. Every row must carry `org_id`; a row without one is
 * refused before anything is sent, because an org-less row is the one kind of
 * residue the cleanup cannot find.
 *
 * `conflict`: `"nothing"` (default — idempotent re-runs) or an explicit
 * `on conflict … do update …` tail for the few families that legitimately
 * refresh (balances, checkpoints).
 */
export async function insertBatch(
  sql: Sql,
  table: string,
  rows: Array<Record<string, unknown>>,
  opts: { conflict?: "nothing" | string; requireOrg?: boolean } = {},
): Promise<InsertResult> {
  const t = ident(table);
  const requireOrg = opts.requireOrg ?? true;
  if (rows.length === 0) return { attempted: 0, inserted: 0 };
  const columns = Object.keys(rows[0]!);
  for (const c of columns) ident(c);
  if (requireOrg && !columns.includes("org_id")) throw new Error(`${t}: rows must carry org_id`);
  for (const r of rows) {
    if (requireOrg && !r.org_id) throw new Error(`${t}: a row has no org_id`);
    for (const k of Object.keys(r))
      if (!columns.includes(k)) throw new Error(`${t}: ragged row (extra ${k})`);
  }
  const cols = columns.map(ident).join(", ");
  const tail =
    opts.conflict === undefined || opts.conflict === "nothing"
      ? "on conflict do nothing"
      : opts.conflict;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const res = await sql.unsafe(
      `insert into public.${t} (${cols})
       select ${cols} from json_populate_recordset(null::public.${t}, $1::json)
       ${tail}`,
      [JSON.stringify(chunk)],
    );
    inserted += res.count ?? 0;
  }
  return { attempted: rows.length, inserted };
}

/** Bytes the whole database occupies right now. */
export async function dbSizeBytes(sql: Sql): Promise<number> {
  const [r] =
    (await sql`select pg_database_size(current_database())::bigint as b`) as unknown as Array<{
      b: string;
    }>;
  return Number(r!.b);
}

/** Live-row estimate per table for the manifest and the dry-run comparison. */
export async function liveRowCounts(sql: Sql, orgIds: string[]): Promise<Record<string, number>> {
  const tables = (await sql`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id' order by table_name
  `) as unknown as Array<{ table_name: string }>;
  const out: Record<string, number> = {};
  for (const { table_name } of tables) {
    const t = ident(table_name);
    const [r] = (await sql.unsafe(
      `select count(*)::int as n from public.${t} where org_id = any($1::uuid[])`,
      [orgIds],
    )) as unknown as Array<{ n: number }>;
    if (r!.n > 0) out[t] = r!.n;
  }
  return out;
}

/** The capacity law from the truth map: refuse to continue past 300 MB. */
export const DB_CEILING_BYTES = 300 * 1024 * 1024;

export async function assertUnderBudget(sql: Sql, label: string): Promise<number> {
  const bytes = await dbSizeBytes(sql);
  if (bytes > DB_CEILING_BYTES) {
    throw new Error(
      `capacity stop after ${label}: database is ${(bytes / 1048576).toFixed(0)} MB, ceiling ${DB_CEILING_BYTES / 1048576} MB`,
    );
  }
  return bytes;
}
