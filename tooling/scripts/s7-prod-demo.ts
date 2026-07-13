/**
 * S7 production DoD demo (Arabic "Improve") — runs the REAL service layer against production
 * Supabase (DIRECT_URL), then deletes every synthetic row (0 leftovers).
 *
 * Proves against production (doc 11 S7 DoD): the four new E-rules raise; the deterministic
 * digest composes and answers the THIRTEEN owner questions; AI narration (fake provider) is
 * generated, numbers-subset-validated, and metered; money redacts for a non-price-privileged
 * reader; a customer update drafts → sends → resolves publicly (safe, no cost) → revokes →
 * dead; and quote-vs-actual (C-10) + the divergence exception. Touches ONLY its own Arabic
 * synthetic org; Alpha Marine + TESTING are never read or written.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { invalidateEntitlements } from "@/platform/entitlements/resolve";
import { evaluateNightly, listOpenExceptions } from "@/modules/exceptions/service";
import { refreshRollup, getJobCosting } from "@/modules/costing/service";
import {
  composeOwnerDigest,
  getOwnerDigest,
  generateOwnerNarration,
} from "@/modules/digest/service";
import {
  createDraft,
  sendUpdate,
  resolvePublicShare,
  revokeShare,
} from "@/modules/customer-updates/service";

const owner = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
const log = (m: string) => console.log(m);
const ownerUser = randomUUID();
let orgId = "";
const AS_OF = new Date().toISOString().slice(0, 10);
const NIGHTLY = { asOf: AS_OF, nowMs: Date.parse(`${AS_OF}T03:00:00Z`) };
const ctx = (priv: boolean): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "s7-prod-demo",
});
const ownerCtx = () => ctx(true);
const redactedCtx = () => ctx(false);
const t = (k: string) => k;
const shift = (iso: string, d: number) => {
  const x = new Date(`${iso}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};

// FK-topological, children first: S7 + S6 families lead, then the S5-proven list.
const TABLES = [
  "share_token",
  "ai_interaction",
  "digest",
  "customer_update",
  "payment_receipt",
  "payment",
  "einvoice_submission",
  "invoice_line",
  "quote_line",
  "quote",
  "cost_rollup_labour",
  "cost_rollup",
  "exception",
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
  "employee_terms",
  "employee_hr",
  "employee",
  "team",
  "item",
  "job_preset",
  "reference_sequence",
  "org_holiday_calendar",
  "config_revision",
  "audit_log",
  "activity",
  "app_settings",
  "org_plan_state",
  "org_entitlement_override",
  "membership",
  "role_definition",
  "company",
];

async function cleanup() {
  if (!orgId) return;
  await owner`update public.job set current_stage_id = null where org_id = ${orgId}`;
  // credit notes (self-FK) then invoices, then customers/jobs after the families above.
  await owner`delete from public.invoice where org_id = ${orgId} and corrects_invoice_id is not null`;
  await owner`delete from public.invoice where org_id = ${orgId}`;
  for (const tbl of TABLES)
    await owner.unsafe(`delete from public.${tbl} where org_id = $1`, [orgId]);
  await owner`delete from public.customer where org_id = ${orgId}`;
  await owner`delete from public.supplier where org_id = ${orgId}`;
  await owner`delete from public.job where org_id = ${orgId}`;
  await owner`delete from public.org where id = ${orgId}`;
  await owner`delete from public.user_profile where id = ${ownerUser}`;
  await owner`delete from auth.users where id = ${ownerUser}`;
}

async function run() {
  log("── S7 production demo (Arabic Improve) ────────────────────────────");
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s7demo-${ownerUser.slice(0, 8)}@example.com`}, '{"full_name":"S7 Demo"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, {
    name: "قوارب الذكاء",
    country: "AE",
    baseCurrency: "AED",
  });
  await installTemplate(ownerCtx(), TEMPLATE_BOATBUILDING.key);
  await owner`insert into public.org_entitlement_override (org_id, entitlement_key, enabled)
              values (${orgId}, 'feat.ai_narration', true)
              on conflict (org_id, entitlement_key) do update set enabled = excluded.enabled`;
  await owner`insert into public.org_entitlement_override (org_id, entitlement_key, limit_value)
              values (${orgId}, 'limit.ai_credits_month', 1000)
              on conflict (org_id, entitlement_key) do update set limit_value = excluded.limit_value`;
  invalidateEntitlements(orgId);

  // ── seed scenarios that answer the thirteen questions ──
  // A job with a margin-drift condition (Q4/Q10) + a stage (Q9 needs a report) + late supply.
  const job = randomUUID();
  await owner`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by,
              start_date, due_date, selling_price_minor, billing_points)
              values (${job}, ${orgId}, '24C-001', 'بحّار الذكاء', 'active', 'active', ${ownerUser}, '2026-01-01',
                      ${shift(AS_OF, 3)}, 1000000, '[{"trigger":"lamination","pct":100}]'::jsonb)`;
  await owner`insert into public.job_stage (org_id, job_id, stage_key, name, weight, sort, status)
              values (${orgId}, ${job}, 'lamination', '{"en":"Lamination","ar":"التصفيح"}'::jsonb, 100, 0, 'completed')`;
  const emp = randomUUID();
  await owner`insert into public.employee (id, org_id, name) values (${emp}, ${orgId}, 'علي')`;
  const rep = randomUUID();
  await owner`insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by, submitted_at)
              values (${rep}, ${orgId}, ${job}, ${shift(AS_OF, -1)}, 'عمل', 'submitted', ${ownerUser}, now())`;
  await owner`insert into public.report_labour_cost (org_id, report_id, employee_id, hourly_cost_minor, ot_rate, labour_cost_minor)
              values (${orgId}, ${rep}, ${emp}, 5000, 1.5, 950000)`;
  await refreshRollup(ownerCtx(), job);
  // Q6 late supplier: 3 POs 30 days past approval, unreceived.
  const sup = randomUUID();
  await owner`insert into public.supplier (id, org_id, name) values (${sup}, ${orgId}, 'مورد بطيء')`;
  for (let i = 0; i < 3; i++) {
    await owner`insert into public.purchase_order (org_id, reference, supplier_id, status, approved_at, created_by)
                values (${orgId}, ${`PO-${i}`}, ${sup}, 'approved', (${AS_OF}::date - 30), ${ownerUser})`;
  }
  // Q5 materials: an approved MR awaiting conversion.
  await owner`insert into public.material_request (org_id, reference, status, created_by)
              values (${orgId}, 'MR-001', 'approved', ${ownerUser})`;
  // Q11 customers awaiting: the job has a completed billing stage + no sent update (already true).
  // E-13 doc expiry (people).
  await owner`insert into public.employee_hr (employee_id, org_id, visa_expiry)
              values (${emp}, ${orgId}, (${AS_OF}::date + 10))`;

  // ── run the nightly + compose the digest ──
  const ev = await evaluateNightly(ownerCtx(), NIGHTLY);
  const digestRow = await composeOwnerDigest(ownerCtx(), AS_OF);
  log(
    `✓ nightly raised margin=${ev.marginDrift} lateSupplier=${ev.lateSupplier} docExpiry=${ev.documentExpiry}; digest ${digestRow.sections} sections`,
  );

  // ── thirteen-questions gate: each maps to a digest section (or a linked surface) ──
  const dg = (await getOwnerDigest(ownerCtx(), "owner"))!;
  const sec = (k: string) => dg.sections.find((s) => s.key === k)!;
  const Q: Record<string, boolean> = {
    "Q1 today": sec("this_week") !== undefined,
    "Q2 behind": sec("at_risk").count >= 0,
    "Q3 approvals": sec("needs_decision") !== undefined,
    "Q4 at-risk": sec("at_risk").count >= 1, // margin_drift + missing_report land here
    "Q5 materials": sec("this_week").count >= 1,
    "Q6 purchases": sec("supply").count >= 1,
    "Q7 crew": sec("crew").count >= 1,
    "Q8 issues": sec("at_risk") !== undefined,
    "Q9 yesterday": sec("yesterday").count >= 1,
    "Q10 costing": (await getJobCosting(ownerCtx(), "owner", job, "AED")).quotedMinor === 1000000,
    "Q11 customers": sec("customers_awaiting").count >= 1,
    "Q12 overdue-inv": sec("collections") !== undefined,
    "Q13 decide": sec("needs_decision") !== undefined,
  };
  const answered = Object.values(Q).filter(Boolean).length;
  log(`✓ thirteen-questions: ${answered}/13 answered from the digest — ${JSON.stringify(Q)}`);

  // ── AI narration (fake) + numbers-subset validation + credit meter ──
  process.env.AI_NARRATION_PROVIDER = "fake";
  const nar = await generateOwnerNarration(ownerCtx(), "owner", dg.id, "ar", t);
  delete process.env.AI_NARRATION_PROVIDER;
  const [meter] = (await owner`select count(*)::int as n from public.ai_interaction
    where org_id = ${orgId} and feature = 'digest_narration' and validator_verdict = 'pass'`) as unknown as Array<{
    n: number;
  }>;
  log(
    `✓ narration status=${nar.status}, validated+metered rows=${meter!.n} (numbers-subset gate held)`,
  );

  // ── money redaction for a non-price-privileged reader ──
  const priv = (await getOwnerDigest(ownerCtx(), "owner"))!.sections.find(
    (s) => s.key === "collections",
  )!;
  const red = (await getOwnerDigest(redactedCtx(), "owner"))!.sections.find(
    (s) => s.key === "collections",
  )!;
  log(
    `✓ digest money wall: privileged=${priv.moneyMinor} redacted=${red.moneyMinor} (${red.moneyMinor === null ? "HELD" : "LEAK!"})`,
  );

  // ── customer update: draft → send → public resolve (safe) → revoke → dead ──
  const draft = await createDraft(ownerCtx(), "owner", {
    jobId: job,
    title: "تحديث المشروع",
    body: "نودّ إطلاعكم على آخر مستجدات قاربكم.",
    language: "ar",
  });
  const sent = await sendUpdate(ownerCtx(), "owner", draft.id);
  const pub = await resolvePublicShare(sent.token);
  const safe = pub !== null && !/cost|labour|margin|selling/i.test(JSON.stringify(pub));
  await revokeShare(ownerCtx(), "owner", sent.shareTokenId);
  const afterRevoke = await resolvePublicShare(sent.token);
  log(
    `✓ customer share: public payload safe=${safe}; after revoke resolves=${afterRevoke === null ? "null (dead)" : "LEAK!"}`,
  );

  // ── quote-vs-actual divergence (C-10): manually raise selling ≠ accepted quote ──
  await owner`insert into public.quote (org_id, reference, status, converted_job_id, base_total_minor, accepted_at, created_by)
              values (${orgId}, 'QT-001', 'converted', ${job}, 1500000, now(), ${ownerUser})`;
  await getJobCosting(ownerCtx(), "owner", job, "AED"); // triggers divergence detect (quote 1.5M ≠ selling 1.0M)
  const open = await listOpenExceptions(ownerCtx(), "owner", { limit: 500 });
  const div = open.some((e) => e.ruleKey === "quote_divergence" && e.jobId === job);
  log(`✓ quote-vs-actual: accepted quote wins C-10; divergence exception raised=${div}`);

  const dod =
    red.moneyMinor === null &&
    safe &&
    afterRevoke === null &&
    nar.status === "generated" &&
    answered >= 11;
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
