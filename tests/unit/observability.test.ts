/**
 * Phase I unit tests: the Sentry PII scrub law, env-gating no-ops, request-id
 * format, and the explicit inngest configuration status.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  scrubEvent,
  sentryEnabled,
  captureRequestError,
  captureWorkerError,
  captureDeadLetter,
} from "@/platform/observability/sentry";
import { newRequestId } from "@/platform/observability/requestId";
import { inngestStatus } from "@/platform/observability/health";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterEach(() => {
  delete process.env.SENTRY_DSN;
  delete process.env.INNGEST_SIGNING_KEY;
  delete process.env.INNGEST_EVENT_KEY;
});

describe("scrubEvent (PII law — Bible §5.9/§8.5)", () => {
  it("strips cookies, body, and all headers except the correlation id", () => {
    const event = scrubEvent({
      request: {
        cookies: { session: "secret-session" } as unknown as string,
        data: { password: "hunter2" },
        headers: {
          "x-request-id": "rid-1",
          authorization: "Bearer token",
          cookie: "sb-auth=abc",
        },
      },
    } as unknown as Parameters<typeof scrubEvent>[0]);
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.data).toBeUndefined();
    expect(event.request?.headers).toEqual({ "x-request-id": "rid-1" });
  });

  it("drops headers entirely when no correlation id is present", () => {
    const event = scrubEvent({
      request: { headers: { authorization: "Bearer token" } },
    } as unknown as Parameters<typeof scrubEvent>[0]);
    expect(event.request?.headers).toEqual({});
  });

  it("reduces user context to the id", () => {
    const event = scrubEvent({
      user: { id: "u-1", email: "someone@example.com", username: "someone" },
    } as unknown as Parameters<typeof scrubEvent>[0]);
    expect(event.user).toEqual({ id: "u-1" });
  });

  it("drops breadcrumb data payloads", () => {
    const event = scrubEvent({
      breadcrumbs: [{ category: "query", data: { sql: "select secret" } }],
    } as unknown as Parameters<typeof scrubEvent>[0]);
    expect(event.breadcrumbs?.[0]?.data).toBeUndefined();
    expect(event.breadcrumbs?.[0]?.category).toBe("query");
  });
});

describe("env gating (OA-4 pre-provisioning state)", () => {
  it("is disabled without SENTRY_DSN and every capture is a no-op", () => {
    expect(sentryEnabled()).toBe(false);
    expect(() => {
      captureRequestError(new Error("x"), { requestId: "r" });
      captureWorkerError(new Error("x"), { functionId: "f" });
      captureDeadLetter([{ id: "1", name: "demo/heartbeat" }]);
    }).not.toThrow();
  });

  it("reports enabled when a DSN is present", () => {
    process.env.SENTRY_DSN = "https://key@o0.ingest.sentry.io/0";
    expect(sentryEnabled()).toBe(true);
  });
});

describe("request id", () => {
  it("mints uuid-format ids", () => {
    const a = newRequestId();
    expect(a).toMatch(UUID_RE);
    expect(newRequestId()).not.toBe(a);
  });
});

describe("inngest status (explicit, never a silent 500)", () => {
  it("is unconfigured without keys, with an actionable detail", () => {
    const s = inngestStatus();
    expect(s.status).toBe("unconfigured");
    expect(s.configured).toBe(false);
    expect(s.detail).toContain("inngest-provisioning");
  });

  it("is configured only when BOTH keys are present", () => {
    process.env.INNGEST_SIGNING_KEY = "signkey";
    expect(inngestStatus().configured).toBe(false);
    process.env.INNGEST_EVENT_KEY = "eventkey";
    expect(inngestStatus()).toEqual({ configured: true, status: "configured" });
  });
});
