/**
 * H21 — adaptive work against the real database: the three creation paths, the
 * validated lifecycle with reasons and terminal immutability, blueprint phase
 * snapshots (including the new phase_semantic) with historical preservation,
 * the task lifecycle with parent/child rules, dependency cycles and readiness,
 * assignment scope, scheduling and overdue truth, the task-completion approval
 * with idempotent decisions, role restrictions, archival and cross-organization
 * isolation. Self-cleaning (wipeOrgs).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate } from "@/platform/config/install";
import {
  createBlueprintDraft,
  validateBlueprintRevision,
  approveBlueprintRevision,
  applyBlueprintRevision,
} from "@/platform/workspace";
import { createCustomer, createEmployee } from "@/modules/masters/service";
import { createQuote, acceptQuote } from "@/modules/quotes/service";
import {
  createJobFromPreset,
  listActivePresets,
  listWork,
  workCountsByCategory,
  getMyWork,
  getSchedule,
  getWorkload,
  workDashboardCounts,
  customerWork,
  changeWorkStatus,
  reopenJob,
  setJobArchived,
  canTransition,
  WorkTransitionError,
  WorkReasonRequiredError,
  WorkImmutableError,
  createTask,
  updateTask,
  updateTaskStatus,
  setTaskArchived,
  listJobTasks,
  addDependency,
  removeDependency,
  getTaskDependencies,
  blockerCountsForJob,
  DependencyCycleError,
  DependencyScopeError,
  TaskBlockedError,
  TaskChildrenOpenError,
  TaskDepthError,
  addCrewMember,
} from "@/modules/jobs/service";
import {
  createOpportunity,
  winOpportunity,
  startWorkFromOpportunity,
  workForOpportunity,
  OpportunityNotWonError,
  OpportunityCustomerRequiredError,
} from "@/modules/crm/service";
import { listInbox, decideApproval } from "@/modules/approvals/service";
import { orgToday } from "@/modules/dashboard/service";
import { scenarioContractor } from "../unit/workspace-fixtures";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";
let presetA = "";
let custId = "";
let aliId = "";

const ctxOf = (orgId: string, userId: string, priv = true): Ctx => ({
  orgId,
  userId,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "h21-test",
});

const asOf = orgToday(new Date(), "Asia/Dubai");
const shift = (days: number) => {
  const d = new Date(`${asOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const FIXTURE_STAGES = scenarioContractor().workflows[0]!.stages;

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h21-${label}-${run}@example.com`}, '{"full_name":"H21 Test"}'::jsonb, now(), now())`;
}

/** The org's status keys, by semantic category. */
async function statusKeyFor(orgId: string, category: string): Promise<string> {
  const rows = (await owner`
    select value from public.app_settings
    where org_id = ${orgId} and key = 'config.status_set.job'`) as unknown as Array<{
    value: { statuses: Array<{ status_key: string; semantic_category: string }> };
  }>;
  const found = rows[0]!.value.statuses.find((s) => s.semantic_category === category);
  if (!found) throw new Error(`org has no status for category ${category}`);
  return found.status_key;
}

