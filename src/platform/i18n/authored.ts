/**
 * H29 — reading text an ORGANISATION wrote, as opposed to product copy.
 *
 * Product copy lives in the message catalogue and exists in every shipped
 * language. Text a customer typed — a stage name, a custom status label — exists
 * only in the languages they typed it in, and H29 deliberately did not add a
 * third column to every content table (truth map C.2, assumption G2).
 *
 * So this is the one place that decides what to show when a reader's language is
 * not among them: the reader's own language if it is there, then the
 * organisation's first language, then anything at all. It never translates and
 * never blanks a name.
 */
import type { Locale } from "@/platform/registries";

/** Text an organisation authored, keyed by whatever languages they used. */
export type AuthoredText = Partial<Record<Locale, string>> & { en?: string; ar?: string };

export function pickAuthoredText(
  text: AuthoredText | null | undefined,
  locale: Locale,
  fallback = "",
): string {
  if (!text) return fallback;
  const own = text[locale];
  if (typeof own === "string" && own.trim().length > 0) return own;
  for (const candidate of ["en", "ar", "es"] as const) {
    const value = text[candidate];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return fallback;
}
