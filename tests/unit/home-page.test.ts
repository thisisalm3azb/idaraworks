/**
 * 005A — the public homepage: routing/CTA contract, bilingual parity, RTL and
 * physical-class safety, mobile-menu accessibility, no dead pricing CTA, and
 * no unsupported customer/compliance/metric claims. The page + sections are
 * server components rendered to static markup; the mobile menu is the one
 * client island. Auth-routing regressions are guarded here and in the
 * auth-callback suite; the full journey lives in the gated e2e spec.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { pricingTiers } from "@/app/_home/pricing";
import { homeNav, SIGNUP_HREF, LOGIN_HREF } from "@/app/_home/nav";
import { getTierBundle } from "@/platform/entitlements";

const tFake = (k: string) => k; // identity translator — we assert on keys/hrefs

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => "/",
}));

const HOME_KEYS = Object.keys(en).filter((k) => k.startsWith("home."));
// The public-homepage marketing copy only — the home.brief/action/chip/
// attention/setup/map namespaces are the owner-DASHBOARD keys (002B), governed
// by their own tests; the content-quality checks below target marketing copy.
const MARKETING = HOME_KEYS.filter((k) =>
  /^home\.(meta|nav|hero|viz|flow|built|caps|gcc|pricing|cta|footer)\./.test(k),
);

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l(?!g)|rounded-r|float-(left|right))\b/;

describe("homepage i18n content", () => {
  it("every home.* key exists in BOTH catalogs (parity)", () => {
    for (const k of HOME_KEYS) {
      expect(en[k as keyof typeof en], `en missing ${k}`).toBeTruthy();
      expect(ar[k as keyof typeof ar], `ar missing ${k}`).toBeTruthy();
    }
    // ar has no home.* key that en lacks.
    for (const k of Object.keys(ar).filter((x) => x.startsWith("home."))) {
      expect(en[k as keyof typeof en], `en missing ${k}`).toBeTruthy();
    }
  });

  it("Arabic homepage copy is genuinely Arabic, not English left in place", () => {
    // Every marketing sentence (skip demo values / brand / acronyms) must carry
    // Arabic script — catches an untranslated string slipping through.
    const proseKeys = MARKETING.filter(
      (k) =>
        !/\.(customer_v|quote_v|total|badge)$/.test(k) &&
        !k.endsWith(".rights") &&
        !k.startsWith("home.viz.quote_v"),
    );
    for (const k of proseKeys) {
      const v = ar[k as keyof typeof ar] as string;
      expect(/[؀-ۿ]/.test(v), `ar.${k} has no Arabic script: "${v}"`).toBe(true);
    }
  });

  it("makes no unsupported customer-count, compliance, or rating claims", () => {
    const BANNED =
      /\b(trusted by|customers worldwide|\d+[\d,]*\+? (customers|businesses|users|companies)|certified|compliant|ISO|SOC ?2|GDPR|guarantee|award|rated|reviews?|testimonial|★|money[- ]back)\b/i;
    for (const loc of [en, ar]) {
      for (const k of MARKETING) {
        expect(
          BANNED.test(String(loc[k as keyof typeof loc])),
          `${k} makes an unsupported claim`,
        ).toBe(false);
      }
    }
  });

  it("never displays a numeric price (launch pricing is being finalized)", () => {
    // The only permitted numeral run is the illustrative demo total in the hero
    // visualization (badged Illustrative). Pricing copy carries no currency figure.
    for (const k of HOME_KEYS.filter((x) => x.startsWith("home.pricing."))) {
      const v = String(en[k as keyof typeof en]);
      expect(/\d/.test(v), `pricing key ${k} contains a number: "${v}"`).toBe(false);
    }
  });
});

describe("routing / CTA contract", () => {
  it("signed-out: Get Started → registration, Log in → /login, sections anchor on-page", () => {
    const { authed, primary, secondary, sections } = homeNav(tFake, null);
    expect(authed).toBe(false);
    expect(primary).toEqual({ href: SIGNUP_HREF, label: "home.nav.get_started" });
    expect(primary.href).toBe("/signup");
    expect(secondary).toEqual({ href: LOGIN_HREF, label: "home.nav.login" });
    expect(secondary!.href).toBe("/login");
    expect(sections.map((s) => s.href)).toEqual(["#product", "#how", "#pricing"]);
  });

  it("authenticated: Open workspace → resolved landing, and NO log-in action", () => {
    const { authed, primary, secondary } = homeNav(tFake, "/o/abc-123");
    expect(authed).toBe(true);
    expect(primary).toEqual({ href: "/o/abc-123", label: "home.nav.open_workspace" });
    expect(secondary).toBeNull(); // never forced back through registration/login
  });

  it("every routing destination is a real internal path (no dead CTA)", () => {
    for (const wh of [null, "/o/xyz", "/onboarding"]) {
      const { primary, secondary } = homeNav(tFake, wh);
      for (const cta of [primary, secondary].filter(Boolean)) {
        expect(cta!.href.startsWith("/") || cta!.href.startsWith("#")).toBe(true);
        expect(cta!.href).not.toMatch(/^https?:|^mailto:|^\s*$/);
      }
    }
  });
});

describe("pricing config — single source, real catalogue tiers", () => {
  it("draws the two paid tiers straight from the entitlements catalogue", () => {
    const tiers = pricingTiers();
    expect(tiers.map((t) => t.key)).toEqual(["free", "medium", "high"]);
    expect(tiers[1]!.names).toEqual(getTierBundle("medium")!.names);
    expect(tiers[2]!.names).toEqual(getTierBundle("high")!.names);
  });

  it("carries no numeric price and exactly one truthful badge", () => {
    const tiers = pricingTiers();
    expect(tiers.filter((t) => t.badgeKey).length).toBe(1);
    expect(JSON.stringify(tiers)).not.toMatch(/\$|usd|aed|\d+\s*\/\s*(mo|month)/i);
  });
});

describe("robots — public page indexable, app paths kept private", async () => {
  const robots = (await import("@/app/robots")).default;
  const r = robots();

  it("allows the public root and disallows every authenticated/tenant path", () => {
    const rule = Array.isArray(r.rules) ? r.rules[0]! : r.rules!;
    expect(rule.allow).toBe("/");
    const disallow = rule.disallow as string[];
    for (const p of ["/o/", "/account", "/onboarding", "/mfa", "/s/", "/api/", "/auth/"]) {
      expect(disallow, `robots must disallow ${p}`).toContain(p);
    }
  });
});

describe("MobileMenu accessibility + RTL safety", async () => {
  const { MobileMenu } = await import("@/app/_home/MobileMenu");
  const html = renderToStaticMarkup(
    h(MobileMenu, {
      links: [
        { href: "#product", label: "المنتج" },
        { href: "#pricing", label: "الأسعار" },
      ],
      primary: { href: "/signup", label: "ابدأ الآن" },
      secondary: { href: "/login", label: "تسجيل الدخول" },
      openLabel: "فتح القائمة",
      closeLabel: "إغلاق القائمة",
      languageSlot: null,
    }),
  );

  it("exposes an aria-labelled disclosure button with aria-expanded/-controls", () => {
    expect(html).toMatch(/aria-expanded="false"/);
    expect(html).toMatch(/aria-controls="home-mobile-menu"/);
    expect(html).toMatch(/aria-label="فتح القائمة"/);
  });

  it("uses no physical-direction classes (mirrors under RTL)", () => {
    const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
    expect(PHYSICAL.test(classes), classes).toBe(false);
  });
});
