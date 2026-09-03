/**
 * H29 — the ZATCA (Fatoora) adapter.
 *
 * Everything the authority publishes and this code can do without a credential
 * is done for real and tested against deterministic fixtures: the UBL 2.1
 * payload, the SHA-256 document hash, the invoice-hash chain, and the QR code
 * in the Tag-Length-Value encoding of the Security Features Implementation
 * Standard v1.2, tags in the order that standard's Table 3 gives them.
 *
 *   1 seller name                       5 VAT total
 *   2 seller VAT registration number    6 hash of the XML invoice (SHA-256)
 *   3 timestamp, ISO 8601               7 ECDSA signature of the XML hash
 *   4 invoice total including VAT       8 ECDSA public key
 *                                       9 signature of the stamp's public key
 *                                         (simplified invoices and their notes)
 *
 * Tags 1 to 5 have been enforced since 4 December 2021 and tags 6 to 9 since
 * 1 January 2023. Tags 7, 8 and 9 exist only once a certificate issued through
 * ZATCA onboarding can sign; without one this adapter emits tags 1 to 6 and
 * says plainly that the stamp is missing. It never fabricates a signature and
 * never fabricates an authority response.
 *
 * Evidence: docs/H29-EVIDENCE-LOG.md B2, B4–B8.
 */
import { createHash } from "node:crypto";
import type {
  AdapterContext,
  EInvoiceAdapter,
  PreparedDocument,
  SourceDocument,
  SubmitOutcome,
  ValidationIssue,
} from "./types";

/** The owner action that would make submission possible, stated once. */
export const ZATCA_OWNER_ACTION =
  "Obtain a compliance CSID through the ZATCA Fatoora portal with a one-time password, then a production CSID and its secret, and record the credential name on the channel. Until then nothing is submitted and no response is simulated.";

// ── TLV, exactly as the standard defines it ────────────────────────────────

/**
 * One tag: the tag byte, the length of the UTF-8 value as an unsigned 8-bit
 * integer, then the value's bytes. A value longer than 255 bytes cannot be
 * encoded, so it is rejected rather than truncated into something wrong.
 */
export function tlv(tag: number, value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (bytes.length > 255)
    throw new RangeError(`TLV tag ${tag}: ${bytes.length} bytes exceeds the single-byte length`);
  return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
}

/** The QR payload: the TLV tuples concatenated, then Base64. */
export function encodeQr(parts: Array<{ tag: number; value: Buffer | string }>): string {
  return Buffer.concat(parts.map((p) => tlv(p.tag, p.value))).toString("base64");
}

