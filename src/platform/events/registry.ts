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

/** Fields every org-scoped event carries. */
const orgScoped = { orgId: z.string().uuid(), actorUserId: z.string().uuid() };

export const FileUploadedData = z.object({ ...orgScoped, fileId: z.string().uuid() });
export type FileUploadedData = z.infer<typeof FileUploadedData>;

export const DemoHeartbeatData = z.object({ ...orgScoped, nonce: z.string().min(1).max(64) });
export type DemoHeartbeatData = z.infer<typeof DemoHeartbeatData>;

export type EventDef = { version: number; schema: z.ZodTypeAny };

export const EVENT_DEFS = {
  [FILE_UPLOADED]: { version: 1, schema: FileUploadedData },
  [DEMO_HEARTBEAT]: { version: 1, schema: DemoHeartbeatData },
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
