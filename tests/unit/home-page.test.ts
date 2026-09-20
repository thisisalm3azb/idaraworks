/**
 * The public homepage: routing/CTA contract, catalogue parity for its copy,
 * RTL and physical-class safety, mobile-menu accessibility, and no
 * unsupported claims (customer counts, certifications, testimonials, AI,
 * compliance) anywhere in the marketing copy. The page and its sections are
 * server components; the interactive demo and the mobile menu are the client
 * islands (the demo's rules are pinned in home-try-it.test.ts).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import es from "@/platform/i18n/messages/es.json";
import { t } from "@/platform/i18n";
import { homeNav, ANCHORS, SIGNUP_HREF, LOGIN_HREF } from "@/app/_home/nav";

const tFake = (k: string) => k; // identity translator — we assert on keys/hrefs
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => "/",
}));

/** The public-homepage namespaces (home.brief/action/chip/attention/setup/map
 * are the owner-dashboard keys, governed by their own suites). */
const MARKETING = Object.keys(en).filter((k) =>
  /^home\.(meta|nav|hero|strip|q|demo|platform|app|start|plans|pricing|faq|trial|footer)\./.test(k),
);

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l(?!g)|rounded-r|float-(left|right))\b/;

describe("homepage i18n content", () => {
  it("every marketing key exists in all three catalogues (parity)", () => {
    for (const k of MARKETING) {
      expect(ar[k as keyof typeof ar], `ar missing ${k}`).toBeTruthy();
      expect(es[k as keyof typeof es], `es missing ${k}`).toBeTruthy();
    }
    for (const k of Object.keys(ar).filter((x) => x.startsWith("home."))) {
      expect(en[k as keyof typeof en], `en missing ${k}`).toBeTruthy();
    }
  });

  it("Arabic homepage copy carries Arabic script wherever English has words", () => {
    for (const k of MARKETING) {
      const source = String(en[k as keyof typeof en]);
      // Codes, numbers and the bare brand carry no language to translate.
      if (!/[A-Za-z]{3,}/.test(source.replace(/\{[a-z_]+\}/g, "").replace(/IdaraWorks/g, "")))
        continue;
      if (
        /^(Sidra Farms|Oasis Market|Palm Properties|Northstar Studio|Atlas Engineering)$/.test(
          source,
        )
      )
        continue;
      const v = String(ar[k as keyof typeof ar]);
      expect(/[؀-ۿ]/.test(v), `ar.${k} has no Arabic script: "${v}"`).toBe(true);
    }
  });

  it("makes no unsupported customer-count, compliance, rating, AI or urgency claims", () => {
    const BANNED =
      /\b(trusted by|customers worldwide|\d+[\d,]*\+? (customers|businesses|users|companies)|certified|compliant|ISO|SOC ?2|GDPR|guarantee[ds]?|award|rated|reviews|testimonial|AI|artificial intelligence|e-invoic|only \d+ left|limited time|hurry|countdown|migrat)/i;
    for (const k of MARKETING) {
      const v = String(en[k as keyof typeof en]);
      expect(BANNED.test(v), `${k} makes an unsupported claim: "${v}"`).toBe(false);
    }
  });

  it("names only the shipped languages and no em dash in any language", () => {
    for (const k of MARKETING) {
      for (const cat of [en, ar, es] as const) {
        const v = String(cat[k as keyof typeof cat] ?? "");
        expect(v, `${k}`).not.toContain("—");
      }
      expect(String(en[k as keyof typeof en])).not.toMatch(/spanish/i);
    }
  });

  it("states the trial exactly as the product implements it", () => {
    // 30 days, no card, then the Free plan with data kept (0139 + TRIAL_LANDING_PLAN).
    const blob = MARKETING.map((k) =>
      t(
        k,
        {
          languages_or: "English or Arabic",
          languages: "English and Arabic",
          job: "job",
          n: 1,
          name: "x",
          amount: "$1",
          billed: "$1",
          customer: "c",
          value: "1",
          work: "w",
          detail: "d",
          resource: "r",
          resource_text: "s",
          year: "2026",
        },
        "en",
      ),
    ).join("\n");
    expect(blob).toMatch(/30 days free/);
    expect(blob).toMatch(/No credit card/);
    expect(blob).toMatch(/moves to the Free plan and keeps its data/);
    expect(blob).not.toMatch(/\b(14|60|90) days\b/);
  });
});

