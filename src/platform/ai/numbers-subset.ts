/**
 * The numbers-subset validator (doc 04 step 4; BUILD_BIBLE §10.4). AI narration may
 * only REPHRASE the deterministic digest — it must never introduce a number that is not
 * in the structured payload. This validator extracts every numeric token from the model's
 * prose, normalises it to a canonical value, and asserts each is present in the allowed
 * set (the numbers the deterministic digest already computed). A narration that fails
 * falls back to the deterministic digest — an invented figure never ships.
 *
 * Canonicalisation (doc 07: numerals are Latin-pinned, but a model may still emit
 * Arabic-Indic digits, thousands separators, or a trailing %): map Arabic-Indic and
 * Extended Arabic-Indic digits to Latin, strip grouping separators, drop a trailing
 * percent sign, and compare by NUMERIC VALUE (not string) so "10,500" ⇒ 10500 matches a
 * payload 10500, and "٤٢" ⇒ 42 matches 42.
 */

// Arabic-Indic (U+0660–0669) and Extended Arabic-Indic (U+06F0–06F9) → Latin 0–9.
export function normalizeNumerals(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else out += ch;
  }
  return out;
}

/** Parse a raw numeric token ("10,500", "42%", "1.5", "٤٢") to a canonical number. */
function canonicalize(token: string): number | null {
  const t = normalizeNumerals(token)
    .replace(/[,٬  ]/g, "") // thousands separators (comma, Arabic, thin/nbsp space)
    .replace(/[%٪]/g, "") // trailing percent
    .replace(/٫/g, "."); // Arabic decimal separator → dot
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// A numeric token: a digit run with optional grouping separators, then an OPTIONAL decimal
// part that must be a separator FOLLOWED by digits (so a trailing '.'/',' at a sentence
// boundary is NOT swallowed), then an optional trailing percent. Tightened (review): the
// old class [\d,.٫٬]* greedily ate a trailing '.', canonicalize() then returned null, and
// the token was silently dropped — a hallucinated sentence-final number was never checked.
const NUM_TOKEN = /\d[\d,٬]*(?:[.٫]\d+)?\s?[%٪]?/g;

/** Every numeric token in a string, canonicalised to values. An uncanonicalizable token
 * (should be impossible with NUM_TOKEN, but defensive) surfaces as NaN so the validator
 * fails CLOSED rather than dropping it. */
export function extractNumbers(text: string): number[] {
  const norm = normalizeNumerals(text);
  const matches = norm.match(NUM_TOKEN) ?? [];
  return matches.map((m) => {
    const v = canonicalize(m.trim());
    return v === null ? NaN : v;
  });
}

/**
 * True iff EVERY number in `text` appears in `allowed` (compared by value, with a small
 * epsilon for the 1-dp rounding the digest uses). An empty-number narration trivially
 * passes (prose with no figures is fine). A token that looks numeric but cannot be parsed
 * (NaN) is treated as OFFENDING — the validator FAILS CLOSED. `allowed` is the set of
 * numbers the deterministic payload contains.
 */
export function validateNumbersSubset(
  text: string,
  allowed: readonly number[],
): { ok: boolean; offending: number[] } {
  const allowedSet = allowed.map((n) => Number(n));
  const offending: number[] = [];
  for (const n of extractNumbers(text)) {
    const found = Number.isFinite(n) && allowedSet.some((a) => Math.abs(a - n) < 0.05);
    if (!found) offending.push(n);
  }
  return { ok: offending.length === 0, offending };
}
