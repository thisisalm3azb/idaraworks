/**
 * H27 deployment pre-flight — READ ONLY.
 *
 * Migrations 0120–0127 are additive (19 new crm_* tables, columns on
 * customer / customer_contact / lead / opportunity / sales_activity /
 * pipeline_stage, functions, policies, grants, entitlement rows) except for
 * the statements that touch rows production already holds: 0120 widens
 * approval.subject_type and approval_rule.subject_type (adds 'crm_discount')
 * and sales_activity.kind (adds the H27 kinds) and replaces the sales_activity
 * subject CHECK (a customer-only activity is now allowed); 0125 widens
 * import_batch.kind (adds contacts / leads / opportunities). A widened CHECK
 * can only fail if a live row already sits outside the NEW list, so this asks
 * production whether every existing value is inside the lists the migration
 * files declare, confirms the prerequisites the files assume, checks the
 * exact pending list, and prints the baseline counts the post-deployment
 * proof compares against.
 *
 * It never writes. Every statement is a SELECT.
 *
 *   npx tsx tooling/scripts/h27-deploy-preflight.ts
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
export const H27_MIGRATIONS = [
  "0120_h27a_revenue_foundation.sql",
  "0121_h27b_opportunity_context.sql",
  "0122_h27c_consent_attribution.sql",
  "0123_h27d_forecast_targets.sql",
  "0124_h27e_success_merge_automation.sql",
  "0125_h27f_merge_grants_imports.sql",
  "0126_h27f_automation_run_update_policy.sql",
  "0127_h27g_automation_sweep_discovery.sql",
];
export const CRM_TABLES = [
  "crm_territory",
  "crm_pipeline",
  "crm_campaign",
  "crm_opportunity_stakeholder",
  "crm_opportunity_product",
  "crm_opportunity_competitor",
  "crm_opportunity_risk",
  "crm_discount",
  "crm_deal_canvas",
  "crm_consent",
  "crm_suppression",
  "crm_touch",
  "crm_forecast_snapshot",
  "crm_scenario",
  "crm_target",
  "crm_customer_signal",
  "crm_merge",
  "crm_automation",
  "crm_automation_run",
];

/** Pull the quoted list out of the FIRST `check (<col> in ('a', 'b', …))` after `alter table public.<table>` in a migration file. */
function checkList(file: string, table: string, column: string): string[] {
  const sql = readFileSync(path.join(MIG, file), "utf8");
  const start = sql.indexOf(`alter table public.${table}\n`);
  const from = start >= 0 ? sql.indexOf(`${column}`, start) : -1;
  const scope = from >= 0 ? sql.slice(from) : sql;
  const re = new RegExp(`${column}\\s+in\\s*\\(([^)]*)\\)`, "i");
  const m = scope.match(re);
  if (!m) throw new Error(`${file}: no CHECK list for ${table}.${column}`);
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

    // 1. Exactly the eight H27 files are pending; nothing else after 0119.
    const applied = (await sql`
      select filename as name from app.migrations`) as unknown as Array<{ name: string }>;
    const done = new Set(applied.map((r) => r.name));
    const files = readdirSync(MIG)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const pending = files.filter((f) => !done.has(f.replace(/\.sql$/, "")) && !done.has(f));
    const unexpected = pending.filter((f) => !H27_MIGRATIONS.includes(f));
    const missing = H27_MIGRATIONS.filter((f) => !pending.includes(f));
    report(
      "pending = exactly 0120..0127",
      unexpected.length === 0 && missing.length === 0,
      `pending=${pending.length} applied=${applied.length} unexpected=[${unexpected.join(",")}] missing=[${missing.join(",")}]`,
    );

    // 2. Widened CHECKs: every live value already inside the new lists.
    for (const table of ["approval", "approval_rule"]) {
      const list = checkList("0120_h27a_revenue_foundation.sql", table, "subject_type");
      const live = (await sql.unsafe(
        `select distinct subject_type as v from public.${table}`,
      )) as unknown as Array<{ v: string }>;
      const bad = live.map((r) => r.v).filter((v) => !list.includes(v));
      report(
        `${table}.subject_type values inside the 0120 list`,
        bad.length === 0 && list.includes("crm_discount"),
        `live=[${live.map((r) => r.v).join(",")}] bad=[${bad.join(",")}]`,
      );
    }
    const kinds = checkList("0120_h27a_revenue_foundation.sql", "sales_activity", "kind");
    const liveKinds = (await sql`
      select distinct kind as v from public.sales_activity`) as unknown as Array<{ v: string }>;
    const badKinds = liveKinds.map((r) => r.v).filter((v) => !kinds.includes(v));
    report(
      "sales_activity.kind values inside the 0120 list",
      badKinds.length === 0,
      `live=[${liveKinds.map((r) => r.v).join(",")}] bad=[${badKinds.join(",")}]`,
    );
    const orphanActivities = (await sql`
      select count(*)::int as n from public.sales_activity where lead_id is null and opportunity_id is null`) as unknown as Array<{
      n: number;
    }>;
    report(
      "every live sales_activity has a lead or an opportunity (new subject CHECK adds customer)",
      Number(orphanActivities[0]!.n) === 0,
      `orphans=${orphanActivities[0]!.n}`,
    );
    const importKinds = checkList("0125_h27f_merge_grants_imports.sql", "import_batch", "kind");
    const liveImportKinds = (await sql`
      select distinct kind as v from public.import_batch`) as unknown as Array<{ v: string }>;
    const badImport = liveImportKinds.map((r) => r.v).filter((v) => !importKinds.includes(v));
    report(
      "import_batch.kind values inside the 0125 list",
      badImport.length === 0,
      `live=[${liveImportKinds.map((r) => r.v).join(",")}]`,
    );

    // 3. Prerequisites the files assume.
    const helpers = (await sql`
      select
        to_regprocedure('app.set_updated_at()') is not null as touch,
        to_regprocedure('app.assert_platform_task()') is not null as platform,
        to_regprocedure('app.current_org_id()') is not null as org,
        to_regprocedure('app.current_user_id()') is not null as usr,
        to_regclass('public.approval') is not null as approval,
        to_regclass('public.customer') is not null as customer,
        to_regclass('public.customer_contact') is not null as customer_contact,
        to_regclass('public.lead') is not null as lead,
        to_regclass('public.opportunity') is not null as opportunity,
        to_regclass('public.sales_activity') is not null as sales_activity,
        to_regclass('public.pipeline_stage') is not null as pipeline_stage,
        to_regclass('public.doc_document') is not null as doc_document,
        to_regclass('public.doc_obligation') is not null as doc_obligation,
        to_regclass('public.import_batch') is not null as import_batch,
        to_regclass('public.entitlement_def') is not null as entitlement_def,
        to_regclass('public.plan_entitlement') is not null as plan_entitlement,
        not exists (select 1 from public.entitlement_def where key = 'cap.revenue_studio') as cap_revenue_absent
    `) as unknown as Array<Record<string, boolean>>;
    for (const [k, v] of Object.entries(helpers[0]!)) report(`prerequisite ${k}`, v);
    const existing = (await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name like 'crm\\_%'`) as unknown as Array<{
      table_name: string;
    }>;
    report(
      "no crm_* tables yet",
      existing.length === 0,
      `found=[${existing.map((r) => r.table_name).join(",")}]`,
    );
    const stageCols = (await sql`
      select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name = 'pipeline_stage' and column_name = 'pipeline_id'`) as unknown as Array<{
      n: number;
    }>;
    report("pipeline_stage.pipeline_id not present yet", Number(stageCols[0]!.n) === 0);

    // 4. Baseline counts the post-deployment proof compares against.
    const base = (await sql`
      select (select count(*) from public.org) as orgs,
             (select count(*) from auth.users) as users,
             (select count(*) from public.customer) as customers,
             (select count(*) from public.lead) as leads,
             (select count(*) from public.opportunity) as opportunities,
             (select count(*) from public.sales_activity) as activities,
             (select count(*) from public.pipeline_stage) as stages,
             (select count(*) from public.job) as jobs,
             (select count(*) from public.quote) as quotes,
             (select count(*) from public.invoice) as invoices,
             (select count(*) from public.approval) as approvals`) as unknown as Array<
      Record<string, string>
    >;
    console.log(`baseline: ${JSON.stringify(base[0])}`);
    console.log(
      `expected after deploy: ${CRM_TABLES.length} crm_* tables (crm_pipeline filled lazily on first write), every stage row keeps its key; counts above unchanged`,
    );
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
