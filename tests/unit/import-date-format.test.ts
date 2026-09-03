/**
 * H29 — a date in a file is not read until someone says how the file writes
 * dates.
 *
 * `01/02/2026` is 2 January in most of the world and 1 February in the United
 * States. Looking at the rest of the column does not settle it: a file whose
 * days never exceed 12 is ambiguous end to end, and a wrong reading moves a
 * close date or a due date by up to eleven months while nothing looks broken.
 *
 * These exercise the real function the importer calls, not a copy of it.
 */
import { describe, expect, it } from "vitest";
import { readSourceDate, SOURCE_DATE_FORMATS } from "@/modules/imports/dates";

const problem = (value: string, format?: (typeof SOURCE_DATE_FORMATS)[number]) => {
  const r = readSourceDate(value, format);
  return "problem" in r ? r.problem : null;
};

describe("the source date format is declared, never inferred", () => {
  it("offers exactly the three readings a file can have", () => {
    expect([...SOURCE_DATE_FORMATS]).toEqual(["iso", "dmy", "mdy"]);
  });

  it("refuses an ambiguous date when no format was stated, and says why", () => {
    expect(problem("01/02/2026")).toMatch(/can be read two ways/);
    expect(problem("01/02/2026")).toMatch(/day or the month first/);
  });

  it("reads the same string two different ways, as the two formats require", () => {
    expect(readSourceDate("01/02/2026", "dmy")).toEqual({ date: "2026-02-01" });
    expect(readSourceDate("01/02/2026", "mdy")).toEqual({ date: "2026-01-02" });
  });

  it("lets an ISO date through whatever the declared format is", () => {
    // Unambiguous by construction; rewriting it would only add a way to be wrong.
    for (const format of [undefined, ...SOURCE_DATE_FORMATS] as const)
      expect(readSourceDate("2026-02-01", format)).toEqual({ date: "2026-02-01" });
  });

  it("treats a declared 'iso' as no permission to read a slashed date", () => {
    // Choosing ISO says the file uses ISO. A slashed value in that file is a
    // surprise, not an invitation to pick a reading.
    expect(problem("01/02/2026", "iso")).toMatch(/can be read two ways/);
  });

  it("refuses a string that is not a date at all", () => {
    expect(problem("next Tuesday", "dmy")).toMatch(/not a date/);
    expect(problem("", "dmy")).toMatch(/not a date/);
  });

  it("refuses a date that does not exist, in either reading", () => {
    // 31 April is not a date whichever way round the numbers are read.
    expect(problem("31/04/2026", "dmy")).toMatch(/not a real calendar date/);
    expect(problem("04/31/2026", "mdy")).toMatch(/not a real calendar date/);
    expect(problem("30/02/2026", "dmy")).toMatch(/not a real calendar date/);
  });

  it("refuses a two-digit year rather than assuming a century", () => {
    // "01/02/26" could be 1926, 2026 or 2126. The file has to say.
    expect(problem("01/02/26", "dmy")).toMatch(/not a date/);
  });

  it("accepts dots and dashes as separators, and is still ambiguous without a format", () => {
    for (const value of ["01.02.2026", "01-02-2026"])
      expect(problem(value)).toMatch(/can be read two ways/);
    expect(readSourceDate("01.02.2026", "dmy")).toEqual({ date: "2026-02-01" });
    expect(readSourceDate("01-02-2026", "mdy")).toEqual({ date: "2026-01-02" });
  });

  it("pads a single-digit day and month rather than emitting a short ISO string", () => {
    expect(readSourceDate("3/4/2026", "dmy")).toEqual({ date: "2026-04-03" });
  });

  it("keeps a leap day that exists and refuses one that does not", () => {
    expect(readSourceDate("29/02/2028", "dmy")).toEqual({ date: "2028-02-29" });
    expect(problem("29/02/2027", "dmy")).toMatch(/not a real calendar date/);
  });

  it("quotes the offending value back, so a rejected row says which cell", () => {
    expect(problem("01/02/2026")).toContain('"01/02/2026"');
  });
});
