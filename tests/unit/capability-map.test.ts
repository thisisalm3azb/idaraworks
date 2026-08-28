/**
 * H6 — the Operating Capability Map (the "#product" Capabilities section).
 * Guarantees:
 *  - the four-equal-card grid is retired,
 *  - one connected foundation with four semantically grouped capability
 *    layers, every displayed capability backed by a REAL workspace surface
 *    (asserted against the navigation IA in src/platform/ui/nav/build.ts and
 *    the export service's entity list),
 *  - availability is stated in text (role + plan) with no planned module
 *    presented as shipped, and export wording matches shipped behavior,
 *  - no accounting/payroll/banking/ERP or universal-export claim,
 *  - no invented data, no industry templates, no AI/automation claims,
 *  - RTL-safe logical classes, static markup, no fake controls,
 *  - hero, H4, H5, international section untouched.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "@/platform/i18n";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { CapabilityMap } from "@/app/_home/CapabilityMap";
import { buildNavGroups } from "@/platform/ui/nav/build";
import { EXPORT_ENTITY_KEYS } from "@/platform/export/service";

const tEn = (k: string) => t(k, undefined, "en");
const tAr = (k: string) => t(k, undefined, "ar");
const htmlEn = renderToStaticMarkup(h(CapabilityMap, { t: tEn }));
const htmlAr = renderToStaticMarkup(h(CapabilityMap, { t: tAr }));
const homeSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/_home/HomePage.tsx", import.meta.url)),
  "utf8",
);
const mapSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/_home/CapabilityMap.tsx", import.meta.url)),
  "utf8",
);

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l(?!g)|rounded-r|float-(left|right))\b/;

const capsEn = Object.keys(en)
  .filter((k) => k.startsWith("home.caps."))
  .map((k) => String(en[k as keyof typeof en]))
  .join("  ");

/** The full owner-eligible nav (all capabilities entitled) = shipped surfaces. */
const NAV_KEYS = new Set(
  buildNavGroups({
    orgId: "x",
    archetype: "owner",
    features: {
      "cap.attendance": true,
      "cap.material_requests": true,
      "cap.purchase_orders": true,
      "cap.quoting": true,
      "cap.invoicing": true,
      "cap.payments": true,
      "cap.expenses": true,
      "cap.costing": true,
      "cap.customer_updates": true,
      "feat.data_import": true,
    },
  }).flatMap((g) => g.items.map((i) => i.key)),
);

describe("H6 — structure", () => {
  it("retires the four-equal-card grid and its copy keys", () => {
    expect(homeSrc).toContain("<CapabilityMap t={t} />");
    expect(homeSrc).not.toMatch(/home\.caps\.\$\{k\}/);
    for (const g of ["win", "run", "see"]) {
      for (const s of ["title", "desc", "i1"]) {
        expect(`home.caps.${g}.${s}` in en, `home.caps.${g}.${s} must be retired`).toBe(false);
      }
    }
    expect("home.caps.supply.i1" in en).toBe(false);
  });

  it("keeps the #product anchor and sticky offset", () => {
    expect(homeSrc).toMatch(/<section id="product" className="scroll-mt-16/);
  });

  it("renders one connected foundation plus four semantically grouped layers", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      expect(html).toContain(tt("home.caps.core_title"));
      expect(html).toContain(tt("home.caps.core_note"));
      expect((html.match(/<h3/g) ?? []).length).toBe(5); // core + 4 layers
      expect((html.match(/<ul/g) ?? []).length).toBe(4); // one item list per layer
      for (const layer of ["commercial", "delivery", "supply", "visibility"]) {
        expect(html).toContain(tt(`home.caps.${layer}.title`));
        expect(html).toContain(tt(`home.caps.${layer}.desc`));
      }
    }
  });

  it("every displayed capability maps to a shipped workspace surface", () => {
    // Public label → nav item key(s) in the real IA (or a verified surface).
    const BACKING: Record<string, string[]> = {
      "home.caps.commercial.customers": ["customers"],
      "home.caps.commercial.quotes": ["quotes"],
      "home.caps.commercial.invoices": ["invoices"],
      "home.caps.commercial.payments": ["payments"],
      "home.caps.commercial.outstanding": ["ar"],
      "home.caps.commercial.docs": ["quotes", "invoices"], // branded print templates
      "home.caps.delivery.work": ["jobs"],
      "home.caps.delivery.reports": ["report_new"],
      "home.caps.delivery.review": ["reports_review"],
      "home.caps.delivery.issues": ["issues"],
      "home.caps.delivery.approvals": ["approvals"],
      "home.caps.delivery.weekly": ["week"],
      "home.caps.delivery.updates": ["customer_updates"],
      "home.caps.supply.items": ["items"],
      "home.caps.supply.mr": ["material_requests"],
      "home.caps.supply.po": ["purchase_orders"],
      "home.caps.supply.suppliers": ["suppliers"],
      "home.caps.supply.attendance": ["attendance"],
      "home.caps.supply.expenses": ["expenses"],
      "home.caps.supply.costing": ["costing"],
      "home.caps.visibility.overview": ["today"],
      "home.caps.visibility.exports": ["exports"],
      "home.caps.visibility.import": ["imports"],
      "home.caps.visibility.members": ["members"],
      "home.caps.visibility.config": ["configuration"],
    };
    for (const [key, navKeys] of Object.entries(BACKING)) {
      expect(key in en, `${key} missing from catalog`).toBe(true);
      expect(htmlEn, `${key} not rendered`).toContain(tEn(key));
      for (const nk of navKeys) {
        expect(NAV_KEYS.has(nk), `${key} claims unshipped surface ${nk}`).toBe(true);
      }
    }
    // And nothing extra: the rendered item labels are exactly the audited set.
    const itemKeys = Object.keys(en).filter(
      (k) =>
        /^home\.caps\.(commercial|delivery|supply|visibility)\./.test(k) &&
        !/\.(title|desc)$/.test(k),
    );
    expect(itemKeys.sort()).toEqual(Object.keys(BACKING).sort());
  });

  it("export wording matches the shipped export surfaces", () => {
    // CSV record exports exist for a real entity set, and branded printable
    // documents ship (quote, tax invoice, purchase order templates).
    expect(EXPORT_ENTITY_KEYS.length).toBeGreaterThanOrEqual(7);
    expect(tEn("home.caps.visibility.exports")).toBe("Record exports");
    expect(capsEn).not.toMatch(/export everything|everything export/i);
    expect(capsEn).not.toMatch(/all documents|any document/i);
  });

  it("states availability in text: today, role, plan", () => {
    for (const [html, tt] of [
      [htmlEn, tEn],
      [htmlAr, tAr],
    ] as const) {
      expect(html).toContain(tt("home.caps.avail"));
      expect(html).toContain(tt("home.caps.close"));
    }
    expect(tEn("home.caps.avail")).toMatch(/available today/i);
    expect(tEn("home.caps.avail")).toMatch(/role/i);
    expect(tEn("home.caps.avail")).toMatch(/plan/i);
    // No planned module is listed in this section.
    expect(capsEn).not.toMatch(/planned|coming soon|on the way/i);
  });
});

