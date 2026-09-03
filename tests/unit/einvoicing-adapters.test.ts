/**
 * H29 — contract tests for the electronic-invoicing adapters, against the
 * published standards and deterministic fixtures. Nothing here reaches a
 * network, and the tests prove that nothing could.
 */
import { describe, expect, it } from "vitest";
import {
  UAE_OWNER_ACTION,
  ZATCA_OWNER_ACTION,
  adapterFor,
  adaptersForCountry,
  credentialPresent,
  encodeQr,
  sha256Base64,
  tlv,
  type AdapterContext,
  type SourceDocument,
} from "@/modules/einvoicing/service";

const NO_CREDENTIAL: AdapterContext = {
  environment: "production",
  credentialRef: null,
  credentialPresent: false,
  counter: 1,
  previousHash: null,
};

const SAUDI_INVOICE: SourceDocument = {
  kind: "tax_invoice",
  id: "11111111-2222-3333-4444-555555555555",
  reference: "INV-000123",
  issuedAt: "2026-09-03T10:15:30Z",
  currency: "SAR",
  totalMinor: 11_500,
  taxTotalMinor: 1_500,
  seller: {
    name: "Najd Trading Company",
    taxNumber: "310122393500003",
    address: {
      buildingNumber: "8228",
      street: "King Fahd Road",
      district: "Al Olaya",
      city: "Riyadh",
      postalCode: "12345",
    },
  },
  buyer: {
    name: "Gulf Marine Works",
    taxNumber: "300000000000003",
    address: {
      buildingNumber: "1234",
      street: "Prince Sultan Road",
      city: "Jeddah",
      postalCode: "23456",
    },
  },
  lines: [
    {
      description: "Hull inspection service",
      quantity: 1,
      unitPriceMinor: 10_000,
      taxRatePercent: 15,
      taxAmountMinor: 1_500,
      lineTotalMinor: 10_000,
    },
  ],
};

describe("TLV, as the ZATCA security standard defines it", () => {
  it("writes the tag, the length as one byte, then the UTF-8 value", () => {
    const encoded = tlv(1, "AB");
    expect([...encoded]).toEqual([1, 2, 0x41, 0x42]);
  });

  it("counts BYTES, not characters, so an Arabic seller name is measured correctly", () => {
    // "شركة" is four characters and eight UTF-8 bytes.
    const encoded = tlv(1, "شركة");
    expect(encoded[0]).toBe(1);
    expect(encoded[1]).toBe(8);
    expect(encoded.length).toBe(10);
  });

  it("refuses a value that cannot fit a single-byte length rather than truncating it", () => {
    expect(() => tlv(1, "x".repeat(256))).toThrow(/exceeds the single-byte length/);
    expect(() => tlv(1, "x".repeat(255))).not.toThrow();
  });

  it("concatenates the tuples and Base64-encodes the result", () => {
    const qr = encodeQr([
      { tag: 1, value: "A" },
      { tag: 2, value: "B" },
    ]);
    expect(Buffer.from(qr, "base64").toString("hex")).toBe("010141020142");
    expect([...Buffer.from(qr, "base64")]).toEqual([1, 1, 0x41, 2, 1, 0x42]);
  });
});

