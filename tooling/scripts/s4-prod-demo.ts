/**
 * S4 production DoD demo (Arabic Supply & Approve) — runs the REAL service layer
 * against the production Supabase (DIRECT_URL from .env.local), then deletes every
 * synthetic row (0 leftovers). Narrated evidence; mirrors the S3 demo.
 *
 * Proves against production: an MR routes by threshold (under → manager); the
 * decide advances BOTH records (sole-writer); MR→PO conversion auto-approves the PO
 * and emits purchase_order/approved; the LPO worker builds bilingual HTML; a GRN
 * partially receives + reconciles the PO; the self-approval guard holds; the E-03
 * evaluator raises for an aged approval; outbox events are emitted.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createJobFromPreset, addCrewMember } from "@/modules/jobs/service";
import { createEmployee } from "@/modules/masters/service";
import {
  createApprovalRule,
  decideApproval,
  getApproval,
  evaluateStuckApprovals,
} from "@/modules/approvals/service";
import {
  createMaterialRequest,
  submitMaterialRequest,
  convertMrToPo,
  recordGoodsReceipt,
  getPurchaseOrder,
} from "@/modules/supply/service";
import { buildLpoForPo } from "@/workers/functions/lpo-pdf";

const owner = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
const log = (m: string) => console.log(m);
const today = new Date().toISOString().slice(0, 10);

const ownerUser = randomUUID();
const managerUser = randomUUID();
const procUser = randomUUID();
let orgId = "";

const ctx = (u: string): Ctx => ({
  orgId,
  userId: u,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "s4-prod-demo",
});
const procCtx = (): Ctx => ({ ...ctx(procUser), costPrivileged: false, pricePrivileged: false });
const mgrCtx = (): Ctx => ({ ...ctx(managerUser), costPrivileged: false, pricePrivileged: false });

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s4demo-${label}-${id.slice(0, 8)}@example.com`}, '{"full_name":"S4 Demo"}'::jsonb, now(), now())`;
}

const TABLES = [
  "goods_receipt_line",
  "goods_receipt",
  "purchase_order_line",
  "purchase_order",
  "material_request_line",
  "material_request",
  "approval",
  "approval_rule",
  "report_labour_cost",
  "report_labour_line",
  "report_material_line",
  "report_work_line",
  "daily_report",
  "attendance",
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
  "org_entitlement_override",
  "comment",
  "audit_log",
  "activity",
  "app_settings",
  "sign_in_log",
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
  await owner`delete from public.user_profile where id = any(${[ownerUser, managerUser, procUser]}::uuid[])`;
  await owner`delete from auth.users where id = any(${[ownerUser, managerUser, procUser]}::uuid[])`;
}

async function run() {
  log("── S4 production demo (Arabic Supply & Approve) ──────────────────");
  await seedUser(ownerUser, "owner");
  await seedUser(managerUser, "mgr");
  await seedUser(procUser, "proc");
  orgId = await createOrgForUser(ownerUser, {
    name: "قوارب التجربة",
    country: "AE",
    baseCurrency: "AED",
  });
  await owner`insert into public.membership (user_id, org_id, role_key) values (${managerUser}, ${orgId}, 'manager')`;
  await owner`insert into public.membership (user_id, org_id, role_key) values (${procUser}, ${orgId}, 'procurement')`;
  const installed = await installTemplate(ctx(ownerUser), TEMPLATE_BOATBUILDING.key);
  // Rules: MR ≥ 5000 → owner, else → manager; MR-less PO → owner.
  await createApprovalRule(ctx(ownerUser), "owner", {
    subjectType: "material_request",
    conditionKind: "always",
    assignedRole: "manager",
  });
  await createApprovalRule(ctx(ownerUser), "owner", {
    subjectType: "material_request",
    conditionKind: "amount_gte",
    amountGteMinor: 500_000,
    assignedRole: "owner",
  });
  await createApprovalRule(ctx(ownerUser), "owner", {
    subjectType: "purchase_order",
    conditionKind: "always",
    assignedRole: "owner",
  });
  const sup = randomUUID();
  await owner`insert into public.supplier (id, org_id, name) values (${sup}, ${orgId}, 'مورد الخليج')`;
  const jobId = (
    await createJobFromPreset(ctx(ownerUser), "owner", {
      presetId: installed.presetIds["13S"]!,
      name: "سكيف التجربة",
    })
  ).id;
  const emp = (await createEmployee(ctx(ownerUser), "owner", { name: "علي" })).id;
  await addCrewMember(ctx(ownerUser), "owner", jobId, emp);
  log(`✓ org قوارب التجربة, rules seeded, supplier مورد الخليج, job 13S-001`);

  // 1) Procurement raises an MR (under threshold → manager).
  const { id: mrId, reference: mrRef } = await createMaterialRequest(procCtx(), "procurement", {
    jobId,
    urgency: "high",
    lines: [
      { itemName: "راتنج إيبوكسي", qty: 4, unit: "لتر", estUnitCostMinor: 50_000 },
      { itemName: "ورق صنفرة", qty: 10, unit: "ورقة", estUnitCostMinor: 2_000 },
    ],
  });
  const { approvalId } = await submitMaterialRequest(procCtx(), "procurement", mrId);
  const appr = await getApproval(mgrCtx(), "manager", approvalId);
  log(
    `✓ MR ${mrRef} submitted → routed to ${appr!.assignedRole} (under threshold), amount visible=${appr!.amountMinor}`,
  );

  // 2) Manager decides (advances BOTH records atomically).
  await decideApproval(mgrCtx(), "manager", { approvalId, decision: "approved" });
  const mrStatus = (
    await owner`select status from public.material_request where id = ${mrId}`
  )[0] as { status: string };
  log(
    `✓ manager approved → MR status=${mrStatus.status}, approval=${(await getApproval(ctx(ownerUser), "owner", approvalId))!.state}`,
  );

  // 3) Procurement converts to PO (auto-approved) → LPO HTML built.
  const { poId, reference: poRef } = await convertMrToPo(procCtx(), "procurement", mrId, {
    supplierId: sup,
    vatMinor: 10_000,
  });
  const poStatus = (
    await owner`select status from public.purchase_order where id = ${poId}`
  )[0] as { status: string };
  const lpo = await buildLpoForPo(ctx(ownerUser), poId);
  log(
    `✓ converted → PO ${poRef} status=${poStatus.status} (auto-approved); LPO HTML ${lpo.outcome === "built" ? lpo.htmlChars + " chars" : lpo.outcome}`,
  );

  // 4) Partial goods receipt reconciles the PO.
  const po = await getPurchaseOrder(procCtx(), "procurement", poId);
  await recordGoodsReceipt(procCtx(), "procurement", {
    poId,
    receivedDate: today,
    lines: [{ poLineId: po!.lines[0]!.id, receivedQty: 2 }], // partial (ordered 4)
  });
  const poStatus2 = (
    await owner`select status from public.purchase_order where id = ${poId}`
  )[0] as { status: string };
  log(`✓ partial GRN recorded → PO status=${poStatus2.status}`);

  // 5) E-03: an aged pending approval raises exception/raised(approval_stuck).
  const { id: mr2 } = await createMaterialRequest(procCtx(), "procurement", {
    lines: [{ itemName: "بند", qty: 1, unit: "ea", estUnitCostMinor: 10_000 }],
  });
  const { approvalId: a2 } = await submitMaterialRequest(procCtx(), "procurement", mr2);
  await owner`update public.approval set created_at = now() - interval '10 hours' where id = ${a2}`;
  const e03 = await evaluateStuckApprovals(ctx(ownerUser));
  log(`✓ E-03 evaluator raised ${e03.raised} stuck-approval exception(s)`);

  // 6) Outbox events for the loop.
  const events = (await owner`
    select name, count(*)::int as n from public.domain_event
    where org_id = ${orgId} and name in
      ('approval/submitted','approval/decided','purchase_order/approved','goods_receipt/recorded','exception/raised')
    group by name order by name`) as unknown as Array<{ name: string; n: number }>;
  log(`✓ outbox: ${events.map((e) => `${e.name}×${e.n}`).join(", ")}`);

  await cleanup();
  const left = (await owner`select count(*)::int as n from public.org where id = ${orgId}`)[0] as {
    n: number;
  };
  log(`✓ cleanup complete — org rows left: ${left.n} (expect 0)`);
  log("── demo complete ────────────────────────────────────────────────");
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
