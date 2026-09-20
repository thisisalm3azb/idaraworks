/**
 * Security review 2026-09-20, pass two — unit coverage for the pure decisions:
 *   • the rate-limit store is chosen from the environment, the shared store
 *     answers with a retry-after, and a store outage falls back to the
 *     per-process store loudly;
 *   • a recovery link always lands on the reset screen;
 *   • error text that reaches a URL or a page is either app-authored or a
 *     fixed phrase — never a driver or runtime message;
 *   • the public signing page maps failures to a closed set of codes;
 *   • the limit responses say what happened, when to retry, and never carry
 *     a partial file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { confirmDestination } from "@/platform/auth/confirm";
import { safeActionMessage } from "@/platform/http/actionError";
import { limitReached } from "@/platform/http/limitResponse";
import { rateLimit, selectRateLimitStore, type HitRunner } from "@/platform/http/rateLimit";
import { isSignErrorCode, signErrorCode } from "@/app/sign/[token]/errors";
import { DocError } from "@/modules/docstudio/types";
import { FinanceError } from "@/modules/finance/ledger";

describe("rate-limit store selection", () => {
  it("uses Upstash when both credentials are set, whatever else is configured", () => {
    expect(
      selectRateLimitStore({
        UPSTASH_REDIS_REST_URL: "https://x",
        UPSTASH_REDIS_REST_TOKEN: "t",
        RATE_LIMIT_STORE: "memory",
        APP_ENV: "prod",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("upstash");
  });

  it("defaults to the shared database store on a deployed environment", () => {
    const saved = process.env.APP_ENV;
    process.env.APP_ENV = "prod";
    try {
      expect(selectRateLimitStore({} as unknown as NodeJS.ProcessEnv)).toBe("db");
      process.env.APP_ENV = "preview";
      expect(selectRateLimitStore({} as unknown as NodeJS.ProcessEnv)).toBe("db");
    } finally {
      if (saved === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = saved;
    }
  });

  it("stays in memory for local development and honours an explicit choice", () => {
    const saved = process.env.APP_ENV;
    process.env.APP_ENV = "dev";
    try {
      expect(selectRateLimitStore({} as unknown as NodeJS.ProcessEnv)).toBe("memory");
      expect(selectRateLimitStore({ RATE_LIMIT_STORE: "db" } as unknown as NodeJS.ProcessEnv)).toBe(
        "db",
      );
      process.env.APP_ENV = "prod";
      expect(
        selectRateLimitStore({ RATE_LIMIT_STORE: "memory" } as unknown as NodeJS.ProcessEnv),
      ).toBe("memory");
      // Asking for Upstash without its credentials is not a shared store.
      expect(
        selectRateLimitStore({ RATE_LIMIT_STORE: "upstash" } as unknown as NodeJS.ProcessEnv),
      ).toBe("memory");
    } finally {
      if (saved === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = saved;
    }
  });
});

describe("the shared store through rateLimit()", () => {
  it("maps the store's answer, including the retry-after on a refusal", async () => {
    const calls: Array<[string, number, number]> = [];
    const run: HitRunner = async (key, limit, windowSeconds) => {
      calls.push([key, limit, windowSeconds]);
      return { allowed: false, remaining: 0, retry_after: 42 };
    };
    const r = await rateLimit("confirm", "203.0.113.9", { store: "db", run });
    expect(r).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 42 });
    expect(calls).toEqual([["confirm:203.0.113.9", 30, 600]]);
  });

  it("a public or authentication budget REFUSES, loudly, when the shared store fails", async () => {
    const { logger } = await import("@/platform/logger");
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const run: HitRunner = async () => {
      throw new Error("connection refused");
    };
    for (const scope of ["identity", "login", "signup", "confirm", "share", "webhook"] as const) {
      const r = await rateLimit(scope, `outage-${Date.now()}`, { store: "db", run });
      expect(r.allowed, scope).toBe(false);
      expect(r.retryAfterSeconds, scope).toBeGreaterThan(0);
    }
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "identity" }),
      expect.stringContaining("refusing until it answers"),
    );
    spy.mockRestore();
  });

  it("a per-member cost budget falls back to the per-process store, loudly, when the shared store fails", async () => {
    const { logger } = await import("@/platform/logger");
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const run: HitRunner = async () => {
      throw new Error("connection refused");
    };
    for (const scope of ["pdf", "export", "health"] as const) {
      const r = await rateLimit(scope, `fallback-${Date.now()}`, { store: "db", run });
      expect(r.allowed, scope).toBe(true);
    }
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "pdf" }),
      expect.stringContaining("falling back to the per-process store"),
    );
    spy.mockRestore();
  });

  it("the memory store reports when its window will roll over", async () => {
    const id = `mem-${Date.now()}`;
    for (let i = 0; i < 6; i++) await rateLimit("share_pdf", id, { store: "memory" });
    const refused = await rateLimit("share_pdf", id, { store: "memory" });
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
  });
});

describe("recovery links", () => {
  it("always land on the reset screen, whatever `next` says", () => {
    expect(confirmDestination("recovery", "/o/some-org")).toBe("/reset-password");
    expect(confirmDestination("recovery", "https://evil.example")).toBe("/reset-password");
    expect(confirmDestination("recovery", null)).toBe("/reset-password");
    expect(confirmDestination("signup", "/invite/abc")).toBe("/invite/abc");
  });
});

describe("safeActionMessage", () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    const { logger } = await import("@/platform/logger");
    spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
  });
  afterEach(() => spy.mockRestore());

  it("passes an application error's own words through, capped", () => {
    expect(safeActionMessage(new FinanceError("the period is closed"), { where: "t" })).toBe(
      "the period is closed",
    );
    expect(safeActionMessage(new DocError("issue the form first", "state"), { where: "t" })).toBe(
      "issue the form first",
    );
    const long = new FinanceError("x".repeat(500));
    expect(safeActionMessage(long, { where: "t" })).toHaveLength(160);
    expect(spy).not.toHaveBeenCalled();
  });

  it("collapses driver, runtime and validation errors and logs the real one", () => {
    const pg = Object.assign(
      new Error('duplicate key value violates unique constraint "payment_idempotency_uq"'),
      {
        name: "PostgresError",
        code: "23505",
      },
    );
    expect(safeActionMessage(pg, { where: "t" })).toBe("failed");
    expect(
      safeActionMessage(new TypeError("Cannot read properties of undefined"), { where: "t" }),
    ).toBe("failed");
    expect(
      safeActionMessage(new Error("relation public.secret does not exist"), { where: "t" }),
    ).toBe("failed");
    expect(safeActionMessage("boom", { where: "t" })).toBe("failed");
    expect(safeActionMessage(new ZodError([]), { where: "t" })).toBe("invalid input");
    expect(spy).toHaveBeenCalled();
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain("payment_idempotency_uq");
  });
});

describe("the public signing page's error codes", () => {
  it("maps every failure onto the closed set and never onto free text", () => {
    expect(signErrorCode(new ZodError([]))).toBe("invalid");
    expect(signErrorCode(new DocError("x", "validation"))).toBe("invalid");
    expect(signErrorCode(new DocError("x", "conflict"))).toBe("conflict");
    expect(signErrorCode(new DocError("x", "forbidden"))).toBe("forbidden");
    expect(signErrorCode(new DocError("x", "expired"))).toBe("closed");
    expect(signErrorCode(new DocError("x", "state"))).toBe("closed");
    expect(signErrorCode(new DocError("x", "not_found"))).toBe("closed");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(signErrorCode(new Error("relation does not exist"))).toBe("failed");
    spy.mockRestore();
    for (const v of ["invalid", "closed", "conflict", "forbidden", "failed"]) {
      expect(isSignErrorCode(v)).toBe(true);
    }
    for (const v of ["Call 0500 now", "<b>x</b>", "", undefined]) {
      expect(isSignErrorCode(v as string | undefined)).toBe(false);
    }
  });
});

describe("limit responses", () => {
  it("answers a browser with a page and a script with JSON, both with retry-after", async () => {
    const html = limitReached({ kind: "rate_limited", retryAfterSeconds: 30 }, "text/html,*/*");
    expect(html.status).toBe(429);
    expect(html.headers.get("retry-after")).toBe("30");
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("30 seconds");

    const json = limitReached({ kind: "rate_limited", retryAfterSeconds: 30 }, "application/json");
    expect(json.status).toBe(429);
    expect(await json.json()).toMatchObject({ error: "rate_limited", retryAfterSeconds: 30 });
  });

  it("refuses an oversized export explicitly, with no retry-after and no partial file", async () => {
    const r = limitReached({ kind: "export_too_large", limit: 100_000 }, "text/html");
    expect(r.status).toBe(413);
    expect(r.headers.get("retry-after")).toBeNull();
    expect(r.headers.get("content-type")).not.toContain("text/csv");
    const body = await r.text();
    expect(body).toContain("100,000");
    expect(body).toContain("Nothing was downloaded");
  });
});
