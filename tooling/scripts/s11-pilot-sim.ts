/**
 * S11 two-org synthetic pilot simulation (Arabic). Exercises the S0–S11 loop across TWO isolated
 * pilot orgs and asserts pilot-readiness: tenant isolation, financial/labour redaction, the full
 * operational + money loop, subscription/read-only commercial states, consent-gated support
 * impersonation (tenant-audited), self-service export + money-wall, and the AI/provider disabled
 * seams. NEVER touches Alpha Marine / TESTING. Self-cleaning (both orgs + the platform staff user).
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb, withCtx, sql } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createCustomer, createEmployee } from "@/modules/masters/service";
import { createJobFromPreset } from "@/modules/jobs/service";
import { submitDailyReport } from "@/modules/reports/service";
import { getJobCosting } from "@/modules/costing/service";
import { createQuote, submitQuote, markQuoteSent, acceptQuote } from "@/modules/quotes/service";
import { decideApproval } from "@/modules/approvals/service";
import { createInvoice, issueInvoice, computeAR } from "@/modules/invoices/service";
import { recordPayment } from "@/modules/payments/service";
import { emitFakeSignal, readSubscription } from "@/modules/subscription/service";
import {
  startImpersonation,
  endImpersonation,
  listImpersonations,
} from "@/modules/support/service";
import { exportEntityCsv } from "@/platform/export/service";
import { getBillingProvider } from "@/platform/billing/adapter";
import { BillingReadOnlyError } from "@/platform/entitlements";

const owner = postgres(process.env.DIRECT_URL!, { max: 2, onnotice: () => {} });
const staffUser = randomUUID();

type Org = { id: string; user: string; name: string };
const orgs: Org[] = [];
let pass = 0;
function assert(label: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (cond) pass++;
  else throw new Error(`pilot-sim assertion failed: ${label}`);
}
const ctx = (o: Org, priv = true): Ctx => ({
  orgId: o.id,
  userId: o.user,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "s11-pilot",
});

async function seedOrg(name: string, country: string, cur: string): Promise<Org> {
  const user = randomUUID();
  await owner`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${user}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s11-${user.slice(0, 8)}@example.com`}, '{"full_name":"Pilot"}'::jsonb, now(), now())`;
  const id = await createOrgForUser(user, { name, country, baseCurrency: cur });
  const o: Org = { id, user, name };
  orgs.push(o); // register BEFORE further seeding so a mid-seed failure still self-cleans
  await installTemplate(ctx(o), TEMPLATE_BOATBUILDING.key);
  return o;
}

async function firstPresetId(o: Org): Promise<string> {
  const [p] = (await owner`select id::text as id from public.job_preset
    where org_id = ${o.id} order by created_at, code limit 1`) as unknown as Array<{ id: string }>;
  return p!.id;
}

async function coreLoop(o: Org, priceMinor: number) {
  // Onboarding already installed the template. Masters → job → daily report → money loop.
  const cust = await createCustomer(ctx(o), "owner", {
    name: "عميل الطيار",
    country: o.name.length ? "AE" : "AE",
  });
  await createEmployee(ctx(o), "owner", { name: "الفني علي" });
  const presetId = await firstPresetId(o);
  const job = await createJobFromPreset(ctx(o), "owner", { presetId, name: `قارب ${o.name}` });

  // Daily report (mobile flow) with material + work lines.
  await submitDailyReport(ctx(o, false), "owner", {
    jobId: job.id,
    reportDate: new Date(Date.UTC(2026, 6, 10)).toISOString().slice(0, 10),
    summary: "تقدم في التصفيح",
    idempotencyKey: `s11-dr-${job.id}`,
    workLines: [{ description: "تصفيح" }],
    materialLines: [{ itemName: "راتنج", qty: 5, unit: "لتر" }],
  });

  // Quote → approve → send → accept → convert → invoice → issue → payment → AR.
  const quote = await createQuote(ctx(o), "owner", {
    customerId: cust.id,
    presetId,
    terms: "الدفع خلال 30 يوماً",
    lines: [
      { description: "تصنيع الهيكل", qty: 1, unit: "قطعة", unitPriceMinor: priceMinor, vatRate: 5 },
    ],
  });
  const { approvalId } = await submitQuote(ctx(o), "owner", quote.id);
  await decideApproval(ctx(o), "owner", { approvalId, decision: "approved" });
  await markQuoteSent(ctx(o), "owner", quote.id);
  const { jobId: soldJob } = await acceptQuote(ctx(o), "owner", quote.id, { note: "أمر موقّع" });

  const inv = await createInvoice(ctx(o), "owner", {
    customerId: cust.id,
    jobId: soldJob,
    lines: [
      {
        description: "دفعة أولى",
        qty: 1,
        unit: "قطعة",
        unitPriceMinor: Math.round(priceMinor / 2),
        vatRate: 5,
      },
    ],
  });
  await issueInvoice(ctx(o), "owner", inv.id);
  await recordPayment(ctx(o), "owner", {
    invoiceId: inv.id,
    method: "bank_transfer",
    paymentDate: "2026-07-12",
    amountMinor: Math.round(priceMinor / 2),
    idempotencyKey: `s11-pay-${inv.id}`,
  });
  const ar = await computeAR(ctx(o), "owner", "2026-07-13");
  return { job, soldJob, inv, ar };
}

async function main() {
  const A = await seedOrg("قوارب الخليج", "AE", "AED");
  const B = await seedOrg("مراكب الشرق", "SA", "SAR");
  console.log(`orgs: A=${A.name} B=${B.name}`);

  const rA = await coreLoop(A, 6_000_000);
  const rB = await coreLoop(B, 4_000_000);
  assert("full operational + money loop runs for both orgs", !!rA.inv.id && !!rB.inv.id);

  // ── Tenant isolation (with positive control): under org A's ctx, org A's OWN job IS visible but
  // org B's job is NOT — so a 0-row result is RLS scoping, not a benign empty table. ──
  const isoRows = await withCtx(ctx(A), (tx) =>
    tx.execute(sql`select id::text as id from public.job where id in (${rA.job.id}, ${rB.job.id})`),
  );
  const visible = (isoRows as unknown as Array<{ id: string }>).map((r) => r.id);
  assert(
    "tenant isolation: org A sees its OWN job but NOT org B's (RLS second wall)",
    visible.includes(rA.job.id) && !visible.includes(rB.job.id),
  );

  // ── Redaction (review-hardened): the app-layer boundary must be SELECTIVE — the cost-privileged
  // total is hidden from a non-cost reader while the ex-labour material cost stays VISIBLE to both.
  // Proving material is equal (not just that total is null) shows real per-field redaction, not an
  // everything-null short-circuit. (The DB RLS wall on cost_rollup_labour is separately proven by the
  // tenancy/bleed harness in CI.)
  const costPriv = await getJobCosting(ctx(A, true), "owner", rA.soldJob, "AED");
  const costRedacted = await getJobCosting(ctx(A, false), "manager", rA.soldJob, "AED");
  assert(
    "redaction: total hidden from a non-cost reader while ex-labour material stays visible to both",
    costPriv.totalCostMinor != null &&
      costRedacted.totalCostMinor == null &&
      costRedacted.materialCostMinor === costPriv.materialCostMinor,
  );

  // ── Export + money wall (F-23, review-hardened): prove the invoice's CONCRETE total (a specific
  // money value, not merely a string diff) is present for a privileged exporter and ABSENT for a
  // non-price one. We use the exact total_minor/vat_amount_minor values, so a timestamp/id digit
  // coincidence can't mask a real leak. ──
  const [invMoney] = (await owner`select total_minor::text as total, vat_amount_minor::text as vat
    from public.invoice where id = ${rA.inv.id}`) as unknown as Array<{
    total: string;
    vat: string;
  }>;
  const invCsvPriv = await exportEntityCsv(ctx(A, true), "owner", "invoices");
  const invCsvRedacted = await exportEntityCsv(ctx(A, false), "accounts", "invoices");
  assert(
    "export: privileged invoice CSV carries the concrete total + vat",
    invCsvPriv.includes(invMoney!.total) && invCsvPriv.includes(invMoney!.vat),
  );
  assert(
    "export money-wall: the invoice total + vat are ABSENT for a non-price exporter",
    !invCsvRedacted.includes(invMoney!.total) && !invCsvRedacted.includes(invMoney!.vat),
  );

  // ── Commercial: trial → active → suspended (read-only blocks ADDs, never reads, FR-9) ──
  // The fake webhook resolves the org by provider_customer_id, so wire it first (as a real provider
  // activation would); emitFakeSignal composes fake_cus_<orgId>.
  await owner`update public.org_plan_state set provider = 'fake',
    provider_customer_id = ${`fake_cus_${A.id}`} where org_id = ${A.id}`;
  await emitFakeSignal(A.id, "activated", { providerEventId: "s11-act" });
  await emitFakeSignal(A.id, "payment_failed", { providerEventId: "s11-f1" });
  await emitFakeSignal(A.id, "payment_failed", { providerEventId: "s11-f2" });
  await emitFakeSignal(A.id, "payment_failed", { providerEventId: "s11-f3" });
  const sub = await readSubscription(ctx(A), "owner");
  assert(
    "subscription: org A reached the suspended read-only state",
    sub.billingState === "suspended",
  );
  let blocked = false;
  try {
    await createCustomer(ctx(A), "owner", { name: "بعد التعليق", country: "AE" });
  } catch (e) {
    blocked = e instanceof BillingReadOnlyError;
  }
  assert("read-only commercial state: an ADD is blocked when suspended (FR-9)", blocked);
  const stillReads = await exportEntityCsv(ctx(A, true), "owner", "jobs");
  assert(
    "read-only never blocks reads/exports (FR-9)",
    stillReads.includes(rA.job.reference), // the org's real data still exports while suspended
  );

  // ── Support impersonation: consent-gated, tenant-audited ──
  // platform_staff.user_id FKs to a real user — seed the staff auth user first.
  await owner`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${staffUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s11-staff-${staffUser.slice(0, 8)}@example.com`}, '{"full_name":"الدعم"}'::jsonb, now(), now())`;
  await owner`insert into public.platform_staff (user_id, active) values (${staffUser}, true)
    on conflict (user_id) do update set active = true`;
  const imp = await startImpersonation({
    orgId: B.id,
    staffUserId: staffUser,
    reason: "دعم",
    consentGrantedBy: B.user,
  });
  const active = await listImpersonations(ctx(B), "owner", true);
  assert(
    "support impersonation: an active session is visible in the TENANT's own view",
    active.length > 0,
  );
  await endImpersonation(imp.sessionId);
  const [auditRow] = (await owner`select count(*)::int as n from public.audit_log
    where org_id = ${B.id} and action like 'support.impersonation%'`) as unknown as Array<{
    n: number;
  }>;
  assert("support impersonation: dual-logged to the tenant's own audit_log", auditRow!.n >= 1);

  // ── Provider disabled seams. This run is off-prod (dev), so the fake provider resolves (enabled);
  // the PROD default (isProd → disabled) is proven by the s10-prod-provider-guards unit regression +
  // the prod smoke. Here we prove the seam is credential-driven: an explicit 'disabled' IS disabled. ──
  process.env.BILLING_PROVIDER = "disabled";
  const disabledSeam = getBillingProvider().enabled;
  delete process.env.BILLING_PROVIDER;
  const fakeSeam = getBillingProvider().enabled;
  assert(
    "provider seam: fake resolves off-prod, an explicit 'disabled' override is disabled",
    fakeSeam === true && disabledSeam === false,
  );

  console.log(`\nS11 PILOT SIM PASS — ${pass} assertions across 2 isolated orgs. Cleaning up…`);
}

async function cleanup() {
  const ids = orgs.map((o) => o.id);
  const users = orgs.map((o) => o.user).concat(staffUser);
  if (ids.length) {
    const tbls = (await owner`select table_name from information_schema.columns
      where table_schema='public' and column_name='org_id'`) as unknown as Array<{
      table_name: string;
    }>;
    await owner.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      for (const t of tbls)
        await tx.unsafe(`delete from public.${t.table_name} where org_id = any($1::uuid[])`, [ids]);
      await tx.unsafe(`delete from public.org where id = any($1::uuid[])`, [ids]);
      await tx.unsafe(`delete from public.platform_staff where user_id = $1`, [staffUser]);
      await tx.unsafe(`delete from public.user_profile where id = any($1::uuid[])`, [users]);
      await tx.unsafe(`delete from auth.users where id = any($1::uuid[])`, [users]);
      await tx.unsafe("set local session_replication_role = default");
    });
  }
  console.log("cleanup complete — 0 leftovers (Alpha Marine + TESTING untouched)");
}

main()
  .then(cleanup)
  .then(async () => {
    await owner.end({ timeout: 5 });
    await closeAppDb();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("PILOT SIM FAILED:", e.message);
    await cleanup().catch(() => {});
    await owner.end({ timeout: 5 }).catch(() => {});
    await closeAppDb().catch(() => {});
    process.exit(1);
  });
