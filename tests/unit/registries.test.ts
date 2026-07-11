import { describe, expect, it } from "vitest";
import {
  APPROVABLE_TYPES,
  ATTACHABLE_TYPES,
  CONTAINER_KINDS,
  CURRENCY_CODES,
  MVP_GRANTABLE_ARCHETYPES,
  TERM_KEYS,
  isPreFinal,
  isReportable,
  minorUnitExponent,
} from "@/platform/registries";

describe("registries (phase2 closed vocabularies)", () => {
  it("MVP has exactly one container kind: job (freeze FR-3)", () => {
    expect(CONTAINER_KINDS).toEqual(["job"]);
  });

  it("currencies match the OP-8 closure, with 3-decimal GCC currencies", () => {
    expect([...CURRENCY_CODES].sort()).toEqual(
      ["AED", "BHD", "EUR", "KWD", "OMR", "QAR", "SAR", "USD"].sort(),
    );
    for (const code of ["KWD", "BHD", "OMR"] as const) {
      expect(minorUnitExponent(code)).toBe(3);
    }
    for (const code of ["AED", "SAR", "QAR", "USD", "EUR"] as const) {
      expect(minorUnitExponent(code)).toBe(2);
    }
  });

  it("phase predicates behave per audit F-19 (engines never read the raw enum)", () => {
    expect(isReportable("production")).toBe(true);
    expect(isReportable("finishing")).toBe(true);
    expect(isReportable("verification")).toBe(true);
    expect(isReportable("preparation")).toBe(false);
    expect(isReportable("handover")).toBe(false);
    expect(isReportable(null)).toBe(false);

    expect(isPreFinal("preparation")).toBe(true);
    expect(isPreFinal("production")).toBe(true);
    expect(isPreFinal("finishing")).toBe(false);
    expect(isPreFinal(null)).toBe(false);
  });

  it("approvable registry matches doc 05 final (OP-7 closure)", () => {
    expect([...APPROVABLE_TYPES].sort()).toEqual(
      ["expense", "material_request", "payment", "purchase_order", "quote_send"].sort(),
    );
    // invoice_issue is explicitly OUT of the MVP enum (audit C-1)
    expect(APPROVABLE_TYPES).not.toContain("invoice_issue");
  });

  it("worker archetype is reserved, not grantable in MVP (audit F-17)", () => {
    expect(MVP_GRANTABLE_ARCHETYPES).not.toContain("worker_reserved_p3");
    expect(MVP_GRANTABLE_ARCHETYPES).toContain("foreman");
    expect(MVP_GRANTABLE_ARCHETYPES).toContain("viewer");
  });

  it("term keys are unique and include the audit C-9 extensions", () => {
    expect(new Set(TERM_KEYS).size).toBe(TERM_KEYS.length);
    for (const key of ["purchase_order", "goods_receipt", "expense", "payment", "task"]) {
      expect(TERM_KEYS).toContain(key);
    }
    // week_plan was cut with its entity (audit F-15)
    expect(TERM_KEYS).not.toContain("week_plan");
  });

  it("attachable registry is unique", () => {
    expect(new Set(ATTACHABLE_TYPES).size).toBe(ATTACHABLE_TYPES.length);
  });
});
