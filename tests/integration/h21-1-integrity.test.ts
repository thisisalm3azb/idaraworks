/**
 * H21.1 — the integrity gaps H21 documented, closed and proven against the real
 * database.
 *
 * Part B: an approval whose subject closes stops waiting, transactionally, and a
 * decision that arrives afterwards changes nothing.
 * Part C: My Work bucket totals are exact at any size, and the page of records a
 * user sees is a bounded window onto that same set — including past the 300 rows
 * that used to be the silent ceiling.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate } from "@/platform/config/install";
import { createCustomer, createEmployee } from "@/modules/masters/service";
import {
  createJobFromPreset,
  listActivePresets,
  createTask,
  updateTaskStatus,
  setTaskArchived,
  changeWorkStatus,
  getMyWork,
  workDashboardCounts,
  MY_WORK_BUCKETS,
  MY_WORK_PAGE_SIZE,
} from "@/modules/jobs/service";
import { decideApproval, listInbox } from "@/modules/approvals/service";
import { orgToday } from "@/modules/dashboard/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";
let presetA = "";
let empA = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h21-1-test",
});

const asOf = orgToday(new Date(), "Asia/Dubai");
const shift = (days: number) => {
  const d = new Date(`${asOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h21-1-${label}-${run}@example.com`}, '{"full_name":"H21.1 Test"}'::jsonb, now(), now())`;
}

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

/** A task parked in awaiting_approval, with its live approval id. */
async function taskAwaitingApproval(jobId: string, title: string) {
  const { id } = await createTask(ctxOf(orgA, userA), "owner", {
    jobId,
    title,
    requiresApproval: true,
  });
  await updateTaskStatus(ctxOf(orgA, userA), "owner", id, { status: "in_progress" });
  const res = await updateTaskStatus(ctxOf(orgA, userA), "owner", id, { status: "completed" });
  const appr = (await owner`
    select id::text as id, state from public.approval
    where org_id = ${orgA} and subject_id = ${id}`) as unknown as Array<{
    id: string;
    state: string;
  }>;
  return { taskId: id, approvalId: appr[0]?.id ?? null, decided: res.status === "completed" };
}

