/**
 * H33 D1 — a purchase order can be printed.
 *
 * The defect: `purchase_order` was not a document kind, so
 * `/api/o/<org>/documents/purchase_order/<id>` answered 404 for every order ever
 * raised, and the order screen said "PDF pending" for ever — the only thing that
 * would have produced a stored PDF was a worker that builds the HTML and stops
 * at an unbuilt store step, behind a queue nobody has provisioned. A customer
 * could raise an order and had no way to send it to their supplier.
 *
 * These tests fail without the fix: the first one because the route's own
 * `isKind` guard is what returns the 404, and the rest because `documentModel`
 * would throw on an unknown kind.
 *
 * Runs against the isolated test project only (vitest.integration.config.ts).
 * Self-cleaning.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate } from "@/platform/config/install";
import { createSupplier } from "@/modules/masters/service";
import { createPurchaseOrder } from "@/modules/supply/service";
import {
  DOCUMENT_KINDS,
  documentModel,
  documentHtml,
  SHAREABLE_KINDS,
} from "@/modules/documents/service";
import { renderDocument, renderPdf, embeddedDocumentFonts } from "@/platform/documents";
import { markFixtureOrg, ownerSql, requireIntegrationEnv, wipeOrgs } from "./helpers";

requireIntegrationEnv();

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";
let poId = "";
let poRef = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h33-po-doc",
});

async function seedAuthUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h33-po-${label}-${run}@example.com`}, '{"full_name":"H33"}'::jsonb, now(), now())`;
}

beforeAll(async () => {
  await seedAuthUser(userA, "a");
  await seedAuthUser(userB, "b");

  orgA = await createOrgForUser(userA, {
    name: `H33 PO ${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  await markFixtureOrg(owner, orgA, "h33-purchase-order-document", run);
  await installTemplate(ctxOf(orgA, userA), "construction_v1");

  orgB = await createOrgForUser(userB, {
    name: `H33 PO other ${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  await markFixtureOrg(owner, orgB, "h33-purchase-order-document", run);

  const supplier = await createSupplier(ctxOf(orgA, userA), "owner", {
    name: "Falcon Building Materials LLC",
    taxRegNo: "199900000000001",
    phone: "+971 50 000 0101",
    email: "orders.falcon.1@example.invalid",
    termsText: "30 days from delivery",
  });

  // 12 × 2,450 + 3 × 18,000 = 29,400 + 54,000 = 83,400 fils; VAT 5% = 4,170.
  const po = await createPurchaseOrder(ctxOf(orgA, userA), "owner", {
    supplierId: supplier.id,
    vatMinor: 4_170,
    notes: "Deliver to the Marina site gate before 07:00.",
    lines: [
      { itemName: "Rebar 12mm (6m)", qty: 12, unit: "pcs", unitCostMinor: 2_450 },
      { itemName: "Cement OPC 50kg — الأسمنت", qty: 3, unit: "bag", unitCostMinor: 18_000 },
    ],
  });
  poId = po.id;
  poRef = po.reference;
}, 180_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end();
  await closeAppDb();
});

describe("the purchase order is a document kind at all", () => {
  it("is registered, so the download route no longer answers 404", () => {
    // The route 404s on any kind absent from this list; that WAS the defect.
    expect(DOCUMENT_KINDS).toContain("purchase_order");
  });

  it("is not shareable outside the organisation", () => {
    // An order names a supplier's prices. It is internal, unlike a quotation.
    expect(SHAREABLE_KINDS as readonly string[]).not.toContain("purchase_order");
  });
});

describe("the printed order carries what a supplier needs", () => {
  it(
    "names the issuer, the supplier, every line and totals that add up",
    { timeout: 180_000 },
    async () => {
      const model = await documentModel(ctxOf(orgA, userA), "owner", {
        kind: "purchase_order",
        id: poId,
        language: "en",
      });

      expect(model.kind).toBe("purchase_order");
      expect(model.titleEn).toBe("Purchase Order");
      expect(model.reference).toBe(poRef);
      // Company legal identity comes from the shared issuer resolver, so the
      // printed order carries the same letterhead as an invoice.
      expect(model.issuer.legalName.length).toBeGreaterThan(0);
      expect(model.issuer.tradingName.length).toBeGreaterThan(0);
      expect(model.recipient?.name).toBe("Falcon Building Materials LLC");
      expect((model.fields ?? []).some((f) => f.value === "199900000000001")).toBe(true);

      const lines = model.sections[0]!.lines;
      expect(lines).toHaveLength(2);
      expect(lines[0]!.description).toBe("Rebar 12mm (6m)");
      expect(lines[0]!.quantity).toBe("12");
      expect(lines[0]!.unit).toBe("pcs");

      // Subtotal 834.00 + VAT 41.70 = 875.70. The document must not invent money.
      const totals = (model.totals ?? []).map((t) => t.value);
      expect(totals.some((v) => v.includes("834.00"))).toBe(true);
      expect(totals.some((v) => v.includes("41.70"))).toBe(true);
      expect(totals.some((v) => v.includes("875.70"))).toBe(true);
      expect((model.totals ?? []).at(-1)?.strong).toBe(true);
    },
  );

  it("renders in English and in Arabic, right to left", { timeout: 180_000 }, async () => {
    const en = await documentHtml(ctxOf(orgA, userA), "owner", {
      kind: "purchase_order",
      id: poId,
      language: "en",
    });
    expect(en).toContain("Purchase Order");
    expect(en).toContain(poRef);
    expect(en).toContain("Falcon Building Materials LLC");

    const ar = await documentHtml(ctxOf(orgA, userA), "owner", {
      kind: "purchase_order",
      id: poId,
      language: "ar",
    });
    expect(ar).toContain("أمر شراء");
    expect(ar).toContain('dir="rtl"');
    expect(ar).toContain(poRef);
    // The Arabic item name survives into the Arabic document.
    expect(ar).toContain("الأسمنت");
  });

  it("a draft order prints with a DRAFT watermark", { timeout: 180_000 }, async () => {
    const model = await documentModel(ctxOf(orgA, userA), "owner", {
      kind: "purchase_order",
      id: poId,
      language: "en",
    });
    // Freshly created orders are drafts; a draft must never look like an
    // instruction a supplier can act on.
    expect(model.statusText).toBe("draft");
    expect(model.watermark).toBe("draft");
  });
});

describe("the download is a real file", () => {
  it("produces PDF bytes, in both languages", { timeout: 300_000 }, async () => {
    const fonts = await embeddedDocumentFonts();
    for (const language of ["en", "ar"] as const) {
      const model = await documentModel(ctxOf(orgA, userA), "owner", {
        kind: "purchase_order",
        id: poId,
        language,
      });
      const html = renderDocument(model, { delivery: "embed", embedded: fonts });
      const pdf = await renderPdf(html);
      expect(pdf.byteLength, `${language} pdf size`).toBeGreaterThan(1000);
      expect(Buffer.from(pdf).toString("latin1").slice(0, 5), `${language} magic`).toBe("%PDF-");
    }
  });
});

describe("printing an order obeys the same walls as reading one", () => {
  it("a role without the purchase-order permission is refused", { timeout: 180_000 }, async () => {
    await expect(
      documentModel(ctxOf(orgA, userA), "viewer", {
        kind: "purchase_order",
        id: poId,
        language: "en",
      }),
    ).rejects.toThrow();
  });

  it("another organisation cannot print this order", { timeout: 180_000 }, async () => {
    await expect(
      documentModel(ctxOf(orgB, userB), "owner", {
        kind: "purchase_order",
        id: poId,
        language: "en",
      }),
    ).rejects.toThrow();
  });
});
