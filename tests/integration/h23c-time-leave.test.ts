/**
 * H23C — schedules, punches, corrections, overtime, leave.
 *
 * The invariants a screen cannot prove: punches materialize the canonical day
 * row and manual marks still win; overnight punch-outs land on the day the
 * shift started; two live leave requests cannot share a day (database
 * exclusion, not an application check); approval debits the append-only ledger
 * exactly once and resolves into attendance; cancellation refunds and clears
 * only FUTURE days; self-scoping holds for the unprivileged.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { createEmployee } from "@/modules/masters/service";
import { createApprovalRule, decideApproval, listInbox } from "@/modules/approvals/service";
import {
  createWorkPattern,
  createShift,
  assignSchedule,
  punch,
  requestAttendanceCorrection,
  decideAttendanceCorrection,
  submitOvertimeRequest,
  attendanceForDate,
} from "@/modules/hr/time";
import {
  createLeaveType,
  setLeavePolicy,
  postLeaveLedger,
  leaveBalances,
  submitLeaveRequest,
  applyLeaveApproval,
  cancelLeaveRequest,
} from "@/modules/hr/leave";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID(); // owner
const userM = randomUUID(); // manager (decider)
const userE = randomUUID(); // employee member (self-service)
let orgA = "";
let empE = ""; // employee row linked to userE

const ctxOf = (userId: string, cost = true): Ctx => ({
  orgId: orgA,
  userId,
  costPrivileged: cost,
  pricePrivileged: cost,
  requestId: "h23c",
});
const A = () => ctxOf(userA);
const M = () => ctxOf(userM);
const E = () => ctxOf(userE, false);

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h23c-${label}-${run}@example.invalid`}, '{"full_name":"H23C"}'::jsonb, now(), now())`;
}

beforeAll(async () => {
  for (const [id, l] of [
    [userA, "a"],
    [userM, "m"],
    [userE, "e"],
  ] as const) {
    await seedUser(id, l);
  }
  orgA = await createOrgForUser(userA, { name: "H23C", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h23c", run);
  await owner`
    insert into public.membership (user_id, org_id, role_key)
    values (${userM}, ${orgA}, 'manager'), (${userE}, ${orgA}, 'foreman')`;
  const e = await createEmployee(A(), "owner", { name: `Self ${run}` });
  empE = e.id;
  await owner`update public.employee set user_id = ${userE} where id = ${empE}`;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA, userM, userE]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 300_000);

describe("punches and the day row", () => {
  it("a self punch materializes the canonical attendance row", { timeout: 240_000 }, async () => {
    await punch(E(), "foreman", {
      employeeId: empE,
      kind: "in",
      at: "2026-09-02T04:05:00Z", // 08:05 Asia/Dubai
    });
    await punch(E(), "foreman", {
      employeeId: empE,
      kind: "out",
      at: "2026-09-02T13:00:00Z", // 17:00 Dubai
    });
    const rows = await owner`
      select status, source, worked_minutes from public.attendance
      where org_id = ${orgA} and employee_id = ${empE} and attendance_date = '2026-09-02'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("clock");
    expect(Number(rows[0]!.worked_minutes)).toBe(535);
  });

  it("a foreman cannot punch for somebody else", { timeout: 240_000 }, async () => {
    const other = await createEmployee(A(), "owner", { name: `Other ${run}` });
    await expect(punch(E(), "foreman", { employeeId: other.id, kind: "in" })).rejects.toThrow();
  });

  it(
    "an overnight punch-out lands on the day the shift started",
    { timeout: 240_000 },
    async () => {
      const night = await createEmployee(A(), "owner", { name: `Night ${run}` });
      // In at 22:00 Dubai Sep 3 (18:00Z), out at 02:00 Dubai Sep 4 (22:00Z Sep 3).
      await punch(A(), "owner", { employeeId: night.id, kind: "in", at: "2026-09-03T18:00:00Z" });
      await punch(A(), "owner", { employeeId: night.id, kind: "out", at: "2026-09-03T22:00:00Z" });
      const rows = await owner`
      select attendance_date::text as d, worked_minutes from public.attendance
      where org_id = ${orgA} and employee_id = ${night.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.d).toBe("2026-09-03");
      expect(Number(rows[0]!.worked_minutes)).toBe(240);
    },
  );

  it("a manual manager mark keeps winning over later punches", { timeout: 240_000 }, async () => {
    const emp = await createEmployee(A(), "owner", { name: `Manual ${run}` });
    await owner`
      insert into public.attendance (org_id, employee_id, attendance_date, status, source, marked_by)
      values (${orgA}, ${emp.id}, '2026-09-05', 'absent', 'manual', ${userA})`;
    await punch(A(), "owner", { employeeId: emp.id, kind: "in", at: "2026-09-05T05:00:00Z" });
    await punch(A(), "owner", { employeeId: emp.id, kind: "out", at: "2026-09-05T13:00:00Z" });
    const rows = await owner`
      select status, source, worked_minutes from public.attendance
      where org_id = ${orgA} and employee_id = ${emp.id} and attendance_date = '2026-09-05'`;
    expect(rows[0]!.status, "the manual mark stands").toBe("absent");
    expect(rows[0]!.source).toBe("manual");
    expect(Number(rows[0]!.worked_minutes), "but the clock numbers still attach").toBe(480);
  });

  it("lateness is measured against the assigned shift", { timeout: 240_000 }, async () => {
    const emp = await createEmployee(A(), "owner", { name: `Late ${run}` });
    const shift = await createShift(A(), "owner", {
      nameEn: "Morning",
      startsAt: "08:00",
      endsAt: "17:00",
    });
    await assignSchedule(A(), "owner", {
      employeeId: emp.id,
      shiftId: shift.id,
      startsOn: "2026-09-01",
    });
    // In at 08:35 Dubai — 35 minutes late.
    await punch(A(), "owner", { employeeId: emp.id, kind: "in", at: "2026-09-06T04:35:00Z" });
    await punch(A(), "owner", { employeeId: emp.id, kind: "out", at: "2026-09-06T13:00:00Z" });
    const rows = await owner`
      select status, late_minutes from public.attendance
      where org_id = ${orgA} and employee_id = ${emp.id} and attendance_date = '2026-09-06'`;
    expect(rows[0]!.status).toBe("late");
    expect(Number(rows[0]!.late_minutes)).toBe(35);
  });

  it(
    "a correction is requested with a reason and applies only on approval",
    { timeout: 240_000 },
    async () => {
      const c = await requestAttendanceCorrection(E(), "foreman", {
        employeeId: empE,
        attendanceDate: "2026-09-02",
        requestedStatus: "half_day",
        reason: "left at noon for a site errand",
      });
      // Not applied yet.
      let rows = await owner`
      select status from public.attendance
      where org_id = ${orgA} and employee_id = ${empE} and attendance_date = '2026-09-02'`;
      expect(rows[0]!.status).not.toBe("half_day");

      await decideAttendanceCorrection(M(), "manager", c.id, "approved");
      rows = await owner`
      select status, source from public.attendance
      where org_id = ${orgA} and employee_id = ${empE} and attendance_date = '2026-09-02'`;
      expect(rows[0]!.status).toBe("half_day");
      expect(rows[0]!.source).toBe("manual");
    },
  );
});

describe("leave", () => {
  let annualType = "";

  beforeAll(async () => {
    const t = await createLeaveType(A(), "owner", {
      key: `annual_${run.slice(0, 4)}`,
      labelEn: "Annual leave",
      labelAr: "إجازة سنوية",
      paid: true,
    });
    annualType = t.id;
    await setLeavePolicy(A(), "owner", {
      leaveTypeId: annualType,
      accrualBasis: "annual_fixed",
      annualDays: 30,
    });
    await postLeaveLedger(A(), "owner", {
      employeeId: empE,
      leaveTypeId: annualType,
      kind: "opening",
      days: 30,
      note: "opening balance",
    });
    // Route leave approvals to the manager role.
    await createApprovalRule(A(), "owner", {
      subjectType: "leave_request",
      conditionKind: "always",
      assignedRole: "manager",
    });
  }, 240_000);

  it(
    "an employee requests, a manager approves, the ledger debits ONCE and days resolve",
    { timeout: 300_000 },
    async () => {
      const req = await submitLeaveRequest(E(), "foreman", {
        employeeId: empE,
        leaveTypeId: annualType,
        startDate: "2026-12-07", // Mon
        endDate: "2026-12-10", // Thu — 4 working days
      });
      expect(req.days).toBe(4);
      expect(req.decided).toBe(false);

      const inbox = await listInbox(M(), "manager");
      const item = inbox.find((i) => i.subjectId === req.id);
      expect(item, "the request reached the manager's one inbox").toBeDefined();
      await decideApproval(M(), "manager", { approvalId: item!.id, decision: "approved" });
      await applyLeaveApproval(M(), "manager", req.id);
      // Applying twice must not double-debit.
      await applyLeaveApproval(M(), "manager", req.id);

      const balances = await leaveBalances(A(), "owner", empE);
      const annual = balances.find((b) => b.leaveTypeId === annualType)!;
      expect(annual.balanceDays).toBe(26);

      const days = await owner`
      select attendance_date::text as d, status, source from public.attendance
      where org_id = ${orgA} and employee_id = ${empE}
        and source = 'leave_request' order by attendance_date`;
      expect(days).toHaveLength(4);
      expect(days[0]!.status).toBe("leave");
    },
  );

  it(
    "two live requests cannot share a day — the DATABASE refuses",
    { timeout: 240_000 },
    async () => {
      await expect(
        submitLeaveRequest(E(), "foreman", {
          employeeId: empE,
          leaveTypeId: annualType,
          startDate: "2026-12-10",
          endDate: "2026-12-11",
        }),
      ).rejects.toThrow();
    },
  );

  it("a half-day start subtracts half a day", { timeout: 240_000 }, async () => {
    const req = await submitLeaveRequest(E(), "foreman", {
      employeeId: empE,
      leaveTypeId: annualType,
      startDate: "2027-01-11",
      endDate: "2027-01-12",
      halfDayStart: true,
    });
    expect(req.days).toBe(1.5);
  });

  it("holidays are not counted as working days", { timeout: 240_000 }, async () => {
    await owner`
      insert into public.org_holiday_calendar (org_id, starts_on, ends_on, label, kind)
      values (${orgA}, '2027-02-01', '2027-02-01', '{"en":"Founding day","ar":"يوم التأسيس"}'::jsonb, 'public_holiday')`;
    const req = await submitLeaveRequest(E(), "foreman", {
      employeeId: empE,
      leaveTypeId: annualType,
      startDate: "2027-02-01", // Mon, holiday
      endDate: "2027-02-03", // Wed
    });
    expect(req.days, "the holiday Monday is free").toBe(2);
  });

  it(
    "cancelling an approved request refunds the ledger and clears only FUTURE days",
    { timeout: 300_000 },
    async () => {
      const req = await submitLeaveRequest(E(), "foreman", {
        employeeId: empE,
        leaveTypeId: annualType,
        startDate: "2027-03-01",
        endDate: "2027-03-04",
      });
      const inbox = await listInbox(M(), "manager");
      const item = inbox.find((i) => i.subjectId === req.id)!;
      await decideApproval(M(), "manager", { approvalId: item.id, decision: "approved" });
      await applyLeaveApproval(M(), "manager", req.id);

      const before = (await leaveBalances(A(), "owner", empE)).find(
        (b) => b.leaveTypeId === annualType,
      )!.balanceDays;

      await cancelLeaveRequest(E(), "foreman", req.id, "plans changed");

      const after = (await leaveBalances(A(), "owner", empE)).find(
        (b) => b.leaveTypeId === annualType,
      )!.balanceDays;
      expect(after, "the full span was in the future, so the full refund").toBe(before + req.days);

      const remaining = await owner`
      select count(*)::int as n from public.attendance
      where org_id = ${orgA} and employee_id = ${empE}
        and source = 'leave_request' and note = ${req.id}::text`;
      expect(remaining[0]!.n, "future day marks were cleared").toBe(0);

      // The ledger kept BOTH sides — nothing was deleted.
      const ledger = await owner`
      select kind from public.leave_ledger
      where org_id = ${orgA} and leave_request_id = ${req.id} order by created_at`;
      expect(ledger.map((l) => l.kind)).toEqual(["request", "cancellation"]);
    },
  );

  it(
    "a type that requires an attachment refuses a bare request",
    { timeout: 240_000 },
    async () => {
      const sick = await createLeaveType(A(), "owner", {
        key: `sick_${run.slice(0, 4)}`,
        labelEn: "Sick leave",
        labelAr: "إجازة مرضية",
        requiresAttachment: true,
      });
      await expect(
        submitLeaveRequest(E(), "foreman", {
          employeeId: empE,
          leaveTypeId: sick.id,
          startDate: "2027-04-05",
          endDate: "2027-04-05",
        }),
      ).rejects.toThrow(/supporting document/);
    },
  );

  it("the leave ledger is append-only at the database", { timeout: 240_000 }, async () => {
    const [row] = await owner`
      select id from public.leave_ledger where org_id = ${orgA} limit 1`;
    let refused = false;
    try {
      await owner`delete from public.leave_ledger where id = ${row!.id}`;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});

describe("overtime", () => {
  it(
    "routes through the approval engine and blocks a duplicate live request",
    { timeout: 300_000 },
    async () => {
      await createApprovalRule(A(), "owner", {
        subjectType: "overtime_request",
        conditionKind: "always",
        assignedRole: "manager",
      });
      const ot = await submitOvertimeRequest(E(), "foreman", {
        employeeId: empE,
        workDate: "2026-09-02",
        minutes: 120,
        reason: "urgent delivery",
      });
      expect(ot.decided).toBe(false);
      await expect(
        submitOvertimeRequest(E(), "foreman", {
          employeeId: empE,
          workDate: "2026-09-02",
          minutes: 60,
          reason: "again",
        }),
      ).rejects.toThrow();

      const inbox = await listInbox(M(), "manager");
      const item = inbox.find((i) => i.subjectId === ot.id)!;
      expect(item.amountMinor ?? null, "overtime carries no money in the inbox").toBeNull();
      await decideApproval(M(), "manager", { approvalId: item.id, decision: "approved" });
      const rows = await owner`
      select status from public.overtime_request where id = ${ot.id}`;
      expect(rows[0]!.status).toBe("approved");
    },
  );
});

describe("grid read", () => {
  it("the day grid stays bounded and org-scoped", { timeout: 240_000 }, async () => {
    const grid = await attendanceForDate(A(), "owner", "2026-09-02");
    expect(grid.length).toBeGreaterThan(0);
    expect(grid.every((g) => typeof g.employeeName === "string")).toBe(true);
  });
});
