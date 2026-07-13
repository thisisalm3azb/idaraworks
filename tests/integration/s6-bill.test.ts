/**
 * S6 "Bill" integration (doc 11 S6 DoD; doc 01 L4 billing spine; doc 04 E-09/E-10).
 * Real DB. Proves the full money loop end to end:
 *   quote → submit → approve → send → accept → convert-to-job (selling_price set)
 *   → invoice → issue → e-invoice (fake adapter clears) → payment → AR drops → credit note.
 * Plus: invoice totals persisted to the minor unit under the VAT-registered base;
 * reference-sequence continuity; issued-invoice immutability (draft-only RLS on
 * invoice_line; issued invoices cannot be voided); price redaction at read; and the
 * E-09 (uninvoiced billing point) + E-10 (overdue invoice) exception raise/self-heal.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { sql } from "drizzle-orm";
import {
  createQuote,
  submitQuote,
  markQuoteSent,
  acceptQuote,
  computeQuoteTotals,
} from "@/modules/quotes/service";
import { decideApproval, createApprovalRule } from "@/modules/approvals/service";
import { ForbiddenError } from "@/platform/authz";
import {
  createInvoice,
  issueInvoice,
  voidInvoice,
  createCreditNote,
  submitEInvoice,
  computeAR,
  getInvoice,
  InvoiceStateError,
} from "@/modules/invoices/service";
import { recordPayment, voidPayment } from "@/modules/payments/service";
import { evaluateNightly, listOpenExceptions } from "@/modules/exceptions/service";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
let orgId = "";
let presetId = "";
let customerId = "";

const AS_OF = "2026-07-13";
const PAST_DUE = "2026-06-01"; // 42 days before AS_OF
const NIGHTLY = { asOf: AS_OF, nowMs: Date.parse(`${AS_OF}T03:00:00Z`) };

// The job the accepted quote converts into — set in the first block, used by the next.
let convertedJobId = "";

const ctxOf = (priv: boolean): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "s6-test",
});
const ownerCtx = () => ctxOf(true);
const redactedCtx = () => ctxOf(false);

const refNum = (ref: string) => Number(ref.split("-").pop());

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s6-owner-${run}@example.com`}, '{"full_name":"S6 Owner"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, { name: "S6 Org", country: "AE", baseCurrency: "AED" });
  const installed = await installTemplate(ownerCtx(), TEMPLATE_BOATBUILDING.key);
  presetId = Object.values(installed.presetIds)[0]!;
  // A customer WITH a tax registration → its invoices clear the fake e-invoice adapter.
  customerId = randomUUID();
  await owner`
    insert into public.customer (id, org_id, name, tax_reg_no, active)
    values (${customerId}, ${orgId}, 'Gulf Marine LLC', '100123456700003', true)`;
}, 120_000);

afterAll(async () => {
  await closeAppDb();
});

describe("quote → approve → accept → convert", () => {
  let quoteId = "";

  it("creates a quote and persists totals to the minor unit", async () => {
    const lines = [
      { description: "Hull moulding", qty: 1, unit: "ea", unitPriceMinor: 5000000, vatRate: 5 },
      { description: "Fit-out labour", qty: 2, unit: "day", unitPriceMinor: 250000, vatRate: 5 },
    ];
    const golden = computeQuoteTotals(
      lines.map((l) => ({ qty: l.qty, unitPriceMinor: l.unitPriceMinor, vatRate: l.vatRate })),
      1,
    );
    const q = await createQuote(ownerCtx(), "owner", { customerId, presetId, lines });
    quoteId = q.id;
    const [row] = (await owner`
      select subtotal_minor, vat_amount_minor, total_minor, base_total_minor, status
      from public.quote where id = ${quoteId}`) as unknown as Array<Record<string, string>>;
    expect(Number(row!.subtotal_minor)).toBe(golden.subtotalMinor);
    expect(Number(row!.vat_amount_minor)).toBe(golden.vatAmountMinor);
    expect(Number(row!.total_minor)).toBe(golden.totalMinor);
    expect(row!.status).toBe("draft");
  });

  it("submits → approves (terminal owner) → sends → accepts into a job with selling_price", async () => {
    const { approvalId } = await submitQuote(ownerCtx(), "owner", quoteId);
    await decideApproval(ownerCtx(), "owner", { approvalId, decision: "approved" });
    const [afterApprove] = (await owner`
      select status from public.quote where id = ${quoteId}`) as unknown as Array<{
      status: string;
    }>;
    expect(afterApprove!.status).toBe("approved");

    await markQuoteSent(ownerCtx(), "owner", quoteId);
    const accepted = await acceptQuote(ownerCtx(), "owner", quoteId, {
      note: "Signed PO attached",
    });
    convertedJobId = accepted.jobId;

    const [q] = (await owner`
      select status, base_total_minor, converted_job_id::text as job
      from public.quote where id = ${quoteId}`) as unknown as Array<Record<string, string>>;
    expect(q!.status).toBe("converted");
    expect(q!.job).toBe(convertedJobId);
    const [job] = (await owner`
      select selling_price_minor from public.job where id = ${convertedJobId}`) as unknown as Array<{
      selling_price_minor: string;
    }>;
    // Job selling price = the quote's frozen base total (OP-8).
    expect(Number(job!.selling_price_minor)).toBe(Number(q!.base_total_minor));
    expect(convertedJobId).not.toBe("");
  });
});

describe("invoice → issue → e-invoice → payment → AR → credit note", () => {
  let invA = "";
  let invARef = "";
  let invBRef = "";

  it("creates two invoices with a continuous reference sequence; voids the draft", async () => {
    const a = await createInvoice(ownerCtx(), "owner", {
      customerId,
      jobId: convertedJobId,
      dueDate: PAST_DUE,
      lines: [
        { description: "Milestone 1", qty: 1, unit: "ea", unitPriceMinor: 10000000, vatRate: 5 },
      ],
    });
    invA = a.id;
    invARef = a.reference;
    const b = await createInvoice(ownerCtx(), "owner", {
      customerId,
      lines: [{ description: "Scratch", qty: 1, unit: "ea", unitPriceMinor: 100, vatRate: 5 }],
    });
    invBRef = b.reference;
    expect(refNum(invBRef)).toBe(refNum(invARef) + 1);
    // Draft may be voided (pre-issuance) — issued invoices cannot (tested below).
    await voidInvoice(ownerCtx(), "owner", b.id, "created in error");
    const [vb] = (await owner`
      select status from public.invoice where id = ${b.id}`) as unknown as Array<{
      status: string;
    }>;
    expect(vb!.status).toBe("cancelled");
  });

  it("persists invoice totals under the VAT-registered base", async () => {
    const [row] = (await owner`
      select subtotal_minor, vat_amount_minor, total_minor from public.invoice where id = ${invA}`) as unknown as Array<
      Record<string, string>
    >;
    // 10,000,000 @ 5% → vat 500,000 → total 10,500,000
    expect(Number(row!.subtotal_minor)).toBe(10000000);
    expect(Number(row!.vat_amount_minor)).toBe(500000);
    expect(Number(row!.total_minor)).toBe(10500000);
  });

  it("issues the invoice, then refuses to void it (immutable — credit note only)", async () => {
    await issueInvoice(ownerCtx(), "owner", invA);
    const [row] = (await owner`
      select status, issued_at from public.invoice where id = ${invA}`) as unknown as Array<
      Record<string, string | null>
    >;
    expect(row!.status).toBe("issued");
    expect(row!.issued_at).not.toBeNull();
    await expect(voidInvoice(ownerCtx(), "owner", invA, "too late")).rejects.toBeInstanceOf(
      InvoiceStateError,
    );
  });

  it("issued invoice lines are immutable (draft-only RLS blocks the update)", async () => {
    // Under the org's app_user ctx, the update policy only matches draft invoices,
    // so this UPDATE touches ZERO rows on an issued invoice (no error, no effect).
    const affected = await withCtx(ownerCtx(), async (tx) => {
      const rows = (await tx.execute(sql`
        update public.invoice_line set description = 'TAMPERED'
        where invoice_id = ${invA} and org_id = ${orgId} returning id
      `)) as unknown as Array<{ id: string }>;
      return rows.length;
    });
    expect(affected).toBe(0);
  });

  it("submits to the e-invoice adapter — fake provider clears it", async () => {
    const res = await submitEInvoice(ownerCtx(), "owner", invA);
    expect(res.status).toBe("cleared");
    const [sub] = (await owner`
      select status, external_id, attempts from public.einvoice_submission where invoice_id = ${invA}`) as unknown as Array<
      Record<string, string | number>
    >;
    expect(sub!.status).toBe("cleared");
    expect(String(sub!.external_id)).toMatch(/^FAKE-/);
  });

  it("AR shows the invoice outstanding in the correct aged bucket, then E-10 raises", async () => {
    const ar = await computeAR(ownerCtx(), "owner", AS_OF);
    expect(ar.outstandingMinor).toBe(10500000);
    // due 2026-06-01, asOf 2026-07-13 → 42 days → 31–60 bucket.
    expect(ar.d31_60).toBe(10500000);
    expect(ar.current).toBe(0);

    const eval1 = await evaluateNightly(ownerCtx(), NIGHTLY);
    expect(eval1.billing).toBeGreaterThanOrEqual(1);
    const open = await listOpenExceptions(ownerCtx(), "owner", { limit: 200 });
    expect(open.some((e) => e.ruleKey === "overdue_invoice" && e.subjectId === invA)).toBe(true);
  });

  it("records a full payment → invoice paid, receipt issued, AR clears, E-10 self-heals", async () => {
    const pay = await recordPayment(ownerCtx(), "owner", {
      invoiceId: invA,
      method: "bank_transfer",
      paymentDate: AS_OF,
      amountMinor: 10500000,
    });
    expect(pay.reference).toMatch(/^PMT-/);
    expect(pay.receiptReference).toMatch(/^RCP-/);
    const [inv] = (await owner`
      select status from public.invoice where id = ${invA}`) as unknown as Array<{
      status: string;
    }>;
    expect(inv!.status).toBe("paid");
    const [rcpt] = (await owner`
      select count(*)::int as n from public.payment_receipt pr
      join public.payment p on p.id = pr.payment_id where p.invoice_id = ${invA}`) as unknown as Array<{
      n: number;
    }>;
    expect(rcpt!.n).toBe(1);

    const ar = await computeAR(ownerCtx(), "owner", AS_OF);
    expect(ar.outstandingMinor).toBe(0);

    await evaluateNightly(ownerCtx(), NIGHTLY);
    const open = await listOpenExceptions(ownerCtx(), "owner", { limit: 200 });
    expect(open.some((e) => e.ruleKey === "overdue_invoice" && e.subjectId === invA)).toBe(false);
  });

  it("issues a credit note that copies the corrected invoice's lines", async () => {
    const cn = await createCreditNote(ownerCtx(), "owner", invA, "post-delivery price adjustment");
    expect(cn.reference).toMatch(/^CN-/);
    const [row] = (await owner`
      select kind, status, corrects_invoice_id::text as corrects, total_minor
      from public.invoice where id = ${cn.id}`) as unknown as Array<Record<string, string>>;
    expect(row!.kind).toBe("credit_note");
    expect(row!.status).toBe("issued");
    expect(row!.corrects).toBe(invA);
    expect(Number(row!.total_minor)).toBe(10500000);
    const [lines] = (await owner`
      select count(*)::int as n from public.invoice_line where invoice_id = ${cn.id}`) as unknown as Array<{
      n: number;
    }>;
    expect(lines!.n).toBe(1);
  });

  it("redacts money at read for a non-price-privileged viewer", async () => {
    const seen = await getInvoice(ownerCtx(), "accounts", invA);
    expect(seen?.totalMinor).toBe(10500000);
    const hidden = await getInvoice(redactedCtx(), "accounts", invA);
    expect(hidden?.totalMinor).toBeNull();
    expect(hidden?.reference).toBe(invARef); // non-money fields still visible
  });
});

describe("E-09 uninvoiced billing point (raise + self-heal)", () => {
  let e09Job = "";

  it("raises when a billing-milestone stage completes with no invoice", async () => {
    e09Job = randomUUID();
    await owner`
      insert into public.job (id, org_id, reference, name, status_key, status_category, created_by, billing_points)
      values (${e09Job}, ${orgId}, ${"E09-" + run}, 'E09 job', 'active', 'active', ${ownerUser},
              '[{"trigger":"lamination","pct":100}]'::jsonb)`;
    await owner`
      insert into public.job_stage (org_id, job_id, stage_key, name, weight, sort, status)
      values (${orgId}, ${e09Job}, 'lamination', '{"en":"Lamination","ar":"التصفيح"}'::jsonb, 100, 0, 'completed')`;
    const ev = await evaluateNightly(ownerCtx(), NIGHTLY);
    expect(ev.billing).toBeGreaterThanOrEqual(1);
    const open = await listOpenExceptions(ownerCtx(), "owner", { limit: 200 });
    expect(open.some((e) => e.ruleKey === "billing_point_uninvoiced" && e.jobId === e09Job)).toBe(
      true,
    );
  });

  it("self-heals once an invoice exists for the job", async () => {
    await createInvoice(ownerCtx(), "owner", {
      customerId,
      jobId: e09Job,
      lines: [
        {
          description: "Lamination milestone",
          qty: 1,
          unit: "ea",
          unitPriceMinor: 100000,
          vatRate: 5,
        },
      ],
    }).then((inv) => issueInvoice(ownerCtx(), "owner", inv.id));
    await evaluateNightly(ownerCtx(), NIGHTLY);
    const open = await listOpenExceptions(ownerCtx(), "owner", { limit: 200 });
    expect(open.some((e) => e.ruleKey === "billing_point_uninvoiced" && e.jobId === e09Job)).toBe(
      false,
    );
  });
});

// Regression coverage for the confirmed adversarial-review findings (each test
// reproduces the exact defect and asserts the fix; failing pre-fix, passing post-fix).
describe("S6 review regressions", () => {
  async function issuedInvoice(opts: {
    unitPriceMinor: number;
    dueDate?: string;
  }): Promise<string> {
    const inv = await createInvoice(ownerCtx(), "owner", {
      customerId,
      dueDate: opts.dueDate,
      lines: [
        { description: "reg", qty: 1, unit: "ea", unitPriceMinor: opts.unitPriceMinor, vatRate: 0 },
      ],
    });
    await issueInvoice(ownerCtx(), "owner", inv.id);
    return inv.id;
  }

  it("#1 credit notes attribute per-invoice: AR outstanding == sum of buckets, never negative", async () => {
    // X large + fully credited (settles, leaves AR); Y unpaid current. Old code
    // subtracted X's credit from the org-wide total → outstanding < bucket sum / negative.
    const x = await issuedInvoice({ unitPriceMinor: 9000000, dueDate: PAST_DUE });
    await issuedInvoice({ unitPriceMinor: 400000 }); // Y, no due date → current
    await createCreditNote(ownerCtx(), "owner", x, "full reversal");
    const ar = await computeAR(ownerCtx(), "owner", AS_OF);
    const bucketSum = ar.current! + ar.d1_30! + ar.d31_60! + ar.d61_90! + ar.over90!;
    expect(ar.outstandingMinor).toBe(bucketSum); // headline agrees with aging
    expect(ar.outstandingMinor!).toBeGreaterThanOrEqual(0); // never negative
    const [xrow] =
      (await owner`select status from public.invoice where id = ${x}`) as unknown as Array<{
        status: string;
      }>;
    expect(xrow!.status).toBe("paid"); // fully credited → settled
  });

  it("#2 a fully-credited overdue invoice does not stay overdue (E-10 clears / never fires)", async () => {
    const z = await issuedInvoice({ unitPriceMinor: 700000, dueDate: PAST_DUE });
    await evaluateNightly(ownerCtx(), NIGHTLY);
    const before = await listOpenExceptions(ownerCtx(), "owner", { limit: 300 });
    expect(before.some((e) => e.ruleKey === "overdue_invoice" && e.subjectId === z)).toBe(true);
    await createCreditNote(ownerCtx(), "owner", z, "goods returned, no payment");
    await evaluateNightly(ownerCtx(), NIGHTLY);
    const after = await listOpenExceptions(ownerCtx(), "owner", { limit: 300 });
    expect(after.some((e) => e.ruleKey === "overdue_invoice" && e.subjectId === z)).toBe(false);
  });

  it("#3 submitEInvoice is gated on invoices.manage (a non-manager is refused)", async () => {
    const inv = await issuedInvoice({ unitPriceMinor: 100000 });
    await expect(submitEInvoice(ownerCtx(), "foreman", inv)).rejects.toBeInstanceOf(ForbiddenError);
    // The internal/worker path (no archetype) still works — owner archetype passes.
    const ok = await submitEInvoice(ownerCtx(), "owner", inv);
    expect(ok.status).toBe("cleared");
  });

  it("#6 an auto-approve quote_send rule advances the quote to approved (not stranded)", async () => {
    await createApprovalRule(ownerCtx(), "owner", {
      subjectType: "quote_send",
      conditionKind: "always",
      assignedRole: "owner",
      autoApproveBelowMinor: 999_999_999,
    });
    const q = await createQuote(ownerCtx(), "owner", {
      customerId,
      presetId,
      lines: [{ description: "auto", qty: 1, unit: "ea", unitPriceMinor: 50000, vatRate: 0 }],
    });
    await submitQuote(ownerCtx(), "owner", q.id);
    const [row] =
      (await owner`select status from public.quote where id = ${q.id}`) as unknown as Array<{
        status: string;
      }>;
    expect(row!.status).toBe("approved"); // decided at submit → advanced, not pending_approval
  });

  it("#4 deciding a stale approval does NOT resurrect a voided payment", async () => {
    // A payment rule (no auto-approve) → the payment gets a PENDING approval.
    await createApprovalRule(ownerCtx(), "owner", {
      subjectType: "payment",
      conditionKind: "always",
      assignedRole: "owner",
    });
    const inv = await issuedInvoice({ unitPriceMinor: 300000 });
    const pay = await recordPayment(ownerCtx(), "owner", {
      invoiceId: inv,
      method: "cash",
      paymentDate: AS_OF,
      amountMinor: 300000,
    });
    expect(pay.approvalId).not.toBeNull();
    const [pre] =
      (await owner`select status from public.payment where id = ${pay.id}`) as unknown as Array<{
        status: string;
      }>;
    expect(pre!.status).toBe("recorded"); // pending approval, not yet confirmed
    await voidPayment(ownerCtx(), "owner", pay.id, "recorded in error");
    // Owner decides the still-pending approval — the guarded subject update must no-op.
    await decideApproval(ownerCtx(), "owner", {
      approvalId: pay.approvalId!,
      decision: "approved",
    });
    const [after] =
      (await owner`select status from public.payment where id = ${pay.id}`) as unknown as Array<{
        status: string;
      }>;
    expect(after!.status).toBe("void"); // NOT resurrected to 'confirmed'
  });

  it("#5 concurrent acceptQuote creates exactly one job (no orphan)", async () => {
    const q = await createQuote(ownerCtx(), "owner", {
      customerId,
      presetId,
      lines: [{ description: "race", qty: 1, unit: "ea", unitPriceMinor: 800000, vatRate: 0 }],
    });
    const { approvalId } = await submitQuote(ownerCtx(), "owner", q.id);
    // The prior test installed a quote_send auto-approve rule, so the quote may
    // already be 'approved' at submit — only decide if it's still pending.
    const [submitted] =
      (await owner`select status from public.quote where id = ${q.id}`) as unknown as Array<{
        status: string;
      }>;
    if (submitted!.status === "pending_approval") {
      await decideApproval(ownerCtx(), "owner", { approvalId, decision: "approved" });
    }
    await markQuoteSent(ownerCtx(), "owner", q.id);

    const [before] =
      (await owner`select count(*)::int as n from public.job where org_id = ${orgId}`) as unknown as Array<{
        n: number;
      }>;
    const results = await Promise.allSettled([
      acceptQuote(ownerCtx(), "owner", q.id, {}),
      acceptQuote(ownerCtx(), "owner", q.id, {}),
    ]);
    const [after] =
      (await owner`select count(*)::int as n from public.job where org_id = ${orgId}`) as unknown as Array<{
        n: number;
      }>;
    expect(after!.n - before!.n).toBe(1); // exactly one job, no orphan
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [conv] =
      (await owner`select status from public.quote where id = ${q.id}`) as unknown as Array<{
        status: string;
      }>;
    expect(conv!.status).toBe("converted");
  });
});
