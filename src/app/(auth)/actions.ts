"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { oauthEnabled } from "@/platform/auth/oauth";
import { sql, withUserCtx } from "@/platform/tenancy";
import { supabaseServer } from "@/platform/tenancy/supabase";
import { getSessionUser, listMyOrgs } from "@/platform/auth/resolve";
import { acceptInvite, createOrgForUser, logAuthEvent } from "@/platform/auth/identity";
import { rateLimit } from "@/platform/http/rateLimit";
import { LOCALE_COOKIE, normalizeLocale } from "@/platform/i18n";

const LOCALE_COOKIE_OPTS = {
  path: "/",
  sameSite: "lax" as const,
  maxAge: 60 * 60 * 24 * 365,
};

/** Set the active-locale cookie from the user's stored profile locale. */
async function applyLocaleFromProfile(userId: string): Promise<void> {
  try {
    const rows = (await withUserCtx(userId, (tx) =>
      tx.execute(sql`select locale from public.user_profile where id = ${userId}`),
    )) as unknown as Array<{ locale: string }>;
    const locale = normalizeLocale(rows[0]?.locale);
    (await cookies()).set(LOCALE_COOKIE, locale, LOCALE_COOKIE_OPTS);
  } catch {
    // A locale-cookie failure must never block sign-in.
  }
}

/** Language switcher (browser cookie only). */
export async function setActiveLocaleAction(locale: string): Promise<void> {
  (await cookies()).set(LOCALE_COOKIE, normalizeLocale(locale), LOCALE_COOKIE_OPTS);
}

/** Language switcher form action (S10): set the active-locale cookie AND persist the choice to
 * user_profile.locale so it follows the signed-in user across devices/sessions. Wired from the
 * account page — before S10 the switcher seam existed but was never mounted, so Arabic/RTL was
 * unreachable (the cookie only ever came from the profile default 'en', which nothing updated). */
export async function changeLanguageAction(formData: FormData): Promise<void> {
  const locale = normalizeLocale(String(formData.get("locale") ?? ""));
  (await cookies()).set(LOCALE_COOKIE, locale, LOCALE_COOKIE_OPTS);
  const user = await getSessionUser();
  if (user) {
    await withUserCtx(user.id, (tx) =>
      tx.execute(sql`update public.user_profile set locale = ${locale} where id = ${user.id}`),
    ).catch(() => {
      // A persistence failure must not break the language change — the cookie already applied.
    });
  }
  redirect("/account?notice=language_changed");
}

async function requestMeta() {
  const h = await headers();
  // Prefer a platform-set trusted client IP (Vercel) over the client-spoofable
  // leftmost x-forwarded-for entry (independent review). Rate-limiting durability
  // still requires Upstash before pilots — tracked in OA-4.
  const ip =
    h.get("x-vercel-forwarded-for") ??
    h.get("true-client-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    undefined;
  return { ip, userAgent: h.get("user-agent") ?? undefined };
}

/**
 * OAuth sign-in seam (S10, doc 11 S10 "OAuth (Google/Microsoft) added"). CREDENTIAL-GATED: the
 * provider must be configured in the Supabase project (owner action) AND OAUTH_ENABLED=true, else
 * the buttons are hidden (see oauthEnabled) and this action refuses. Kicks off the provider redirect;
 * the provider calls back to /auth/callback which exchanges the code for a session.
 */
const OAUTH_PROVIDERS = new Set(["google", "azure"]);

export async function signInWithProviderAction(formData: FormData): Promise<void> {
  if (!oauthEnabled()) redirect("/login?error=oauth_disabled");
  const provider = String(formData.get("provider") ?? "");
  if (!OAUTH_PROVIDERS.has(provider)) redirect("/login?error=invalid");
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("host") ?? "";
  const supabase = supabaseServer(await cookies());
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: provider as "google" | "azure",
    options: { redirectTo: `${proto}://${host}/auth/callback` },
  });
  if (error || !data.url) redirect("/login?error=oauth_failed");
  redirect(data.url);
}

