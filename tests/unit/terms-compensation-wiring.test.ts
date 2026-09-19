import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The employee "Salary terms" form must write the compensation HISTORY
 * (payroll's source of truth, which also refreshes the costing projection),
 * not the projection alone — that left payroll runs with no lines.
 */
describe("salary terms action wiring", () => {
  const src = readFileSync("src/app/(app)/o/[orgId]/people/actions.ts", "utf8");
  const start = src.indexOf("export async function setTermsAction(");
  const end = src.indexOf("\nexport ", start + 1);
  const body = src.slice(start, end === -1 ? undefined : end);

  it("records a compensation change with an effective date", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("recordCompensationChange(");
    expect(body).toContain("effectiveDate:");
  });

  it("no longer writes the projection alone", () => {
    expect(body).not.toContain("setEmployeeTerms(");
  });
});
