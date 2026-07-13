/**
 * Worker registry — /api/inngest serves exactly this list. New functions are
 * added here (and only here) so the serve route never drifts from the fleet.
 */
export { imageDerivatives, deriveImageVariants } from "./functions/image-derivatives";
export { storageReconcile, reconcileOrg, reconcileAllOrgs } from "./functions/storage-reconcile";
export { outboxRelay, outboxRetention } from "./functions/outbox-relay";
export { demoHeartbeat } from "./functions/demo-heartbeat";
export { approvalStuckEvaluator, sweepStuckApprovals } from "./functions/approval-stuck";
export { lpoPdfRenderer, buildLpoForPo } from "./functions/lpo-pdf";
// S5 "Measure": cost-rollup invalidation + the exception engine.
export {
  costRollupOnReportSubmit,
  costRollupOnReportReturn,
  costRollupOnExpenseCreate,
  costRollupOnExpenseVoid,
  costRollupOnGoodsReceipt,
  costRollupOnGoodsReceiptCancel,
} from "./functions/cost-rollup";
export {
  exceptionSignalMaterializer,
  exceptionClearOnApprovalDecided,
  expenseAnomalyOnCreate,
  expenseAnomalyOnVoid,
  exceptionNightlyDispatch,
  nightlyOrgRun,
  sweepExceptions,
  dispatchNightly,
  runOrgNightly,
  computeStaggerSeconds,
} from "./functions/exception-engine";
// S6 "Bill": invoice issue → e-invoice + PDF seam; payment approval → reconcile.
export {
  invoiceOnIssued,
  paymentReconcileOnDecision,
  buildInvoiceForIssue,
} from "./functions/invoice-billing";
export { verifyOrgPayload, defineOrgFunction, OrgVerificationError } from "./harness";

import { imageDerivatives } from "./functions/image-derivatives";
import { storageReconcile } from "./functions/storage-reconcile";
import { outboxRelay, outboxRetention } from "./functions/outbox-relay";
import { demoHeartbeat } from "./functions/demo-heartbeat";
import { approvalStuckEvaluator } from "./functions/approval-stuck";
import { lpoPdfRenderer } from "./functions/lpo-pdf";
import {
  costRollupOnReportSubmit,
  costRollupOnReportReturn,
  costRollupOnExpenseCreate,
  costRollupOnExpenseVoid,
  costRollupOnGoodsReceipt,
  costRollupOnGoodsReceiptCancel,
} from "./functions/cost-rollup";
import {
  exceptionSignalMaterializer,
  exceptionClearOnApprovalDecided,
  expenseAnomalyOnCreate,
  expenseAnomalyOnVoid,
  exceptionNightlyDispatch,
  nightlyOrgRun,
} from "./functions/exception-engine";
import { invoiceOnIssued, paymentReconcileOnDecision } from "./functions/invoice-billing";

export const workerFunctions = [
  imageDerivatives,
  storageReconcile,
  outboxRelay,
  outboxRetention,
  demoHeartbeat,
  approvalStuckEvaluator,
  lpoPdfRenderer,
  costRollupOnReportSubmit,
  costRollupOnReportReturn,
  costRollupOnExpenseCreate,
  costRollupOnExpenseVoid,
  costRollupOnGoodsReceipt,
  costRollupOnGoodsReceiptCancel,
  exceptionSignalMaterializer,
  exceptionClearOnApprovalDecided,
  expenseAnomalyOnCreate,
  expenseAnomalyOnVoid,
  exceptionNightlyDispatch,
  nightlyOrgRun,
  invoiceOnIssued,
  paymentReconcileOnDecision,
];
