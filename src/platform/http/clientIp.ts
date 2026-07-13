/**
 * Derive a rate-limit key IP from request headers, preferring the PLATFORM-set trusted
 * client IP over the client-SPOOFABLE leftmost x-forwarded-for entry.
 *
 * Why the order matters (review finding #3): on a no-auth surface (the public /s/[token]
 * share page) a caller controls x-forwarded-for. If the rate-limit key were derived from the
 * leftmost XFF entry, a loop could send a distinct XFF per request and never trip the per-IP
 * throttle. Vercel sets x-vercel-forwarded-for to the real client IP it observed; true-client-ip
 * is the equivalent from other CDNs. Only fall back to the (spoofable) XFF / x-real-ip when no
 * trusted header is present, and to a constant when nothing is — a constant still throttles.
 *
 * Shared so the precedence is defined once and unit-tested (health route and auth actions keep
 * their own NextRequest-shaped copies with the identical order).
 */
export function clientIpFromHeaders(h: Headers): string {
  return (
    h.get("x-vercel-forwarded-for") ??
    h.get("true-client-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    h.get("x-real-ip") ??
    "unknown"
  );
}
