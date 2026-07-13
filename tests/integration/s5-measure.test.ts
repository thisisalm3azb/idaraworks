/**
 * S5 "Measure" integration (doc 11 DoD; doc 01 costing spine; doc 04 exceptions).
 * Real DB. Proves: the costing sum equals a hand-computed fixture to the minor unit
 * under BOTH VAT bases (ex-VAT / inc-VAT); the labour-cost wall (manager sees cost
 * EXCLUDING labour, foreman sees nothing); the single-writer rollup + drift alarm;
 * expense create/void feeding cost; exception raise/clear/dedup + E-07 + the E-03
 * fold + C-10 divergence; and the dismiss authorization (manager yes, foreman no).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { ForbiddenError } from "@/platform/authz";
import {
  refreshRollup,
  getJobCosting,
  reconcileOrgRollups,
  raiseQuoteDivergence,
  clearQuoteDivergence,
  CostingNotFoundError,
} from "@/modules/costing/service";
import { createExpense, voidExpense } from "@/modules/expenses/service";
import { cancelGoodsReceipt } from "@/modules/supply/service";
import {
  evaluateNightly,
  evaluateReportAnomalies,
  materializeApprovalStuck,
  clearApprovalStuck,
  listOpenExceptions,
  dismissException,
} from "@/modules/exceptions/service";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
const managerUser = randomUUID();
const foremanUser = randomUUID();
let orgId = "";
let jobCost = "";
let jobExc = "";
let employeeId = "";
let categoryKey = "";

const ctxOf = (userId: string, priv: boolean): Ctx => ({
  orgId,
  userId,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "s5-test",
});
const ownerCtx = () => ctxOf(ownerUser, true);
const managerCtx = () => ctxOf(managerUser, false);
const foremanCtx = () => ctxOf(foremanUser, false);

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s5-${label}-${run}@example.com`}, '{"full_name":"S5 Test"}'::jsonb, now(), now())`;
}

async function newJob(ref: string, startDate: string | null): Promise<string> {
  const id = randomUUID();
  await owner`
    insert into public.job (id, org_id, reference, name, status_key, status_category, created_by, start_date)
    values (${id}, ${orgId}, ${ref}, ${"Boat " + ref}, 'active', 'active', ${ownerUser}, ${startDate})`;
  return id;
}

beforeAll(async () => {
  for (const [id, l] of [
    [ownerUser, "owner"],
    [managerUser, "mgr"],
    [foremanUser, "fore"],
  ] as const) {
    await seedUser(id, l);
  }
  orgId = await createOrgForUser(ownerUser, { name: "S5 Org", country: "AE", baseCurrency: "AED" });
  await owner`insert into public.membership (user_id, org_id, role_key) values (${managerUser}, ${orgId}, 'manager')`;
  await owner`insert into public.membership (user_id, org_id, role_key) values (${foremanUser}, ${orgId}, 'foreman')`;
  await installTemplate(ownerCtx(), TEMPLATE_BOATBUILDING.key);

  // A real expense category from the installed template (+ its costing_mapping).
  const cats = (await owner`
    select value from public.app_settings where org_id = ${orgId} and key = 'config.categories.expense'
  `) as unknown as Array<{
    value: { categories: Array<{ key: string; costing_mapping: string }> };
  }>;
  const jobCat = cats[0]!.value.categories.find((c) => c.costing_mapping === "job_materials")!;
  categoryKey = jobCat.key;

  employeeId = randomUUID();
  await owner`insert into public.employee (id, org_id, name) values (${employeeId}, ${orgId}, 'Ali')`;

  jobCost = await newJob("24C-COST", "2026-01-01");
  jobExc = await newJob("13S-EXC", "2026-01-01");
  await owner`update public.job set selling_price_minor = 500000 where id = ${jobCost}`;

  // ── Seed the cost inputs for jobCost (hand-computed fixture below). ──
  // Material: one MANUAL report line, qty 4 × 50000 = 200000 (catalog lines are
  // evidence, excluded — F-2 rule 2).
  const report = randomUUID();
  await owner`
    insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by, submitted_at)
    values (${report}, ${orgId}, ${jobCost}, '2026-02-01', 'seed', 'submitted', ${ownerUser}, now())`;
  await owner`
    insert into public.report_material_line (org_id, report_id, item_name, qty, unit, unit_cost_minor, cost_source)
    values (${orgId}, ${report}, 'Resin', 4, 'ltr', 50000, 'manual')`;
  await owner`
    insert into public.report_material_line (org_id, report_id, item_name, qty, unit, unit_cost_minor, cost_source)
    values (${orgId}, ${report}, 'Catalog bolt', 100, 'ea', 999, 'catalog')`; // excluded (evidence)
  // Labour: frozen snapshot 105000 (behind the cost wall — owner client bypasses RLS).
  await owner`
    insert into public.report_labour_cost (org_id, report_id, employee_id, hourly_cost_minor, ot_rate, labour_cost_minor)
    values (${orgId}, ${report}, ${employeeId}, 5000, 1.5, 105000)`;
  // PO receipt: line 10 × 10000 (subtotal 100000), vat 5000; net received 6 → ex 60000.
  const sup = randomUUID();
  const po = randomUUID();
  const pol = randomUUID();
  const grn = randomUUID();
  await owner`insert into public.supplier (id, org_id, name) values (${sup}, ${orgId}, 'Gulf')`;
  await owner`
    insert into public.purchase_order (id, org_id, reference, supplier_id, job_id, status, vat_minor, total_minor, created_by)
    values (${po}, ${orgId}, 'PO-COST', ${sup}, ${jobCost}, 'approved', 5000, 105000, ${ownerUser})`;
  await owner`
    insert into public.purchase_order_line (id, org_id, po_id, item_name, qty, unit, unit_cost_minor, line_total_minor)
    values (${pol}, ${orgId}, ${po}, 'Ply', 10, 'ea', 10000, 100000)`;
  await owner`
    insert into public.goods_receipt (id, org_id, reference, po_id, status, received_date, created_by)
    values (${grn}, ${orgId}, 'GRN-COST', ${po}, 'recorded', '2026-02-02', ${ownerUser})`;
  await owner`
    insert into public.goods_receipt_line (org_id, grn_id, po_line_id, ordered_qty, received_qty, damaged_qty, rejected_qty)
    values (${orgId}, ${grn}, ${pol}, 10, 6, 0, 0)`;
  // Expense (job): net 30000 + vat 1500 = 31500, mapping job_materials.
  await owner`
    insert into public.expense (org_id, reference, job_id, category_key, costing_mapping, description,
                                expense_date, amount_minor, vat_amount_minor, total_minor, created_by)
    values (${orgId}, 'EXP-COST', ${jobCost}, ${categoryKey}, 'job_materials', 'seed',
            '2026-02-03', 30000, 1500, 31500, ${ownerUser})`;
}, 120_000);

afterAll(async () => {
  // Teardown: FK-topological delete of everything this test seeded, then org+users.
  const T = [
    "cost_rollup_labour",
    "cost_rollup",
    "exception",
    "expense",
    "goods_receipt_line",
    "goods_receipt",
    "purchase_order_line",
    "purchase_order",
    "report_labour_cost",
    "report_labour_line",
    "attendance",
    "report_material_line",
    "daily_report",
    "approval",
    "job_crew",
    "job_stage",
    "job",
    "employee_terms",
    "employee_hr",
    "employee",
    "supplier",
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
  for (const t of T) await owner.unsafe(`delete from public.${t} where org_id = $1`, [orgId]);
  await owner`delete from public.org where id = ${orgId}`;
  await owner`delete from public.user_profile where id = any(${[ownerUser, managerUser, foremanUser]}::uuid[])`;
  await owner`delete from auth.users where id = any(${[ownerUser, managerUser, foremanUser]}::uuid[])`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("costing golden (both VAT bases, to the minor unit)", () => {
  it("ex-VAT: total_ex_labour = 290000, total = 395000 (boatFinance-style parity)", async () => {
    await owner`update public.app_settings set value = 'true'::jsonb where org_id = ${orgId} and key = 'finance.vat_registered'`;
    await owner`insert into public.app_settings (org_id, key, value) values (${orgId}, 'finance.vat_registered', 'true'::jsonb) on conflict do nothing`;
    await refreshRollup(ownerCtx(), jobCost);
    const rr =
      (await owner`select * from public.cost_rollup where org_id = ${orgId} and job_id = ${jobCost}`) as unknown as Array<
        Record<string, string>
      >;
    const lc =
      (await owner`select * from public.cost_rollup_labour where org_id = ${orgId} and job_id = ${jobCost}`) as unknown as Array<
        Record<string, string>
      >;
    expect(Number(rr[0]!.material_cost_minor)).toBe(200000);
    expect(Number(rr[0]!.po_cost_minor)).toBe(60000); // ex-VAT: net 6 × 10000
    expect(Number(rr[0]!.expense_cost_minor)).toBe(30000); // ex-VAT: net
    expect(Number(rr[0]!.total_ex_labour_minor)).toBe(290000);
    expect(Number(lc[0]!.labour_cost_minor)).toBe(105000);
    expect(Number(lc[0]!.total_cost_minor)).toBe(395000);
    expect(rr[0]!.cost_basis).toBe("ex_vat");
  });

  it("inc-VAT: PO grosses up (63000), expense uses gross (31500) → total 399500", async () => {
    await owner`insert into public.app_settings (org_id, key, value) values (${orgId}, 'finance.vat_registered', 'false'::jsonb) on conflict (org_id, key) do update set value = 'false'::jsonb`;
    await refreshRollup(ownerCtx(), jobCost);
    const rr =
      (await owner`select * from public.cost_rollup where org_id = ${orgId} and job_id = ${jobCost}`) as unknown as Array<
        Record<string, string>
      >;
    const lc =
      (await owner`select * from public.cost_rollup_labour where org_id = ${orgId} and job_id = ${jobCost}`) as unknown as Array<
        Record<string, string>
      >;
    expect(Number(rr[0]!.po_cost_minor)).toBe(63000); // 60000 + vat share 5000×(60000/100000)=3000
    expect(Number(rr[0]!.expense_cost_minor)).toBe(31500); // gross
    expect(Number(rr[0]!.total_ex_labour_minor)).toBe(294500);
    expect(Number(lc[0]!.total_cost_minor)).toBe(399500);
    // Restore ex-VAT for the redaction tests.
    await owner`update public.app_settings set value = 'true'::jsonb where org_id = ${orgId} and key = 'finance.vat_registered'`;
    await refreshRollup(ownerCtx(), jobCost);
  });
});

describe("cost redaction (D-6.2 / F-23 labour wall)", () => {
  it("owner (cost + price privileged) sees labour, total, quoted, margin", async () => {
    const v = await getJobCosting(ownerCtx(), "owner", jobCost, "AED");
    expect(v.labourCostMinor).toBe(105000);
    expect(v.totalCostMinor).toBe(395000);
    expect(v.quotedMinor).toBe(500000);
    expect(v.marginMinor).toBe(105000); // 500000 - 395000
  });

  it("manager (viewCosts OFF) sees cost EXCLUDING labour; labour/total/quoted/margin redacted", async () => {
    const v = await getJobCosting(managerCtx(), "manager", jobCost, "AED");
    expect(v.materialCostMinor).toBe(200000);
    expect(v.totalExLabourMinor).toBe(290000);
    expect(v.labourCostMinor).toBeNull();
    expect(v.totalCostMinor).toBeNull();
    expect(v.quotedMinor).toBeNull();
    expect(v.marginMinor).toBeNull();
  });

  it("foreman has NO costing access at all (F-23)", async () => {
    await expect(getJobCosting(foremanCtx(), "foreman", jobCost, "AED")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("expenses feed cost; void removes it", () => {
  it("a created expense raises job cost; voiding it lowers cost back", async () => {
    const before = await getJobCosting(ownerCtx(), "owner", jobCost, "AED");
    const { id } = await createExpense(ownerCtx(), "owner", {
      jobId: jobCost,
      categoryKey,
      description: "Extra glue",
      expenseDate: "2026-02-05",
      amountMinor: 20000,
    });
    await refreshRollup(ownerCtx(), jobCost); // the invalidator worker's job, simulated
    const withExp = await getJobCosting(ownerCtx(), "owner", jobCost, "AED");
    expect(withExp.expenseCostMinor).toBe(before.expenseCostMinor + 20000);
    await voidExpense(ownerCtx(), "owner", { expenseId: id, reason: "duplicate" });
    await refreshRollup(ownerCtx(), jobCost);
    const afterVoid = await getJobCosting(ownerCtx(), "owner", jobCost, "AED");
    expect(afterVoid.expenseCostMinor).toBe(before.expenseCostMinor);
  });
});

describe("reconcile drift alarm (D-2.2 / doc 10 #49)", () => {
  it("detects a cache that drifted from source (a missed invalidation)", async () => {
    await refreshRollup(ownerCtx(), jobCost); // cache is current
    // Mutate a cost input WITHOUT refreshing (simulate a missed event).
    await owner`insert into public.expense (org_id, reference, job_id, category_key, costing_mapping,
                  description, expense_date, amount_minor, vat_amount_minor, total_minor, created_by)
                values (${orgId}, ${"EXP-DRIFT-" + run}, ${jobCost}, ${categoryKey}, 'job_materials',
                        'drift', '2026-02-06', 7000, 0, 7000, ${ownerUser})`;
    const res = await reconcileOrgRollups(ownerCtx());
    expect(res.drifted).toBeGreaterThanOrEqual(1);
  });
});

describe("exception engine (raise / clear / dedup / calendar)", () => {
  it("E-01 raises missing_report for an active job with no report, ages (dedup), then clears", async () => {
    const asOf = "2026-07-13";
    const first = await evaluateNightly(ownerCtx(), {
      asOf,
      nowMs: Date.parse(`${asOf}T03:00:00Z`),
    });
    expect(first.missing).toBeGreaterThanOrEqual(1);
    const open1 = (await owner`select count(*)::int as n from public.exception
      where org_id = ${orgId} and rule_key = 'missing_report' and job_id = ${jobExc} and resolved_at is null`) as unknown as Array<{
      n: number;
    }>;
    expect(open1[0]!.n).toBe(1);
    // Second run: the row AGES — still exactly ONE open (dedup), not a duplicate.
    await evaluateNightly(ownerCtx(), { asOf, nowMs: Date.parse(`${asOf}T03:00:00Z`) });
    const open2 = (await owner`select count(*)::int as n from public.exception
      where org_id = ${orgId} and rule_key = 'missing_report' and job_id = ${jobExc} and resolved_at is null`) as unknown as Array<{
      n: number;
    }>;
    expect(open2[0]!.n).toBe(1);
    // A report arrives today → the next sweep auto-clears it.
    await owner`insert into public.daily_report (org_id, job_id, report_date, summary, status, submitted_by, submitted_at)
                values (${orgId}, ${jobExc}, ${asOf}, 'now', 'submitted', ${ownerUser}, now())`;
    await evaluateNightly(ownerCtx(), { asOf, nowMs: Date.parse(`${asOf}T03:00:00Z`) });
    const open3 = (await owner`select count(*)::int as n from public.exception
      where org_id = ${orgId} and rule_key = 'missing_report' and job_id = ${jobExc} and resolved_at is null`) as unknown as Array<{
      n: number;
    }>;
    expect(open3[0]!.n).toBe(0);
  });

  it("E-07 raises a labour outlier on a >12h report line", async () => {
    const report = randomUUID();
    await owner`insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by, submitted_at)
                values (${report}, ${orgId}, ${jobExc}, '2026-03-01', 'ot', 'submitted', ${ownerUser}, now())`;
    await owner`insert into public.report_labour_line (org_id, report_id, employee_id, normal_hours, ot_hours)
                values (${orgId}, ${report}, ${employeeId}, 13, 0)`;
    const res = await evaluateReportAnomalies(ownerCtx(), report);
    expect(res.raised).toBe(1);
    const n = (await owner`select count(*)::int as n from public.exception
      where org_id = ${orgId} and rule_key = 'labour_outlier' and resolved_at is null`) as unknown as Array<{
      n: number;
    }>;
    expect(n[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it("E-03 fold: materialize an approval-stuck signal, then auto-clear on decision", async () => {
    const appr = randomUUID();
    await owner`insert into public.approval (id, org_id, subject_type, subject_id, subject_summary, requested_by, assigned_role, state)
                values (${appr}, ${orgId}, 'material_request', ${randomUUID()}, '{}'::jsonb, ${ownerUser}, 'manager', 'pending')`;
    await materializeApprovalStuck(ownerCtx(), { approvalId: appr, severity: "warning" });
    const openA = (await owner`select count(*)::int as n from public.exception
      where org_id = ${orgId} and rule_key = 'approval_stuck' and subject_id = ${appr} and resolved_at is null`) as unknown as Array<{
      n: number;
    }>;
    expect(openA[0]!.n).toBe(1);
    await clearApprovalStuck(ownerCtx(), appr);
    const closedA = (await owner`select count(*)::int as n from public.exception
      where org_id = ${orgId} and rule_key = 'approval_stuck' and subject_id = ${appr} and resolved_at is null`) as unknown as Array<{
      n: number;
    }>;
    expect(closedA[0]!.n).toBe(0);
  });

  it("C-10: raise + clear the quote/selling-price divergence exception", async () => {
    await raiseQuoteDivergence(ownerCtx(), { jobId: jobCost });
    const openD = (await owner`select count(*)::int as n from public.exception
      where org_id = ${orgId} and rule_key = 'quote_divergence' and job_id = ${jobCost} and resolved_at is null`) as unknown as Array<{
      n: number;
    }>;
    expect(openD[0]!.n).toBe(1);
    await clearQuoteDivergence(ownerCtx(), jobCost);
    const closedD = (await owner`select count(*)::int as n from public.exception
      where org_id = ${orgId} and rule_key = 'quote_divergence' and job_id = ${jobCost} and resolved_at is null`) as unknown as Array<{
      n: number;
    }>;
    expect(closedD[0]!.n).toBe(0);
  });
});

describe("exception authorization (dismiss)", () => {
  it("a manager (in audience) may dismiss; a foreman may not", async () => {
    // Raise an org-scoped missing_report the manager audience sees.
    const asOf = "2026-08-01";
    await evaluateNightly(ownerCtx(), { asOf, nowMs: Date.parse(`${asOf}T03:00:00Z`) });
    const mgrView = await listOpenExceptions(managerCtx(), "manager");
    const target = mgrView.find((e) => e.ruleKey === "missing_report");
    expect(target).toBeTruthy();
    // Foreman cannot dismiss (no exceptions.dismiss).
    await expect(
      dismissException(foremanCtx(), "foreman", { exceptionId: target!.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Manager dismisses (audience + scope ok).
    const res = await dismissException(managerCtx(), "manager", {
      exceptionId: target!.id,
      note: "known",
    });
    expect(res.id).toBe(target!.id);
    const gone =
      (await owner`select resolution from public.exception where id = ${target!.id}`) as unknown as Array<{
        resolution: string;
      }>;
    expect(gone[0]!.resolution).toBe("dismissed");
  });

  it("a foreman sees no manager-audience exceptions", async () => {
    const foremanView = await listOpenExceptions(foremanCtx(), "foreman");
    expect(foremanView.every((e) => e.ruleKey !== "missing_report")).toBe(true);
  });
});

describe("review regressions", () => {
  it("E-01 is NOT flagged when the last report is the previous working day (off-by-one)", async () => {
    const j = randomUUID();
    await owner`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by, start_date)
                values (${j}, ${orgId}, ${"OBO-" + run}, 'ob', 'active', 'active', ${ownerUser}, '2026-01-01')`;
    // asOf = Wed 2026-07-15; the report is for the previous WORKING day Tue 2026-07-14.
    await owner`insert into public.daily_report (org_id, job_id, report_date, summary, status, submitted_by, submitted_at)
                values (${orgId}, ${j}, '2026-07-14', 'ok', 'submitted', ${ownerUser}, now())`;
    await evaluateNightly(ownerCtx(), {
      asOf: "2026-07-15",
      nowMs: Date.parse("2026-07-15T03:00:00Z"),
    });
    const n = (await owner`select count(*)::int as n from public.exception
      where org_id = ${orgId} and rule_key = 'missing_report' and job_id = ${j} and resolved_at is null`) as unknown as Array<{
      n: number;
    }>;
    expect(n[0]!.n).toBe(0);
  });

  it("self-heal: an open missing_report auto-clears once its job leaves 'active'", async () => {
    const j = randomUUID();
    await owner`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by, start_date)
                values (${j}, ${orgId}, ${"HEAL-" + run}, 'h', 'active', 'active', ${ownerUser}, '2026-01-01')`;
    const asOf = "2026-08-15";
    await evaluateNightly(ownerCtx(), { asOf, nowMs: Date.parse(`${asOf}T03:00:00Z`) });
    const raised = (await owner`select count(*)::int as n from public.exception
      where org_id = ${orgId} and rule_key = 'missing_report' and job_id = ${j} and resolved_at is null`) as unknown as Array<{
      n: number;
    }>;
    expect(raised[0]!.n).toBe(1);
    await owner`update public.job set status_category = 'done' where id = ${j}`;
    await evaluateNightly(ownerCtx(), { asOf, nowMs: Date.parse(`${asOf}T03:00:00Z`) });
    const healed = (await owner`select resolution from public.exception
      where org_id = ${orgId} and rule_key = 'missing_report' and job_id = ${j}`) as unknown as Array<{
      resolution: string;
    }>;
    expect(healed[0]!.resolution).toBe("auto");
  });

  it("GRN cancellation invalidates cost: emits the event + refresh drops PO cost to 0", async () => {
    await refreshRollup(ownerCtx(), jobCost);
    const before = await getJobCosting(ownerCtx(), "owner", jobCost, "AED");
    expect(before.poCostMinor).toBe(60000);
    const grn = (await owner`select id::text as id from public.goods_receipt
      where org_id = ${orgId} and reference = 'GRN-COST'`) as unknown as Array<{ id: string }>;
    await cancelGoodsReceipt(ownerCtx(), "owner", grn[0]!.id);
    const ev = (await owner`select count(*)::int as n from public.domain_event
      where org_id = ${orgId} and name = 'goods_receipt/cancelled'`) as unknown as Array<{
      n: number;
    }>;
    expect(ev[0]!.n).toBeGreaterThanOrEqual(1);
    await refreshRollup(ownerCtx(), jobCost); // the cost-rollup-on-goods-receipt-cancel worker's job, simulated
    const after = await getJobCosting(ownerCtx(), "owner", jobCost, "AED");
    expect(after.poCostMinor).toBe(0);
  });
});