describe("routing / CTA contract", () => {
  it("signed-out: Start free → registration, Log in → /login, sections anchor on-page", () => {
    const { authed, primary, secondary, sections } = homeNav(tFake, null);
    expect(authed).toBe(false);
    expect(primary).toEqual({ href: SIGNUP_HREF, label: "home.nav.get_started" });
    expect(primary.href).toBe("/signup");
    expect(secondary).toEqual({ href: LOGIN_HREF, label: "home.nav.login" });
    expect(sections.map((s) => s.href)).toEqual([
      ANCHORS.platform,
      ANCHORS.demo,
      ANCHORS.app,
      ANCHORS.trial,
    ]);
  });

  it("authenticated: Open workspace → resolved landing, and NO log-in action", () => {
    const { authed, primary, secondary } = homeNav(tFake, "/o/abc-123");
    expect(authed).toBe(true);
    expect(primary).toEqual({ href: "/o/abc-123", label: "home.nav.open_workspace" });
    expect(secondary).toBeNull();
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

  it("every navigated anchor is a section on the page with the sticky offset", () => {
    const sources = [
      "HomePage",
      "PlatformDepth",
      "CompanyApp",
      "Start",
      "Plans",
      "Faq",
      "FinalTrial",
    ]
      .map((f) => read(`../../src/app/_home/${f}.tsx`))
      .join("\n");
    for (const anchor of Object.values(ANCHORS)) {
      const id = anchor.slice(1);
      expect(sources, `#${id} missing`).toMatch(
        new RegExp(
          `id="${id}"[^>]*className="[^"]*scroll-mt-20|className="[^"]*scroll-mt-20[^"]*"[^>]*id="${id}"`,
        ),
      );
    }
  });
});

describe("no local-prototype leftovers", () => {
  const sources = [
    "HomePage",
    "Hero",
    "Questions",
    "TryIt",
    "PlatformDepth",
    "CompanyApp",
    "Start",
    "Plans",
    "Faq",
    "FinalTrial",
    "Frame",
  ].map((f) => read(`../../src/app/_home/${f}.tsx`));

  it("no design-concept dialog, no external link to the live site, no localhost", () => {
    for (const src of sources) {
      expect(src).not.toMatch(
        /<dialog|showModal|Local design concept|localhost|Not the live website/,
      );
      expect(src).not.toMatch(/https:\/\/www\.idaraworks\.com\/(login|signup)/);
    }
  });

  it("the demo keeps its state in the page: no fetch, storage or form submission", () => {
    const demo = read("../../src/app/_home/TryIt.tsx");
    expect(demo).not.toMatch(
      /fetch\(|localStorage|sessionStorage|<form|navigator\.sendBeacon|XMLHttpRequest/,
    );
    expect(demo).not.toMatch(/dangerouslySetInnerHTML/);
    expect(demo).toMatch(/useState/);
  });

  it("uses no physical-direction classes (mirrors under RTL)", () => {
    for (const src of sources) {
      const classes = [...src.matchAll(/className=["`]([^"`]*)["`]/g)].map((m) => m[1]).join(" ");
      expect(PHYSICAL.test(classes), classes.match(PHYSICAL)?.[0]).toBe(false);
    }
  });

  it("no real tenant's name appears in the sample content", () => {
    for (const k of MARKETING) {
      for (const cat of [en, ar, es] as const) {
        expect(String(cat[k as keyof typeof cat] ?? "")).not.toMatch(
          /Liwa ?Harvest|Rimal|ليوا|رمال/,
        );
      }
    }
  });
});

describe("MobileMenu accessibility + RTL safety", async () => {
  const { MobileMenu } = await import("@/app/_home/MobileMenu");
  const html = renderToStaticMarkup(
    h(MobileMenu, {
      links: [
        { href: "#platform", label: "المنصة" },
        { href: "#trial", label: "تجربة مجانية" },
      ],
      primary: { href: "/signup", label: "ابدأ مجاناً" },
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
