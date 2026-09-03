import "server-only";
/**
 * H29 — which languages a person may actually CHOOSE, as opposed to which
 * languages the product has a catalogue for.
 *
 * The two are deliberately different. `SUPPORTED_LOCALES` is the closed registry
 * every catalogue, test and type is checked against; a language belongs there
 * from the moment its catalogue is complete. Whether people are OFFERED it is a
 * release decision, because a language can be complete in the catalogue and
 * still be waiting on the native review the mandate requires before general
 * availability.
 *
 * Server-only on purpose. The gate reads an environment flag, and a flag read in
 * a client bundle is always `undefined` — which would make the browser normalise
 * a locale the server had accepted, and the page would hydrate in the wrong
 * language. Every locale decision that can be influenced by a cookie goes
 * through here.
 */
import { SUPPORTED_LOCALES, type Locale } from "@/platform/registries";
import { localeEsEnabled } from "@/platform/flags";
import { DEFAULT_LOCALE, LOCALE_NATIVE_NAME, normalizeLocale } from "./locale";

/** Locales gated behind a release flag, with the gate that opens each one. */
const GATED: Partial<Record<Locale, () => boolean>> = {
  es: localeEsEnabled,
};

/** The languages this deployment offers, in registry order. */
export function offeredLocales(): readonly Locale[] {
  return SUPPORTED_LOCALES.filter((locale) => (GATED[locale] ?? (() => true))());
}

export function localeIsOffered(locale: Locale): boolean {
  return (GATED[locale] ?? (() => true))();
}

/**
 * Resolve an untrusted locale string (a cookie, a form field) to one this
 * deployment actually offers. An unknown value and a gated-off value both land
 * on the default, so turning a flag back off cannot leave anyone stranded in a
 * language the deployment has withdrawn.
 */
export function resolveOfferedLocale(value: string | undefined | null): Locale {
  const locale = normalizeLocale(value);
  return localeIsOffered(locale) ? locale : DEFAULT_LOCALE;
}

/**
 * The offered languages named in the READER's language and joined by their own
 * grammar — "Arabic and English", "العربية والإنجليزية", "árabe e inglés".
 *
 * Copy that lists the interface languages must never hard-code the list. Before
 * H29 several marketing strings said "Arabic and English" in prose, which was
 * true only for as long as there were exactly two; the moment a third language
 * is released those sentences become false claims about the product in three
 * catalogues at once. Deriving the list from the same gate the switcher uses
 * makes that impossible.
 *
 * Falls back to the locale's own name list if the runtime lacks the Intl data,
 * so a formatting gap can never blank a sentence.
 */
export function languageListFor(
  locale: Locale,
  type: "conjunction" | "disjunction" = "conjunction",
): string {
  const locales = offeredLocales();
  let names: string[];
  try {
    const display = new Intl.DisplayNames([locale], { type: "language" });
    names = locales.map((candidate) => display.of(candidate) ?? LOCALE_NATIVE_NAME[candidate]);
  } catch {
    names = locales.map((candidate) => LOCALE_NATIVE_NAME[candidate]);
  }
  try {
    return new Intl.ListFormat(locale, { style: "long", type }).format(names);
  } catch {
    return names.join(", ");
  }
}

/**
 * Both list forms at once, ready to spread into a t() call. Copy needs "English
 * and Arabic" in one sentence and "English or Arabic" in the next, and asking
 * every call site to remember which is which is how one of them ends up wrong.
 */
export function languageVars(locale: Locale): { languages: string; languages_or: string } {
  return {
    languages: languageListFor(locale, "conjunction"),
    languages_or: languageListFor(locale, "disjunction"),
  };
}
