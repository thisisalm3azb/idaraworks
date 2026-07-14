/**
 * The provider-neutral billing adapter seam (S9; v1 §13 merchant-of-record is the open D1
 * decision). Mirrors the e-invoice (S6) and AI-narration (S7) seams: a provider-agnostic
 * interface, a deterministic FAKE provider for dev/tests/the DoD demo, and a DISABLED provider
 * that ships in production until D1 closes and real credentials arrive.
 *
 * D1 boundary: NO real processor is wired here. The fake provider does no network I/O, stores no
 * card data, and mints deterministic ids + HMAC-signed webhook payloads so the whole lifecycle is
 * exercisable end-to-end without a merchant account. Enabling a real provider is an ACTIVATION
 * step (supply secrets + a real adapter impl behind the same interface) — no schema/logic change.
 *
 * Webhook rule (v1 §13 / doc 10 gap closed): a webhook only drives state when its signature
 * VERIFIES. verifySignature is HMAC-SHA256 over the raw body; an unverified event is recorded as
 * 'unverified' and never transitions state.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type ProviderName = "fake" | "stripe" | "paddle" | "lemonsqueezy" | "tap" | "moyasar";

/**
 * The normalized signal vocabulary an adapter maps each processor's raw event onto. Lives in the
 * platform layer (the adapter produces it) so the subscription module can import it without the
 * platform ever importing a module (BUILD_BIBLE §3.3). The state machine consumes these.
 */
export type SubscriptionSignal =
  | "activated" // payment succeeded / trial converted / reactivated
  | "payment_failed" // a charge failed
  | "payment_recovered" // a retry or manual payment succeeded
  | "canceled" // customer or provider cancelled the subscription
  | "trial_ended" // trial window elapsed with no conversion (lifecycle worker or provider)
  | "grace_elapsed" // dunning/grace window elapsed (lifecycle worker)
  | "purge_due" // read-only window elapsed → schedule purge (lifecycle worker)
  | "purged"; // purge executed (purge worker)

/** A normalized provider webhook event — every processor's raw event maps onto this shape. */
export type NormalizedEvent = {
  providerEventId: string;
  eventType: string; // the provider's raw type, for the audit trail
  signal: SubscriptionSignal; // mapped onto our state-machine vocabulary
  providerCustomerId: string | null; // resolves the org
  providerSubscriptionId: string | null;
  planKey: string | null;
  billingInterval: "month" | "year" | null;
  billingCurrency: string | null;
};

export type CheckoutInput = {
  orgId: string;
  planKey: string;
  billingInterval: "month" | "year";
  currency: string;
};
export type CheckoutResult = {
  url: string;
  providerCustomerId: string;
  providerSubscriptionId: string;
};

export interface BillingProvider {
  readonly id: ProviderName;
  readonly enabled: boolean;
  /** Start a checkout. Real impls return a redirect URL; the fake returns a sentinel + minted ids. */
  createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult>;
  /** Open the provider's billing portal (manage card / cancel). */
  createPortalSession(input: {
    orgId: string;
    providerCustomerId: string;
  }): Promise<{ url: string }>;
  /** Request cancellation (at period end). The authoritative state change arrives via webhook. */
  cancelSubscription(input: {
    providerSubscriptionId: string;
    atPeriodEnd: boolean;
  }): Promise<void>;
  /** Verify an inbound webhook signature (HMAC-SHA256 over the raw body). */
  verifySignature(rawBody: string, signature: string): boolean;
  /** Parse a raw (already signature-verified) webhook body into a normalized event. */
  parseEvent(rawBody: string): NormalizedEvent;
}

export class BillingProviderDisabledError extends Error {
  constructor(op: string) {
    super(`billing provider disabled (commercial activation pending D1): ${op}`);
    this.name = "BillingProviderDisabledError";
  }
}

