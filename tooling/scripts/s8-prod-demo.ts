/**
 * S8 production DoD demo (Arabic "AI Onboarding") — runs the REAL Layer-A pipeline against
 * production Supabase (DIRECT_URL), then deletes every synthetic row (0 leftovers).
 *
 * Proves against production (doc 11 S8 DoD): a COLD org → configured workspace via the
 * onboarding pipeline (propose → apply: template + F-28-capped approval rules) with a real
 * first job; the PARITY gate (onboarded config reproduces the S5 costing golden 290000/395000);
 * a guided CSV import through the governed masters service; the per-org onboarding-call cap;
 * and session undo restoring config. Touches ONLY its own Arabic synthetic org; Alpha Marine +
 * TESTING are never read or written.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { getInstalledTemplate } from "@/platform/config";
import { invalidateEntitlements } from "@/platform/entitlements/resolve";
import { refreshRollup } from "@/modules/costing/service";
import {
  startOnboarding,
  applyOnboarding,
  undoOnboarding,
  OnboardingCapError,
} from "@/modules/onboarding/service";
import { stageImport, applyImport } from "@/modules/imports/service";

const owner = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
const log = (m: string) => console.log(m);
const ownerUser = randomUUID();
let orgId = "";
const ctx = (): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "s8-prod-demo",
});

const TABLES = [
  "onboarding_session",
  "import_row",
  "import_batch",
  "ai_interaction",
  "cost_rollup_labour",
  "cost_rollup",
  "goods_receipt_line",
  "goods_receipt",
  "purchase_order_line",
  "purchase_order",
  "expense",
  "report_labour_cost",
  "report_material_line",
  "daily_report",
  "approval",
  "approval_rule",
  "job_stage",
  "employee",
  "supplier",
  "customer",
  "domain_event",
  "notification",
  "config_revision",
  "app_settings",
  "org_holiday_calendar",
  "job_preset",
  "reference_sequence",
  "membership", // must precede role_definition (membership.role_key → role_definition(org,key))
  "role_definition",
  "org_plan_state",
  "org_entitlement_override",
  "audit_log",
  "activity",
  "company",
];

async function cleanup() {
  if (!orgId) return;
  await owner`update public.job set current_stage_id = null where org_id = ${orgId}`;
  for (const t of TABLES) await owner.unsafe(`delete from public.${t} where org_id = $1`, [orgId]);
  await owner`delete from public.job where org_id = ${orgId}`;
  await owner`delete from public.org where id = ${orgId}`;
  await owner`delete from public.user_profile where id = ${ownerUser}`;
  await owner`delete from auth.users where id = ${ownerUser}`;
}

async function run() {
  log("── S8 production demo (Arabic AI onboarding) ──────────────────────");
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s8demo-${ownerUser.slice(0, 8)}@example.com`}, '{"full_name":"S8 Demo"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, {
    name: "ورشة الإعداد",
    country: "AE",
    baseCurrency: "AED",
  });

  const cold = await getInstalledTemplate(ctx());
  log(`✓ cold org — template installed: ${cold ? "YES (unexpected)" : "no"}`);

  // ── propose → apply ──
  const started = await startOnboarding(ctx(), "owner", {
    business_name: "ورشة الإعداد",
    country: "AE",
    base_currency: "AED",
    languages: ["ar", "en"],
    six_day_week: true,
    vat_registered: true,
    job_term_en: "Boat",
    job_term_ar: "قارب",
    approval_auto_approve_below: { purchase_order: 400000, material_request: 200000 },
    requested_features: [],
  });
  const applied = await applyOnboarding(ctx(), "owner", started.sessionId);
  const installedNow = await getInstalledTemplate(ctx());
  const [rules] = (await owner`select count(*)::int as n from public.approval_rule
    where org_id = ${orgId} and condition_kind = 'amount_gte'`) as unknown as Array<{ n: number }>;
  log(
    `✓ onboarding applied — template installed=${!!installedNow}, ${applied.revisionIds.length} revisions, ${applied.rulesCreated} approval rules (${rules!.n} amount_gte)`,
  );

  // ── first real job under the onboarded config ──
  const [preset] = (await owner`select id::text as id from public.job_preset
    where org_id = ${orgId} order by created_at limit 1`) as unknown as Array<{ id: string }>;
  const job = randomUUID();
  await owner`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by, start_date, selling_price_minor)
              values (${job}, ${orgId}, '24C-001', 'قارب التجربة', 'active', 'active', ${ownerUser}, '2026-01-01', 500000)`;
  log(
    `✓ first job created under onboarded preset ${preset?.id.slice(0, 8)} — 24C-001 قارب التجربة`,
  );

  // ── PARITY: onboarded config reproduces the S5 costing golden 290000/395000 ──
  await owner`insert into public.app_settings (org_id, key, value) values (${orgId}, 'finance.vat_registered', 'true'::jsonb)
              on conflict (org_id, key) do update set value = 'true'::jsonb`;
  const report = randomUUID();
  const emp = randomUUID();
  await owner`insert into public.employee (id, org_id, name) values (${emp}, ${orgId}, 'علي')`;
  await owner`insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by, submitted_at)
              values (${report}, ${orgId}, ${job}, '2026-02-01', 'seed', 'submitted', ${ownerUser}, now())`;
  await owner`insert into public.report_material_line (org_id, report_id, item_name, qty, unit, unit_cost_minor, cost_source)
              values (${orgId}, ${report}, 'Resin', 4, 'ltr', 50000, 'manual')`;
  await owner`insert into public.report_labour_cost (org_id, report_id, employee_id, hourly_cost_minor, ot_rate, labour_cost_minor)
              values (${orgId}, ${report}, ${emp}, 5000, 1.5, 105000)`;
  const sup = randomUUID();
  const po = randomUUID();
  const pol = randomUUID();
  const grn = randomUUID();
  await owner`insert into public.supplier (id, org_id, name) values (${sup}, ${orgId}, 'الخليج')`;
  await owner`insert into public.purchase_order (id, org_id, reference, supplier_id, job_id, status, vat_minor, total_minor, created_by)
              values (${po}, ${orgId}, 'PO-001', ${sup}, ${job}, 'approved', 5000, 105000, ${ownerUser})`;
  await owner`insert into public.purchase_order_line (id, org_id, po_id, item_name, qty, unit, unit_cost_minor, line_total_minor)
              values (${pol}, ${orgId}, ${po}, 'Ply', 10, 'ea', 10000, 100000)`;
  await owner`insert into public.goods_receipt (id, org_id, reference, po_id, status, received_date, created_by)
              values (${grn}, ${orgId}, 'GRN-001', ${po}, 'recorded', '2026-02-02', ${ownerUser})`;
  await owner`insert into public.goods_receipt_line (org_id, grn_id, po_line_id, ordered_qty, received_qty, damaged_qty, rejected_qty)
              values (${orgId}, ${grn}, ${pol}, 10, 6, 0, 0)`;
  const cats =
    (await owner`select value from public.app_settings where org_id = ${orgId} and key = 'config.categories.expense'`) as unknown as Array<{
      value: { categories: Array<{ key: string; costing_mapping: string }> };
    }>;
  const cat = cats[0]!.value.categories.find((c) => c.costing_mapping === "job_materials")!.key;
  await owner`insert into public.expense (org_id, reference, job_id, category_key, costing_mapping, description, expense_date, amount_minor, vat_amount_minor, total_minor, created_by)
              values (${orgId}, 'EXP-001', ${job}, ${cat}, 'job_materials', 'seed', '2026-02-03', 30000, 1500, 31500, ${ownerUser})`;
  await refreshRollup(ctx(), job);
  const [rr] =
    (await owner`select * from public.cost_rollup where org_id = ${orgId} and job_id = ${job}`) as unknown as Array<
      Record<string, string>
    >;
  const [lc] =
    (await owner`select * from public.cost_rollup_labour where org_id = ${orgId} and job_id = ${job}`) as unknown as Array<
      Record<string, string>
    >;
  const parityOk =
    Number(rr!.total_ex_labour_minor) === 290000 && Number(lc!.total_cost_minor) === 395000;
  log(
    `✓ PARITY: ex-labour=${rr!.total_ex_labour_minor} total=${lc!.total_cost_minor} → ${parityOk ? "MATCH (290000/395000)" : "MISMATCH!"}`,
  );

  // ── guided import (customers) through the governed service ──
  const staged = await stageImport(ctx(), "owner", {
    kind: "customers",
    filename: "customers.csv",
    rows: [
      { name: "عميل الخليج", phone: "0501234567" },
      { name: "", phone: "x" },
    ],
  });
  const impApplied = await applyImport(ctx(), "owner", staged.batchId);
  log(
    `✓ guided import: staged ${staged.total} (valid ${staged.valid}, invalid ${staged.invalid}) → applied ${impApplied.applied} customer(s)`,
  );

  // ── per-org onboarding-call cap ──
  await owner`insert into public.org_entitlement_override (org_id, entitlement_key, limit_value)
              values (${orgId}, 'limit.ai_onboarding_calls', 1)
              on conflict (org_id, entitlement_key) do update set limit_value = 1`;
  invalidateEntitlements(orgId);
  let capped = false;
  try {
    await startOnboarding(ctx(), "owner", {
      business_name: "x",
      country: "AE",
      base_currency: "AED",
      languages: ["ar"],
      six_day_week: false,
      vat_registered: false,
      job_term_en: "Boat",
      job_term_ar: "قارب",
      approval_auto_approve_below: {},
      requested_features: [],
    });
  } catch (e) {
    capped = e instanceof OnboardingCapError;
  }
  log(`✓ onboarding-call cap: further proposal blocked=${capped}`);

  // ── undo restores config ──
  const undone = await undoOnboarding(ctx(), "owner", started.sessionId);
  const afterUndo = await getInstalledTemplate(ctx());
  log(`✓ undo: reverted ${undone.undone} revisions; template installed after undo=${!!afterUndo}`);

  const dod =
    !cold && !!installedNow && parityOk && impApplied.applied === 1 && capped && !afterUndo;
  log(`✓ DoD: ${dod ? "PASS" : "REVIEW"}`);

  await cleanup();
  const [left] =
    (await owner`select count(*)::int as n from public.org where id = ${orgId}`) as unknown as Array<{
      n: number;
    }>;
  log(`✓ cleanup complete — org rows left: ${left!.n} (expect 0)`);
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
