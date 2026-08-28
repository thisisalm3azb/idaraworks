/**
 * H10 — homepage launch-quality contracts. Pins the defects corrected by the
 * launch audit so they cannot regress:
 *  - the public canonical origin is the custom domain everywhere (page
 *    metadata, robots, sitemap, and the auth-callback fallback), with no
 *    stale Vercel-domain or localhost reference in public metadata,
 *  - the hero's motion-only pulse is clipped by its wrapper (the RTL mirror
 *    once pushed it outside the viewport at 1024px and created horizontal
 *    scroll),
 *  - every section anchor targeted by navigation and footer exists with the
 *    sticky-header offset,
 *  - homepage catalogs stay em-dash free and the public journey's key claims
 *    hold (spot contracts; the per-section suites carry the detail).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const pageSrc = read("../../src/app/page.tsx");
const robotsSrc = read("../../src/app/robots.ts");
const sitemapSrc = read("../../src/app/sitemap.ts");
const callbackSrc = read("../../src/platform/auth/callback.ts");
const homeSrc = read("../../src/app/_home/HomePage.tsx");
const heroSrc = read("../../src/app/_home/ProductVisual.tsx");

const CUSTOM = "https://www.idaraworks.com";

describe("H10 — canonical origin", () => {
  it("page metadata, robots and sitemap use the custom domain", () => {
    for (const [name, src] of [
      ["page", pageSrc],
      ["robots", robotsSrc],
      ["sitemap", sitemapSrc],
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
});

describe("H10 — layout integrity", () => {
  it("the hero's motion wrapper clips its pulse (RTL 1024 overflow fix)", () => {
    expect(heroSrc).toMatch(/lcs-form[^"]*overflow-hidden/);
  });

  it("every navigated anchor exists with the sticky offset", () => {
    for (const id of ["how", "product", "international", "trust", "pricing"]) {
      expect(homeSrc, `#${id} missing`).toMatch(
        new RegExp(`<section id="${id}" className="[^"]*scroll-mt-16`),
      );
    }
    expect(homeSrc).toMatch(/<main id="main" tabIndex=\{-1\}/);
  });
});

describe("H10 — homepage copy contracts", () => {
  // The PUBLIC homepage namespaces only — home.brief/action/chip/attention/
  // setup/map are the authenticated owner-dashboard keys (002B) and are
  // governed by their own suites.
  const homeKeys = Object.keys(en).filter((k) =>
    /^home.(meta|nav|hero|agents|viz|flow|built|os|gcc|trust|pricing|close|footer)\./.test(k),
  );

  it("homepage catalogs carry no em dash in either language", () => {
    for (const k of homeKeys) {
      expect(String(en[k as keyof typeof en]), `en.${k}`).not.toContain("—");
      expect(String(ar[k as keyof typeof ar] ?? ""), `ar.${k}`).not.toContain("—");
    }
  });

  it("no unshipped language is named anywhere in homepage copy (H13)", () => {
    const blob = homeKeys
      .map((k) => `${en[k as keyof typeof en]} ${ar[k as keyof typeof ar] ?? ""}`)
      .join(" ");
    expect(blob).not.toMatch(/spanish|الإسبانية/i);
  });

  it("the public journey keeps one consistent primary CTA wording", () => {
    expect(String(en["home.nav.get_started" as keyof typeof en])).toBe("Get Started");
    // Header, hero, pricing plans and footer all draw the primary label from
    // the same routing contract (the closing section deliberately uses the
    // clearer "Build my workspace" for signed-out visitors).
    expect((homeSrc.match(/primary\.label/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