export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").toLowerCase();
  const password = String(formData.get("password") ?? "");
  const meta = await requestMeta();

  const rl = await rateLimit("login", meta.ip ?? email);
  if (!rl.allowed) {
    redirect("/login?error=rate_limited");
  }

  const supabase = supabaseServer(await cookies());
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    await logAuthEvent({ event: "login_failure", detail: { email }, ...meta });
    redirect("/login?error=invalid");
  }
  await logAuthEvent({ userId: data.user.id, event: "login_success", ...meta });
  await applyLocaleFromProfile(data.user.id);
  redirect("/");
}

export async function signupAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").toLowerCase();
  const password = String(formData.get("password") ?? "");
  const fullName = String(formData.get("full_name") ?? "").trim();
  const meta = await requestMeta();

  const rl = await rateLimit("signup", meta.ip ?? email);
  if (!rl.allowed) {
    redirect("/signup?error=rate_limited");
  }

  const supabase = supabaseServer(await cookies());
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  });
  if (error || !data.user) {
    redirect("/signup?error=failed");
  }
  await logAuthEvent({ userId: data.user.id, event: "signup", ...meta });
  // Local/CI: confirmations off => session exists => straight to onboarding.
  // Hosted: confirmations on => the confirm link returns the user to "/".
  redirect(data.session ? "/onboarding" : "/login?notice=confirm_email");
}

export async function logoutAction(): Promise<void> {
  const user = await getSessionUser();
  const supabase = supabaseServer(await cookies());
  await supabase.auth.signOut();
  if (user) {
    await logAuthEvent({ userId: user.id, event: "logout" });
  }
  redirect("/login");
}

export async function signOutOtherDevicesAction(): Promise<void> {
  const supabase = supabaseServer(await cookies());
  await supabase.auth.signOut({ scope: "others" });
  redirect("/account?notice=others_signed_out");
}

/**
 * Audit an MFA lifecycle event (independent review: the mfa_* sign_in_log event
 * types were dead — MFA ran entirely client-side with no audit seam). The client
 * calls this after Supabase confirms the transition; we re-derive the user
 * server-side so the event cannot be forged for someone else.
 */
export async function logMfaEventAction(
  event: "mfa_enrolled" | "mfa_challenge_success" | "mfa_challenge_failure",
): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  const meta = await requestMeta();
  await logAuthEvent({ userId: user.id, event, ...meta });
}

export async function createOrgAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const orgId = await createOrgForUser(user.id, {
    name: String(formData.get("name") ?? ""),
    country: String(formData.get("country") ?? ""),
    baseCurrency: String(formData.get("base_currency") ?? ""),
    timezone: String(formData.get("timezone") ?? "Asia/Dubai"),
    languages: ["en"],
    sixDayWeek: formData.get("six_day") === "on",
  });
  redirect(`/o/${orgId}`);
}

export async function acceptInviteAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const user = await getSessionUser();
  if (!user) {
    redirect(`/login?next=/invite/${encodeURIComponent(token)}`);
  }
  const meta = await requestMeta();
  const rl = await rateLimit("invite_accept", meta.ip ?? user.id);
  if (!rl.allowed) {
    redirect(`/invite/${encodeURIComponent(token)}?error=rate_limited`);
  }
  try {
    const orgId = await acceptInvite(user.id, token);
    redirect(`/o/${orgId}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`/invite/${encodeURIComponent(token)}?error=invalid`);
  }
}

/** Root landing decision: session → first org or onboarding; else login. */
export async function resolveLanding(): Promise<string> {
  const user = await getSessionUser();
  if (!user) return "/login";
  const orgs = await listMyOrgs(user.id);
  return orgs[0] ? `/o/${orgs[0].orgId}` : "/onboarding";
}
