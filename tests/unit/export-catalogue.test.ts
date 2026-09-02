/**
 * 003B.1 — the universal export catalogue: coverage, metadata completeness,
 * and above all the HONESTY LAW — no entry may claim an export is available
 * before its route actually ships.
 */
import { describe, expect, it } from "vitest";
import { DATA_EXPORTS, DOCUMENT_EXPORTS, EXPORT_CATALOGUE } from "@/platform/documents";
import { EXPORT_ENTITY_KEYS } from "@/platform/export/service";

describe("catalogue shape and coverage", () => {
  it("ids are unique and namespaced by kind", () => {
    const ids = EXPORT_CATALOGUE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of EXPORT_CATALOGUE) {
      expect(e.id.startsWith(e.kind === "document" ? "doc_" : "data_"), e.id).toBe(true);
    }
  });

  it("covers the mandated surfaces: 19 formal documents + 25 data exports", () => {
    // 17 from 003B.1, plus the weekly work plan introduced with the document
    // foundation in H22.0, plus the governed Document Studio document (H26).
    expect(DOCUMENT_EXPORTS.length).toBe(19);
    // H23H added leave requests, expense claims and payslips; H24I added the
    // chart of accounts and journal entries.
    expect(DATA_EXPORTS.length).toBe(28);
  });

  it("every entry carries bilingual names, a permission, redaction and entitlement notes", () => {
    for (const e of EXPORT_CATALOGUE) {
      expect(e.nameEn.trim().length, e.id).toBeGreaterThan(0);
      expect(e.nameAr.trim().length, e.id).toBeGreaterThan(0);
      expect(e.permission.length, e.id).toBeGreaterThan(0);
      expect(e.redaction.trim().length, e.id).toBeGreaterThan(0);
      expect(e.entitlementNote.trim().length, e.id).toBeGreaterThan(0);
      expect(e.source.trim().length, e.id).toBeGreaterThan(0);
    }
  });

  it("formats fit the kind: documents print/pdf (never csv); data csv/xlsx (never print)", () => {
    for (const e of DOCUMENT_EXPORTS) {
      expect(e.formats).toContain("print");
      expect(e.formats).not.toContain("csv");
      expect(e.usesDocumentProfile, e.id).toBe(true);
    }
    for (const e of DATA_EXPORTS) {
      expect(e.formats).toContain("csv");
      expect(e.formats).not.toContain("print");
      expect(e.formats).not.toContain("pdf");
      expect(e.usesDocumentProfile, e.id).toBe(false);
    }
  });

  it("issuer snapshots are demanded only by formal commercial documents", () => {
    for (const e of EXPORT_CATALOGUE.filter((x) => x.requiresIssuerSnapshot)) {
      expect(e.kind, e.id).toBe("document");
      expect(e.usesDocumentProfile, e.id).toBe(true);
    }
    // The five commercial/legal documents all require one.
    for (const id of [
      "doc_quote",
      "doc_invoice",
      "doc_credit_note",
      "doc_payment_receipt",
      "doc_purchase_order",
    ]) {
      expect(EXPORT_CATALOGUE.find((e) => e.id === id)?.requiresIssuerSnapshot, id).toBe(true);
    }
  });
});

describe("HONESTY LAW — availability never overstates reality", () => {
  /**
   * The document kinds the live route actually renders, from
   * src/app/api/o/[orgId]/documents/[kind]/[id]/route.ts. A credit note is an
   * invoice row with kind='credit_note', so the invoice path serves it too.
   *
   * Keep this in step with the route, never with intent: it is the whole point
   * of the law that a catalogue entry cannot claim to work before it does.
   */
  // H26: the Document Studio route (src/app/api/o/[orgId]/documents/studio/[id]/route.ts)
  // renders any governed document as HTML or a real PDF.
  const SERVED = new Set([
    "doc_quote",
    "doc_invoice",
    "doc_credit_note",
    "doc_week_plan",
    "doc_studio_document",
  ]);

  it("a document claims availability ONLY when the document route renders it", () => {
    for (const e of DOCUMENT_EXPORTS) {
      if (e.availability === "available") {
        expect(SERVED.has(e.id), `${e.id} claims availability but no route renders it`).toBe(true);
      }
    }
  });

  it("every document the route renders is marked available", () => {
    for (const id of SERVED) {
      const entry = DOCUMENT_EXPORTS.find((e) => e.id === id);
      expect(entry, `served document '${id}' missing from the catalogue`).toBeTruthy();
      expect(entry!.availability, id).toBe("available");
    }
  });

  it("a data export claims availability ONLY when the live CSV route serves it", () => {
    const live = new Set<string>(EXPORT_ENTITY_KEYS);
    for (const e of DATA_EXPORTS) {
      const entityKey = e.id.replace(/^data_/, "");
      if (e.availability === "available") {
        expect(
          live.has(entityKey),
          `${e.id} claims availability but the export route has no '${entityKey}' entity`,
        ).toBe(true);
      }
    }
  });

  it("every currently-live CSV entity is represented and marked available", () => {
    for (const key of EXPORT_ENTITY_KEYS) {
      const entry = DATA_EXPORTS.find((e) => e.id === `data_${key}`);
      expect(entry, `live export '${key}' missing from the catalogue`).toBeTruthy();
      expect(entry!.availability, key).toBe("available");
    }
  });

  it("the audit log is the one entitlement-gated export (feat.audit_export)", () => {
    const audit = EXPORT_CATALOGUE.find((e) => e.id === "data_audit_log")!;
    expect(audit.entitlementFeature).toBe("feat.audit_export");
    for (const e of DATA_EXPORTS.filter((x) => x.id !== "data_audit_log")) {
      expect(e.entitlementFeature, e.id).toBeNull();
    }
  });
});
