/**
 * 005A — the public homepage: routing/CTA contract, bilingual parity, RTL and
 * physical-class safety, mobile-menu accessibility, no dead pricing CTA, and
 * no unsupported customer/compliance/metric claims. The page + sections are
 * server components rendered to static markup; the mobile menu is the one
 * client island. Auth-routing regressions are guarded here and in the
 * auth-callback suite; the full journey lives in the gated e2e spec.
 */
import { existsSync, readFileSync } from "node:fs";
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
  /^home.(meta|nav|hero|viz|flow|built|os|gcc|trust|pricing|close|footer)\./.test(k),
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
    // "reviews" (plural) targets fake social proof; the verb "review" is the
    // product's real review-before-apply behavior (H5) and stays allowed.
    // A percentage is banned as fake statistics UNLESS it is the verified
    // annual saving ("Save 20%" / "وفّر 20%" — H9.1).
    const BANNED =
      /\b(trusted by|customers worldwide|\d+[\d,]*\+? (customers|businesses|users|companies)|certified|compliant|ISO|SOC ?2|GDPR|guarantee|award|rated|reviews|testimonial|★|money[- ]back)\b|(?<!save )(?<!وفّر )(?<!\d)\d+%/i;
    for (const loc of [en, ar]) {
      for (const k of MARKETING) {
        expect(
          BANNED.test(String(loc[k as keyof typeof loc])),
          `${k} makes an unsupported claim`,
        ).toBe(false);
      }
    }
  });

  it("pricing numerals are only the approved facts (H9.1: prices live in config)", () => {
    // Prices render from the typed pricing config, never from catalog copy.
    // The only catalog numerals allowed are the verified facts: seat counts
    // (3 / 13) and the 20% annual saving.
    for (const k of HOME_KEYS.filter((x) => x.startsWith("home.pricing."))) {
      const v = String(en[k as keyof typeof en]);
      const stripped = v.replace(/\b(3|13)\b/g, "").replace(/20%/g, "");
      expect(/\d/.test(stripped), `pricing key ${k} carries an unapproved number: "${v}"`).toBe(
        false,
      );
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
    // H2/H8: section links in the page's own reading order. Trust is
    // deliberately absent (a fifth item overflows the 768px English header);
    // #trust is reached through the page flow and the footer.
    expect(sections.map((s) => s.href)).toEqual(["#how", "#product", "#international", "#pricing"]);
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
  it("anchors internal tiers to the catalogue; public labels are the H9.1 names", () => {
    const tiers = pricingTiers();
    expect(tiers.map((t) => t.key)).toEqual(["free", "medium", "high"]);
    // The catalogue tiers must still exist (identity anchor); the PUBLIC
    // display labels are deliberately different (documented mapping).
    expect(getTierBundle("medium")).toBeTruthy();
    expect(getTierBundle("high")).toBeTruthy();
    expect(tiers.map((t) => t.names.en)).toEqual(["Free", "Operations", "Complete"]);
  });

  it("carries exactly the approved target prices and one truthful badge", () => {
    const tiers = pricingTiers();
    expect(tiers.filter((t) => t.badgeKey).length).toBe(1);
    expect(tiers.map((t) => t.price.monthlyUsd)).toEqual([0, 39, 89]);
    expect(tiers.map((t) => t.price.annualBilledUsd)).toEqual([0, 372, 852]);
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
      navLabel: "الرئيسية",
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

// H1 (006B): homepage truthfulness + international-first copy. These assertions
// encode the deliberate copy corrections and must not be weakened to pass.
describe("H1 truthfulness + international-first copy", () => {
  const marketingEn = MARKETING.map((k) => String(en[k as keyof typeof en])).join("  ");
  const marketingAr = MARKETING.map((k) => String(ar[k as keyof typeof ar])).join("  ");
  const builtEn = Object.keys(en)
    .filter((k) => k.startsWith("home.built."))
    .map((k) => String(en[k as keyof typeof en]))
    .join("  ");

  it("does not claim AI configures the product today (removed claim cannot return)", () => {
    expect(marketingEn.toLowerCase()).not.toContain("ai can help");
    expect(marketingEn).not.toMatch(
      /turn(s|ing)?\s+(your\s+)?(plain\s+)?answers\s+into\s+a\s+working\s+setup/i,
    );
    // No marketing copy attributes configuration or setup to AI in the present tense.
    expect(marketingEn).not.toMatch(/\bAI\b[^.]{0,60}(configur|set\s?up|setup)/i);
    expect(builtEn).not.toMatch(/\bAI\b/); // the built section is AI-free after H1
  });

  it("describes guided setup truthfully: nothing is created until confirmed", () => {
    expect(builtEn).toMatch(/guided setup/i);
    expect(builtEn).toMatch(
      /nothing is created until|before (anything|it) is (created|confirmed)/i,
    );
  });

  it("keeps the AI configuration boundary as a planned principle, not an active feature", () => {
    const guard = String(en["home.built.guardrail" as keyof typeof en]);
    expect(guard).toMatch(/propose changes for you to approve/i);
    expect(guard).toMatch(/never (write|change)[^.]*(code|database|security)/i);
    expect(guard.toLowerCase()).not.toContain("ai helps with configuration");
  });

  it("removes GCC-only positioning", () => {
    for (const blob of [marketingEn, marketingAr]) {
      expect(blob.toLowerCase()).not.toContain("made for the gcc");
    }
    expect(marketingEn).not.toMatch(/native for (the )?gcc/i);
    expect(marketingEn).not.toMatch(/(built|made|only|exclusively) for (the )?gcc\b/i);
    expect(String(en["home.meta.description" as keyof typeof en])).not.toMatch(
      /for gcc (small|medium|businesses)/i,
    );
  });

  it("renders international-first framing, with the UAE and GCC as the launch market", () => {
    expect(marketingEn).toMatch(/across markets/i);
    expect(marketingEn).toMatch(/first launch market/i);
    // GCC is allowed only as launch-market context, never as the product boundary.
    expect(marketingEn).toMatch(/uae and gcc/i);
  });

  it("describes English and Arabic as available now", () => {
    expect(marketingEn).toMatch(/arabic and english/i);
    expect(marketingEn).toMatch(/arabic and english[^.]*\b(today|now|work)\b/i);
    expect(marketingEn).toMatch(/right-to-left/i);
  });

  it("describes Spanish as planned, never as available, and adds no Spanish locale", () => {
    expect(marketingEn).toMatch(/spanish is planned/i);
    expect(marketingEn).not.toMatch(/spanish[^.]*\b(today|now|available)\b/i);
    expect(existsSync("src/platform/i18n/messages/es.json")).toBe(false);
  });

  it("does not claim custom roles or trade-tailored permissions", () => {
    expect(marketingEn).not.toMatch(/custom roles?/i);
    expect(marketingEn).not.toMatch(/create (your own )?roles?/i);
    expect(marketingEn).not.toMatch(/permissions that match your trade/i);
  });

  it("preserves the available-now vs planned distinction and the Illustrative label", () => {
    expect(String(en["home.built.now_label" as keyof typeof en])).toMatch(/now|available/i);
    expect(String(en["home.built.planned_label" as keyof typeof en])).toMatch(/planned/i);
    expect(en["home.viz.illustrative" as keyof typeof en]).toBeTruthy();
    expect(ar["home.viz.illustrative" as keyof typeof ar]).toBeTruthy();
  });

  it("contains no em dash in any homepage marketing copy (en or ar)", () => {
    for (const k of MARKETING) {
      expect(String(en[k as keyof typeof en]), `en.${k} has an em dash`).not.toContain("—");
      expect(String(ar[k as keyof typeof ar]), `ar.${k} has an em dash`).not.toContain("—");
    }
  });
});

// H2 (006C): public header + navigation. The homepage is an async server
// component (cookies-bound), so structural wiring is asserted against its
// SOURCE, the nav contract against the pure homeNav(), and the focus trap
// against its pure decision function — the repo has no DOM test environment
// (vitest env "node", no jsdom dependency), so real keydown/focus events are
// verified on the deployed page, not here.
describe("H2 header + navigation", () => {
  const homeSrc = readFileSync("src/app/_home/HomePage.tsx", "utf8");
  const menuSrc = readFileSync("src/app/_home/MobileMenu.tsx", "utf8");
  const langSrc = readFileSync("src/app/_home/LanguageSwitch.tsx", "utf8");

  it("every header section link targets an existing homepage anchor, with sticky offset", () => {
    const { sections } = homeNav(tFake, null);
    for (const s of sections) {
      const id = s.href.slice(1);
      const sectionTag = new RegExp(`<section id="${id}" className="[^"]*scroll-mt-`);
      expect(sectionTag.test(homeSrc), `#${id} must exist with a scroll-mt offset`).toBe(true);
    }
  });

  it("the Trust section exists; the header omits it by measured decision (H8)", () => {
    // The section and anchor are real; the header stays at four items because
    // a fifth overflows the English header at 768px. The footer links #trust.
    expect(homeSrc).toMatch(/<section id="trust" className="[^"]*scroll-mt-16/);
    const { sections } = homeNav(tFake, null);
    expect(sections.some((s) => s.href === "#trust")).toBe(false);
    expect(en["home.nav.trust" as keyof typeof en]).toBeTruthy(); // used by the footer
    expect(ar["home.nav.trust" as keyof typeof ar]).toBeTruthy();
  });

  it("International targets the real international section anchor", () => {
    const { sections } = homeNav(tFake, null);
    const intl = sections.find((s) => s.label === "home.nav.international");
    expect(intl?.href).toBe("#international");
    expect(homeSrc).toMatch(/<section id="international"/);
    expect(en["home.nav.international" as keyof typeof en]).toBeTruthy();
    expect(ar["home.nav.international" as keyof typeof ar]).toBeTruthy();
  });

  it("skip link targets a real, focusable main-content destination", () => {
    expect(homeSrc).toMatch(/href="#main"/);
    expect(homeSrc).toMatch(/<main id="main" tabIndex=\{-1\}/);
    // Hidden until focus, then a visible ≥44px card above the sticky header.
    expect(homeSrc).toMatch(/sr-only focus:not-sr-only/);
    expect(homeSrc).toMatch(/focus:min-h-11/);
    expect(homeSrc).toMatch(/focus:z-50/);
    expect(en["home.nav.skip" as keyof typeof en]).toBeTruthy();
    expect(ar["home.nav.skip" as keyof typeof ar]).toBeTruthy();
  });

  it("desktop navigation is a labelled landmark with 44px targets; brand link is named", () => {
    expect(homeSrc).toMatch(/<nav[^>]*aria-label=\{t\("home\.nav\.primary"\)\}/s);
    expect(homeSrc).toMatch(/min-h-11 items-center rounded-md px-3 text-sm font-medium/);
    expect(homeSrc).toMatch(/aria-label=\{t\("home\.nav\.brand_home"\)\}/);
  });

  it("mobile nav landmark uses a proper label, not the open-menu button label", () => {
    expect(menuSrc).toMatch(/<nav[^>]*aria-label=\{navLabel\}/s);
    expect(menuSrc).not.toMatch(/<nav[^>]*aria-label=\{openLabel\}/s);
  });

  describe("mobile-menu focus trap (pure decision function)", async () => {
    const { trapTabTarget } = await import("@/app/_home/MobileMenu");
    const [trigger, a, b, c] = ["trigger", "a", "b", "c"];

    it("Tab from the last control wraps to the trigger", () => {
      expect(trapTabTarget([trigger, a, b, c], c, false)).toBe(trigger);
    });
    it("Shift+Tab from the trigger wraps to the last control", () => {
      expect(trapTabTarget([trigger, a, b, c], trigger, true)).toBe(c);
    });
    it("focus that escaped the cycle is pulled back to the trigger", () => {
      expect(trapTabTarget([trigger, a, b, c], "outside", false)).toBe(trigger);
      expect(trapTabTarget([trigger, a, b, c], null, false)).toBe(trigger);
    });
    it("mid-cycle Tab lets the browser's default order proceed", () => {
      expect(trapTabTarget([trigger, a, b, c], a, false)).toBeNull();
      expect(trapTabTarget([trigger, a, b, c], b, true)).toBeNull();
    });
    it("an empty cycle traps nothing", () => {
      expect(trapTabTarget([], null, false)).toBeNull();
    });
    it("the keydown handler wires Tab through the trap with trigger + sheet controls", () => {
      expect(menuSrc).toMatch(/e\.key === "Tab"/);
      expect(menuSrc).toMatch(/\[trigger, \.\.\.Array\.from\(sheet\.querySelectorAll/);
      expect(menuSrc).toMatch(/trapTabTarget\(\s*cycle/);
    });
  });

  it("Escape closes and returns focus to the trigger; links close; scroll is restored", () => {
    // Source-level wiring tripwires (real events are exercised on production —
    // no DOM environment exists in this suite).
    expect(menuSrc).toMatch(
      /e\.key === "Escape"[\s\S]{0,120}setOpen\(false\);\s*triggerRef\.current\?\.focus\(\)/,
    );
    expect(menuSrc).toMatch(/onClick=\{\(\) => setOpen\(false\)\}/);
    expect(menuSrc).toMatch(/document\.body\.style\.overflow = "hidden"/);
    expect(menuSrc).toMatch(/document\.body\.style\.overflow = "";/);
  });

  it("language control is text-labelled, 44px, accessible, and offers no Spanish", () => {
    expect(langSrc).toMatch(/العربية/);
    expect(langSrc).toMatch(/English/);
    expect(langSrc).toMatch(/min-h-11/);
    expect(langSrc).toMatch(/aria-label=\{ariaLabel\}/);
    expect(langSrc).not.toMatch(/"es"|Español/);
  });

  it("new header copy exists in both catalogs with no em dash and natural Arabic", () => {
    for (const k of ["home.nav.international", "home.nav.skip", "home.nav.brand_home"] as const) {
      const e = String(en[k as keyof typeof en]);
      const a2 = String(ar[k as keyof typeof ar]);
      expect(e).toBeTruthy();
      expect(a2).toBeTruthy();
      expect(e).not.toContain("—");
      expect(a2).not.toContain("—");
      expect(/[؀-ۿ]/.test(a2), `ar.${k} must carry Arabic script`).toBe(true);
    }
  });
});
