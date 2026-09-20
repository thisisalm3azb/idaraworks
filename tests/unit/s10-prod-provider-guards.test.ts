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
import {
  getDocumentScanner,
  assertDocumentClean,
  DocumentRejectedError,
} from "@/platform/files/scan";

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

  it("all three seams run the fake provider in local dev (the lifecycle stays exercisable)", () => {
    clearProviderEnv();
    process.env.APP_ENV = "dev";
    expect(getBillingProvider().enabled).toBe(true);
    expect(getEInvoiceProvider().name).toBe("fake");
    expect(getNarrationProvider().enabled).toBe(true);
  });

  it("a deployed preview runs the fake billing lifecycle only with an operator-set secret (security review 2026-09-20)", () => {
    clearProviderEnv();
    process.env.APP_ENV = "preview";
    delete process.env.BILLING_FAKE_WEBHOOK_SECRET;
    // Internet-reachable, no secret of its own: the repository default must
    // never be enough to accept a forged subscription event.
    expect(getBillingProvider().enabled).toBe(false);
    process.env.BILLING_FAKE_WEBHOOK_SECRET = "preview-only-secret-for-this-test";
    expect(getBillingProvider().enabled).toBe(true);
    delete process.env.BILLING_FAKE_WEBHOOK_SECRET;
    // The other two seams are unaffected by this law.
    expect(getEInvoiceProvider().name).toBe("fake");
    expect(getNarrationProvider().enabled).toBe(true);
  });

  it("an explicit real credential still wins in prod (activation path unaffected)", () => {
    clearProviderEnv();
    process.env.APP_ENV = "prod";
    process.env.BILLING_PROVIDER = "fake"; // stands in for a future real provider name
    expect(getBillingProvider().enabled).toBe(true);
  });
});

describe("S10 document-scan seam (doc 10 #27)", () => {
  it("refuses documents in prod until a scanner is provisioned, passes them off-prod", async () => {
    delete process.env.SCAN_PROVIDER;
    process.env.APP_ENV = "prod";
    expect(getDocumentScanner().name).toBe("disabled");
    await expect(assertDocumentClean(Buffer.from("x"), "application/pdf")).rejects.toBeInstanceOf(
      DocumentRejectedError,
    );
    process.env.APP_ENV = "dev";
    expect(getDocumentScanner().name).toBe("passthrough");
    await expect(assertDocumentClean(Buffer.from("x"), "application/pdf")).resolves.toBeUndefined();
  });
});
