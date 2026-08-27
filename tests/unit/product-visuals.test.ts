/**
 * 005B.1 — the public product visuals ("The Living Operations System"): the
 * homepage hero (ProductVisual) and the signup-side composition (AuthVisual).
 *
 * These are decorative, server-rendered illustrations. The guarantees a visual
 * must hold to ship on public pages:
 *  - every referenced i18n key resolves in BOTH locales (no ⟦marker⟧ leaks),
 *  - it is announced as ONE image with an aria-label and its internals are
 *    aria-hidden (a screen reader hears a description, not a soup of fragments),
 *  - it is honestly badged "Illustrative" — no demo value is passed off as real,
 *  - it carries no fabricated metric (percentage KPI) or trust/rating claim,
 *  - it uses only logical (RTL-safe) direction classes, in EN and in RTL,
 *  - it renders fully as STATIC markup (works with no client JS), and
 *  - its one motion lives only under prefers-reduced-motion: no-preference.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "@/platform/i18n";
import { ProductVisual } from "@/app/_home/ProductVisual";
import { AuthVisual } from "@/app/(auth)/signup/AuthVisual";

const en = (k: string) => t(k, undefined, "en");
const ar = (k: string) => t(k, undefined, "ar");

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l(?!g)|rounded-r|float-(left|right))\b/;
const CLAIM = /\b(trusted by|rated|reviews?|★|guarantee|certified|\d+%)\b/i;

const renders = {
  "product (en/ltr)": renderToStaticMarkup(h(ProductVisual, { t: en, dir: "ltr" })),
  "product (ar/rtl)": renderToStaticMarkup(h(ProductVisual, { t: ar, dir: "rtl" })),
  "auth (en)": renderToStaticMarkup(h(AuthVisual, { t: en })),
  "auth (ar)": renderToStaticMarkup(h(AuthVisual, { t: ar })),
};

describe("public product visuals", () => {
  for (const [name, html] of Object.entries(renders)) {
    describe(name, () => {
      it("resolves every i18n key (no fallback marker leaks)", () => {
        expect(html).not.toContain("⟦");
      });

      it("is announced as one labelled image", () => {
        expect(html).toMatch(/role="img"/);
        expect(html).toMatch(/aria-label="[^"]+"/);
      });

      it("is honestly badged as illustrative", () => {
        // The demo customer/amount are visibly labelled, never presented as real.
        expect(
          html.includes(t("home.viz.illustrative", undefined, "en")) ||
            html.includes(t("auth.viz.illustrative", undefined, "en")) ||
            html.includes("توضيحي"),
        ).toBe(true);
      });

      it("marks its decorative internals aria-hidden", () => {
        expect(html).toContain('aria-hidden="true"');
        // No inner SVG advertises itself to the a11y tree.
        expect(html).not.toMatch(/<svg[^>]*aria-label=/);
      });

      it("makes no fabricated metric or trust/rating claim", () => {
        expect(CLAIM.test(html), html.match(CLAIM)?.[0]).toBe(false);
      });

      it("uses only logical (RTL-safe) direction classes", () => {
        const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
        expect(PHYSICAL.test(classes), classes).toBe(false);
      });
    });
  }

  it("the homepage flow pulse is direction-aware (mirrors under RTL)", () => {
    expect(renders["product (en/ltr)"]).toMatch(/data-dir="ltr"/);
    expect(renders["product (ar/rtl)"]).toMatch(/data-dir="rtl"/);
  });

  it("all four renders are non-empty static markup (works with no client JS)", () => {
    for (const html of Object.values(renders)) expect(html.length).toBeGreaterThan(200);
  });
});

describe("public product visuals — motion is reduced-motion gated", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../../src/app/globals.css", import.meta.url)),
    "utf8",
  );
  const guard = "@media (prefers-reduced-motion: no-preference)";

  it("defines every .los-* animated rule only inside the motion-safe block", () => {
    const at = css.indexOf(guard);
    expect(at).toBeGreaterThan(-1);
    for (const rule of [".los-pulse", ".los-cta", ".los-core"]) {
      // Present, and its first (only) definition is after the motion-safe guard.
      expect(css.includes(rule), `${rule} missing`).toBe(true);
      expect(css.indexOf(rule)).toBeGreaterThan(at);
    }
    // No stray animation:/keyframes for these outside the guarded block.
    expect(css.slice(0, at)).not.toMatch(/\.los-|los-pulse-flow|los-cta-pulse|los-core-pulse/);
  });
});
