/**
 * Author-supplied field patterns for public forms (security review 2026-09-20,
 * F-25).
 *
 * A form author may attach a regular expression to a text field, and the
 * expression is evaluated on the server against whatever an anonymous visitor
 * submits. JavaScript's engine backtracks, so a pattern such as `(a+)+$` takes
 * exponential time on a string of a's that ends in a mismatch: one submission
 * could pin a CPU for minutes. There is no way to interrupt a running match,
 * so the defence is to refuse the shapes that backtrack catastrophically
 * BEFORE they are saved, and to bound the input a pattern is ever tested
 * against.
 *
 * What is refused (each is a known catastrophic shape, and none is needed
 * for the field-format checks a form author actually writes — phone numbers,
 * reference codes, postcodes):
 *   - a quantifier applied to a group that itself contains a quantifier
 *     (`(a+)+`, `(\d*)*`, `(ab?){2,}`);
 *   - a quantified group whose alternatives can match the same text
 *     (`(a|a)*`, `(\w|\d)+`) — approximated as alternation inside a
 *     quantified group;
 *   - backreferences (`\1`), which turn matching NP-hard;
 *   - lookaround, which the simple analysis cannot bound;
 *   - a pattern that does not compile.
 * Nested groups are permitted when no quantifier sits on a quantified group.
 * Everything else is evaluated against at most `MAX_PATTERN_INPUT` characters.
 */

export const MAX_PATTERN_LENGTH = 200;
/** Longer inputs are still stored (up to the field's own cap); only the
 * pattern test sees the first slice, and a longer value is reported as not
 * matching, never as matching. */
export const MAX_PATTERN_INPUT = 1_000;

export type PatternVerdict = { ok: true } | { ok: false; reason: string };

/** Split a pattern into tokens, keeping escapes and classes opaque. */
function tokens(pattern: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      out.push(pattern.slice(i, i + 2));
      i++;
    } else if (c === "[") {
      let j = i + 1;
      if (pattern[j] === "^") j++;
      if (pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") {
        if (pattern[j] === "\\") j++;
        j++;
      }
      out.push(pattern.slice(i, j + 1));
      i = j;
    } else if (c === "{") {
      const m = /^\{\d+(,\d*)?\}/.exec(pattern.slice(i));
      if (m) {
        out.push(m[0]);
        i += m[0].length - 1;
      } else out.push(c);
    } else out.push(c);
  }
  return out;
}

const isQuantifier = (t: string): boolean =>
  t === "*" || t === "+" || t === "?" || t.startsWith("{");

/**
 * Decide whether a pattern may be saved and evaluated. Pure and cheap: it
 * walks the pattern once, never runs it.
 */
export function checkPattern(pattern: string): PatternVerdict {
  if (pattern.length === 0) return { ok: true };
  if (pattern.length > MAX_PATTERN_LENGTH) return { ok: false, reason: "too_long" };
  if (/\\[1-9]/.test(pattern) || /\\k</.test(pattern))
    return { ok: false, reason: "backreference" };
  if (/\(\?[=!<]/.test(pattern)) return { ok: false, reason: "lookaround" };
  try {
    new RegExp(pattern, "u");
  } catch {
    try {
      new RegExp(pattern);
    } catch {
      return { ok: false, reason: "syntax" };
    }
  }

  // Walk groups: for each group note whether it contains a quantifier or a
  // top-level alternation; a quantifier immediately after such a group is the
  // catastrophic shape.
  const ts = tokens(pattern);
  type Frame = { hasQuantifier: boolean; hasAlternation: boolean };
  const stack: Frame[] = [];
  let prevClosedGroup: Frame | null = null;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!;
    if (t === "(") {
      stack.push({ hasQuantifier: false, hasAlternation: false });
      prevClosedGroup = null;
      continue;
    }
    if (t === ")") {
      const frame = stack.pop();
      if (!frame) return { ok: false, reason: "syntax" };
      const parent = stack[stack.length - 1];
      if (parent && frame.hasQuantifier) parent.hasQuantifier = true;
      prevClosedGroup = frame;
      continue;
    }
    if (t === "|") {
      const frame = stack[stack.length - 1];
      if (frame) frame.hasAlternation = true;
      prevClosedGroup = null;
      continue;
    }
    if (isQuantifier(t)) {
      if (prevClosedGroup && (prevClosedGroup.hasQuantifier || prevClosedGroup.hasAlternation)) {
        return { ok: false, reason: "nested_quantifier" };
      }
      const frame = stack[stack.length - 1];
      if (frame) frame.hasQuantifier = true;
      // A lazy/possessive suffix (`+?`) is a modifier, not a second quantifier.
      if (ts[i + 1] === "?") i++;
      prevClosedGroup = null;
      continue;
    }
    prevClosedGroup = null;
  }
  if (stack.length > 0) return { ok: false, reason: "syntax" };
  return { ok: true };
}

/**
 * Evaluate a saved pattern against a submitted value. A pattern that fails the
 * check (a legacy row saved before the check existed) is never run — the
 * field is treated as unconstrained, which is what an invalid pattern already
 * meant. Input longer than the bound is reported as not matching.
 */
export function testPattern(pattern: string, value: string): boolean {
  if (!checkPattern(pattern).ok) return true;
  if (value.length > MAX_PATTERN_INPUT) return false;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}
