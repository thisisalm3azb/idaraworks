/**
 * Public product visuals — the homepage hero ("The Living Control Surface",
 * H3.3B) and the signup-side composition. Server-rendered illustrations with
 * hard guarantees:
 *  - every referenced i18n key resolves in BOTH locales (no ⟦marker⟧ leaks),
 *  - each visual is ONE labelled conceptual image with decorative internals
 *    hidden from assistive technology,
 *  - honestly badged Illustrative, with a visible caption, and NO invented
 *    business data: no names, counts, amounts, percentages or trust claims,
 *  - RTL-safe (logical classes; the carved operational path mirrors),
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

// ── H3.3B: the Living Control Surface ────────────────────────────────────────
describe("H3.3B hero — the Living Control Surface", () => {
  const heroSrc = readFileSync(
    fileURLToPath(new URL("../../src/app/_home/ProductVisual.tsx", import.meta.url)),
    "utf8",
  );
  const css = readFileSync(
    fileURLToPath(new URL("../../src/app/globals.css", import.meta.url)),
    "utf8",
  );

  it("retires the H3.2 tilted plane, recessed rail and connector row for good", () => {
    for (const gone of ["rotateX(", "perspective", "lbs-", "data-dir="]) {
      expect(heroSrc, `source still contains ${gone}`).not.toContain(gone);
    }
    expect(css).not.toContain("lbs-");
    for (const html of [productEn, productAr]) {
      expect(html).not.toContain("lbs-");
    }
  });

  it("renders ONE molded surface holding every formed zone", () => {
    for (const html of [productEn, productAr]) {
      expect((html.match(/data-lcs="surface"/g) ?? []).length).toBe(1);
      // Zones formed from the surface: signals, quote+invoice, work, payment.
      expect((html.match(/data-lcs="signal"/g) ?? []).length).toBe(2);
      expect((html.match(/data-lcs="formed"/g) ?? []).length).toBe(2);
      expect((html.match(/data-lcs="work"/g) ?? []).length).toBe(1);
      expect((html.match(/data-lcs="payment"/g) ?? []).length).toBe(1);
    }
  });

  it("carves ONE continuous operational path (a single uninterrupted curve)", () => {
    for (const html of [productEn, productAr]) {
      const accents = [...html.matchAll(/data-lcs="carve"[^>]*\sd="([^"]+)"/g)];
      expect(accents.length).toBe(1);
      const d = accents[0]?.[1] ?? "";
      // One subpath only: exactly one M command, no path restarts.
      expect(d.trim().startsWith("M ")).toBe(true);
      expect((d.match(/M /g) ?? []).length).toBe(1);
    }
  });

  it("mirrors the carved path (and only the path wrapper) under RTL", () => {
    expect(productAr).toContain("scaleX(-1)");
    expect(productEn).not.toContain("scaleX(-1)");
    // Zones mirror through logical positions; the canvas flips its scale
    // origin so the fitted composition stays anchored in both directions.
    expect(productEn).toContain("origin-top-left");
    expect(productEn).toContain("rtl:lg:origin-top-right");
  });

  it("represents the truthful operational concepts, and nothing else", () => {
    for (const k of [
      "home.viz.customer",
      "home.viz.request",
      "home.viz.quote",
      "home.viz.quote_accepted",
      "home.viz.term_generic",
      "home.viz.work_v",
      "home.viz.team_assigned",
      "home.viz.approval_ready",
      "home.viz.term_note",
      "home.viz.dock",
      "home.viz.invoice",
      "home.viz.invoice_v",
      "home.viz.payment",
      "home.viz.payment_v",
    ]) {
      expect(productEn, `missing ${k} (en)`).toContain(en(k));
      expect(productAr, `missing ${k} (ar)`).toContain(ar(k));
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

  it("contains no invented names, numbers, dates or metrics in semantic text", () => {
    for (const html of [productEn, productAr]) {
      expect(html).not.toContain("Rawan");
      expect(html).not.toContain("روان");
      expect(html).not.toMatch(/Bakery/i);
      expect(html).not.toMatch(/Stage \d+ of \d+/i);
      const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ");
      expect(text).not.toMatch(/\d/);
      expect(html).not.toMatch(/\b(AED|USD|SAR|EUR|QAR|KWD|BHD|OMR)\b/);
    }
    expect(JSON.stringify(enCat)).not.toContain("Rawan");
    expect(JSON.stringify(arCat)).not.toContain("روان");
  });

  it("states terminology flexibility as identity, and retired wording stays retired", () => {
    const enText = productEn.replace(/<[^>]+>/g, "");
    expect(enText).toContain("Called Order in your workspace");
    const arText = productAr.replace(/<[^>]+>/g, "");
    expect(arText).toContain("يُسمّى طلبية في مساحة عملك");
    expect(productEn).not.toContain("&ldquo;");
    expect(enText).not.toContain("Your term");
    expect(arText).not.toContain("مصطلحك:");
  });

  it("offers recessed capability sockets with meaningful localized wording, once", () => {
    const enText = productEn.replace(/<[^>]+>/g, "");
    expect(enText).toContain("Space for what you need");
    const arText = productAr.replace(/<[^>]+>/g, "");
    expect(arText).toContain("مساحة لما تحتاجه");
    // ONE shared labelled socket across desktop and mobile, plus one small
    // unlabelled desktop recess; the retired dock wording stays retired.
    expect((productEn.match(/Space for what you need/g) ?? []).length).toBe(1);
    expect((productEn.match(/data-lcs="socket"/g) ?? []).length).toBe(2);
    expect(enText).not.toContain("Add what you need");
    expect(arText).not.toContain("أضف ما تحتاجه");
  });

  it("has a localized concise aria-label and a visible localized caption", () => {
    expect(productEn).toContain(en("home.viz.aria"));
    expect(productAr).toContain(ar("home.viz.aria"));
    expect(productEn).toContain(en("home.viz.caption"));
    expect(productAr).toContain(ar("home.viz.caption"));
  });

  it("renders no fake interactive control and nothing focusable", () => {
    for (const html of [productEn, productAr]) {
      expect(html).not.toMatch(/<button|<a |<input|tabindex/i);
    }
  });

  it("makes the separate and connected states structurally identifiable", () => {
    for (const html of [productEn, productAr]) {
      expect(html).toContain("lcs-settle"); // zones settle from separated offsets
      expect(html).toContain("lcs-form"); // the channel forms once
      expect(html).toContain("lcs-carve-line"); // the path draws once
      expect(html).toContain("--lcs-from-x"); // per-zone separated offsets
    }
  });

  it("the final STATIC state carries all essential meaning (no motion required)", () => {
    for (const k of ["home.viz.work_v", "home.viz.quote_accepted", "home.viz.payment_v"]) {
      expect(productEn).toContain(en(k));
    }
    // Only the motion-only pulse is hidden at rest; no semantic node is.
    const hidden = [...productEn.matchAll(/class="([^"]*opacity-0[^"]*)"/g)];
    expect(hidden.length).toBe(1);
    expect(hidden[0]?.[1] ?? "").toContain("lcs-pulse");
  });

  it("gives mobile an intentional vertical composition, not a shrunken canvas", () => {
    // Carved stubs link the stages on mobile only; the carved SVG path and
    // texture are desktop-only; every semantic zone stays visible on mobile.
    expect((productEn.match(/lg:hidden/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(productEn).toContain("hidden lg:block");
    expect(productEn).not.toMatch(
      /data-lcs="(signal|formed|work|payment)"[^>]*class="[^"]*\bhidden\b/,
    );
    // The desktop canvas is a fixed composition with stepped scaling, so the
    // carved path and the zones keep exact registration at every lg+ width.
    expect(productEn).toContain("lg:[transform:scale(0.9)]");
    expect(productEn).toContain("xl:[transform:scale(1)]");
  });

  it("introduces no raster, video, canvas, WebGL or animation library", () => {
    for (const bad of ["<img", "<canvas", "<video", "webgl", "three", "framer-motion", "gsap"]) {
      expect(heroSrc.toLowerCase()).not.toContain(bad);
    }
    // This surface imports none of these libraries. A SOURCE check on the
    // surface itself, not a name regex over package.json: the app's gated
    // Studio 3D route dynamically imports `three` (H25 ADR-4) and must not
    // be mistaken for a hero animation.
    expect(heroSrc).not.toMatch(
      /from\s+["'](framer|three|gsap|lottie|animejs|motion|@xyflow\/react)/,
    );
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
    for (const k of ["home.viz.caption", "home.viz.aria", "home.viz.dock"]) {
      expect(/[؀-ۿ]/.test(String(arCat[k as keyof typeof arCat]))).toBe(true);
    }
    for (const k of [
      "home.viz.customer_v",
      "home.viz.work_stage",
      "home.viz.team_v",
      "home.viz.status",
      "home.viz.term_hint",
      "home.viz.term_label",
      "home.viz.term_custom",
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
  const lcsBlock = css.slice(
    css.indexOf("The Living Control Surface hero (H3.3B)"),
    css.indexOf("Signup visual"),
  );

  it("defines .lcs-* only inside the motion-safe block, nested behind a desktop width gate", () => {
    expect(guardAt).toBeGreaterThan(-1);
    const widthGateAt = css.indexOf("@media (min-width: 1024px)", guardAt);
    expect(widthGateAt).toBeGreaterThan(guardAt);
    for (const rule of [".lcs-settle", ".lcs-form", ".lcs-carve-line", ".lcs-pulse"]) {
      expect(css.includes(rule), `${rule} missing`).toBe(true);
      expect(css.indexOf(rule)).toBeGreaterThan(widthGateAt);
    }
    expect(css.slice(0, guardAt)).not.toMatch(
      /\.lcs-|lcs-settle-in|lcs-form-in|lcs-carve-draw|lcs-pulse-run/,
    );
  });

  it("hero motion never loops: no infinite iteration anywhere in the hero rules", () => {
    expect(lcsBlock.length).toBeGreaterThan(100);
    expect(lcsBlock).not.toContain("infinite");
    expect(lcsBlock).toMatch(/lcs-settle-in[^;]*\)\s*1 both/);
    expect(lcsBlock).toMatch(/lcs-form-in[^;]*\s1 both/);
    expect(lcsBlock).toMatch(/lcs-carve-draw[^;]*\s1 both/);
    expect(lcsBlock).toMatch(/lcs-pulse-run[^;]*\s1 both/);
  });

  it("animates only cheap paint-safe properties (opacity, transform, path offsets)", () => {
    // Slice each @keyframes to its balanced closing brace so trailing rules
    // (the next selector's animation shorthand) are not misread as keyframe
    // declarations.
    const bodies: string[] = [];
    for (const seg of lcsBlock.split("@keyframes").slice(1)) {
      let depth = 0;
      let end = seg.length;
      for (let i = seg.indexOf("{"); i < seg.length; i++) {
        if (seg[i] === "{") depth++;
        if (seg[i] === "}" && --depth === 0) {
          end = i;
          break;
        }
      }
      bodies.push(seg.slice(0, end));
    }
    expect(bodies.length).toBe(4); // settle-in, form-in, carve-draw, pulse-run
    for (const body of bodies) {
      expect(body).not.toMatch(/box-shadow|inset|margin|padding|top:|left:|right:|width:|height:/);
      const props = [...body.matchAll(/^\s*([a-z-]+):/gm)].map((m) => m[1]);
      expect(props.length).toBeGreaterThan(0);
      for (const p of props) {
        expect(["opacity", "transform", "stroke-dashoffset", "offset-distance"]).toContain(p);
      }
    }
  });

  it("the whole story ends within ~3 seconds (last delay + duration)", () => {
    const delays = [...lcsBlock.matchAll(/animation(?:-delay)?:[^;]*?([\d.]+)s/g)].map((m) =>
      parseFloat(m[1] ?? "0"),
    );
    expect(Math.max(...delays)).toBeLessThanOrEqual(2.2); // latest start
    expect(lcsBlock).toContain("animation-delay: 2.1s"); // the closing pulse
  });

  it("the old hero animation sets are gone; the signup core stays guarded", () => {
    expect(css).not.toContain(".icv-");
    expect(css).not.toContain(".lbs-");
    expect(css).not.toContain(".los-pulse");
    expect(css).not.toContain(".los-cta");
    expect(css.indexOf(".los-core")).toBeGreaterThan(guardAt);
  });
});
