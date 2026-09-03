import "server-only";
/**
 * H29C — reading and writing the recorded half of translation governance.
 *
 * Split from `release.ts` on purpose: the laws (what completeness means, what
 * readiness a given measurement plus record implies) are pure and unit-tested
 * against the real catalogues, while this file is the only thing that touches
 * the database or the release flags.
 */
import { sql, withUserCtx } from "@/platform/tenancy";
import { SUPPORTED_LOCALES, type Locale } from "@/platform/registries";
import { localeIsOffered } from "./offered";
import {
  localeCompleteness,
  localeReadiness,
  type LocaleReleaseRow,
  type LocaleStatus,
  type ProductionMethod,
  type ReviewState,
} from "./release";

function toRow(r: Record<string, unknown>): LocaleReleaseRow {
  return {
    locale: String(r.locale) as Locale,
    production: String(r.production) as ProductionMethod,
    nativeReview: String(r.native_review) as ReviewState,
    nativeReviewer: (r.native_reviewer as string | null) ?? null,
    nativeReviewedAt: (r.native_reviewed_at as string | null) ?? null,
    legalReview: String(r.legal_review) as ReviewState,
    legalReviewer: (r.legal_reviewer as string | null) ?? null,
    legalReviewedAt: (r.legal_reviewed_at as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  };
}

/**
 * Every shipped language with its measured completeness and recorded review.
 *
 * The registry drives the list, not the table: a language with no row at all
 * must still appear, reading as "awaiting review", because a missing record is
 * exactly the case that must never look like approval.
 */
export async function localeStatuses(userId: string): Promise<LocaleStatus[]> {
  const rows = (await withUserCtx(userId, (tx) =>
    tx.execute(sql`
      select locale, production, native_review, native_reviewer,
             native_reviewed_at::text as native_reviewed_at,
             legal_review, legal_reviewer, legal_reviewed_at::text as legal_reviewed_at, note
        from public.locale_release`),
  )) as unknown as Array<Record<string, unknown>>;
  const byLocale = new Map(rows.map((r) => [String(r.locale), toRow(r)]));
  return SUPPORTED_LOCALES.map((locale) => {
    const completeness = localeCompleteness(locale);
    const release = byLocale.get(locale) ?? null;
    return {
      completeness,
      release,
      readiness: localeReadiness(completeness, release),
      offered: localeIsOffered(locale),
    };
  });
}

/**
 * Record how a language was produced and what review it has had. Operator-only,
 * enforced in the database; a decided review without a named reviewer is
 * refused there too, so an unevidenced claim cannot be stored by any path.
 */
export async function setLocaleRelease(
  userId: string,
  input: {
    locale: Locale;
    production: ProductionMethod;
    nativeReview: ReviewState;
    nativeReviewer: string | null;
    legalReview: ReviewState;
    legalReviewer: string | null;
    note: string | null;
  },
): Promise<void> {
  await withUserCtx(userId, (tx) =>
    tx.execute(sql`
      select app.locale_release_set(
        ${input.locale}, ${input.production},
        ${input.nativeReview}, ${input.nativeReviewer},
        ${input.legalReview}, ${input.legalReviewer}, ${input.note})`),
  );
}
