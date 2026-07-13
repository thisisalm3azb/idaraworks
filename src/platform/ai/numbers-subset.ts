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

/** Every numeric token in a string, canonicalised to values (deduped). */
export function extractNumbers(text: string): number[] {
  const norm = normalizeNumerals(text);
  // A run of digits with optional grouping/decimal and optional trailing %.
  const matches = norm.match(/\d[\d,.٫٬]*\s?%?/g) ?? [];
  const values: number[] = [];
  for (const m of matches) {
    const v = canonicalize(m.trim());
    if (v !== null) values.push(v);
  }
  return values;
}

/**
 * True iff EVERY number in `text` appears in `allowed` (compared by value, with a small
 * epsilon for the 1-dp rounding the digest uses). An empty-number narration trivially
 * passes (prose with no figures is fine). `allowed` is the set of numbers the
 * deterministic payload contains.
 */
export function validateNumbersSubset(
  text: string,
  allowed: readonly number[],
): { ok: boolean; offending: number[] } {
  const allowedSet = allowed.map((n) => Number(n));
  const offending: number[] = [];
  for (const n of extractNumbers(text)) {
    const found = allowedSet.some((a) => Math.abs(a - n) < 0.05);
    if (!found) offending.push(n);
  }
  return { ok: offending.length === 0, offending };
}
