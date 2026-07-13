/**
 * S6 production DoD demo (Arabic "Bill") — runs the REAL service layer against
 * production Supabase (DIRECT_URL), then deletes every synthetic row (0 leftovers).
 *
 * Proves against production (doc 11 S6 DoD): the full money loop —
 *   quote → submit → approve → send → accept → convert-to-job (selling_price set)
 *   → invoice → issue → e-invoice (fake adapter CLEARS) → payment → AR drops to 0 → credit note —
 * plus invoice totals to the minor unit, issued-invoice immutability, price
 * redaction for a non-privileged viewer, and E-10 overdue raise + self-heal.
 *
 * Touches ONLY its own synthetic org (Arabic name). Production orgs — Alpha Marine,
 * TESTING — are never read or written. Cleanup removes every row it created.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createQuote, submitQuote, markQuoteSent, acceptQuote } from "@/modules/quotes/service";
import { decideApproval } from "@/modules/approvals/service";
import {
  createInvoice,
  issueInvoice,
  voidInvoice,
  createCreditNote,
  submitEInvoice,
  computeAR,
  getInvoice,
} from "@/modules/invoices/service";
import { recordPayment } from "@/modules/payments/service";
import { evaluateNightly, listOpenExceptions } from "@/modules/exceptions/service";

const owner = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
const log = (m: string) => console.log(m);

const ownerUser = randomUUID();
let orgId = "";
const ctx = (priv: boolean): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "s6-prod-demo",
});
const ownerCtx = () => ctx(true);
const redactedCtx = () => ctx(false);

const AS_OF = new Date().toISOString().slice(0, 10);
const pastDue = () => {
  const d = new Date(`${AS_OF}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 42);
  return d.toISOString().slice(0, 10);
};

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s6demo-${label}-${id.slice(0, 8)}@example.com`}, '{"full_name":"S6 Demo"}'::jsonb, now(), now())`;
}

// FK-topological, children before parents. S6 billing tables lead so they clear
// before the job/customer/quote they reference (all on delete restrict).
const TABLES = [
  "payment_receipt",
  "payment",
  "einvoice_submission",
  "invoice_line",
  "invoice",
  "quote_line",
  "quote",
  "exception",
  "domain_event",
  "notification",
  "notification_preference",
  "task",
  "job_crew",
  "job_stage",
  "job",
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
  // Credit notes carry a self-FK to the invoice they correct (restrict) — remove
  // them before the generic invoice delete so the single statement can't trip it.
  await owner`delete from public.invoice where org_id = ${orgId} and corrects_invoice_id is not null`;
  for (const t of TABLES) await owner.unsafe(`delete from public.${t} where org_id = $1`, [orgId]);
  await owner`delete from public.org where id = ${orgId}`;
  await owner`delete from public.user_profile where id = ${ownerUser}`;
  await owner`delete from auth.users where id = ${ownerUser}`;
}

async function run() {
  log("── S6 production demo (Arabic Bill) ───────────────────────────────");
  await seedUser(ownerUser, "owner");
  orgId = await createOrgForUser(ownerUser, {
    name: "قوارب الفوترة",
    country: "AE",
    baseCurrency: "AED",
  });
  const installed = await installTemplate(ownerCtx(), TEMPLATE_BOATBUILDING.key);
  const presetId = Object.values(installed.presetIds)[0]!;
  const customerId = randomUUID();
  await owner`insert into public.customer (id, org_id, name, tax_reg_no, active)
              values (${customerId}, ${orgId}, 'شركة الخليج البحرية', '100123456700003', true)`;
  log("✓ org قوارب الفوترة + customer شركة الخليج البحرية (tax-registered)");

  // 1) Quote → submit → approve (terminal owner) → send → accept → convert to job.
  const quote = await createQuote(ownerCtx(), "owner", {
    customerId,
    presetId,
    terms: "الدفع خلال 30 يوماً",
    lines: [
      { description: "تصنيع الهيكل", qty: 1, unit: "قطعة", unitPriceMinor: 5000000, vatRate: 5 },
      { description: "أعمال التجهيز", qty: 2, unit: "يوم", unitPriceMinor: 250000, vatRate: 5 },
    ],
  });
  const { approvalId } = await submitQuote(ownerCtx(), "owner", quote.id);
  await decideApproval(ownerCtx(), "owner", { approvalId, decision: "approved" });
  await markQuoteSent(ownerCtx(), "owner", quote.id);
  const { jobId } = await acceptQuote(ownerCtx(), "owner", quote.id, { note: "أمر شراء موقّع" });
  const [q] = (await owner`select reference, status, total_minor, base_total_minor,
    converted_job_id::text as job from public.quote where id = ${quote.id}`) as unknown as Array<
    Record<string, string>
  >;
  const [job] =
    (await owner`select reference, selling_price_minor from public.job where id = ${jobId}`) as unknown as Array<
      Record<string, string>
    >;
  const convertOk =
    q!.status === "converted" &&
    q!.job === jobId &&
    Number(job!.selling_price_minor) === Number(q!.base_total_minor);
  log(
    `✓ quote ${q!.reference}: total=${q!.total_minor} → job ${job!.reference} selling_price=${job!.selling_price_minor} (convert ${convertOk ? "OK" : "FAIL"})`,
  );

  // 2) Invoice for the job (VAT-registered base), issue, then prove immutability.
  const inv = await createInvoice(ownerCtx(), "owner", {
    customerId,
    jobId,
    dueDate: pastDue(),
    lines: [
      { description: "الدفعة الأولى", qty: 1, unit: "قطعة", unitPriceMinor: 2000000, vatRate: 5 },
    ],
  });
  const [ir] = (await owner`select reference, subtotal_minor, vat_amount_minor, total_minor
    from public.invoice where id = ${inv.id}`) as unknown as Array<Record<string, string>>;
  const totalsOk =
    Number(ir!.subtotal_minor) === 2000000 &&
    Number(ir!.vat_amount_minor) === 100000 &&
    Number(ir!.total_minor) === 2100000;
  await issueInvoice(ownerCtx(), "owner", inv.id);
  let immutable = false;
  try {
    await voidInvoice(ownerCtx(), "owner", inv.id, "محاولة إلغاء");
  } catch {
    immutable = true; // issued invoice cannot be voided — credit note only
  }
  log(
    `✓ invoice ${ir!.reference}: total=${ir!.total_minor} (math ${totalsOk ? "OK" : "FAIL"}); issued & immutable=${immutable}`,
  );

  // 3) E-invoice adapter (fake provider CLEARS a tax-registered domestic supply).
  const einv = await submitEInvoice(ownerCtx(), "owner", inv.id);
  log(`✓ e-invoice submission status=${einv.status} (adapter seam; fake provider in non-prod)`);

  // 4) AR shows it outstanding + aged; E-10 overdue raises on the nightly sweep.
  const arBefore = await computeAR(ownerCtx(), "owner", AS_OF);
  const nightly1 = await evaluateNightly(ownerCtx(), {
    asOf: AS_OF,
    nowMs: Date.parse(`${AS_OF}T03:00:00Z`),
  });
  const open1 = await listOpenExceptions(ownerCtx(), "owner", { limit: 200 });
  const e10raised = open1.some((e) => e.ruleKey === "overdue_invoice" && e.subjectId === inv.id);
  log(
    `✓ AR outstanding=${arBefore.outstandingMinor} (aged: 31-60=${arBefore.d31_60}); E-10 overdue raised=${e10raised} (billing sweep=${nightly1.billing})`,
  );

  // 5) Redaction: a non-price-privileged viewer sees NO money.
  const asOwner = await getInvoice(ownerCtx(), "accounts", inv.id);
  const asRedacted = await getInvoice(redactedCtx(), "accounts", inv.id);
  const redactionOk = asOwner?.totalMinor === 2100000 && asRedacted?.totalMinor === null;
  log(
    `✓ redaction: owner sees ${asOwner?.totalMinor}, redacted sees ${asRedacted?.totalMinor} (wall ${redactionOk ? "HELD" : "LEAK!"})`,
  );

  // 6) Full payment → invoice paid, receipt issued, AR clears, E-10 self-heals.
  const pay = await recordPayment(ownerCtx(), "owner", {
    invoiceId: inv.id,
    method: "bank_transfer",
    paymentDate: AS_OF,
    amountMinor: 2100000,
  });
  const [pinv] =
    (await owner`select status from public.invoice where id = ${inv.id}`) as unknown as Array<{
      status: string;
    }>;
  const arAfter = await computeAR(ownerCtx(), "owner", AS_OF);
  await evaluateNightly(ownerCtx(), { asOf: AS_OF, nowMs: Date.parse(`${AS_OF}T03:00:00Z`) });
  const open2 = await listOpenExceptions(ownerCtx(), "owner", { limit: 200 });
  const e10healed = !open2.some((e) => e.ruleKey === "overdue_invoice" && e.subjectId === inv.id);
  log(
    `✓ payment ${pay.reference} (receipt ${pay.receiptReference}): invoice=${pinv!.status}, AR outstanding=${arAfter.outstandingMinor}, E-10 self-healed=${e10healed}`,
  );

  // 7) Credit note corrects the issued invoice (never a cancel post-issuance).
  const cn = await createCreditNote(ownerCtx(), "owner", inv.id, "تسوية بعد التسليم");
  const [cnr] =
    (await owner`select reference, kind, total_minor from public.invoice where id = ${cn.id}`) as unknown as Array<
      Record<string, string>
    >;
  log(`✓ credit note ${cnr!.reference} kind=${cnr!.kind} total=${cnr!.total_minor}`);

  // 8) Outbox events for the loop.
  const events = (await owner`select name, count(*)::int as n from public.domain_event
    where org_id = ${orgId} and name in ('quote/accepted','invoice/issued','credit_note/issued','payment/recorded')
    group by name order by name`) as unknown as Array<{ name: string; n: number }>;
  log(`✓ outbox: ${events.map((e) => `${e.name}×${e.n}`).join(", ")}`);

  const dod =
    convertOk &&
    totalsOk &&
    immutable &&
    redactionOk &&
    pinv!.status === "paid" &&
    arAfter.outstandingMinor === 0 &&
    e10raised &&
    e10healed;
  log(`✓ DoD money loop: ${dod ? "PASS" : "FAIL"}`);

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
