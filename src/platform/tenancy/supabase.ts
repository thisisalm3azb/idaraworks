/**
 * Supabase AUTH clients — constructed here and nowhere else (phase2/10 #1, #3;
 * lint-enforced). These clients are for AUTH ONLY (sessions, MFA, OTP): all
 * DATA access goes through withCtx/withUserCtx as app_user. The anon key holds
 * no data privileges (RLS policies are TO app_user; built-in roles revoked in 0002).
 */
import { createBrowserClient, createServerClient } from "@supabase/ssr";
import type { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

function supabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set.");
  }
  return { url, anonKey };
}

/** Browser client — client components (login form, MFA enrolment). */
export function supabaseBrowser() {
  const { url, anonKey } = supabaseEnv();
  return createBrowserClient(url, anonKey);
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * Middleware session refresh (@supabase/ssr canonical pattern) — lives here so
 * middleware.ts never imports @supabase/* directly (lint law, phase2/10 #1).
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const { url, anonKey } = supabaseEnv();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });
  await supabase.auth.getUser(); // refreshes expired tokens
  return response;
}

/** Server client bound to the request's cookie store (server components/actions). */
export function supabaseServer(cookieStore: CookieStore) {
  const { url, anonKey } = supabaseEnv();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies; middleware handles refresh.
        }
      },
    },
  });
}
