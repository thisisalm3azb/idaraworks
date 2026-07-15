/**
 * Auth-callback helpers (email confirmation + OAuth) — pure functions, unit-tested.
 *
 * Why this exists (prod defect): signupAction called supabase.auth.signUp without
 * emailRedirectTo, so confirmation links fell back to the Supabase project Site URL
 * (still http://localhost:3000) and landed users on "refused to connect" — even though
 * the email WAS verified. The fix derives the redirect origin from the live request,
 * exchanges the code in /auth/callback for BOTH flows, and sanitizes the `next` hop
 * so the callback can never be used as an open redirect.
 */

/**
 * Derive the request's public origin. Prefers the proxy-forwarded host (Vercel sets
 * x-forwarded-host/-proto) over the raw Host header — same header-trust posture as
 * requestMeta/clientIpFromHeaders. Falls back to APP_URL, then localhost, so local
 * dev without env vars still works.
 */
export function requestOrigin(h: Headers): string {
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return process.env.APP_URL ?? "http://localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

/** True when the string contains a C0 control (0x00-0x1F) or DEL (0x7F). */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/**
 * Sanitize a post-auth `next` hop so the callback is never an open redirect.
 * Accepts only same-origin absolute paths: must start with "/", must not start
 * with "//" (protocol-relative — `new URL("//evil.com", origin)` leaves the origin),
 * must not embed a scheme ("://"), and must not contain backslashes (browsers treat
 * "\" as "/", so "/\evil.com" is "//evil.com") or control characters (the URL parser
 * strips tab/CR/LF, which would let a tab-split "//" collapse back together).
 * Anything else → fallback.
 */
export function sanitizeNext(raw: string | null | undefined, fallback = "/"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.includes("\\")) return fallback;
  if (raw.includes("://")) return fallback;
  if (hasControlChars(raw)) return fallback;
  return raw;
}

/**
 * Classify an exchangeCodeForSession failure. A confirmation code is single-use:
 * clicking the email link twice (or a mail scanner pre-fetching it) burns the code,
 * but the email itself IS verified — Supabase reports that as a consumed/expired
 * PKCE flow state or an expired OTP. Those users should see a friendly
 * "already verified — sign in" notice, not a scary error.
 */
export function classifyExchangeError(error: {
  message?: string;
  status?: number;
  code?: string;
}): "already_confirmed" | "confirm_invalid" {
  const code = error.code ?? "";
  if (code === "flow_state_not_found" || code === "flow_state_expired" || code === "otp_expired") {
    return "already_confirmed";
  }
  const message = (error.message ?? "").toLowerCase();
  if (
    message.includes("flow state") ||
    message.includes("expired") ||
    message.includes("already") ||
    message.includes("used")
  ) {
    return "already_confirmed";
  }
  return "confirm_invalid";
}
