/**
 * Email verification via TOKEN HASH (005B.1) — the server-rendered SSR flow.
 *
 * The confirmation/recovery email links here with `?token_hash=…&type=…&next=…`.
 * We verify the hash SERVER-SIDE (verifyOtp) and set the session cookie, so
 * confirmation is NOT tied to the browser that started signup (unlike the PKCE
 * `code` flow, which needs the code-verifier cookie). This is the fix for the
 * localhost / "log in again" defect: the link resolves entirely on the server
 * and lands the user on their destination already authenticated.
 *
 * This is DISTINCT from /auth/callback, which stays the OAuth (PKCE) callback.
 * Never logs the token. Never redirects off-origin. Cleans the URL. Rejects
 * unsupported types. Failures land on the branded, recoverable /auth/verify.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { supabaseServer } from "@/platform/tenancy/supabase";
import { requestOrigin } from "@/platform/auth/callback";
import {
  confirmDestination,
  confirmFailureReason,
  isAllowedEmailOtpType,
} from "@/platform/auth/confirm";
import { clientIpFromHeaders } from "@/platform/http/clientIp";
import { rateLimit } from "@/platform/http/rateLimit";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const origin = requestOrigin(request.headers);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const next = confirmDestination(type, url.searchParams.get("next"));

  const rawNext = url.searchParams.get("next");
  const keep = rawNext ? `&next=${encodeURIComponent(next)}` : "";
  if (!tokenHash || !isAllowedEmailOtpType(type)) {
    return NextResponse.redirect(`${origin}/auth/verify?reason=invalid${keep}`);
  }

  // Security review 2026-09-20: every call verifies against the auth provider,
  // so the route is budgeted per client address. A refusal lands on the same
  // recoverable page as a transient provider failure — the link itself is
  // still valid and works again once the window rolls over.
  const gate = await rateLimit("confirm", clientIpFromHeaders(request.headers));
  if (!gate.allowed) {
    return NextResponse.redirect(`${origin}/auth/verify?reason=temporary${keep}`, {
      headers: { "retry-after": String(gate.retryAfterSeconds) },
    });
  }

  const supabase = supabaseServer(await cookies());
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) {
    // No token in the URL, no internal error text surfaced.
    return NextResponse.redirect(
      `${origin}/auth/verify?reason=${confirmFailureReason(error.message)}${keep}`,
    );
  }

  // Session established (cookies set) — land on the clean destination, no
  // token_hash / type / next left in the URL.
  return NextResponse.redirect(`${origin}${next}`);
}
