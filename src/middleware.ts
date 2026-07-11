import type { NextRequest } from "next/server";
import { updateSession } from "@/platform/tenancy/supabase";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Session refresh on app routes; skip static assets and health.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health|.*\\.(?:svg|png|jpg|ico)$).*)"],
};