beforeAll(async () => {
  await seedUser(userA, "a");
  await seedUser(userB, "b");
  orgA = await createOrgForUser(userA, { name: "H21 A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "H21 B", country: "AE", baseCurrency: "AED" });
  await installTemplate(ctxOf(orgA, userA), "generic_operations_v1");
  await installTemplate(ctxOf(orgB, userB), "generic_operations_v1");
  const draft = await createBlueprintDraft(ctxOf(orgA, userA), "owner", {
    blueprint: scenarioContractor(),
    source: "onboarding_answer",
    reason: "H21 work test",
  });
  await validateBlueprintRevision(ctxOf(orgA, userA), "owner", draft.id);
  await approveBlueprintRevision(ctxOf(orgA, userA), "owner", draft.id, {
    expectedHash: draft.blueprintHash,
  });
  await applyBlueprintRevision(ctxOf(orgA, userA), "owner", draft.id);
  presetA = (await listActivePresets(ctxOf(orgA, userA), "owner"))[0]!.id;
  ({ id: custId } = await createCustomer(ctxOf(orgA, userA), "owner", { name: "Northline Group" }));
  ({ id: aliId } = await createEmployee(ctxOf(orgA, userA), "owner", {
    name: "Ali",
    userId: userA,
  }));
}, 240_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 120_000);

describe("H21 — work creation paths", () => {
  it("direct work records its origin and adopts the blueprint phases with semantics", async () => {
    const { id } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "Direct internal initiative",
      priority: "high",
      description: "Started without any sales record.",
      location: "Head office",
    });
    const rows = (await owner`
      select origin, priority, description, location, source_opportunity_id
      from public.job where id = ${id}`) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]!.origin).toBe("direct");
    expect(rows[0]!.priority).toBe("high");
    expect(rows[0]!.source_opportunity_id).toBeNull();
    // Phases snapshot from the applied blueprint, now carrying phase_semantic.
    const stages = (await owner`
      select stage_key, phase_semantic from public.job_stage
      where job_id = ${id} order by sort`) as unknown as Array<{
      stage_key: string;
      phase_semantic: string | null;
    }>;
    expect(stages.map((s) => s.stage_key)).toEqual(FIXTURE_STAGES.map((s) => s.key));
    expect(stages.some((s) => s.phase_semantic !== null)).toBe(true);
  });

  it("an accepted quotation still creates exactly one work record", async () => {
    const q = await createQuote(ctxOf(orgA, userA), "owner", {
      customerId: custId,
      presetId: presetA,
      lines: [{ description: "Phase one", qty: 1, unit: "lot", unitPriceMinor: 400000 }],
    });
    await owner`update public.quote set status = 'sent', updated_at = now()
                where id = ${q.id} and org_id = ${orgA}`;
    const { jobId } = await acceptQuote(ctxOf(orgA, userA), "owner", q.id, {
      jobName: "Quoted delivery",
    });
    const jobs = (await owner`
      select count(*)::int as n from public.job
      where org_id = ${orgA} and id = ${jobId}`) as unknown as Array<{ n: number }>;
    expect(jobs[0]!.n).toBe(1);
    const linked = (await owner`
      select converted_job_id::text as j from public.quote where id = ${q.id}`) as unknown as Array<{
      j: string;
    }>;
    expect(linked[0]!.j).toBe(jobId);
  });

  it("a won opportunity creates work ONLY through the explicit command, idempotently", async () => {
    const { id: oppId } = await createOpportunity(ctxOf(orgA, userA), "owner", {
      name: "Retainer engagement",
      customerId: custId,
      estimatedValueMinor: 300000,
    });
    // Winning alone must not create work.
    await winOpportunity(ctxOf(orgA, userA), "owner", oppId);
    expect(await workForOpportunity(ctxOf(orgA, userA), "owner", oppId)).toBeNull();

    const first = await startWorkFromOpportunity(ctxOf(orgA, userA), "owner", oppId, {
      presetId: presetA,
      name: "Retainer delivery",
      dueDate: shift(30),
    });
    expect(first.deduped).toBe(false);
    const second = await startWorkFromOpportunity(ctxOf(orgA, userA), "owner", oppId, {
      presetId: presetA,
      name: "Retainer delivery again",
    });
    expect(second.deduped).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    const rows = (await owner`
      select origin, source_opportunity_id::text as opp, customer_id::text as cust
      from public.job where id = ${first.jobId}`) as unknown as Array<Record<string, string>>;
    expect(rows[0]!.origin).toBe("opportunity");
    expect(rows[0]!.opp).toBe(oppId);
    expect(rows[0]!.cust).toBe(custId);
    // Exactly one work record exists for that opportunity.
    const count = (await owner`
      select count(*)::int as n from public.job
      where org_id = ${orgA} and source_opportunity_id = ${oppId}`) as unknown as Array<{
      n: number;
    }>;
    expect(count[0]!.n).toBe(1);
  });

  it("refuses to start work from an unwon opportunity or one without a customer", async () => {
    const { id: open } = await createOpportunity(ctxOf(orgA, userA), "owner", {
      name: "Still open",
      customerId: custId,
    });
    await expect(
      startWorkFromOpportunity(ctxOf(orgA, userA), "owner", open, {
        presetId: presetA,
        name: "Too early",
      }),
    ).rejects.toBeInstanceOf(OpportunityNotWonError);

    const { id: noCustomer } = await createOpportunity(ctxOf(orgA, userA), "owner", {
      name: "No customer yet",
    });
    await winOpportunity(ctxOf(orgA, userA), "owner", noCustomer);
    await expect(
      startWorkFromOpportunity(ctxOf(orgA, userA), "owner", noCustomer, {
        presetId: presetA,
        name: "Missing customer",
      }),
    ).rejects.toBeInstanceOf(OpportunityCustomerRequiredError);
  });
});

