import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalCallError, fetchWithPolicy } from "@/platform/http/fetchWithPolicy";

const okResponse = () => new Response("ok", { status: 200 });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchWithPolicy (BUILD_BIBLE §8.10)", () => {
  it("returns a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse()));
    const res = await fetchWithPolicy("https://example.test/a");
    expect(res.status).toBe(200);
  });

  it("retries idempotent requests on 5xx and succeeds", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad", { status: 503 }))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", mock);
    const res = await fetchWithPolicy("https://example.test/b", {}, { backoffMs: 1 });
    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("does not retry POST", async () => {
    const mock = vi.fn().mockRejectedValue(new Error("boom"));
    vi.stubGlobal("fetch", mock);
    await expect(
      fetchWithPolicy("https://example.test/c", { method: "POST" }, { backoffMs: 1 }),
    ).rejects.toBeInstanceOf(ExternalCallError);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("gives up after retries and throws a typed error", async () => {
    const mock = vi.fn().mockRejectedValue(new Error("down"));
    vi.stubGlobal("fetch", mock);
    await expect(
      fetchWithPolicy("https://example.test/d", {}, { retries: 1, backoffMs: 1 }),
    ).rejects.toBeInstanceOf(ExternalCallError);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

describe("circuit breaker (review finding #5)", () => {
  it("opens after repeated terminal 5xx on POST and rejects fast", async () => {
    const mock = vi.fn().mockResolvedValue(new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", mock);
    // 5 terminal 5xx responses on a dedicated host reach the threshold…
    for (let i = 0; i < 5; i++) {
      const res = await fetchWithPolicy(
        "https://breaker.test/x",
        { method: "POST" },
        { backoffMs: 1 },
      );
      expect(res.status).toBe(503);
    }
    // …then the breaker is open: the next call throws without hitting fetch.
    const callsBefore = mock.mock.calls.length;
    await expect(fetchWithPolicy("https://breaker.test/x", { method: "POST" })).rejects.toThrow(
      /Circuit open/,
    );
    expect(mock.mock.calls.length).toBe(callsBefore);
  });

  it("a success resets the failure count", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", mock);
    await fetchWithPolicy("https://reset.test/x", { method: "POST" }, { backoffMs: 1 });
    const res = await fetchWithPolicy("https://reset.test/x", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
