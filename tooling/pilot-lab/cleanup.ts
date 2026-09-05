/**
 * H33 Pilot Lab — the guarded cleanup.
 *
 *   npx tsx tooling/pilot-lab/cleanup.ts                         # preview: what WOULD be deleted
 *   npx tsx tooling/pilot-lab/cleanup.ts --confirm=<phrase>      # delete exactly the five
 *
 * Four gates, every one of which refuses on its own:
 *   1. the environment resolves to the isolated test project (guard.ts);
 *   2. the confirmation phrase names that project and this operation;
 *   3. every organisation to be deleted carries the exact H33 marker with THIS
 *      seed version — an organisation is selected only by that marker, never by
 *      name, id, date or pattern;
 *   4. the marked set is exactly the five companies. Fewer means a partial lab
 *      (say which is missing); more means something has gone badly wrong.
 *      Either way: refuse, print, exit.
 *
 * `--allow-partial` lifts gate 4's lower bound only, for cleaning up after an
 * interrupted seed. It never lifts the upper bound and never lifts gate 3.
 *
 * Deletion uses `session_replication_role = replica` (owner) inside one
 * transaction so whole tenants go regardless of FK topology and append-only
 * triggers — which is exactly the case those triggers exempt. The mandate is
 * clear that the lab must be removable; a lab that cannot be removed is
 * residue with a nicer name.
 */
import { loadLabEnv } from "./guard";
import { openOwner, type Sql } from "./db";
import { COMPANIES } from "./companies";
import { MARKER_KEY, SEED_VERSION, EMAIL_DOMAIN, isLabMarker } from "./marker";
import { cleanupPhrase } from "./manifest";
import { adminClient } from "./provision";

const argv = process.argv.slice(2);
const confirm = argv.find((a) => a.startsWith("--confirm="))?.slice(10) ?? "";
const allowPartial = argv.includes("--allow-partial");

type Marked = { org_id: string; name: string; company_key: string; seed_version: string };

async function markedOrgs(sql: Sql): Promise<Marked[]> {
  const rows = (await sql`
    select s.org_id::text as org_id, o.name, s.value
    from public.app_settings s join public.org o on o.id = s.org_id
    where s.key = ${MARKER_KEY}
    order by o.created_at
  `) as unknown as Array<{ org_id: string; name: string; value: unknown }>;
  return rows
    .filter((r) => isLabMarker(r.value))
    .map((r) => {
      const v = (typeof r.value === "string" ? JSON.parse(r.value) : r.value) as {
        company_key: string;
        seed_version: string;
      };
      return {
        org_id: r.org_id,
        name: r.name,
        company_key: v.company_key,
        seed_version: v.seed_version,
      };
    })
    .filter((r) => r.seed_version === SEED_VERSION);
}

async function main() {
  const env = loadLabEnv();
  const sql = openOwner(env);
  const phrase = cleanupPhrase(env.ref);
  try {
    const marked = await markedOrgs(sql);
    const expected = new Set<string>(COMPANIES.map((c) => c.key));
    const unknown = marked.filter((m) => !expected.has(m.company_key));
    const missing = COMPANIES.filter((c) => !marked.some((m) => m.company_key === c.key)).map(
      (c) => c.key,
    );

    console.log(`H33 Pilot Lab cleanup — test project ${env.ref} — seed ${SEED_VERSION}`);
    console.log(`marked organisations found: ${marked.length}`);
    for (const m of marked) {
      const tables = (await sql`
        select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'org_id'
      `) as unknown as Array<{ table_name: string }>;
      let rows = 0;
      for (const { table_name } of tables) {
        const [r] = (await sql.unsafe(
          `select count(*)::int as n from public.${table_name} where org_id = $1`,
          [m.org_id],
        )) as unknown as Array<{ n: number }>;
        rows += r!.n;
      }
      const [u] =
        (await sql`select count(*)::int as n from auth.users where email like ${`h33.${m.company_key}.%@${EMAIL_DOMAIN}`}`) as unknown as Array<{
          n: number;
        }>;
      console.log(
        `  ${m.company_key.padEnd(10)} ${m.org_id}  "${m.name}"  ${rows.toLocaleString()} rows, ${u!.n} lab logins`,
      );
    }

    // Gate 3/4 verdicts.
    const problems: string[] = [];
    if (unknown.length)
      problems.push(
        `marked organisations with an unexpected company key: ${unknown.map((u) => u.company_key).join(", ")}`,
      );
    if (marked.length > COMPANIES.length)
      problems.push(`more than ${COMPANIES.length} marked organisations`);
    if (missing.length && !allowPartial)
      problems.push(
        `not all five are present (missing: ${missing.join(", ")}); pass --allow-partial to remove what exists`,
      );
    if (marked.length === 0) problems.push("nothing carries the H33 marker for this seed version");

    if (!confirm) {
      console.log(`\nPREVIEW ONLY. Nothing was deleted.`);
      if (problems.length) {
        console.log("A real run would refuse:");
        for (const p of problems) console.log(`  - ${p}`);
      } else {
        console.log(
          `A real run would delete exactly these ${marked.length} organisations and their lab logins.`,
        );
      }
      console.log(`To delete: --confirm=${phrase}`);
      return;
    }
    if (confirm !== phrase)
      throw new Error(`refusing: the confirmation phrase must be exactly ${phrase}`);
    if (problems.length)
      throw new Error(`refusing:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

    // Re-check the marker on every org INSIDE the transaction (H30's lesson).
    const orgIds = marked.map((m) => m.org_id);
    const tables = (await sql`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'org_id'
    `) as unknown as Array<{ table_name: string }>;
    const SAFE = /^[a-z_][a-z0-9_]*$/;
    await sql.begin(async (tx) => {
      const recheck = (await tx`
        select org_id::text as org_id, value from public.app_settings
        where key = ${MARKER_KEY} and org_id = any(${orgIds}::uuid[])
      `) as unknown as Array<{ org_id: string; value: unknown }>;
      const ok = new Set(recheck.filter((r) => isLabMarker(r.value)).map((r) => r.org_id));
      for (const o of orgIds)
        if (!ok.has(o)) throw new Error(`refusing inside the transaction: ${o} lost its marker`);
      await tx.unsafe("set local session_replication_role = replica");
      const script = [
        ...tables
          .map((t) => t.table_name)
          .filter((t) => SAFE.test(t))
          .map(
            (t) => `delete from public."${t}" where org_id = any('{${orgIds.join(",")}}'::uuid[]);`,
          ),
        `delete from public.org where id = any('{${orgIds.join(",")}}'::uuid[]);`,
      ].join("\n");
      await tx.unsafe(script);
      await tx.unsafe("set local session_replication_role = default");
    });

    // Lab logins: by the exact reserved-domain pattern, per company.
    const admin = adminClient(env);
    let removedUsers = 0;
    for (const m of marked) {
      const users =
        (await sql`select id::text as id from auth.users where email like ${`h33.${m.company_key}.%@${EMAIL_DOMAIN}`}`) as unknown as Array<{
          id: string;
        }>;
      for (const u of users) {
        await sql`delete from public.user_profile where id = ${u.id}`;
        const res = await admin.auth.admin.deleteUser(u.id);
        if (res.error) await sql`delete from auth.users where id = ${u.id}`;
        removedUsers++;
      }
    }
    const left = await markedOrgs(sql);
    console.log(
      `\nDELETED ${marked.length} organisations and ${removedUsers} lab logins. Marked organisations remaining: ${left.length}.`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
