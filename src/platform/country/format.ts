/**
 * H29 — formatting that knows which context it is in.
 *
 * The mandate's distinction, made explicit in one type rather than left to
 * whoever calls a formatter:
 *
 *   uiLocale        the language the reader chose
 *   documentLocale  the language a document is produced in, which is a legal
 *                   matter in some jurisdictions and is NOT the reader's choice
 *   jurisdiction    the establishment's country, which decides the rules
 *   timezone        the establishment's timezone, never the browser's
 *   currency        the currency of the transaction
 *
 * Browser locale never decides any of them. A date shown without a timezone
 * would drift across midnight, so `FormattingContext.timezone` is required.
 */
import type { Locale } from "@/platform/registries";
import { minorUnitExponent, type CurrencyCode } from "@/platform/registries";

export type FormattingContext = {
  uiLocale: Locale;
  documentLocale?: Locale;
  /** ISO 3166-1 alpha-2 of the establishment whose rules apply. */
  jurisdiction: string;
  /** IANA identifier, e.g. "Asia/Riyadh". Required: there is no safe default. */
  timezone: string;
  currency: CurrencyCode;
  /** Whether the pack allows a Hijri date beside the Gregorian one. */
  hijriDisplay?: boolean;
};

/**
 * Numerals stay Latin in every locale, including Arabic (F-44: Gulf business
 * documents use Western digits). Spanish inherits the same rule, which also
 * keeps a number the same string in every language of one document.
 */
function intlLocale(locale: Locale): string {
  return `${locale}-u-nu-latn`;
}

export function formatAmount(
  minorAmount: number | bigint,
  ctx: FormattingContext,
  options: { locale?: Locale; withCurrency?: boolean } = {},
): string {
  const locale = options.locale ?? ctx.documentLocale ?? ctx.uiLocale;
  const exponent = minorUnitExponent(ctx.currency);
  const minor = Number(minorAmount);
  if (!Number.isSafeInteger(minor))
    throw new RangeError(`money amount out of safe integer range: ${minorAmount}`);
  return new Intl.NumberFormat(intlLocale(locale), {
    style: options.withCurrency === false ? "decimal" : "currency",
    currency: ctx.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
    numberingSystem: "latn",
  }).format(minor / 10 ** exponent);
}

export function formatPercent(
  fraction: number,
  ctx: FormattingContext,
  options: { locale?: Locale; decimals?: number } = {},
): string {
  const locale = options.locale ?? ctx.documentLocale ?? ctx.uiLocale;
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "percent",
    minimumFractionDigits: options.decimals ?? 0,
    maximumFractionDigits: options.decimals ?? 2,
    numberingSystem: "latn",
  }).format(fraction);
}

/**
 * A business date is a calendar day, not an instant. It is formatted in the
 * establishment's timezone with the day pinned to noon UTC so that no timezone
 * offset can move it to the day before or after.
 */
export function formatBusinessDate(
  isoDate: string,
  ctx: FormattingContext,
  options: { locale?: Locale; long?: boolean } = {},
): string {
  const locale = options.locale ?? ctx.documentLocale ?? ctx.uiLocale;
  const at = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: options.long ? "long" : "short",
    day: "numeric",
    timeZone: "UTC",
    numberingSystem: "latn",
  }).format(at);
}

/** An instant, rendered in the establishment's timezone. */
export function formatInstant(
  instant: Date | string,
  ctx: FormattingContext,
  options: { locale?: Locale; withTime?: boolean } = {},
): string {
  const locale = options.locale ?? ctx.documentLocale ?? ctx.uiLocale;
  const at = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(options.withTime === false ? {} : { hour: "2-digit", minute: "2-digit" }),
    timeZone: ctx.timezone,
    numberingSystem: "latn",
  }).format(at);
}

/**
 * The Hijri rendering of a business date, for packs that allow it. Display
 * only: every stored business date stays Gregorian (assumption G5). Returns
 * null when the pack does not allow it or the runtime lacks the calendar.
 */
export function formatHijriDate(isoDate: string, ctx: FormattingContext): string | null {
  if (!ctx.hijriDisplay) return null;
  try {
    const at = new Date(`${isoDate}T12:00:00Z`);
    return new Intl.DateTimeFormat(`${ctx.uiLocale}-u-ca-islamic-umalqura-nu-latn`, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(at);
  } catch {
    return null;
  }
}

/** The day of the week an ISO date falls on, in the pack's own vocabulary. */
export function weekdayOf(isoDate: string): "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat" {
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  return days[new Date(`${isoDate}T12:00:00Z`).getUTCDay()]!;
}
