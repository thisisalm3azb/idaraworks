/**
 * H25A — read-only production baseline for the Management Studio.
 *
 * Captures the planning-relevant shape of production BEFORE H25 changes
 * anything: how much work, how many tasks and dependencies, what planning
 * artifacts exist. Every statement is a SELECT; table presence is probed via
 * to_regclass so the script is honest on any schema version.
 *
 *   npx tsx tooling/scripts/h25-baseline.ts
 */
import { config } from "dotenv";

config({ path: [".env.local"], quiet: true });

import postgres from "postgres";
import {
  PRODUCTION_PROJECT_REF,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const TABLES = [
  "job",
  "job_stage",
  "task",
  "task_dependency",
  "week_plan",
  "week_plan_job",
  "approval",
  "issue",
  "employee",
  "team",
  "customer",
  "lead",
  "opportunity",
  "quote",
  "invoice",
  "budget",
  "journal_entry",
  "stock_movement",
  "org_holiday_calendar",
] as const;

async function main(): Promise<void> {
  const guard = targetsOnlyProductionProject();
  if (!guard.ok) {
    console.error(`REFUSED: ${guard.problems.join("; ")}`);
    process.exit(2);
  }
  const sql = postgres(process.env.DIRECT_URL ?? "", { max: 1, prepare: false });
  try {
    const [ident] = await sql`
      select current_database() as db, (select count(*)::int from public.org) as orgs`;
    console.log(`# H25 baseline — read-only (${PRODUCTION_PROJECT_REF}, db=${ident!.db})`);
    console.log(`orgs: ${ident!.orgs}`);
    for (const t of TABLES) {
      const [probe] = await sql`select to_regclass(${"public." + t}) is not null as present`;
      if (!probe!.present) {
        console.log(`${t}: (absent)`);
        continue;
      }
      const rows = (await sql.unsafe(`select count(*)::int as n from public.${t}`)) as unknown as Array<{ n: number }>;
      console.log(`${t}: ${rows[0]!.n}`);
    }
    const jobStatus = await sql`
      select status_category, count(*)::int as n from public.job
      group by status_category order by n desc`;
    console.log("job by status_category:", JSON.stringify(jobStatus));
    const taskStatus = await sql`
      select status, count(*)::int as n from public.task group by status order by n desc`;
    console.log("task by status:", JSON.stringify(taskStatus));
    const [deps] = await sql`
      select count(*)::int as live from public.task_dependency where removed_at is null`;
    console.log("live task dependencies:", deps!.live);
    const [dates] = await sql`
      select count(*) filter (where start_date is not null)::int as with_start,
             count(*) filter (where due_date is not null)::int as with_due,
             count(*) filter (where estimated_minutes is not null)::int as with_estimate
      from public.task`;
    console.log("task date/estimate coverage:", JSON.stringify(dates));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
