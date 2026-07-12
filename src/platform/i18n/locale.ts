/**
 * Locale + direction resolution (Bible §9.11). The active locale comes from a
 * `locale` cookie (set from the user's user_profile.locale once known); absent
 * or unknown → the platform default `en`. Direction is derived: `ar` is RTL.
 * Kept dependency-free so the root layout (server component) and client
 * components share one source of truth.
 */
import { SUPPORTED_LOCALES, type Locale } from "@/platform/registries";

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "locale";

export type Direction = "ltr" | "rtl";

const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(["ar"]);

export function isSupportedLocale(value: string | undefined | null): value is Locale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function normalizeLocale(value: string | undefined | null): Locale {
  return isSupportedLocale(value) ? value : DEFAULT_LOCALE;
}

export function directionFor(locale: Locale): Direction {
  return RTL_LOCALES.has(locale) ? "rtl" : "ltr";
}