/** Amounts are printed as decimal strings, which is what the QR carries. */
function major(minor: number, exponent = 2): string {
  const sign = minor < 0 ? "-" : "";
  const digits = Math.abs(minor)
    .toString()
    .padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : "";
  return `${sign}${whole}${fraction}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── the payload ────────────────────────────────────────────────────────────

/**
 * A UBL 2.1 invoice carrying the fields Article 53(5) and 53(8) require and the
 * ZATCA-specific identifiers. It is deliberately minimal and deterministic:
 * this is the shape the contract tests pin, not a claim of full conformance
 * with every business rule in the XML implementation standard.
 */
function buildUbl(document: SourceDocument, ctx: AdapterContext, uuid: string): string {
  const type =
    document.kind === "tax_credit_note"
      ? "381"
      : document.kind === "tax_debit_note"
        ? "383"
        : "388";
  const simplified = document.kind === "simplified_tax_invoice";
  const lines = document.lines
    .map(
      (line, i) => `
    <cac:InvoiceLine>
      <cbc:ID>${i + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="PCE">${line.quantity}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${document.currency}">${major(line.lineTotalMinor)}</cbc:LineExtensionAmount>
      <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${document.currency}">${major(line.taxAmountMinor)}</cbc:TaxAmount>
      </cac:TaxTotal>
      <cac:Item><cbc:Name>${escapeXml(line.description)}</cbc:Name></cac:Item>
      <cac:Price><cbc:PriceAmount currencyID="${document.currency}">${major(line.unitPriceMinor)}</cbc:PriceAmount></cac:Price>
    </cac:InvoiceLine>`,
    )
    .join("");

  const address = (a: Record<string, string>) => `
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(a.street ?? "")}</cbc:StreetName>
        <cbc:BuildingNumber>${escapeXml(a.buildingNumber ?? "")}</cbc:BuildingNumber>
        <cbc:CitySubdivisionName>${escapeXml(a.district ?? "")}</cbc:CitySubdivisionName>
        <cbc:CityName>${escapeXml(a.city ?? "")}</cbc:CityName>
        <cbc:PostalZone>${escapeXml(a.postalCode ?? "")}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${escapeXml(document.reference)}</cbc:ID>
  <cbc:UUID>${uuid}</cbc:UUID>
  <cbc:IssueDate>${document.issuedAt.slice(0, 10)}</cbc:IssueDate>
  <cbc:IssueTime>${document.issuedAt.slice(11, 19)}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${simplified ? "0200000" : "0100000"}">${type}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${document.currency}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${ctx.counter}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${ctx.previousHash ?? ""}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyTaxScheme><cbc:CompanyID>${escapeXml(document.seller.taxNumber ?? "")}</cbc:CompanyID></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>${escapeXml(document.seller.name)}</cbc:RegistrationName></cac:PartyLegalEntity>${address(document.seller.address)}
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyTaxScheme><cbc:CompanyID>${escapeXml(document.buyer?.taxNumber ?? "")}</cbc:CompanyID></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>${escapeXml(document.buyer?.name ?? "")}</cbc:RegistrationName></cac:PartyLegalEntity>${address(document.buyer?.address ?? {})}
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${document.currency}">${major(document.taxTotalMinor)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:TaxInclusiveAmount currencyID="${document.currency}">${major(document.totalMinor)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${document.currency}">${major(document.totalMinor)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lines}
</Invoice>`;
}

/** SHA-256 of the payload, Base64 — the transform the standard names. */
export function sha256Base64(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("base64");
}

/** A deterministic UUID for a document, so preparing twice gives one identity. */
function documentUuid(document: SourceDocument): string {
  const hex = createHash("sha256").update(`${document.kind}:${document.id}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    // Version 8: a name-based UUID this platform generated, not a random one.
    `8${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

// ── validation against what the authority requires ─────────────────────────

function validate(document: SourceDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const need = (ok: boolean, code: string, message: string) => {
    if (!ok) issues.push({ severity: "error", code, message });
  };

  // Article 53(5) and 53(8): the fields every Saudi tax document must carry.
  need(document.issuedAt.length >= 10, "BR-KSA-issue-date", "The date of issue is required.");
  need(
    document.reference.trim().length > 0,
    "BR-KSA-sequential-number",
    "A sequential number that uniquely identifies the document is required.",
  );
  need(
    Boolean(document.seller.taxNumber),
    "BR-KSA-supplier-tin",
    "The supplier's tax identification number is required.",
  );
  need(
    document.seller.name.trim().length > 0,
    "BR-KSA-supplier-name",
    "The supplier's name is required.",
  );
  need(
    Object.values(document.seller.address).some((v) => (v ?? "").trim().length > 0),
    "BR-KSA-supplier-address",
    "The supplier's address is required.",
  );
  need(
    document.lines.length > 0,
    "BR-KSA-lines",
    "A description of the goods or services is required.",
  );
  need(document.currency.length === 3, "BR-KSA-currency", "A currency is required.");

  if (document.kind === "tax_invoice") {
    // A standard tax invoice identifies its buyer; a simplified one need not.
    need(
      Boolean(document.buyer?.name),
      "BR-KSA-customer-name",
      "A standard tax invoice must name the customer.",
    );
    need(
      Object.values(document.buyer?.address ?? {}).some((v) => (v ?? "").trim().length > 0),
      "BR-KSA-customer-address",
      "A standard tax invoice must carry the customer's address.",
    );
  }
  if (document.kind === "tax_credit_note" || document.kind === "tax_debit_note") {
    need(
      Boolean(document.correctsReference),
      "BR-KSA-corrects",
      "A note must reference the document it corrects.",
    );
    need(Boolean(document.correctionReason), "BR-KSA-reason", "A note must state its reason.");
  }

  const lineTax = document.lines.reduce((n, l) => n + l.taxAmountMinor, 0);
  if (lineTax !== document.taxTotalMinor)
    issues.push({
      severity: "error",
      code: "BR-KSA-tax-total",
      message: `The tax total (${document.taxTotalMinor}) does not equal the sum of the line tax (${lineTax}).`,
    });
  return issues;
}

// ── the adapter ────────────────────────────────────────────────────────────

export const zatcaAdapter: EInvoiceAdapter = {
  key: "zatca",
  authority: "Zakat, Tax and Customs Authority (ZATCA)",
  countries: ["SA"],
  model: "clearance",
  supports: ["tax_invoice", "simplified_tax_invoice", "tax_credit_note", "tax_debit_note"],

  prepare(document, ctx): PreparedDocument {
    const issues = validate(document);
    const uuid = documentUuid(document);
    const payload = buildUbl(document, ctx, uuid);
    const documentHash = sha256Base64(payload);

    // Tags 1 to 6 are everything this platform can produce on its own. Tags 7,
    // 8 and 9 need a certificate issued through ZATCA onboarding, so their
    // absence is reported rather than filled with a placeholder.
    const parts = [
      { tag: 1, value: document.seller.name },
      { tag: 2, value: document.seller.taxNumber ?? "" },
      { tag: 3, value: document.issuedAt },
      { tag: 4, value: major(document.totalMinor) },
      { tag: 5, value: major(document.taxTotalMinor) },
      { tag: 6, value: Buffer.from(documentHash, "base64") },
    ];
    if (!ctx.credentialPresent)
      issues.push({
        severity: "warning",
        code: "stamp-missing",
        message:
          "The cryptographic stamp and its QR tags are absent: no certificate has been issued through ZATCA onboarding.",
      });

    // The FIRST document in a chain has no previous invoice hash, and the value
    // ZATCA requires in that position could not be read from a primary source —
    // evidence log B5 records the TRANSFORM (SHA-256), not the initial value.
    // Inventing one would be exactly the fabrication the mandate forbids, so the
    // element is left empty and the gap is reported on the document itself
    // rather than discovered by an authority later.
    if (!ctx.previousHash)
      issues.push({
        severity: "warning",
        code: "pih-initial-unknown",
        message:
          "First document in its chain: the previous-invoice-hash value ZATCA requires in that position is not encoded. Confirm it from the Security Features Implementation Standards before any submission.",
      });

    return {
      payload,
      payloadKind: "ubl_xml",
      documentHash,
      qrPayload: encodeQr(parts),
      issues,
    };
  },

  async submit(_prepared, ctx): Promise<SubmitOutcome> {
    // Fail closed, always, and say what would change it. No branch of this
    // function can reach a network without a credential, and none invents a
    // response when it cannot.
    if (!ctx.credentialPresent || !ctx.credentialRef)
      return { state: "unavailable", ownerAction: ZATCA_OWNER_ACTION };
    return {
      state: "unavailable",
      ownerAction:
        "A credential is recorded, but submission to ZATCA is not enabled in this release. The clearance and reporting calls are the next step and need the owner's explicit approval.",
    };
  },
};
