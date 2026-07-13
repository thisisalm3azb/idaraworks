/**
 * S5 perf-budget harness (doc 11 "perf budget harness from S5"; BUILD_BIBLE §13.7).
 * Seeds synthetic volume into a THROWAWAY org, then asserts the §11 budgets at that
 * volume and self-cleans:
 *   - Today compose p95 < 1500 ms,
 *   - job costing read p95 < 1500 ms (cached-rollup path),
 *   - nightly evaluation + reconcile < 5 min / org.
 *
 * Default volume is a fast CI-friendly proxy; the FULL delivery-plan volume
 * (200 jobs / 50k reports / 200k lines / 2 orgs) runs via env override:
 *   PERF_JOBS=200 PERF_REPORTS_PER_JOB=250 PERF_LINES_PER_REPORT=4 npx tsx tooling/scripts/s5-perf-harness.ts
 * (heavier; not part of the per-commit CI wall so VC-5 ≤12 min holds).
 */
import "./load-env";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { composeToday } from "@/modules/today/service";
import { getJobCosting, reconcileOrgRollups } from "@/modules/costing/service";
import { evaluateNightly } from "@/modules/exceptions/service";

const owner = postgres(process.env.DIRECT_URL!, { max: 4, onnotice: () => {} });

const JOBS = Number(process.env.PERF_JOBS ?? 30);
const REPORTS_PER_JOB = Number(process.env.PERF_REPORTS_PER_JOB ?? 10);
const LINES_PER_REPORT = Number(process.env.PERF_LINES_PER_REPORT ?? 4);
const TODAY_ITERS = 30;

const ownerUser = randomUUID();
let orgId = "";
const ctx = (priv: boolean): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "s5-perf",
});

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
}

