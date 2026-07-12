/**
 * Terminology resolution (doc 07): order (override → template → default),
 * fallback, grammar metadata, and full key coverage in en + ar.
 */
import { describe, expect, it } from "vitest";
import { resolveTerm, term, PLATFORM_DEFAULT_TERMS } from "@/platform/terminology";
import { TERM_KEYS } from "@/platform/registries";

describe("resolution order (first hit wins)", () => {
  it("platform default when nothing overrides", () => {
    expect(term("job", { locale: "en" })).toBe("Job");
    expect(term("job", { locale: "ar" })).toBe("مشروع");
  });

  it("template map beats platform default", () => {
    expect(term("job", { locale: "en", templateKey: "boat-building" })).toBe("Boat");
    expect(term("job", { locale: "ar", templateKey: "boat-building" })).toBe("قارب");
    // a key the template does NOT override falls through to the default
    expect(term("invoice", { locale: "en", templateKey: "boat-building" })).toBe("Invoice");
  });

  it("org override beats template and default", () => {
    const overrides = {
      job: {
        en: { singular: "Vessel", plural: "Vessels" },
        ar: { singular: "سفينة", plural: "سفن", gender: "f" as const },
      },
    };
    expect(term("job", { locale: "en", overrides, templateKey: "boat-building" })).toBe("Vessel");
    expect(term("job", { locale: "ar", overrides, templateKey: "boat-building" })).toBe("سفينة");
  });

  it("plural variant resolves", () => {
    expect(term("job", { locale: "en" }, "plural")).toBe("Jobs");
    expect(term("purchase_order", { locale: "en", templateKey: "boat-building" }, "plural")).toBe(
      "LPOs",
    );
  });
});

describe("grammar metadata", () => {
  it("ar carries gender; en does not", () => {
    expect(resolveTerm("task", { locale: "ar" }).gender).toBe("f");
    expect(resolveTerm("customer", { locale: "ar" }).gender).toBe("m");
    expect(resolveTerm("task", { locale: "en" }).gender).toBeNull();
  });
});

describe("key coverage (fails the build, not runtime — doc 07 #2)", () => {
  it("every canonical term key resolves in en AND ar with a plural + ar gender", () => {
    for (const key of TERM_KEYS) {
      for (const locale of ["en", "ar"] as const) {
        const r = resolveTerm(key, { locale });
        expect(r.singular, `${key}/${locale} singular`).toBeTruthy();
        expect(r.plural, `${key}/${locale} plural`).toBeTruthy();
      }
      expect(resolveTerm(key, { locale: "ar" }).gender, `${key} ar gender`).toMatch(/^[mf]$/);
    }
  });

  it("PLATFORM_DEFAULT_TERMS has an entry for every key (no gaps)", () => {
    expect(Object.keys(PLATFORM_DEFAULT_TERMS).sort()).toEqual([...TERM_KEYS].sort());
  });
});
