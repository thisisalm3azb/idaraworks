/**
 * H29C — translation governance: what each shipped language's catalogue is, how
 * it was produced, and what review it has actually had.
 *
 * Two different kinds of fact meet here and are kept apart on purpose.
 *
 * COMPLETENESS is measured, right now, from the catalogue files themselves. It
 * is never stored, because a stored percentage is a claim that can drift from
 * the thing it describes; a count taken from the file cannot.
 *
 * PRODUCTION AND REVIEW are recorded by a person in `locale_release`. Nothing
 * infers them. A catalogue being 100% complete says nothing about whether a
 * native speaker has read it, and the mandate is explicit that native review may
 * not be claimed without evidence — so the absence of a review row reads as
 * "not started", never as "fine".
 *
 * This half is deliberately PURE — no database, no flags, no server-only import
 * — so the laws below are unit-testable against the real catalogues. Reading and
 * writing the recorded row lives in `release-store.ts`.
 */
import { type Locale } from "@/platform/registries";
import en from "./messages/en.json";
import ar from "./messages/ar.json";
import es from "./messages/es.json";
import arSame from "./messages/ar.same.json";
import esSame from "./messages/es.same.json";

const CATALOGS: Record<Locale, Record<string, string>> = {
  en: en as Record<string, string>,
  ar: ar as Record<string, string>,
  es: es as Record<string, string>,
};

/**
 * Locales whose "identical to English" keys were reviewed and recorded. English
 * has no list because measuring the source language against itself is
 * meaningless — it is identified by its recorded production method instead.
 */
const RECORDED_IDENTICAL: Partial<Record<Locale, ReadonlySet<string>>> = {
  ar: new Set(arSame as string[]),
  es: new Set(esSame as string[]),
};

export type LocaleCompleteness = {
  locale: Locale;
  /** Keys the English catalogue defines — the denominator, always. */
  total: number;
  /** Keys whose text genuinely differs from the English. */
  translated: number;
  /** Keys a translator recorded as legitimately identical (names, codes). */
  recordedIdentical: number;
  /** Keys still showing English text with no explanation. The number that matters. */
  untranslated: number;
  /** Keys the locale has no entry for at all. */
  missing: number;
};

/** Measured now, from the files. Never cached, never stored. */
export function localeCompleteness(locale: Locale): LocaleCompleteness {
  const source = CATALOGS.en;
  const target = CATALOGS[locale] ?? {};
  const recorded = RECORDED_IDENTICAL[locale] ?? new Set<string>();
  let translated = 0;
  let recordedIdentical = 0;
  let untranslated = 0;
  let missing = 0;
  for (const [key, value] of Object.entries(source)) {
    const mine = target[key];
    if (mine === undefined) missing++;
    else if (mine !== value) translated++;
    else if (recorded.has(key)) recordedIdentical++;
    else untranslated++;
  }
  return {
    locale,
    total: Object.keys(source).length,
    translated,
    recordedIdentical,
    untranslated,
    missing,
  };
}

export type ReviewState = "not_applicable" | "not_started" | "in_progress" | "passed" | "failed";
export type ProductionMethod = "source" | "machine_assisted" | "native_authored" | "professional";

export type LocaleReleaseRow = {
  locale: Locale;
  production: ProductionMethod;
  nativeReview: ReviewState;
  nativeReviewer: string | null;
  nativeReviewedAt: string | null;
  legalReview: ReviewState;
  legalReviewer: string | null;
  legalReviewedAt: string | null;
  note: string | null;
};

/**
 * The six states a language can genuinely be in. Deliberately not a percentage:
 * a single number would let "94% translated, no review" and "100% translated,
 * review failed" look like neighbours, when the second must not ship and the
 * first is ordinary work in progress.
 */
export type LocaleReadiness =
  | "source_language"
  | "catalogue_incomplete"
  | "awaiting_native_review"
  | "native_review_in_progress"
  | "native_review_failed"
  | "reviewed";

export function localeReadiness(
  completeness: LocaleCompleteness,
  release: LocaleReleaseRow | null,
): LocaleReadiness {
  if (release?.production === "source") return "source_language";
  if (completeness.untranslated > 0 || completeness.missing > 0) return "catalogue_incomplete";
  switch (release?.nativeReview) {
    case "passed":
      return "reviewed";
    case "failed":
      return "native_review_failed";
    case "in_progress":
      return "native_review_in_progress";
    default:
      // No row at all reads exactly like a row saying "not started". An absent
      // record is not evidence of a review.
      return "awaiting_native_review";
  }
}

export type LocaleStatus = {
  completeness: LocaleCompleteness;
  release: LocaleReleaseRow | null;
  readiness: LocaleReadiness;
  /** Whether this deployment currently OFFERS the language to people. */
  offered: boolean;
};
