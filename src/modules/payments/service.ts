/**
 * Payments + printable receipts (doc 01 L4; doc 11 S6 "Bill"). Recording a payment
 * creates it in 'recorded' and, if the org installed a payment approval rule (OP-7
 * mode always | amount_gte), routes it through the approval engine to owner/admin who
 * confirm/reject. A serial-numbered payment_receipt is generated. AR counts payments
 * in ('recorded','confirmed'); a rejected/void payment drops out (the reconcile +
 * an APPROVAL_DECIDED worker keep the invoice status truthful). Void-never-delete.
 */
import { z } from "zod";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { command } from "@/platform/audit/command";
import { assertCan } from "@/platform/authz/can";
import { requireCapability } from "@/platform/entitlements";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { submitForApproval } from "@/modules/approvals/service";
import { reconcileInvoiceStatus } from "@/modules/invoices/service";
import { PAYMENT_RECORDED } from "@/platform/events";
import type { CurrencyCode, RoleArchetype } from "@/platform/registries";
import { CURRENCY_CODES } from "@/platform/registries";

export class PaymentNotFoundError extends Error {
  constructor() {
    super("payment not found");
    this.name = "PaymentNotFoundError";
  }
}
export class PaymentStateError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PaymentStateError";
  }
}

export const RecordPaymentInput = z.object({
  invoiceId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  method: z.enum(["cash", "bank_transfer", "cheque", "card", "other"]).default("bank_transfer"),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountMinor: z.number().int().nonnegative(),
  currency: z.enum(CURRENCY_CODES as unknown as [string, ...string[]]).optional(),
  exchangeRate: z.number().positive().default(1),
  externalReference: z.string().trim().max(200).optional(),
  // S10 idempotency: a client-generated key collapses a double-submit to one payment (0063).
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

export async function recordPayment(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; reference: string; receiptReference: string; approvalId: string | null }> {
  assertCan(archetype, "payments.manage");
  // Add-on gate (FR-9): RECORD only — reads/AR and voiding an existing payment never gate.
  await requireCapability(ctx, "cap.payments");
  const input = RecordPaymentInput.parse(raw);
  const currency = (input.currency ?? "AED") as CurrencyCode;
  const baseAmountMinor = Math.round(input.amountMinor * input.exchangeRate);

  try {
    return await command<{
      id: string;
      reference: string;
      receiptReference: string;
      approvalId: string | null;
    }>(
      ctx,
      {
        audit: (r) => ({
          action: "payment.record",
          entityType: "payment",
          entityId: r.id,
          summary: `Payment ${r.reference}`,
          after: { amountMinor: input.amountMinor, currency, invoiceId: input.invoiceId ?? null },
        }),
        events: (r) => [
          {
            name: PAYMENT_RECORDED,
            payload: { paymentId: r.id, invoiceId: input.invoiceId ?? undefined },
          },
        ],
      },
      async (tx) => {
        let customerName: string | null = null;
        if (input.customerId) {
          const c = (await tx.execute(sql`
          select name from public.customer where id = ${input.customerId} and org_id = ${ctx.orgId}
        `)) as unknown as Array<{ name: string }>;
          customerName = c[0]?.name ?? null;
        }
        const seq = await allocateReference(tx, ctx, "payment");
        const reference = formatRef("PMT", seq);
        const rows = (await tx.execute(sql`
        insert into public.payment
          (org_id, reference, invoice_id, job_id, customer_id, customer_name, method, payment_date,
           amount_minor, currency, exchange_rate, base_amount_minor, external_reference, created_by,
           idempotency_key)
        values (${ctx.orgId}, ${reference}, ${input.invoiceId ?? null}, ${input.jobId ?? null},
                ${input.customerId ?? null}, ${customerName}, ${input.method}, ${input.paymentDate},
                ${input.amountMinor}, ${currency}, ${input.exchangeRate}, ${baseAmountMinor},
                ${input.externalReference ?? null}, ${ctx.userId}, ${input.idempotencyKey ?? null})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
        const id = rows[0]!.id;

        // A recorded payment counts toward the invoice paid status immediately.
        if (input.invoiceId) await reconcileInvoiceStatus(tx, ctx, input.invoiceId);

        // Printable serial receipt.
        const rseq = await allocateReference(tx, ctx, "payment_receipt");
        const receiptReference = formatRef("RCP", rseq);
        await tx.execute(sql`
        insert into public.payment_receipt (org_id, payment_id, reference) values (${ctx.orgId}, ${id}, ${receiptReference})
      `);

        // OP-7: route for confirmation only if a payment approval rule is installed.
        let approvalId: string | null = null;
        const rule = (await tx.execute(sql`
        select 1 from public.approval_rule
        where org_id = ${ctx.orgId} and subject_type = 'payment' and active = true limit 1
      `)) as unknown as Array<{ "?column?": number }>;
        if (rule.length > 0) {
          const res = await submitForApproval(tx, ctx, {
            subjectType: "payment",
            subjectId: id,
            subjectSummary: { title: `Payment ${reference}`, amountMinor: input.amountMinor },
            amountMinor: input.amountMinor,
          });
          approvalId = res.approvalId;
          // Auto-approve (rule below threshold) decides at submission with no human
          // decide — advance the subject here (mirrors S4 + submitQuote), else the
          // payment is stranded 'recorded' and never reaches the documented 'confirmed'.
          if (res.decided) {
            await tx.execute(sql`
            update public.payment set status = 'confirmed', updated_at = now()
            where id = ${id} and org_id = ${ctx.orgId} and status = 'recorded'
          `);
          }
        }
        return { id, reference, receiptReference, approvalId };
      },
    );
  } catch (err) {
    // S10 idempotent replay: a retry with the same idempotency key hits the 0063 partial
    // unique — return the already-recorded payment instead of minting a duplicate.
    const cause = (err as { cause?: { code?: string; constraint_name?: string } }).cause;
    if (
      input.idempotencyKey &&
      cause?.code === "23505" &&
      cause.constraint_name === "payment_idempotency_uq"
    ) {
      return withCtx(ctx, async (tx) => {
        const rows = (await tx.execute(sql`
          select p.id::text as id, p.reference,
                 r.reference as receipt_reference,
                 a.id::text as approval_id
          from public.payment p
          left join public.payment_receipt r on r.payment_id = p.id and r.org_id = p.org_id
          left join public.approval a
            on a.subject_type = 'payment' and a.subject_id = p.id and a.org_id = p.org_id
          where p.org_id = ${ctx.orgId} and p.idempotency_key = ${input.idempotencyKey}
          limit 1`)) as unknown as Array<{
          id: string;
          reference: string;
          receipt_reference: string | null;
          approval_id: string | null;
        }>;
        const p = rows[0]!;
        return {
          id: p.id,
          reference: p.reference,
          receiptReference: p.receipt_reference ?? "",
          approvalId: p.approval_id,
        };
      });
    }
    throw err;
  }
}

/** Void a payment (reason required) and re-reconcile the invoice it paid. */
export async function voidPayment(
  ctx: Ctx,
  archetype: RoleArchetype,
  paymentId: string,
  reason: string,
): Promise<void> {
  assertCan(archetype, "payments.manage");
  if (!reason.trim()) throw new PaymentStateError("a void reason is required");
  await command(
    ctx,
    {
      audit: {
        action: "payment.void",
        entityType: "payment",
        entityId: paymentId,
        summary: `Voided payment: ${reason}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.payment set status = 'void', voided_at = now(), void_reason = ${reason},
          voided_by = ${ctx.userId}, updated_at = now()
        where id = ${paymentId} and org_id = ${ctx.orgId} and voided_at is null
        returning invoice_id::text as invoice_id
      `)) as unknown as Array<{ invoice_id: string | null }>;
      if (!rows[0]) throw new PaymentStateError("payment already voided or not found");
      if (rows[0].invoice_id) await reconcileInvoiceStatus(tx, ctx, rows[0].invoice_id);
    },
  );
}

// ── reads (price-redacted) ────────────────────────────────────────────────────
export type PaymentRow = {
  id: string;
  reference: string;
  invoiceId: string | null;
  customerName: string | null;
  status: string;
  method: string;
  paymentDate: string;
  amountMinor: number | null;
  currency: string;
  voided: boolean;
};

export async function listPayments(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { limit?: number; invoiceId?: string } = {},
): Promise<PaymentRow[]> {
  assertCan(archetype, "payments.view");
  const seesPrice = ctx.pricePrivileged;
  const limit = Math.min(opts.limit ?? 200, 500);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, reference, invoice_id::text as invoice_id, customer_name, status, method,
             payment_date::text as payment_date, amount_minor, currency, (voided_at is not null) as voided
      from public.payment where org_id = ${ctx.orgId}
        ${opts.invoiceId ? sql`and invoice_id = ${opts.invoiceId}` : sql``}
      order by payment_date desc, created_at desc limit ${limit}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      reference: r.reference as string,
      invoiceId: (r.invoice_id as string | null) ?? null,
      customerName: (r.customer_name as string | null) ?? null,
      status: r.status as string,
      method: r.method as string,
      paymentDate: r.payment_date as string,
      amountMinor: seesPrice ? Number(r.amount_minor) : null,
      currency: r.currency as string,
      voided: r.voided as boolean,
    }));
  });
}

/** Re-reconcile an invoice from a payment id (used by the APPROVAL_DECIDED worker so a
 * confirmed/rejected payment keeps the invoice status truthful). */
export async function reconcileFromPayment(ctx: Ctx, paymentId: string): Promise<void> {
  await withCtx(ctx, async (tx: TenantTx) => {
    const rows = (await tx.execute(sql`
      select invoice_id::text as invoice_id from public.payment where id = ${paymentId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<{ invoice_id: string | null }>;
    if (rows[0]?.invoice_id) await reconcileInvoiceStatus(tx, ctx, rows[0].invoice_id);
  });
}
