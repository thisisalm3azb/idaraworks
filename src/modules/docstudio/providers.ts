/**
 * H26 — signature provider adapters (ADR-23).
 *
 * The room talks to a provider through this seam. `native` captures an
 * electronic signature inside IdaraWorks with an evidence record. Providers
 * that deliver certificate-backed (advanced / qualified) signatures are
 * declared here so the shape exists, but none is provisioned: selecting one
 * fails closed with the exact owner action. Nothing ever simulates a
 * provider result.
 */
import { DocError } from "./types";
import type { Locale } from "@/platform/registries";

export type SignatureLegalLevel = "electronic" | "advanced" | "qualified";

export type ProviderCapabilities = {
  /** What the provider genuinely delivers; copy must not claim more (truth map C). */
  legalLevel: SignatureLegalLevel;
  certificate: boolean;
  qualifiedTimestamp: boolean;
  /** The signer draws or types inside our page (native) or is redirected (external). */
  captureInApp: boolean;
};

export type SignatureProvider = {
  name: string;
  capabilities: ProviderCapabilities;
  /** Lines the evidence record prints about how the signature was produced. */
  evidenceLines: (locale: Locale) => string[];
};

export const NATIVE_PROVIDER: SignatureProvider = {
  name: "native",
  capabilities: {
    legalLevel: "electronic",
    certificate: false,
    qualifiedTimestamp: false,
    captureInApp: true,
  },
  evidenceLines: (locale) =>
    locale === "ar"
      ? [
          "المزود: IdaraWorks (توقيع إلكتروني مع سجل إثبات)",
          "التحقق: دعوة لمرة واحدة أو جلسة عضو؛ لا شهادة رقمية ولا ختم زمني معتمد",
        ]
      : [
          "Provider: IdaraWorks native (electronic signature with an evidence record)",
          "Verification: one-time invitation or member session; no digital certificate, no qualified time stamp",
        ],
};

/** Declared, not provisioned. Owner action required before any can be chosen. */
export const EXTERNAL_PROVIDERS: Record<
  string,
  { label: string; ownerAction: string; capabilities: ProviderCapabilities }
> = {
  uae_pass: {
    label: "UAE PASS (TDRA-licensed trust service)",
    ownerAction:
      "Obtain UAE PASS integration credentials from the TDRA-licensed provider and set SIGNATURE_PROVIDER_UAE_PASS_CLIENT_ID / _SECRET; then set documents.signatureProvider = uae_pass.",
    capabilities: {
      legalLevel: "qualified",
      certificate: true,
      qualifiedTimestamp: true,
      captureInApp: false,
    },
  },
};

export const PROVIDER_NAMES = ["native", ...Object.keys(EXTERNAL_PROVIDERS)] as const;

/** The provider for a name. Anything but `native` fails closed. */
export function getSignatureProvider(name: string): SignatureProvider {
  if (name === "native") return NATIVE_PROVIDER;
  const ext = EXTERNAL_PROVIDERS[name];
  if (ext) {
    throw new DocError(
      `signature provider "${name}" is not provisioned. Owner action: ${ext.ownerAction}`,
      "unavailable",
    );
  }
  throw new DocError(`unknown signature provider "${name}"`, "validation");
}

/** The consent text version signers accept; bump when the wording changes. */
export const CONSENT_VERSION = "h26-consent-1";

export const CONSENT_TEXT: Record<"en" | "ar", string> = {
  en: "I agree to sign this document electronically. My typed or drawn signature, the time of signing, my network address and the document's content hash will be recorded as evidence.",
  ar: "أوافق على توقيع هذا المستند إلكترونياً. سيُسجَّل توقيعي المكتوب أو المرسوم ووقت التوقيع وعنوان الشبكة وبصمة محتوى المستند كإثبات.",
};
