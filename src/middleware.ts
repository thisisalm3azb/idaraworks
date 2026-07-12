import type { NextRequest } from "next/server";
import { updateSession } from "@/platform/tenancy/supabase";
import { REQUEST_ID_HEADER } from "@/platform/observability/requestId";

export async function middleware(request: NextRequest) {
  // Correlation id (Phase I; BUILD_BIBLE §15.3): always server-minted — an
  // inbound client value is overwritten, never trusted (log-spoofing guard).
  const requestId = crypto.randomUUID();
  request.headers.set(REQUEST_ID_HEADER, requestId);
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