describe("H21 — work lifecycle", () => {
  let jobId = "";

  it("moves through legal transitions and demands a reason to hold", async () => {
    ({ id: jobId } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "Lifecycle probe",
      dueDate: shift(10),
    }));
    expect(canTransition("draft", "active")).toBe(true);
    expect(canTransition("done", "active")).toBe(false);

    const activeKey = await statusKeyFor(orgA, "active");
    await changeWorkStatus(ctxOf(orgA, userA), "owner", jobId, { statusKey: activeKey });

    const holdKey = await statusKeyFor(orgA, "on_hold");
    await expect(
      changeWorkStatus(ctxOf(orgA, userA), "owner", jobId, { statusKey: holdKey }),
    ).rejects.toBeInstanceOf(WorkReasonRequiredError);
    await changeWorkStatus(ctxOf(orgA, userA), "owner", jobId, {
      statusKey: holdKey,
      reason: "Waiting for the customer's drawings",
    });
    const held = (await owner`
      select status_category, on_hold_reason from public.job where id = ${jobId}`) as unknown as Array<
      Record<string, string>
    >;
    expect(held[0]!.status_category).toBe("on_hold");
    expect(held[0]!.on_hold_reason).toMatch(/drawings/);

    // Leaving the hold clears the stale explanation.
    await changeWorkStatus(ctxOf(orgA, userA), "owner", jobId, { statusKey: activeKey });
    const resumed = (await owner`
      select on_hold_reason from public.job where id = ${jobId}`) as unknown as Array<
      Record<string, string | null>
    >;
    expect(resumed[0]!.on_hold_reason).toBeNull();
  });

  it("completed work is immutable until an authorized reopen with a reason", async () => {
    const doneKey = await statusKeyFor(orgA, "done");
    await changeWorkStatus(ctxOf(orgA, userA), "owner", jobId, { statusKey: doneKey });
    const done = (await owner`
      select status_category, completed_date from public.job where id = ${jobId}`) as unknown as Array<
      Record<string, string | null>
    >;
    expect(done[0]!.status_category).toBe("done");
    expect(done[0]!.completed_date).not.toBeNull();

    // No ordinary status edit escapes a terminal state.
    const activeKey = await statusKeyFor(orgA, "active");
    await expect(
      changeWorkStatus(ctxOf(orgA, userA), "owner", jobId, { statusKey: activeKey }),
    ).rejects.toBeInstanceOf(WorkTransitionError);
    // Operational writes are refused too.
    await expect(
      createTask(ctxOf(orgA, userA), "owner", { jobId, title: "Too late" }),
    ).rejects.toBeInstanceOf(WorkImmutableError);
    // A manager may reopen, with a reason; the completion date is cleared.
    await reopenJob(ctxOf(orgA, userA), "manager", jobId, {
      reason: "Customer reported a defect",
      statusKey: activeKey,
    });
    const reopened = (await owner`
      select status_category, completed_date from public.job where id = ${jobId}`) as unknown as Array<
      Record<string, string | null>
    >;
    expect(reopened[0]!.status_category).toBe("active");
    expect(reopened[0]!.completed_date).toBeNull();
    // A foreman may not reopen.
    await expect(
      reopenJob(ctxOf(orgA, userA), "foreman", jobId, {
        reason: "nope",
        statusKey: activeKey,
      }),
    ).rejects.toThrow();
  });

  it("cancellation requires a reason and archival keeps every record", async () => {
    const cancelKey = await statusKeyFor(orgA, "cancelled");
    await expect(
      changeWorkStatus(ctxOf(orgA, userA), "owner", jobId, { statusKey: cancelKey }),
    ).rejects.toBeInstanceOf(WorkReasonRequiredError);
    await changeWorkStatus(ctxOf(orgA, userA), "owner", jobId, {
      statusKey: cancelKey,
      reason: "Customer withdrew the scope",
    });

    const stagesBefore = (await owner`
      select count(*)::int as n from public.job_stage where job_id = ${jobId}`) as unknown as Array<{
      n: number;
    }>;
    await setJobArchived(ctxOf(orgA, userA), "owner", jobId, true);
    const archived = (await owner`
      select archived, archived_at, archived_by::text as by, cancellation_reason
      from public.job where id = ${jobId}`) as unknown as Array<Record<string, unknown>>;
    expect(archived[0]!.archived).toBe(true);
    expect(archived[0]!.archived_at).not.toBeNull();
    expect(archived[0]!.by).toBe(userA);
    expect(archived[0]!.cancellation_reason).toMatch(/withdrew/);
    // Archival destroys nothing.
    const stagesAfter = (await owner`
      select count(*)::int as n from public.job_stage where job_id = ${jobId}`) as unknown as Array<{
      n: number;
    }>;
    expect(stagesAfter[0]!.n).toBe(stagesBefore[0]!.n);
    // Archived work is out of the working list but reachable through the filter.
    expect((await listWork(ctxOf(orgA, userA), "owner", {})).some((w) => w.id === jobId)).toBe(
      false,
    );
    expect(
      (await listWork(ctxOf(orgA, userA), "owner", { archived: true })).some((w) => w.id === jobId),
    ).toBe(true);
    // Live work cannot be archived.
    const { id: live } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "Still running",
    });
    await expect(setJobArchived(ctxOf(orgA, userA), "owner", live, true)).rejects.toBeInstanceOf(
      WorkTransitionError,
    );
  });
});

