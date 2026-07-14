/**
 * The closed platform template registry (post-MVP template catalogue). Every
 * shipped template registers BOTH its installable manifest and its catalogue
 * entry here; the registry is the single source the pipeline validator, the
 * installer, the terminology resolver, the onboarding classifier and the
 * chooser UI all read — a manifest cannot exist without selection metadata and
 * vice versa (entryIsCoherent + build-time tests enforce it).
 */
import type { TemplateManifest } from "../schemas/manifest";
import type { TemplateCatalogueEntry } from "./catalogue";
import { TEMPLATE_BOATBUILDING, TEMPLATE_BOATBUILDING_ENTRY } from "./boatbuilding";
import { TEMPLATE_MANUFACTURING, TEMPLATE_MANUFACTURING_ENTRY } from "./manufacturing";
import { TEMPLATE_SERVICE_BUSINESS, TEMPLATE_SERVICE_BUSINESS_ENTRY } from "./service-business";
import { TEMPLATE_CONSTRUCTION, TEMPLATE_CONSTRUCTION_ENTRY } from "./construction";
import { TEMPLATE_FOOD_BEVERAGE, TEMPLATE_FOOD_BEVERAGE_ENTRY } from "./food-beverage";
import { TEMPLATE_ONLINE_STORE, TEMPLATE_ONLINE_STORE_ENTRY } from "./online-store";
import { TEMPLATE_AGRICULTURE, TEMPLATE_AGRICULTURE_ENTRY } from "./agriculture";
import {
  TEMPLATE_GENERIC_OPERATIONS,
  TEMPLATE_GENERIC_OPERATIONS_ENTRY,
} from "./generic-operations";

export type { TemplateCatalogueEntry } from "./catalogue";
export { entryIsCoherent } from "./catalogue";

/** Catalogue order = chooser display order (generic last as the fallback). */
export const TEMPLATE_CATALOGUE: readonly TemplateCatalogueEntry[] = [
  TEMPLATE_BOATBUILDING_ENTRY,
  TEMPLATE_MANUFACTURING_ENTRY,
  TEMPLATE_SERVICE_BUSINESS_ENTRY,
  TEMPLATE_CONSTRUCTION_ENTRY,
  TEMPLATE_FOOD_BEVERAGE_ENTRY,
  TEMPLATE_ONLINE_STORE_ENTRY,
  TEMPLATE_AGRICULTURE_ENTRY,
  TEMPLATE_GENERIC_OPERATIONS_ENTRY,
];

/** Shipped templates by key — derived from the catalogue so the two can never drift. */
export const TEMPLATES: Record<string, TemplateManifest> = Object.fromEntries(
  TEMPLATE_CATALOGUE.map((e) => [e.manifest.key, e.manifest]),
);

export function getCatalogueEntry(key: string): TemplateCatalogueEntry | undefined {
  return TEMPLATE_CATALOGUE.find((e) => e.key === key);
}

export {
  TEMPLATE_BOATBUILDING,
  TEMPLATE_MANUFACTURING,
  TEMPLATE_SERVICE_BUSINESS,
  TEMPLATE_CONSTRUCTION,
  TEMPLATE_FOOD_BEVERAGE,
  TEMPLATE_ONLINE_STORE,
  TEMPLATE_AGRICULTURE,
  TEMPLATE_GENERIC_OPERATIONS,
};
