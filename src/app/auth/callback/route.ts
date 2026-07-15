/**
 * Auth code-exchange callback — serves BOTH flows that hand us a one-time `code`:
 *   - OAuth (S10): provider redirect from signInWithProviderAction.
 *   - Email confirmation: the signup verification link (signupAction sets
 *     emailRedirectTo here with ?next=/onboarding).
 *
 * Exchange the code for a session, then forward to a SANITIZED same-origin `next`
 * (open-redirect guard — see sanitizeNext). Failure modes are distinguished so a
 * user whose code was already consumed (double-click, mail-scanner prefetch) gets
 * a friendly "already verified — sign in" notice instead of a scary error.
 * The login page whitelists these notice/error keys. See docs/ux/AUTH_CALLBACK_FIX.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { supabaseServer } from "@/platform/tenancy/supabase";
import { classifyExchangeError, requestOrigin, sanitizeNext } from "@/platform/auth/callback";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  // Behind the Vercel proxy request.url can carry the internal host — derive the
  // public origin from the forwarded headers like the auth actions do.
  const origin = requestOrigin(request.headers);
  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=confirm_missing`);
  }
  const supabase = supabaseServer(await cookies());
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const kind = classifyExchangeError(error);
    return NextResponse.redirect(
      kind === "already_confirmed"
        ? `${origin}/login?notice=already_confirmed`
        : `${origin}/login?error=confirm_invalid`,
    );
  }
  // Session established — land on the requested page (email confirm passes
  // /onboarding; OAuth passes nothing and falls back to "/", where resolveLanding
  // routes to the first org or onboarding).
  return NextResponse.redirect(`${origin}${sanitizeNext(url.searchParams.get("next"))}`);
}
