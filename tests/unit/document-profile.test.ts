/**
 * 003B.1 — issuer identity foundations (pure): the immutable issuer-snapshot
 * schema, capture/legacy helpers, bilingual address formatting, and the
 * document-identity input validation the settings surface writes through.
 */
import { describe, expect, it } from "vitest";
import {
  ISSUER_SNAPSHOT_VERSION,
  IssuerSnapshot,
  captureIssuerSnapshot,
  formatIssuerAddress,
  legacyIssuerFallback,
  type IssuerIdentity,
} from "@/platform/documents";
import { SaveDocumentIdentityInput } from "@/modules/branding/service";

const FULL: IssuerIdentity = {
  tradingName: "Alpha Co",
  legalName: "Alpha Trading LLC",
  trn: "100000000000003",
  licenseNo: "CN-1234567",
  addressEn: "Warehouse 4, Industrial Area 2",
  addressAr: "مستودع ٤، المنطقة الصناعية ٢",
  city: "Sharjah",
  region: "Sharjah",
  postalCode: "00000",
  country: "United Arab Emirates",
  phone: "+971 6 555 0000",
  email: "office@alpha.example",
  website: "www.alpha.example",
  signatoryName: "A. Owner",
  signatoryTitle: "General Manager",
  paymentInstructions: "Bank X — IBAN AE00",
  footer: "PO Box 1",
  docLanguage: "bilingual",
  logoFileId: "3b241101-e2bb-4255-8caf-4136c566a962",
};

describe("issuer snapshot schema — strict, versioned, loud on invalid", () => {
  it("captures a complete valid snapshot from the identity", () => {
    const snap = captureIssuerSnapshot(FULL, "2026-08-27T10:00:00.000Z");
    expect(snap.version).toBe(ISSUER_SNAPSHOT_VERSION);
    expect(snap.legalName).toBe("Alpha Trading LLC");
    expect(snap.trn).toBe("100000000000003");
    expect(snap.logoFileId).toBe(FULL.logoFileId);
    // Round-trips through parse (what a stored snapshot must survive).
    expect(IssuerSnapshot.parse(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });

  it("rejects an incomplete snapshot (no legal name = no formal document)", () => {
    expect(() =>
      captureIssuerSnapshot({ ...FULL, legalName: "" }, "2026-08-27T10:00:00.000Z"),
    ).toThrow();
  });

  it("rejects a wrong version and a bad capture timestamp", () => {
    const snap = captureIssuerSnapshot(FULL, "2026-08-27T10:00:00.000Z");
    expect(IssuerSnapshot.safeParse({ ...snap, version: 2 }).success).toBe(false);
    expect(IssuerSnapshot.safeParse({ ...snap, capturedAt: "yesterday" }).success).toBe(false);
  });

  it("rejects smuggled unknown fields (strict) and a non-uuid logo reference", () => {
    const snap = captureIssuerSnapshot(FULL, "2026-08-27T10:00:00.000Z");
    expect(IssuerSnapshot.safeParse({ ...snap, injected: "<script>" }).success).toBe(false);
    expect(IssuerSnapshot.safeParse({ ...snap, logoFileId: "not-a-uuid" }).success).toBe(false);
  });

  it("legacy fallback is explicit — never disguised as a stored snapshot", () => {
    const legacy = legacyIssuerFallback(FULL);
    expect(legacy.legacy).toBe(true);
    expect(legacy.identity.legalName).toBe("Alpha Trading LLC");
    // The fallback shape is NOT a valid snapshot (no version/capturedAt).
    expect(IssuerSnapshot.safeParse(legacy).success).toBe(false);
  });
});

describe("bilingual address formatting (structured fields, never footer parsing)", () => {
  it("formats the English and Arabic lines in structured order", () => {
    expect(formatIssuerAddress(FULL, "en")).toBe(
      "Warehouse 4, Industrial Area 2, Sharjah, Sharjah, 00000, United Arab Emirates",
    );
    const ar = formatIssuerAddress(FULL, "ar");
    expect(ar).toContain("مستودع ٤");
    expect(ar).toContain("، ");
  });

  it("falls back across languages and skips missing parts", () => {
    const noAr = { ...FULL, addressAr: null };
    expect(formatIssuerAddress(noAr, "ar")).toContain("Warehouse 4");
    const sparse = { ...FULL, addressEn: null, addressAr: null, postalCode: null, region: null };
    expect(formatIssuerAddress(sparse, "en")).toBe("Sharjah, United Arab Emirates");
  });

  it("an identity with no address parts formats to null (never an empty line)", () => {
    expect(
      formatIssuerAddress(
        {
          addressEn: null,
          addressAr: null,
          city: null,
          region: null,
          postalCode: null,
          country: null,
        },
        "en",
      ),
    ).toBeNull();
  });
});

describe("document-identity input validation (the settings write path)", () => {
  const VALID = {
    legalName: "Alpha Trading LLC",
    taxRegNo: "100000000000003",
    tradeLicenseNo: "",
    addressEn: "Warehouse 4",
    addressAr: "",
    city: "Sharjah",
    region: "",
    postalCode: "",
    country: "United Arab Emirates",
    phone: "",
    email: "office@alpha.example",
    website: "",
    signatoryName: "",
    signatoryTitle: "",
    paymentInstructions: "",
    docLanguage: "bilingual",
  };

  it("accepts a valid payload; empty strings become null", () => {
    const parsed = SaveDocumentIdentityInput.parse(VALID);
    expect(parsed.legalName).toBe("Alpha Trading LLC");
    expect(parsed.tradeLicenseNo).toBeNull();
    expect(parsed.phone).toBeNull();
    expect(parsed.docLanguage).toBe("bilingual");
  });

  it("rejects an invalid email, an over-length field and an unknown language", () => {
    expect(SaveDocumentIdentityInput.safeParse({ ...VALID, email: "nope" }).success).toBe(false);
    expect(
      SaveDocumentIdentityInput.safeParse({ ...VALID, legalName: "x".repeat(201) }).success,
    ).toBe(false);
    expect(SaveDocumentIdentityInput.safeParse({ ...VALID, docLanguage: "fr" }).success).toBe(
      false,
    );
  });
});
