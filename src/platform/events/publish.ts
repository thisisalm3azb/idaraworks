/**
 * Standalone event emission (no owning mutation) — e.g. confirmUpload queueing
 * the ingest pipeline. Phase G replaced the Phase-E direct Inngest send with a
 * durable outbox write: publishEvent inserts a domain_event (in its own tx) and
 * the relay delivers it. The signature is unchanged so callers never knew the
 * transport moved. For events emitted ALONGSIDE a mutation, use command({events})
 * so the event is atomic with the change.
 */
import { withCtx, type Ctx } from "@/platform/tenancy";
import type { EventName } from "./registry";
import { emitEvent } from "./outbox";

export type PublishableEvent = {
  name: EventName;
  /** Full payload; orgId + actorUserId identify the emitting org/actor. */
  data: { orgId: string; actorUserId: string } & Record<string, unknown>;
};

export async function publishEvent(event: PublishableEvent): Promise<void> {
  const ctx: Ctx = {
    orgId: event.data.orgId,
    userId: event.data.actorUserId,
    costPrivileged: false,
    pricePrivileged: false,
    requestId: "outbox-emit",
  };
  await withCtx(ctx, (tx) => emitEvent(tx, ctx, { name: event.name, payload: event.data }));
}
