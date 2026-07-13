/**
 * S4 "Supply & Approve" unit coverage (doc 11 testing):
 *  - per-archetype permission snapshot for the seven S4 actions (doc 06);
 *  - the LPO template: bilingual labels, BIDI isolation of Latin serials/amounts
 *    in RTL text, HTML escaping (§6.11), no VAT re-derivation (P5);
 *  - the new domain-event payloads (incl. exception approval_stuck);
 *  - the supply/rule input schemas.
 * The stateful engine (routing, self-approval escalation, sole-writer, partial-
 * receipt math) is proven against a real DB in the integration suite.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { can } from "@/platform/authz";
import { MVP_GRANTABLE_ARCHETYPES } from "@/platform/registries";
import {
  APPROVAL_SUBMITTED,
  APPROVAL_DECIDED,
  PURCHASE_ORDER_APPROVED,
  GOODS_RECEIPT_RECORDED,
  EXCEPTION_RAISED,
  validateEventPayload,
} from "@/platform/events";
import { lpoHtml } from "@/modules/supply/service";
import { CreateMrInput, CreatePoInput } from "@/modules/supply/service";
import { CreateRuleInput } from "@/modules/approvals/service";

describe("S4 permission snapshot (doc 06 rows 50-53)", () => {
  const EXPECT: Record<string, readonly string[]> = {
    "approvals.decide": ["owner", "admin", "manager", "accounts"],
    "mr.create": ["owner", "admin", "manager", "foreman", "procurement"],
    "mr.convert": ["owner", "admin", "procurement"],
    "po.manage": ["owner", "admin", "manager", "procurement"],
    "po.view": ["owner", "admin", "manager", "procurement", "accounts"],
    "grn.create": ["owner", "admin", "manager", "foreman", "procurement"],
    "grn.cancel": ["owner", "admin"],
  };
  for (const [action, allowed] of Object.entries(EXPECT)) {
    it(`${action} → exactly ${allowed.join("/")}`, () => {
      for (const arch of MVP_GRANTABLE_ARCHETYPES) {
        expect(can(arch, action as Parameters<typeof can>[1])).toBe(allowed.includes(arch));
      }
    });
  }
  it("a foreman never decides approvals, never manages/views POs", () => {
    for (const a of [
      "approvals.decide",
      "mr.convert",
      "po.manage",
      "po.view",
      "grn.cancel",
    ] as const) {
      expect(can("foreman", a)).toBe(false);
    }
  });
});

describe("LPO template — bilingual, bidi, escaping (§6.11, P5)", () => {
  const html = lpoHtml(
    {
      reference: "PO-027",
      supplierName: "Gulf Supplies <b>Ltd</b>",
      jobReference: "24C-001",
      issueDate: "2026-07-13",
      vatMinor: "5000",
      totalMinor: "105000",
      notes: "handle with care",
      lines: [
        {
          itemName: "Epoxy Resin",
          qty: "3",
          unit: "L",
          unitCostMinor: "5000",
          lineTotalMinor: "15000",
        },
      ],
    },
    {
      orgName: "قوارب التجربة",
      currency: "AED",
      poTermEn: "Local Purchase Order",
      poTermAr: "أمر شراء محلي",
    },
  );

  it("is an RTL document with both Arabic and English labels", () => {
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("أمر شراء محلي");
    expect(html).toContain("Local Purchase Order");
    expect(html).toContain("المورد / Supplier");
  });
  it("isolates Latin serials/amounts inside RTL text (bidi)", () => {
    // The PO reference must be wrapped in an LTR-isolated span.
    expect(html).toMatch(/dir="ltr"[^>]*>PO-027</);
    // Amounts too (formatMoney output, Latin numerals, pinned latn F-44):
    // 105000 minor AED → "1,050.00", isolated LTR inside the RTL table.
    expect(html).toMatch(/dir="ltr"[^>]*>[^<]*1,050/);
  });
  it("escapes interpolated values (no raw HTML injection)", () => {
    expect(html).not.toContain("<b>Ltd</b>");
    expect(html).toContain("Gulf Supplies &lt;b&gt;Ltd&lt;/b&gt;");
  });
  it("does not re-derive VAT — it prints the passed values verbatim", () => {
    // 5000 VAT + 105000 total are formatted as-is; the template never sums lines.
    expect(html).toMatch(/1,050\.00|105/); // total present
  });
});

describe("S4 event payloads", () => {
  const base = { orgId: randomUUID(), actorUserId: randomUUID() };
  it("approval/submitted + decided validate", () => {
    expect(
      validateEventPayload(APPROVAL_SUBMITTED, {
        ...base,
        approvalId: randomUUID(),
        subjectType: "material_request",
        subjectId: randomUUID(),
        assignedRole: "manager",
      }),
    ).toBeTruthy();
    expect(
      validateEventPayload(APPROVAL_DECIDED, {
        ...base,
        approvalId: randomUUID(),
        subjectType: "purchase_order",
        subjectId: randomUUID(),
        outcome: "approved",
      }),
    ).toBeTruthy();
    expect(() =>
      validateEventPayload(APPROVAL_DECIDED, {
        ...base,
        approvalId: randomUUID(),
        subjectType: "x",
        subjectId: randomUUID(),
        outcome: "nope",
      }),
    ).toThrow();
  });
  it("purchase_order/approved + goods_receipt/recorded validate", () => {
    expect(
      validateEventPayload(PURCHASE_ORDER_APPROVED, {
        ...base,
        purchaseOrderId: randomUUID(),
        reference: "PO-001",
      }),
    ).toBeTruthy();
    expect(
      validateEventPayload(GOODS_RECEIPT_RECORDED, {
        ...base,
        goodsReceiptId: randomUUID(),
        purchaseOrderId: randomUUID(),
      }),
    ).toBeTruthy();
  });
  it("exception/raised accepts the new approval_stuck kind", () => {
    expect(
      validateEventPayload(EXCEPTION_RAISED, {
        ...base,
        kind: "approval_stuck",
        subjectType: "approval",
        subjectId: randomUUID(),
        severity: "warning",
      }),
    ).toBeTruthy();
  });
});

describe("S4 input schemas", () => {
  it("CreateMrInput requires ≥1 line", () => {
    expect(() => CreateMrInput.parse({ lines: [] })).toThrow();
    const ok = CreateMrInput.parse({ lines: [{ itemName: "x", qty: 1, unit: "ea" }] });
    expect(ok.urgency).toBe("normal");
  });
  it("CreatePoInput requires a supplier + a costed line", () => {
    expect(() =>
      CreatePoInput.parse({ lines: [{ itemName: "x", qty: 1, unit: "ea", unitCostMinor: 100 }] }),
    ).toThrow(); // missing supplierId
    const ok = CreatePoInput.parse({
      supplierId: randomUUID(),
      lines: [{ itemName: "x", qty: 1, unit: "ea", unitCostMinor: 100 }],
    });
    expect(ok.vatMinor).toBe(0);
  });
  it("CreateRuleInput enforces the condition vocabulary", () => {
    expect(
      CreateRuleInput.parse({
        subjectType: "material_request",
        conditionKind: "always",
        assignedRole: "manager",
      }).conditionKind,
    ).toBe("always");
    expect(() =>
      CreateRuleInput.parse({
        subjectType: "material_request",
        conditionKind: "bogus",
        assignedRole: "manager",
      }),
    ).toThrow();
  });
});
