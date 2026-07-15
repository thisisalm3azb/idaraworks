/**
 * Add-on ENFORCEMENT PARITY (0070 honesty pass — review: "sold add-ons whose
 * feature keys are enforced nowhere"). Every feature key granted by a
 * purchasable add-on (`available` | `manual_process`) must appear in at least
 * one REAL enforcement call site in src/ — `hasFeature(..., "<key>")` or
 * `requireCapability(ctx, "<key>")`. An add-on may never charge for a key the
 * product checks nowhere: that is exactly how exports_extended / branding_docs
 * / branding_app came to be sold with zero deliverable (reclassified to
 * deferred by migration 0070). Seat/limit-only add-ons (empty `features[]`)
 * pass vacuously — their enforcement is the limit checker, tested elsewhere.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ADDONS, getAddon, isPurchasable } from "@/platform/entitlements/addons";

const SRC_ROOT = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

const sources = walk(SRC_ROOT).map((path) => ({
  path: relative(process.cwd(), path),
  text: readFileSync(path, "utf8"),
}));

/** Files containing a literal enforcement call for `key`. Catalogue definitions
 * (`features: ["..."]`) do NOT match — only hasFeature/requireCapability calls. */
function enforcementSites(key: string): string[] {
  const re = new RegExp(
    String.raw`(?:hasFeature|requireCapability)\([^)]*"${key.replace(/\./g, String.raw`\.`)}"`,
  );
  return sources.filter((s) => re.test(s.text)).map((s) => s.path);
}

describe("addon enforcement parity (src/ scan)", () => {
  it("sanity: the scanner finds known enforcement sites (guards against regex rot)", () => {
    // A service gate (requireCapability) and a page gate (hasFeature) must both register.
    expect(enforcementSites("cap.quoting").length).toBeGreaterThan(0);
    expect(enforcementSites("feat.owner_digest").length).toBeGreaterThan(0);
  });

  it("every feature key granted by a PURCHASABLE add-on is enforced somewhere in src/", () => {
    for (const addon of ADDONS.filter(isPurchasable)) {
      for (const key of addon.features) {
        const sites = enforcementSites(key);
        expect(
          sites.length,
          `${addon.key} sells "${key}" but no hasFeature/requireCapability call site in src/ ` +
            `enforces it — buying the add-on changes nothing (honesty law). ` +
            `Either enforce the key or reclassify the add-on as deferred.`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("0070 regression: exports_extended stays deferred, priceless and grant-free", () => {
    // 0071 shipped the branding capability and restored branding_docs/
    // branding_app (their enforcement sites are covered by the scan above);
    // exports_extended still has no deliverable and must stay deferred.
    for (const key of ["addon.exports_extended"]) {
      const addon = getAddon(key)!;
      expect(addon.availability, `${key} must stay deferred until its capability ships`).toBe(
        "deferred",
      );
      expect(addon.usdMonthlyMinor).toBe(0);
      expect(addon.aedMonthlyMinor).toBe(0);
      expect(addon.features.length).toBe(0);
    }
  });

  it("0071 reversal: the branding add-ons are purchasable AND their keys are enforced", () => {
    for (const [key, feature] of [
      ["addon.branding_docs", "feat.branding_docs"],
      ["addon.branding_app", "feat.branding_app"],
    ] as const) {
      const addon = getAddon(key)!;
      expect(addon.availability).toBe("available");
      expect(addon.features).toContain(feature);
      expect(
        enforcementSites(feature).length,
        `${feature} must keep a real enforcement call site (honesty law)`,
      ).toBeGreaterThan(0);
    }
  });
});
