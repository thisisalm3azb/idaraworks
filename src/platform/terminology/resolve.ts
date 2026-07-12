/**
 * Terminology resolver (doc 07 D-7.2). Resolution order, first hit wins:
 *   org override → template map → platform default
 * keyed by (term_key, language). A missing term falls back to the platform
 * default + a logged warning; a raw key never reaches the screen (doc 07 #4).
 *
 * `term()` is PURE over a resolved TermContext so it is trivially unit-testable
 * and callable from server components, message interpolation, and tests alike.
 * Loading the org's overrides (from app_settings) is the caller's concern —
 * loadOrgTerminology() does it once per request; term() then stays sync.
 */
import { logger } from "@/platform/logger";
import { isTermKey } from "@/platform/registries";
import type { Locale, TermKey } from "@/platform/registries";
import {
  PLATFORM_DEFAULT_TERMS,
  type Gender,
  type TerminologyMap,
  type TermForm,
} from "./catalogue";
import { TEMPLATE_TERMS } from "./template-boat";

export type TermContext = {
  locale: Locale;
  /** Org override map (validated), from app_settings. */
  overrides?: TerminologyMap;
  /** Selected template key (e.g. 'boat-building'); undefined = none. */
  templateKey?: string;
};

export type ResolvedTerm = {
  singular: string;
  plural: string;
  gender: Gender | null; // null under en (agreement is an ar concern)
};

function pickForm(map: TerminologyMap | undefined, key: TermKey, locale: Locale): TermForm | null {
  return map?.[key]?.[locale] ?? null;
}

/** Full resolved entry for a key — resolution order applied per language. */
export function resolveTerm(key: TermKey, ctx: TermContext): ResolvedTerm {
  if (!isTermKey(key)) {
    // Defensive: an unknown key must not render raw.
    logger.warn({ key }, "terminology: unknown term key");
  }
  const template = ctx.templateKey ? TEMPLATE_TERMS[ctx.templateKey] : undefined;
  const form =
    pickForm(ctx.overrides, key, ctx.locale) ??
    pickForm(template, key, ctx.locale) ??
    pickForm(PLATFORM_DEFAULT_TERMS, key, ctx.locale);

  if (!form) {
    logger.warn({ key, locale: ctx.locale }, "terminology: no term resolved, using en default");
    const en = PLATFORM_DEFAULT_TERMS[key]?.en ?? { singular: key, plural: key };
    return { singular: en.singular, plural: en.plural, gender: null };
  }
  return {
    singular: form.singular,
    plural: form.plural,
    gender: ctx.locale === "ar" ? (form.gender ?? "m") : null,
  };
}

export type TermVariant = "singular" | "plural";

/** The interpolation-friendly form: `term('job', ctx)` → the singular noun. */
export function term(key: TermKey, ctx: TermContext, variant: TermVariant = "singular"): string {
  return resolveTerm(key, ctx)[variant];
}