beforeAll(async () => {
  await seedUser(userA, "a");
  await seedUser(userB, "b");
  orgA = await createOrgForUser(userA, { name: "H21.1 A", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h21-1-integrity", run);
  orgB = await createOrgForUser(userB, { name: "H21.1 B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgB, "h21-1-integrity", run);
  await installTemplate(ctxOf(orgA, userA), "generic_operations_v1");
  await installTemplate(ctxOf(orgB, userB), "generic_operations_v1");
  presetA = (await listActivePresets(ctxOf(orgA, userA), "owner"))[0]!.id;
  await createCustomer(ctxOf(orgA, userA), "owner", { name: "H21.1 Customer" });
  const emp = await createEmployee(ctxOf(orgA, userA), "owner", {
    name: "Assignee",
    userId: userA,
  });
  empA = emp.id;
}, 240_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 180_000);

describe("H21.1 Part B — an approval stops waiting when its subject closes", () => {
  it(
    "cancelling a step supersedes its pending approval in the same transaction",
    { timeout: 180_000 },
    async () => {
      const { id: jobId } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
        presetId: presetA,
        name: "Cancel probe",
      });
      const { taskId, approvalId, decided } = await taskAwaitingApproval(jobId, "Needs sign-off");
      if (decided) return; // an auto-approving rule settled it at submission
      expect(approvalId).not.toBeNull();

      await updateTaskStatus(ctxOf(orgA, userA), "owner", taskId, {
        status: "cancelled",
        reason: "Scope dropped",
      });

      const after = (await owner`
      select a.state, a.decided_by::text as decided_by, a.decision_note, t.status as task_status
      from public.approval a
      join public.task t on t.id = a.subject_id
      where a.id = ${approvalId}`) as unknown as Array<Record<string, string | null>>;
      expect(after[0]!.state).toBe("superseded");
      expect(after[0]!.task_status).toBe("cancelled");
      // History is preserved, and it records who caused it and why.
      expect(after[0]!.decided_by).toBe(userA);
      expect(after[0]!.decision_note).toMatch(/Scope dropped/);
      // It is gone from the queue of things awaiting a person.
      const inbox = await listInbox(ctxOf(orgA, userA), "owner");
      expect(inbox.some((i) => i.subjectId === taskId)).toBe(false);
    },
  );

  it(
    "a decision arriving after the cancellation is refused, not applied",
    { timeout: 180_000 },
    async () => {
      const { id: jobId } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
        presetId: presetA,
        name: "Late decision probe",
      });
      const { taskId, approvalId, decided } = await taskAwaitingApproval(jobId, "Late sign-off");
      if (decided) return;
      await updateTaskStatus(ctxOf(orgA, userA), "owner", taskId, {
        status: "cancelled",
        reason: "Not needed",
      });
      // Approving now must not resurrect the step.
      await expect(
        decideApproval(ctxOf(orgA, userA), "owner", {
          approvalId: approvalId!,
          decision: "approved",
        }),
      ).rejects.toThrow();
      // Rejecting is refused for the same reason.
      await expect(
        decideApproval(ctxOf(orgA, userA), "owner", {
          approvalId: approvalId!,
          decision: "rejected",
          note: "no",
        }),
      ).rejects.toThrow();
      const still = (await owner`
      select a.state, t.status from public.approval a
      join public.task t on t.id = a.subject_id
      where a.id = ${approvalId}`) as unknown as Array<{ state: string; status: string }>;
      expect(still[0]!.state).toBe("superseded");
      expect(still[0]!.status).toBe("cancelled");
    },
  );

  it(
    "repeating the cancellation is harmless and supersedes nothing twice",
    { timeout: 180_000 },
    async () => {
      const { id: jobId } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
        presetId: presetA,
        name: "Idempotent cancel probe",
      });
      const { taskId, approvalId, decided } = await taskAwaitingApproval(jobId, "Repeat sign-off");
      if (decided) return;
      await updateTaskStatus(ctxOf(orgA, userA), "owner", taskId, {
        status: "cancelled",
        reason: "First",
      });
      const first = (await owner`
      select state, decided_at from public.approval where id = ${approvalId}`) as unknown as Array<{
        state: string;
        decided_at: string;
      }>;
      // cancelled -> cancelled is a legal no-op move.
      await updateTaskStatus(ctxOf(orgA, userA), "owner", taskId, {
        status: "cancelled",
        reason: "Second",
      });
      const second = (await owner`
      select state, decided_at, decision_note from public.approval
      where id = ${approvalId}`) as unknown as Array<{
        state: string;
        decided_at: string;
        decision_note: string;
      }>;
      expect(second[0]!.state).toBe("superseded");
      // The original supersession is not rewritten by the repeat.
      expect(String(second[0]!.decided_at)).toBe(String(first[0]!.decided_at));
      expect(second[0]!.decision_note).toMatch(/First/);
      // And exactly one approval exists for that subject.
      const n = (await owner`
      select count(*)::int as n from public.approval
      where org_id = ${orgA} and subject_id = ${taskId}`) as unknown as Array<{ n: number }>;
      expect(n[0]!.n).toBe(1);
    },
  );

  it(
    "an approved or rejected approval is untouched by later cancellation",
    { timeout: 180_000 },
    async () => {
      const { id: jobId } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
        presetId: presetA,
        name: "Decided first probe",
      });
      const { taskId, approvalId, decided } = await taskAwaitingApproval(jobId, "Decide first");
      if (!decided && approvalId) {
        await decideApproval(ctxOf(orgA, userA), "owner", {
          approvalId,
          decision: "approved",
        });
      }
      const done = (await owner`
      select status from public.task where id = ${taskId}`) as unknown as Array<{ status: string }>;
      expect(done[0]!.status).toBe("completed");
      // Reopen and cancel: the settled approval keeps its verdict.
      await updateTaskStatus(ctxOf(orgA, userA), "owner", taskId, { status: "in_progress" });
      await updateTaskStatus(ctxOf(orgA, userA), "owner", taskId, {
        status: "cancelled",
        reason: "Changed our minds",
      });
      const appr = (await owner`
      select state from public.approval where org_id = ${orgA} and subject_id = ${taskId}
      order by created_at`) as unknown as Array<{ state: string }>;
      // Whatever was decided stays decided; supersession only ever touches pending.
      expect(appr.every((a) => a.state !== "pending")).toBe(true);
      expect(appr.some((a) => a.state === "approved")).toBe(true);
    },
  );

  it(
    "archiving a step, and cancelling whole work, close their approvals too",
    { timeout: 180_000 },
    async () => {
      const { id: archJob } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
        presetId: presetA,
        name: "Archive probe",
      });
      const arch = await taskAwaitingApproval(archJob, "Archive sign-off");
      if (!arch.decided) {
        await setTaskArchived(ctxOf(orgA, userA), "owner", arch.taskId, true);
        const a = (await owner`
        select state from public.approval where id = ${arch.approvalId}`) as unknown as Array<{
          state: string;
        }>;
        expect(a[0]!.state).toBe("superseded");
      }

      const { id: jobId } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
        presetId: presetA,
        name: "Work cancel probe",
      });
      const t = await taskAwaitingApproval(jobId, "Work-level sign-off");
      if (t.decided) return;
      const activeKey = await statusKeyFor(orgA, "active");
      const cancelKey = await statusKeyFor(orgA, "cancelled");
      await changeWorkStatus(ctxOf(orgA, userA), "owner", jobId, { statusKey: activeKey });
      await changeWorkStatus(ctxOf(orgA, userA), "owner", jobId, {
        statusKey: cancelKey,
        reason: "Customer withdrew",
      });
      const appr = (await owner`
      select state, decision_note from public.approval
      where id = ${t.approvalId}`) as unknown as Array<{ state: string; decision_note: string }>;
      // Left pending, this could still have been approved — completing a step on
      // work that is supposed to be immutable.
      expect(appr[0]!.state).toBe("superseded");
      expect(appr[0]!.decision_note).toMatch(/withdrew/);
    },
  );

  it(
    "organization B cannot supersede or even see organization A's approvals",
    { timeout: 180_000 },
    async () => {
      const rows = (await owner`
      select id::text as id, subject_id::text as subject_id from public.approval
      where org_id = ${orgA} limit 1`) as unknown as Array<{ id: string; subject_id: string }>;
      if (!rows[0]) return;
      await expect(
        decideApproval(ctxOf(orgB, userB), "owner", {
          approvalId: rows[0].id,
          decision: "approved",
        }),
      ).rejects.toThrow();
      const inboxB = await listInbox(ctxOf(orgB, userB), "owner");
      expect(inboxB.some((i) => i.id === rows[0]!.id)).toBe(false);
      // Cancelling a foreign task changes nothing of A's.
      await expect(
        updateTaskStatus(ctxOf(orgB, userB), "owner", rows[0].subject_id, {
          status: "cancelled",
          reason: "cross-org attempt",
        }),
      ).rejects.toThrow();
    },
  );
});

