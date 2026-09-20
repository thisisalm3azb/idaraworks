/**
 * Homepage launch-quality contracts:
 *  - the public canonical origin is the custom domain everywhere (page
 *    metadata, robots, sitemap, the auth-callback fallback, the structured
 *    data), with no stale Vercel-domain or localhost reference,
 *  - the hero scene reserves its space and is clipped by its own box so the
 *    RTL mirror can never create horizontal scroll,
 *  - the social preview is a real image route on this origin,
 *  - the page's fonts are self-hosted through next/font (no font host),
 *  - the structured data states only verified facts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import { JsonLd } from "@/app/_home/JsonLd";
import { pricingTiers } from "@/app/_home/pricing";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const pageSrc = read("../../src/app/page.tsx");
const robotsSrc = read("../../src/app/robots.ts");
const sitemapSrc = read("../../src/app/sitemap.ts");
const callbackSrc = read("../../src/platform/auth/callback.ts");
const homeSrc = read("../../src/app/_home/HomePage.tsx");
const heroSrc = read("../../src/app/_home/Hero.tsx");
const fontsSrc = read("../../src/app/_home/fonts.ts");
const cssSrc = read("../../src/app/_home/home.css");
const ogSrc = read("../../src/app/opengraph-image.tsx");

const CUSTOM = "https://www.idaraworks.com";

describe("canonical origin", () => {
  it("page metadata, robots, sitemap and the homepage use the custom domain", () => {
    for (const [name, src] of [
      ["page", pageSrc],
      ["robots", robotsSrc],
      ["sitemap", sitemapSrc],
      ["home", homeSrc],
    ] as const) {
      expect(src, `${name} must use the custom domain`).toContain(CUSTOM);
      expect(src, `${name} still references the Vercel domain`).not.toContain(
        "idaraworks.vercel.app",
      );
      expect(src, `${name} references localhost`).not.toMatch(/localhost/);
    }
  });

  it("the auth-callback production fallback is the custom domain", () => {
    expect(callbackSrc).toContain(`const CANONICAL_PROD_ORIGIN = "${CUSTOM}"`);
    expect(callbackSrc).not.toContain("idaraworks.vercel.app");
  });

  it("the social preview is generated on this origin with a large-image card", () => {
    expect(pageSrc).toMatch(/card: "summary_large_image"/);
    expect(ogSrc).toMatch(/size = \{ width: 1200, height: 630 \}/);
    expect(ogSrc).toMatch(/public", "fonts"/);
    expect(ogSrc).not.toMatch(/https?:\/\//);
  });
});

describe("layout integrity", () => {
  it("the hero scene is a single positioned box with its illustrations inside it", () => {
    // The scene wrapper is `relative` and the window clips its own overflow;
    // the phone and receipt are absolutely positioned INSIDE the wrapper.
    expect(heroSrc).toMatch(/className="relative mx-auto w-full max-w-\[40rem\]/);
    expect(heroSrc).toMatch(/mk-window-3d relative overflow-hidden/);
    expect((heroSrc.match(/absolute bottom-/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("the main landmark is focusable for the skip link and the page mirrors by dir", () => {
    expect(homeSrc).toMatch(/<main id="main" tabIndex=\{-1\}/);
    expect(homeSrc).toMatch(/dir=\{dir\}/);
  });

  it("motion is opt-in: every animation sits under prefers-reduced-motion: no-preference", () => {
    const blocks = cssSrc.split("@media");
    for (const block of blocks) {
      if (/@keyframes|animation:|transition:/.test(block)) {
        expect(block, "animation outside a motion-safe block").toMatch(
          /prefers-reduced-motion: no-preference/,
        );
      }
    }
  });
});

describe("fonts", () => {
  it("Space Grotesk and Noto Sans Arabic come through next/font (self-hosted), never a font host", () => {
    expect(fontsSrc).toMatch(/from "next\/font\/google"/);
    expect(fontsSrc).toMatch(/Space_Grotesk\(/);
    expect(fontsSrc).toMatch(/Noto_Sans_Arabic\(/);
    expect(cssSrc).not.toMatch(/fonts\.googleapis|@import url/);
    expect(cssSrc).toMatch(/var\(--font-space-grotesk\), var\(--font-noto-arabic\)/);
  });
});

describe("structured data", () => {
  it("carries only verified facts: names, canonical URL, languages and the free plan's price", () => {
    const html = renderToStaticMarkup(
      h(JsonLd, { canonical: CUSTOM, languages: ["en", "ar"], freePriceUsd: 0 }),
    );
    const json = html.replace(/^.*?>/, "").replace(/<\/script>$/, "");
    const data = JSON.parse(json) as Array<Record<string, unknown>>;
    expect(data.map((d) => d["@type"])).toEqual(["Organization", "WebSite", "SoftwareApplication"]);
    expect(JSON.stringify(data)).not.toMatch(/aggregateRating|review|award|ratingValue/i);
    expect(JSON.stringify(data)).toContain(CUSTOM);
    expect(pricingTiers()[0]!.price.monthlyUsd).toBe(0);
  });
});

describe("copy contracts", () => {
  it("the headline is the approved direction", () => {
    expect(String(en["home.hero.title" as keyof typeof en])).toBe(
      "Run the business.|Not after it.",
    );
    expect(String(en["home.nav.get_started" as keyof typeof en])).toBe("Start free");
  });

  it("the metadata title carries the same direction and no stale product framing", () => {
    expect(String(en["home.meta.title" as keyof typeof en])).toMatch(/run the business/i);
    expect(String(en["home.meta.description" as keyof typeof en])).toMatch(/30 days free/);
  });
});
