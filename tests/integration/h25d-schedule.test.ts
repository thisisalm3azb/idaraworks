/**
 * H25D — scheduling on the living model.
 *
 * Properties: the schedule is computed from linked tasks + dependency edges
 * over the org's working calendar (the critical path is never hand-colored);
 * a draft milestone rides the same network; a baseline freezes the computed
 * dates; editing a linked node's duration changes the REAL task and the
 * next schedule shows the variance in working days; a scenario edit shifts
 * the scenario's schedule and leaves the live schedule and the canonical
 * task untouched; capturing a baseline needs the schedule lane.
 *
 * Every duration assertion is in WORKING days, so it holds on any org
 * calendar the fixture happens to get.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { ForbiddenError } from "@/platform/authz";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createJobFromPreset, createTask, updateTask } from "@/modules/jobs/service";
import {
  createStudioPlan,
  addNode,
  addEdge,
  updateNode,
  scheduleForPlan,
  captureBaseline,
  listBaselines,
} from "@/modules/studio/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
let planId = "";
let taskA = "";
let taskB = "";
let nodeA = "";
let nodeB = "";
let nodeM = "";
let baselineId = "";

const A = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h25d",
});

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h25d-${run}@example.invalid`}, '{"full_name":"H25D"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H25D", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h25d", run);
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  const preset = (await owner`
    select id::text as id from public.job_preset where org_id = ${orgA} limit 1`) as unknown as Array<{
    id: string;
  }>;
  const job = await createJobFromPreset(A(), "owner", {
    presetId: preset[0]!.id,
    name: `Schedule job ${run}`,
  });
  // A is anchored on a date and lasts 3 working days; B has no dates and
  // lasts 5 — it must follow A purely through the dependency network.
  taskA = (
    await createTask(A(), "owner", { jobId: job.id, title: "Survey", startDate: "2026-10-05" })
  ).id;
  await updateTask(A(), "owner", taskA, { durationDays: 3 });
  taskB = (await createTask(A(), "owner", { jobId: job.id, title: "Lamination" })).id;
  await updateTask(A(), "owner", taskB, { durationDays: 5 });

  planId = (await createStudioPlan(A(), "owner", { name: `Hull 24 ${run}` })).id;
  nodeA = (
    await addNode(A(), "owner", { planId, nodeType: "task", recordType: "task", recordId: taskA })
  ).id;
  nodeB = (
    await addNode(A(), "owner", { planId, nodeType: "task", recordType: "task", recordId: taskB })
  ).id;
  nodeM = (await addNode(A(), "owner", { planId, nodeType: "milestone", title: "Handover" })).id;
  await addEdge(A(), "owner", {
    planId,
    sourceNodeId: nodeA,
    targetNodeId: nodeB,
    edgeType: "dependency",
    depKind: "finish_to_start",
  });
  await addEdge(A(), "owner", {
    planId,
    sourceNodeId: nodeB,
    targetNodeId: nodeM,
    edgeType: "dependency",
    depKind: "finish_to_start",
  });
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
}, 240_000);

describe("scheduling on the living model", () => {
  it("computes the chain from the network and the calendar", { timeout: 300_000 }, async () => {
    const s = await scheduleForPlan(A(), "owner", { planId });
    expect(s.result.ok).toBe(true);
    expect(s.unscheduled).toEqual([]);
    const a = s.byNode.get(nodeA)!;
    const b = s.byNode.get(nodeB)!;
    const m = s.byNode.get(nodeM)!;
    expect(a.durationDays).toBe(3);
    expect(b.durationDays).toBe(5);
    expect(m.durationDays).toBe(0);
    expect(b.earlyStart > a.earlyFinish).toBe(true);
    expect(m.earlyStart).toBe(m.earlyFinish);
    expect([a.critical, b.critical, m.critical]).toEqual([true, true, true]);
    expect(s.result.criticalPaths).toEqual([[nodeA, nodeB, nodeM]]);
    expect(s.result.projectDurationDays).toBe(8);
    expect(s.calendar.workingDaysPerWeek).toBeGreaterThanOrEqual(5);
  });

  it(
    "a baseline freezes the computed dates; only the schedule lane may capture",
    { timeout: 300_000 },
    async () => {
      await expect(captureBaseline(A(), "viewer", { planId, name: "nope" })).rejects.toThrow(
        ForbiddenError,
      );
      const b = await captureBaseline(A(), "owner", { planId, name: "Baseline 0" });
      baselineId = b.id;
      expect(b.entries).toBe(3);
      const list = await listBaselines(A(), "owner", planId);
      expect(list.map((x) => x.name)).toEqual(["Baseline 0"]);
    },
  );

  it(
    "editing a linked node changes the REAL task and the variance appears",
    { timeout: 300_000 },
    async () => {
      await updateNode(A(), "owner", { nodeId: nodeA, durationDays: 5 });
      const task = (await owner`
      select duration_days from public.task where id = ${taskA}`) as unknown as Array<{
        duration_days: number;
      }>;
      expect(task[0]!.duration_days).toBe(5); // the canonical record moved
      const s = await scheduleForPlan(A(), "owner", { planId, baselineId });
      expect(s.result.projectDurationDays).toBe(10);
      expect(s.baseline?.name).toBe("Baseline 0");
      expect(s.baseline?.variance.get(nodeB)?.finishVarianceDays).toBe(2);
      expect(s.baseline?.variance.get(nodeM)?.finishVarianceDays).toBe(2);
      expect(s.baseline?.droppedNodeIds).toEqual([]);
      expect(s.baseline?.newNodeIds).toEqual([]);
    },
  );

  it(
    "a scenario reschedules its branch and leaves live work untouched",
    { timeout: 300_000 },
    async () => {
      const scenario = (await owner`
      insert into public.studio_scenario (org_id, plan_id, name, created_by)
      values (${orgA}, ${planId}, 'Longer survey', ${userA})
      returning id::text as id`) as unknown as Array<{ id: string }>;
      const scenarioId = scenario[0]!.id;
      await updateNode(A(), "owner", { nodeId: nodeA, scenarioId, durationDays: 7 });

      const branched = await scheduleForPlan(A(), "owner", { planId, scenarioId });
      expect(branched.result.projectDurationDays).toBe(12);
      const live = await scheduleForPlan(A(), "owner", { planId });
      expect(live.result.projectDurationDays).toBe(10);
      const task = (await owner`
      select duration_days from public.task where id = ${taskA}`) as unknown as Array<{
        duration_days: number;
      }>;
      expect(task[0]!.duration_days).toBe(5); // never touched by the scenario
    },
  );
});
