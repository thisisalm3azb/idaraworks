/**
 * S10 regression (audit CONFIRMED MATERIAL): all three provider seams — billing, e-invoice,
 * AI narration — previously gated their production "disabled" default on
 * `APP_ENV === "production"`, a string never set anywhere (the canonical prod tag is "prod").
 * So in production the guard fell through and served the FAKE provider: a fake billing
 * checkout shown as enabled, fake ZATCA clearance, fake narration. Now centralised on
 * isProd() (APP_ENV === "prod"). This asserts every seam disables in prod with no creds.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getBillingProvider } from "@/platform/billing/adapter";
import { getEInvoiceProvider } from "@/platform/einvoice/adapter";
import { getNarrationProvider } from "@/platform/ai/adapter";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function clearProviderEnv() {
  delete process.env.BILLING_PROVIDER;
  delete process.env.EINVOICE_PROVIDER;
  delete process.env.AI_NARRATION_PROVIDER;
}

describe("S10 production provider guards (APP_ENV=prod → all seams disabled)", () => {
  it("billing/e-invoice/AI narration all default to DISABLED in prod with no credentials", () => {
    clearProviderEnv();
    process.env.APP_ENV = "prod";
    expect(getBillingProvider().enabled).toBe(false);
    expect(getEInvoiceProvider().name).toBe("disabled");
    expect(getNarrationProvider().enabled).toBe(false);
  });

  it("all three seams run the fake provider off-prod (dev/preview exercise the lifecycle)", () => {
    clearProviderEnv();
    for (const env of ["dev", "preview"]) {
      process.env.APP_ENV = env;
      expect(getBillingProvider().enabled).toBe(true);
      expect(getEInvoiceProvider().name).toBe("fake");
      expect(getNarrationProvider().enabled).toBe(true);
    }
  });

  it("an explicit real credential still wins in prod (activation path unaffected)", () => {
    clearProviderEnv();
    process.env.APP_ENV = "prod";
    process.env.BILLING_PROVIDER = "fake"; // stands in for a future real provider name
    expect(getBillingProvider().enabled).toBe(true);
  });
});
