/**
 * Template catalogue build-time validation (post-MVP template catalogue).
 * EVERY shipped template is validated here — a broken manifest or a dishonest
 * catalogue entry fails the build, never an install (doc 07 tooling rule,
 * extended from the single-template test in config-pipeline.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  TEMPLATES,
  TEMPLATE_CATALOGUE,
  TemplateManifestSchema,
  entryIsCoherent,
} from "@/platform/config";
import { FEATURE_KEYS } from "@/platform/entitlements/catalogue";
import { TEMPLATE_TERMS } from "@/platform/terminology";
import { resolveTerm } from "@/platform/terminology";

const EXPECTED_KEYS = [
  "boatbuilding_marine_v1",
  "manufacturing_workshop_v1",
  "service_business_v1",
  "construction_v1",
  "food_beverage_v1",
  "online_store_v1",
  "agriculture_v1",
  "generic_operations_v1",
];

// Marine vocabulary is allowed ONLY in the marine template (en + ar). Note:
// bare بحري/بحرية is NOT banned — "مأكولات بحرية" (seafood) is legitimate
// culinary Arabic in the F&B template; only boat-industry terms are leakage.
const BOAT_EN = /\b(boat|boats|boatyard|hull|marine|vessel|yacht|skiff|catamaran|lamination)\b/i;
const BOAT_AR = /(قارب|قوارب|يخت|أحواض بناء|بناء القوارب|تصنيع بحري|هيكل القارب)/;

const ALLOWED_DASHBOARD = new Set([
  "jobs_active",
  "reports_today",
  "approvals_pending",
  "exceptions",
  "ar_outstanding",
  "week_plan",
]);

describe("template registry (all shipped templates)", () => {
  it("contains exactly the expected templates with unique keys", () => {
    const keys = TEMPLATE_CATALOGUE.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(Object.keys(TEMPLATES).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  for (const entry of TEMPLATE_CATALOGUE) {
    describe(`template ${entry.key}`, () => {
      it("manifest passes TemplateManifestSchema (build-time validation)", () => {
        const r = TemplateManifestSchema.safeParse(entry.manifest);
        if (!r.success) {
          throw new Error(`${entry.key}: ${JSON.stringify(r.error.issues.slice(0, 5))}`);
        }
      });

      it("catalogue entry is coherent (key parity, honest limitations, classification data)", () => {
        expect(entryIsCoherent(entry)).toBe(true);
        expect(entry.limitations.length).toBeGreaterThanOrEqual(3);
      });

      it("has Arabic AND English names, description, and target businesses", () => {
        for (const l of [
          entry.names,
          entry.description,
          ...entry.targetBusinesses,
          ...entry.limitations,
        ]) {
          expect(l.en.trim().length).toBeGreaterThan(0);
          expect(l.ar.trim().length).toBeGreaterThan(0);
        }
      });

      it("stage weights sum to 100 and roles use the 7 bootstrap keys", () => {
        const sum = entry.manifest.stage_template.stages.reduce((a, s) => a + s.weight, 0);
        expect(sum).toBe(100);
        expect(entry.manifest.role_presets.roles.map((r) => r.key).sort()).toEqual(
          ["accounts", "admin", "foreman", "manager", "owner", "procurement", "viewer"].sort(),
        );
      });

      it("every preset's billing points sum to 100", () => {
        for (const p of entry.manifest.presets) {
          expect(p.billing_points.reduce((a, b) => a + b.pct, 0)).toBe(100);
        }
      });

      it("modules reference only real feature keys; dashboard defaults are known", () => {
        const valid = new Set<string>(FEATURE_KEYS);
        for (const k of [...entry.enabledModules, ...entry.optionalModules]) {
          expect(valid.has(k)).toBe(true);
        }
        for (const d of entry.dashboardDefaults) {
          expect(ALLOWED_DASHBOARD.has(d)).toBe(true);
        }
      });

      it("terminology is auto-registered for the resolver (en + ar job term resolves)", () => {
        expect(TEMPLATE_TERMS[entry.key]).toBeDefined();
        const en = resolveTerm("job", { templateKey: entry.key, overrides: {} }, "en");
        const ar = resolveTerm("job", { templateKey: entry.key, overrides: {} }, "ar");
        expect(en.singular.length).toBeGreaterThan(0);
        expect(ar.singular.length).toBeGreaterThan(0);
      });

      if (entry.key !== "boatbuilding_marine_v1") {
        it("contains NO boat/marine language anywhere (en or ar)", () => {
          const blob = JSON.stringify(entry);
          const enHit = blob.match(BOAT_EN);
          const arHit = blob.match(BOAT_AR);
          expect(enHit?.[0] ?? null).toBeNull();
          expect(arHit?.[0] ?? null).toBeNull();
        });
      }

      it("configures STRUCTURE only — presets are job types, never seeded records", () => {
        // A manifest has no fields capable of carrying transactional data; this
        // guards the shape stays that way (no jobs/users/suppliers/customers keys).
        const raw = entry.manifest as Record<string, unknown>;
        for (const forbidden of ["jobs", "users", "suppliers", "customers", "employees", "items"]) {
          expect(raw[forbidden]).toBeUndefined();
        }
      });
    });
  }

  it("generic template uses neutral terminology (Project, not any industry noun)", () => {
    const en = resolveTerm("job", { templateKey: "generic_operations_v1", overrides: {} }, "en");
    expect(["Project", "Job"]).toContain(en.singular);
  });
});
