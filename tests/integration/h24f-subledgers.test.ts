/**
 * H24F — subledger integration: stock movements value the books, payroll
 * finalization posts its liabilities, depreciation runs accumulate and cap,
 * and the subledger reconciliations read zero drift when the world is right.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { createEmployee } from "@/modules/masters/service";
import { decideApproval, listInbox } from "@/modules/approvals/service";
import { recordCompensationChange } from "@/modules/hr/people";
import {
  createPayGroup,
  createPayRun,
  calculatePayRun,
  submitPayRunForApproval,
  finalizePayRun,
} from "@/modules/payroll/service";
import { postMovement } from "@/modules/inventory/service";
import {
  installFinanceSetup,
  runDepreciation,
  subledgerReconciliations,
  trialBalance,
} from "@/modules/finance/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
let itemId = "";
let whId = "";
let binId = "";
let unitId = "";

const A = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h24f",
});

async function glBalance(systemKey: string): Promise<number> {
  const rows = await owner`
    select coalesce(sum(l.base_debit_minor - l.base_credit_minor), 0)::int as bal
    from public.journal_line l
    join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
    join public.gl_account a on a.id = l.account_id and a.org_id = l.org_id
    where l.org_id = ${orgA} and a.system_key = ${systemKey}
      and e.status in ('posted', 'reversed')`;
  return rows[0]!.bal as number;
}

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h24f-${run}@example.invalid`}, '{"full_name":"H24F"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H24F", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h24f", run);
  await installFinanceSetup(A(), "owner", { booksStartDate: "2026-01-01" });

  unitId = randomUUID();
  whId = randomUUID();
  binId = randomUUID();
  itemId = randomUUID();
  await owner`insert into public.unit_of_measure (id, org_id, code, name_en, name_ar, dimension, factor_to_base)
              values (${unitId}, ${orgA}, 'EA', 'Each', 'وحدة', 'count', 1)`;
  await owner`insert into public.warehouse (id, org_id, code, name_en, created_by)
              values (${whId}, ${orgA}, 'WH1', 'Main', ${userA})`;
  await owner`insert into public.stock_location (id, org_id, warehouse_id, code, name_en)
              values (${binId}, ${orgA}, ${whId}, 'B1', 'Bin 1')`;
  await owner`insert into public.item (id, org_id, sku, name, category_key, unit, base_unit_id)
              values (${itemId}, ${orgA}, ${"SKU-" + run}, 'Resin', 'general', 'ea', ${unitId})`;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
}, 240_000);

describe("stock movements value the books", () => {
  it(
    "increase, consume and reverse all post; reconciliation reads zero drift",
    { timeout: 300_000 },
    async () => {
      await postMovement(A(), "owner", {
        itemId,
        warehouseId: whId,
        locationId: binId,
        movementType: "adjustment_increase",
        qtyDelta: 10,
        unitId,
        unitCostMinor: 2_000,
        idempotencyKey: `inc-${run}`,
        reason: "opening stock via adjustment",
      });
      expect(await glBalance("inventory")).toBe(20_000);
      expect(await glBalance("stock_adjustment")).toBe(-20_000);

      await postMovement(A(), "owner", {
        itemId,
        warehouseId: whId,
        locationId: binId,
        movementType: "material_issue",
        qtyDelta: -4,
        unitId,
        idempotencyKey: `iss-${run}`,
        reason: "issued to floor",
      });
      expect(await glBalance("inventory")).toBe(20_000 - 8_000);
      expect(await glBalance("direct_costs")).toBe(8_000);

      const recon = await subledgerReconciliations(A(), "owner");
      const inv = recon.find((r) => r.name === "inventory")!;
      expect(inv.driftMinor).toBe(0);
      const tb = await trialBalance(A(), "owner", {});
      expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
    },
  );
});

describe("payroll posts its liabilities", () => {
  it(
    "finalize creates the salary/liability entry that ties to the run",
    { timeout: 600_000 },
    async () => {
      const emp = await createEmployee(A(), "owner", { name: `Payee ${run}` });
      await recordCompensationChange(A(), "owner", emp.id, {
        effectiveDate: "2026-01-01",
        salaryMinor: 700_000,
        reason: "hire",
      });
      const g = await createPayGroup(A(), "owner", { nameEn: "F Monthly" });
      const r = await createPayRun(A(), "owner", {
        payGroupId: g.id,
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
      });
      await calculatePayRun(A(), "owner", r.id);
      await submitPayRunForApproval(A(), "owner", r.id);
      const inbox = await listInbox(A(), "owner");
      const item = inbox.find((i) => i.subjectId === r.id);
      await decideApproval(A(), "owner", { approvalId: item!.id, decision: "approved" });
      await finalizePayRun(A(), "owner", r.id);

      const entry = await owner`
      select id::text as id, total_debit_minor::int as td from public.journal_entry
      where org_id = ${orgA} and source_type = 'pay_run' and source_id = ${r.id}
        and status = 'posted'`;
      expect(entry).toHaveLength(1);
      expect(entry[0]!.td).toBe(700_000);
      expect(await glBalance("salary_expense")).toBe(700_000);
      expect(await glBalance("payroll_net_payable")).toBe(-700_000);
    },
  );
});

describe("depreciation", () => {
  it(
    "runs straight-line monthly, refuses duplicate periods, and caps at the base",
    { timeout: 300_000 },
    async () => {
      const catId = randomUUID();
      const assetId = randomUUID();
      await owner`insert into public.asset_category (id, org_id, code, name_en, created_by)
                values (${catId}, ${orgA}, 'MC', 'Machines', ${userA})`;
      await owner`
      insert into public.asset
        (id, org_id, asset_no, category_id, name_en, status, condition,
         acquisition_cost_minor, base_acquisition_cost_minor, residual_value_minor,
         useful_life_months, depreciation_start_on, created_by)
      values (${assetId}, ${orgA}, ${"AST-" + run}, ${catId}, 'CNC router', 'in_service', 'good',
              120_000, 120_000, 0, 12, '2026-01-01', ${userA})`;

      const jan = await runDepreciation(A(), "owner", {
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      });
      expect(jan.totalMinor).toBe(10_000);
      expect(jan.assets).toBe(1);
      await expect(
        runDepreciation(A(), "owner", { periodStart: "2026-01-01", periodEnd: "2026-01-31" }),
      ).rejects.toThrow();

      // Eleven more months fully depreciate it; a 13th month finds nothing.
      for (let m = 2; m <= 12; m++) {
        const start = `2026-${String(m).padStart(2, "0")}-01`;
        const end = new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10);
        await runDepreciation(A(), "owner", { periodStart: start, periodEnd: end });
      }
      expect(await glBalance("accumulated_depreciation")).toBe(-120_000);
      const extra = await runDepreciation(A(), "owner", {
        periodStart: "2027-01-01",
        periodEnd: "2027-01-31",
      });
      expect(extra.totalMinor).toBe(0);

      const recon = await subledgerReconciliations(A(), "owner");
      const dep = recon.find((r) => r.name === "accumulated_depreciation")!;
      expect(dep.driftMinor).toBe(0);
    },
  );
});
