/**
 * Money formatter (Bible §9.11 "amounts through the shared formatters only";
 * OP-8 multi-currency). Amounts are stored as BIGINT MINOR UNITS (Bible §4 — no
 * floats near money); this converts by the currency's own exponent and formats
 * with Intl, pinning LATIN numerals under `ar` (audit F-44 — GCC business
 * documents use Western digits, not ٥٬٠٠٠).
 *
 * KWD/BHD/OMR are 3-decimal currencies — minorUnitExponent + Intl both agree.
 */
import { minorUnitExponent, type CurrencyCode, type Locale } from "@/platform/registries";

export type MoneyFormatOptions = {
  locale?: Locale;
  /** Show the currency code/symbol (default true). */
  withCurrencySymbol?: boolean;
};

/** Force the Latin numbering system regardless of locale (F-44 default). */
function intlLocale(locale: Locale): string {
  return `${locale}-u-nu-latn`;
}

/**
 * Format a minor-unit integer amount in its currency.
 * `minorAmount` is an integer (number or bigint) of minor units.
 */
export function formatMoney(
  minorAmount: number | bigint,
  currency: CurrencyCode,
  options: MoneyFormatOptions = {},
): string {
  const { locale = "en", withCurrencySymbol = true } = options;
  const exponent = minorUnitExponent(currency);
  const divisor = 10 ** exponent;
  // Money integrity (§4): minor-unit amounts are integers; beyond 2^53 a JS
  // double loses integer precision. Real amounts are astronomically below this
  // (millions of major units), so an out-of-range value is data corruption —
  // fail loud rather than silently mis-format.
  const minorNumber = Number(minorAmount);
  if (!Number.isSafeInteger(minorNumber)) {
    throw new RangeError(`money amount out of safe integer range: ${minorAmount}`);
  }
  const major = minorNumber / divisor;

  const fmt = new Intl.NumberFormat(intlLocale(locale), {
    style: withCurrencySymbol ? "currency" : "decimal",
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
    numberingSystem: "latn",
  });
  return fmt.format(major);
}

/** Parse a decimal major-unit string into minor units (integer). Never floats-through. */
export function toMinorUnits(major: string | number, currency: CurrencyCode): number {
  const exponent = minorUnitExponent(currency);
  const n = typeof major === "number" ? major : Number(major);
  if (!Number.isFinite(n)) throw new Error("invalid amount");
  return Math.round(n * 10 ** exponent);
}
