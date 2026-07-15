/**
 * Date/number formatters (Bible §9.11). Business dates render in the ORG's
 * timezone; numerals are LATIN by default under `ar` (F-44). Instants are
 * `timestamptz` (UTC) in the DB; business dates are `date` strings.
 */
import type { Locale } from "@/platform/registries";

function intlLocale(locale: Locale): string {
  return `${locale}-u-nu-latn`;
}

export type DateFormatOptions = {
  locale?: Locale;
  timeZone?: string; // org timezone, e.g. 'Asia/Dubai'
};

/** Format an instant (Date or ISO string) as a date in the org timezone. */
export function formatDate(instant: Date | string, options: DateFormatOptions = {}): string {
  const { locale = "en", timeZone = "Asia/Dubai" } = options;
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone,
    numberingSystem: "latn",
  }).format(d);
}

/** Format an instant as date + time in the org timezone. */
export function formatDateTime(instant: Date | string, options: DateFormatOptions = {}): string {
  const { locale = "en", timeZone = "Asia/Dubai" } = options;
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
    numberingSystem: "latn",
  }).format(d);
}

/**
 * Format an instant as a wall-clock time (HH:MM) in the ORG's timezone.
 * When no timezone is known the value renders in UTC with an explicit "UTC"
 * suffix — an honest label beats silently pretending UTC is local time.
 */
export function formatTime(instant: Date | string, options: DateFormatOptions = {}): string {
  const { locale = "en", timeZone } = options;
  const d = typeof instant === "string" ? new Date(instant) : instant;
  const render = (tz: string) =>
    new Intl.DateTimeFormat(intlLocale(locale), {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
      numberingSystem: "latn",
    }).format(d);
  return timeZone ? render(timeZone) : `${render("UTC")} UTC`;
}

/** Format a plain number with Latin digits (F-44). */
export function formatNumber(
  value: number,
  locale: Locale = "en",
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    numberingSystem: "latn",
    ...options,
  }).format(value);
}
