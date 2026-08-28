/**
 * Public product visuals — the homepage hero ("The Living Business Surface",
 * H3.1) and the signup-side composition. Server-rendered illustrations with
 * hard guarantees:
 *  - every referenced i18n key resolves in BOTH locales (no ⟦marker⟧ leaks),
 *  - each visual is ONE labelled conceptual image with decorative internals
 *    hidden from assistive technology,
 *  - honestly badged Illustrative, with a visible caption, and NO invented
 *    business data: no names, counts, amounts, percentages or trust claims,
 *  - RTL-safe (logical classes; operational direction mirrors),
 *  - complete as STATIC markup (no client JS / hydration dependency), and
 *  - hero motion runs ONCE, desktop-only, only under motion-safe.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "@/platform/i18n";
import enCat from "@/platform/i18n/messages/en.json";
import arCat from "@/platform/i18n/messages/ar.json";
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
const productEn = renders["product (en/ltr)"];
const productAr = renders["product (ar/rtl)"];

describe("public product visuals", () => {
  for (const [name, html] of Object.entries(renders)) {
    describe(name, () => {
      it("resolves every i18n key (no fallback marker leaks)", () => {
        expect(html).not.toContain("⟦");
      });

      it("is announced as exactly ONE labelled conceptual image", () => {
        expect((html.match(/role="img"/g) ?? []).length).toBe(1);
        expect(html).toMatch(/aria-label="[^"]+"/);
      });

      it("is honestly badged as illustrative", () => {
        expect(
          html.includes(t("home.viz.illustrative", undefined, "en")) ||
            html.includes(t("auth.viz.illustrative", undefined, "en")) ||
            html.includes("توضيحي"),
        ).toBe(true);
      });

      it("marks its decorative internals aria-hidden", () => {
        expect(html).toContain('aria-hidden="true"');
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

  it("all four renders are non-empty static markup (works with no client JS)", () => {
    for (const html of Object.values(renders)) expect(html.length).toBeGreaterThan(200);
  });
});

// ── H3.1: the Living Business Surface ────────────────────────────────────────
describe("H3.1 hero — the Living Business Surface", () => {
  it("contains no invented business names anywhere (renders or catalogs)", () => {
    for (const html of [productEn, productAr]) {
      expect(html).not.toContain("Rawan");
      expect(html).not.toContain("روان");
      expect(html).not.toMatch(/Bakery/i);
    }
    expect(JSON.stringify(enCat)).not.toContain("Rawan");
    expect(JSON.stringify(arCat)).not.toContain("روان");
  });

  it("contains no invented stage, team or other counts", () => {
    for (const html of [productEn, productAr]) {
      expect(html).not.toMatch(/Stage \d+ of \d+/i);
      expect(html).not.toMatch(/\d+\s*(people|أشخاص)/);
      expect(html).not.toMatch(/المرحلة \d+/);
      // No digits at all in the semantic labels of the hero.
      const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ");
      expect(text).not.toMatch(/\d/);
    }
  });

  it("shows exactly ONE payment outcome (no duplication)", () => {
    const enText = productEn.replace(/<[^>]+>/g, " ");
    expect(enText.match(/Payment/g)?.length).toBe(1);
    expect(enText.match(/Received/g)?.length).toBe(1);
    const arText = productAr.replace(/<[^>]+>/g, " ");
    expect(arText.match(/الدفعة/g)?.length).toBe(1);
    expect(arText.match(/مستلمة/g)?.length).toBe(1);
  });

  it("states the terminology example explicitly, with no bare quoted term", () => {
    const enText = productEn.replace(/<[^>]+>/g, "");
    expect(enText).toContain("Your term: Order");
    const arText = productAr.replace(/<[^>]+>/g, "");
    expect(arText).toContain("مصطلحك: طلبية");
    // The old unexplained treatment is gone.
    expect(productEn).not.toContain("&ldquo;");
    expect(productEn).not.toMatch(/your term(?!:)/i);
  });

  it("has a localized concise aria-label and a visible localized caption", () => {
    expect(productEn).toContain(en("home.viz.aria"));
    expect(productAr).toContain(ar("home.viz.aria"));
    expect(productEn).toContain(en("home.viz.caption"));
    expect(productAr).toContain(ar("home.viz.caption"));
  });

  it("represents the truthful signal set: customer, request, quote, work, team, invoice, payment", () => {
    for (const k of [
      "home.viz.customer",
      "home.viz.request",
      "home.viz.quote",
      "home.viz.term_generic",
      "home.viz.team_assigned",
      "home.viz.approval_ready",
      "home.viz.invoice",
      "home.viz.payment",
    ]) {
      expect(productEn, `missing ${k} (en)`).toContain(en(k));
      expect(productAr, `missing ${k} (ar)`).toContain(ar(k));
    }
  });

  it("makes the separate and connected states structurally identifiable", () => {
    for (const html of [productEn, productAr]) {
      expect(html).toContain('data-state="a"'); // incoming signals
      expect(html).toContain('data-state="b"'); // the settled connected flow
      expect(html).toContain("--lbs-from-x"); // per-object scattered offsets
    }
  });

  it("the final STATIC state carries all essential meaning (no motion required)", () => {
    for (const k of ["home.viz.work_v", "home.viz.quote_accepted", "home.viz.payment_v"]) {
      expect(productEn).toContain(en(k));
    }
    expect(productEn).not.toMatch(/style="[^"]*opacity:\s*0/);
  });

  it("renders no monetary amount and no fake interactive control", () => {
    for (const html of [productEn, productAr]) {
      expect(html).not.toMatch(/\b(AED|USD|SAR|EUR|QAR|KWD|BHD|OMR)\b/);
      expect(html).not.toMatch(/<button|<a |<input|tabindex/i);
    }
  });

  it("introduces no raster, video, canvas, WebGL or animation library", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/app/_home/ProductVisual.tsx", import.meta.url)),
      "utf8",
    );
    for (const bad of ["<img", "<canvas", "<video", "webgl", "three", "framer-motion", "gsap"]) {
      expect(src.toLowerCase()).not.toContain(bad);
    }
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      expect(dep).not.toMatch(/framer|three|gsap|lottie|animejs|motion/);
    }
  });

  it("mirrors the operational direction and pulse under RTL", () => {
    expect(productEn).toMatch(/data-dir="ltr"/);
    expect(productAr).toMatch(/data-dir="rtl"/);
    expect(productAr).toContain("scaleX(-1)");
    expect(productEn).not.toContain("scaleX(-1)");
  });

  it("mobile gets the simplified static composition; the surface plane is desktop-only", () => {
    expect((productEn.match(/hidden lg:flex/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(productEn).toContain("lg:hidden"); // the mobile vertical spine stubs
    expect(productEn).toContain("hidden lg:block"); // the perspective surface
  });

  it("hero copy exists in both catalogs, natural Arabic, no em dash; retired keys stay retired", () => {
    const vizKeys = Object.keys(enCat).filter((k) => k.startsWith("home.viz."));
    expect(vizKeys.length).toBeGreaterThan(12);
    for (const k of vizKeys) {
      const e = String(enCat[k as keyof typeof enCat]);
      const a = String(arCat[k as keyof typeof arCat]);
      expect(a, `ar missing ${k}`).toBeTruthy();
      expect(e).not.toContain("—");
      expect(a).not.toContain("—");
    }
    for (const k of ["home.viz.caption", "home.viz.aria", "home.viz.team_assigned"]) {
      expect(/[؀-ۿ]/.test(String(arCat[k as keyof typeof arCat]))).toBe(true);
    }
    for (const k of [
      "home.viz.customer_v",
      "home.viz.work_stage",
      "home.viz.team_v",
      "home.viz.status",
      "home.viz.term_hint",
      "home.viz.total",
    ]) {
      expect(k in enCat).toBe(false);
      expect(k in arCat).toBe(false);
    }
  });
});

// ── Motion: once-only, desktop-only, motion-safe-only ────────────────────────
describe("hero motion rules", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../../src/app/globals.css", import.meta.url)),
    "utf8",
  );
  const guard = "@media (prefers-reduced-motion: no-preference)";
  const guardAt = css.indexOf(guard);
  // The hero block runs from its header comment to the (out-of-scope) signup
  // visual's rules that follow it in the same motion-safe media query.
  const lbsBlock = css.slice(
    css.indexOf("The Living Business Surface hero (H3.1)"),
    css.indexOf("Signup visual"),
  );

  it("defines .lbs-* only inside the motion-safe block, nested behind a desktop width gate", () => {
    expect(guardAt).toBeGreaterThan(-1);
    const widthGateAt = css.indexOf("@media (min-width: 1024px)", guardAt);
    expect(widthGateAt).toBeGreaterThan(guardAt);
    for (const rule of [".lbs-settle", ".lbs-link", ".lbs-pulse"]) {
      expect(css.includes(rule), `${rule} missing`).toBe(true);
      expect(css.indexOf(rule)).toBeGreaterThan(widthGateAt);
    }
    expect(css.slice(0, guardAt)).not.toMatch(/\.lbs-|lbs-settle-in|lbs-pulse-run|lbs-link-in/);
  });

  it("hero motion never loops: no infinite iteration anywhere in the hero rules", () => {
    expect(lbsBlock.length).toBeGreaterThan(100);
    expect(lbsBlock).not.toContain("infinite");
    expect(lbsBlock).toMatch(/lbs-settle-in[^;]*\)\s*1 both/);
    expect(lbsBlock).toMatch(/lbs-link-in[^;]*\s1 both/);
    expect(lbsBlock).toMatch(/lbs-pulse-run[^;]*\s1 both/);
  });

  it("animates transform and opacity only (no layout, inset or box-shadow motion)", () => {
    const segments = lbsBlock.split("@keyframes").slice(1);
    expect(segments.length).toBe(4); // settle-in, link-in, pulse-run, pulse-run-rtl
    for (const seg of segments) {
      expect(seg).not.toMatch(/box-shadow|inset|margin|padding|top:|left:|right:|width:|height:/);
    }
  });

  it("the RTL pulse travels the opposite direction", () => {
    expect(css).toMatch(/lbs-pulse-run-rtl/);
    expect(css).toMatch(/translateX\(42px\)/);
    expect(css).toMatch(/translateX\(-42px\)/);
  });

  it("the old hero animation sets are gone; the signup core stays guarded", () => {
    expect(css).not.toContain(".icv-");
    expect(css).not.toContain(".los-pulse");
    expect(css).not.toContain(".los-cta");
    expect(css.indexOf(".los-core")).toBeGreaterThan(guardAt);
  });
});
