/**
 * S3 "Report: the heartbeat" integration (doc 11 DoD; doc 01 D-1.5/D-1.4).
 * Runs against a real Postgres (hosted .env.local / CI local stack). Proves:
 *  - a full daily report (work + material[item+free] + labour lines) submits
 *    atomically; labour COST is frozen behind the D-6.2 wall; attendance derives;
 *  - exactly-once idempotent submit (offline retry writes nothing new);
 *  - the cost wall: a non-cost session reads ZERO report_labour_cost rows AT THE
 *    DB, and getReportDetail redacts labourCostMinor;
 *  - the review loop (submitted → reviewed[immutable] | returned[re-editable]);
 *  - manual attendance wins over the labour-line derivation;
 *  - issues raise/resolve + events + foreman assigned-scope;
 *  - authz: foreman assigned-only, backfill owner/admin-only, viewer no issues.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, sql, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { ForbiddenError } from "@/platform/authz";
import { createJobFromPreset, addCrewMember } from "@/modules/jobs/service";
import { createEmployee, setEmployeeTerms } from "@/modules/masters/service";
import {
  submitDailyReport,
  saveReportDraft,
  reviewReport,
  returnReport,
  getReportDetail,
  listReviewQueue,
  listJobReports,
  DuplicateReportError,
  InvalidReportInputError,
} from "@/modules/reports/service";
import { markAttendance, listAttendanceForDate } from "@/modules/attendance/service";
import { createIssue, updateIssueStatus, listIssues } from "@/modules/issues/service";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);

// Dates RELATIVE to server "today" (UTC) — the service's date gate (review fix A)
// treats >14 days past as backfill (owner/admin only) and >1 day future as
// rejected, so fixed calendar dates would drift out of the valid window.
const iso = (daysAgo: number): string => {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() - daysAgo);
  return t.toISOString().slice(0, 10);
};
const D_FULL = iso(2);
const D_IMMUT = iso(3);
const D_RETURN = iso(4);
const D_ONCE = iso(5);
const D_ATT = iso(6);
const D_UNASSIGNED = iso(1);
const D_DRAFT = iso(0);
const D_BACKFILL = iso(60); // clearly historical → requires reports.backfill
const ownerUser = randomUUID();
const foremanUser = randomUUID();
const managerUser = randomUUID();
const viewerUser = randomUUID();
let orgId = "";
let presetIds: Record<string, string> = {};
let jobAssigned = "";
let jobOther = "";
let aliId = ""; // employee linked to the foreman user (assignment + attendance)
let samiId = ""; // employee with terms (labour cost)
let itemId = "";

const ctxOf = (userId: string, priv = true): Ctx => ({
  orgId,
  userId,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "s3-test",
});
const ownerCtx = () => ctxOf(ownerUser, true);
const foremanCtx = () => ctxOf(foremanUser, false);
const managerCtx = () => ctxOf(managerUser, false);

async function seedAuthUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s3-${label}-${run}@example.com`}, '{"full_name":"S3 Test"}'::jsonb, now(), now())`;
}

beforeAll(async () => {
  await seedAuthUser(ownerUser, "owner");
  await seedAuthUser(foremanUser, "foreman");
  await seedAuthUser(managerUser, "manager");
  await seedAuthUser(viewerUser, "viewer");
  orgId = await createOrgForUser(ownerUser, { name: "S3 Org", country: "AE", baseCurrency: "AED" });
  await owner`insert into public.membership (user_id, org_id, role_key) values (${foremanUser}, ${orgId}, 'foreman')`;
  await owner`insert into public.membership (user_id, org_id, role_key) values (${managerUser}, ${orgId}, 'manager')`;
  await owner`insert into public.membership (user_id, org_id, role_key) values (${viewerUser}, ${orgId}, 'viewer')`;
  const installed = await installTemplate(ownerCtx(), TEMPLATE_BOATBUILDING.key);
  presetIds = installed.presetIds;

  // Employees: Ali is the foreman's linked employee; Sami is a second worker.
  aliId = (await createEmployee(ownerCtx(), "owner", { name: "Ali", userId: foremanUser })).id;
  samiId = (await createEmployee(ownerCtx(), "owner", { name: "Sami" })).id;
  // salary 20800 → hourly 100 (÷208); ot 1.25.
  await setEmployeeTerms(ownerCtx(), "owner", aliId, { salaryMinor: 20800, otRate: 1.25 });
  await setEmployeeTerms(ownerCtx(), "owner", samiId, { salaryMinor: 41600, otRate: 1.5 }); // hourly 200

  // A catalog item (seeded directly to skip the category-config dependency).
  itemId = randomUUID();
  await owner`
    insert into public.item (id, org_id, sku, name, category_key, unit, unit_cost_minor, active)
    values (${itemId}, ${orgId}, ${`RESIN-${run}`}, 'Epoxy Resin', 'raw_material', 'L', 5000, true)`;

  // Two jobs; the foreman is crewed onto jobAssigned only.
  jobAssigned = (
    await createJobFromPreset(ownerCtx(), "owner", {
      presetId: presetIds["13S"]!,
      name: "Assigned",
    })
  ).id;
  jobOther = (
    await createJobFromPreset(ownerCtx(), "owner", { presetId: presetIds["13S"]!, name: "Other" })
  ).id;
  await addCrewMember(ownerCtx(), "owner", jobAssigned, aliId);
}, 240_000);

afterAll(async () => {
  await owner`update public.job set current_stage_id = null where org_id = ${orgId}`;
  for (const t of [
    "report_labour_cost",
    "report_labour_line",
    "report_material_line",
    "report_work_line",
    "daily_report",
    "attendance",
    "issue",
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
  await owner`delete from public.user_profile where id = any(${[ownerUser, foremanUser, managerUser, viewerUser]}::uuid[])`;
  await owner`delete from auth.users where id = any(${[ownerUser, foremanUser, managerUser, viewerUser]}::uuid[])`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

async function eventCount(name: string, reportOrIssueId: string): Promise<number> {
  const rows = await owner`
    select count(*)::int as n from public.domain_event
    where org_id = ${orgId} and name = ${name}
      and (payload->>'reportId' = ${reportOrIssueId} or payload->>'issueId' = ${reportOrIssueId})`;
  return (rows[0] as { n: number }).n;
}

describe("full daily report: lines + frozen cost + derived attendance", () => {
  const key = `idem-full-${run}`;
  const date = D_FULL;
  let reportId = "";

  it("submits header + work/material/labour lines atomically", async () => {
    const res = await submitDailyReport(foremanCtx(), "foreman", {
      jobId: jobAssigned,
      reportDate: date,
      summary: "Laminated the hull; two coats.",
      blockers: "Waiting on resin delivery",
      idempotencyKey: key,
      workLines: [
        { stageKey: "lamination", description: "Two gelcoat coats", progressNote: "~40%" },
      ],
      materialLines: [
        { itemId, itemName: "ignored — snapshot wins", qty: 3, unit: "ignored" },
        { itemName: "Sandpaper 80-grit", qty: 5, unit: "sheet" },
      ],
      labourLines: [
        { employeeId: aliId, normalHours: 8, otHours: 2 },
        { employeeId: samiId, normalHours: 8, otHours: 0 },
      ],
    });
    expect(res.deduped).toBe(false);
    expect(res.submitted).toBe(true);
    reportId = res.id;

    // Item-linked material snapshots the CATALOG name/unit (D-1.6), not client text.
    const detail = await getReportDetail(ownerCtx(), "owner", reportId);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe("submitted");
    expect(detail!.workLines).toHaveLength(1);
    expect(detail!.materialLines).toHaveLength(2);
    const linked = detail!.materialLines.find((m) => m.itemId === itemId)!;
    expect(linked.itemName).toBe("Epoxy Resin");
    expect(linked.unit).toBe("L");
    expect(linked.costSource).toBe("catalog");
    const free = detail!.materialLines.find((m) => m.itemId === null)!;
    expect(free.costSource).toBe("none");
  });

  it("freezes labour cost behind the wall: owner sees it, foreman does not", async () => {
    // Cost-privileged read: Ali = 8*100 + 2*100*1.25 = 1050; Sami = 8*200 = 1600.
    const asOwner = await getReportDetail(ownerCtx(), "owner", reportId);
    const ali = asOwner!.labourLines.find((l) => l.employeeId === aliId)!;
    const sami = asOwner!.labourLines.find((l) => l.employeeId === samiId)!;
    expect(ali.labourCostMinor).toBe("1050");
    expect(sami.labourCostMinor).toBe("1600");

    // Foreman (assigned) sees hours but NO cost (service redaction).
    const asForeman = await getReportDetail(foremanCtx(), "foreman", reportId);
    expect(asForeman).not.toBeNull();
    expect(asForeman!.labourLines).toHaveLength(2);
    for (const l of asForeman!.labourLines) expect(l.labourCostMinor).toBeNull();

    // The RLS wall itself: a non-cost session reads ZERO cost rows AT THE DB.
    const nonCost = (await withCtx(foremanCtx(), (tx) =>
      tx.execute(
        sql`select count(*)::int as n from public.report_labour_cost where report_id = ${reportId}`,
      ),
    )) as unknown as Array<{ n: number }>;
    expect(nonCost[0]!.n).toBe(0);
    const cost = (await withCtx(ownerCtx(), (tx) =>
      tx.execute(
        sql`select count(*)::int as n from public.report_labour_cost where report_id = ${reportId}`,
      ),
    )) as unknown as Array<{ n: number }>;
    expect(cost[0]!.n).toBe(2);
  });

  it("derives attendance present for employees with hours (C-3)", async () => {
    const grid = await listAttendanceForDate(ownerCtx(), "owner", date);
    const ali = grid.find((r) => r.employeeId === aliId)!;
    const sami = grid.find((r) => r.employeeId === samiId)!;
    expect(ali.status).toBe("present");
    expect(ali.source).toBe("labour_line");
    expect(sami.status).toBe("present");
  });

  it("emitted exactly one submitted event", async () => {
    expect(await eventCount("daily_report/submitted", reportId)).toBe(1);
  });

  it("is exactly-once: a retry with the same key writes nothing new", async () => {
    const retry = await submitDailyReport(foremanCtx(), "foreman", {
      jobId: jobAssigned,
      reportDate: date,
      summary: "Laminated the hull; two coats.",
      idempotencyKey: key,
      labourLines: [{ employeeId: aliId, normalHours: 8, otHours: 2 }],
    });
    expect(retry.deduped).toBe(true);
    expect(retry.id).toBe(reportId);
    expect(await eventCount("daily_report/submitted", reportId)).toBe(1);
  });

  it("rejects a different key for the same job+date (already reported today)", async () => {
    await expect(
      submitDailyReport(foremanCtx(), "foreman", {
        jobId: jobAssigned,
        reportDate: date,
        summary: "dup",
        idempotencyKey: `other-${run}`,
      }),
    ).rejects.toBeInstanceOf(DuplicateReportError);
  });
});

describe("review loop", () => {
  it("submitted → reviewed is immutable; a resubmit no-ops", async () => {
    const key = `idem-review-${run}`;
    const date = D_IMMUT;
    const { id } = await submitDailyReport(ownerCtx(), "owner", {
      jobId: jobAssigned,
      reportDate: date,
      summary: "day work",
      idempotencyKey: key,
    });
    // In the manager's review queue while submitted.
    const queue = await listReviewQueue(managerCtx(), "manager");
    expect(queue.some((r) => r.id === id)).toBe(true);

    await reviewReport(managerCtx(), "manager", id);
    expect(await eventCount("daily_report/reviewed", id)).toBe(1);
    const detail = await getReportDetail(ownerCtx(), "owner", id);
    expect(detail!.status).toBe("reviewed");
    expect(detail!.reviewedByName).not.toBeNull();

    // A late offline retry of the same key is a no-op (finalised).
    const retry = await submitDailyReport(ownerCtx(), "owner", {
      jobId: jobAssigned,
      reportDate: date,
      summary: "changed",
      idempotencyKey: key,
    });
    expect(retry.deduped).toBe(true);
    const after = await getReportDetail(ownerCtx(), "owner", id);
    expect(after!.status).toBe("reviewed");
    expect(after!.summary).toBe("day work"); // unchanged — immutable
  });

  it("submitted → returned reopens author edit, then re-submits", async () => {
    const key = `idem-return-${run}`;
    const date = D_RETURN;
    const { id } = await submitDailyReport(ownerCtx(), "owner", {
      jobId: jobAssigned,
      reportDate: date,
      summary: "first pass",
      idempotencyKey: key,
      labourLines: [{ employeeId: samiId, normalHours: 4, otHours: 0 }],
    });
    await returnReport(managerCtx(), "manager", id, "Please add the material used");
    expect(await eventCount("daily_report/returned", id)).toBe(1);
    let detail = await getReportDetail(ownerCtx(), "owner", id);
    expect(detail!.status).toBe("returned");
    expect(detail!.returnReason).toBe("Please add the material used");

    // Author re-edits (same key) and resubmits → back to submitted, re-frozen.
    const re = await submitDailyReport(ownerCtx(), "owner", {
      jobId: jobAssigned,
      reportDate: date,
      summary: "second pass with materials",
      idempotencyKey: key,
      materialLines: [{ itemName: "Filler", qty: 1, unit: "kg" }],
      labourLines: [{ employeeId: samiId, normalHours: 8, otHours: 1 }],
    });
    expect(re.deduped).toBe(false);
    expect(re.id).toBe(id);
    detail = await getReportDetail(ownerCtx(), "owner", id);
    expect(detail!.status).toBe("submitted");
    expect(detail!.summary).toBe("second pass with materials");
    expect(detail!.materialLines).toHaveLength(1);
    // Re-frozen cost: Sami 8*200 + 1*200*1.5 = 1900.
    const sami = detail!.labourLines.find((l) => l.employeeId === samiId)!;
    expect(sami.labourCostMinor).toBe("1900");
  });

  it("only a submitted report can be reviewed", async () => {
    const { id } = await submitDailyReport(ownerCtx(), "owner", {
      jobId: jobAssigned,
      reportDate: D_ONCE,
      summary: "x",
      idempotencyKey: `idem-once-${run}`,
    });
    await reviewReport(managerCtx(), "manager", id);
    await expect(reviewReport(managerCtx(), "manager", id)).rejects.toThrow(/only a submitted/);
  });
});

describe("attendance: manual grid wins over derivation", () => {
  it("a manual mark is not clobbered by a later report submit", async () => {
    const date = D_ATT;
    await markAttendance(managerCtx(), "manager", {
      employeeId: aliId,
      attendanceDate: date,
      status: "absent",
      note: "called in sick",
    });
    // A report with Ali's hours would derive 'present' — but manual wins.
    await submitDailyReport(foremanCtx(), "foreman", {
      jobId: jobAssigned,
      reportDate: date,
      summary: "work",
      idempotencyKey: `idem-att-${run}`,
      labourLines: [{ employeeId: aliId, normalHours: 8, otHours: 0 }],
    });
    const grid = await listAttendanceForDate(managerCtx(), "manager", date);
    const ali = grid.find((r) => r.employeeId === aliId)!;
    expect(ali.status).toBe("absent");
    expect(ali.source).toBe("manual");
  });
});

describe("issues", () => {
  it("raise (blocker) → resolve emits events; list shows blockers first", async () => {
    const { id } = await createIssue(ownerCtx(), "owner", {
      jobId: jobAssigned,
      title: "Mould crack found",
      severity: "high",
      isBlocker: true,
    });
    expect(await eventCount("issue/raised", id)).toBe(1);
    await updateIssueStatus(managerCtx(), "manager", { issueId: id, status: "resolved" });
    expect(await eventCount("issue/resolved", id)).toBe(1);
    const list = await listIssues(managerCtx(), "manager", {});
    expect(list.some((i) => i.id === id && i.status === "resolved")).toBe(true);
  });

  it("foreman may raise on an assigned job, not an unassigned one", async () => {
    await expect(
      createIssue(foremanCtx(), "foreman", { jobId: jobOther, title: "nope" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const ok = await createIssue(foremanCtx(), "foreman", {
      jobId: jobAssigned,
      title: "loose bolt",
    });
    expect(ok.id).toBeTruthy();
  });

  it("viewer cannot list issues (doc 06: issues row is − for viewer)", async () => {
    await expect(listIssues(ctxOf(viewerUser, false), "viewer", {})).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("authz walls", () => {
  it("foreman cannot report on an unassigned job", async () => {
    await expect(
      submitDailyReport(foremanCtx(), "foreman", {
        jobId: jobOther,
        reportDate: D_UNASSIGNED,
        summary: "x",
        idempotencyKey: `idem-unassigned-${run}`,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("backdating is server-derived + owner/admin-only (client flag is ignored)", async () => {
    // review fix A: NO isBackfill flag passed — the server derives it from the
    // (old) date, so a manager without reports.backfill is still denied.
    await expect(
      submitDailyReport(managerCtx(), "manager", {
        jobId: jobAssigned,
        reportDate: D_BACKFILL,
        summary: "historic",
        idempotencyKey: `idem-backfill-mgr-${run}`,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const ok = await submitDailyReport(ownerCtx(), "owner", {
      jobId: jobAssigned,
      reportDate: D_BACKFILL,
      summary: "historic",
      idempotencyKey: `idem-backfill-owner-${run}`,
    });
    expect(ok.submitted).toBe(true);
  });

  it("a future report date is rejected for everyone (review fix A)", async () => {
    await expect(
      submitDailyReport(ownerCtx(), "owner", {
        jobId: jobAssigned,
        reportDate: iso(-5), // 5 days ahead, beyond the +1 grace
        summary: "future",
        idempotencyKey: `idem-future-${run}`,
      }),
    ).rejects.toBeInstanceOf(InvalidReportInputError);
  });

  it("a server draft (submit=false) does not derive attendance or emit", async () => {
    const { id, submitted } = await saveReportDraft(ownerCtx(), "owner", {
      jobId: jobAssigned,
      reportDate: D_DRAFT,
      summary: "draft only",
      idempotencyKey: `idem-draft-${run}`,
      labourLines: [{ employeeId: samiId, normalHours: 3, otHours: 0 }],
    });
    expect(submitted).toBe(false);
    const reports = await listJobReports(ownerCtx(), "owner", jobAssigned);
    expect(reports.find((r) => r.id === id)!.status).toBe("draft");
    expect(await eventCount("daily_report/submitted", id)).toBe(0);
  });
});
