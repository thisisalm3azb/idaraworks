/**
 * The e-invoice adapter seam (decision D4; audit FR-16). A provider-agnostic contract
 * so the invoicing code never depends on a specific tax authority / clearance partner.
 * S6 ships and TESTS against the FAKE provider (deterministic clearance) — real
 * partner submission is credential-gated (owner action OP-3): with no provider
 * configured, `getEInvoiceProvider` returns the disabled provider, which records a
 * gated no-op instead of contacting any government portal. No secrets here — provider
 * credentials live in the platform secret store (BUILD_BIBLE §6.3/§6.4), never in code.
 */
import { logger } from "@/platform/logger";
import { isProd } from "@/platform/env";

export type EInvoicePayload = {
  invoiceId: string;
  reference: string;
  kind: "invoice" | "credit_note";
  correctsReference: string | null;
  customerName: string | null;
  customerTaxRegNo: string | null;
  currency: string;
  isExport: boolean;
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  issuedAt: string;
};

export type EInvoiceResult = {
  status: "submitted" | "cleared" | "rejected";
  externalId: string | null;
  clearedAt: string | null;
  /** Provider-supplied clearance QR (TLV/base64) to embed on the KSA tax invoice (F-43). */
  qr: string | null;
  error: string | null;
};

export interface EInvoiceProvider {
  readonly name: string;
  readonly enabled: boolean;
  submit(payload: EInvoicePayload): Promise<EInvoiceResult>;
}

/**
 * The FAKE provider: deterministic clearance for tests + the S6 demo. It performs the
 * SAME validation shape a real provider would (rejects a missing tax reg on a
 * non-export domestic supply) so the adapter-contract tests exercise clear + reject.
 */
export const fakeEInvoiceProvider: EInvoiceProvider = {
  name: "fake",
  enabled: true,
  async submit(payload) {
    // A real GCC provider rejects a domestic (non-export) taxable invoice with no
    // buyer tax registration; mirror that so the reject path is contract-tested.
    if (!payload.isExport && payload.vatMinor > 0 && !payload.customerTaxRegNo) {
      return {
        status: "rejected",
        externalId: null,
        clearedAt: null,
        qr: null,
        error: "buyer tax registration required for a domestic taxable supply",
      };
    }
    // Deterministic pseudo-clearance id derived from the invoice id (no randomness).
    const externalId = `FAKE-${payload.invoiceId.replace(/-/g, "").slice(0, 16).toUpperCase()}`;
    const qr = Buffer.from(
      `${payload.reference}|${payload.totalMinor}|${payload.currency}`,
    ).toString("base64");
    return { status: "cleared", externalId, clearedAt: payload.issuedAt, qr, error: null };
  },
};

/** The disabled provider — used when no real partner is configured (owner action). */
const disabledProvider: EInvoiceProvider = {
  name: "disabled",
  enabled: false,
  async submit(payload) {
    logger.info(
      { invoiceId: payload.invoiceId, provider: "disabled" },
      "e-invoice submission skipped — no provider configured (owner action OP-3; runbooks/einvoice-provisioning.md)",
    );
    return { status: "pending", externalId: null, clearedAt: null, qr: null, error: null } as never;
  },
};

/**
 * Resolve the active provider. In tests + the S6 demo the fake provider is used
 * (EINVOICE_PROVIDER=fake, the default in non-production). A real provider slots in
 * here once its adapter + credentials exist; until then production is 'disabled'.
 */
export function getEInvoiceProvider(): EInvoiceProvider {
  const configured = process.env.EINVOICE_PROVIDER;
  if (configured === "fake") return fakeEInvoiceProvider;
  // Default: fake outside production (so CI/dev/demo clear), disabled in production
  // until a real partner + credentials are provisioned.
  if (isProd() && !configured) return disabledProvider;
  return fakeEInvoiceProvider;
}
