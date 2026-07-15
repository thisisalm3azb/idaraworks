import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/platform/tenancy/supabase";
import { REQUEST_ID_HEADER } from "@/platform/observability/requestId";

export async function middleware(request: NextRequest) {
  // Correlation id (Phase I; BUILD_BIBLE §15.3): always server-minted — an
  // inbound client value is overwritten, never trusted (log-spoofing guard).
  const requestId = crypto.randomUUID();
  request.headers.set(REQUEST_ID_HEADER, requestId);
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
  const response = await updateSession(request);
  // Echoed on the response so user-reported failures correlate with logs.
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  // Session refresh on app routes; skip static assets and health/ready probes
  // (they mint their own request ids and must not touch auth).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health|api/ready|.*\\.(?:svg|png|jpg|ico)$).*)",
  ],
};
