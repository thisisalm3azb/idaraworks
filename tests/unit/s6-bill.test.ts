/**
 * S6 "Bill" money golden + permission logic. Pure-function coverage for the two
 * total engines (quotes and invoices) — VAT recorded per line, both VAT bases
 * (registered domestic vs zero-rated / non-registered), independent per-line VAT
 * rounding, and the frozen multi-currency base conversion (OP-8). Cross-role
 * gating for the billing actions is asserted against the live authz matrix.
 */
import { describe, it, expect } from "vitest";
import { computeQuoteTotals } from "@/modules/quotes/service";
import { computeInvoiceTotals, computeAR } from "@/modules/invoices/service";
import { can, ForbiddenError } from "@/platform/authz";
import type { Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";

describe("computeQuoteTotals (money golden)", () => {
  it("single VAT line at base currency", () => {
    const r = computeQuoteTotals([{ qty: 2, unitPriceMinor: 10000, vatRate: 5 }], 1);
    expect(r).toMatchObject({
      subtotalMinor: 20000,
      vatAmountMinor: 1000,
      totalMinor: 21000,
      baseTotalMinor: 21000,
    });
  });

  it("multi-line, fractional qty, mixed VAT, foreign exchange freezes the base", () => {
    const r = computeQuoteTotals(
      [
        { qty: 1.5, unitPriceMinor: 10000, vatRate: 5 },
        { qty: 3, unitPriceMinor: 2500, vatRate: 0 },
      ],
      3.75,
    );
    // L1 = round(15000)=15000, vat=round(750)=750 ; L2 = 7500, vat=0
    expect(r.subtotalMinor).toBe(22500);
    expect(r.vatAmountMinor).toBe(750);
    expect(r.totalMinor).toBe(23250);
    // base = round(23250 * 3.75) = round(87187.5) = 87188
    expect(r.baseTotalMinor).toBe(87188);
  });

  it("total always equals subtotal + VAT (the DB CHECK, mirrored)", () => {
    const r = computeQuoteTotals([{ qty: 7, unitPriceMinor: 333, vatRate: 5 }], 1);
    expect(r.totalMinor).toBe(r.subtotalMinor + r.vatAmountMinor);
  });
});

describe("computeInvoiceTotals (both VAT bases)", () => {
  const lines = [{ qty: 1, unitPriceMinor: 100000, vatRate: 15 }];

  it("VAT applies (registered, domestic)", () => {
    const r = computeInvoiceTotals(lines, { vatApplies: true, exchangeRate: 1 });
    expect(r).toMatchObject({ subtotalMinor: 100000, vatAmountMinor: 15000, totalMinor: 115000 });
  });

  it("zero-rated export / non-registered org — VAT forced to zero", () => {
    const r = computeInvoiceTotals(lines, { vatApplies: false, exchangeRate: 1 });
    expect(r.subtotalMinor).toBe(100000);
    expect(r.vatAmountMinor).toBe(0);
    expect(r.totalMinor).toBe(100000);
  });

  it("multi-currency freezes base at issuance exchange_rate", () => {
    const r = computeInvoiceTotals([{ qty: 1, unitPriceMinor: 100000, vatRate: 5 }], {
      vatApplies: true,
      exchangeRate: 0.27,
    });
    // total = 105000 ; base = round(105000 * 0.27) = 28350
    expect(r.totalMinor).toBe(105000);
    expect(r.baseTotalMinor).toBe(28350);
  });

  it("per-line VAT rounds independently before summing", () => {
    const r = computeInvoiceTotals(
      [
        { qty: 1, unitPriceMinor: 101, vatRate: 5 }, // vat=round(5.05)=5
        { qty: 1, unitPriceMinor: 101, vatRate: 5 }, // vat=round(5.05)=5
      ],
      { vatApplies: true, exchangeRate: 1 },
    );
    expect(r.subtotalMinor).toBe(202);
    expect(r.vatAmountMinor).toBe(10);
  });
});

describe("billing action gating (doc 06 matrix)", () => {
  const view = (a: RoleArchetype) => can(a, "invoices.view");
  it("accounts can manage invoices & payments; owner/admin too", () => {
    for (const a of ["owner", "admin", "accounts"] as RoleArchetype[]) {
      expect(can(a, "invoices.manage")).toBe(true);
      expect(can(a, "payments.manage")).toBe(true);
      expect(can(a, "ar.view")).toBe(true);
    }
  });
  it("manager can view+manage quotes but NOT invoices/payments", () => {
    expect(can("manager", "quotes.manage")).toBe(true);
    expect(can("manager", "invoices.manage")).toBe(false);
    expect(can("manager", "payments.view")).toBe(false);
  });
  it("shop-floor roles see no billing", () => {
    for (const a of ["foreman", "procurement", "viewer"] as RoleArchetype[]) {
      expect(view(a)).toBe(false);
      expect(can(a, "quotes.view")).toBe(false);
    }
  });
});

describe("computeAR redaction (review #7)", () => {
  const ctxOf = (pricePrivileged: boolean): Ctx => ({
    orgId: "00000000-0000-0000-0000-000000000000",
    userId: "00000000-0000-0000-0000-000000000001",
    costPrivileged: pricePrivileged,
    pricePrivileged,
    requestId: "unit",
  });

  it("returns all-null money for an ar.view role WITHOUT price privilege (no DB touch)", async () => {
    // A role can hold ar.view yet have price_privileged=false (independent flags) —
    // computeAR must redact before any query, like every other money read.
    const ar = await computeAR(ctxOf(false), "owner", "2026-07-13");
    expect(ar).toEqual({
      outstandingMinor: null,
      current: null,
      d1_30: null,
      d31_60: null,
      d61_90: null,
      over90: null,
    });
  });

  it("still enforces ar.view (a role without it is refused before redaction)", async () => {
    await expect(computeAR(ctxOf(true), "foreman", "2026-07-13")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
