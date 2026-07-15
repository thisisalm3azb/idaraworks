/**
 * U1 — email-confirmation redirect fix (docs/ux/AUTH_CALLBACK_FIX.md).
 * Covers the pure helpers (origin derivation, next-sanitizer, exchange-error
 * classification), the /auth/callback route (mocked supabaseServer), and the
 * middleware root-forwarding of "/?code=…" to /auth/callback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyExchangeError, requestOrigin, sanitizeNext } from "@/platform/auth/callback";

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("requestOrigin", () => {
  const savedAppUrl = process.env.APP_URL;
  afterEach(() => {
    if (savedAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = savedAppUrl;
  });

  it("prefers x-forwarded-host + x-forwarded-proto over host", () => {
    const h = new Headers({
      "x-forwarded-host": "idaraworks.vercel.app",
      "x-forwarded-proto": "https",
      host: "10.0.0.5:3000",
    });
    expect(requestOrigin(h)).toBe("https://idaraworks.vercel.app");
  });

  it("uses host with https default when nothing is forwarded", () => {
    expect(requestOrigin(new Headers({ host: "idaraworks.vercel.app" }))).toBe(
      "https://idaraworks.vercel.app",
    );
  });

  it("defaults localhost hosts to http", () => {
    expect(requestOrigin(new Headers({ host: "localhost:3000" }))).toBe("http://localhost:3000");
    expect(requestOrigin(new Headers({ host: "127.0.0.1:3000" }))).toBe("http://127.0.0.1:3000");
  });

  it("falls back to APP_URL, then localhost, when no host header exists", () => {
    process.env.APP_URL = "https://app.example.test";
    expect(requestOrigin(new Headers())).toBe("https://app.example.test");
    delete process.env.APP_URL;
    expect(requestOrigin(new Headers())).toBe("http://localhost:3000");
  });
});

describe("sanitizeNext (open-redirect guard)", () => {
  it("accepts same-origin absolute paths", () => {
    expect(sanitizeNext("/onboarding")).toBe("/onboarding");
    expect(sanitizeNext("/o/123?tab=reports")).toBe("/o/123?tab=reports");
  });

  it("falls back on empty / missing values", () => {
    expect(sanitizeNext(null)).toBe("/");
    expect(sanitizeNext(undefined)).toBe("/");
    expect(sanitizeNext("")).toBe("/");
    expect(sanitizeNext(null, "/onboarding")).toBe("/onboarding");
  });

  it("rejects protocol-relative URLs (//evil.com)", () => {
    expect(sanitizeNext("//evil.com")).toBe("/");
    expect(sanitizeNext("//evil.com/phish")).toBe("/");
  });

  it("rejects absolute URLs (https://evil.com)", () => {
    expect(sanitizeNext("https://evil.com")).toBe("/");
    expect(sanitizeNext("http://evil.com/x")).toBe("/");
  });

  it("rejects backslash variants (/\\evil — browsers treat \\ as /)", () => {
    expect(sanitizeNext("/\\evil.com")).toBe("/");
    expect(sanitizeNext("/\\/evil.com")).toBe("/");
    expect(sanitizeNext("/a\\b")).toBe("/");
  });

  it("rejects embedded schemes and control characters", () => {
    expect(sanitizeNext("/redirect?to=https://evil.com")).toBe("/");
    expect(sanitizeNext("/\t/evil.com")).toBe("/");
    expect(sanitizeNext("/a\nb")).toBe("/");
  });

  it("rejects relative paths (no leading slash)", () => {
    expect(sanitizeNext("onboarding")).toBe("/");
    expect(sanitizeNext("../up")).toBe("/");
  });
});

describe("classifyExchangeError", () => {
  it("treats consumed/expired flow states as already-confirmed", () => {
    expect(classifyExchangeError({ code: "flow_state_not_found", status: 404 })).toBe(
      "already_confirmed",
    );
    expect(classifyExchangeError({ code: "flow_state_expired" })).toBe("already_confirmed");
    expect(classifyExchangeError({ code: "otp_expired" })).toBe("already_confirmed");
    expect(classifyExchangeError({ message: "Email link is invalid or has expired" })).toBe(
      "already_confirmed",
    );
    expect(
      classifyExchangeError({ message: "invalid flow state, no valid flow state found" }),
    ).toBe("already_confirmed");
  });

  it("treats everything else as genuinely invalid", () => {
    expect(
      classifyExchangeError({ message: "invalid request: auth code malformed", status: 400 }),
    ).toBe("confirm_invalid");
    expect(classifyExchangeError({})).toBe("confirm_invalid");
  });
});

// ── /auth/callback route (mocked supabaseServer) ────────────────────────────

const exchangeMock = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ getAll: () => [], set: () => {} })),
}));

vi.mock("@/platform/tenancy/supabase", () => ({
  supabaseServer: vi.fn(() => ({ auth: { exchangeCodeForSession: exchangeMock } })),
  updateSession: vi.fn(),
}));

import { GET } from "@/app/auth/callback/route";

const CALLBACK_HEADERS = { host: "app.test", "x-forwarded-proto": "https" };

function callbackRequest(query: string): Request {
  return new Request(`https://app.test/auth/callback${query}`, { headers: CALLBACK_HEADERS });
}

describe("GET /auth/callback", () => {
  beforeEach(() => {
    exchangeMock.mockReset();
  });

  it("missing code → /login?error=confirm_missing", async () => {
    const res = await GET(callbackRequest(""));
    expect(res.headers.get("location")).toBe("https://app.test/login?error=confirm_missing");
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it("invalid code → /login?error=confirm_invalid", async () => {
    exchangeMock.mockResolvedValue({
      error: { message: "invalid request: auth code malformed", status: 400 },
    });
    const res = await GET(callbackRequest("?code=bad"));
    expect(res.headers.get("location")).toBe("https://app.test/login?error=confirm_invalid");
  });

  it("already-used code → /login?notice=already_confirmed (friendly, not scary)", async () => {
    exchangeMock.mockResolvedValue({
      error: {
        message: "invalid flow state, no valid flow state found",
        status: 404,
        code: "flow_state_not_found",
      },
    });
    const res = await GET(callbackRequest("?code=used"));
    expect(res.headers.get("location")).toBe("https://app.test/login?notice=already_confirmed");
  });

  it("success → sanitized next (email confirm lands on /onboarding)", async () => {
    exchangeMock.mockResolvedValue({ error: null });
    const res = await GET(callbackRequest("?code=ok&next=/onboarding"));
    expect(res.headers.get("location")).toBe("https://app.test/onboarding");
  });

  it("success without next (OAuth) → / for resolveLanding", async () => {
    exchangeMock.mockResolvedValue({ error: null });
    const res = await GET(callbackRequest("?code=ok"));
    expect(res.headers.get("location")).toBe("https://app.test/");
  });

  it("malicious next values fall back to / (no open redirect)", async () => {
    exchangeMock.mockResolvedValue({ error: null });
    for (const evil of [
      "//evil.com",
      "https://evil.com",
      "/\\evil.com",
      encodeURIComponent("https://evil.com"),
    ]) {
      const res = await GET(callbackRequest(`?code=ok&next=${evil}`));
      expect(res.headers.get("location")).toBe("https://app.test/");
    }
  });
});

// ── Middleware root-forwarding ("/?code=…" → /auth/callback) ────────────────

describe("middleware forwards a root auth code to /auth/callback", () => {
  it("preserves the code and defaults next=/onboarding", async () => {
    const { NextRequest } = await import("next/server");
    const { middleware } = await import("@/middleware");
    const res = await middleware(new NextRequest("https://app.test/?code=abc123"));
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/auth/callback");
    expect(location.searchParams.get("code")).toBe("abc123");
    expect(location.searchParams.get("next")).toBe("/onboarding");
  });

  it("does not intercept a plain root request", async () => {
    const { updateSession } = await import("@/platform/tenancy/supabase");
    vi.mocked(updateSession).mockResolvedValue(
      new (await import("next/server")).NextResponse(null),
    );
    const { NextRequest } = await import("next/server");
    const { middleware } = await import("@/middleware");
    const res = await middleware(new NextRequest("https://app.test/"));
    expect(res.headers.get("location")).toBeNull();
  });
});
