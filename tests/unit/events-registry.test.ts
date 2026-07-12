/**
 * Event registry (BUILD_BIBLE §8.6): closed names, versioned payloads, schema
 * validation shared by emitters/relay/consumers.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVENT_DEFS,
  FILE_UPLOADED,
  DEMO_HEARTBEAT,
  isEventName,
  eventVersion,
  validateEventPayload,
} from "@/platform/events";

describe("event registry", () => {
  it("names are closed and past-tense; every def has a version + schema", () => {
    for (const [name, def] of Object.entries(EVENT_DEFS)) {
      expect(isEventName(name)).toBe(true);
      expect(def.version).toBeGreaterThanOrEqual(1);
      expect(def.schema).toBeDefined();
    }
    expect(isEventName("not/a/real/event")).toBe(false);
    expect(eventVersion(FILE_UPLOADED)).toBe(1);
  });

  it("validates payloads against the schema (accepts good, rejects bad)", () => {
    const ok = { orgId: randomUUID(), actorUserId: randomUUID(), fileId: randomUUID() };
    expect(validateEventPayload(FILE_UPLOADED, ok)).toMatchObject(ok);
    // missing fileId
    expect(() =>
      validateEventPayload(FILE_UPLOADED, { orgId: randomUUID(), actorUserId: randomUUID() }),
    ).toThrow();
    // wrong type
    expect(() =>
      validateEventPayload(DEMO_HEARTBEAT, {
        orgId: randomUUID(),
        actorUserId: randomUUID(),
        nonce: 123,
      }),
    ).toThrow();
  });

  it("demo/heartbeat requires a non-empty nonce", () => {
    expect(() =>
      validateEventPayload(DEMO_HEARTBEAT, {
        orgId: randomUUID(),
        actorUserId: randomUUID(),
        nonce: "",
      }),
    ).toThrow();
    const ok = { orgId: randomUUID(), actorUserId: randomUUID(), nonce: "beat-1" };
    expect(validateEventPayload(DEMO_HEARTBEAT, ok)).toMatchObject(ok);
  });
});
