/**
 * The domain-event registry (BUILD_BIBLE §8.6; doc 07-style closed registry).
 * ONE definition per event: a past-tense name, a payload version, and a Zod
 * schema shared by emitters (outbox), the relay, and consumers. Every payload
 * carries orgId + actorUserId (org-scoped facts). Adding an event is a reviewed
 * change; a breaking payload change bumps `version`.
 */
import { z } from "zod";

export const FILE_UPLOADED = "file/uploaded" as const;
export const DEMO_HEARTBEAT = "demo/heartbeat" as const;
export const JOB_CREATED = "job/created" as const; // S1 walking skeleton
export const DAILY_REPORT_SUBMITTED = "daily_report/submitted" as const; // S1
export const JOB_STAGE_COMPLETED = "job_stage/completed" as const; // S2
export const JOB_STAGE_REOPENED = "job_stage/reopened" as const; // S2 (F-5)
export const DAILY_REPORT_REVIEWED = "daily_report/reviewed" as const; // S3
export const DAILY_REPORT_RETURNED = "daily_report/returned" as const; // S3
export const ISSUE_RAISED = "issue/raised" as const; // S3
export const ISSUE_RESOLVED = "issue/resolved" as const; // S3
export const APPROVAL_SUBMITTED = "approval/submitted" as const; // S4
export const APPROVAL_DECIDED = "approval/decided" as const; // S4
export const PURCHASE_ORDER_APPROVED = "purchase_order/approved" as const; // S4 (→ LPO PDF)
export const GOODS_RECEIPT_RECORDED = "goods_receipt/recorded" as const; // S4
export const GOODS_RECEIPT_CANCELLED = "goods_receipt/cancelled" as const; // S5 (→ cost rollup invalidate)
export const EXPENSE_CREATED = "expense/created" as const; // S5 (→ cost rollup invalidate)
export const EXPENSE_VOIDED = "expense/voided" as const; // S5 (→ cost rollup invalidate)
// S6 "Bill": the money-loop facts.
export const QUOTE_ACCEPTED = "quote/accepted" as const;
export const INVOICE_ISSUED = "invoice/issued" as const; // → PDF render + e-invoice submit workers
export const INVOICE_VOIDED = "invoice/voided" as const;
export const CREDIT_NOTE_ISSUED = "credit_note/issued" as const;
export const PAYMENT_RECORDED = "payment/recorded" as const;
// S7 "Improve": the staggered per-org nightly fan-out trigger + customer-update facts.
export const NIGHTLY_ORG_DUE = "nightly/org_due" as const; // dispatcher → per-org child (staggered)
export const CUSTOMER_UPDATE_SENT = "customer_update/sent" as const;
export const SHARE_TOKEN_CREATED = "share_token/created" as const;
export const SHARE_TOKEN_REVOKED = "share_token/revoked" as const;
// The cross-module exception SIGNAL channel: modules that detect a condition
// outside the exception engine emit this (S2 F-5 billing-point reopen; the S4 E-03
// approval-stuck stub), and the S5 engine's materializer subscribes to this NAME
// and upserts an exception row. The engine's own rules (E-01/E-02/E-04/E-07/C-10)
// write rows directly, not through this event.
export const EXCEPTION_RAISED = "exception/raised" as const;

/** Fields every org-scoped event carries. */
const orgScoped = { orgId: z.string().uuid(), actorUserId: z.string().uuid() };

export const FileUploadedData = z.object({ ...orgScoped, fileId: z.string().uuid() });
export type FileUploadedData = z.infer<typeof FileUploadedData>;

export const DemoHeartbeatData = z.object({ ...orgScoped, nonce: z.string().min(1).max(64) });
export type DemoHeartbeatData = z.infer<typeof DemoHeartbeatData>;

export const JobCreatedData = z.object({
  ...orgScoped,
  jobId: z.string().uuid(),
  reference: z.string().min(1).max(40),
});
export type JobCreatedData = z.infer<typeof JobCreatedData>;

