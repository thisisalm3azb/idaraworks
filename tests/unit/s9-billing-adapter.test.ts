/**
 * S9 billing adapter seam: the fake provider signs + verifies webhooks (HMAC), round-trips a
 * normalized event, and the disabled provider (production default until D1) refuses every op and
 * never verifies a signature.
 */
import { describe, it, expect } from "vitest";
import {
  fakeBillingProvider,
  disabledBillingProvider,
  getBillingProvider,
  BillingProviderDisabledError,
  type NormalizedEvent,
} from "@/platform/billing/adapter";

const evt: NormalizedEvent = {
  providerEventId: "fake_evt_1",
  eventType: "invoice.paid",
  signal: "activated",
  providerCustomerId: "fake_cus_org1",
  providerSubscriptionId: "fake_sub_org1",
  planKey: "growth",
  billingInterval: "month",
  billingCurrency: "AED",
};

describe("fake billing provider (signature + parse)", () => {
  it("verifies a signature it produced, and rejects a tampered body or signature", () => {
    const { body, signature } = fakeBillingProvider.signEvent(evt);
    expect(fakeBillingProvider.verifySignature(body, signature)).toBe(true);
    expect(fakeBillingProvider.verifySignature(body + "x", signature)).toBe(false);
    expect(fakeBillingProvider.verifySignature(body, signature.slice(0, -2) + "00")).toBe(false);
    expect(fakeBillingProvider.verifySignature(body, "")).toBe(false);
  });

  it("round-trips a normalized event through sign→parse", () => {
    const { body } = fakeBillingProvider.signEvent(evt);
    expect(fakeBillingProvider.parseEvent(body)).toEqual(evt);
  });

  it("mints deterministic customer/subscription ids from the org id", async () => {
    const a = await fakeBillingProvider.createCheckoutSession({
      orgId: "org1",
      planKey: "growth",
      billingInterval: "month",
      currency: "AED",
    });
    expect(a.providerCustomerId).toBe("fake_cus_org1");
    expect(a.providerSubscriptionId).toBe("fake_sub_org1");
  });
});

describe("disabled billing provider (production default until D1)", () => {
  it("never verifies a signature and refuses every outbound op", async () => {
    expect(disabledBillingProvider.enabled).toBe(false);
    const { body, signature } = fakeBillingProvider.signEvent(evt);
    expect(disabledBillingProvider.verifySignature(body, signature)).toBe(false);
    await expect(
      disabledBillingProvider.createCheckoutSession({
        orgId: "o",
        planKey: "growth",
        billingInterval: "month",
        currency: "AED",
      }),
    ).rejects.toBeInstanceOf(BillingProviderDisabledError);
  });
});

describe("getBillingProvider selection", () => {
  it("honours BILLING_PROVIDER=fake / disabled", () => {
    const prev = process.env.BILLING_PROVIDER;
    try {
      process.env.BILLING_PROVIDER = "fake";
      expect(getBillingProvider().enabled).toBe(true);
      process.env.BILLING_PROVIDER = "disabled";
      expect(getBillingProvider().enabled).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.BILLING_PROVIDER;
      else process.env.BILLING_PROVIDER = prev;
    }
  });

  // S10 regression: the prod default gated on APP_ENV === "production" (a value never set;
  // the canonical prod tag is "prod"), so production silently served the FAKE provider.
  it("defaults to DISABLED in production (APP_ENV=prod) and fake off-prod", () => {
    const prevProv = process.env.BILLING_PROVIDER;
    const prevEnv = process.env.APP_ENV;
    try {
      delete process.env.BILLING_PROVIDER;
      process.env.APP_ENV = "prod";
      expect(getBillingProvider().enabled).toBe(false);
      process.env.APP_ENV = "preview";
      expect(getBillingProvider().enabled).toBe(true);
      process.env.APP_ENV = "dev";
      expect(getBillingProvider().enabled).toBe(true);
    } finally {
      if (prevProv === undefined) delete process.env.BILLING_PROVIDER;
      else process.env.BILLING_PROVIDER = prevProv;
      if (prevEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = prevEnv;
    }
  });
});
