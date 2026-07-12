/**
 * t() — the single string resolver (Bible §9.11; doc 07 D-7.1). Backed by ICU
 * MessageFormat (intl-messageformat) so messages support {var}, plural, and
 * select — the last is how Arabic gender/number agreement is expressed, with
 * domain nouns injected as variables from the terminology resolver.
 *
 * Numerals are pinned to LATIN even under `ar` (F-44). Compiled formats are
 * cached per (locale,key). A missing key never renders raw — it falls back to
 * the en catalog, then to a bracketed key marker (loud, not silent).
 */
import IntlMessageFormat from "intl-messageformat";
import { SUPPORTED_LOCALES, type Locale } from "@/platform/registries";
import { logger } from "@/platform/logger";
import en from "./messages/en.json";
import ar from "./messages/ar.json";

type Messages = Record<string, string>;

const catalogs: Record<Locale, Messages> = { en: en as Messages, ar: ar as Messages };

const formatCache = new Map<string, IntlMessageFormat>();

export type TVars = Record<string, string | number | boolean | null | undefined>;

export function t(key: string, vars?: TVars, locale: Locale = "en"): string {
  const template = catalogs[locale]?.[key] ?? catalogs.en?.[key];
  if (template === undefined) {
    logger.warn({ key, locale }, "i18n: missing message key");
    return `⟦${key}⟧`;
  }
  const cacheKey = `${locale}:${key}`;
  let mf = formatCache.get(cacheKey);
  if (!mf) {
    try {
      mf = new IntlMessageFormat(template, `${locale}-u-nu-latn`);
    } catch (err) {
      logger.warn({ key, locale, err: (err as Error).message }, "i18n: message compile failed");
      return template; // raw template beats a crash
    }
    formatCache.set(cacheKey, mf);
  }
  return String(mf.format(vars ?? {}));
}

export { SUPPORTED_LOCALES };
