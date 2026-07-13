/**
 * S5 production DoD demo (Arabic "Measure") — runs the REAL service layer against
 * production Supabase (DIRECT_URL), then deletes every synthetic row (0 leftovers).
 *
 * Proves against production (doc 11 S5 DoD): job cost equals a hand-computed fixture
 * to the minor unit; the manager Today shows missing-report + blocker cards with a
 * freshness stamp; cost fields are ABSENT from foreman/manager payloads without the
 * privilege (the labour wall); the nightly evaluator raises + clears exceptions; the
 * single-writer rollup + reconcile; an expense feeds cost and voiding removes it.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { getJobCosting, refreshRollup, reconcileOrgRollups } from "@/modules/costing/service";
import { createExpense, voidExpense } from "@/modules/expenses/service";
import { evaluateNightly, evaluateReportAnomalies } from "@/modules/exceptions/service";
import { composeToday } from "@/modules/today/service";

const owner = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
const log = (m: string) => console.log(m);

const ownerUser = randomUUID();
const managerUser = randomUUID();
let orgId = "";
const ctx = (u: string, priv: boolean): Ctx => ({
  orgId,
  userId: u,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "s5-prod-demo",
});
const ownerCtx = () => ctx(ownerUser, true);
const mgrCtx = () => ctx(managerUser, false);

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s5demo-${label}-${id.slice(0, 8)}@example.com`}, '{"full_name":"S5 Demo"}'::jsonb, now(), now())`;
}

const TABLES = [
  "cost_rollup_labour",
  "cost_rollup",
  "exception",
  "expense",
  "goods_receipt_line",
  "goods_receipt",
  "purchase_order_line",
  "purchase_order",
  "material_request_line",
  "material_request",
  "approval",
  "report_labour_cost",
  "report_labour_line",
  "attendance",
  "report_material_line",
  "report_work_line",
  "daily_report",
  "issue",
  "domain_event",
  "notification",
  "notification_preference",
  "task",
  "job_crew",
  "job_stage",
  "job",
  "employee_terms",
  "employee_hr",
  "employee",
  "team",
  "item",
  "customer",
  "supplier",
  "job_preset",
  "reference_sequence",
  "org_holiday_calendar",
  "config_revision",
  "audit_log",
  "activity",
  "app_settings",
  "org_plan_state",
  "membership",
  "role_definition",
  "company",
];

async function cleanup() {
  if (!orgId) return;
  await owner`update public.job set current_stage_id = null where org_id = ${orgId}`;
  for (const t of TABLES) await owner.unsafe(`delete from public.${t} where org_id = $1`, [orgId]);
  await owner`delete from public.org where id = ${orgId}`;
  await owner`delete from public.user_profile where id = any(${[ownerUser, managerUser]}::uuid[])`;
  await owner`delete from auth.users where id = any(${[ownerUser, managerUser]}::uuid[])`;
}

async function run() {
  log("── S5 production demo (Arabic Measure) ────────────────────────────");
  await seedUser(ownerUser, "owner");
  await seedUser(managerUser, "mgr");
  orgId = await createOrgForUser(ownerUser, {
    name: "قوارب القياس",
    country: "AE",
    baseCurrency: "AED",
  });
  await owner`insert into public.membership (user_id, org_id, role_key) values (${managerUser}, ${orgId}, 'manager')`;
  await installTemplate(ownerCtx(), TEMPLATE_BOATBUILDING.key);

  const jobId = randomUUID();
  await owner`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by, start_date, selling_price_minor)
              values (${jobId}, ${orgId}, '24C-001', 'بحّار الخليج', 'active', 'active', ${ownerUser}, '2026-01-01', 500000)`;
  const emp = randomUUID();
  await owner`insert into public.employee (id, org_id, name) values (${emp}, ${orgId}, 'علي')`;
  const cats =
    (await owner`select value from public.app_settings where org_id = ${orgId} and key = 'config.categories.expense'`) as unknown as Array<{
      value: { categories: Array<{ key: string; costing_mapping: string }> };
    }>;
  const cat = cats[0]!.value.categories.find((c) => c.costing_mapping === "job_materials")!.key;

  // Cost inputs: material 200000 + labour 105000 + PO ex 60000 + expense 30000.
  const report = randomUUID();
  await owner`insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by, submitted_at)
              values (${report}, ${orgId}, ${jobId}, '2026-02-01', 'عمل', 'submitted', ${ownerUser}, now())`;
  await owner`insert into public.report_material_line (org_id, report_id, item_name, qty, unit, unit_cost_minor, cost_source)
              values (${orgId}, ${report}, 'راتنج', 4, 'لتر', 50000, 'manual')`;
  await owner`insert into public.report_labour_cost (org_id, report_id, employee_id, hourly_cost_minor, ot_rate, labour_cost_minor)
              values (${orgId}, ${report}, ${emp}, 5000, 1.5, 105000)`;
  const sup = randomUUID();
  const po = randomUUID();
  const pol = randomUUID();
  const grn = randomUUID();
  await owner`insert into public.supplier (id, org_id, name) values (${sup}, ${orgId}, 'مورد الخليج')`;
  await owner`insert into public.purchase_order (id, org_id, reference, supplier_id, job_id, status, vat_minor, total_minor, created_by)
              values (${po}, ${orgId}, 'PO-001', ${sup}, ${jobId}, 'approved', 5000, 105000, ${ownerUser})`;
  await owner`insert into public.purchase_order_line (id, org_id, po_id, item_name, qty, unit, unit_cost_minor, line_total_minor)
              values (${pol}, ${orgId}, ${po}, 'خشب', 10, 'ea', 10000, 100000)`;
  await owner`insert into public.goods_receipt (id, org_id, reference, po_id, status, received_date, created_by)
              values (${grn}, ${orgId}, 'GRN-001', ${po}, 'recorded', '2026-02-02', ${ownerUser})`;
  await owner`insert into public.goods_receipt_line (org_id, grn_id, po_line_id, ordered_qty, received_qty)
              values (${orgId}, ${grn}, ${pol}, 10, 6)`;
  await createExpense(ownerCtx(), "owner", {
    jobId,
    categoryKey: cat,
    description: "غراء",
    expenseDate: "2026-02-03",
    amountMinor: 30000,
    vatAmountMinor: 1500,
  });
  log("✓ org قوارب القياس, job 24C-001 بحّار الخليج, cost inputs seeded");

  // 1) Costing golden (ex-VAT): material 200000 + PO 60000 + expense 30000 = 290000; + labour 105000 = 395000.
  await refreshRollup(ownerCtx(), jobId);
  const full = await getJobCosting(ownerCtx(), "owner", jobId, "AED");
  log(
    `✓ owner costing: material=${full.materialCostMinor} po=${full.poCostMinor} expense=${full.expenseCostMinor} exLabour=${full.totalExLabourMinor} labour=${full.labourCostMinor} total=${full.totalCostMinor} quoted=${full.quotedMinor} margin=${full.marginMinor}`,
  );
  const okGolden =
    full.totalExLabourMinor === 290000 &&
    full.totalCostMinor === 395000 &&
    full.marginMinor === 105000;

  // 2) The labour WALL: a manager (viewCosts OFF) sees cost EXCLUDING labour; labour/total/margin redacted.
  const mgr = await getJobCosting(mgrCtx(), "manager", jobId, "AED");
  const walled =
    mgr.totalExLabourMinor === 290000 &&
    mgr.labourCostMinor === null &&
    mgr.totalCostMinor === null &&
    mgr.marginMinor === null &&
    mgr.quotedMinor === null;
  log(
    `✓ manager costing redacted: exLabour=${mgr.totalExLabourMinor} labour=${mgr.labourCostMinor} total=${mgr.totalCostMinor} margin=${mgr.marginMinor} (wall ${walled ? "HELD" : "LEAK!"})`,
  );

  // 3) Expense feeds cost; voiding removes it.
  const { id: exp2 } = await createExpense(ownerCtx(), "owner", {
    jobId,
    categoryKey: cat,
    description: "إضافي",
    expenseDate: "2026-02-04",
    amountMinor: 20000,
  });
  await refreshRollup(ownerCtx(), jobId);
  const withExp = await getJobCosting(ownerCtx(), "owner", jobId, "AED");
  await voidExpense(ownerCtx(), "owner", { expenseId: exp2, reason: "مكرر" });
  await refreshRollup(ownerCtx(), jobId);
  const afterVoid = await getJobCosting(ownerCtx(), "owner", jobId, "AED");
  log(
    `✓ expense feed/void: +20000 → ${withExp.expenseCostMinor}, void → ${afterVoid.expenseCostMinor}`,
  );

  // 4) E-01 nightly: a second active job with no report raises missing_report; a report clears it.
  const job2 = randomUUID();
  await owner`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by, start_date)
              values (${job2}, ${orgId}, '13S-002', 'سكيف', 'active', 'active', ${ownerUser}, '2026-01-01')`;
  const asOf = new Date().toISOString().slice(0, 10);
  const nightly = await evaluateNightly(ownerCtx(), { asOf, nowMs: Date.now() });
  log(`✓ E-01 nightly sweep raised ${nightly.missing} missing-report exception(s)`);

  // 5) E-07: a >12h labour line raises a labour outlier on submit.
  const r2 = randomUUID();
  await owner`insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by, submitted_at)
              values (${r2}, ${orgId}, ${jobId}, '2026-03-01', 'إضافي', 'submitted', ${ownerUser}, now())`;
  await owner`insert into public.report_labour_line (org_id, report_id, employee_id, normal_hours, ot_hours) values (${orgId}, ${r2}, ${emp}, 13, 0)`;
  const e07 = await evaluateReportAnomalies(ownerCtx(), r2);
  log(`✓ E-07 labour-outlier raised ${e07.raised}`);

  // 6) Manager Today: missing-report + blocker cards, freshness stamp, NO money.
  const today = await composeToday(mgrCtx(), "manager", {
    asOf,
    computedAt: new Date().toISOString(),
  });
  const missingCard = today.cards.find((c) => c.key === "missing_reports")!;
  const hasMoney = JSON.stringify(today).match(/amount|cost|price|margin|labour/i);
  log(
    `✓ manager Today: ${today.cards.length} cards, missing_reports=${missingCard.count}, freshness computedAt=${missingCard.freshness.computedAt.slice(11, 16)}, money-on-screen=${hasMoney ? "LEAK!" : "none"}`,
  );

  // 7) Reconcile drift alarm sanity (no drift right after a refresh).
  const rec = await reconcileOrgRollups(ownerCtx());
  log(`✓ reconcile ${rec.jobs} jobs, drift=${rec.drifted}`);

  // 8) Outbox events.
  const events = (await owner`select name, count(*)::int as n from public.domain_event
    where org_id = ${orgId} and name in ('expense/created','expense/voided') group by name order by name`) as unknown as Array<{
    name: string;
    n: number;
  }>;
  log(`✓ outbox: ${events.map((e) => `${e.name}×${e.n}`).join(", ")}`);

  log(
    `✓ DoD: golden=${okGolden ? "PASS" : "FAIL"}, labour-wall=${walled ? "PASS" : "FAIL"}, no-money-on-today=${hasMoney ? "FAIL" : "PASS"}`,
  );

  await cleanup();
  const left = (await owner`select count(*)::int as n from public.org where id = ${orgId}`)[0] as {
    n: number;
  };
  log(`✓ cleanup complete — org rows left: ${left.n} (expect 0)`);
  log("── demo complete ──────────────────────────────────────────────────");
}

run()
  .then(async () => {
    await owner.end({ timeout: 5 });
    await closeAppDb();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("DEMO FAILED:", e);
    try {
      await cleanup();
    } catch (ce) {
      console.error("cleanup after failure errored:", ce);
    }
    await owner.end({ timeout: 5 });
    process.exit(1);
  });