describe("H6 — truthfulness", () => {
  it("makes no accounting, payroll, banking, HR or ERP claim", () => {
    expect(capsEn).not.toMatch(/accounting|payroll|banking|tax filing|\bERP\b|\bHR\b|recruit/i);
  });

  it("makes no automation, AI or banned-language claim", () => {
    expect(capsEn).not.toMatch(/\bAI\b|automat|magical|revolutionary|effortless|smart/i);
    expect(capsEn).not.toMatch(/replaces every|all[- ]in[- ]one|everything your business/i);
    expect(capsEn).not.toContain("—");
  });

  it("shows no industry templates and no invented data", () => {
    expect(capsEn + htmlEn).not.toMatch(
      /coffee|cafe|construction|bakery|real[- ]estate|workshop|farm|salon|boat/i,
    );
    for (const html of [htmlEn, htmlAr]) {
      const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ");
      expect(text).not.toMatch(/\d/);
      expect(html).not.toMatch(/\b(AED|USD|SAR|EUR|QAR|KWD|BHD|OMR)\b/);
    }
  });

  it("Arabic copy is genuinely Arabic and reuses established product terms", () => {
    for (const k of Object.keys(ar).filter((x) => x.startsWith("home.caps."))) {
      expect(/[؀-ۿ]/.test(String(ar[k as keyof typeof ar])), `ar.${k} not Arabic`).toBe(true);
    }
    // Established workspace terminology is reused verbatim, not re-invented.
    expect(tAr("home.caps.commercial.quotes")).toBe(String(ar["nav.quotes" as keyof typeof ar]));
    expect(tAr("home.caps.commercial.invoices")).toBe(
      String(ar["nav.invoices" as keyof typeof ar]),
    );
    expect(tAr("home.caps.supply.suppliers")).toBe(String(ar["nav.suppliers" as keyof typeof ar]));
    expect(tAr("home.caps.delivery.approvals")).toBe(
      String(ar["nav.approvals" as keyof typeof ar]),
    );
  });
});

describe("H6 — accessibility, RTL, motion, scope", () => {
  it("renders no fake interactive control and nothing focusable", () => {
    for (const html of [htmlEn, htmlAr]) {
      expect(html).not.toMatch(/<button|<a |<input|<select|tabindex|role="(button|switch)"/i);
    }
  });

  it("uses only logical direction classes; connectors are decorative", () => {
    for (const html of [htmlEn, htmlAr]) {
      const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
      expect(PHYSICAL.test(classes), classes).toBe(false);
    }
    expect((htmlEn.match(/aria-hidden="true"/g) ?? []).length).toBeGreaterThanOrEqual(10);
  });

  it("is fully static, so reduced motion needs no special path", () => {
    expect(mapSrc).not.toMatch(/animation[:-]|animate-|@keyframes|lcs-|lbs-/);
    for (const html of [htmlEn, htmlAr]) {
      expect(html).not.toMatch(/animation|animate-/);
      expect(html).not.toMatch(/style="[^"]*opacity:\s*0/);
    }
  });

  it("leaves the hero, H4, H5 and international sections untouched", () => {
    expect(mapSrc).not.toMatch(/home\.viz\.|home\.flow\.|home\.built\.|home\.gcc\./);
    expect(homeSrc).toContain("<ProductVisual t={t} dir={dir} />");
    expect(homeSrc).toContain("<FlowJourney t={t} />");
    expect(homeSrc).toContain("<FoundationShapes t={t} />");
    expect(homeSrc).toMatch(/<section id="international"/);
  });

  it("introduces no raster, canvas, video or new runtime dependency", () => {
    for (const bad of ["<img", "<canvas", "<video", "webgl", "three"]) {
      expect(mapSrc.toLowerCase()).not.toContain(bad);
    }
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      expect(dep).not.toMatch(/framer|three|gsap|lottie|animejs|motion/);
    }
  });
});
