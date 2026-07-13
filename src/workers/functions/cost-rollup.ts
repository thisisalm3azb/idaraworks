/**
 * Cost-rollup invalidation workers (doc 11 S5; BUILD_BIBLE §4.8). Every event that
 * changes a job's cost re-runs the SINGLE-WRITER refresh so the cached rollup stays
 * current between nightly reconciles. Each is a defineOrgFunction (doc 10 #9:
 * re-resolve + re-verify org from the payload). The refresh itself is the DEFINER's
 * monopoly — the worker (non-cost-privileged) only triggers it.
 *
 * A report submit also runs the E-07 labour-outlier check and clears any open E-01
 * "missing report" for that job (the report just arrived — intra-day self-heal).
 */
import { defineOrgFunction } from "@/workers/harness";
import {
  DAILY_REPORT_SUBMITTED,
  DAILY_REPORT_RETURNED,
  EXPENSE_CREATED,
  EXPENSE_VOIDED,
  GOODS_RECEIPT_RECORDED,
  GOODS_RECEIPT_CANCELLED,
} from "@/platform/events";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { refreshRollup } from "@/modules/costing/service";
import { evaluateReportAnomalies, clearException } from "@/modules/exceptions/service";

async function jobOfPurchaseOrder(ctx: Ctx, poId: string): Promise<string | null> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select job_id::text as job_id from public.purchase_order
      where id = ${poId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<{ job_id: string | null }>;
    return rows[0]?.job_id ?? null;
  });
}

export const costRollupOnReportSubmit = defineOrgFunction(
  { id: "cost-rollup-on-report-submit", event: DAILY_REPORT_SUBMITTED },
  async ({ payload, ctx }) => {
    await refreshRollup(ctx, payload.jobId);
    await clearException(ctx, `missing_report:${payload.jobId}`);
    const anomalies = await evaluateReportAnomalies(ctx, payload.reportId);
    return { refreshed: payload.jobId, ...anomalies };
  },
);

export const costRollupOnReportReturn = defineOrgFunction(
  { id: "cost-rollup-on-report-return", event: DAILY_REPORT_RETURNED },
  async ({ payload, ctx }) => {
    // A returned report leaves 'submitted/reviewed', so its lines drop out of cost.
    await refreshRollup(ctx, payload.jobId);
    return { refreshed: payload.jobId };
  },
);

export const costRollupOnExpenseCreate = defineOrgFunction(
  { id: "cost-rollup-on-expense-create", event: EXPENSE_CREATED },
  async ({ payload, ctx }) => {
    if (payload.jobId) await refreshRollup(ctx, payload.jobId);
    return { refreshed: payload.jobId ?? null };
  },
);

export const costRollupOnExpenseVoid = defineOrgFunction(
  { id: "cost-rollup-on-expense-void", event: EXPENSE_VOIDED },
  async ({ payload, ctx }) => {
    if (payload.jobId) await refreshRollup(ctx, payload.jobId);
    return { refreshed: payload.jobId ?? null };
  },
);

export const costRollupOnGoodsReceipt = defineOrgFunction(
  { id: "cost-rollup-on-goods-receipt", event: GOODS_RECEIPT_RECORDED },
  async ({ payload, ctx }) => {
    const jobId = await jobOfPurchaseOrder(ctx, payload.purchaseOrderId);
    if (jobId) await refreshRollup(ctx, jobId);
    return { refreshed: jobId };
  },
);

// A cancelled GRN drops out of the rollup (only 'recorded' GRNs count), so it must
// refresh the same way a recorded one does (review: missed invalidation on cancel).
export const costRollupOnGoodsReceiptCancel = defineOrgFunction(
  { id: "cost-rollup-on-goods-receipt-cancel", event: GOODS_RECEIPT_CANCELLED },
  async ({ payload, ctx }) => {
    const jobId = await jobOfPurchaseOrder(ctx, payload.purchaseOrderId);
    if (jobId) await refreshRollup(ctx, jobId);
    return { refreshed: jobId };
  },
);
