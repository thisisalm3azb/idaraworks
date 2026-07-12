/**
 * Config-string sanitiser (doc 10 #24; audit F-25). EVERY tenant-authored
 * string in a config artifact (labels, names, terms, descriptions) passes this
 * at the single config write path. Policy is REJECT, never silently clamp —
 * a validator that mutates input hides the problem from the editor.
 *
 * Rules:
 *  - no markup characters   < >            (tag injection; a BARE & is allowed —
 *    doc-08 template content itself uses "Finishing & Polishing", React escapes
 *    by default, and the export layer quotes defensively per doc 09. &-escapes
 *    cannot form entities without surrounding markup, which < > already ban.)
 *  - no ICU metacharacters  { } #          (labels are interpolated into ICU messages)
 *  - no leading = + - @                    (CSV/spreadsheet formula injection)
 *  - no control characters  (C0/C1, incl. \n \t) — single-line values only
 *  - trimmed, non-empty, bounded length
 *
 * The export layer additionally quotes defensively and LLM payloads delimit
 * tenant strings (doc 09 envelope note) — this is the first wall, not the only.
 */
import { z } from "zod";

export const MAX_LABEL_LENGTH = 80;
export const MAX_TEXT_LENGTH = 200;

const MARKUP = /[<>]/;
const ICU_META = /[{}#]/;
const FORMULA_LEAD = /^[=+\-@]/;
// C0 (0x00-0x1f) + DEL/C1 (0x7f-0x9f), built from char codes so no escape
// sequence survives tooling layers; includes newline/tab (single-line values).
const cc = String.fromCharCode;
const CONTROL = new RegExp("[" + cc(0) + "-" + cc(31) + cc(127) + "-" + cc(159) + "]");

export type ConfigStringIssue =
  "empty" | "too_long" | "markup" | "icu_metacharacter" | "formula_lead" | "control_character";

/** Pure check — returns the first violated rule, or null when clean. */
export function configStringIssue(raw: string, maxLength: number): ConfigStringIssue | null {
  const value = raw.trim();
  if (value.length === 0) return "empty";
  if (value.length > maxLength) return "too_long";
  if (MARKUP.test(value)) return "markup";
  if (ICU_META.test(value)) return "icu_metacharacter";
  if (FORMULA_LEAD.test(value)) return "formula_lead";
  if (CONTROL.test(value)) return "control_character";
  return null;
}

/** Zod string type with the sanitiser applied — use for EVERY tenant-authored
 * config string. Trims; rejects (never clamps) on any rule violation. */
export function configString(maxLength: number = MAX_LABEL_LENGTH) {
  return z
    .string()
    .transform((s) => s.trim())
    .superRefine((value, ctx) => {
      const issue = configStringIssue(value, maxLength);
      if (issue) {
        ctx.addIssue({
          code: "custom",
          message: `config string rejected: ${issue}`,
          params: { issue },
        });
      }
    });
}
