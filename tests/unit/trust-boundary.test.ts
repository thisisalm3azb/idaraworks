/**
 * H8 — the Trust Boundary (the "#trust" section). Guarantees:
 *  - the section exists with a working anchor and nav link,
 *  - every public security statement maps to verified implementation
 *    (RLS-bounded workspaces, the authz matrix, server-side money redaction,
 *    config revisions with undo, the configuration guardrail),
 *  - no certification, uptime, encryption, breach-prevention or scare claim,
 *  - no internal security identifier leaks into public copy,
 *  - real legal routes, no fake controls, static markup, full RTL,
 *  - H1..H7 and authenticated surfaces untouched.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "@/platform/i18n";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { TrustBoundary } from "@/app/_home/TrustBoundary";

const tEn = (k: string) => t(k, undefined, "en");
const tAr = (k: string) => t(k, undefined, "ar");
const htmlEn = renderToStaticMarkup(h(TrustBoundary, { t: tEn }));
const htmlAr = renderToStaticMarkup(h(TrustBoundary, { t: tAr }));
const homeSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/_home/HomePage.tsx", import.meta.url)),
  "utf8",
);
const src = readFileSync(
  fileURLToPath(new URL("../../src/app/_home/TrustBoundary.tsx", import.meta.url)),
  "utf8",
);

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l(?!g)|rounded-r|float-(left|right))\b/;

const trustEn = Object.keys(en)
  .filter((k) => k.startsWith("home.trust."))
  .map((k) => String(en[k as keyof typeof en]))
  .join("  ");

describe("H8 — structure", () => {
  it("exists with a working #trust anchor, sticky offset and nav link", () => {
    expect(homeSrc).toMatch(/<section id="trust" className="[^"]*scroll-mt-16/);
    expect(homeSrc).toContain("<TrustBoundary t={t} />");
  });

  it("renders the boundary with all verified proof statements, both locales", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      for (const k of [
        "eyebrow",
        "title",
        "body",
        "boundary_title",
        "boundary_note",
        "p1",
        "p2",
        "p3",
        "guard",
        "privacy",
        "terms",
      ]) {
        // React escapes apostrophes in rendered text.
        expect(html, `missing home.trust.${k}`).toContain(
          tt(`home.trust.${k}`).replace(/'/g, "&#x27;"),
        );
      }
    }
  });

  it("statements match the audited implementation scope", () => {
    // Boundary: workspace-scoped records (RLS + org storage) — no wider claim.
    expect(tEn("home.trust.boundary_note")).toMatch(/inside your organization/i);
    // Permissions: the matrix decides visibility and actions.
    expect(tEn("home.trust.p1")).toMatch(/roles and permissions/i);
    // Redaction: server-side money masking incl. exports (F-23).
    expect(tEn("home.trust.p2")).toMatch(/cost and price[^.]*permission/i);
    expect(tEn("home.trust.p2")).toMatch(/exports/i);
    // History: config_revision + undo.
    expect(tEn("home.trust.p3")).toMatch(/recorded[^.]*history/i);
    expect(tEn("home.trust.p3")).toMatch(/undone/i);
    // Guardrail: config cannot touch code or security rules.
    expect(tEn("home.trust.guard")).toMatch(/never changes[^.]*(code|security)/i);
  });

  it("links only the real legal routes", () => {
    for (const html of [htmlEn, htmlAr]) {
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/terms"');
      expect((html.match(/<a /g) ?? []).length).toBe(2); // exactly the two legal links
    }
  });
});

describe("H8 — truthfulness", () => {
  it("makes no certification, compliance or absolute-security claim", () => {
    expect(trustEn).not.toMatch(
      /SOC ?2|ISO|GDPR|HIPAA|PCI|certif|complian|penetration|pen[- ]test|audit(ed)? by/i,
    );
    expect(trustEn).not.toMatch(
      /encrypt|uptime|99\.|guarantee|unbreakable|bank[- ]grade|military|impenetrable|zero[- ]trust/i,
    );
    expect(trustEn).not.toMatch(/backup|disaster|residency|fraud|monitor/i);
    expect(trustEn).not.toMatch(/\bAI\b|automat/i);
    expect(trustEn).not.toContain("—");
  });

  it("exposes no internal security identifier, table, policy or env name", () => {
    for (const blob of [trustEn, htmlEn]) {
      expect(blob).not.toMatch(/org_id|RLS|row[- ]level|supabase|postgres|app_user|NOBYPASS/i);
      expect(blob).not.toMatch(/config_revision|audit_log|set_config|jwt|token|env\./i);
    }
  });

  it("invents no people, roles, timestamps or metrics", () => {
    for (const html of [htmlEn, htmlAr]) {
      const text = html.replace(/<[^>]+>/g, " ").replace(/&#?[a-z0-9]+;/gi, " ");
      expect(text).not.toMatch(/\d/);
      expect(html).not.toMatch(/Rawan|روان/);
    }
  });

  it("Arabic copy is genuinely Arabic", () => {
    for (const k of Object.keys(ar).filter((x) => x.startsWith("home.trust."))) {
      expect(/[؀-ۿ]/.test(String(ar[k as keyof typeof ar])), `ar.${k} not Arabic`).toBe(true);
    }
    expect(/[؀-ۿ]/.test(String(ar["home.nav.trust" as keyof typeof ar]))).toBe(true);
  });
});

describe("H8 — accessibility, RTL, motion, scope", () => {
  it("has one h2, one h3, and no fake interactive control", () => {
    for (const html of [htmlEn, htmlAr]) {
      expect((html.match(/<h2/g) ?? []).length).toBe(1);
      expect((html.match(/<h3/g) ?? []).length).toBe(1);
      expect(html).not.toMatch(/<button|<input|<select|tabindex|role="(button|switch)"/i);
    }
  });

  it("uses only logical direction classes; the undo glyph mirrors; decor hidden", () => {
    for (const html of [htmlEn, htmlAr]) {
      const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
      expect(PHYSICAL.test(classes), classes).toBe(false);
    }
    expect(htmlEn).toContain("rtl:-scale-x-100");
    expect((htmlEn.match(/aria-hidden="true"/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("is fully static, so reduced motion needs no special path", () => {
    expect(src).not.toMatch(/animation[:-]|animate-|@keyframes|lcs-|lbs-/);
    for (const html of [htmlEn, htmlAr]) {
      expect(html).not.toMatch(/animation|animate-/);
      expect(html).not.toMatch(/style="[^"]*opacity:\s*0/);
    }
  });

  it("leaves H1..H7 sections and authenticated surfaces untouched", () => {
    expect(src).not.toMatch(/home\.(viz|flow|built|caps|gcc|pricing)\./);
    for (const marker of [
      "<ProductVisual t={t} dir={dir} />",
      "<FlowJourney t={t} />",
      "<FoundationShapes t={t} />",
      "<BusinessOS t={t} />", // H11 successor of the capability map
      "<BusinessPassport t={t} />",
    ]) {
      expect(homeSrc).toContain(marker);
    }
  });

  it("introduces no raster, canvas, video or new runtime dependency", () => {
    for (const bad of ["<img", "<canvas", "<video", "webgl", "three"]) {
      expect(src.toLowerCase()).not.toContain(bad);
    }
    // This surface imports none of these libraries. A SOURCE check on the
    // surface itself, not a name regex over package.json: the app's gated
    // Studio 3D route dynamically imports `three` (H25 ADR-4) and must not
    // be mistaken for a hero animation.
    expect(src).not.toMatch(/from\s+["'](framer|three|gsap|lottie|animejs|motion|@xyflow\/react)/);
  });
});
