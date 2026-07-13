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
  EXCEPTION_RAISED,
  FileUploadedData,
  DemoHeartbeatData,
  JobCreatedData,
  DailyReportSubmittedData,
  JobStageCompletedData,
  JobStageReopenedData,
  ExceptionRaisedData,
} from "./registry";

export {
  FILE_UPLOADED,
  DEMO_HEARTBEAT,
  JOB_CREATED,
  DAILY_REPORT_SUBMITTED,
  JOB_STAGE_COMPLETED,
  JOB_STAGE_REOPENED,
  EXCEPTION_RAISED,
  FileUploadedData,
  DemoHeartbeatData,
  JobCreatedData,
  DailyReportSubmittedData,
  JobStageCompletedData,
  JobStageReopenedData,
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
  [EXCEPTION_RAISED]: exceptionRaisedEvent,
} as const;

export const inngest = new Inngest({
  id: "idaraworks",
  eventKey: process.env.INNGEST_EVENT_KEY, // undefined → dev mode
});
