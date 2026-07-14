/**
 * Template catalogue entry — the SELECTION metadata that wraps a TemplateManifest
 * (post-MVP template catalogue). The manifest is what installs; the entry is what
 * the chooser, the AI/deterministic classifier and the docs display. Strictly
 * honest by construction: `limitations` is a required, non-empty list, and
 * `enabledModules`/`optionalModules` are ADVISORY UI defaults referencing the
 * existing capability keys — they NEVER grant or imply commercial entitlements
 * (entitlements resolve exclusively from the plan/add-on/override layer).
 */
import type { FeatureKey } from "@/platform/entitlements/catalogue";
import type { TemplateManifest } from "../schemas/manifest";
import type { Labels } from "./blocks";

export type TemplateCatalogueEntry = {
  /** Same key as the manifest — the single identity. */
  key: string;
  /** Display name (distinct from terminology: "Food & Beverage", not "Order"). */
  names: Labels;
  /** One-paragraph target-business description shown on the chooser card. */
  description: Labels;
  /** Concrete business types this template suits (chooser bullet list). */
  targetBusinesses: Labels[];
  /**
   * Example business-description phrases used for classification — the
   * deterministic matcher and (when wired) the AI classifier score the founder's
   * free-text against these. Mixed English + Arabic, lowercase.
   */
  classificationPhrases: string[];
  /** Weighted match keywords (lowercase, en + ar). Strong domain signals only. */
  classificationKeywords: string[];
  /** Capability areas the template emphasises by default (advisory UI defaults —
   * never entitlements; unknown keys are ignored by the UI). */
  enabledModules: FeatureKey[];
  /** Capability areas that make sense for some orgs of this type (shown as
   * optional in the preview; advisory only). */
  optionalModules: FeatureKey[];
  /** Advisory dashboard emphasis — keys of EXISTING Today cards/sections. */
  dashboardDefaults: string[];
  /** Honest, user-facing limitations (required — a template must say what it is
   * NOT: e.g. "not a POS", "no courier integrations"). */
  limitations: Labels[];
  /** The installable manifest. */
  manifest: TemplateManifest;
};

/** Guard used by tests + the registry: entry key must equal manifest key. */
export function entryIsCoherent(e: TemplateCatalogueEntry): boolean {
  return (
    e.key === e.manifest.key &&
    e.limitations.length > 0 &&
    e.classificationPhrases.length >= 6 &&
    e.classificationKeywords.length >= 6
  );
}