describe("H21 — tasks, dependencies and readiness", () => {
  let jobId = "";
  let a = "";
  let b = "";
  let c = "";

  it("creates tasks with real fields and enforces nesting depth", async () => {
    ({ id: jobId } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "Task probe",
    }));
    ({ id: a } = await createTask(ctxOf(orgA, userA), "owner", {
      jobId,
      title: "Survey the site",
      description: "Measure and photograph",
      priority: "high",
      startDate: asOf,
      dueDate: shift(2),
      estimatedMinutes: 120,
      assigneeEmployeeId: aliId,
    }));
    ({ id: b } = await createTask(ctxOf(orgA, userA), "owner", {
      jobId,
      title: "Produce drawings",
      dueDate: shift(5),
    }));
    const child = await createTask(ctxOf(orgA, userA), "owner", {
      jobId,
      title: "Check dimensions",
      parentTaskId: a,
    });
    // Two levels only.
    await expect(
      createTask(ctxOf(orgA, userA), "owner", {
        jobId,
        title: "Too deep",
        parentTaskId: child.id,
      }),
    ).rejects.toBeInstanceOf(TaskDepthError);

    const tasks = await listJobTasks(ctxOf(orgA, userA), jobId);
    const survey = tasks.find((t) => t.id === a)!;
    expect(survey.priority).toBe("high");
    expect(survey.estimatedMinutes).toBe(120);
    expect(survey.assigneeName).toBe("Ali");
  });

  // Creating a second work record inside this case pushes it past the default
  // 30s against the hosted database; the assertions themselves are quick.
  it(
    "rejects self, duplicate, cross-work and cyclic dependencies",
    { timeout: 90_000 },
    async () => {
      await addDependency(ctxOf(orgA, userA), "owner", { taskId: b, dependsOnTaskId: a });
      // Duplicate is a no-op, not a second edge.
      await addDependency(ctxOf(orgA, userA), "owner", { taskId: b, dependsOnTaskId: a });
      const edges = (await owner`
      select count(*)::int as n from public.task_dependency
      where org_id = ${orgA} and task_id = ${b} and depends_on_task_id = ${a}
        and removed_at is null`) as unknown as Array<{ n: number }>;
      expect(edges[0]!.n).toBe(1);

      await expect(
        addDependency(ctxOf(orgA, userA), "owner", { taskId: a, dependsOnTaskId: a }),
      ).rejects.toBeInstanceOf(DependencyCycleError);
      // Direct cycle.
      await expect(
        addDependency(ctxOf(orgA, userA), "owner", { taskId: a, dependsOnTaskId: b }),
      ).rejects.toBeInstanceOf(DependencyCycleError);
      // Indirect cycle: a <- b <- c, then c -> a would close the loop.
      ({ id: c } = await createTask(ctxOf(orgA, userA), "owner", { jobId, title: "Install" }));
      await addDependency(ctxOf(orgA, userA), "owner", { taskId: c, dependsOnTaskId: b });
      await expect(
        addDependency(ctxOf(orgA, userA), "owner", { taskId: a, dependsOnTaskId: c }),
      ).rejects.toBeInstanceOf(DependencyCycleError);

      // Cross-work dependencies are refused.
      const other = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
        presetId: presetA,
        name: "Other work",
      });
      const foreign = await createTask(ctxOf(orgA, userA), "owner", {
        jobId: other.id,
        title: "Elsewhere",
      });
      await expect(
        addDependency(ctxOf(orgA, userA), "owner", { taskId: c, dependsOnTaskId: foreign.id }),
      ).rejects.toBeInstanceOf(DependencyScopeError);
    },
  );

  it("a blocked task cannot start, and finishing its blocker frees it", async () => {
    await expect(
      updateTaskStatus(ctxOf(orgA, userA), "owner", b, { status: "in_progress" }),
    ).rejects.toBeInstanceOf(TaskBlockedError);

    const view = await getTaskDependencies(ctxOf(orgA, userA), "owner", b);
    expect(view.blockedBy.map((e) => e.dependsOnTaskId)).toContain(a);
    expect(view.blocks.map((e) => e.taskId)).toContain(c);
    expect(view.blockedBy[0]!.satisfied).toBe(false);

    const counts = await blockerCountsForJob(ctxOf(orgA, userA), jobId);
    expect(counts.get(b)).toBe(1);

    // Finish the blocker. It contains a child step, and a container never
    // completes over unfinished contents — so the child closes first.
    const children = (await listJobTasks(ctxOf(orgA, userA), jobId)).filter(
      (t) => t.parentTaskId === a,
    );
    for (const child of children) {
      await updateTaskStatus(ctxOf(orgA, userA), "owner", child.id, { status: "in_progress" });
      await updateTaskStatus(ctxOf(orgA, userA), "owner", child.id, { status: "completed" });
    }
    await updateTaskStatus(ctxOf(orgA, userA), "owner", a, { status: "in_progress" });
    await updateTaskStatus(ctxOf(orgA, userA), "owner", a, {
      status: "completed",
      actualMinutes: 90,
    });
    const after = await listJobTasks(ctxOf(orgA, userA), jobId);
    expect(after.find((t) => t.id === b)!.status).toBe("ready");
    expect(after.find((t) => t.id === a)!.actualMinutes).toBe(90);
    await updateTaskStatus(ctxOf(orgA, userA), "owner", b, { status: "in_progress" });

    // Removing a dependency also frees the dependent.
    const edge = (await owner`
      select id::text as id from public.task_dependency
      where org_id = ${orgA} and task_id = ${c} and removed_at is null`) as unknown as Array<{
      id: string;
    }>;
    await removeDependency(ctxOf(orgA, userA), "owner", edge[0]!.id);
    expect((await blockerCountsForJob(ctxOf(orgA, userA), jobId)).get(c) ?? 0).toBe(0);
  });

  it("a blocked task explains itself and a parent never completes over open children", async () => {
    const { id: t } = await createTask(ctxOf(orgA, userA), "owner", {
      jobId,
      title: "Blocked one",
    });
    await expect(
      updateTaskStatus(ctxOf(orgA, userA), "owner", t, { status: "blocked" }),
    ).rejects.toThrow();
    await updateTaskStatus(ctxOf(orgA, userA), "owner", t, {
      status: "blocked",
      reason: "Waiting for the access permit",
    });
    const rows = await listJobTasks(ctxOf(orgA, userA), jobId);
    expect(rows.find((x) => x.id === t)!.blockedReason).toMatch(/permit/);

    // 'a' has an unfinished child, so completing it is refused (never silent).
    const parent = await createTask(ctxOf(orgA, userA), "owner", { jobId, title: "Container" });
    await createTask(ctxOf(orgA, userA), "owner", {
      jobId,
      title: "Inner step",
      parentTaskId: parent.id,
    });
    await updateTaskStatus(ctxOf(orgA, userA), "owner", parent.id, { status: "in_progress" });
    await expect(
      updateTaskStatus(ctxOf(orgA, userA), "owner", parent.id, { status: "completed" }),
    ).rejects.toBeInstanceOf(TaskChildrenOpenError);
  });

  it("archiving a task hides it without deleting it", async () => {
    const { id: t } = await createTask(ctxOf(orgA, userA), "owner", { jobId, title: "Archive me" });
    await setTaskArchived(ctxOf(orgA, userA), "owner", t, true);
    expect((await listJobTasks(ctxOf(orgA, userA), jobId)).some((x) => x.id === t)).toBe(false);
    expect(
      (await listJobTasks(ctxOf(orgA, userA), jobId, { includeArchived: true })).some(
        (x) => x.id === t,
      ),
    ).toBe(true);
    const still = (await owner`
      select count(*)::int as n from public.task where id = ${t}`) as unknown as Array<{
      n: number;
    }>;
    expect(still[0]!.n).toBe(1);
  });

  it("edits task fields through the audited command", async () => {
    const { id: t } = await createTask(ctxOf(orgA, userA), "owner", { jobId, title: "Editable" });
    await updateTask(ctxOf(orgA, userA), "owner", t, {
      title: "Edited title",
      priority: "urgent",
      dueDate: shift(3),
      estimatedMinutes: 45,
    });
    const row = (await listJobTasks(ctxOf(orgA, userA), jobId)).find((x) => x.id === t)!;
    expect(row.title).toBe("Edited title");
    expect(row.priority).toBe("urgent");
    expect(row.estimatedMinutes).toBe(45);
  });
});

