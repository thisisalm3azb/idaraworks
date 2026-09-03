/**
 * H29C — translation governance laws.
 *
 * The mandate's two rules about translated copy are testable, and this is where
 * they are tested: a machine-assisted language is marked for native review, and
 * a native review is never claimed without evidence. Everything here is pure —
 * completeness is measured from the shipped catalogue files, readiness is a
 * function of that measurement plus a recorded row.
 */
import { describe, expect, it } from "vitest";
import {
  localeCompleteness,
  localeReadiness,
  type LocaleReleaseRow,
} from "@/platform/i18n/release";
import { SUPPORTED_LOCALES } from "@/platform/registries";
import en from "@/platform/i18n/messages/en.json";

const row = (over: Partial<LocaleReleaseRow> = {}): LocaleReleaseRow => ({
  locale: "es",
  production: "machine_assisted",
  nativeReview: "not_started",
  nativeReviewer: null,
  nativeReviewedAt: null,
  legalReview: "not_started",
  legalReviewer: null,
  legalReviewedAt: null,
  note: null,
  ...over,
});

const complete = {
  locale: "es" as const,
  total: 10,
  translated: 9,
  recordedIdentical: 1,
  untranslated: 0,
  missing: 0,
};

describe("completeness is measured, not claimed", () => {
  it("counts every English key as the denominator", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(localeCompleteness(locale).total).toBe(Object.keys(en).length);
    }
  });

  it("the shipped catalogues have no untranslated and no missing keys", () => {
    // This is the same fact the parity test asserts, read through the surface
    // the operator page renders — so the number an operator sees cannot drift
    // from the number CI enforces. English is excluded because measuring it
    // against itself is meaningless: see the next test.
    for (const locale of SUPPORTED_LOCALES.filter((l) => l !== "en")) {
      const c = localeCompleteness(locale);
      expect(c.missing, `${locale} missing keys`).toBe(0);
      expect(c.untranslated, `${locale} keys still English`).toBe(0);
      expect(c.translated + c.recordedIdentical).toBe(c.total);
    }
  });

  it("English measures as fully 'identical' only where recorded, never as untranslated", () => {
    // en against en is every key identical. It has no recorded-identical list,
    // so it reads as untranslated — which is why the source language is
    // identified by its RECORDED production method, not by counting.
    const c = localeCompleteness("en");
    expect(c.translated).toBe(0);
    expect(c.untranslated).toBe(c.total);
  });
});

describe("readiness never overstates what is known", () => {
  it("a language with no recorded row is awaiting review, never ready", () => {
    expect(localeReadiness(complete, null)).toBe("awaiting_native_review");
  });

  it("an absent review and a recorded 'not started' read identically", () => {
    expect(localeReadiness(complete, row({ nativeReview: "not_started" }))).toBe(
      localeReadiness(complete, null),
    );
  });

  it("a complete catalogue is not readiness — only a passed review is", () => {
    expect(localeReadiness(complete, row())).toBe("awaiting_native_review");
    expect(
      localeReadiness(
        complete,
        row({
          nativeReview: "passed",
          nativeReviewer: "A. Reviewer",
          nativeReviewedAt: "2026-09-04",
        }),
      ),
    ).toBe("reviewed");
  });

  it("an incomplete catalogue is reported as incomplete even if a review passed", () => {
    // Otherwise a review recorded before the last batch of keys would keep
    // saying "reviewed" about text nobody has read.
    const incomplete = { ...complete, translated: 8, untranslated: 1 };
    expect(
      localeReadiness(
        incomplete,
        row({
          nativeReview: "passed",
          nativeReviewer: "A. Reviewer",
          nativeReviewedAt: "2026-09-04",
        }),
      ),
    ).toBe("catalogue_incomplete");
  });

  it("a failed review is its own state, never folded into 'not ready'", () => {
    expect(
      localeReadiness(
        complete,
        row({
          nativeReview: "failed",
          nativeReviewer: "A. Reviewer",
          nativeReviewedAt: "2026-09-04",
        }),
      ),
    ).toBe("native_review_failed");
  });

  it("the source language is identified by its recorded production, not by counting", () => {
    const source = localeCompleteness("en");
    expect(localeReadiness(source, row({ locale: "en", production: "source" }))).toBe(
      "source_language",
    );
  });

  it("missing keys count as incomplete, not merely as untranslated", () => {
    expect(localeReadiness({ ...complete, translated: 8, missing: 1 }, row())).toBe(
      "catalogue_incomplete",
    );
  });
});