export const DailyReportSubmittedData = z.object({
  ...orgScoped,
  reportId: z.string().uuid(),
  jobId: z.string().uuid(),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type DailyReportSubmittedData = z.infer<typeof DailyReportSubmittedData>;

export const JobStageCompletedData = z.object({
  ...orgScoped,
  jobId: z.string().uuid(),
  stageId: z.string().uuid(),
  stageKey: z.string().min(1).max(40),
});
export type JobStageCompletedData = z.infer<typeof JobStageCompletedData>;

export const JobStageReopenedData = z.object({
  ...orgScoped,
  jobId: z.string().uuid(),
  stageId: z.string().uuid(),
  stageKey: z.string().min(1).max(40),
  reason: z.string().min(1).max(500),
});
export type JobStageReopenedData = z.infer<typeof JobStageReopenedData>;

export const ExceptionRaisedData = z.object({
  ...orgScoped,
  // The E-catalogue grows with later slices. S4 adds approval_stuck (E-03 stub).
  kind: z.enum(["billing_point_reopened", "approval_stuck"]),
  jobId: z.string().uuid().optional(),
  stageKey: z.string().min(1).max(40).optional(),
  subjectType: z.string().min(1).max(40).optional(),
  subjectId: z.string().uuid().optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
});
export type ExceptionRaisedData = z.infer<typeof ExceptionRaisedData>;

export const ApprovalSubmittedData = z.object({
  ...orgScoped,
  approvalId: z.string().uuid(),
  subjectType: z.string().min(1).max(40),
  subjectId: z.string().uuid(),
  assignedRole: z.string().min(1).max(20),
});
export type ApprovalSubmittedData = z.infer<typeof ApprovalSubmittedData>;

export const ApprovalDecidedData = z.object({
  ...orgScoped,
  approvalId: z.string().uuid(),
  subjectType: z.string().min(1).max(40),
  subjectId: z.string().uuid(),
  outcome: z.enum(["approved", "rejected", "withdrawn"]),
});
export type ApprovalDecidedData = z.infer<typeof ApprovalDecidedData>;

export const PurchaseOrderApprovedData = z.object({
  ...orgScoped,
  purchaseOrderId: z.string().uuid(),
  reference: z.string().min(1).max(40),
});
export type PurchaseOrderApprovedData = z.infer<typeof PurchaseOrderApprovedData>;

export const GoodsReceiptRecordedData = z.object({
  ...orgScoped,
  goodsReceiptId: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
});
export type GoodsReceiptRecordedData = z.infer<typeof GoodsReceiptRecordedData>;

export const GoodsReceiptCancelledData = z.object({
  ...orgScoped,
  goodsReceiptId: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
});
export type GoodsReceiptCancelledData = z.infer<typeof GoodsReceiptCancelledData>;

export const ExpenseCreatedData = z.object({
  ...orgScoped,
  expenseId: z.string().uuid(),
  jobId: z.string().uuid().optional(),
});
export type ExpenseCreatedData = z.infer<typeof ExpenseCreatedData>;

export const ExpenseVoidedData = z.object({
  ...orgScoped,
  expenseId: z.string().uuid(),
  jobId: z.string().uuid().optional(),
});
export type ExpenseVoidedData = z.infer<typeof ExpenseVoidedData>;

export const QuoteAcceptedData = z.object({
  ...orgScoped,
  quoteId: z.string().uuid(),
  jobId: z.string().uuid(),
});
export type QuoteAcceptedData = z.infer<typeof QuoteAcceptedData>;

export const InvoiceIssuedData = z.object({
  ...orgScoped,
  invoiceId: z.string().uuid(),
  jobId: z.string().uuid().optional(),
});
export type InvoiceIssuedData = z.infer<typeof InvoiceIssuedData>;

export const InvoiceVoidedData = z.object({ ...orgScoped, invoiceId: z.string().uuid() });
export type InvoiceVoidedData = z.infer<typeof InvoiceVoidedData>;

export const CreditNoteIssuedData = z.object({
  ...orgScoped,
  invoiceId: z.string().uuid(),
  correctsInvoiceId: z.string().uuid(),
});
export type CreditNoteIssuedData = z.infer<typeof CreditNoteIssuedData>;

export const PaymentRecordedData = z.object({
  ...orgScoped,
  paymentId: z.string().uuid(),
  invoiceId: z.string().uuid().optional(),
});
export type PaymentRecordedData = z.infer<typeof PaymentRecordedData>;

export const DailyReportReviewedData = z.object({
  ...orgScoped,
  reportId: z.string().uuid(),
  jobId: z.string().uuid(),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type DailyReportReviewedData = z.infer<typeof DailyReportReviewedData>;

export const DailyReportReturnedData = z.object({
  ...orgScoped,
  reportId: z.string().uuid(),
  jobId: z.string().uuid(),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().min(1).max(2000),
});
export type DailyReportReturnedData = z.infer<typeof DailyReportReturnedData>;

export const IssueRaisedData = z.object({
  ...orgScoped,
  issueId: z.string().uuid(),
  jobId: z.string().uuid().optional(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  isBlocker: z.boolean(),
});
export type IssueRaisedData = z.infer<typeof IssueRaisedData>;

export const IssueResolvedData = z.object({
  ...orgScoped,
  issueId: z.string().uuid(),
  jobId: z.string().uuid().optional(),
});
export type IssueResolvedData = z.infer<typeof IssueResolvedData>;

// S7 "Improve": staggered per-org nightly run + customer-update facts.
export const NightlyOrgDueData = z.object({
  ...orgScoped,
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nowMs: z.number().int().nonnegative(),
});
export type NightlyOrgDueData = z.infer<typeof NightlyOrgDueData>;

export const CustomerUpdateSentData = z.object({
  ...orgScoped,
  customerUpdateId: z.string().uuid(),
  jobId: z.string().uuid().optional(),
});
export type CustomerUpdateSentData = z.infer<typeof CustomerUpdateSentData>;

export const ShareTokenCreatedData = z.object({
  ...orgScoped,
  shareTokenId: z.string().uuid(),
  customerUpdateId: z.string().uuid(),
});
export type ShareTokenCreatedData = z.infer<typeof ShareTokenCreatedData>;

export const ShareTokenRevokedData = z.object({
  ...orgScoped,
  shareTokenId: z.string().uuid(),
});
export type ShareTokenRevokedData = z.infer<typeof ShareTokenRevokedData>;

export type EventDef = { version: number; schema: z.ZodTypeAny };

export const EVENT_DEFS = {
  [FILE_UPLOADED]: { version: 1, schema: FileUploadedData },
  [DEMO_HEARTBEAT]: { version: 1, schema: DemoHeartbeatData },
  [JOB_CREATED]: { version: 1, schema: JobCreatedData },
  [DAILY_REPORT_SUBMITTED]: { version: 1, schema: DailyReportSubmittedData },
  [JOB_STAGE_COMPLETED]: { version: 1, schema: JobStageCompletedData },
  [JOB_STAGE_REOPENED]: { version: 1, schema: JobStageReopenedData },
  [DAILY_REPORT_REVIEWED]: { version: 1, schema: DailyReportReviewedData },
  [DAILY_REPORT_RETURNED]: { version: 1, schema: DailyReportReturnedData },
  [ISSUE_RAISED]: { version: 1, schema: IssueRaisedData },
  [ISSUE_RESOLVED]: { version: 1, schema: IssueResolvedData },
  [APPROVAL_SUBMITTED]: { version: 1, schema: ApprovalSubmittedData },
  [APPROVAL_DECIDED]: { version: 1, schema: ApprovalDecidedData },
  [PURCHASE_ORDER_APPROVED]: { version: 1, schema: PurchaseOrderApprovedData },
  [GOODS_RECEIPT_RECORDED]: { version: 1, schema: GoodsReceiptRecordedData },
  [GOODS_RECEIPT_CANCELLED]: { version: 1, schema: GoodsReceiptCancelledData },
  [EXPENSE_CREATED]: { version: 1, schema: ExpenseCreatedData },
  [EXPENSE_VOIDED]: { version: 1, schema: ExpenseVoidedData },
  [QUOTE_ACCEPTED]: { version: 1, schema: QuoteAcceptedData },
  [INVOICE_ISSUED]: { version: 1, schema: InvoiceIssuedData },
  [INVOICE_VOIDED]: { version: 1, schema: InvoiceVoidedData },
  [CREDIT_NOTE_ISSUED]: { version: 1, schema: CreditNoteIssuedData },
  [PAYMENT_RECORDED]: { version: 1, schema: PaymentRecordedData },
  [NIGHTLY_ORG_DUE]: { version: 1, schema: NightlyOrgDueData },
  [CUSTOMER_UPDATE_SENT]: { version: 1, schema: CustomerUpdateSentData },
  [SHARE_TOKEN_CREATED]: { version: 1, schema: ShareTokenCreatedData },
  [SHARE_TOKEN_REVOKED]: { version: 1, schema: ShareTokenRevokedData },
  [EXCEPTION_RAISED]: { version: 1, schema: ExceptionRaisedData },
} as const satisfies Record<string, EventDef>;

export type EventName = keyof typeof EVENT_DEFS;

export function isEventName(name: string): name is EventName {
  return Object.prototype.hasOwnProperty.call(EVENT_DEFS, name);
}

/** Validate a payload against its registered schema (throws on mismatch). */
export function validateEventPayload(name: EventName, payload: unknown): unknown {
  return EVENT_DEFS[name].schema.parse(payload);
}

export function eventVersion(name: EventName): number {
  return EVENT_DEFS[name].version;
}
