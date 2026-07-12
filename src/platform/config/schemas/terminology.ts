/**
 * TerminologyMap config schema (doc 09 §2). Validates the org override blob the
 * resolver reads from app_settings (key `terminology.overrides`) and that the
 * S1 config pipeline will write. Keys are the closed TERM_KEYS registry; values
 * carry length caps + no markup (doc 07 "Values are validated").
 */
import { z } from "zod";
import { TERM_KEYS } from "@/platform/registries";
import { configString } from "../sanitize";

// S1: term values pass the full config-string sanitiser (doc 10 #24) — no
// markup, no ICU metacharacters, no formula leads, no control chars, 40-cap.
const termForm = z.object({
  singular: configString(40),
  plural: configString(40),
  gender: z.enum(["m", "f"]).optional(),
});

const termEntry = z.object({
  en: termForm,
  ar: termForm.extend({ gender: z.enum(["m", "f"]) }), // gender required for ar
});

/** Partial: an override supplies only the keys it changes. */
export const TerminologyOverrideSchema = z
  .object(Object.fromEntries(TERM_KEYS.map((k) => [k, termEntry.optional()])))
  .strict(); // reject unknown keys — registry discipline

export type TerminologyOverride = z.infer<typeof TerminologyOverrideSchema>;

/** Parse defensively: malformed stored config must never crash a render. */
export function parseTerminologyOverride(raw: unknown): TerminologyOverride {
  const result = TerminologyOverrideSchema.safeParse(raw);
  return result.success ? result.data : {};
}
