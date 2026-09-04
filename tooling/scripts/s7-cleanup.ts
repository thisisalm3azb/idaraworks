/**
 * Fixture cleanup: removes organisations that PROVE they are test residue.
 *
 * ── What changed in H30, and why ────────────────────────────────────────────
 * This script used to select its victims by complement: every organisation whose
 * name and id were not in a two-entry hard-coded allow-list. That is safe only
 * while the database contains nothing but fixtures. Production holds 40
 * organisations and the allow-list named 2, so from the first pilot customer
 * onward a single `--apply` would have deleted real tenants, their users and
 * their `auth.users` rows — doing exactly what it was written to do.
 *
 * The rule is now inverted. An organisation is deleted only if `classifyOrg()`
 * returns `confirmed_fixture`: the suite's own marker, or three independent
 * kinds of evidence agreeing. Anything unrecognised is KEPT.
 *
 * Two further gates were added:
 *   - the target project must be identified positively (working rules 5 and 6),
 *     and production additionally demands an explicit intent phrase;
 *   - `--apply` re-reads and re-classifies inside the transaction, so a tenant
 *     created between the dry run and the apply cannot be swept up by an id
 *     list computed a moment earlier.
 *
 *   tsx tooling/scripts/s7-cleanup.ts                    # dry run (default)
 *   tsx tooling/scripts/s7-cleanup.ts --apply            # non-production
 *   tsx tooling/scripts/s7-cleanup.ts --apply --confirm=delete-fixtures-in-<ref>
 */
import "./load-env";
import postgres from "postgres";
import {
  PRODUCTION_PROJECT_REF,
  referencedProjectRefs,
  type EnvSnapshot,
} from "../../tests/integration/guard-env";
import { classifyOrg, readOrgEvidence, type Classified } from "../fixtures/evidence";

const APPLY = process.argv.includes("--apply");
const CONFIRM = process.argv.find((a) => a.startsWith("--confirm="))?.split("=")[1] ?? "";

/** Naming the project makes the phrase useless anywhere but where it was meant. */
function confirmPhraseFor(ref: string): string {
  return `delete-fixtures-in-${ref}`;
}

async function main() {
  // ── Gate 1: identify the target positively, before connecting ──────────────
  const refs = referencedProjectRefs(process.env as EnvSnapshot);
  if (refs.length === 0) {
    throw new Error(
      "No Supabase project reference found in DATABASE_URL / DIRECT_URL / NEXT_PUBLIC_SUPABASE_URL.\n" +
        "This script refuses to run against an environment it cannot name.",
    );
  }
  if (refs.length > 1) {
    throw new Error(
      `More than one Supabase project is referenced (${refs.join(", ")}).\n` +
        "A half-edited environment is refused rather than guessed at.",
    );
  }
  const ref = refs[0]!;
  const isProduction = ref === PRODUCTION_PROJECT_REF;
  console.log(`target project: ${ref}${isProduction ? "  ** PRODUCTION **" : ""}`);

  // ── Gate 2: production demands an explicit, project-naming intent ──────────
  if (APPLY && isProduction && CONFIRM !== confirmPhraseFor(ref)) {
    throw new Error(
      "Refusing to delete in PRODUCTION without explicit intent.\n" +
        `Re-run with --confirm=${confirmPhraseFor(ref)} if that is genuinely what you mean.`,
    );
  }

  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  try {
    const classified = (await readOrgEvidence(sql)).map(classifyOrg);
    report(classified);

    const deletable = classified.filter((c) => c.classification === "confirmed_fixture");
    if (deletable.length === 0) {
      console.log("\nNothing proves itself disposable. Nothing to do.");
      return;
    }

    const tableNames = await orgScopedTables(sql);

    if (!APPLY) {
      console.log(`\nDRY RUN — org-scoped tables: ${tableNames.length}`);
      let total = 0;
      const ids = deletable.map((d) => d.id);
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
        `\nwould delete ${total} tenant row(s) across ${deletable.length} organisation(s).`,
      );
      console.log("re-run with --apply to execute.");
      return;
    }

    // ── Gate 3: re-classify INSIDE the transaction ────────────────────────────
    // The dry run above is a report to a human, and a human takes time. An
    // organisation created in between must not be deleted because it happened to
    // land in an id array computed before it existed.
    let removedOrgs = 0;
    let removedUsers = 0;
    await sql.begin(async (tx) => {
      const fresh = (await readOrgEvidence(tx as unknown as postgres.Sql))
        .map(classifyOrg)
        .filter((c) => c.classification === "confirmed_fixture");
      const ids = fresh.map((f) => f.id);
      for (const d of deletable.filter((d) => !ids.includes(d.id))) {
        console.log(`  skipped ${d.id} ${JSON.stringify(d.name)} — no longer a confirmed fixture`);
      }
      if (ids.length === 0) {
        console.log("\nRe-check inside the transaction found nothing deletable. Nothing done.");
        return;
      }

      // Users belonging ONLY to organisations in this set. A user who is also a
      // member of anything else keeps their login.
      const users = (await tx.unsafe(
        `select distinct m.user_id::text as id from public.membership m
          where m.org_id = any($1::uuid[])
            and m.user_id not in (
              select m2.user_id from public.membership m2 where m2.org_id <> all($1::uuid[]))`,
        [ids],
      )) as unknown as Array<{ id: string }>;
      const userIds = users.map((u) => u.id);

      await tx.unsafe("set local session_replication_role = replica");
      for (const tn of tableNames) {
        await tx.unsafe(`delete from public.${tn} where org_id = any($1::uuid[])`, [ids]);
      }
      await tx.unsafe(`delete from public.org where id = any($1::uuid[])`, [ids]);
      if (userIds.length) {
        await tx.unsafe(`delete from public.user_profile where id = any($1::uuid[])`, [userIds]);
        await tx.unsafe(`delete from auth.users where id = any($1::uuid[])`, [userIds]);
      }
      await tx.unsafe("set local session_replication_role = default");
      removedOrgs = ids.length;
      removedUsers = userIds.length;
    });
    console.log(`\nAPPLIED — removed ${removedOrgs} organisation(s) and ${removedUsers} user(s).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Every public table carrying an org_id, for an order-independent wipe. */
async function orgScopedTables(sql: postgres.Sql): Promise<string[]> {
  const rows = (await sql`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'
    order by table_name`) as unknown as Array<{ table_name: string }>;
  return rows.map((t) => t.table_name);
}

function report(classified: Classified[]): void {
  const groups = {
    confirmed_fixture: classified.filter((c) => c.classification === "confirmed_fixture"),
    needs_review: classified.filter((c) => c.classification === "needs_review"),
    simulation: classified.filter((c) => c.classification === "simulation"),
    live: classified.filter((c) => c.classification === "live"),
  };
  console.log(`\n${classified.length} organisation(s) read.\n`);
  console.log(`CONFIRMED FIXTURES — will be deleted (${groups.confirmed_fixture.length}):`);
  for (const c of groups.confirmed_fixture) {
    console.log(`  ${c.id} ${JSON.stringify(c.name)} — ${c.reason}`);
    console.log(`      evidence: ${c.evidence.join(", ") || "NONE"}`);
  }
  for (const [label, rows] of [
    ["NEEDS REVIEW — kept", groups.needs_review],
    ["SEEDED DEMO — kept", groups.simulation],
    ["LIVE — kept", groups.live],
  ] as const) {
    console.log(`\n${label} (${rows.length}):`);
    for (const c of rows) console.log(`  ${c.id} ${JSON.stringify(c.name)} — ${c.reason}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
