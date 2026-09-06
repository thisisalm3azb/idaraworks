/**
 * H25B — the canonical planning graph: one truth, routed writes.
 *
 * Properties: a linked node copies NOTHING (its fields resolve from the
 * record, and editing the node's date through the studio changes the REAL
 * task — the mandate's core principle); a dependency edge between linked
 * tasks materializes as a canonical task_dependency and cycles are refused
 * through the same service; scenario edits divert into the overlay and the
 * live task is untouched; converting a draft shape creates a real record
 * through the owning module; drift repairs hold (journal_entry approval
 * rules are creatable; lag rides the dependency).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createJobFromPreset, createTask, getTask } from "@/modules/jobs/service";
import { createApprovalRule } from "@/modules/approvals/service";
import {
  createStudioPlan,
  addNode,
  addEdge,
  updateNode,
  convertNode,
  resolvePlanGraph,
  archiveNode,
} from "@/modules/studio/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
let jobId = "";
let planId = "";
let taskA = "";
let taskB = "";
let nodeA = "";
let nodeB = "";

const A = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h25b",
});

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h25b-${run}@example.invalid`}, '{"full_name":"H25B"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H25B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h25b", run);
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  const preset = (await owner`
    select id::text as id from public.job_preset where org_id = ${orgA} limit 1`) as unknown as Array<{
    id: string;
  }>;
  const job = await createJobFromPreset(A(), "owner", {
    presetId: preset[0]!.id,
    name: `Studio job ${run}`,
  });
  jobId = job.id;
  taskA = (
    await createTask(A(), "owner", {
      jobId,
      title: "Design",
      startDate: "2026-10-01",
      dueDate: "2026-10-05",
    })
  ).id;
  taskB = (
    await createTask(A(), "owner", {
      jobId,
      title: "Build",
      startDate: "2026-10-06",
      dueDate: "2026-10-20",
    })
  ).id;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
}, 240_000);

describe("one living model", () => {
  it("links resolve from the record and edits route THROUGH it", { timeout: 300_000 }, async () => {
    const plan = await createStudioPlan(A(), "owner", { name: `Yard expansion ${run}` });
    planId = plan.id;
    expect(plan.reference).toMatch(/^PLN-/);

    nodeA = (
      await addNode(A(), "owner", {
        planId,
        nodeType: "task",
        recordType: "task",
        recordId: taskA,
        x: 100,
        y: 100,
      })
    ).id;
    nodeB = (
      await addNode(A(), "owner", {
        planId,
        nodeType: "task",
        recordType: "task",
        recordId: taskB,
        x: 400,
        y: 100,
      })
    ).id;

    // Cross-org / nonexistent link refused loudly.
    await expect(
      addNode(A(), "owner", {
        planId,
        nodeType: "task",
        recordType: "task",
        recordId: randomUUID(),
      }),
    ).rejects.toThrow(/not found/);

    const g1 = await resolvePlanGraph(A(), "owner", { planId });
    const a1 = g1.nodes.find((n) => n.id === nodeA)!;
    expect(a1.title).toBe("Design"); // resolved from the task, not stored
    expect(a1.dueDate).toBe("2026-10-05");

    // Editing the node's date updates the REAL task through the jobs door.
    const routed = await updateNode(A(), "owner", {
      nodeId: nodeA,
      dueDate: "2026-10-07",
      durationDays: 5,
    });
    expect(routed.routed).toBe("record");
    const task = await getTask(A(), "owner", taskA);
    expect(task?.dueDate).toBe("2026-10-07");
    expect(task?.durationDays).toBe(5);
    const g2 = await resolvePlanGraph(A(), "owner", { planId });
    expect(g2.nodes.find((n) => n.id === nodeA)!.dueDate).toBe("2026-10-07");
  });

  it(
    "a dependency edge IS a canonical dependency; cycles are refused",
    { timeout: 300_000 },
    async () => {
      const edge = await addEdge(A(), "owner", {
        planId,
        sourceNodeId: nodeA,
        targetNodeId: nodeB,
        edgeType: "dependency",
        depKind: "finish_to_start",
        lagDays: 2,
      });
      expect(edge.taskDependencyId).not.toBeNull();
      const dep = await owner`
        select kind, lag_days from public.task_dependency
        where id = ${edge.taskDependencyId!} and removed_at is null`;
      expect(dep[0]).toMatchObject({ kind: "finish_to_start", lag_days: 2 });

      // The reverse edge would create a cycle — refused by the SAME service.
      await expect(
        addEdge(A(), "owner", {
          planId,
          sourceNodeId: nodeB,
          targetNodeId: nodeA,
          edgeType: "dependency",
          depKind: "finish_to_start",
        }),
      ).rejects.toThrow();

      const g = await resolvePlanGraph(A(), "owner", { planId });
      const e = g.edges.find((x) => x.id === edge.id)!;
      expect(e.materialized).toBe(true);
      expect(e.lagDays).toBe(2);
    },
  );

  it(
    "scenario edits stay in the overlay; the live task is untouched",
    { timeout: 300_000 },
    async () => {
      const scenario = (await owner`
      insert into public.studio_scenario (org_id, plan_id, name, created_by)
      values (${orgA}, ${planId}, 'Delay test', ${userA})
      returning id::text as id`) as unknown as Array<{ id: string }>;
      const scenarioId = scenario[0]!.id;

      const routed = await updateNode(A(), "owner", {
        nodeId: nodeA,
        scenarioId,
        dueDate: "2026-11-30",
      });
      expect(routed.routed).toBe("scenario");

      // Live truth unchanged…
      const task = await getTask(A(), "owner", taskA);
      expect(task?.dueDate).toBe("2026-10-07");
      const live = await resolvePlanGraph(A(), "owner", { planId });
      expect(live.nodes.find((n) => n.id === nodeA)!.dueDate).toBe("2026-10-07");
      // …while the scenario resolution overlays it and says so.
      const branched = await resolvePlanGraph(A(), "owner", { planId, scenarioId });
      const overlaid = branched.nodes.find((n) => n.id === nodeA)!;
      expect(overlaid.dueDate).toBe("2026-11-30");
      expect(overlaid.overlaidFields).toContain("dueDate");
    },
  );

  it(
    "a draft shape converts into a real task with its dependencies",
    { timeout: 300_000 },
    async () => {
      const draft = (
        await addNode(A(), "owner", {
          planId,
          nodeType: "task",
          title: "Commission",
          startDate: "2026-10-21",
          dueDate: "2026-10-25",
          durationDays: 4,
          x: 700,
          y: 100,
        })
      ).id;
      // Draft dependency on a linked task: stays studio-level (not materialized)…
      const draftEdge = await addEdge(A(), "owner", {
        planId,
        sourceNodeId: nodeB,
        targetNodeId: draft,
        edgeType: "dependency",
        depKind: "finish_to_start",
      });
      expect(draftEdge.taskDependencyId).toBeNull();
      let g = await resolvePlanGraph(A(), "owner", { planId });
      expect(g.edges.find((e) => e.id === draftEdge.id)!.materialized).toBe(false);

      // …until conversion, when it becomes canonical.
      const converted = await convertNode(A(), "owner", { nodeId: draft, to: "task", jobId });
      expect(converted.recordType).toBe("task");
      const newTask = await getTask(A(), "owner", converted.recordId);
      expect(newTask?.title).toBe("Commission");
      expect(newTask?.durationDays).toBe(4);
      g = await resolvePlanGraph(A(), "owner", { planId });
      expect(g.edges.find((e) => e.id === draftEdge.id)!.materialized).toBe(true);

      // Archiving the node soft-removes edges and the canonical dependency.
      await archiveNode(A(), "owner", draft);
      const liveDeps = await owner`
      select count(*)::int as n from public.task_dependency
      where org_id = ${orgA} and task_id = ${converted.recordId} and removed_at is null`;
      expect(liveDeps[0]!.n).toBe(0);
    },
  );

  it(
    "a materialised edge never outlives the dependency it names",
    { timeout: 300_000 },
    async () => {
      /*
       * H33 found four Studio edges citing a task_dependency row that did not
       * exist. Two causes, both here:
       *
       *   1. addEdge materialised the dependency by calling the ctx form from
       *      inside its own transaction, so the dependency was written in a
       *      DIFFERENT transaction and the two could not fail together.
       *   2. The insert is "on conflict do nothing", and the id returned was
       *      the freshly minted uuid rather than the row's — so asking twice
       *      for the same dependency handed back an id that was never written.
       *
       * The second is the one that bites without any transaction trouble at
       * all, so it is what this test drives: materialise the same pair twice.
       */
      const t1 = await createTask(A(), "manager", { jobId, title: `dup-a-${run}` });
      const t2 = await createTask(A(), "manager", { jobId, title: `dup-b-${run}` });
      const n1 = await addNode(A(), "manager", {
        planId,
        nodeType: "task",
        title: "dup source",
        recordType: "task",
        recordId: t1.id,
      });
      const n2 = await addNode(A(), "manager", {
        planId,
        nodeType: "task",
        title: "dup target",
        recordType: "task",
        recordId: t2.id,
      });
      const first = await addEdge(A(), "manager", {
        planId,
        sourceNodeId: n1.id,
        targetNodeId: n2.id,
        edgeType: "dependency",
        depKind: "finish_to_start",
        lagDays: 0,
      });
      // The same dependency again, through a second edge.
      const n3 = await addNode(A(), "manager", {
        planId,
        nodeType: "task",
        title: "dup source again",
        recordType: "task",
        recordId: t1.id,
      });
      const n4 = await addNode(A(), "manager", {
        planId,
        nodeType: "task",
        title: "dup target again",
        recordType: "task",
        recordId: t2.id,
      });
      const second = await addEdge(A(), "manager", {
        planId,
        sourceNodeId: n3.id,
        targetNodeId: n4.id,
        edgeType: "dependency",
        depKind: "finish_to_start",
        lagDays: 0,
      });

      const dangling = (await owner`
        select count(*)::int as n from public.studio_edge e
        where e.org_id = ${orgA} and e.id in (${first.id}, ${second.id})
          and e.task_dependency_id is not null
          and not exists (
            select 1 from public.task_dependency d
            where d.id = e.task_dependency_id and d.org_id = e.org_id)
      `) as unknown as Array<{ n: number }>;
      expect(dangling[0]!.n, "an edge citing a dependency that is not there").toBe(0);

      // And both edges name the SAME dependency, because there is only one.
      const named = (await owner`
        select distinct task_dependency_id::text as id from public.studio_edge
        where org_id = ${orgA} and id in (${first.id}, ${second.id})
          and task_dependency_id is not null
      `) as unknown as Array<{ id: string }>;
      expect(named.length, "one pair of tasks, one dependency").toBe(1);
    },
  );

  it(
    "drift repair: a journal_entry approval rule is creatable again",
    { timeout: 300_000 },
    async () => {
      const rule = await createApprovalRule(A(), "owner", {
        subjectType: "journal_entry",
        conditionKind: "always",
        assignedRole: "owner",
      });
      expect(rule.id).toBeTruthy();
    },
  );
});
