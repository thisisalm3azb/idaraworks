/**
 * 005B — the registration gateway + legal pages: gateway structure & provider
 * gating, Terms/Privacy links, EN/AR parity, RTL safety, and the honesty of
 * the legal content (no invented legal entity, address, certification,
 * compliance claim, or support email). The gateway is the one client island;
 * server actions (Supabase-backed) are exercised in the security/e2e layers.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { legalDoc, LEGAL_EFFECTIVE_DATE } from "@/app/_legal/content";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => "/signup",
}));

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l(?!g)|rounded-r|float-(left|right))\b/;

const DICT = {
  google: "Continue with Google",
  or: "Or",
  full_name: "Full name",
  email: "Work email",
  email_hint: "Use your work email.",
  password: "Password",
  password_hint: "At least 10 characters.",
  submit: "Create account",
  submitting: "Creating…",
  have_account: "Already have an account?",
  login: "Sign in",
  agree_pre: "By continuing you agree to our",
  terms: "Terms of Service",
  agree_mid: "and",
  privacy: "Privacy Policy",
  confirm_title: "Check your inbox",
  confirm_sent_to: "We sent a verification link to",
  confirm_explain: "Open it to finish setup — no second login.",
  confirm_spam: "Check spam.",
  confirm_expired: "Links expire.",
  resend: "Resend email",
  resend_cooldown: "Resend in {s}s",
  resend_sent: "Sent.",
  resend_rate: "Wait a moment.",
  change_email: "Use a different email",
  verified_already: "Already verified?",
  errors: { failed: "Failed", invalid: "Invalid", rate_limited: "Slow down" },
};
const noop = async () => ({ ok: false as const, error: "failed" as const });
const noopResend = async () => ({ ok: true as const });
const noopVoid = () => {};

describe("AuthGateway — identity step structure & provider gating", async () => {
  const { AuthGateway } = await import("@/app/(auth)/signup/AuthGateway");

  function render(oauthOn: boolean, next = "") {
    return renderToStaticMarkup(
      h(AuthGateway, {
        oauthOn,
        loginHref: next ? `/login?next=${encodeURIComponent(next)}` : "/login",
        googleNext: next,
        registerAction: noop,
        resendAction: noopResend,
        googleAction: noopVoid,
        dict: DICT,
      }),
    );
  }

  it("collects identity only (name/email/password) with a Continue action", () => {
    const html = render(false);
    expect(html).toContain('name="full_name"');
    expect(html).toContain('name="email"');
    expect(html).toMatch(/type="password"/);
    expect(html).toContain("Create account");
    // No business fields on the gateway.
    expect(html).not.toMatch(/name="business_name"|name="country"/);
  });

  it("shows Google ONLY when the provider is ready, and threads next into it", () => {
    expect(render(false)).not.toContain("Continue with Google");
    const on = render(true, "/invite/abc");
    expect(on).toContain("Continue with Google");
    expect(on).toMatch(/name="provider"[^>]*value="google"/);
    expect(on).toMatch(/name="next"[^>]*value="\/invite\/abc"/);
  });

  it("links to the real Terms and Privacy routes and to Log in", () => {
    const html = render(false, "/invite/abc");
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/login?next=%2Finvite%2Fabc"');
  });

  it("uses no physical-direction classes (RTL-safe)", () => {
    const classes = [...render(true).matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
    expect(PHYSICAL.test(classes), classes).toBe(false);
  });
});

describe("legal content — real, honest, bilingual", () => {
  it("terms & privacy exist in EN and AR with intro + sections + an effective date", () => {
    for (const kind of ["terms", "privacy"] as const) {
      for (const loc of ["en", "ar"] as const) {
        const doc = legalDoc(kind, loc);
        expect(doc.title.length).toBeGreaterThan(0);
        expect(doc.intro.length).toBeGreaterThan(40);
        expect(doc.sections.length).toBeGreaterThanOrEqual(4);
        for (const s of doc.sections) {
          expect(s.heading.length).toBeGreaterThan(0);
          expect(s.paragraphs.length).toBeGreaterThan(0);
        }
      }
    }
    expect(LEGAL_EFFECTIVE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("invents no legal entity, address, certification, compliance claim, or support email", () => {
    const FABRICATED =
      /\b(certified|ISO ?\d|SOC ?2|GDPR[- ]compliant|HIPAA|registered (in|as|number)|LLC\b|L\.L\.C|FZ-?LLC|P\.?O\.? Box|street|@idaraworks\.(com|io)|support@)\b/i;
    for (const kind of ["terms", "privacy"] as const) {
      for (const loc of ["en", "ar"] as const) {
        const text = [
          legalDoc(kind, loc).intro,
          ...legalDoc(kind, loc).sections.flatMap((s) => [s.heading, ...s.paragraphs]),
        ].join(" ");
        expect(FABRICATED.test(text), `${kind}.${loc} makes a fabricated claim`).toBe(false);
      }
    }
  });

  it("Arabic legal docs are genuinely Arabic (no untranslated English body)", () => {
    for (const kind of ["terms", "privacy"] as const) {
      const doc = legalDoc(kind, "ar");
      expect(/[؀-ۿ]/.test(doc.title)).toBe(true);
      expect(/[؀-ۿ]/.test(doc.intro)).toBe(true);
      for (const s of doc.sections) expect(/[؀-ۿ]/.test(s.heading)).toBe(true);
    }
  });
});

describe("gateway/visual i18n parity", () => {
  it("every auth.gateway.* / auth.viz.* key exists in both catalogs", () => {
    const keys = Object.keys(en).filter(
      (k) => k.startsWith("auth.gateway.") || k.startsWith("auth.viz."),
    );
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) {
      expect(en[k as keyof typeof en], `en ${k}`).toBeTruthy();
      expect(ar[k as keyof typeof ar], `ar ${k}`).toBeTruthy();
    }
  });
});
