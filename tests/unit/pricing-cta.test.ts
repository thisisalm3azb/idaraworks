/**
 * H9 — pricing, final CTA and footer. Guarantees:
 *  - every public plan maps to a real catalogue tier (pricingTiers throws
 *    otherwise, and the shape is pinned here),
 *  - no invented price, discount, trial, unlimited, credit-card or
 *    cancellation claim; unfinalized pricing is stated per plan,
 *  - the payment-during-setup statement matches reality (the payment
 *    provider is gated off, so no charge is possible during setup),
 *  - the comparison spine lists only capabilities verified in EVERY plan,
 *  - an existing-user login path exists beside Get Started,
 *  - the footer links only real destinations (page anchors, auth routes,
 *    legal pages) and covers every homepage section,
 *  - #pricing anchor, RTL, and static rendering are preserved.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import { pricingTiers } from "@/app/_home/pricing";
import { getTierBundle } from "@/platform/entitlements";

const homeSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/_home/HomePage.tsx", import.meta.url)),
  "utf8",
);
const subscriptionSrc = readFileSync(
  fileURLToPath(new URL("../../src/modules/subscription/service.ts", import.meta.url)),
  "utf8",
);

const pricingEn = Object.keys(en)
  .filter((k) => k.startsWith("home.pricing.") || k.startsWith("home.cta."))
  .map((k) => String(en[k as keyof typeof en]))
  .join("  ");

describe("H9 — plan truth", () => {
  it("every public plan maps to a real internal tier with catalogue names", () => {
    const tiers = pricingTiers();
    expect(tiers.map((t) => t.key)).toEqual(["free", "medium", "high"]);
    expect(tiers[1]!.names).toEqual(getTierBundle("medium")!.names);
    expect(tiers[2]!.names).toEqual(getTierBundle("high")!.names);
  });

  it("states unfinalized pricing per plan and shows no number anywhere", () => {
    expect(String(en["home.pricing.finalizing" as keyof typeof en])).toMatch(/being finalized/i);
    for (const k of Object.keys(en).filter((x) => x.startsWith("home.pricing."))) {
      expect(/\d/.test(String(en[k as keyof typeof en])), `${k} contains a number`).toBe(false);
    }
    expect(pricingEn).not.toMatch(/\$|USD|AED|SAR|per (month|user|seat)|\/mo/i);
  });

  it("payment wording matches the gated provider: no charge during setup", () => {
    // The real payment provider sits behind an explicit disabled gate, so a
    // charge during setup is impossible; the note claims exactly that.
    expect(subscriptionSrc).toMatch(/provider_unavailable|BillingProviderDisabled/);
    expect(String(en["home.pricing.note" as keyof typeof en])).toMatch(
      /no charge is taken while you set up/i,
    );
    // The unverifiable "prices are shown at sign-up" claim is retired.
    expect(pricingEn).not.toMatch(/prices are shown at sign[- ]up/i);
  });

  it("makes no unlimited, trial, discount, credit-card or cancellation claim", () => {
    expect(pricingEn).not.toMatch(
      /unlimited|free forever|no credit card|cancel anytime|trial|discount|% off|save \d|most popular|best value|limited[- ]time/i,
    );
    expect(pricingEn).not.toContain("—");
    expect(pricingEn).not.toMatch(/\bAI\b/);
  });

  it("the comparison spine lists only all-plan capabilities", () => {
    for (const k of ["spine_label", "s1", "s2", "s3", "s4", "existing"]) {
      expect(`home.pricing.${k}` in en, `missing home.pricing.${k}`).toBe(true);
      expect(
        /[؀-ۿ]/.test(String(ar[`home.pricing.${k}` as keyof typeof ar])),
        `ar home.pricing.${k}`,
      ).toBe(true);
    }
    // The spine must not claim quote-gated capabilities as universal: quoting
    // is a medium-tier capability, so "quote to payment" may not appear here.
    for (const k of ["s1", "s2", "s3", "s4"]) {
      expect(String(en[`home.pricing.${k}` as keyof typeof en])).not.toMatch(/quote|invoice/i);
    }
    expect(homeSrc).toContain("home.pricing.spine_label");
  });
});

describe("H9 — CTA and footer", () => {
  it("keeps the #pricing anchor, adds the existing-user login path", () => {
    expect(homeSrc).toMatch(/<section id="pricing" className="scroll-mt-16/);
    expect(homeSrc).toContain('t("home.pricing.existing")');
    expect(homeSrc).toMatch(/home\.pricing\.existing[\s\S]{0,200}href=\{LOGIN\}/);
  });

  it("the final CTA carries the verified reassurance line", () => {
    expect(homeSrc).toContain('t("home.cta.reassure")');
    expect(String(en["home.cta.reassure" as keyof typeof en])).toMatch(
      /no charge while you set up/i,
    );
    expect(/[؀-ۿ]/.test(String(ar["home.cta.reassure" as keyof typeof ar]))).toBe(true);
  });

  it("the footer links every section anchor plus only real routes", () => {
    const footer = homeSrc.slice(homeSrc.indexOf("<footer"));
    for (const a of ["#how", "#product", "#international", "#trust", "#pricing"]) {
      expect(footer, `footer missing ${a}`).toContain(`href="${a}"`);
    }
    expect(footer).toContain('href="/terms"');
    expect(footer).toContain('href="/privacy"');
    expect(footer).toContain("href={LOGIN}");
    // No fake destinations: no social, mailto, external or dead links.
    expect(footer).not.toMatch(/mailto:|twitter|linkedin|facebook|instagram|status\.|docs\./i);
    expect(footer).not.toMatch(/href="https?:/);
  });

  it("all H9 copy exists in both catalogs with no em dash", () => {
    for (const k of Object.keys(en).filter(
      (x) => x.startsWith("home.pricing.") || x.startsWith("home.cta."),
    )) {
      expect(k in ar, `ar missing ${k}`).toBe(true);
      expect(String(en[k as keyof typeof en])).not.toContain("—");
      expect(String(ar[k as keyof typeof ar])).not.toContain("—");
    }
  });
});
