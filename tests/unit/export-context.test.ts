/**
 * H29 — a downloaded file says what it was produced under.
 *
 * A CSV of amounts with no currency, or of timestamps with no timezone, is
 * unreadable the moment it leaves the screen it came from. The body is left
 * alone so any tool can still parse it, which makes the filename, the headers
 * and the manifest the only places the context can live.
 */
import { describe, expect, it } from "vitest";
import {
  buildExportContext,
  exportFilename,
  exportHeaders,
  manifestRows,
  type ExportContext,
} from "@/platform/export/context";

const context = (over: Partial<ExportContext> = {}): ExportContext =>
  buildExportContext({
    producedAt: "2026-09-04T08:30:00.000Z",
    locale: "en",
    currency: "SAR",
    timezone: "Asia/Riyadh",
    country: "SA",
    packKey: "SA-2026-09-03",
    derivedFromOrganisation: false,
    pricePrivileged: true,
    costPrivileged: true,
    ...over,
  });

describe("the filename carries the context", () => {
  it("names the entity, the day, the language, the currency and the timezone", () => {
    expect(exportFilename("invoices", context())).toBe(
      "invoices_2026-09-04_en_SAR_Asia-Riyadh.csv",
    );
  });

  it("keeps the timezone filesystem-safe", () => {
    // A slash in a filename is a directory separator on every operating system
    // this file will ever land on.
    const name = exportFilename("jobs", context({ timezone: "America/Argentina/Buenos_Aires" }));
    expect(name).not.toContain("/");
    expect(name).toContain("America-Argentina-Buenos-Aires");
  });

  it("distinguishes the same export taken in two languages", () => {
    expect(exportFilename("jobs", context({ locale: "ar" }))).not.toBe(
      exportFilename("jobs", context({ locale: "es" })),
    );
  });
});

describe("the headers carry the same facts", () => {
  it("states the pack version, or says plainly that none is adopted", () => {
    expect(exportHeaders(context())["X-Idaraworks-Export-Pack"]).toBe("SA-2026-09-03");
    expect(exportHeaders(context({ packKey: null }))["X-Idaraworks-Export-Pack"]).toBe("none");
  });

  it("says when money was redacted, so a blank column is not read as a zero", () => {
    expect(exportHeaders(context())["X-Idaraworks-Export-Money-Redacted"]).toBe("false");
    expect(
      exportHeaders(context({ costPrivileged: false }))["X-Idaraworks-Export-Money-Redacted"],
    ).toBe("true");
    expect(
      exportHeaders(context({ pricePrivileged: false }))["X-Idaraworks-Export-Money-Redacted"],
    ).toBe("true");
  });

  it("carries no header value that could hold a newline", () => {
    // Every value is a code, a date or an identifier; a stray newline in a
    // response header is a response-splitting bug.
    for (const value of Object.values(exportHeaders(context())))
      expect(/[\r\n]/.test(value)).toBe(false);
  });
});

describe("the manifest is readable without the product", () => {
  it("names every fact a reader needs, in plain field names", () => {
    const fields = manifestRows(context()).map((r) => r[0]);
    expect(fields).toEqual([
      "produced_at",
      "locale",
      "currency",
      "timezone",
      "country",
      "country_pack_version",
      "configuration_source",
      "selling_prices_included",
      "costs_included",
    ]);
  });

  it("says which settings the file was produced under", () => {
    const derived = Object.fromEntries(manifestRows(context({ derivedFromOrganisation: true })));
    expect(derived.configuration_source).toBe("organisation");
    const own = Object.fromEntries(manifestRows(context()));
    expect(own.configuration_source).toBe("establishment");
  });

  it("says 'none adopted' rather than leaving the pack blank", () => {
    const rows = Object.fromEntries(manifestRows(context({ packKey: null })));
    expect(rows.country_pack_version).toBe("none adopted");
  });

  it("states redaction as its own two facts, not one", () => {
    // "Money redacted" hides WHICH money. An accounts person may see cost and
    // not selling price, and the file has to say which columns are empty.
    const rows = Object.fromEntries(manifestRows(context({ pricePrivileged: false })));
    expect(rows.selling_prices_included).toBe("false");
    expect(rows.costs_included).toBe("true");
  });
});
