/**
 * H25 deployment pre-flight — READ ONLY.
 *
 * Migrations 0107–0113 are additive except for three statements in 0107 that
 * touch rows production already holds: two CHECK constraints are widened
 * (approval.subject_type and approval_rule.subject_type gain the studio
 * subjects; task_dependency.kind gains SS/FF/SF) and one index is rebuilt with
 * a wider status list. A widened CHECK can only fail if a live row already
 * violates the NEW list, which would mean data outside the old list too. This
 * asks production, before anything is applied, whether every existing value is
 * inside the lists the migration files declare, and reports what would stop
 * them if not. It also confirms the prerequisites the later files assume
 * (the app schema, the realtime.messages table, no studio tables yet, the
 * exact pending list).
 *
 * It never writes. Every statement is a SELECT.
 *
 *   npx tsx tooling/scripts/h25-deploy-preflight.ts
 */
import { config } from "dotenv";
config({ path: [".env.local"], quiet: true });
import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import {
  PRODUCTION_PROJECT_REF,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const MIG = path.join(process.cwd(), "supabase", "migrations");
const EXPECTED_PENDING = [
  "0107_h25b_planning_graph.sql",
  "0108_h25b_link_node.sql",
  "0109_h25g_node_estimates.sql",
  "0110_h25h_skills_allocations.sql",
  "0111_h25l_realtime_channels.sql",
  "0112_h25l_channel_membership_fn.sql",
  "0113_h25c_view_removal.sql",
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

    // 1. Pending list is exactly the H25 files, in order.
    const done = new Set(
      ((await sql`select filename from app.migrations`) as Array<{ filename: string }>).map(
        (r) => r.filename,
      ),
    );
    const pending = EXPECTED_PENDING.filter((f) => !done.has(f));
    const unexpected = [...done].filter(
      (f) => f.slice(0, 4) > "0106" && !EXPECTED_PENDING.includes(f),
    );
    report(
      "pending migrations are exactly 0107–0113",
      pending.length === EXPECTED_PENDING.length && unexpected.length === 0,
      `pending=${pending.length} unexpected=${unexpected.join(",") || "none"}`,
    );

    // 2. Widened CHECKs: every live value must be inside the NEW list.
    const subjects = checkList("0107_h25b_planning_graph.sql", "subject_type");
    const badApprovals = (await sql`
      select subject_type, count(*)::int as n from public.approval
      where subject_type <> all(${subjects}::text[]) group by 1`) as Array<{
      subject_type: string;
      n: number;
    }>;
    report(
      "approval.subject_type values fit the widened CHECK",
      badApprovals.length === 0,
      badApprovals.map((r) => `${r.subject_type}×${r.n}`).join(", ") ||
        `${subjects.length} allowed`,
    );
    const badRules = (await sql`
      select subject_type, count(*)::int as n from public.approval_rule
      where subject_type <> all(${subjects}::text[]) group by 1`) as Array<{
      subject_type: string;
      n: number;
    }>;
    report(
      "approval_rule.subject_type values fit the widened CHECK",
      badRules.length === 0,
      badRules.map((r) => `${r.subject_type}×${r.n}`).join(", ") || "none outside",
    );
    const kinds = checkList("0107_h25b_planning_graph.sql", "kind");
    const badKinds = (await sql`
      select kind, count(*)::int as n from public.task_dependency
      where kind <> all(${kinds}::text[]) group by 1`) as Array<{ kind: string; n: number }>;
    report(
      "task_dependency.kind values fit the widened CHECK",
      badKinds.length === 0,
      badKinds.map((r) => `${r.kind}×${r.n}`).join(", ") || `${kinds.join("/")}`,
    );

    // 3. Prerequisites of the later files.
    const app = (await sql`select to_regclass('app.migrations') as t`)[0]!.t;
    report("app schema present (definer functions land there)", app !== null);
    const rt = (await sql`select to_regclass('realtime.messages') as t`)[0]!.t;
    const rtRls = (
      await sql`select relrowsecurity from pg_class where oid = 'realtime.messages'::regclass`
    )[0]?.relrowsecurity;
    report(
      "realtime.messages exists with RLS enabled (0111/0112 policies)",
      rt !== null && rtRls === true,
    );
    const studioTables = (
      await sql`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name like 'studio\\_%'`
    )[0]!.n;
    report(
      "no studio tables exist yet (0107 creates them)",
      Number(studioTables) === 0,
      `${studioTables} found`,
    );
    const planTable = (await sql`select to_regclass('public.plan') as t`)[0]!.t;
    report("billing public.plan present (entitlement rows reference it)", planTable !== null);
    const idx = (await sql`select to_regclass('public.task_org_due_idx') as t`)[0]!.t;
    report("task_org_due_idx exists to be rebuilt", idx !== null);

    // 4. Baseline facts the report cites (read only).
    const counts = (
      await sql`
      select (select count(*) from public.org) as orgs,
             (select count(*) from public.task) as tasks,
             (select count(*) from public.task_dependency) as deps,
             (select count(*) from public.employee) as employees,
             (select count(*) from public.approval) as approvals`
    )[0]!;
    console.log(`baseline: ${JSON.stringify(counts)}`);

    console.log(
      problems === 0 ? "\nPRE-FLIGHT CLEAR" : `\nPRE-FLIGHT: ${problems} problem(s) — do not apply`,
    );
    if (problems > 0) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
