/**
 * S2 unit tests: the U7 progress fixtures (doc 11 testing line: "progress math
 * matches doc 01 U7 fixtures"), current-stage denormalisation, FieldDefinition
 * schema (#6), custom-value validation, and the per-role job-page permission
 * snapshot (doc 11: "permission snapshots for job page per role").
 */
import { describe, expect, it } from "vitest";
import { computeProgress, currentStage, displayProgress } from "@/modules/jobs/progress";
import { FieldDefinitionSetSchema } from "@/platform/config/schemas/artifacts";
import { mergeCustomValues, CustomValueError } from "@/platform/config/customFields";
import { TEMPLATE_BOATBUILDING } from "@/platform/config/templates/boatbuilding";
import { MVP_GRANTABLE_ARCHETYPES } from "@/platform/registries";
import { can, MATRIX, type Action } from "@/platform/authz";

type S = Parameters<typeof computeProgress>[0][number];
const st = (weight: number, status: S["status"]): S => ({ weight, status });

describe("U7 progress fixtures (weights; in_progress=0.5; skips renormalize)", () => {
  // The doc-08 template weights, as the job_stage snapshots would hold them.
  const FULL = TEMPLATE_BOATBUILDING.stage_template.stages.map((s) => st(s.weight, "not_started"));

  it("all not_started → 0", () => {
    expect(computeProgress(FULL)).toBe(0);
  });

  it("one stage in progress → half its weight share", () => {
    const stages = FULL.map((s, i) => (i === 1 ? st(s.weight, "in_progress") : s)); // lamination 16
    expect(computeProgress(stages)).toBe(8); // 16 × 0.5 / 100
  });

  it("completed stages count fully", () => {
    const stages = FULL.map((s, i) => (i <= 1 ? st(s.weight, "completed") : s)); // 5+16
    expect(computeProgress(stages)).toBe(21);
  });

  it("skips renormalize the denominator (13S without Upholstery, weight 7)", () => {
    // Upholstery (index 7, weight 7) skipped; Mould Prep (5) completed.
    const stages = FULL.map((s, i) =>
      i === 7 ? st(s.weight, "skipped") : i === 0 ? st(s.weight, "completed") : s,
    );
    // 5 / 93 = 5.376… → 5.4 (1dp)
    expect(computeProgress(stages)).toBe(5.4);
  });

  it("all completed (skips aside) → 100", () => {
    const stages = FULL.map((s, i) => st(s.weight, i === 7 ? "skipped" : "completed"));
    expect(computeProgress(stages)).toBe(100);
  });

  it("everything skipped → null (no denominator)", () => {
    expect(computeProgress([st(50, "skipped"), st(50, "skipped")])).toBeNull();
  });

  it("override wins for DISPLAY and is flagged — never silent (D-1.4)", () => {
    const stages = [st(100, "completed")];
    expect(displayProgress(stages, null)).toEqual({ percent: 100, overridden: false });
    expect(displayProgress(stages, 60)).toEqual({ percent: 60, overridden: true });
  });

  it("reopen recompute: completed → in_progress drops the share by half", () => {
    const done = FULL.map((s) => st(s.weight, "completed"));
    expect(computeProgress(done)).toBe(100);
    const reopened = done.map((s, i) => (i === 10 ? st(s.weight, "in_progress") : s)); // delivery 4
    expect(computeProgress(reopened)).toBe(98); // 100 - 4 + 2
  });
});

describe("current stage (the sanctioned denormalisation)", () => {
  const rows = (statuses: S["status"][]) =>
    statuses.map((status, i) => ({ weight: 10, status, sort: i, id: `s${i}` }));

  it("earliest in_progress wins", () => {
    expect(currentStage(rows(["completed", "in_progress", "not_started"]))?.id).toBe("s1");
  });
  it("else earliest not_started (skipped stages never current)", () => {
    expect(currentStage(rows(["completed", "skipped", "not_started"]))?.id).toBe("s2");
  });
  it("null when nothing remains", () => {
    expect(currentStage(rows(["completed", "skipped", "completed"]))).toBeNull();
  });
});

