/**
 * H18 — blueprint workflow stage adoption: the pure stage-source selector
 * (server data only, defensive, order/label/weight-preserving), the legacy
 * fallback, and the structural pins (no client-authoritative workflow input,
 * no historical stage rewrites in the creation path).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stagesFromBlueprint, CreateJobInput } from "@/modules/jobs/service";
import { scenarioContractor } from "./workspace-fixtures";

const goodBlueprint = {
  workflows: [
    {
      id: "job",
      stages: [
        { key: "planning", name: { en: "Planning", ar: "التخطيط" }, weight: 20 },
        { key: "execution", name: { en: "Execution", ar: "التنفيذ" }, weight: 60 },
        { key: "handover", name: { en: "Handover", ar: "التسليم" }, weight: 20 },
      ],
    },
  ],
};

describe("H18 — stagesFromBlueprint (pure selector)", () => {
  it("returns the job workflow's stages with identity, labels, weights and order", () => {
    const stages = stagesFromBlueprint(goodBlueprint);
    expect(stages).toEqual([
      // H21: the snapshot also carries phase_semantic — null here because this
      // fixture declares none, which must never disqualify a workflow.
      {
        stage_key: "planning",
        names: { en: "Planning", ar: "التخطيط" },
        weight: 20,
        phase_semantic: null,
      },
      {
        stage_key: "execution",
        names: { en: "Execution", ar: "التنفيذ" },
        weight: 60,
        phase_semantic: null,
      },
      {
        stage_key: "handover",
        names: { en: "Handover", ar: "التسليم" },
        weight: 20,
        phase_semantic: null,
      },
    ]);
  });

  it("accepts a real validated blueprint fixture", () => {
    const stages = stagesFromBlueprint(scenarioContractor());
    expect(stages).not.toBeNull();
    expect(stages!.length).toBeGreaterThan(0);
    expect(stages!.every((s) => s.names.en && s.names.ar)).toBe(true);
    expect(stages!.reduce((n, s) => n + s.weight, 0)).toBe(100);
  });

  it("legacy fallback: null/absent blueprint yields null (template path)", () => {
    expect(stagesFromBlueprint(null)).toBeNull();
    expect(stagesFromBlueprint(undefined)).toBeNull();
    expect(stagesFromBlueprint({})).toBeNull();
    expect(stagesFromBlueprint({ workflows: [] })).toBeNull();
    expect(stagesFromBlueprint({ workflows: [{ id: "other", stages: [] }] })).toBeNull();
  });

  it("any malformed stage disqualifies the whole workflow (fail safe)", () => {
    const broken = (stage: unknown) =>
      stagesFromBlueprint({ workflows: [{ id: "job", stages: [stage] }] });
    expect(broken({ key: "BadKey", name: { en: "x", ar: "y" }, weight: 10 })).toBeNull();
    expect(broken({ key: "ok", name: { en: "x" }, weight: 10 })).toBeNull(); // ar missing
    expect(broken({ key: "ok", name: { en: "x", ar: "y" }, weight: 101 })).toBeNull();
    expect(broken({ key: "ok", name: { en: "x", ar: "y" }, weight: 10.5 })).toBeNull();
    // Duplicate keys would violate the per-job unique snapshot — rejected.
    expect(
      stagesFromBlueprint({
        workflows: [
          {
            id: "job",
            stages: [
              { key: "dup", name: { en: "a", ar: "b" }, weight: 50 },
              { key: "dup", name: { en: "c", ar: "d" }, weight: 50 },
            ],
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("H18 — structural pins", () => {
  const serviceSrc = readFileSync("src/modules/jobs/service.ts", "utf8");

  it("job creation accepts NO client-authoritative workflow or blueprint input", () => {
    const shape = Object.keys(CreateJobInput.shape);
    for (const key of shape) {
      expect(key.toLowerCase(), key).not.toMatch(/workflow|blueprint|stage|revision/);
    }
    // The applied revision is read inside the creation transaction, filtered
    // to the acting organization.
    expect(serviceSrc).toContain("from public.workspace_blueprint_revision");
    expect(serviceSrc).toMatch(/workspace_blueprint_revision\s+where org_id = \$\{ctx\.orgId\}/);
  });

  it("the creation path never rewrites existing stage snapshots", () => {
    // createJobFromPreset region: inserts only; the single job_stage UPDATE
    // in the module is the status state machine (stages.ts), not creation.
    const createRegion = serviceSrc.slice(
      serviceSrc.indexOf("export async function createJobFromPreset"),
      serviceSrc.indexOf("export type JobRow"),
    );
    expect(createRegion).toContain("insert into public.job_stage");
    expect(createRegion).not.toMatch(/update public\.job_stage/);
    expect(createRegion).not.toMatch(/delete from public\.job_stage/);
  });

  it("historical work is untouched: no migration or bulk stage rewrite ships in H18", () => {
    expect(serviceSrc).not.toMatch(/update public\.job_stage set (stage_key|name|weight|sort)/);
  });
});
