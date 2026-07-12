/**
 * Event publication seam. Phase E: direct Inngest send. Phase G replaces the
 * internals with the transactional outbox (domain_event + relay) WITHOUT
 * changing this signature — callers never know the transport.
 *
 * Publish failures THROW: a mutation whose follow-up work cannot be queued must
 * surface that, not lose the event silently (the outbox removes this failure
 * mode in G).
 */
import { inngest, FILE_UPLOADED, type FileUploadedData } from "./inngest";

export type PublishableEvent = { name: typeof FILE_UPLOADED; data: FileUploadedData };

export async function publishEvent(event: PublishableEvent): Promise<void> {
  await inngest.send(event);
}
