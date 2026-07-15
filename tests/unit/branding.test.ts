/**
 * U2 org branding — unit surface:
 *  1. The logo upload VALIDATION MATRIX (pure: size / MIME whitelist incl. the
 *     SVG rejection / magic-byte agreement / decoded-dimension bounds).
 *  2. The accent-colour contract (same regex the 0071 CHECK enforces).
 *  3. The logo re-encode variant (PNG, alpha-capable, edge caps).
 *  4. renderHtml for the THREE print templates: branded header (logo img +
 *     data URI) when branding is present, org-name text fallback when absent,
 *     and NO cross-tenant leakage by construction (templates are pure
 *     functions of explicit branding args).
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  ACCENT_COLOR_RE,
  LOGO_MAX_BYTES,
  checkLogoDimensions,
  sniffImageMime,
  validateLogoBytes,
} from "@/modules/branding/validation";
import { processLogo, LOGO_MAX_EDGE_PX, LOGO_THUMB_EDGE_PX } from "@/platform/files/image";
import { lpoHtml } from "@/modules/supply/lpo-template";
import { quoteHtml } from "@/modules/quotes/quote-template";
import { invoiceHtml } from "@/modules/invoices/invoice-template";

async function png(width = 200, height = 200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 10, g: 120, b: 110, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
}
async function webp(width = 200, height = 200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .webp()
    .toBuffer();
}
async function jpeg(width = 200, height = 200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 40, b: 200 } },
  })
    .jpeg()
    .toBuffer();
}

describe("logo upload validation matrix", () => {
  it("accepts a valid PNG and a valid WEBP (magic bytes agree with MIME)", async () => {
    expect(validateLogoBytes(await png(), "image/png")).toEqual({ ok: true, mime: "image/png" });
    expect(validateLogoBytes(await webp(), "image/webp")).toEqual({
      ok: true,
      mime: "image/webp",
    });
    expect(validateLogoBytes(await jpeg(), "image/jpeg")).toEqual({
      ok: true,
      mime: "image/jpeg",
    });
  });

  it("rejects a bad MIME outright — SVG is NEVER accepted", async () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>`);
    expect(validateLogoBytes(svg, "image/svg+xml")).toEqual({ ok: false, error: "bad_type" });
    expect(validateLogoBytes(await png(), "image/svg+xml")).toEqual({
      ok: false,
      error: "bad_type",
    });
    expect(validateLogoBytes(Buffer.from("hello"), "text/plain")).toEqual({
      ok: false,
      error: "bad_type",
    });
  });

  it("rejects fake magic bytes (declared PNG, actual JPEG — and garbage)", async () => {
    expect(validateLogoBytes(await jpeg(), "image/png")).toEqual({
      ok: false,
      error: "bad_signature",
    });
    expect(validateLogoBytes(Buffer.from("not an image at all"), "image/png")).toEqual({
      ok: false,
      error: "bad_signature",
    });
  });

  it("rejects an oversized file (> 2 MB)", async () => {
    const head = await png(64, 64);
    const oversized = Buffer.concat([head, Buffer.alloc(LOGO_MAX_BYTES)]);
    expect(validateLogoBytes(oversized, "image/png")).toEqual({ ok: false, error: "too_large" });
  });

  it("sniffs the three formats and nothing else", async () => {
    expect(sniffImageMime(await png())).toBe("image/png");
    expect(sniffImageMime(await jpeg())).toBe("image/jpeg");
    expect(sniffImageMime(await webp())).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("<svg/>"))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });

  it("bounds decoded dimensions: ≥32×32, ≤2000×2000", () => {
    expect(checkLogoDimensions(16, 200)).toBe("too_small_dims");
    expect(checkLogoDimensions(200, 16)).toBe("too_small_dims");
    expect(checkLogoDimensions(undefined, undefined)).toBe("too_small_dims");
    expect(checkLogoDimensions(2600, 200)).toBe("too_large_dims");
    expect(checkLogoDimensions(200, 2600)).toBe("too_large_dims");
    expect(checkLogoDimensions(32, 32)).toBeNull();
    expect(checkLogoDimensions(2000, 2000)).toBeNull();
  });
});

describe("accent colour contract (mirrors the 0071 CHECK)", () => {
  it("accepts #rrggbb only", () => {
    for (const good of ["#000000", "#FFFFFF", "#1a2B3c"]) {
      expect(ACCENT_COLOR_RE.test(good), good).toBe(true);
    }
    for (const bad of ["", "red", "#fff", "#1234567", "112233", "#12345G", "#12 345"]) {
      expect(ACCENT_COLOR_RE.test(bad), bad).toBe(false);
    }
  });
});

describe("logo re-encode variant (PNG pipeline)", () => {
  it("outputs PNG main+thumb within the edge caps, never enlarging", async () => {
    const out = await processLogo(await png(1000, 400));
    expect(out.main.mime).toBe("image/png");
    expect(out.thumb.mime).toBe("image/png");
    expect(Math.max(out.main.width, out.main.height)).toBeLessThanOrEqual(LOGO_MAX_EDGE_PX);
    expect(Math.max(out.thumb.width, out.thumb.height)).toBeLessThanOrEqual(LOGO_THUMB_EDGE_PX);
    const small = await processLogo(await png(64, 64));
    expect(small.main.width).toBe(64); // withoutEnlargement
  });

  it("preserves the alpha channel (a transparent logo is not flattened)", async () => {
    const out = await processLogo(await png(120, 120)); // fixture has alpha 0.5
    const meta = await sharp(out.main.buffer).metadata();
    expect(meta.hasAlpha).toBe(true);
  });
});

// ── template render assertions ───────────────────────────────────────────────
const LOGO_A = "data:image/png;base64,ORG-A-LOGO-BYTES";
const LOGO_B = "data:image/png;base64,ORG-B-LOGO-BYTES";

const lpoData = {
  reference: "PO-001",
  supplierName: "Supplier",
  jobReference: null,
  issueDate: "2026-07-15",
  vatMinor: "500",
  totalMinor: "10500",
  notes: null,
  lines: [
    { itemName: "Resin", qty: "1", unit: "L", unitCostMinor: "10000", lineTotalMinor: "10000" },
  ],
};
const quoteData = {
  reference: "QT-001",
  customerName: "Customer",
  issueDate: "2026-07-15",
  validUntil: null,
  subtotalMinor: "10000",
  vatMinor: "500",
  totalMinor: "10500",
  terms: null,
  lines: [
    { description: "Line", qty: "1", unit: "ea", unitPriceMinor: "10000", lineTotalMinor: "10000" },
  ],
};
const invoiceData = {
  reference: "INV-001",
  kind: "invoice" as const,
  correctsReference: null,
  customerName: "Customer",
  customerTaxRegNo: null,
  issuedAt: "2026-07-15T00:00:00Z",
  dueDate: null,
  isExport: false,
  currency: "AED" as const,
  subtotalMinor: 10000,
  vatMinor: 500,
  totalMinor: 10500,
  qr: null,
  lines: [
    {
      description: "Line",
      qty: 1,
      unit: "ea",
      unitPriceMinor: 10000,
      vatRate: 5,
      lineTotalMinor: 10000,
    },
  ],
};

describe("print templates — branded header, honest fallback, no cross-tenant leak", () => {
  const renders: Array<[string, (logo: string | null, org: string) => string]> = [
    [
      "lpo",
      (logo, org) =>
        lpoHtml(lpoData, {
          orgName: org,
          currency: "AED",
          poTermEn: "Local Purchase Order",
          poTermAr: "أمر شراء محلي",
          logoDataUri: logo,
          footerDetails: logo ? `${org} footer details` : null,
        }),
    ],
    [
      "quote",
      (logo, org) =>
        quoteHtml(quoteData, {
          orgName: org,
          currency: "AED",
          logoDataUri: logo,
          footerDetails: logo ? `${org} footer details` : null,
        }),
    ],
    [
      "invoice",
      (logo, org) =>
        invoiceHtml({
          ...invoiceData,
          orgName: org,
          logoDataUri: logo,
          footerDetails: logo ? `${org} footer details` : null,
        }),
    ],
  ];

  for (const [name, render] of renders) {
    it(`${name}: embeds the logo img when branding is present`, () => {
      const html = render(LOGO_A, "Org A");
      expect(html).toContain(`<img class="logo"`);
      expect(html).toContain(LOGO_A);
      expect(html).toContain("Org A"); // name still printed alongside
      expect(html).toContain("Org A footer details");
    });

    it(`${name}: falls back to the org-name text header when branding is absent`, () => {
      const html = render(null, "Org A");
      expect(html).not.toContain(`<img class="logo"`);
      expect(html).not.toContain("data:image/png");
      expect(html).toContain("Org A");
    });

    it(`${name}: a render for org A never embeds org B's branding (pure fn of explicit args)`, () => {
      const htmlA = render(LOGO_A, "Org A");
      expect(htmlA).not.toContain(LOGO_B);
      expect(htmlA).not.toContain("Org B");
      const htmlB = render(LOGO_B, "Org B");
      expect(htmlB).not.toContain(LOGO_A);
      expect(htmlB).not.toContain("Org A footer details");
    });
  }

  it("escapes a hostile data URI (no raw attribute breakout)", () => {
    const hostile = `data:image/png;base64,x" onerror="alert(1)`;
    const html = quoteHtml(quoteData, {
      orgName: "Org A",
      currency: "AED",
      logoDataUri: hostile,
    });
    expect(html).not.toContain(`onerror="alert(1)"`);
    expect(html).toContain("&quot;");
  });
});
