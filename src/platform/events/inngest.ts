/**
 * Inngest client — the queue transport (S0 checklist §7 item 1). Phase E shipped
 * the client + storage consumers; Phase G adds the outbox/relay/dead-letter. The
 * event payload schemas are the registry's (registry.ts) — one source of truth.
 *
 * Keys: INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY are required in production
 * (owner item before pilots). Absent keys → the SDK runs in dev mode against a
 * local/pointed Inngest dev server, which is how local dev, CI and previews run.
 */
import { Inngest, eventType } from "inngest";
import {
  FILE_UPLOADED,
  DEMO_HEARTBEAT,
  JOB_CREATED,
  DAILY_REPORT_SUBMITTED,
  JOB_STAGE_COMPLETED,
  JOB_STAGE_REOPENED,
  DAILY_REPORT_REVIEWED,
  DAILY_REPORT_RETURNED,
  ISSUE_RAISED,
  ISSUE_RESOLVED,
  APPROVAL_SUBMITTED,
  APPROVAL_DECIDED,
  PURCHASE_ORDER_APPROVED,
  GOODS_RECEIPT_RECORDED,
  EXCEPTION_RAISED,
  FileUploadedData,
  DemoHeartbeatData,
  JobCreatedData,
  DailyReportSubmittedData,
  JobStageCompletedData,
  JobStageReopenedData,
  DailyReportReviewedData,
  DailyReportReturnedData,
  IssueRaisedData,
  IssueResolvedData,
  ApprovalSubmittedData,
  ApprovalDecidedData,
  PurchaseOrderApprovedData,
  GoodsReceiptRecordedData,
  ExceptionRaisedData,
} from "./registry";

export {
  FILE_UPLOADED,
  DEMO_HEARTBEAT,
  JOB_CREATED,
  DAILY_REPORT_SUBMITTED,
  JOB_STAGE_COMPLETED,
  JOB_STAGE_REOPENED,
  DAILY_REPORT_REVIEWED,
  DAILY_REPORT_RETURNED,
  ISSUE_RAISED,
  ISSUE_RESOLVED,
  APPROVAL_SUBMITTED,
  APPROVAL_DECIDED,
  PURCHASE_ORDER_APPROVED,
  GOODS_RECEIPT_RECORDED,
  EXCEPTION_RAISED,
  FileUploadedData,
  DemoHeartbeatData,
  JobCreatedData,
  DailyReportSubmittedData,
  JobStageCompletedData,
  JobStageReopenedData,
  DailyReportReviewedData,
  DailyReportReturnedData,
  IssueRaisedData,
  IssueResolvedData,
  ApprovalSubmittedData,
  ApprovalDecidedData,
  PurchaseOrderApprovedData,
  GoodsReceiptRecordedData,
  ExceptionRaisedData,
};
export type { FileUploadedData as FileUploadedPayload } from "./registry";

/** Typed triggers/creators (Inngest v4 eventType), backed by the registry schemas. */
export const fileUploadedEvent = eventType(FILE_UPLOADED, { schema: FileUploadedData });
export const demoHeartbeatEvent = eventType(DEMO_HEARTBEAT, { schema: DemoHeartbeatData });
export const jobCreatedEvent = eventType(JOB_CREATED, { schema: JobCreatedData });
export const dailyReportSubmittedEvent = eventType(DAILY_REPORT_SUBMITTED, {
  schema: DailyReportSubmittedData,
});
export const jobStageCompletedEvent = eventType(JOB_STAGE_COMPLETED, {
  schema: JobStageCompletedData,
});
export const jobStageReopenedEvent = eventType(JOB_STAGE_REOPENED, {
  schema: JobStageReopenedData,
});
export const dailyReportReviewedEvent = eventType(DAILY_REPORT_REVIEWED, {
  schema: DailyReportReviewedData,
});
export const dailyReportReturnedEvent = eventType(DAILY_REPORT_RETURNED, {
  schema: DailyReportReturnedData,
});
export const issueRaisedEvent = eventType(ISSUE_RAISED, { schema: IssueRaisedData });
export const issueResolvedEvent = eventType(ISSUE_RESOLVED, { schema: IssueResolvedData });
export const approvalSubmittedEvent = eventType(APPROVAL_SUBMITTED, {
  schema: ApprovalSubmittedData,
});
export const approvalDecidedEvent = eventType(APPROVAL_DECIDED, { schema: ApprovalDecidedData });
export const purchaseOrderApprovedEvent = eventType(PURCHASE_ORDER_APPROVED, {
  schema: PurchaseOrderApprovedData,
});
export const goodsReceiptRecordedEvent = eventType(GOODS_RECEIPT_RECORDED, {
  schema: GoodsReceiptRecordedData,
});
export const exceptionRaisedEvent = eventType(EXCEPTION_RAISED, { schema: ExceptionRaisedData });

/** name → its trigger. Paired with EVENT_DEFS[name].schema so defineOrgFunction
 * binds BOTH from a single event key — a trigger/schema mismatch is impossible. */
export const EVENT_TRIGGERS = {
  [FILE_UPLOADED]: fileUploadedEvent,
  [DEMO_HEARTBEAT]: demoHeartbeatEvent,
  [JOB_CREATED]: jobCreatedEvent,
  [DAILY_REPORT_SUBMITTED]: dailyReportSubmittedEvent,
  [JOB_STAGE_COMPLETED]: jobStageCompletedEvent,
  [JOB_STAGE_REOPENED]: jobStageReopenedEvent,
  [DAILY_REPORT_REVIEWED]: dailyReportReviewedEvent,
  [DAILY_REPORT_RETURNED]: dailyReportReturnedEvent,
  [ISSUE_RAISED]: issueRaisedEvent,
  [ISSUE_RESOLVED]: issueResolvedEvent,
  [APPROVAL_SUBMITTED]: approvalSubmittedEvent,
  [APPROVAL_DECIDED]: approvalDecidedEvent,
  [PURCHASE_ORDER_APPROVED]: purchaseOrderApprovedEvent,
  [GOODS_RECEIPT_RECORDED]: goodsReceiptRecordedEvent,
  [EXCEPTION_RAISED]: exceptionRaisedEvent,
} as const;

export const inngest = new Inngest({
  id: "idaraworks",
  eventKey: process.env.INNGEST_EVENT_KEY, // undefined → dev mode
});
