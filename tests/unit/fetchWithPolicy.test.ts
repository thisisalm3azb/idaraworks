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
