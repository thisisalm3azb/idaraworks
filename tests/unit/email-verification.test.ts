/**
 * 005B.1 Part A — the email-verification journey contract: the token-hash
 * confirm route's decisions (type whitelist, safe destination, non-leaking
 * failure classification), the open-redirect guard on `next`, and the
 * verify-error page's recoverable-state map. The live Supabase verifyOtp call
 * is exercised by the production email test in the report, not here.
 */
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import {
  ALLOWED_EMAIL_OTP_TYPES,
  confirmDestination,
  confirmFailureReason,
  isAllowedEmailOtpType,
} from "@/platform/auth/confirm";

describe("confirm route — accepted verification types", () => {
  it("accepts exactly the supported email-OTP types and rejects anything else", () => {
    for (const t of ALLOWED_EMAIL_OTP_TYPES) expect(isAllowedEmailOtpType(t)).toBe(true);
    for (const bad of [null, "", "phone", "sms", "token", "signup ", "SIGNUP", "../recovery"]) {
      expect(isAllowedEmailOtpType(bad), `must reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe("confirm route — safe destination", () => {
  it("recovery always lands on the reset-password screen", () => {
    expect(confirmDestination("recovery", null)).toBe("/reset-password");
    // A different next cannot redirect a recovery elsewhere-external, but a safe
    // same-origin path is honoured.
    expect(confirmDestination("recovery", "/reset-password")).toBe("/reset-password");
  });

  it("a new signup defaults to onboarding, and a safe invite next is honoured", () => {
    expect(confirmDestination("signup", null)).toBe("/onboarding");
    expect(confirmDestination("signup", "/invite/abc")).toBe("/invite/abc");
    expect(confirmDestination("email", "/o/xyz")).toBe("/o/xyz");
  });

  it("rejects an unsafe/open-redirect next and falls back to the safe default", () => {
    for (const evil of [
      "https://evil.com",
      "//evil.com",
      "/\\evil.com",
      "http://localhost:3000/onboarding",
      "javascript:alert(1)",
    ]) {
      expect(confirmDestination("signup", evil)).toBe("/onboarding");
    }
  });
});

describe("confirm route — failure classification is safe and recoverable", () => {
  it("maps provider messages to recoverable reasons without leaking the raw text", () => {
    expect(confirmFailureReason("Token has expired")).toBe("expired");
    expect(confirmFailureReason("otp_expired")).toBe("expired");
    expect(confirmFailureReason("Email link is invalid or has already been used")).toBe("used");
    expect(confirmFailureReason("already confirmed")).toBe("used");
    expect(confirmFailureReason("something weird")).toBe("invalid");
    expect(confirmFailureReason(undefined)).toBe("invalid");
    // Only the three closed reasons are ever produced.
    for (const m of ["expired", "used foo", "gibberish", ""]) {
      expect(["expired", "used", "invalid"]).toContain(confirmFailureReason(m));
    }
  });
});

describe("verify-error + resend i18n parity", () => {
  it("every auth.verify.* and new auth.gateway.* key exists in both catalogs", () => {
    const keys = Object.keys(en).filter(
      (k) =>
        k.startsWith("auth.verify.") ||
        [
          "auth.gateway.confirm_sent_to",
          "auth.gateway.confirm_explain",
          "auth.gateway.confirm_spam",
          "auth.gateway.confirm_expired",
          "auth.gateway.resend",
          "auth.gateway.resend_cooldown",
          "auth.gateway.change_email",
          "auth.gateway.verified_already",
        ].includes(k),
    );
    expect(keys.length).toBeGreaterThanOrEqual(15);
    for (const k of keys) {
      expect(en[k as keyof typeof en], `en ${k}`).toBeTruthy();
      expect(ar[k as keyof typeof ar], `ar ${k}`).toBeTruthy();
    }
  });

  it("the resend-cooldown string carries the {s} placeholder in both languages", () => {
    expect(String(en["auth.gateway.resend_cooldown" as keyof typeof en])).toContain("{s}");
    expect(String(ar["auth.gateway.resend_cooldown" as keyof typeof ar])).toContain("{s}");
  });
});
