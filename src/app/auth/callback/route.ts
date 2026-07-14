/**
 * OAuth callback (S10 seam). The provider redirects here with a `code`; exchange it for a session,
 * then land the user in the app. Credential-gated end of the flow started by signInWithProviderAction.
 * On any failure, bounce to /login with a generic error (never leak provider internals).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { supabaseServer } from "@/platform/tenancy/supabase";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const origin = url.origin;
  if (!code) return NextResponse.redirect(`${origin}/login?error=oauth_failed`);
  const supabase = supabaseServer(await cookies());
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${origin}/login?error=oauth_failed`);
  return NextResponse.redirect(`${origin}/`);
}
