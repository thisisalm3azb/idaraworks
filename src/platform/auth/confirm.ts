/**
 * Pure helpers for the token-hash email-confirmation route (005B.1). Kept out
 * of the route handler so the security-critical decisions — which verification
 * types are accepted, where a verified user lands, and how a failure is
 * classified without leaking the raw error — are unit-testable.
 */
import { sanitizeNext } from "./callback";

/** The email-OTP verification kinds — a local closed union (assignable to the
 * Supabase SDK's EmailOtpType). Declared here rather than imported so this
 * helper stays outside the Supabase-client boundary (only platform/tenancy may
 * import @supabase/*). */
export type EmailOtpType =
  "signup" | "email" | "invite" | "recovery" | "email_change" | "magiclink";

/** The email verification types a link may carry. Anything else is rejected. */
export const ALLOWED_EMAIL_OTP_TYPES: readonly EmailOtpType[] = [
  "signup",
  "email",
  "invite",
  "recovery",
  "email_change",
  "magiclink",
];

export function isAllowedEmailOtpType(v: string | null): v is EmailOtpType {
  return !!v && (ALLOWED_EMAIL_OTP_TYPES as readonly string[]).includes(v);
}

/** Safe post-verification destination: recovery ALWAYS ends on the
 * set-a-new-password screen — a recovery link mints a session, and nothing in
 * the URL may carry that fresh session anywhere else (security review
 * 2026-09-20: `next` used to override the recovery landing). Everything else
 * defaults to onboarding, and any explicit same-origin `next` (e.g. an invite)
 * is honoured after sanitisation (open-redirect guarded). */
export function confirmDestination(type: string | null, nextRaw: string | null): string {
  if (type === "recovery") return "/reset-password";
  return sanitizeNext(nextRaw, "/onboarding");
}

/** Map a verifyOtp failure message to a safe, recoverable reason — never the
 * raw provider error. */
export function confirmFailureReason(message: string | undefined): "expired" | "used" | "invalid" {
  const m = (message ?? "").toLowerCase();
  if (/expired/.test(m)) return "expired";
  if (/already|used|confirm/.test(m)) return "used";
  return "invalid";
}