describe("the ZATCA adapter", () => {
  const zatca = adapterFor("zatca")!;

  it("serves Saudi Arabia and clears rather than reports", () => {
    expect(zatca.countries).toEqual(["SA"]);
    expect(zatca.model).toBe("clearance");
    expect(adaptersForCountry("SA").map((a) => a.key)).toEqual(["zatca"]);
  });

  it("builds a UBL 2.1 invoice carrying the identifiers the standard names", () => {
    const prepared = zatca.prepare(SAUDI_INVOICE, NO_CREDENTIAL);
    expect(prepared.payloadKind).toBe("ubl_xml");
    expect(prepared.payload).toContain("urn:oasis:names:specification:ubl:schema:xsd:Invoice-2");
    expect(prepared.payload).toContain("<cbc:ID>INV-000123</cbc:ID>");
    expect(prepared.payload).toContain("<cbc:ID>ICV</cbc:ID>");
    expect(prepared.payload).toContain("<cbc:ID>PIH</cbc:ID>");
    // 388 is an invoice; a credit note is 381.
    expect(prepared.payload).toContain(">388<");
    expect(
      zatca.prepare(
        {
          ...SAUDI_INVOICE,
          kind: "tax_credit_note",
          correctsReference: "INV-000100",
          correctionReason: "Return",
        },
        NO_CREDENTIAL,
      ).payload,
    ).toContain(">381<");
  });

  it("hashes the payload with SHA-256 and puts the raw digest in QR tag 6", () => {
    const prepared = zatca.prepare(SAUDI_INVOICE, NO_CREDENTIAL);
    expect(prepared.documentHash).toBe(sha256Base64(prepared.payload));
    const bytes = Buffer.from(prepared.qrPayload!, "base64");
    // Walk the TLV structure and pull tag 6 out of it.
    const tags = new Map<number, Buffer>();
    let i = 0;
    while (i < bytes.length) {
      const tag = bytes[i]!;
      const length = bytes[i + 1]!;
      tags.set(tag, bytes.subarray(i + 2, i + 2 + length));
      i += 2 + length;
    }
    expect(tags.get(6)!.length).toBe(32);
    expect(tags.get(6)!.toString("base64")).toBe(prepared.documentHash);
  });

  it("puts the tags in the order the standard's table gives them", () => {
    const prepared = zatca.prepare(SAUDI_INVOICE, NO_CREDENTIAL);
    const bytes = Buffer.from(prepared.qrPayload!, "base64");
    const order: number[] = [];
    let i = 0;
    while (i < bytes.length) {
      order.push(bytes[i]!);
      i += 2 + bytes[i + 1]!;
    }
    expect(order).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("carries the seller, the tax number, the timestamp and both totals", () => {
    const prepared = zatca.prepare(SAUDI_INVOICE, NO_CREDENTIAL);
    const bytes = Buffer.from(prepared.qrPayload!, "base64");
    const values: string[] = [];
    let i = 0;
    while (i < bytes.length) {
      const length = bytes[i + 1]!;
      values.push(bytes.subarray(i + 2, i + 2 + length).toString("utf8"));
      i += 2 + length;
    }
    expect(values[0]).toBe("Najd Trading Company");
    expect(values[1]).toBe("310122393500003");
    expect(values[2]).toBe("2026-09-03T10:15:30Z");
    expect(values[3]).toBe("115.00");
    expect(values[4]).toBe("15.00");
  });

  it("says the cryptographic stamp is missing rather than inventing tags 7 to 9", () => {
    const prepared = zatca.prepare(SAUDI_INVOICE, NO_CREDENTIAL);
    const warning = prepared.issues.find((i) => i.code === "stamp-missing");
    expect(warning?.severity).toBe("warning");
    expect(prepared.qrPayload).not.toContain("SIGNATURE");
  });

  it("chains each document to the hash of the one before it", () => {
    const first = zatca.prepare(SAUDI_INVOICE, NO_CREDENTIAL);
    const second = zatca.prepare(
      { ...SAUDI_INVOICE, id: "22222222-2222-3333-4444-555555555555", reference: "INV-000124" },
      { ...NO_CREDENTIAL, counter: 2, previousHash: first.documentHash },
    );
    expect(second.payload).toContain(first.documentHash!);
    expect(second.documentHash).not.toBe(first.documentHash);
  });

  it("reports the unknown initial previous-invoice-hash rather than inventing one", () => {
    // Evidence log B5 records the TRANSFORM ZATCA uses for the previous invoice
    // hash, not the value a chain's FIRST document must carry. A guess there is
    // a fabricated value an authority would check, so the gap is reported on the
    // document and the element is left empty.
    const first = zatca.prepare(SAUDI_INVOICE, NO_CREDENTIAL);
    expect(first.issues.map((i) => i.code)).toContain("pih-initial-unknown");
    expect(first.issues.find((i) => i.code === "pih-initial-unknown")?.severity).toBe("warning");

    // A document that HAS a predecessor carries no such warning.
    const second = zatca.prepare(
      { ...SAUDI_INVOICE, id: "33333333-2222-3333-4444-555555555555", reference: "INV-000125" },
      { ...NO_CREDENTIAL, counter: 2, previousHash: first.documentHash },
    );
    expect(second.issues.map((i) => i.code)).not.toContain("pih-initial-unknown");
  });

  it("is deterministic: the same document prepared twice is byte-identical", () => {
    const a = zatca.prepare(SAUDI_INVOICE, NO_CREDENTIAL);
    const b = zatca.prepare(SAUDI_INVOICE, NO_CREDENTIAL);
    expect(a.payload).toBe(b.payload);
    expect(a.qrPayload).toBe(b.qrPayload);
  });

  it("enforces the Article 53(5) fields a standard tax invoice must carry", () => {
    const noTin = zatca.prepare(
      { ...SAUDI_INVOICE, seller: { ...SAUDI_INVOICE.seller, taxNumber: null } },
      NO_CREDENTIAL,
    );
    expect(noTin.issues.map((i) => i.code)).toContain("BR-KSA-supplier-tin");

    const noBuyer = zatca.prepare({ ...SAUDI_INVOICE, buyer: null }, NO_CREDENTIAL);
    expect(noBuyer.issues.map((i) => i.code)).toContain("BR-KSA-customer-name");

    // A simplified invoice need not name its customer, which is the difference
    // between Article 53(5) and 53(8).
    const simplified = zatca.prepare(
      { ...SAUDI_INVOICE, kind: "simplified_tax_invoice", buyer: null },
      NO_CREDENTIAL,
    );
    expect(simplified.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("catches a tax total that does not equal the sum of the lines", () => {
    const wrong = zatca.prepare({ ...SAUDI_INVOICE, taxTotalMinor: 1_400 }, NO_CREDENTIAL);
    const issue = wrong.issues.find((i) => i.code === "BR-KSA-tax-total");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("1400");
  });

  it("requires a note to name what it corrects and why", () => {
    const note = zatca.prepare({ ...SAUDI_INVOICE, kind: "tax_credit_note" }, NO_CREDENTIAL);
    expect(note.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(["BR-KSA-corrects", "BR-KSA-reason"]),
    );
  });

  it("cannot submit without a credential, and says exactly what would change that", async () => {
    const outcome = await zatca.submit(
      { payload: "", payloadKind: "ubl_xml", documentHash: null, qrPayload: null, issues: [] },
      NO_CREDENTIAL,
    );
    expect(outcome.state).toBe("unavailable");
    expect(outcome).toHaveProperty("ownerAction", ZATCA_OWNER_ACTION);
    expect(ZATCA_OWNER_ACTION).toMatch(/compliance CSID/);
  });

  it("still refuses when a credential exists, because submission is not enabled in this release", async () => {
    const outcome = await zatca.submit(
      { payload: "", payloadKind: "ubl_xml", documentHash: null, qrPayload: null, issues: [] },
      { ...NO_CREDENTIAL, credentialRef: "ZATCA_PRODUCTION_CSID", credentialPresent: true },
    );
    expect(outcome.state).toBe("unavailable");
    expect((outcome as { ownerAction: string }).ownerAction).toMatch(/explicit approval/);
  });
});

describe("the UAE adapter", () => {
  const uae = adapterFor("uae_peppol")!;

  it("builds a PINT AE document and can never send one", async () => {
    const prepared = uae.prepare(
      {
        ...SAUDI_INVOICE,
        currency: "AED",
        seller: { ...SAUDI_INVOICE.seller, taxNumber: "100123456700003" },
      },
      NO_CREDENTIAL,
    );
    expect(prepared.payloadKind).toBe("pint_xml");
    expect(prepared.payload).toContain("urn:peppol:pint:billing-1@ae-1");
    // The UAE model carries no QR requirement of its own.
    expect(prepared.qrPayload).toBeNull();

    const outcome = await uae.submit(prepared, {
      ...NO_CREDENTIAL,
      credentialRef: "AE_ASP_TOKEN",
      credentialPresent: true,
    });
    expect(outcome.state).toBe("unavailable");
    expect((outcome as { ownerAction: string }).ownerAction).toBe(UAE_OWNER_ACTION);
    expect(UAE_OWNER_ACTION).toMatch(/Accredited Service Provider/);
  });

  it("insists a negative total is a credit note, as the guidelines do", () => {
    const negative = uae.prepare(
      { ...SAUDI_INVOICE, currency: "AED", totalMinor: -11_500 },
      NO_CREDENTIAL,
    );
    expect(negative.issues.map((i) => i.code)).toContain("AE-negative-total");
  });
});

describe("credentials", () => {
  it("treats an unset or empty variable as absent, so a half-configured deployment fails closed", () => {
    expect(credentialPresent(null, {})).toBe(false);
    expect(credentialPresent("ZATCA_CSID", {})).toBe(false);
    expect(credentialPresent("ZATCA_CSID", { ZATCA_CSID: "" })).toBe(false);
    expect(credentialPresent("ZATCA_CSID", { ZATCA_CSID: "   " })).toBe(false);
    expect(credentialPresent("ZATCA_CSID", { ZATCA_CSID: "value" })).toBe(true);
  });

  it("no adapter can return an accepted state without a credential", async () => {
    for (const key of ["zatca", "uae_peppol"]) {
      const adapter = adapterFor(key)!;
      const outcome = await adapter.submit(
        { payload: "", payloadKind: "ubl_xml", documentHash: null, qrPayload: null, issues: [] },
        NO_CREDENTIAL,
      );
      expect(outcome.state, key).toBe("unavailable");
    }
  });
});
