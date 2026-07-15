/**
 * Shared formatters (Bible §9.11; OP-8; audit F-44). Money honours minor-unit
 * exponents (KWD/BHD/OMR = 3-dp); numerals stay LATIN under `ar`.
 */
import { describe, expect, it } from "vitest";
import { formatMoney, toMinorUnits, formatDate, formatNumber, formatTime } from "@/platform/format";

const ARABIC_INDIC = /[٠-٩]/; // ٠-٩ must NOT appear (latn pin)

describe("formatMoney (minor units → currency)", () => {
  it("2-decimal currency (AED): 150000 minor = 1,500.00", () => {
    const s = formatMoney(150000, "AED");
    expect(s).toContain("1,500.00");
    expect(s).not.toContain("1,500.000");
  });

  it("3-decimal currency (KWD): 1500000 minor = 1,500.000 (OP-8 exponent 3)", () => {
    const s = formatMoney(1500000, "KWD");
    expect(s).toContain("1,500.000");
  });

  it("other exponent-3 currencies format with 3 fraction digits", () => {
    expect(formatMoney(1000, "BHD")).toContain("1.000");
    expect(formatMoney(1000, "OMR")).toContain("1.000");
  });

  it("bigint minor amounts are accepted (no float-through)", () => {
    expect(formatMoney(150000n, "AED")).toContain("1,500.00");
  });

  it("pins Latin digits under ar (F-44) — never Arabic-Indic", () => {
    const s = formatMoney(150000, "AED", { locale: "ar" });
    expect(s).toMatch(/1[,.]500/); // Western digits present
    expect(ARABIC_INDIC.test(s)).toBe(false);
  });

  it("toMinorUnits round-trips by exponent", () => {
    expect(toMinorUnits("1500.00", "AED")).toBe(150000);
    expect(toMinorUnits("1500.000", "KWD")).toBe(1500000);
    expect(toMinorUnits(1.5, "KWD")).toBe(1500);
  });
});

describe("date + number formatters pin Latin numerals", () => {
  it("formatDate under ar uses Latin digits in the org timezone", () => {
    const s = formatDate("2026-07-12T09:00:00Z", { locale: "ar", timeZone: "Asia/Dubai" });
    expect(ARABIC_INDIC.test(s)).toBe(false);
    expect(s).toMatch(/2026/);
  });

  it("formatNumber under ar uses Latin digits", () => {
    const s = formatNumber(1234567, "ar");
    expect(ARABIC_INDIC.test(s)).toBe(false);
    expect(s).toMatch(/1[,.]?234[,.]?567/);
  });

  it("formatTime renders HH:MM in the given org timezone", () => {
    // 09:00Z is 13:00 in Asia/Dubai (UTC+4, no DST).
    const s = formatTime("2026-07-12T09:00:00Z", { locale: "en", timeZone: "Asia/Dubai" });
    expect(s).toBe("13:00");
  });

  it("formatTime without a timezone falls back to UTC with an honest suffix", () => {
    expect(formatTime("2026-07-12T09:07:00Z", { locale: "en" })).toBe("09:07 UTC");
  });

  it("formatTime under ar keeps Latin digits", () => {
    const s = formatTime("2026-07-12T09:00:00Z", { locale: "ar", timeZone: "Asia/Dubai" });
    expect(ARABIC_INDIC.test(s)).toBe(false);
  });
});
