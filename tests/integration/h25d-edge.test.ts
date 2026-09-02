/**
 * H25D — connectors carry the schedule's logic. Editing a dependency's lag or
 * kind re-makes the REAL task_dependency through the jobs door and the next
 * schedule shows it; a label is presentation; kind/lag on a reference edge is
 * refused; removing the connector removes the dependency.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createJobFromPreset, createTask, updateTask } from "@/modules/jobs/service";
import {
  createStudioPlan,
  addNode,
  addEdge,
  updateEdge,
  removeEdge,
  scheduleForPlan,
  resolvePlanGraph,
} from "@/modules/studio/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
let planId = "";
let nodeA = "";
let nodeB = "";
let edgeId = "";
let taskB = "";

const A = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h25d-edge",
});

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h25dedge-${run}@example.invalid`}, '{"full_name":"H25D edge"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H25D edge", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h25d-edge", run);
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  const preset = (await owner`
    select id::text as id from public.job_preset where org_id = ${orgA} limit 1`) as unknown as Array<{
    id: string;
  }>;
  const job = await createJobFromPreset(A(), "owner", {
    presetId: preset[0]!.id,
    name: `Edge job ${run}`,
  });
  const taskA = (
    await createTask(A(), "owner", { jobId: job.id, title: "First", startDate: "2026-10-05" })
  ).id;
  await updateTask(A(), "owner", taskA, { durationDays: 2 });
  taskB = (await createTask(A(), "owner", { jobId: job.id, title: "Second" })).id;
  await updateTask(A(), "owner", taskB, { durationDays: 2 });
  planId = (await createStudioPlan(A(), "owner", { name: `Edge plan ${run}` })).id;
  nodeA = (
    await addNode(A(), "owner", { planId, nodeType: "task", recordType: "task", recordId: taskA })
  ).id;
  nodeB = (
    await addNode(A(), "owner", { planId, nodeType: "task", recordType: "task", recordId: taskB })
  ).id;
  const e = await addEdge(A(), "owner", {
    planId,
    sourceNodeId: nodeA,
    targetNodeId: nodeB,
    edgeType: "dependency",
    depKind: "finish_to_start",
  });
  edgeId = e.id;
  expect(e.taskDependencyId).not.toBeNull();
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
});

async function depRow(): Promise<{ kind: string; lag_days: number } | undefined> {
  const rows = (await owner`
    select kind, lag_days from public.task_dependency
    where org_id = ${orgA} and task_id = ${taskB} and removed_at is null`) as unknown as Array<{
    kind: string;
    lag_days: number;
  }>;
  return rows[0];
}

describe("editing a connector", () => {
  it("a lag re-makes the real dependency and moves the successor", async () => {
    const before = await scheduleForPlan(A(), "owner", { planId });
    expect(before.byNode.get(nodeB)!.earlyStart).toBe("2026-10-07"); // Mon 2 days → Wed
    const r = await updateEdge(A(), "owner", { edgeId, lagDays: 2, label: "cure time" });
    expect(r.taskDependencyId).not.toBeNull();
    expect(await depRow()).toMatchObject({ kind: "finish_to_start", lag_days: 2 });
    const after = await scheduleForPlan(A(), "owner", { planId });
    expect(after.byNode.get(nodeB)!.earlyStart).toBe("2026-10-09"); // +2 working days → Fri
    const g = await resolvePlanGraph(A(), "owner", { planId });
    const e = g.edges.find((x) => x.id === edgeId)!;
    expect(e).toMatchObject({ lagDays: 2, label: "cure time", depKind: "finish_to_start" });
    expect(e.taskDependencyId).toBe(r.taskDependencyId);
  });

  it("a kind change is honoured by the engine (start-to-start)", async () => {
    await updateEdge(A(), "owner", { edgeId, depKind: "start_to_start", lagDays: 0 });
    expect(await depRow()).toMatchObject({ kind: "start_to_start", lag_days: 0 });
    const s = await scheduleForPlan(A(), "owner", { planId });
    expect(s.byNode.get(nodeB)!.earlyStart).toBe("2026-10-05"); // starts with A
  });

  it("kind or lag on a reference edge is refused", async () => {
    const ref = await addEdge(A(), "owner", {
      planId,
      sourceNodeId: nodeB,
      targetNodeId: nodeA,
      edgeType: "reference",
    });
    await expect(updateEdge(A(), "owner", { edgeId: ref.id, lagDays: 1 })).rejects.toMatchObject({
      code: "invalid_state",
    });
    await updateEdge(A(), "owner", { edgeId: ref.id, label: "see also" }); // labels are fine
  });

  it("removing the connector removes the real dependency", async () => {
    await removeEdge(A(), "owner", edgeId);
    expect(await depRow()).toBeUndefined();
    const s = await scheduleForPlan(A(), "owner", { planId });
    expect(s.result.health.missingLogicCount).toBe(2);
  });
});
