/**
 * Derive a rate-limit key IP from request headers, preferring the PLATFORM-set trusted
 * client IP over the client-SPOOFABLE leftmost x-forwarded-for entry.
 *
 * Why the order matters (review finding #3): on a no-auth surface (the public /s/[token]
 * share page) a caller controls x-forwarded-for. If the rate-limit key were derived from the
 * leftmost XFF entry, a loop could send a distinct XFF per request and never trip the per-IP
 * throttle.
 *
 * On Vercel (VERCEL=1) the edge sets `x-vercel-forwarded-for` and `x-real-ip` to the
 * client address it observed and overwrites whatever the client sent, so ONLY those are
 * consulted there — a client-supplied `true-client-ip` is ignored (security review
 * 2026-09-20: Vercel does not set it, so on Vercel it could only ever come from the
 * client). Off Vercel, a CDN's `true-client-ip` and then the leftmost XFF entry and
 * x-real-ip are accepted, and a constant when nothing is present — a constant still
 * throttles.
 *
 * Shared so the precedence is defined once and unit-tested (health route and auth actions keep
 * their own NextRequest-shaped copies with the identical order).
 */
export function clientIpFromHeaders(h: Headers, env: NodeJS.ProcessEnv = process.env): string {
  const vercel = h.get("x-vercel-forwarded-for");
  if (env.VERCEL) return vercel ?? h.get("x-real-ip") ?? "unknown";
  return (
    vercel ??
    h.get("true-client-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    h.get("x-real-ip") ??
    "unknown"
  );
}