/** Test/dev HMAC secret. In prod a real provider uses its own signing secret from the secret store. */
const FAKE_SECRET = process.env.BILLING_FAKE_WEBHOOK_SECRET ?? "idaraworks/fake-billing/dev-secret";

function hmac(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Deterministic, network-free provider. Mints stable ids from the org id so re-runs converge, and
 * signs webhook payloads so signature verification is genuinely exercised. `signEvent` is a test/
 * demo helper (NOT part of the interface) that produces a `{ body, signature }` pair a caller can
 * feed to the webhook processor — modelling "provider → webhook" without a network.
 */
export const fakeBillingProvider: BillingProvider & {
  signEvent: (e: NormalizedEvent) => { body: string; signature: string };
} = {
  id: "fake",
  enabled: true,
  async createCheckoutSession(input) {
    return {
      url: `https://fake-billing.local/checkout?org=${input.orgId}&plan=${input.planKey}`,
      providerCustomerId: `fake_cus_${input.orgId}`,
      providerSubscriptionId: `fake_sub_${input.orgId}`,
    };
  },
  async createPortalSession(input) {
    return { url: `https://fake-billing.local/portal?cus=${input.providerCustomerId}` };
  },
  async cancelSubscription() {
    // No-op: the fake caller emits the resulting `canceled` webhook via signEvent().
  },
  verifySignature(rawBody, signature) {
    const expected = hmac(rawBody, FAKE_SECRET);
    // Constant-time compare; guard against length-mismatch throwing in timingSafeEqual.
    const a = Buffer.from(expected);
    const b = Buffer.from(signature ?? "");
    return a.length === b.length && timingSafeEqual(a, b);
  },
  parseEvent(rawBody) {
    return NormalizedEventShape(JSON.parse(rawBody));
  },
  signEvent(e) {
    const body = JSON.stringify(e);
    return { body, signature: hmac(body, FAKE_SECRET) };
  },
};

/** The production default until D1: every outbound op refuses; no webhook ever verifies. */
export const disabledBillingProvider: BillingProvider = {
  id: "fake",
  enabled: false,
  async createCheckoutSession() {
    throw new BillingProviderDisabledError("createCheckoutSession");
  },
  async createPortalSession() {
    throw new BillingProviderDisabledError("createPortalSession");
  },
  async cancelSubscription() {
    throw new BillingProviderDisabledError("cancelSubscription");
  },
  verifySignature() {
    return false; // no inbound webhook is ever accepted while disabled
  },
  parseEvent() {
    throw new BillingProviderDisabledError("parseEvent");
  },
};

/** Coerce an unknown parsed object into a NormalizedEvent (defensive at the webhook boundary). */
function NormalizedEventShape(o: unknown): NormalizedEvent {
  const r = (o ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const interval =
    r.billingInterval === "month" || r.billingInterval === "year" ? r.billingInterval : null;
  return {
    providerEventId: String(r.providerEventId ?? ""),
    eventType: String(r.eventType ?? ""),
    signal: r.signal as SubscriptionSignal,
    providerCustomerId: str(r.providerCustomerId),
    providerSubscriptionId: str(r.providerSubscriptionId),
    planKey: str(r.planKey),
    billingInterval: interval,
    billingCurrency: str(r.billingCurrency),
  };
}

/**
 * Provider selector (mirrors getNarrationProvider): the FAKE provider off-production (dev + tests +
 * demo), the DISABLED provider in production until BILLING_PROVIDER names a real, credentialed one.
 * A real provider is added here behind the same interface at D1 activation.
 */
export function getBillingProvider(): BillingProvider {
  const explicit = process.env.BILLING_PROVIDER;
  if (explicit === "fake") return fakeBillingProvider;
  if (explicit === "disabled") return disabledBillingProvider;
  // Default: fake off-prod so the lifecycle is fully exercisable; disabled in production (D1 gate).
  return process.env.APP_ENV === "production" ? disabledBillingProvider : fakeBillingProvider;
}
