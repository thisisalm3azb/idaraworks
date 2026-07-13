/**
 * S2 integration (doc 11 DoD/AC): 13S from preset auto-skips Upholstery; stage
 * lifecycle incl. foreman request-complete + reopen-with-reason; reopen past a
 * billing point raises the placeholder exception event; the foreman sees ONLY
 * assigned jobs (all three F-6 legs); tasks/crew/pricing/override walls.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, sql, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import {
  addCrewMember,
  addPriceAdjustment,
  clearProgressOverride,
  completeStage,
  createJobFromPreset,
  createTask,
  getJob,
  listCrew,
  listJobs,
  listStages,
  removeCrewMember,
  reopenStage,
  requestStageCompletion,
  setProgressOverride,
  startStage,
  updateJobCore,
  updateJobPricing,
  updateJobStatus,
  updateTaskStatus,
} from "@/modules/jobs/service";
import { ForbiddenError } from "@/platform/authz";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
const foremanUser = randomUUID();
let orgId = "";
let presetIds: Record<string, string> = {};

const ctxOf = (userId: string, priv = true): Ctx => ({
  orgId,
  userId,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "s2-test",
});

async function seedAuthUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s2-${label}-${run}@example.com`}, '{"full_name":"S2 Test"}'::jsonb, now(), now())`;
}

beforeAll(async () => {
  await seedAuthUser(ownerUser, "owner");
  await seedAuthUser(foremanUser, "foreman");
  orgId = await createOrgForUser(ownerUser, { name: "S2 Org", country: "AE", baseCurrency: "AED" });
  await owner`insert into public.membership (user_id, org_id, role_key) values (${foremanUser}, ${orgId}, 'foreman')`;
  const installed = await installTemplate(ctxOf(ownerUser), TEMPLATE_BOATBUILDING.key);
  presetIds = installed.presetIds;
}, 240_000);

afterAll(async () => {
  for (const t of [
    "daily_report",
    "domain_event",
    "task",
    "job_crew",
    "job_stage",
    "job",
    "employee_terms",
    "employee_hr",
    "employee",
    "team",
    "item",
    "customer",
    "supplier",
    "job_preset",
    "reference_sequence",
    "org_holiday_calendar",
    "config_revision",
    "org_entitlement_override",
    "comment",
    "audit_log",
    "activity",
    "app_settings",
    "sign_in_log",
    "org_plan_state",
    "membership",
    "role_definition",
    "company",
  ]) {
    await owner.unsafe(`delete from public.${t} where org_id = $1`, [orgId]);
  }
  await owner`delete from public.org where id = ${orgId}`;
  await owner`delete from public.user_profile where id = any(${[ownerUser, foremanUser]}::uuid[])`;
  await owner`delete from auth.users where id = any(${[ownerUser, foremanUser]}::uuid[])`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

// The job.current_stage_id FK forces stage teardown AFTER clearing it — the
// FK-topological bleed teardown handles the general case; here job_stage is
// deleted before job, but job.current_stage_id references job_stage → clear it.
async function clearCurrentStages() {
  await owner`update public.job set current_stage_id = null where org_id = ${orgId}`;
}

describe("DoD: create from preset with skips + billing points", () => {
  it("13S auto-skips Upholstery; stages seeded as snapshots; current = mould_prep", async () => {
    const ctx = ctxOf(ownerUser);
    const { id, reference } = await createJobFromPreset(ctx, "owner", {
      presetId: presetIds["13S"]!,
      name: "Skiff DoD",
    });
    expect(reference).toBe("13S-001");
    const stages = await listStages(ctx, id);
    expect(stages).toHaveLength(11);
    const upholstery = stages.find((s) => s.stageKey === "upholstery")!;
    expect(upholstery.status).toBe("skipped");
    // Weight snapshots match the template; sort preserves template order.
    expect(stages.map((s) => s.weight).reduce((a, b) => a + b, 0)).toBe(100);

    const job = (await owner`
      select current_stage_id, billing_points from public.job where id = ${id}
    `) as unknown as Array<{
      current_stage_id: string;
      billing_points: Array<{ pct: number }>;
    }>;
    const current = stages.find((s) => s.id === job[0]!.current_stage_id)!;
    expect(current.stageKey).toBe("mould_prep");
    // Billing points seeded from the preset (60/40 — F-1).
    expect(job[0]!.billing_points.map((b) => b.pct)).toEqual([60, 40]);
  }, 60_000);
});

describe("stage lifecycle", () => {
  let jobId = "";
  let stageIds: Record<string, string> = {};

  beforeAll(async () => {
    const ctx = ctxOf(ownerUser);
    const created = await createJobFromPreset(ctx, "owner", {
      presetId: presetIds["24C"]!,
      name: "Lifecycle Boat",
      foremanUserId: foremanUser,
    });
    jobId = created.id;
    stageIds = Object.fromEntries((await listStages(ctx, jobId)).map((s) => [s.stageKey, s.id]));
  }, 60_000);

  it("start → in_progress and current stage tracks", async () => {
    const ctx = ctxOf(ownerUser);
    await startStage(ctx, "owner", stageIds.mould_prep!);
    const stages = await listStages(ctx, jobId);
    expect(stages.find((s) => s.stageKey === "mould_prep")!.status).toBe("in_progress");
  });

  it("foreman (assigned) may request completion, not complete", async () => {
    const fctx = ctxOf(foremanUser, false);
    await requestStageCompletion(fctx, "foreman", stageIds.mould_prep!);
    const stages = await listStages(fctx, jobId);
    expect(stages.find((s) => s.stageKey === "mould_prep")!.completionRequestedAt).toBeTruthy();
    await expect(completeStage(fctx, "foreman", stageIds.mould_prep!)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("manager+ completes; the event is emitted; current advances", async () => {
    const ctx = ctxOf(ownerUser);
    await completeStage(ctx, "owner", stageIds.mould_prep!);
    const stages = await listStages(ctx, jobId);
    expect(stages.find((s) => s.stageKey === "mould_prep")!.status).toBe("completed");
    const events = (await owner`
      select 1 as ok from public.domain_event
      where org_id = ${orgId} and name = 'job_stage/completed'
        and payload->>'stageKey' = 'mould_prep' and payload->>'jobId' = ${jobId}
    `) as unknown as Array<{ ok: number }>;
    expect(events).toHaveLength(1);
    const job = (await owner`
      select current_stage_id from public.job where id = ${jobId}
    `) as unknown as Array<{ current_stage_id: string }>;
    expect(job[0]!.current_stage_id).toBe(stageIds.lamination);
  });

  it("reopen requires a reason and emits job_stage/reopened", async () => {
    const ctx = ctxOf(ownerUser);
    await expect(reopenStage(ctx, "owner", stageIds.mould_prep!, { reason: "" })).rejects.toThrow();
    await reopenStage(ctx, "owner", stageIds.mould_prep!, { reason: "rework on the mould base" });
    const stages = await listStages(ctx, jobId);
    expect(stages.find((s) => s.stageKey === "mould_prep")!.status).toBe("in_progress");
    const events = (await owner`
      select payload->>'reason' as reason from public.domain_event
      where org_id = ${orgId} and name = 'job_stage/reopened' and payload->>'jobId' = ${jobId}
    `) as unknown as Array<{ reason: string }>;
    expect(events[0]!.reason).toBe("rework on the mould base");
  });

  it("DoD: reopening past a BILLING POINT raises the placeholder exception event", async () => {
    const ctx = ctxOf(ownerUser);
    // delivery is the 40% billing trigger (template F-1). Walk it to completed.
    await startStage(ctx, "owner", stageIds.delivery!);
    await completeStage(ctx, "owner", stageIds.delivery!);
    await reopenStage(ctx, "owner", stageIds.delivery!, { reason: "handover checklist failed" });
    const events = (await owner`
      select payload->>'kind' as kind from public.domain_event
      where org_id = ${orgId} and name = 'exception/raised' and payload->>'jobId' = ${jobId}
    `) as unknown as Array<{ kind: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("billing_point_reopened");
    // …and a NON-billing stage reopen raised none (only the delivery one).
  });
});

describe("F-6: the foreman sees only assigned jobs (all three legs)", () => {
  let assignedByCrew = "";
  let unassigned = "";

  beforeAll(async () => {
    const ctx = ctxOf(ownerUser);
    const a = await createJobFromPreset(ctx, "owner", {
      presetId: presetIds["18S"]!,
      name: "Crew Leg Boat",
    });
    assignedByCrew = a.id;
    const b = await createJobFromPreset(ctx, "owner", {
      presetId: presetIds["21P"]!,
      name: "Unassigned Boat",
    });
    unassigned = b.id;
    // Crew leg: employee LINKED to the foreman user, added to job A's crew.
    const { createEmployee } = await import("@/modules/masters/service");
    const { id: employeeId } = await createEmployee(ctx, "owner", {
      name: "Linked Foreman",
      userId: foremanUser,
    });
    await addCrewMember(ctx, "owner", assignedByCrew, employeeId);
  }, 90_000);

  it("list: foreman_user_id leg + crew leg visible; unassigned invisible", async () => {
    const rows = await listJobs(ctxOf(foremanUser, false), "foreman");
    const refs = rows.map((r) => r.name);
    expect(refs).toContain("Lifecycle Boat"); // foreman_user_id leg
    expect(refs).toContain("Crew Leg Boat"); // job_crew via employee.user_id leg
    expect(refs).not.toContain("Unassigned Boat");
  });

  it("detail: unassigned job resolves to null for the foreman", async () => {
    expect(await getJob(ctxOf(foremanUser, false), "foreman", unassigned)).toBeNull();
    expect(await getJob(ctxOf(foremanUser, false), "foreman", assignedByCrew)).not.toBeNull();
  });

  it("crew removal revokes the leg", async () => {
    const ctx = ctxOf(ownerUser);
    const crew = await listCrew(ctx, assignedByCrew);
    await removeCrewMember(ctx, "owner", assignedByCrew, crew[0]!.employeeId);
    expect(await getJob(ctxOf(foremanUser, false), "foreman", assignedByCrew)).toBeNull();
  });
});

describe("tasks + walls", () => {
  it("manager creates; foreman updates status on ASSIGNED job only; cancel needs manage", async () => {
    const ctx = ctxOf(ownerUser);
    const jobs = await listJobs(ctx, "owner");
    const assigned = jobs.find((j) => j.name === "Lifecycle Boat")!;
    const other = jobs.find((j) => j.name === "Unassigned Boat")!;
    const { id: t1 } = await createTask(ctx, "owner", { jobId: assigned.id, title: "Fit rails" });
    const { id: t2 } = await createTask(ctx, "owner", { jobId: other.id, title: "Order resin" });

    const fctx = ctxOf(foremanUser, false);
    await updateTaskStatus(fctx, "foreman", t1, { status: "in_progress" });
    await expect(updateTaskStatus(fctx, "foreman", t2, { status: "in_progress" })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(updateTaskStatus(fctx, "foreman", t1, { status: "cancelled" })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("pricing: manager blocked; adjustment is owner-only and appends", async () => {
    const ctx = ctxOf(ownerUser);
    const job = (await listJobs(ctx, "owner")).find((j) => j.name === "Lifecycle Boat")!;
    await expect(
      updateJobPricing(ctxOf(ownerUser), "manager", job.id, { sellingPriceMinor: 100 }),
    ).rejects.toThrow(ForbiddenError);
    await updateJobPricing(ctx, "owner", job.id, { sellingPriceMinor: 45000000 });
    await expect(
      addPriceAdjustment(ctx, "admin", job.id, { amountMinor: 1, reason: "x" }),
    ).rejects.toThrow(ForbiddenError);
    await addPriceAdjustment(ctx, "owner", job.id, {
      amountMinor: 2500000,
      reason: "Extended swim platform",
    });
    await addPriceAdjustment(ctx, "owner", job.id, {
      amountMinor: -500000,
      reason: "Dropped stereo upgrade",
    });
    const rows = (await owner`
      select price_adjustments from public.job where id = ${job.id}
    `) as unknown as Array<{ price_adjustments: Array<{ amount_minor: number }> }>;
    expect(rows[0]!.price_adjustments.map((a) => a.amount_minor)).toEqual([2500000, -500000]);
  });

  it("progress override sets with reason, audits, clears", async () => {
    const ctx = ctxOf(ownerUser);
    const job = (await listJobs(ctx, "owner")).find((j) => j.name === "Lifecycle Boat")!;
    await setProgressOverride(ctx, "owner", job.id, { percent: 42, reason: "sea-trial holdback" });
    let row = (await listJobs(ctx, "owner")).find((j) => j.id === job.id)!;
    expect(row.progress).toBe(42);
    expect(row.progressOverridden).toBe(true);
    await clearProgressOverride(ctx, "owner", job.id);
    row = (await listJobs(ctx, "owner")).find((j) => j.id === job.id)!;
    expect(row.progressOverridden).toBe(false);
    const audits = (await owner`
      select 1 as ok from public.audit_log
      where org_id = ${orgId} and action = 'job.progress_override' and entity_id = ${job.id}
    `) as unknown as Array<{ ok: number }>;
    expect(audits).toHaveLength(1);
  });

  it("custom fields: template keys round-trip; unknown keys rejected", async () => {
    const ctx = ctxOf(ownerUser);
    const { id } = await createJobFromPreset(ctx, "owner", {
      presetId: presetIds["27P"]!,
      name: "Fields Boat",
      customValues: { engine_package: "Twin Yamaha 300" },
    });
    await updateJobCore(ctx, "owner", id, {
      name: "Fields Boat",
      customValues: { colour_scheme: "Navy over white" },
    });
    const rows = (await owner`
      select custom_values from public.job where id = ${id}
    `) as unknown as Array<{ custom_values: Record<string, unknown> }>;
    expect(rows[0]!.custom_values).toEqual({
      engine_package: "Twin Yamaha 300",
      colour_scheme: "Navy over white",
    });
    await expect(
      updateJobCore(ctx, "owner", id, { name: "Fields Boat", customValues: { bogus: "x" } }),
    ).rejects.toThrow(/unknown field/);
  }, 60_000);

  it("status change maintains the semantic anchor", async () => {
    const ctx = ctxOf(ownerUser);
    const job = (await listJobs(ctx, "owner")).find((j) => j.name === "Fields Boat")!;
    await updateJobStatus(ctx, "owner", job.id, "in_production");
    const rows = (await owner`
      select status_key, status_category from public.job where id = ${job.id}
    `) as unknown as Array<{ status_key: string; status_category: string }>;
    expect(rows[0]).toEqual({ status_key: "in_production", status_category: "active" });
    await expect(updateJobStatus(ctx, "owner", job.id, "no_such_status")).rejects.toThrow(
      /unknown status/,
    );
    await clearCurrentStages(); // teardown aid (job_stage FK)
  });
});