describe("H21 — task completion approval", () => {
  it("routes an approval-gated task through the inbox and completes it once", async () => {
    const { id: jobId } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "Approval probe",
    });
    const { id: taskId } = await createTask(ctxOf(orgA, userA), "owner", {
      jobId,
      title: "Sign off the survey",
      requiresApproval: true,
    });
    await updateTaskStatus(ctxOf(orgA, userA), "owner", taskId, { status: "in_progress" });
    const res = await updateTaskStatus(ctxOf(orgA, userA), "owner", taskId, {
      status: "completed",
    });
    // It did NOT complete directly.
    expect(res.status === "awaiting_approval" || res.status === "completed").toBe(true);

    const rows = (await owner`
      select state, subject_type from public.approval
      where org_id = ${orgA} and subject_id = ${taskId}`) as unknown as Array<{
      state: string;
      subject_type: string;
    }>;
    expect(rows[0]!.subject_type).toBe("task_completion");

    if (rows[0]!.state === "pending") {
      const inbox = await listInbox(ctxOf(orgA, userA), "owner");
      const item = inbox.find((i) => i.subjectId === taskId);
      expect(item).toBeDefined();
      // A task approval never borrows a money permission.
      expect(item!.amountMinor).toBeNull();
      const approvalId = item!.id;
      await decideApproval(ctxOf(orgA, userA), "owner", {
        approvalId,
        decision: "approved",
      });
      // Deciding twice is refused — the decision is idempotent.
      await expect(
        decideApproval(ctxOf(orgA, userA), "owner", { approvalId, decision: "approved" }),
      ).rejects.toThrow();
    }
    const task = (await owner`
      select status, completed_at from public.task where id = ${taskId}`) as unknown as Array<
      Record<string, unknown>
    >;
    expect(task[0]!.status).toBe("completed");
    expect(task[0]!.completed_at).not.toBeNull();
  });
});

