/**
 * S10 CSV export guard (doc 10 #25 / audit F-25). A tenant-authored value that leads with a
 * spreadsheet formula trigger (= + - @ tab CR) must be neutralised so opening the export in
 * Excel/Sheets cannot execute it. Every cell is also RFC-4180 quoted.
 */
import { describe, it, expect } from "vitest";
import { csvEscape, toCsv } from "@/platform/export/csv";

describe("csvEscape (formula-injection guard)", () => {
  it("prefixes a leading formula trigger with a single quote", () => {
    expect(csvEscape("=1+1")).toBe(`"'=1+1"`);
    expect(csvEscape("+SUM(A1)")).toBe(`"'+SUM(A1)"`);
    expect(csvEscape("-2")).toBe(`"'-2"`);
    expect(csvEscape("@cmd")).toBe(`"'@cmd"`);
    expect(csvEscape("\tTAB")).toBe(`"'\tTAB"`);
  });

  it("leaves an ordinary value alone (but still RFC-4180 quotes it)", () => {
    expect(csvEscape("Gulf Marine LLC")).toBe(`"Gulf Marine LLC"`);
    expect(csvEscape("has, comma")).toBe(`"has, comma"`);
    expect(csvEscape('has "quote"')).toBe(`"has ""quote"""`);
    expect(csvEscape(null)).toBe(""); // an empty cell stays empty (no quotes)
    expect(csvEscape(undefined)).toBe("");
    expect(csvEscape(1500)).toBe(`"1500"`);
  });

  it("builds a guarded CSV document with CRLF rows", () => {
    const csv = toCsv(["name", "note"], [["=danger", "ok"]]);
    expect(csv).toBe(`"name","note"\r\n"'=danger","ok"\r\n`);
  });
});
