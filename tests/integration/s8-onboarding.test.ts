/**
 * S8 AI onboarding + imports integration (doc 11 S8 DoD). Real DB. Proves: a COLD org (no
 * template) runs the Layer-A pipeline (propose → apply) to a configured workspace + F-28-capped
 * approval rules; the PARITY gate — a workspace configured PURELY by onboarding reproduces the
 * S5 costing golden (290000 ex-labour / 395000 total) to the minor unit; guided CSV import
 * stages + applies through the governed masters service; the per-org onboarding-call cap blocks
 * abuse; and session undo reverts the applied config (template uninstalled).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { getInstalledTemplate } from "@/platform/config";
import { invalidateEntitlements } from "@/platform/entitlements/resolve";
import { refreshRollup } from "@/modules/costing/service";
import {
  startOnboarding,
  applyOnboarding,
  undoOnboarding,
  getOnboardingSession,
  OnboardingCapError,
} from "@/modules/onboarding/service";
import { stageImport, applyImport } from "@/modules/imports/service";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
let orgId = "";
let sessionId = "";

const ownerCtx = (): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "s8-test",
});

const intake = {
  business_name: "Onboarded Marine",
  country: "AE",
  base_currency: "AED",
  languages: ["ar", "en"],
  six_day_week: true,
  vat_registered: true,
  job_term_en: "Boat",
  job_term_ar: "قارب",
  approval_auto_approve_below: { purchase_order: 400_000, material_request: 200_000 },
  requested_features: [],
};

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s8-${run}@example.com`}, '{"full_name":"S8"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, { name: "S8 Org", country: "AE", baseCurrency: "AED" });
}, 120_000);

afterAll(async () => {
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("Layer-A pipeline: cold org → configured workspace", () => {
  it("a cold org has no template; onboarding proposes then applies template + approval rules", async () => {
    expect(await getInstalledTemplate(ownerCtx())).toBeNull();

    const started = await startOnboarding(ownerCtx(), "owner", intake);
    sessionId = started.sessionId;
    expect(started.proposal.template_key).toBe("boatbuilding_marine_v1");

    const res = await applyOnboarding(ownerCtx(), "owner", sessionId);
    expect(res.installed).toBe(true);
    expect(res.rulesCreated).toBe(2); // purchase_order + material_request auto-approve rules
    expect(res.revisionIds.length).toBeGreaterThan(0);

    expect(await getInstalledTemplate(ownerCtx())).not.toBeNull();
    const [rules] = (await owner`
      select count(*)::int as n from public.approval_rule where org_id = ${orgId}
        and condition_kind = 'amount_gte'`) as unknown as Array<{ n: number }>;
    expect(rules!.n).toBeGreaterThanOrEqual(2);
    const session = await getOnboardingSession(ownerCtx(), "owner", sessionId);
    expect(session!.status).toBe("applied");
  }, 120_000);
});

describe("PARITY gate — onboarded config reproduces the costing golden", () => {
  it("ex-VAT total_ex_labour = 290000, total = 395000 (doc 08 boatFinance-style parity)", async () => {
    // VAT-registered ex-VAT basis (intake said VAT-registered).
    await owner`insert into public.app_settings (org_id, key, value) values (${orgId}, 'finance.vat_registered', 'true'::jsonb)
                on conflict (org_id, key) do update set value = 'true'::jsonb`;
    // A job under the ONBOARDED config + the same S5 golden cost inputs.
    const job = randomUUID();
    await owner`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by, start_date, selling_price_minor)
                values (${job}, ${orgId}, ${`24C-${run}`}, 'Parity', 'active', 'active', ${ownerUser}, '2026-01-01', 500000)`;
    const report = randomUUID();
    const emp = randomUUID();
    await owner`insert into public.employee (id, org_id, name) values (${emp}, ${orgId}, 'Ali')`;
    await owner`insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by, submitted_at)
                values (${report}, ${orgId}, ${job}, '2026-02-01', 'seed', 'submitted', ${ownerUser}, now())`;
    await owner`insert into public.report_material_line (org_id, report_id, item_name, qty, unit, unit_cost_minor, cost_source)
                values (${orgId}, ${report}, 'Resin', 4, 'ltr', 50000, 'manual')`; // 200000
    await owner`insert into public.report_material_line (org_id, report_id, item_name, qty, unit, unit_cost_minor, cost_source)
                values (${orgId}, ${report}, 'Catalog bolt', 100, 'ea', 999, 'catalog')`; // excluded
    await owner`insert into public.report_labour_cost (org_id, report_id, employee_id, hourly_cost_minor, ot_rate, labour_cost_minor)
                values (${orgId}, ${report}, ${emp}, 5000, 1.5, 105000)`;
    const sup = randomUUID();
    const po = randomUUID();
    const pol = randomUUID();
    const grn = randomUUID();
    await owner`insert into public.supplier (id, org_id, name) values (${sup}, ${orgId}, 'Gulf')`;
    await owner`insert into public.purchase_order (id, org_id, reference, supplier_id, job_id, status, vat_minor, total_minor, created_by)
                values (${po}, ${orgId}, ${`PO-${run}`}, ${sup}, ${job}, 'approved', 5000, 105000, ${ownerUser})`;
    await owner`insert into public.purchase_order_line (id, org_id, po_id, item_name, qty, unit, unit_cost_minor, line_total_minor)
                values (${pol}, ${orgId}, ${po}, 'Ply', 10, 'ea', 10000, 100000)`;
    await owner`insert into public.goods_receipt (id, org_id, reference, po_id, status, received_date, created_by)
                values (${grn}, ${orgId}, ${`GRN-${run}`}, ${po}, 'recorded', '2026-02-02', ${ownerUser})`;
    await owner`insert into public.goods_receipt_line (org_id, grn_id, po_line_id, ordered_qty, received_qty, damaged_qty, rejected_qty)
                values (${orgId}, ${grn}, ${pol}, 10, 6, 0, 0)`; // net 6 → 60000
    // Expense under an ONBOARDED expense category mapped to job_materials.
    const cats = (await owner`
      select value from public.app_settings where org_id = ${orgId} and key = 'config.categories.expense'`) as unknown as Array<{
      value: { categories: Array<{ key: string; costing_mapping: string }> };
    }>;
    const cat = cats[0]!.value.categories.find((c) => c.costing_mapping === "job_materials")!.key;
    await owner`insert into public.expense (org_id, reference, job_id, category_key, costing_mapping, description,
                                            expense_date, amount_minor, vat_amount_minor, total_minor, created_by)
                values (${orgId}, ${`EXP-${run}`}, ${job}, ${cat}, 'job_materials', 'seed', '2026-02-03', 30000, 1500, 31500, ${ownerUser})`;

    await refreshRollup(ownerCtx(), job);
    const [rr] =
      (await owner`select * from public.cost_rollup where org_id = ${orgId} and job_id = ${job}`) as unknown as Array<
        Record<string, string>
      >;
    const [lc] =
      (await owner`select * from public.cost_rollup_labour where org_id = ${orgId} and job_id = ${job}`) as unknown as Array<
        Record<string, string>
      >;
    expect(Number(rr!.material_cost_minor)).toBe(200000);
    expect(Number(rr!.po_cost_minor)).toBe(60000);
    expect(Number(rr!.expense_cost_minor)).toBe(30000);
    expect(Number(rr!.total_ex_labour_minor)).toBe(290000);
    expect(Number(lc!.total_cost_minor)).toBe(395000); // 290000 + 105000 labour
  }, 120_000);
});

describe("guided CSV import (customers) through the governed masters service", () => {
  it("stages valid + invalid rows, applies only valid ones, creates real customers", async () => {
    const staged = await stageImport(ownerCtx(), "owner", {
      kind: "customers",
      filename: "customers.csv",
      rows: [
        { name: `Acme ${run}`, phone: "0501112233", email: "a@acme.test" },
        { name: "", phone: "x" }, // invalid — name required
      ],
    });
    expect(staged.total).toBe(2);
    expect(staged.valid).toBe(1);
    expect(staged.invalid).toBe(1);

    const applied = await applyImport(ownerCtx(), "owner", staged.batchId);
    expect(applied.applied).toBe(1);
    const [cust] = (await owner`
      select count(*)::int as n from public.customer where org_id = ${orgId} and name = ${`Acme ${run}`}`) as unknown as Array<{
      n: number;
    }>;
    expect(cust!.n).toBe(1);
  }, 120_000);
});

describe("trial-abuse: per-org onboarding-call cap", () => {
  it("rejects a further proposal once the cap is reached", async () => {
    // One proposal was already generated (the pipeline test). Cap the org at 1 → the next throws.
    await owner`insert into public.org_entitlement_override (org_id, entitlement_key, limit_value)
                values (${orgId}, 'limit.ai_onboarding_calls', 1)
                on conflict (org_id, entitlement_key) do update set limit_value = 1`;
    invalidateEntitlements(orgId);
    await expect(startOnboarding(ownerCtx(), "owner", intake)).rejects.toBeInstanceOf(
      OnboardingCapError,
    );
  }, 120_000);
});

describe("session undo restores config", () => {
  it("undo reverts the applied revisions (template uninstalled)", async () => {
    const res = await undoOnboarding(ownerCtx(), "owner", sessionId);
    expect(res.undone).toBeGreaterThan(0);
    expect(await getInstalledTemplate(ownerCtx())).toBeNull(); // install marker reverted
    const session = await getOnboardingSession(ownerCtx(), "owner", sessionId);
    expect(session!.status).toBe("dismissed");
  }, 120_000);
});
