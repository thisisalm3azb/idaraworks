import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/platform/tenancy/supabase";
import { REQUEST_ID_HEADER } from "@/platform/observability/requestId";

/**
 * A nonce-based script policy, staged as REPORT-ONLY (security review
 * 2026-09-20, F-04 / SEC-1). This is observation, not enforcement: the
 * enforced policy stays the one next.config.ts sends (with 'unsafe-inline'),
 * and this second header only asks the browser to REPORT what a nonce policy
 * would have blocked, to /api/csp-report. Next.js reads the nonce from this
 * request header and stamps it on every script it emits, so the reports show
 * only the scripts the app itself failed to nonce. It is enforced — moved to
 * next.config as the real policy — only after the reports are empty across
 * signup, install, PDFs, Studio and the installed app.
 */
function reportOnlyPolicy(nonce: string): string {
  const dev = process.env.NODE_ENV === "development";
  return [
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "report-uri /api/csp-report",
  ].join("; ");
}

export async function middleware(request: NextRequest) {
  // Correlation id (Phase I; BUILD_BIBLE §15.3): always server-minted — an
  // inbound client value is overwritten, never trusted (log-spoofing guard).
  const requestId = crypto.randomUUID();
  request.headers.set(REQUEST_ID_HEADER, requestId);
  const nonce = btoa(crypto.randomUUID());
  const cspReportOnly = reportOnlyPolicy(nonce);
  request.headers.set("x-nonce", nonce);
  request.headers.set("content-security-policy-report-only", cspReportOnly);
  // Next.js only reads the nonce it stamps on its own scripts from the
  // ENFORCED header name on the REQUEST. This request-side header never
  // reaches the browser: the response's enforced policy still comes from
  // next.config.ts unchanged, and the browser only sees the report-only
  // policy from middleware. Without this, every page reported Next's own
  // scripts as violations (production, 2026-09-21: 46 reports per walk).
  request.headers.set("content-security-policy", cspReportOnly);
  // Auth-code resilience (docs/ux/AUTH_CALLBACK_FIX.md): if the Supabase Site URL
  // is the only thing the owner fixes, confirmation links land on "/?code=…".
  // Forward that code to /auth/callback (preserving all params) so the exchange
  // still happens; default next=/onboarding matches the email-confirm flow.
  if (request.nextUrl.pathname === "/" && request.nextUrl.searchParams.has("code")) {
    const forward = request.nextUrl.clone();
    forward.pathname = "/auth/callback";
    if (!forward.searchParams.has("next")) forward.searchParams.set("next", "/onboarding");
    const redirect = NextResponse.redirect(forward);
    redirect.headers.set(REQUEST_ID_HEADER, requestId);
    return redirect;
  }
  // 005B.1: the token-hash confirmation/recovery flow. If a link ever lands on
  // "/?token_hash=…&type=…" (e.g. a Site-URL-root email), forward it to the
  // dedicated /auth/confirm route (params preserved) so verification still
  // completes server-side instead of stranding the user on the homepage.
  if (request.nextUrl.pathname === "/" && request.nextUrl.searchParams.has("token_hash")) {
    const forward = request.nextUrl.clone();
    forward.pathname = "/auth/confirm";
    const redirect = NextResponse.redirect(forward);
    redirect.headers.set(REQUEST_ID_HEADER, requestId);
    return redirect;
  }
  const response = await updateSession(request);
  // Echoed on the response so user-reported failures correlate with logs.
  response.headers.set(REQUEST_ID_HEADER, requestId);
  // Report-only: the browser reports, it does not block (see reportOnlyPolicy).
  response.headers.set("content-security-policy-report-only", cspReportOnly);
  return response;
}

export const config = {
  // Session refresh on app routes; skip static assets and health/ready probes
  // (they mint their own request ids and must not touch auth).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health|api/ready|.*\\.(?:svg|png|jpg|ico)$).*)",
  ],
};
