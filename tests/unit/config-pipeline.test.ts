/**
 * S1 unit tests: the config-string sanitiser (doc 10 #24), the artifact schema
 * suite (doc 09 Σ-rules + closed catalogs), template #1 build validation +
 * referential closure, the diff builder, and the reference-pattern engine.
 */
import { describe, expect, it } from "vitest";
import { configStringIssue, configString } from "@/platform/config/sanitize";
import {
  CategorySetSchema,
  JobPresetSchema,
  ReferencePatternSetSchema,
  RolePresetSetSchema,
  StageTemplateSchema,
  StatusSetSchema,
} from "@/platform/config/schemas/artifacts";
import { TemplateManifestSchema } from "@/platform/config/schemas/manifest";
import { TEMPLATE_BOATBUILDING } from "@/platform/config/templates/boatbuilding";
import { diffConfig } from "@/platform/config/diff";
import { renderReference } from "@/platform/config/reference";
import { TERM_KEYS } from "@/platform/registries";
import { resolveTerm } from "@/platform/terminology";

describe("config-string sanitiser (doc 10 #24 — reject, never clamp)", () => {
  it.each([
    ["Boat", null],
    ["Finishing & Polishing", null], // bare & is allowed (doc-08 content)
    ["قارب", null],
    ["<script>", "markup"],
    ["a>b", "markup"],
    ["ICU {brace}", "icu_metacharacter"],
    ["hash#tag", "icu_metacharacter"],
    ["=SUM(A1)", "formula_lead"],
    ["+971 phone", "formula_lead"],
    ["-lead", "formula_lead"],
    ["@handle", "formula_lead"],
    ["tab\there", "control_character"],
    ["line\nbreak", "control_character"],
    ["", "empty"],
    ["   ", "empty"],
  ])("%j → %s", (value, issue) => {
    expect(configStringIssue(value as string, 80)).toBe(issue);
  });

  it("rejects over-length instead of clamping", () => {
    expect(configStringIssue("x".repeat(81), 80)).toBe("too_long");
    expect(configString(80).safeParse("x".repeat(81)).success).toBe(false);
  });
});

describe("artifact schemas (doc 09)", () => {
  it("stage template: weights must sum to 100", () => {
    const bad = {
      stages: [
        { stage_key: "a", names: { en: "A", ar: "أ" }, weight: 50, phase_semantic: "production" },
        { stage_key: "b", names: { en: "B", ar: "ب" }, weight: 49, phase_semantic: "production" },
      ],
    };
    expect(StageTemplateSchema.safeParse(bad).success).toBe(false);
    (bad.stages[1] as { weight: number }).weight = 50;
    expect(StageTemplateSchema.safeParse(bad).success).toBe(true);
  });

  it("stage template: duplicate keys rejected", () => {
    const dup = {
      stages: [
        { stage_key: "a", names: { en: "A", ar: "أ" }, weight: 50, phase_semantic: "production" },
        { stage_key: "a", names: { en: "B", ar: "ب" }, weight: 50, phase_semantic: "production" },
      ],
    };
    expect(StageTemplateSchema.safeParse(dup).success).toBe(false);
  });

  it("status set: every required semantic category must be reachable", () => {
    const missingCancelled = {
      entity: "job",
      statuses: [
        { status_key: "draft", labels: { en: "D", ar: "م" }, semantic_category: "draft", sort: 0 },
        { status_key: "run", labels: { en: "R", ar: "ت" }, semantic_category: "active", sort: 1 },
        { status_key: "done", labels: { en: "F", ar: "ن" }, semantic_category: "done", sort: 2 },
      ],
    };
    const r = StatusSetSchema.safeParse(missingCancelled);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.success ? [] : r.error.issues)).toContain("cancelled");
  });

  it("job preset: billing points must sum to 100%", () => {
    const preset = {
      code: "24C",
      names: { en: "24ft Catamaran", ar: "كاتاماران 24" },
      default_skipped_stage_keys: [],
      billing_points: [
        { trigger: "on_acceptance", pct: 60 },
        { trigger: { stage_key: "delivery" }, pct: 30 },
      ],
    };
    expect(JobPresetSchema.safeParse(preset).success).toBe(false);
    preset.billing_points[1]!.pct = 40;
    expect(JobPresetSchema.safeParse(preset).success).toBe(true);
  });

  it("category set: expense categories require a costing mapping (F-2)", () => {
    const bad = {
      kind: "expense",
      categories: [{ key: "materials", labels: { en: "Materials", ar: "مواد" }, retired: false }],
    };
    expect(CategorySetSchema.safeParse(bad).success).toBe(false);
  });

  it("reference pattern: closed token grammar with exactly one seq", () => {
    expect(
      ReferencePatternSetSchema.safeParse({ job: { pattern: "{preset_code}-{seq:3}", start: 1 } })
        .success,
    ).toBe(true);
    expect(
      ReferencePatternSetSchema.safeParse({ job: { pattern: "{bogus}-{seq:3}", start: 1 } })
        .success,
    ).toBe(false);
    expect(
      ReferencePatternSetSchema.safeParse({ job: { pattern: "{preset_code}", start: 1 } }).success,
    ).toBe(false);
  });

  it("role presets: duplicate keys and >12 roles rejected", () => {
    const role = (key: string) => ({
      key,
      archetype: "manager",
      labels: { en: "M", ar: "م" },
      cost_privileged: false,
      price_privileged: false,
    });
    expect(RolePresetSetSchema.safeParse({ roles: [role("a"), role("a")] }).success).toBe(false);
    expect(
      RolePresetSetSchema.safeParse({
        roles: Array.from({ length: 13 }, (_, i) => role(`r${i}`)),
      }).success,
    ).toBe(false);
  });
});

