/**
 * H25H — resources and capacity on the living model.
 *
 * Properties: allocations are canonical (jobs door) and permission-gated; the
 * capacity report is a projection of the one schedule (demand per person per
 * ISO week vs calendar capacity, unassigned work kept visible); an assignee
 * without an allocation counts full time and is flagged implicit; leveling
 * never moves work — it records a scenario whose overlay delays the task
 * with float; skills attach to people and show on the report; the live task
 * is untouched by leveling.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { ForbiddenError } from "@/platform/authz";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import {
  createJobFromPreset,
  createTask,
  updateTask,
  allocateTask,
  unallocateTask,
  listTaskAllocations,
} from "@/modules/jobs/service";
import { createEmployee, createSkill, setEmployeeSkill } from "@/modules/masters/service";
import {
  createStudioPlan,
  addNode,
  capacityForPlan,
  levelIntoScenario,
  compareScenario,
  scheduleForPlan,
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
let salem = "";
let noor = "";

const A = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h25h",
});

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h25h-${run}@example.invalid`}, '{"full_name":"H25H"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H25H", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h25h", run);
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  salem = (await createEmployee(A(), "owner", { name: "Salem Al Harfi" })).id;
  noor = (await createEmployee(A(), "owner", { name: "Noor Rashid" })).id;
  const preset = (await owner`
    select id::text as id from public.job_preset where org_id = ${orgA} limit 1`) as unknown as Array<{
    id: string;
  }>;
  const job = await createJobFromPreset(A(), "owner", {
    presetId: preset[0]!.id,
    name: `Capacity job ${run}`,
  });
  // Two tasks in the SAME week, both anchored: A Mon 10-05 (3 days), B Tue 10-06 (2 days).
  taskA = (
    await createTask(A(), "owner", { jobId: job.id, title: "Survey", startDate: "2026-10-05" })
  ).id;
  await updateTask(A(), "owner", taskA, { durationDays: 3 });
  taskB = (
    await createTask(A(), "owner", { jobId: job.id, title: "Rigging", startDate: "2026-10-06" })
  ).id;
  await updateTask(A(), "owner", taskB, { durationDays: 2, assigneeEmployeeId: noor });
  // C runs two weeks later so A and B have float to level into.
  const taskC = (
    await createTask(A(), "owner", { jobId: job.id, title: "Sea trial", startDate: "2026-10-19" })
  ).id;
  await updateTask(A(), "owner", taskC, { durationDays: 3 });
  planId = (await createStudioPlan(A(), "owner", { name: `Capacity plan ${run}` })).id;
  await addNode(A(), "owner", { planId, nodeType: "task", recordType: "task", recordId: taskC });
  nodeA = (
    await addNode(A(), "owner", { planId, nodeType: "task", recordType: "task", recordId: taskA })
  ).id;
  nodeB = (
    await addNode(A(), "owner", { planId, nodeType: "task", recordType: "task", recordId: taskB })
  ).id;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
});

describe("allocations and the capacity report", () => {
  it("a viewer cannot allocate; a foreman-less owner can, and the rows are canonical", async () => {
    await expect(
      allocateTask(A(), "viewer", { taskId: taskA, employeeId: salem, sharePct: 100 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await allocateTask(A(), "owner", { taskId: taskA, employeeId: salem, sharePct: 100 });
    const rows = await listTaskAllocations(A(), "owner", [taskA, taskB]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId: taskA, employeeId: salem, sharePct: 100 });
  });

  it("projects demand per person-week from the schedule; an assignee counts implicitly", async () => {
    const report = await capacityForPlan(A(), "owner", { planId });
    expect(report.weeks[0]).toBe("2026-10-05");
    const s = report.people.find((p) => p.employeeId === salem)!;
    const n = report.people.find((p) => p.employeeId === noor)!;
    expect(s.cells["2026-10-05"]!.demandDays).toBe(3); // 3 working days at 100%
    expect(n.cells["2026-10-05"]!.demandDays).toBe(2); // assignee, no allocation
    expect(n.cells["2026-10-05"]!.items[0]!.implicit).toBe(true);
    expect(s.cells["2026-10-05"]!.capacityDays).toBeGreaterThanOrEqual(5);
    expect(report.overloads).toHaveLength(0);
    // C has nobody on it yet: visible as unassigned demand, never dropped.
    expect(report.unassigned["2026-10-19"]?.demandDays).toBe(3);
  });

  it("an overload appears when one person carries both tasks at once, and skills show", async () => {
    const skill = await createSkill(A(), "owner", { key: "lamination", name: "Lamination" });
    await setEmployeeSkill(A(), "owner", { employeeId: salem, skillId: skill.id, level: 4 });
    // Put Salem on B too, and push B's share so the week exceeds capacity:
    // A: 3 days + B: 2 days at 100% = 5 of 5 (UAE Mon–Fri) → not over. Add a
    // third day on Salem by stretching B to 4 days (Tue..Fri) → 3 + 4 = 7 > 5.
    await updateTask(A(), "owner", taskB, { durationDays: 4 });
    await allocateTask(A(), "owner", { taskId: taskB, employeeId: salem, sharePct: 100 });
    const report = await capacityForPlan(A(), "owner", { planId });
    const s = report.people.find((p) => p.employeeId === salem)!;
    expect(s.skills).toContain("Lamination");
    expect(s.cells["2026-10-05"]!.demandDays).toBeGreaterThan(s.cells["2026-10-05"]!.capacityDays);
    expect(report.overloads.some((o) => o.employeeId === salem && o.week === "2026-10-05")).toBe(
      true,
    );
    // Noor is off B now (explicit allocation replaces the implicit assignee count).
    const n = report.people.find((p) => p.employeeId === noor)!;
    expect(n.cells["2026-10-05"]?.demandDays ?? 0).toBe(0);
  });

  it("leveling records a scenario and leaves the live task where it is", async () => {
    const before = await scheduleForPlan(A(), "owner", { planId });
    // A and B both have float against C's later finish; the proposal delays
    // the one with the most float to the following week.
    const res = await levelIntoScenario(A(), "owner", { planId, name: `Level ${run}` });
    expect(res.proposals.length).toBeGreaterThanOrEqual(1);
    const cmp = await compareScenario(A(), "owner", res.scenarioId);
    expect(cmp.changes.some((c) => c.field === "startDate")).toBe(true);
    const after = await scheduleForPlan(A(), "owner", { planId });
    expect(after.byNode.get(nodeA)!.earlyStart).toBe(before.byNode.get(nodeA)!.earlyStart);
    expect(after.byNode.get(nodeB)!.earlyStart).toBe(before.byNode.get(nodeB)!.earlyStart);
    const branch = await scheduleForPlan(A(), "owner", { planId, scenarioId: res.scenarioId });
    const movedId = res.proposals[0]!.nodeId;
    expect(branch.byNode.get(movedId)!.earlyStart > before.byNode.get(movedId)!.earlyStart).toBe(
      true,
    );
  });

  it("removing an allocation clears the demand", async () => {
    const rows = await listTaskAllocations(A(), "owner", [taskB]);
    await unallocateTask(A(), "owner", rows.find((r) => r.employeeId === salem)!.id);
    const report = await capacityForPlan(A(), "owner", { planId });
    const s = report.people.find((p) => p.employeeId === salem)!;
    expect(s.cells["2026-10-05"]!.demandDays).toBe(3);
    expect(report.overloads).toHaveLength(0);
  });
});