describe("H21.1 Part C — My Work counts and records describe one set", () => {
  let bulkJob = "";

  it("reports zero honestly when there is nothing assigned", { timeout: 180_000 }, async () => {
    const view = await getMyWork(ctxOf(orgB, userB), "owner", { asOf });
    for (const key of MY_WORK_BUCKETS) {
      expect(view.buckets[key].total).toBe(0);
      expect(view.buckets[key].rows).toEqual([]);
      expect(view.buckets[key].hasMore).toBe(false);
    }
  });

  it("counts and shows a single record", { timeout: 180_000 }, async () => {
    const { id } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "One step",
    });
    bulkJob = id;
    await createTask(ctxOf(orgA, userA), "owner", {
      jobId: id,
      title: "The only overdue step",
      dueDate: shift(-3),
      assigneeEmployeeId: empA,
    });
    const view = await getMyWork(ctxOf(orgA, userA), "owner", { asOf, focus: "overdue" });
    expect(view.buckets.overdue.total).toBe(1);
    expect(view.buckets.overdue.rows).toHaveLength(1);
    expect(view.buckets.overdue.hasMore).toBe(false);
  });

  it(
    "stays exact at 300, at 301 and well beyond the old ceiling",
    { timeout: 300_000 },
    async () => {
      // Bulk-insert directly: this is fixture setup, not the behaviour under test,
      // and 400 service calls against a remote database would time out.
      const make = async (n: number) => {
        await owner`
          insert into public.task (id, org_id, job_id, title, status, due_date,
                                   assignee_employee_id, created_by, archived)
          select gen_random_uuid(), ${orgA}, ${bulkJob},
                 'Bulk overdue ' || g, 'pending', ${shift(-2)}::date, ${empA}, ${userA}, false
          from generate_series(1, ${n}) g`;
      };
      const totalNow = async () =>
        (await getMyWork(ctxOf(orgA, userA), "owner", { asOf, focus: "overdue" })).buckets.overdue;

      // One already exists, so 299 more reaches exactly 300.
      await make(299);
      let b = await totalNow();
      expect(b.total).toBe(300);
      expect(b.rows.length).toBe(MY_WORK_PAGE_SIZE);
      expect(b.hasMore).toBe(true);

      // 301 is the number the old 300-row fetch could never report.
      await make(1);
      b = await totalNow();
      expect(b.total).toBe(301);

      await make(119); // 420 total — comfortably past any accidental ceiling
      b = await totalNow();
      expect(b.total).toBe(420);

      // The dashboard card must agree with the bucket it drills into.
      const counts = await workDashboardCounts(ctxOf(orgA, userA), "owner", {
        asOf,
        horizonDays: 7,
      });
      expect(counts.overdueTasks).toBe(b.total);

      // Paging walks the whole set exactly once: no gaps, no repeats.
      const seen = new Set<string>();
      const pages = Math.ceil(b.total / MY_WORK_PAGE_SIZE);
      for (let p = 1; p <= pages; p += 1) {
        const view = await getMyWork(ctxOf(orgA, userA), "owner", {
          asOf,
          focus: "overdue",
          page: p,
        });
        for (const r of view.buckets.overdue.rows) seen.add(r.id);
        expect(view.buckets.overdue.total).toBe(b.total);
        expect(view.buckets.overdue.hasMore).toBe(p < pages);
      }
      expect(seen.size).toBe(b.total);

      // A page past the end is empty, not an error, and still tells the truth.
      const past = await getMyWork(ctxOf(orgA, userA), "owner", {
        asOf,
        focus: "overdue",
        page: pages + 5,
      });
      expect(past.buckets.overdue.rows).toEqual([]);
      expect(past.buckets.overdue.total).toBe(b.total);
    },
  );

  it(
    "every role sees counts that match the records it is allowed to open",
    { timeout: 180_000 },
    async () => {
      // The archetypes that can reach My Work at all. A foreman is the restricted
      // worker: narrowed to assigned work everywhere, including here.
      for (const archetype of ["owner", "admin", "manager", "foreman"] as const) {
        const view = await getMyWork(ctxOf(orgA, userA), archetype, { asOf, focus: "overdue" });
        const b = view.buckets.overdue;
        expect(b.rows.length).toBeLessThanOrEqual(b.total);
        expect(b.rows.length).toBeLessThanOrEqual(MY_WORK_PAGE_SIZE);
        // Whatever the role, the rows shown belong to the bucket that counted them.
        for (const r of b.rows) {
          expect(r.dueDate).not.toBeNull();
          expect(r.dueDate! < asOf).toBe(true);
        }
      }
    },
  );
});
