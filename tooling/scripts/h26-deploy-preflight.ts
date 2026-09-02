/**
 * H26 deployment pre-flight — READ ONLY.
 *
 * Migrations 0114–0119 are additive (new doc_* tables, functions, policies,
 * entitlement rows) except for two statements that touch rows production
 * already holds: 0114 widens public.file's access_class CHECK (adds
 * 'document_file') and 0116 widens approval.subject_type / approval_rule
 * .subject_type (adds 'document_step'). A widened CHECK can only fail if a live
 * row already sits outside the NEW list, so this asks production whether every
 * existing value is inside the lists the migration files declare, confirms the
 * prerequisites the files assume (the app schema and its helpers, no doc_*
 * tables yet, the exact pending list), and prints the baseline counts the
 * post-deployment proof compares against.
 *
 * It never writes. Every statement is a SELECT.
 *
 *   npx tsx tooling/scripts/h26-deploy-preflight.ts
 */
import { config } from "dotenv";
config({ path: [".env.local"], quiet: true });
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import {
  PRODUCTION_PROJECT_REF,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const MIG = path.join(process.cwd(), "supabase", "migrations");
export const H26_MIGRATIONS = [
  "0114_h26a_document_foundation.sql",
  "0115_h26a_terminated_check.sql",
  "0116_h26d_workflow_runs.sql",
  "0117_h26f_signature_room.sql",
  "0118_h26g_forms.sql",
  "0119_h26h_obligations.sql",
];
const DOC_TABLES = [
  "doc_folder",
  "doc_workflow",
  "doc_template",
  "doc_template_version",
  "doc_document",
  "doc_revision",
  "doc_snapshot",
  "doc_event",
  "doc_comment",
  "doc_saved_view",
  "doc_workflow_run",
  "doc_workflow_step_run",
  "doc_signature_request",
  "doc_signer",
  "doc_form_link",
  "doc_form_submission",
  "doc_obligation",
];

/** Pull the quoted list out of `check (<col> in ('a', 'b', …))` in a migration file. */
function checkList(file: string, column: string): string[] {
  const sql = readFileSync(path.join(MIG, file), "utf8");
  const re = new RegExp(`${column}\\s+in\\s*\\(([^)]*)\\)`, "i");
  const m = sql.match(re);
  if (!m) throw new Error(`${file}: no CHECK list for ${column}`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

async function main(): Promise<void> {
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    console.error("Refusing: the environment does not point only at production:");
    for (const p of target.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const sql = postgres(process.env.DIRECT_URL!, {
    max: 1,
    connect_timeout: 60,
    onnotice: () => {},
  });
  let problems = 0;
  const report = (what: string, ok: boolean, detail = "") => {
    if (!ok) problems++;
    console.log(`  ${ok ? "ok " : "STOP"}: ${what}${detail ? ` (${detail})` : ""}`);
  };
  try {
    const db = (await sql`select current_database() as db, current_user as u`)[0]!;
    console.log(`pre-flight on ${PRODUCTION_PROJECT_REF}: db=${db.db} user=${db.u}`);

    // 1. Exactly the six H26 files are pending; nothing else after 0113.
    const applied = (await sql`
      select filename as name from app.migrations`) as unknown as Array<{
      name: string;
    }>;
    const done = new Set(applied.map((r) => r.name));
    const files = readdirSync(MIG)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const pending = files.filter((f) => !done.has(f.replace(/\.sql$/, "")) && !done.has(f));
    const unexpected = pending.filter((f) => !H26_MIGRATIONS.includes(f));
    const missing = H26_MIGRATIONS.filter((f) => !pending.includes(f));
    report(
      "pending = exactly 0114..0119",
      unexpected.length === 0 && missing.length === 0,
      `pending=${pending.length} applied=${applied.length} unexpected=[${unexpected.join(",")}] missing=[${missing.join(",")}]`,
    );

    // 2. Widened CHECKs: every live value already inside the new lists.
    const access = checkList("0114_h26a_document_foundation.sql", "access_class");
    const liveAccess = (await sql`
      select distinct access_class as v from public.file`) as unknown as Array<{ v: string }>;
    const badAccess = liveAccess.map((r) => r.v).filter((v) => !access.includes(v));
    report(
      "file.access_class values inside the 0114 list",
      badAccess.length === 0,
      `live=[${liveAccess.map((r) => r.v).join(",")}] new=[${access.join(",")}]`,
    );
    const subjects = checkList("0116_h26d_workflow_runs.sql", "subject_type");
    for (const table of ["approval", "approval_rule"]) {
      const live = (await sql.unsafe(
        `select distinct subject_type as v from public.${table}`,
      )) as unknown as Array<{ v: string }>;
      const bad = live.map((r) => r.v).filter((v) => !subjects.includes(v));
      report(
        `${table}.subject_type values inside the 0116 list`,
        bad.length === 0,
        `live=[${live.map((r) => r.v).join(",")}]`,
      );
    }

    // 3. Prerequisites the files assume.
    const helpers = (await sql`
      select
        to_regprocedure('app.set_updated_at()') is not null as touch,
        to_regprocedure('app.assert_platform_task()') is not null as platform,
        to_regprocedure('app.current_org_id()') is not null as org,
        to_regprocedure('app.current_user_id()') is not null as usr,
        to_regclass('public.approval') is not null as approval,
        to_regclass('public.file') is not null as file,
        to_regclass('public.notification') is not null as notification,
        to_regclass('public.entitlement_def') is not null as entitlement_def,
        to_regclass('public.plan_entitlement') is not null as plan_entitlement,
        not exists (select 1 from public.entitlement_def where key = 'cap.documents') as cap_documents_absent
    `) as unknown as Array<Record<string, boolean>>;
    for (const [k, v] of Object.entries(helpers[0]!)) report(`prerequisite ${k}`, v);
    const existing = (await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name like 'doc\\_%'`) as unknown as Array<{
      table_name: string;
    }>;
    report(
      "no doc_* tables yet",
      existing.length === 0,
      `found=[${existing.map((r) => r.table_name).join(",")}]`,
    );

    // 4. Baseline counts the post-deployment proof compares against.
    const base = (await sql`
      select (select count(*) from public.org) as orgs,
             (select count(*) from auth.users) as users,
             (select count(*) from public.job) as jobs,
             (select count(*) from public.quote) as quotes,
             (select count(*) from public.invoice) as invoices,
             (select count(*) from public.approval) as approvals,
             (select count(*) from public.file) as files`) as unknown as Array<
      Record<string, string>
    >;
    console.log(`baseline: ${JSON.stringify(base[0])}`);
    console.log(`expected after deploy: ${DOC_TABLES.length} doc_* tables, all empty`);
    console.log(problems === 0 ? "\nPRE-FLIGHT CLEAR" : `\nPRE-FLIGHT: ${problems} problem(s)`);
    if (problems > 0) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
