/**
 * Empty the TEST project back to a freshly-migrated state.
 *
 * Removes every organization, every org-owned row, every auth user and its
 * identities/sessions, and every stored object — but keeps the schema, so the
 * next run starts from clean data rather than re-migrating.
 *
 * Refuses to run anywhere except `idaraworks-test`. There is no override: this
 * empties a database, and the only database it may ever empty is the test one.
 *
 *   npx tsx tooling/scripts/reset-test-db.ts
 */
import { config } from "dotenv";

config({ path: [".env.test.local", ".env.test"], quiet: true });

import postgres from "postgres";
import {
  assertNotProduction,
  targetsOnlyTestProject,
  TEST_PROJECT_REF,
} from "../../tests/integration/guard-env";

async function main() {
  assertNotProduction();
  const target = targetsOnlyTestProject();
  if (!target.ok || target.refs.length !== 1 || target.refs[0] !== TEST_PROJECT_REF) {
    console.error("Refusing to reset — this is not exclusively the test project:");
    for (const p of target.problems) console.error(`  - ${p}`);
    console.error(`  refs seen: ${target.refs.join(", ") || "none"}`);
    process.exit(1);
  }

  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  try {
    // Belt and braces: ask the server what it is before deleting anything.
    const who = await sql`select current_database() as db`;
    console.log(`resetting ${target.refs[0]} (db=${who[0]!.db})`);

    const before = await sql`
      select (select count(*)::int from public.org) as orgs,
             (select count(*)::int from auth.users) as users,
             (select count(*)::int from storage.objects) as objects`;
    console.log(`before: ${JSON.stringify(before[0])}`);

    const tbls = await sql`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'org_id'`;

    // Free Nano is slow and the project's default statement_timeout cuts a long
    // multi-table delete short. TRUNCATE is also far cheaper than DELETE here:
    // one pass, no per-row work, and CASCADE handles the FK order for us.
    await sql.begin(async (tx) => {
      await tx.unsafe("set local statement_timeout = 0");
      await tx.unsafe("set local session_replication_role = replica");
      const names = [...tbls.map((t) => `public."${t.table_name}"`), "public.org"];
      const platform = ["public.platform_staff"];
      for (const p of platform) {
        const exists = (await tx.unsafe(`select to_regclass('${p}') as t`)) as unknown as Array<{
          t: string | null;
        }>;
        if (exists[0]?.t) names.push(p);
      }
      await tx.unsafe(`truncate table ${names.join(", ")} cascade`);
      // FK enforcement back on BEFORE auth, so identities and sessions cascade.
      await tx.unsafe("set local session_replication_role = default");
      await tx.unsafe("delete from public.user_profile");
      await tx.unsafe("delete from auth.users");
    });
    // storage.objects refuses direct SQL deletion ("Use the Storage API
    // instead"), so uploads are cleared through the API when any exist.
    //
    // The paths come from the catalogue, not from listing the bucket root:
    // files live under nested prefixes (org/class/name), and a root listing
    // returns folder entries whose removal deletes nothing.
    const objects = (await sql`
      select b.name as bucket, o.name as path
      from storage.objects o
      join storage.buckets b on b.id = o.bucket_id`) as unknown as Array<{
      bucket: string;
      path: string;
    }>;
    if (objects.length > 0) {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
      const { createClient } = await import("@supabase/supabase-js");
      const admin = createClient(url, key, { auth: { persistSession: false } });
      const byBucket = new Map<string, string[]>();
      for (const o of objects) {
        byBucket.set(o.bucket, [...(byBucket.get(o.bucket) ?? []), o.path]);
      }
      for (const [bucket, paths] of byBucket) {
        const { error } = await admin.storage.from(bucket).remove(paths);
        if (error) console.error(`  remove from ${bucket} failed: ${error.message}`);
      }
      console.log(`cleared ${objects.length} stored object(s) via the Storage API`);
    }

    const after = await sql`
      select (select count(*)::int from public.org) as orgs,
             (select count(*)::int from auth.users) as users,
             (select count(*)::int from auth.identities) as identities,
             (select count(*)::int from auth.sessions) as sessions,
             (select count(*)::int from public.user_profile) as profiles,
             (select count(*)::int from storage.objects) as objects`;
    console.log(`after:  ${JSON.stringify(after[0])}`);

    let residue = 0;
    for (const t of tbls) {
      const r = (await sql.unsafe(
        `select count(*)::int as n from public."${t.table_name}"`,
      )) as unknown as Array<{ n: number }>;
      residue += r[0]?.n ?? 0;
    }
    console.log(`org-scoped tables checked: ${tbls.length} | residual rows: ${residue}`);
    const clean =
      residue === 0 &&
      Object.values(after[0] as Record<string, number>).every((n) => Number(n) === 0);
    console.log(clean ? "\nCLEAN — no test residue." : "\nRESIDUE REMAINS.");
    process.exitCode = clean ? 0 : 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
