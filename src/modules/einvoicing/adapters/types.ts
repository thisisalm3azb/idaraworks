/**
 * H29 — the electronic-invoicing adapter contract (ADR-72, ADR-73).
 *
 * One framework, many authorities. An adapter knows how to turn a business
 * document into whatever its authority expects, how to validate it, and how to
 * submit it. It never invents a response: with no credential it reports
 * `unavailable` and names the owner action, which is a different thing from a
 * failure.
 */

export type EInvoiceEnvironment = "sandbox" | "production";

/** What a business document looks like to an adapter, whatever module owns it. */
export type SourceDocument = {
  kind: "tax_invoice" | "simplified_tax_invoice" | "tax_credit_note" | "tax_debit_note";
  id: string;
  reference: string;
  issuedAt: string;
  currency: string;
  /** Minor units, as everywhere else in the platform. */
  totalMinor: number;
  taxTotalMinor: number;
  seller: {
    name: string;
    taxNumber: string | null;
    address: Record<string, string>;
  };
  buyer: {
    name: string | null;
    taxNumber: string | null;
    address: Record<string, string>;
  } | null;
  lines: Array<{
    description: string;
    quantity: number;
    unitPriceMinor: number;
    taxRatePercent: number;
    taxAmountMinor: number;
    lineTotalMinor: number;
  }>;
  /** For a credit or debit note, the document it corrects. */
  correctsReference?: string;
  correctionReason?: string;
};

export type ValidationIssue = {
  severity: "error" | "warning";
  /** The field or rule the authority names. */
  code: string;
  /** Plain words, in English; surfaces render their own message keys. */
  message: string;
};

/** What the adapter produced for one document, before anything is sent. */
export type PreparedDocument = {
  /** The authority's own payload, as text. */
  payload: string;
  payloadKind: "ubl_xml" | "pint_xml" | "json";
  /** SHA-256 of the payload, base64, when the authority specifies one. */
  documentHash: string | null;
  /** The QR the document must carry, when the authority specifies one. */
  qrPayload: string | null;
  issues: ValidationIssue[];
};

export type SubmitOutcome =
  | {
      state: "unavailable";
      /** The exact action that would make submission possible. */
      ownerAction: string;
    }
  | { state: "accepted"; authorityReference: string; response: unknown }
  | { state: "rejected"; code: string; message: string; response: unknown }
  | { state: "warning"; code: string; message: string; response: unknown }
  | { state: "retry"; code: string; message: string };

export type AdapterContext = {
  environment: EInvoiceEnvironment;
  /** The NAME of the credential, never its value. Null means none is set. */
  credentialRef: string | null;
  /** Whether the credential actually resolves in this deployment. */
  credentialPresent: boolean;
  /** The chain position and the hash before this one. */
  counter: number;
  previousHash: string | null;
};

export type EInvoiceAdapter = {
  key: string;
  /** The authority, in its own name. */
  authority: string;
  /** Countries this adapter serves. */
  countries: string[];
  /** Whether the authority clears before delivery or takes a report after. */
  model: "clearance" | "reporting" | "peppol_network";
  /** Document kinds the adapter can carry. */
  supports: SourceDocument["kind"][];
  /** Build and validate. Pure: no network, no credential needed. */
  prepare(document: SourceDocument, ctx: AdapterContext): PreparedDocument;
  /**
   * Send. Every implementation must return `unavailable` when the credential is
   * absent rather than attempting a call or inventing a result.
   */
  submit(prepared: PreparedDocument, ctx: AdapterContext): Promise<SubmitOutcome>;
};
