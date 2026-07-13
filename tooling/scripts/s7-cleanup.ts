/**
 * Synthetic-org cleanup: removes EVERY non-production org's data + the org + its users,
 * restoring the production baseline to the two protected orgs only. Order-independent
 * (session_replication_role = replica disables FK triggers inside one owner transaction),
 * so it copes with the full S1–S7 table graph regardless of FK topology.
 *
 * SAFETY: the protected orgs are matched by NAME **and** by their known UUIDs; both are
 * asserted excluded before any delete. Dry-run by default — pass `--apply` to execute.
 * Alpha Marine / TESTING are never read for deletion or touched.
 */
import "./load-env";
import postgres from "postgres";

const PROTECTED_NAMES = ["Alpha Marine", "TESTING"];
const PROTECTED_IDS = [
  "d22b2098-2e09-436d-ab9e-ee26c8719cd5", // Alpha Marine
  "9fcaa697-becd-41ec-97d4-6ce2851ead36", // TESTING
];
const APPLY = process.argv.includes("--apply");

async function main() {
  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  try {
    const synth = (await sql`
      select id::text as id, name from public.org
      where name <> all(${PROTECTED_NAMES}) and id <> all(${PROTECTED_IDS}::uuid[])
      order by name`) as unknown as Array<{ id: string; name: string }>;
    const ids = synth.map((s) => s.id);
    console.log(`synthetic orgs to remove: ${ids.length}`);
    for (const s of synth) console.log(`  - ${s.id} ${JSON.stringify(s.name)}`);

    // HARD GUARD: never proceed if a protected id/name slipped into the set.
    if (ids.some((id) => PROTECTED_IDS.includes(id)))
      throw new Error("ABORT: a protected UUID is in the delete set");
    if (synth.some((s) => PROTECTED_NAMES.includes(s.name)))
      throw new Error("ABORT: a protected name is in the delete set");
    if (ids.length === 0) {
      console.log("nothing to remove — baseline already clean.");
      return;
    }

    // Users that belong ONLY to synthetic orgs (never a member of a protected org).
    const users = (await sql`
      select distinct m.user_id::text as id from public.membership m
      where m.org_id = any(${ids}::uuid[])
        and m.user_id not in (
          select m2.user_id from public.membership m2 where m2.org_id = any(${PROTECTED_IDS}::uuid[]))`) as unknown as Array<{
      id: string;
    }>;
    const userIds = users.map((u) => u.id);
    console.log(`synthetic-only users to remove: ${userIds.length}`);

    // Every public table carrying an org_id (tenant-scoped), for an order-independent wipe.
    const tbls = (await sql`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'org_id'
      order by table_name`) as unknown as Array<{ table_name: string }>;
    const tableNames = tbls.map((t) => t.table_name);

    if (!APPLY) {
      console.log(`\nDRY-RUN. org-scoped tables: ${tableNames.length}`);
      let total = 0;
      for (const tn of tableNames) {
        const [r] = (await sql.unsafe(
          `select count(*)::int as n from public.${tn} where org_id = any($1::uuid[])`,
          [ids],
        )) as unknown as Array<{ n: number }>;
        if (r!.n > 0) {
          console.log(`  ${tn}: ${r!.n}`);
          total += r!.n;
        }
      }
      console.log(
        `\nwould delete ${total} tenant rows + ${ids.length} orgs + ${userIds.length} users.`,
      );
      console.log("re-run with --apply to execute.");
      return;
    }

    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica"); // disable FK triggers
      for (const tn of tableNames) {
        await tx.unsafe(`delete from public.${tn} where org_id = any($1::uuid[])`, [ids]);
      }
      await tx.unsafe(`delete from public.org where id = any($1::uuid[])`, [ids]);
      if (userIds.length) {
        await tx.unsafe(`delete from public.user_profile where id = any($1::uuid[])`, [userIds]);
        await tx.unsafe(`delete from auth.users where id = any($1::uuid[])`, [userIds]);
      }
      await tx.unsafe("set local session_replication_role = default");
    });
    console.log(`\nAPPLIED — removed ${ids.length} synthetic orgs + ${userIds.length} users.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
