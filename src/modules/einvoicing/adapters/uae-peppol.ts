/**
 * H29 — the UAE electronic-invoicing adapter.
 *
 * The UAE model is decentralised and five-cornered: the supplier's Accredited
 * Service Provider sends to the buyer's, and the Federal Tax Authority is the
 * fifth corner. The organisation must appoint an Accredited Service Provider;
 * IdaraWorks is corner 1, not corner 2.
 *
 * So this adapter can build and validate a PINT AE document and can never send
 * one: there is no provider to send it through. It says exactly that rather
 * than pretending to be a network participant.
 *
 * No phase date is encoded anywhere. The Ministry publishes its timeline as an
 * image and Ministerial Decision No. 244 of 2025 could not be read as text, so
 * H29 records the instruments and leaves the date to the organisation
 * (evidence log E7, truth map D2).
 */
import type {
  EInvoiceAdapter,
  PreparedDocument,
  SourceDocument,
  SubmitOutcome,
  ValidationIssue,
} from "./types";
import { sha256Base64 } from "./zatca";

export const UAE_OWNER_ACTION =
  "Appoint a UAE Accredited Service Provider and record its identifier on the channel, together with the establishment's Participant Identifier (the first ten digits of the TRN, or a TIN obtained from the Federal Tax Authority). IdaraWorks is corner 1 of the five-corner model and cannot transmit without corner 2.";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function major(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const d = Math.abs(minor).toString().padStart(3, "0");
  return `${sign}${d.slice(0, -2)}.${d.slice(-2)}`;
}

function validate(document: SourceDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const need = (ok: boolean, code: string, message: string) => {
    if (!ok) issues.push({ severity: "error", code, message });
  };
  need(
    Boolean(document.seller.taxNumber),
    "AE-supplier-tin",
    "The supplier's tax identifier is required.",
  );
  need(document.reference.trim().length > 0, "AE-id", "A document identifier is required.");
  need(document.lines.length > 0, "AE-lines", "At least one line is required.");
  // The guidelines are explicit that a negative payable total must be a credit
  // note rather than an invoice with a negative total.
  if (document.totalMinor < 0 && document.kind !== "tax_credit_note")
    issues.push({
      severity: "error",
      code: "AE-negative-total",
      message: "A negative payable total must be issued as a credit note, not as an invoice.",
    });
  return issues;
}

export const uaePeppolAdapter: EInvoiceAdapter = {
  key: "uae_peppol",
  authority: "UAE Federal Tax Authority, through an Accredited Service Provider",
  countries: ["AE"],
  model: "peppol_network",
  supports: ["tax_invoice", "tax_credit_note", "tax_debit_note"],

  prepare(document): PreparedDocument {
    const issues = validate(document);
    const lines = document.lines
      .map(
        (line, i) => `
    <cac:InvoiceLine>
      <cbc:ID>${i + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="EA">${line.quantity}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${document.currency}">${major(line.lineTotalMinor)}</cbc:LineExtensionAmount>
      <cac:Item><cbc:Name>${escapeXml(line.description)}</cbc:Name></cac:Item>
      <cac:Price><cbc:PriceAmount currencyID="${document.currency}">${major(line.unitPriceMinor)}</cbc:PriceAmount></cac:Price>
    </cac:InvoiceLine>`,
      )
      .join("");
    const payload = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:peppol:pint:billing-1@ae-1</cbc:CustomizationID>
  <cbc:ProfileID>urn:peppol:bis:billing</cbc:ProfileID>
  <cbc:ID>${escapeXml(document.reference)}</cbc:ID>
  <cbc:IssueDate>${document.issuedAt.slice(0, 10)}</cbc:IssueDate>
  <cbc:DocumentCurrencyCode>${document.currency}</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyTaxScheme><cbc:CompanyID>${escapeXml(document.seller.taxNumber ?? "")}</cbc:CompanyID></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>${escapeXml(document.seller.name)}</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyLegalEntity><cbc:RegistrationName>${escapeXml(document.buyer?.name ?? "")}</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="${document.currency}">${major(document.taxTotalMinor)}</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:PayableAmount currencyID="${document.currency}">${major(document.totalMinor)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lines}
</Invoice>`;
    return {
      payload,
      payloadKind: "pint_xml",
      documentHash: sha256Base64(payload),
      // The UAE model carries no QR requirement of its own.
      qrPayload: null,
      issues,
    };
  },

  async submit(): Promise<SubmitOutcome> {
    return { state: "unavailable", ownerAction: UAE_OWNER_ACTION };
  },
};
