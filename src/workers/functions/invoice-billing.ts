/**
 * S6 billing workers (doc 11 S6; defineOrgFunction — org re-verified, no cost/price
 * privilege). On invoice/issued: submit to the e-invoice provider (fake in S6) through
 * the adapter, then build the Arabic-primary bilingual PDF HTML (with the clearance QR)
 * — the render+store RUNTIME (headless-Chromium vs a render microservice, F-42) is the
 * gated seam, exactly like the LPO PDF worker; it no-ops with a log until the render
 * runtime + Inngest are provisioned (owner action). On approval/decided for a PAYMENT
 * subject: re-reconcile the invoice's paid status (a confirm/reject changes what counts).
 */
import { defineOrgFunction } from "@/workers/harness";
import { INVOICE_ISSUED, APPROVAL_DECIDED } from "@/platform/events";
import { submitEInvoiceInternal, buildInvoiceHtmlInternal } from "@/modules/invoices/service";
import { reconcileFromPayment } from "@/modules/payments/service";
import { logger } from "@/platform/logger";

export async function buildInvoiceForIssue(
  ctx: import("@/platform/tenancy").Ctx,
  invoiceId: string,
): Promise<{ outcome: "built" | "empty"; eInvoiceStatus: string; htmlChars: number }> {
  const submission = await submitEInvoiceInternal(ctx, invoiceId);
  const html = await buildInvoiceHtmlInternal(ctx, invoiceId, submission.qr);
  if (!html) return { outcome: "empty", eInvoiceStatus: submission.status, htmlChars: 0 };
  logger.info(
    {
      invoiceId,
      orgId: ctx.orgId,
      requestId: ctx.requestId,
      htmlChars: html.length,
      eInvoiceStatus: submission.status,
    },
    "invoice HTML built — PDF render+store gated on render runtime + Inngest (owner action, F-42)",
  );
  return { outcome: "built", eInvoiceStatus: submission.status, htmlChars: html.length };
}

export const invoiceOnIssued = defineOrgFunction(
  { id: "invoice-on-issued", event: INVOICE_ISSUED, retries: 3 },
  async ({ payload, ctx }) => buildInvoiceForIssue(ctx, payload.invoiceId),
);

export const paymentReconcileOnDecision = defineOrgFunction(
  { id: "payment-reconcile-on-decision", event: APPROVAL_DECIDED },
  async ({ payload, ctx }) => {
    if (payload.subjectType !== "payment") return { skipped: true };
    await reconcileFromPayment(ctx, payload.subjectId);
    return { reconciled: payload.subjectId };
  },
);
