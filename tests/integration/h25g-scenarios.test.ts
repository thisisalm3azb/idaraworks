/**
 * H25G — the scenario laboratory on the living model.
 *
 * Properties: a scenario edit is an overlay (the canonical task is untouched
 * and the live schedule does not move); compare shows from → to and the
 * schedule delta in working days; Monte Carlo is reproducible from its seed
 * and refuses without estimates; submit goes through the approval engine and
 * approval only makes the scenario applicable; apply needs its own lane and
 * REFUSES when the live plan drifted from the branch-time values; a
 * successful apply changes the real task through the jobs door; a viewer
 * cannot branch.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { ForbiddenError } from "@/platform/authz";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createJobFromPreset, createTask, updateTask } from "@/modules/jobs/service";
import { decideApproval } from "@/modules/approvals/service";
import {
  createStudioPlan,
  addNode,
  addEdge,
  updateNode,
  scheduleForPlan,
  createScenario,
  listScenarios,
  updateScenario,
  compareScenario,
  submitScenario,
  applyScenario,
  discardScenario,
  simulatePlan,
  StudioError,
} from "@/modules/studio/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userM = randomUUID();
let orgA = "";
let planId = "";
let taskA = "";
let taskB = "";
let nodeB = "";
let scenarioId = "";
let approvalId = "";

const ctxOf = (userId: string): Ctx => ({
  orgId: orgA,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h25g",
});
const A = () => ctxOf(userA);
const M = () => ctxOf(userM);

async function taskDuration(id: string): Promise<number | null> {
  const rows = (await owner`
    select duration_days from public.task where id = ${id}`) as unknown as Array<{
    duration_days: number | null;
  }>;
  return rows[0]?.duration_days ?? null;
}

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "H25G Owner"],
    [userM, "H25G Manager"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h25g-${name.split(" ")[1]!.toLowerCase()}-${run}@example.invalid`},
              ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H25G", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h25g", run);
  await owner`
    insert into public.user_profile (id, full_name, locale) values (${userM}, 'H25G Manager', 'en')
    on conflict (id) do nothing`;
  await owner`
    insert into public.membership (user_id, org_id, role_key) values (${userM}, ${orgA}, 'manager')`;
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  const preset = (await owner`
    select id::text as id from public.job_preset where org_id = ${orgA} limit 1`) as unknown as Array<{
    id: string;
  }>;
  const job = await createJobFromPreset(A(), "owner", {
    presetId: preset[0]!.id,
    name: `Scenario job ${run}`,
  });
  taskA = (
    await createTask(A(), "owner", { jobId: job.id, title: "Survey", startDate: "2026-10-05" })
  ).id;
  await updateTask(A(), "owner", taskA, {
    durationDays: 3,
    estimateOptimisticDays: 2,
    estimatePessimisticDays: 5,
  });
  taskB = (await createTask(A(), "owner", { jobId: job.id, title: "Lamination" })).id;
  await updateTask(A(), "owner", taskB, {
    durationDays: 5,
    estimateOptimisticDays: 4,
    estimatePessimisticDays: 9,
  });

  planId = (await createStudioPlan(A(), "owner", { name: `Scenario plan ${run}` })).id;
  const nodeA = (
    await addNode(A(), "owner", { planId, nodeType: "task", recordType: "task", recordId: taskA })
  ).id;
  nodeB = (
    await addNode(A(), "owner", { planId, nodeType: "task", recordType: "task", recordId: taskB })
  ).id;
  await addEdge(A(), "owner", {
    planId,
    sourceNodeId: nodeA,
    targetNodeId: nodeB,
    edgeType: "dependency",
    depKind: "finish_to_start",
  });
}, 120_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
});

describe("branching and overlay", () => {
  it("a viewer cannot branch; a manager can", async () => {
    await expect(createScenario(M(), "viewer", { planId, name: "nope" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    scenarioId = (
      await createScenario(M(), "manager", {
        planId,
        name: "Longer lamination",
        assumptions: [{ text: "Resin cures slower in October", confidence: "medium" }],
      })
    ).id;
    const listed = await listScenarios(A(), "owner", planId);
    expect(listed.map((s) => s.id)).toContain(scenarioId);
    expect(listed[0]!.status).toBe("draft");
  });

  it("a scenario edit overlays the plan and leaves the canonical task untouched", async () => {
    const res = await updateNode(M(), "manager", { nodeId: nodeB, scenarioId, durationDays: 8 });
    expect(res.routed).toBe("scenario");
    expect(await taskDuration(taskB)).toBe(5);

    const live = await scheduleForPlan(A(), "owner", { planId });
    const branch = await scheduleForPlan(A(), "owner", { planId, scenarioId });
    expect(live.byNode.get(nodeB)!.durationDays).toBe(5);
    expect(branch.byNode.get(nodeB)!.durationDays).toBe(8);

    const cmp = await compareScenario(A(), "owner", scenarioId);
    expect(cmp.changes).toHaveLength(1);
    expect(cmp.changes[0]).toMatchObject({
      field: "durationDays",
      oldValue: 5,
      newValue: 8,
      liveValue: 5,
      drifted: false,
      nodeId: nodeB,
    });
    expect(cmp.schedule.finishDeltaDays).toBe(3);
    expect(cmp.schedule.live.projectFinish! < cmp.schedule.scenario.projectFinish!).toBe(true);
  });

  it("Monte Carlo is reproducible from its stored seed and refuses without estimates", async () => {
    const r1 = await simulatePlan(A(), "owner", { planId, scenarioId, samples: 300, seed: 99 });
    const r2 = await simulatePlan(A(), "owner", { planId, scenarioId, samples: 300, seed: 99 });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.finish).toEqual(r2.finish);
    expect(r1.confidenceInDeterministic).toEqual(r2.confidenceInDeterministic);
    const stored = (await listScenarios(A(), "owner", planId)).find((s) => s.id === scenarioId)!;
    expect(stored.simulation).toMatchObject({ seed: 99, samples: 300, finish: r1.finish });

    // Strip B's estimates inside the scenario only → refusal names the node.
    await updateNode(M(), "manager", {
      nodeId: nodeB,
      scenarioId,
      estimateOptimisticDays: null,
    });
    const r3 = await simulatePlan(A(), "owner", { planId, scenarioId, samples: 300, seed: 99 });
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.reason).toBe("insufficient_estimates");
      expect(r3.missing).toEqual([nodeB]);
    }
    // Put it back (as a scenario change it just returns to the live value).
    await updateNode(M(), "manager", { nodeId: nodeB, scenarioId, estimateOptimisticDays: 4 });
  });
});

describe("review, approval and controlled apply", () => {
  it("submitting routes through the approval engine and does not apply", async () => {
    const before = (await listScenarios(A(), "owner", planId)).find((s) => s.id === scenarioId)!;
    const res = await submitScenario(M(), "manager", {
      scenarioId,
      expectedRowVersion: before.rowVersion,
    });
    expect(res.status).toBe("under_review");
    approvalId = res.approvalId;
    expect(await taskDuration(taskB)).toBe(5);
    await expect(applyScenario(A(), "owner", { scenarioId })).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("the decider approves; the manager may not apply, and drift refuses the owner", async () => {
    const decided = await decideApproval(A(), "owner", { approvalId, decision: "approved" });
    expect(decided.outcome).toBe("approved");
    const s = (await listScenarios(A(), "owner", planId)).find((x) => x.id === scenarioId)!;
    expect(s.status).toBe("approved");

    await expect(applyScenario(M(), "manager", { scenarioId })).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    // The live task moves under the scenario's feet → apply must refuse.
    await updateTask(A(), "owner", taskB, { durationDays: 6 });
    const cmp = await compareScenario(A(), "owner", scenarioId);
    expect(cmp.changes.find((c) => c.field === "durationDays")!.drifted).toBe(true);
    await expect(applyScenario(A(), "owner", { scenarioId })).rejects.toMatchObject({
      code: "drift",
    });
    expect(await taskDuration(taskB)).toBe(6);
  });

  it("with the drift undone, apply replays the change through the jobs door", async () => {
    await updateTask(A(), "owner", taskB, { durationDays: 5 });
    const res = await applyScenario(A(), "owner", { scenarioId });
    expect(res.applied).toBeGreaterThanOrEqual(1);
    expect(await taskDuration(taskB)).toBe(8);
    const s = (await listScenarios(A(), "owner", planId)).find((x) => x.id === scenarioId)!;
    expect(s.status).toBe("applied");
    expect(s.appliedBy).toBe(userA);
    const audit = (await owner`
      select action from public.audit_log where org_id = ${orgA} and entity_id = ${scenarioId}
      order by created_at`) as unknown as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "studio.scenario.create",
        "studio.scenario.submit",
        "studio.scenario.apply",
      ]),
    );
    // Applied scenarios are closed.
    await expect(discardScenario(A(), "owner", { scenarioId })).rejects.toBeInstanceOf(StudioError);
    await expect(
      updateScenario(A(), "owner", { scenarioId, name: "renamed" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    // The live schedule now reflects the applied duration.
    const live = await scheduleForPlan(A(), "owner", { planId });
    expect(live.byNode.get(nodeB)!.durationDays).toBe(8);
  });

  it("a draft can be discarded and stays out of the way", async () => {
    const id = (await createScenario(A(), "owner", { planId, name: "Throwaway" })).id;
    await discardScenario(A(), "owner", { scenarioId: id });
    const s = (await listScenarios(A(), "owner", planId)).find((x) => x.id === id)!;
    expect(s.status).toBe("discarded");
    await expect(
      updateNode(A(), "owner", { nodeId: nodeB, scenarioId: id, durationDays: 9 }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});
