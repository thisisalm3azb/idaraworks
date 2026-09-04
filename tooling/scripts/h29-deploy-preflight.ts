/**
 * H29 — read-only production pre-flight. Every statement is a SELECT: it proves
 * the target is production, that the pending migrations are exactly H29's, that
 * nothing H29 adds already exists, that the prerequisites are present, that no
 * country pack, establishment or electronic-invoicing channel is live, and it
 * prints the baseline counts the post-deploy proof compares against.
 *
 *   npx tsx tooling/scripts/h29-deploy-preflight.ts
 */
import { config } from "dotenv";
config({ path: [".env.local"], quiet: true });
import postgres from "postgres";
import {
  PRODUCTION_PROJECT_REF,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const H29_MIGRATIONS = [
  "0130_h29a_country_packs_establishments.sql",
  "0131_h29b_einvoicing_privacy.sql",
  "0132_h29c_locale_release.sql",
  "0133_h29e_country_pack_rows.sql",
];

const NEW_TABLES = [
  "country_pack",
  "country_pack_review",
  "establishment",
  "establishment_registration",
  "establishment_pack_adoption",
  "establishment_privacy",
  "einvoice_channel",
  "einvoice_document",
  "einvoice_event",
  "locale_release",
];

/** Tables H29 depends on. A missing one means the deployment is not where it thinks it is. */
const PREREQUISITES = [
  "org",
  "membership",
  "user_profile",
  "role_definition",
  "audit_log",
  "platform_audit",
  "platform_operator",
  "invoice",
  "journal_entry",
];

async function main(): Promise<void> {
  const problems: string[] = [];
  const notes: string[] = [];
  // .ok, not the verdict object: a truthy object made this guard vacuous,
  // so it could never refuse anything (H29, found by CI).
  const target = targetsOnlyProductionProject({ ...process.env } as Record<
    string,
    string | undefined
  >);
  if (!target.ok) {
    console.error(`Refusing: the environment does not point only at ${PRODUCTION_PROJECT_REF}`);
    for (const p of target.problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  const sql = postgres(process.env.DIRECT_URL!, { max: 1, prepare: false });
  try {
    const applied = (await sql`select filename from app.migrations order by filename`).map((r) =>
      String(r.filename),
    );
    const pending = H29_MIGRATIONS.filter((f) => !applied.includes(f));
    notes.push(`applied migrations: ${applied.length}`);
    notes.push(
      `H29 pending: ${pending.length === 0 ? "none (already applied)" : pending.join(", ")}`,
    );
    // `>= "0130"` and not `> "0129..."`: comparing against the last H28 file
    // name would exclude a file that sorts equal to it, which is how the H28
    // pre-flight briefly flagged its own last migration.
    const unexpected = applied.filter((f) => f >= "0130" && !H29_MIGRATIONS.includes(f));
    if (unexpected.length)
      problems.push(`unexpected migrations at or after 0130: ${unexpected.join(", ")}`);

    const tables = (
      await sql`
      select table_name from information_schema.tables where table_schema = 'public'
        and table_name = any(string_to_array(${NEW_TABLES.join(",")}, ','))`
    ).map((r) => String(r.table_name));
    if (pending.length === H29_MIGRATIONS.length && tables.length > 0)
      problems.push(`tables already exist before the migration: ${tables.join(", ")}`);
    notes.push(`H29 tables present: ${tables.length}/${NEW_TABLES.length}`);

    const publicTables = new Set(
      (
        await sql`select table_name from information_schema.tables where table_schema = 'public'`
      ).map((r) => String(r.table_name)),
    );
    const missing = PREREQUISITES.filter((t) => !publicTables.has(t));
    if (missing.length) problems.push(`missing prerequisite tables: ${missing.join(", ")}`);

    // Nothing H29-shaped may already carry live data.
    for (const table of ["establishment", "einvoice_document", "einvoice_channel"]) {
      if (!publicTables.has(table)) continue;
      const n = Number(
        (await sql.unsafe(`select count(*)::int as n from public.${table}`))[0]!.n as number,
      );
      if (n > 0) problems.push(`${table} already holds ${n} row(s)`);
    }

    // The release flags must be OFF on the deployment before the migration, so
    // the screens cannot appear the moment the tables do.
    for (const flag of ["FEATURE_COUNTRY_PACKS", "FEATURE_LOCALE_ES"]) {
      const value = process.env[flag];
      notes.push(`${flag} locally: ${value === undefined ? "unset (expected)" : `"${value}"`}`);
      if (value !== undefined && value !== "1" && value !== "0")
        problems.push(`${flag} is set to "${value}"; the only enabling value is the exact "1"`);
    }

    const counts = (
      await sql`
      select
        (select count(*) from public.org)::int as orgs,
        (select count(*) from auth.users)::int as users,
        (select count(*) from public.customer)::int as customers,
        (select count(*) from public.job)::int as jobs,
        (select count(*) from public.invoice)::int as invoices,
        (select count(*) from public.approval)::int as approvals,
        (select count(*) from public.audit_log)::int as audit_rows,
        (select count(*) from public.platform_audit)::int as platform_audit_rows`
    )[0]!;
    notes.push(
      `baseline: orgs ${counts.orgs}, users ${counts.users}, customers ${counts.customers}, ` +
        `jobs ${counts.jobs}, invoices ${counts.invoices}, approvals ${counts.approvals}, ` +
        `audit ${counts.audit_rows}, platform_audit ${counts.platform_audit_rows}`,
    );

    console.log("H29 PRE-FLIGHT — production");
    for (const n of notes) console.log(`  ${n}`);
    if (problems.length === 0) {
      console.log(`CLEAR — safe to apply ${H29_MIGRATIONS.join(", ")}.`);
    } else {
      console.log("PROBLEMS:");
      for (const p of problems) console.log(`  ! ${p}`);
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
