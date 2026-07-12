/**
 * Inngest client — the queue transport (S0 checklist §7 item 1; Phase E ships
 * the client + the two storage consumers; the transactional outbox, relay and
 * dead-letter land in Phase G).
 *
 * Keys: INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY are required in production
 * (owner item before pilots). Absent keys → the SDK runs in dev mode against a
 * local/pointed Inngest dev server, which is how local dev, CI and the VC-4
 * preview check operate.
 */
import { Inngest, eventType } from "inngest";
import { z } from "zod";

/** Event payload schemas — ONE definition used by senders and consumers (Bible §6.9). */
export const FILE_UPLOADED = "file/uploaded" as const;
export const FileUploadedData = z.object({
  orgId: z.string().uuid(),
  fileId: z.string().uuid(),
  actorUserId: z.string().uuid(),
});
export type FileUploadedData = z.infer<typeof FileUploadedData>;

/** Typed trigger + creator for the file/uploaded event (Inngest v4 eventType). */
export const fileUploadedEvent = eventType(FILE_UPLOADED, { schema: FileUploadedData });

export const inngest = new Inngest({
  id: "idaraworks",
  eventKey: process.env.INNGEST_EVENT_KEY, // undefined → dev mode
});