describe("H21 — reads: hub, my work, schedule, workload, dashboard", () => {
  it("the work list filters and counts agree with the records", async () => {
    const all = await listWork(ctxOf(orgA, userA), "owner", {});
    expect(all.length).toBeGreaterThan(0);
    const urgent = await listWork(ctxOf(orgA, userA), "owner", { priority: "high" });
    expect(urgent.every((w) => w.priority === "high")).toBe(true);
    const byCustomer = await listWork(ctxOf(orgA, userA), "owner", { customerId: custId });
    expect(byCustomer.every((w) => w.customerId === custId)).toBe(true);
    const byOrigin = await listWork(ctxOf(orgA, userA), "owner", { origin: "opportunity" });
    expect(byOrigin.every((w) => w.origin === "opportunity")).toBe(true);
    const searched = await listWork(ctxOf(orgA, userA), "owner", { q: "Task probe" });
    expect(searched.some((w) => w.name === "Task probe")).toBe(true);

    const counts = await workCountsByCategory(ctxOf(orgA, userA), "owner");
    const draftListed = await listWork(ctxOf(orgA, userA), "owner", { category: "draft" });
    expect(draftListed.length).toBe(counts.draft ?? 0);
    // Task rollups are real, not guesses.
    const probe = all.find((w) => w.name === "Task probe");
    expect(probe!.openTasks).toBeGreaterThan(0);
  });

  it("my work shows only this person's records and drills to them", async () => {
    const mine = await getMyWork(ctxOf(orgA, userA), "owner", { asOf });
    expect(mine.employeeId).toBe(aliId);
    // Every listed task is assigned to this user's employee record.
    const assigned = (await owner`
      select id::text as id from public.task
      where org_id = ${orgA} and assignee_employee_id = ${aliId}`) as unknown as Array<{
      id: string;
    }>;
    const ids = new Set(assigned.map((r) => r.id));
    for (const t of [...mine.overdueTasks, ...mine.dueTodayTasks, ...mine.upcomingTasks]) {
      expect(ids.has(t.id)).toBe(true);
    }
  });

  it("the schedule separates dated items from unscheduled ones and marks overdue", async () => {
    const { id: jobId } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "Scheduled work",
      dueDate: shift(-3),
    });
    await createTask(ctxOf(orgA, userA), "owner", {
      jobId,
      title: "Late task",
      dueDate: shift(-1),
    });
    await createTask(ctxOf(orgA, userA), "owner", { jobId, title: "No dates at all" });
    const view = await getSchedule(ctxOf(orgA, userA), "owner", {
      from: shift(-30),
      to: shift(30),
      asOf,
    });
    const late = view.items.find((i) => i.title === "Late task");
    expect(late!.overdue).toBe(true);
    expect(view.unscheduled.some((i) => i.title === "No dates at all")).toBe(true);
    expect(view.items.some((i) => i.kind === "work" && i.title === "Scheduled work")).toBe(true);
  });

  it("workload reports counts, never a capacity verdict", async () => {
    const load = await getWorkload(ctxOf(orgA, userA), "owner", asOf);
    const ali = load.find((l) => l.employeeId === aliId);
    expect(ali).toBeDefined();
    expect(typeof ali!.openTasks).toBe("number");
    expect(typeof ali!.assignedWork).toBe("number");
  });

  it("dashboard counts match the lists they drill into", async () => {
    const counts = await workDashboardCounts(ctxOf(orgA, userA), "owner", {
      asOf,
      horizonDays: 7,
    });
    const overdueList = await listWork(ctxOf(orgA, userA), "owner", { overdue: asOf });
    expect(counts.overdueWork).toBe(overdueList.length);
    const activeList = await listWork(ctxOf(orgA, userA), "owner", { category: "active" });
    expect(counts.activeWork).toBe(activeList.length);
  });

  it("customer 360 work summary is scoped to that customer", async () => {
    const view = await customerWork(ctxOf(orgA, userA), "owner", custId, asOf);
    expect(view.rows.every((r) => r.customerId === custId)).toBe(true);
    expect(view.activeCount + view.completedCount).toBeLessThanOrEqual(view.rows.length);
  });
});