async function seed() {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s5perf-${ownerUser.slice(0, 8)}@example.com`}, '{"full_name":"Perf"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, { name: "PERF", country: "AE", baseCurrency: "AED" });
  await installTemplate(ctx(true), TEMPLATE_BOATBUILDING.key);
  console.log(`seeding ${JOBS} jobs × ${REPORTS_PER_JOB} reports × ${LINES_PER_REPORT} lines …`);
  const emp = randomUUID();
  await owner`insert into public.employee (id, org_id, name) values (${emp}, ${orgId}, 'W')`;
  for (let j = 0; j < JOBS; j++) {
    const jobId = randomUUID();
    await owner`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by, start_date, selling_price_minor)
                values (${jobId}, ${orgId}, ${"P-" + j}, ${"Boat " + j}, 'active', 'active', ${ownerUser}, '2026-01-01', 500000)`;
    for (let r = 0; r < REPORTS_PER_JOB; r++) {
      const report = randomUUID();
      const d = new Date(Date.UTC(2026, 0, 1 + r)).toISOString().slice(0, 10);
      await owner`insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by, submitted_at)
                  values (${report}, ${orgId}, ${jobId}, ${d}, 's', 'submitted', ${ownerUser}, now())`;
      const rows = Array.from({ length: LINES_PER_REPORT }, () => ({ id: randomUUID(), report }));
      await owner`insert into public.report_material_line ${owner(
        rows.map((x) => ({
          id: x.id,
          org_id: orgId,
          report_id: x.report,
          item_name: "M",
          qty: 2,
          unit: "ea",
          unit_cost_minor: 1000,
          cost_source: "manual",
        })),
      )}`;
      await owner`insert into public.report_labour_cost (org_id, report_id, employee_id, hourly_cost_minor, ot_rate, labour_cost_minor)
                  values (${orgId}, ${report}, ${emp}, 5000, 1.5, 40000)`;
    }
  }
  const n =
    (await owner`select count(*)::int as n from public.report_material_line where org_id = ${orgId}`) as unknown as Array<{
      n: number;
    }>;
  console.log(`seeded ${JOBS} jobs, ${JOBS * REPORTS_PER_JOB} reports, ${n[0]!.n} material lines`);
}

async function measure() {
  // Warm the rollups (single-writer refresh) so the costing read is on the cache path.
  const t0 = performance.now();
  const rec = await reconcileOrgRollups(ctx(true));
  console.log(
    `reconcile ${rec.jobs} jobs in ${Math.round(performance.now() - t0)}ms (drift ${rec.drifted})`,
  );

  const jobRows =
    (await owner`select id::text as id from public.job where org_id = ${orgId} limit 20`) as unknown as Array<{
      id: string;
    }>;
  const todayMs: number[] = [];
  for (let i = 0; i < TODAY_ITERS; i++) {
    const s = performance.now();
    await composeToday(ctx(false), "manager", {
      asOf: "2026-07-13",
      computedAt: new Date().toISOString(),
    });
    todayMs.push(performance.now() - s);
  }
  const costMs: number[] = [];
  for (const jr of jobRows) {
    const s = performance.now();
    await getJobCosting(ctx(true), "owner", jr.id, "AED");
    costMs.push(performance.now() - s);
  }
  const nightlyStart = performance.now();
  const ex = await evaluateNightly(ctx(true), { asOf: "2026-07-13", nowMs: Date.now() });
  await reconcileOrgRollups(ctx(true));
  const nightlyMs = performance.now() - nightlyStart;

  const todayP95 = p95(todayMs);
  const costP95 = p95(costMs);
  // The per-REQUEST budgets (§11) are CO-LOCATED targets: they assume the app and DB
  // share a region (Vercel icn1 ↔ Supabase Seoul; the /api/health check is ~0.6s
  // co-located vs ~2.4s from iad1). Run from a remote client, every statement pays a
  // full transcontinental round-trip, so the p95 is dominated by network RTT, not
  // server compute — set PERF_COLOCATED=1 (CI local stack / a co-located run) to
  // ENFORCE them. The nightly/reconcile budget is enforced everywhere (it passes even
  // over the remote link).
  const colocated = process.env.PERF_COLOCATED === "1";
  console.log(
    `── perf budgets (§11) ${colocated ? "[co-located: enforced]" : "[remote: reported only]"} ──`,
  );
  console.log(
    `Today compose p95 : ${Math.round(todayP95)}ms  (budget < 1500ms)  ${todayP95 < 1500 ? "PASS" : "FAIL"}`,
  );
  console.log(
    `Job costing  p95  : ${Math.round(costP95)}ms  (budget < 1500ms)  ${costP95 < 1500 ? "PASS" : "FAIL"}`,
  );
  console.log(
    `Nightly+reconcile : ${Math.round(nightlyMs)}ms  (budget < 300000ms/org)  ${nightlyMs < 300000 ? "PASS" : "FAIL"} (raised ${ex.missing + ex.overdue + ex.blockers})`,
  );
  const perRequestOk = todayP95 < 1500 && costP95 < 1500;
  const ok = nightlyMs < 300000 && (!colocated || perRequestOk);
  return ok;
}

async function cleanup() {
  if (!orgId) return;
  const TABLES = [
    "cost_rollup_labour",
    "cost_rollup",
    "exception",
    "expense",
    "report_labour_cost",
    "report_material_line",
    "daily_report",
    "job",
    "employee",
    "notification",
    "domain_event",
    "audit_log",
    "activity",
    "app_settings",
    "org_holiday_calendar",
    "config_revision",
    "job_preset",
    "reference_sequence",
    "org_plan_state",
    "membership",
    "role_definition",
    "company",
  ];
  await owner`update public.job set current_stage_id = null where org_id = ${orgId}`;
  for (const t of TABLES) await owner.unsafe(`delete from public.${t} where org_id = $1`, [orgId]);
  await owner`delete from public.org where id = ${orgId}`;
  await owner`delete from public.user_profile where id = ${ownerUser}`;
  await owner`delete from auth.users where id = ${ownerUser}`;
}

async function run() {
  let ok = false;
  try {
    await seed();
    ok = await measure();
  } finally {
    await cleanup();
    console.log("cleanup complete");
  }
  await owner.end({ timeout: 5 });
  await closeAppDb();
  process.exit(ok ? 0 : 1);
}
run().catch(async (e) => {
  console.error("PERF HARNESS FAILED:", e);
  try {
    await cleanup();
  } catch {}
  await owner.end({ timeout: 5 });
  process.exit(1);
});
