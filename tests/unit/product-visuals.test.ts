/**
 * Public product visuals — the homepage hero ("A workspace that takes shape",
 * H3) and the signup-side composition. Server-rendered illustrations with hard
 * guarantees:
 *  - every referenced i18n key resolves in BOTH locales (no ⟦marker⟧ leaks),
 *  - each visual is ONE labelled conceptual image with decorative internals
 *    hidden from assistive technology,
 *  - honestly badged Illustrative, with a visible caption, no fabricated
 *    metric, precise money amount, or trust claim,
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

// ── H3: the Intelligent Clay hero — "a workspace that takes shape" ───────────
describe("H3 hero — a workspace that takes shape", () => {
  it("has a localized concise aria-label describing the shaping concept", () => {
    expect(productEn).toContain(en("home.viz.aria"));
    expect(productAr).toContain(ar("home.viz.aria"));
  });

  it("shows a visible localized caption stating the concept", () => {
    expect(productEn).toContain(en("home.viz.caption"));
    expect(productAr).toContain(ar("home.viz.caption"));
  });

  it("represents customer, work, team, approval, document/invoice and cash", () => {
    for (const k of [
      "home.viz.customer",
      "home.viz.term_generic", // the work object
      "home.viz.team",
      "home.viz.approval",
      "home.viz.invoice", // the document the work becomes
      "home.viz.payment", // the cash outcome
    ]) {
      expect(productEn, `missing ${k} (en)`).toContain(en(k));
      expect(productAr, `missing ${k} (ar)`).toContain(ar(k));
    }
  });

  it("makes State A and State B structurally identifiable in the markup", () => {
    for (const html of [productEn, productAr]) {
      expect(html).toContain('data-state="a"');
      expect(html).toContain('data-state="b"');
    }
  });

  it("the final STATIC state carries all essential meaning (no motion required)", () => {
    // Everything State B adds is present in the server-rendered markup itself:
    // stage progression, team, approval, invoice, terminology, caption.
    for (const k of ["home.viz.work_stage", "home.viz.quote_accepted", "home.viz.status"]) {
      expect(productEn).toContain(en(k));
    }
    // Nothing is hidden behind an inline opacity style awaiting JS.
    expect(productEn).not.toMatch(/style="[^"]*opacity:\s*0/);
  });

  it("shows the terminology-shaping example (the business's own word)", () => {
    expect(productEn).toContain(en("home.viz.term_custom"));
    expect(productEn).toContain(en("home.viz.term_hint"));
    expect(productAr).toContain(ar("home.viz.term_custom"));
    expect(productAr).toContain(ar("home.viz.term_hint"));
  });

  it("renders no precise monetary amount (cash is qualitative)", () => {
    for (const html of [productEn, productAr]) {
      expect(html).not.toMatch(/\b(AED|USD|SAR|EUR|QAR|KWD|BHD|OMR)\b/);
      expect(html).not.toMatch(/\d{1,3},\d{3}/);
    }
  });

  it("contains no fake interactive control and no focusable decoration", () => {
    for (const html of [productEn, productAr]) {
      expect(html).not.toMatch(/<button|<a |<input|tabindex/i);
    }
  });

  it("introduces no external image, video, canvas or WebGL", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/app/_home/ProductVisual.tsx", import.meta.url)),
      "utf8",
    );
    for (const bad of ["<img", "<canvas", "<video", "webgl", "three", "framer-motion"]) {
      expect(src.toLowerCase()).not.toContain(bad);
    }
    for (const html of [productEn, productAr]) {
      expect(html).not.toMatch(/<img|<canvas|<video/i);
    }
  });

  it("mirrors the operational direction and pulse under RTL", () => {
    expect(productEn).toMatch(/data-dir="ltr"/);
    expect(productAr).toMatch(/data-dir="rtl"/);
    // The forward chevron flips in RTL.
    expect(productAr).toContain("scaleX(-1)");
    expect(productEn).not.toContain("scaleX(-1)");
  });

  it("simplifies on mobile: secondary nodes hide, the vertical spine shows", () => {
    // Quote + invoice step back on small screens; customer → work → cash stays.
    expect((productEn.match(/hidden lg:flex/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(productEn).toContain("lg:hidden"); // the mobile vertical spine stubs
  });

  it("no longer uses the old infinite los-pulse / los-cta treatment", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/app/_home/ProductVisual.tsx", import.meta.url)),
      "utf8",
    );
    expect(src).not.toContain("los-");
    expect(productEn).not.toContain("los-");
  });

  it("new hero copy exists in both catalogs, is natural Arabic, and has no em dash", () => {
    const vizKeys = Object.keys(enCat).filter((k) => k.startsWith("home.viz."));
    expect(vizKeys.length).toBeGreaterThan(15);
    for (const k of vizKeys) {
      const e = String(enCat[k as keyof typeof enCat]);
      const a = String(arCat[k as keyof typeof arCat]);
      expect(a, `ar missing ${k}`).toBeTruthy();
      expect(e).not.toContain("—");
      expect(a).not.toContain("—");
    }
    // Arabic prose keys carry Arabic script (demo values/digits excluded).
    for (const k of ["home.viz.caption", "home.viz.aria", "home.viz.term_custom"]) {
      expect(/[؀-ۿ]/.test(String(arCat[k as keyof typeof arCat]))).toBe(true);
    }
    // The retired keys stay retired.
    for (const k of ["home.viz.total", "home.viz.materials_v", "home.viz.next_action"]) {
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

  it("defines .icv-* only inside the motion-safe block, nested behind a desktop width gate", () => {
    expect(guardAt).toBeGreaterThan(-1);
    const widthGateAt = css.indexOf("@media (min-width: 1024px)", guardAt);
    expect(widthGateAt).toBeGreaterThan(guardAt);
    for (const rule of [".icv-shape", ".icv-pulse"]) {
      expect(css.includes(rule), `${rule} missing`).toBe(true);
      expect(css.indexOf(rule)).toBeGreaterThan(widthGateAt);
    }
    expect(css.slice(0, guardAt)).not.toMatch(/\.icv-|icv-shape-in|icv-pulse-run/);
  });

  // The icv block runs from its header comment to the (out-of-scope) signup
  // visual's rules that follow it in the same motion-safe media query.
  const icvBlock = css.slice(
    css.indexOf("Intelligent Clay hero (H3)"),
    css.indexOf("Signup visual"),
  );

  it("hero motion never loops: no infinite iteration anywhere in the icv rules", () => {
    expect(icvBlock.length).toBeGreaterThan(100);
    expect(icvBlock).not.toContain("infinite");
    // Explicit single iteration + settle-and-stop fill behaviour.
    expect(icvBlock).toMatch(/icv-shape-in[^;]*\)\s*1 both/);
    expect(icvBlock).toMatch(/icv-pulse-run[^;]*\s1 both/);
  });

  it("animates transform and opacity only (no layout, inset or box-shadow motion)", () => {
    const segments = icvBlock.split("@keyframes").slice(1); // keyframe bodies + trailing rules
    expect(segments.length).toBe(3); // shape-in, pulse-run, pulse-run-rtl
    for (const seg of segments) {
      // Everything after the first @keyframes sits past the min-width media
      // gate, so any width/inset/etc. here would be a real animated property.
      expect(seg).not.toMatch(/box-shadow|inset|margin|padding|top:|left:|right:|width:|height:/);
    }
  });

  it("the RTL pulse travels the opposite direction", () => {
    expect(css).toMatch(/icv-pulse-run-rtl/);
    expect(css).toMatch(/translateX\(50px\)/);
    expect(css).toMatch(/translateX\(-50px\)/);
  });

  it("the old infinite hero animations are gone; the signup core stays guarded", () => {
    expect(css).not.toContain(".los-pulse");
    expect(css).not.toContain(".los-cta");
    // The signup visual's motion (out of H3 scope) remains motion-safe-gated.
    expect(css.indexOf(".los-core")).toBeGreaterThan(guardAt);
  });
});