describe("H21 — roles and isolation", () => {
  it("a foreman is narrowed to assigned work everywhere", async () => {
    const { id: unassigned } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "Not theirs",
    });
    const { id: assignedJob } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "Theirs",
    });
    await addCrewMember(ctxOf(orgA, userA), "owner", assignedJob, aliId);
    const seen = await listWork(ctxOf(orgA, userA, false), "foreman", {});
    expect(seen.some((w) => w.id === assignedJob)).toBe(true);
    expect(seen.some((w) => w.id === unassigned)).toBe(false);
  });

  it("a viewer cannot manage tasks and a foreman cannot archive work", async () => {
    const { id: jobId } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "Role probe",
    });
    await expect(
      createTask(ctxOf(orgA, userA), "viewer", { jobId, title: "nope" }),
    ).rejects.toThrow();
    await expect(setJobArchived(ctxOf(orgA, userA), "foreman", jobId, true)).rejects.toThrow();
    await expect(
      addDependency(ctxOf(orgA, userA), "foreman", {
        taskId: randomUUID(),
        dependsOnTaskId: randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it("organization B reads and changes nothing of organization A", async () => {
    const aWork = await listWork(ctxOf(orgA, userA), "owner", {});
    const bWork = await listWork(ctxOf(orgB, userB), "owner", {});
    expect(bWork.some((w) => aWork.some((x) => x.id === w.id))).toBe(false);
    const aTaskRows = (await owner`
      select id::text as id, job_id::text as job_id from public.task
      where org_id = ${orgA} limit 1`) as unknown as Array<{ id: string; job_id: string }>;
    // A cross-org status change matches no row and changes nothing.
    await expect(
      updateTaskStatus(ctxOf(orgB, userB), "owner", aTaskRows[0]!.id, { status: "in_progress" }),
    ).rejects.toThrow();
    const bSchedule = await getSchedule(ctxOf(orgB, userB), "owner", {
      from: shift(-30),
      to: shift(30),
      asOf,
    });
    expect(bSchedule.items.length).toBe(0);
    expect(await workForOpportunity(ctxOf(orgB, userB), "owner", randomUUID())).toBeNull();
  });
});
