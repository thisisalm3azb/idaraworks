/**
 * Deterministic template classification (post-MVP template catalogue).
 *
 * PURE + TRANSPARENT: scores the founder's free-text business description
 * against every catalogue entry's classification keywords/phrases and returns
 * the full ranked list with the evidence for each score — the preview screen
 * shows WHY a template was recommended and every alternative, and the founder
 * always chooses. This is the shipped selection path (it needs no AI provider);
 * an AI provider, when one is wired, may only produce the same ConfigProposal
 * shape re-checked by validateProposal — never arbitrary configuration.
 *
 * Scoring (documented in docs/templates/AI_TEMPLATE_SELECTION_RULES.md):
 *   keyword hit   +3 each   (word-boundary for latin, substring for Arabic)
 *   phrase match  +2×ratio  (informative-token overlap ≥ 50%)
 * Fallback: if the best non-generic score < MIN_SCORE the recommendation is
 * Generic Operations (never a forced bad fit); a lead < MIN_LEAD over the
 * runner-up marks the result ambiguous (confident=false) so the UI emphasises
 * the manual choice.
 */
import { TEMPLATE_CATALOGUE, type TemplateCatalogueEntry } from "@/platform/config";

export const GENERIC_TEMPLATE_KEY = "generic_operations_v1";
export const MIN_SCORE = 3; // below this, no specific template is a real match
export const MIN_LEAD = 2; // smaller lead over the runner-up = ambiguous

export type TemplateMatch = {
  key: string;
  score: number;
  matchedKeywords: string[];
  matchedPhrases: string[];
};

export type ClassificationResult = {
  /** Every catalogue template, best first (ties broken by catalogue order). */
  ranked: TemplateMatch[];
  recommendedKey: string;
  /** false = ambiguous or generic fallback — UI emphasises manual selection. */
  confident: boolean;
};

/** Latin lowercase + Arabic normalisation (strip tashkeel, unify alef/yaa/taa marbuta). */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[ً-ْٰ]/g, "") // tashkeel + dagger alef
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const HAS_ARABIC = /[؀-ۿ]/;

/** Stopwords excluded from phrase-overlap scoring (weak signals). */
const STOPWORDS = new Set([
  "we",
  "run",
  "have",
  "own",
  "the",
  "and",
  "for",
  "our",
  "with",
  "small",
  "company",
  "business",
  "shop",
  "in",
  "a",
  "an",
  "of",
  "to",
  "على",
  "في",
  "لدينا",
  "نملك",
  "نحن",
  "شركه",
  "مؤسسه",
  "محل",
  "عمل",
]);

function informativeTokens(normalized: string): string[] {
  return normalized
    .split(" ")
    .filter((t) => t.length >= (HAS_ARABIC.test(t) ? 2 : 3) && !STOPWORDS.has(t));
}

function keywordHits(normalizedText: string, keywords: string[]): string[] {
  const hits: string[] = [];
  for (const raw of keywords) {
    const kw = normalizeText(raw);
    if (!kw) continue;
    if (HAS_ARABIC.test(kw)) {
      if (normalizedText.includes(kw)) hits.push(raw);
    } else {
      // Word-boundary match for latin keywords/bigrams (no substring false hits).
      const re = new RegExp(`(?:^| )${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`);
      if (re.test(normalizedText)) hits.push(raw);
    }
  }
  return hits;
}

function phraseMatches(
  textTokens: Set<string>,
  phrases: string[],
): Array<{ phrase: string; ratio: number }> {
  const out: Array<{ phrase: string; ratio: number }> = [];
  for (const raw of phrases) {
    const tokens = informativeTokens(normalizeText(raw));
    if (tokens.length === 0) continue;
    const matched = tokens.filter((t) => textTokens.has(t)).length;
    const ratio = matched / tokens.length;
    if (ratio >= 0.5) out.push({ phrase: raw, ratio });
  }
  return out;
}

export function scoreTemplate(description: string, entry: TemplateCatalogueEntry): TemplateMatch {
  const normalized = normalizeText(description);
  const tokens = new Set(informativeTokens(normalized));
  const kws = keywordHits(normalized, entry.classificationKeywords);
  const phrases = phraseMatches(tokens, entry.classificationPhrases);
  const score = kws.length * 3 + phrases.reduce((s, p) => s + 2 * p.ratio, 0);
  return {
    key: entry.key,
    score: Math.round(score * 100) / 100,
    matchedKeywords: kws,
    matchedPhrases: phrases.map((p) => p.phrase),
  };
}

/**
 * Classify a business description against the template catalogue.
 * Deterministic: same input → same output (stable tie-break by catalogue order).
 */
export function classifyBusiness(
  description: string,
  catalogue: readonly TemplateCatalogueEntry[] = TEMPLATE_CATALOGUE,
): ClassificationResult {
  const ranked = catalogue
    .map((e) => scoreTemplate(description, e))
    .sort((a, b) => b.score - a.score); // Array.prototype.sort is stable — catalogue order breaks ties
  const nonGeneric = ranked.filter((m) => m.key !== GENERIC_TEMPLATE_KEY);
  const top = nonGeneric[0];
  const second = nonGeneric[1];

  if (!top || top.score < MIN_SCORE) {
    return { ranked, recommendedKey: GENERIC_TEMPLATE_KEY, confident: false };
  }
  const confident = !second || top.score - second.score >= MIN_LEAD;
  return { ranked, recommendedKey: top.key, confident };
}
