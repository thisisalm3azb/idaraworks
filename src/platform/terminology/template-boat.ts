/**
 * Template #1 (boat-building) terminology overrides (doc 08). A boat-building
 * org sees "Boat/قارب" for `job` and Najolatech's house term "LPO" for
 * `purchase_order` — exactly the override-style terms doc 07 calls out. Only the
 * keys that differ from the platform default are listed; the rest fall through.
 */
import type { TerminologyMap } from "./catalogue";

export const TEMPLATE_BOAT_TERMS: TerminologyMap = {
  job: {
    en: { singular: "Boat", plural: "Boats" },
    ar: { singular: "قارب", plural: "قوارب", gender: "m" },
  },
  // Najolatech says "LPO", not "PO" (doc 07 example).
  purchase_order: {
    en: { singular: "LPO", plural: "LPOs" },
    ar: { singular: "أمر شراء محلي", plural: "أوامر شراء محلية", gender: "m" },
  },
};

/** Registered templates by key (S1 config pipeline selects one per org). */
export const TEMPLATE_TERMS: Record<string, TerminologyMap> = {
  "boat-building": TEMPLATE_BOAT_TERMS,
};