describe("template #1 (build-time validation — doc 07 tooling)", () => {
  it("validates against the full manifest schema", () => {
    const r = TemplateManifestSchema.safeParse(TEMPLATE_BOATBUILDING);
    expect(r.success, JSON.stringify(r.success ? [] : r.error.issues.slice(0, 3))).toBe(true);
  });

  it("ships the doc-08 content: 11 stages Σ100, 9 presets, 17/13/9 categories", () => {
    expect(TEMPLATE_BOATBUILDING.stage_template.stages).toHaveLength(11);
    expect(TEMPLATE_BOATBUILDING.stage_template.stages.reduce((a, s) => a + s.weight, 0)).toBe(100);
    expect(TEMPLATE_BOATBUILDING.presets).toHaveLength(9);
    expect(TEMPLATE_BOATBUILDING.category_sets.item.categories).toHaveLength(17);
    expect(TEMPLATE_BOATBUILDING.category_sets.expense.categories).toHaveLength(13);
    expect(TEMPLATE_BOATBUILDING.category_sets.quote_section.categories).toHaveLength(9);
    // The 60/40 contract terms (audit F-1) on every preset.
    for (const p of TEMPLATE_BOATBUILDING.presets) {
      expect(p.billing_points.reduce((a, b) => a + b.pct, 0)).toBe(100);
    }
    // Small skiffs skip Upholstery (doc 08).
    const skiff = TEMPLATE_BOATBUILDING.presets.find((p) => p.code === "13S")!;
    expect(skiff.default_skipped_stage_keys).toContain("upholstery");
  });

  it("referential closure violations fail the build", () => {
    const broken = structuredClone(TEMPLATE_BOATBUILDING);
    broken.presets[0]!.default_skipped_stage_keys = ["no_such_stage"];
    expect(TemplateManifestSchema.safeParse(broken).success).toBe(false);
  });

  it("terminology coverage: every canonical key resolves en+ar under template #1", () => {
    for (const key of TERM_KEYS) {
      for (const locale of ["en", "ar"] as const) {
        const resolved = resolveTerm(key, { locale, templateKey: TEMPLATE_BOATBUILDING.key });
        expect(resolved.singular, `${key}/${locale}`).toBeTruthy();
        expect(resolved.plural, `${key}/${locale}`).toBeTruthy();
      }
      // Arabic gender metadata present (grammar agreement, doc 07 D-7.1).
      expect(
        resolveTerm(key, { locale: "ar", templateKey: TEMPLATE_BOATBUILDING.key }).gender,
      ).toBeTruthy();
    }
    // The template actually renames: job → Boat / قارب, PO → LPO (doc 08).
    expect(
      resolveTerm("job", { locale: "en", templateKey: TEMPLATE_BOATBUILDING.key }).singular,
    ).toBe("Boat");
    expect(
      resolveTerm("job", { locale: "ar", templateKey: TEMPLATE_BOATBUILDING.key }).singular,
    ).toBe("قارب");
    expect(
      resolveTerm("purchase_order", { locale: "en", templateKey: TEMPLATE_BOATBUILDING.key })
        .singular,
    ).toBe("LPO");
  });
});

describe("diff builder (preview — v1 §14 step 5)", () => {
  it("reports added/removed/changed leaf paths", () => {
    const entries = diffConfig(
      { a: 1, nested: { keep: "x", drop: "y" }, arr: [1, 2] },
      { a: 2, nested: { keep: "x", add: "z" }, arr: [1, 3] },
    );
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e.kind]));
    expect(byPath["a"]).toBe("changed");
    expect(byPath["nested.drop"]).toBe("removed");
    expect(byPath["nested.add"]).toBe("added");
    expect(byPath["arr[1]"]).toBe("changed");
    expect(entries.find((e) => e.path === "nested.keep")).toBeUndefined();
  });

  it("null before = full add (first install)", () => {
    expect(diffConfig(null, { a: 1 })[0]).toEqual({ path: "", kind: "added", after: { a: 1 } });
  });
});

describe("reference engine (doc 07 — hull numbers)", () => {
  it("renders the hull-number pattern with padding", () => {
    expect(renderReference("{preset_code}-{seq:3}", { presetCode: "24C", seq: 3 })).toBe("24C-003");
    expect(renderReference("{preset_code}-{seq:3}", { presetCode: "D46", seq: 142 })).toBe(
      "D46-142",
    );
  });
  it("renders year + seq serials", () => {
    expect(renderReference("LPO-{year}-{seq:4}", { seq: 27, year: 2026 })).toBe("LPO-2026-0027");
  });
});
