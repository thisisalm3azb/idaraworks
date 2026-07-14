/**
 * Template terminology registry. Historically hand-maintained for template #1
 * (boat-building); now DERIVED from the platform template registry so every
 * shipped manifest's terminology is auto-registered — a new template cannot be
 * forgotten here (the old failure mode: falling back to "Job" silently). The
 * legacy "boat-building" alias predates S1 and stays for stored settings.
 */
import type { TerminologyMap } from "./catalogue";
import { TEMPLATE_CATALOGUE } from "@/platform/config/templates";

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

/** Registered template terminologies by key — derived from the catalogue. */
export const TEMPLATE_TERMS: Record<string, TerminologyMap> = {
  "boat-building": TEMPLATE_BOAT_TERMS, // legacy alias (pre-S1 stored settings)
  ...Object.fromEntries(
    TEMPLATE_CATALOGUE.map((e) => [e.manifest.key, e.manifest.terminology as TerminologyMap]),
  ),
};