describe("FieldDefinition schema (#6) + custom values", () => {
  it("select fields need options; others must not carry them", () => {
    const base = {
      field_key: "colour",
      labels: { en: "Colour", ar: "لون" },
      required: false,
      visibility: [],
      retired: false,
    };
    expect(
      FieldDefinitionSetSchema.safeParse({ fields: [{ ...base, type: "select" }] }).success,
    ).toBe(false);
    expect(
      FieldDefinitionSetSchema.safeParse({
        fields: [
          { ...base, type: "text", options: [{ key: "red", labels: { en: "Red", ar: "أحمر" } }] },
        ],
      }).success,
    ).toBe(false);
    expect(
      FieldDefinitionSetSchema.safeParse({
        fields: [
          { ...base, type: "select", options: [{ key: "red", labels: { en: "Red", ar: "أحمر" } }] },
        ],
      }).success,
    ).toBe(true);
  });

  it("template #1 ships engine_package + colour_scheme on job (doc 08)", () => {
    const keys = TEMPLATE_BOATBUILDING.field_definitions?.job?.fields.map((f) => f.field_key);
    expect(keys).toEqual(["engine_package", "colour_scheme"]);
  });

  it("mergeCustomValues: types enforced, unknown rejected, retired read-only", () => {
    const defs = {
      fields: [
        {
          field_key: "engine",
          type: "text" as const,
          labels: { en: "E", ar: "م" },
          required: false,
          visibility: [],
          retired: false,
        },
        {
          field_key: "budget",
          type: "money" as const,
          labels: { en: "B", ar: "م" },
          required: false,
          visibility: [],
          retired: false,
        },
        {
          field_key: "old",
          type: "text" as const,
          labels: { en: "O", ar: "ق" },
          required: false,
          visibility: [],
          retired: true,
        },
      ],
    };
    expect(mergeCustomValues(defs, {}, { engine: "Twin 300" })).toEqual({ engine: "Twin 300" });
    expect(() => mergeCustomValues(defs, {}, { budget: 12.5 })).toThrow(CustomValueError);
    expect(mergeCustomValues(defs, {}, { budget: 500000 })).toEqual({ budget: 500000 });
    expect(() => mergeCustomValues(defs, {}, { nope: "x" })).toThrow(/unknown field/);
    expect(() => mergeCustomValues(defs, {}, { old: "new value" })).toThrow(/retired/);
    // Existing retired values persist through unrelated patches (history).
    expect(mergeCustomValues(defs, { old: "kept" }, { engine: "E1" })).toEqual({
      old: "kept",
      engine: "E1",
    });
    // Clearing a non-required field removes it.
    expect(mergeCustomValues(defs, { engine: "E1" }, { engine: null })).toEqual({});
  });
});

describe("job-page permission snapshot per role (doc 11 S2 testing)", () => {
  const JOB_PAGE_ACTIONS: Action[] = [
    "jobs.view",
    "jobs.create",
    "jobs.edit",
    "jobs.price.manage",
    "jobs.price.adjust",
    "jobs.progress.override",
    "stages.update",
    "stages.request_complete",
    "stages.reopen",
    "tasks.manage",
    "tasks.update_status",
    "crew.manage",
    "week.view",
    "reports.create",
  ];

  it("matches the doc-06 grid snapshot", () => {
    const snapshot = Object.fromEntries(
      MVP_GRANTABLE_ARCHETYPES.map((arch) => [
        arch,
        Object.fromEntries(JOB_PAGE_ACTIONS.map((action) => [action, can(arch, action)])),
      ]),
    );
    expect(snapshot).toMatchSnapshot();
    // Spot invariants that must never drift:
    expect(snapshot.owner!["jobs.price.adjust"]).toBe(true); // F-10
    expect(snapshot.admin!["jobs.price.adjust"]).toBe(false); // owner-ONLY
    expect(snapshot.manager!["jobs.price.manage"]).toBe(false); // Workshop variant
    expect(snapshot.foreman!["stages.update"]).toBe(false);
    expect(snapshot.foreman!["stages.request_complete"]).toBe(true);
    expect(snapshot.viewer!["week.view"]).toBe(true);
    expect(snapshot.viewer!["tasks.update_status"]).toBe(false);
  });

  it("every S2 action is deny-by-default beyond its doc-06 row", () => {
    for (const action of JOB_PAGE_ACTIONS) {
      const allowed = MATRIX[action];
      for (const arch of MVP_GRANTABLE_ARCHETYPES) {
        expect(can(arch, action)).toBe((allowed as readonly string[]).includes(arch));
      }
    }
  });
});
