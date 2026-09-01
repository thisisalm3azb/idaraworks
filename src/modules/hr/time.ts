/**
 * H23C — schedules, punches, corrections and overtime.
 *
 * The clock stream is append-only; every punch immediately re-materializes the
 * canonical attendance day row through a SECURITY DEFINER rollup (no worker to
 * wait for, nothing to go stale). Manual manager marks keep winning exactly as
 * they have since S3.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, can } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { submitForApproval } from "@/modules/approvals/service";
import { HrError } from "./people";

const DayShape = z
  .object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
    break_minutes: z.number().int().min(0).max(480).default(0),
  })
  .nullable();

export async function createWorkPattern(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "attendance.manage");
  const input = z
    .object({
      nameEn: z.string().trim().min(1).max(120),
      nameAr: z.string().trim().max(120).optional(),
      days: z.record(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]), DayShape),
      weeklyHours: z.number().min(0).max(168).default(48),
      isDefault: z.boolean().default(false),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.pattern.create",
        entityType: "attendance",
        entityId: r.id,
        summary: `Created work pattern ${input.nameEn}`,
      }),
    },
    async (tx) => {
      if (input.isDefault) {
        await tx.execute(sql`
          update public.work_pattern set is_default = false
          where org_id = ${ctx.orgId} and is_default
        `);
      }
      const rows = (await tx.execute(sql`
        insert into public.work_pattern (org_id, name_en, name_ar, days, weekly_hours, is_default)
        values (${ctx.orgId}, ${input.nameEn}, ${input.nameAr ?? null},
                ${JSON.stringify(input.days)}::jsonb, ${input.weeklyHours}, ${input.isDefault})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export async function createShift(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "attendance.manage");
  const input = z
    .object({
      nameEn: z.string().trim().min(1).max(120),
      nameAr: z.string().trim().max(120).optional(),
      startsAt: z.string().regex(/^\d{2}:\d{2}$/),
      endsAt: z.string().regex(/^\d{2}:\d{2}$/),
      breakMinutes: z.number().int().min(0).max(480).default(0),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.shift.create",
        entityType: "attendance",
        entityId: r.id,
        summary: `Created shift ${input.nameEn}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.shift (org_id, name_en, name_ar, starts_at, ends_at, break_minutes)
        values (${ctx.orgId}, ${input.nameEn}, ${input.nameAr ?? null},
                ${input.startsAt}::time, ${input.endsAt}::time, ${input.breakMinutes})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export async function assignSchedule(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "attendance.manage");
  const input = z
    .object({
      employeeId: z.string().uuid().optional(),
      teamId: z.string().uuid().optional(),
      workLocationId: z.string().uuid().optional(),
      patternId: z.string().uuid().optional(),
      shiftId: z.string().uuid().optional(),
      startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endsOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .refine(
      (v) => [v.employeeId, v.teamId, v.workLocationId].filter(Boolean).length === 1,
      "exactly one of employee, team or location",
    )
    .refine((v) => v.patternId || v.shiftId, "a pattern or a shift is required")
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.schedule.assign",
        entityType: "attendance",
        entityId: r.id,
        summary: "Assigned a schedule",
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.schedule_assignment
          (org_id, employee_id, team_id, work_location_id, pattern_id, shift_id,
           starts_on, ends_on, created_by)
        values (${ctx.orgId}, ${input.employeeId ?? null}, ${input.teamId ?? null},
                ${input.workLocationId ?? null}, ${input.patternId ?? null},
                ${input.shiftId ?? null}, ${input.startsOn}, ${input.endsOn ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

// ── punches ──────────────────────────────────────────────────────────────────

/**
 * The org-timezone date a moment belongs to. Overnight shifts: a punch-out
 * before 06:00 with an open 'in' on the previous date belongs to that previous
 * date — the day the shift started.
 */
async function workDateFor(ctx: Ctx, employeeId: string, kind: string, at: Date): Promise<string> {
  return withCtx(ctx, async (tx) => {
    const tzRows = (await tx.execute(sql`
      select timezone from public.org where id = ${ctx.orgId}
    `)) as unknown as Array<{ timezone: string }>;
    const tz = tzRows[0]?.timezone ?? "Asia/Dubai";
    const localIso = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at); // en-CA gives YYYY-MM-DD
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(at),
    );
    if (kind !== "in" && hour < 6) {
      const prev = new Date(at.getTime() - 24 * 3600 * 1000);
      const prevIso = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(prev);
      const open = (await tx.execute(sql`
        select 1 from public.attendance_event
        where org_id = ${ctx.orgId} and employee_id = ${employeeId}
          and work_date = ${prevIso}::date and kind = 'in' and voided_at is null
      `)) as unknown as unknown[];
      if (open.length > 0) return prevIso;
    }
    return localIso;
  });
}

export async function punch(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; workDate: string }> {
  const input = z
    .object({
      employeeId: z.string().uuid(),
      kind: z.enum(["in", "out", "break_start", "break_end"]),
      at: z.string().optional(), // ISO; defaults to now
      note: z.string().trim().max(300).optional(),
    })
    .parse(raw);
  const managesOthers = can(archetype, "attendance.manage");
  const at = input.at ? new Date(input.at) : new Date();
  const workDate = await workDateFor(ctx, input.employeeId, input.kind, at);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.attendance.punch",
        entityType: "attendance",
        entityId: r.id,
        summary: `Recorded a clock-${input.kind.replace("_", " ")}`,
      }),
    },
    async (tx) => {
      if (!managesOthers) {
        const self = (await tx.execute(sql`
          select 1 from public.employee
          where id = ${input.employeeId} and org_id = ${ctx.orgId} and user_id = ${ctx.userId}
        `)) as unknown as unknown[];
        if (self.length === 0) throw new HrError("you can only clock for yourself", "forbidden");
      }
      const rows = (await tx.execute(sql`
        insert into public.attendance_event
          (org_id, employee_id, kind, at, work_date, source, recorded_by, note)
        values (${ctx.orgId}, ${input.employeeId}, ${input.kind}, ${at.toISOString()}::timestamptz,
                ${workDate}::date, ${managesOthers && input.at ? "manager" : "self"},
                ${ctx.userId}, ${input.note ?? null})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      await tx.execute(sql`
        select app.rollup_attendance_day(${ctx.orgId}::uuid, ${input.employeeId}::uuid, ${workDate}::date)
      `);
      return { id: rows[0]!.id, workDate };
    },
  );
}

// ── corrections ──────────────────────────────────────────────────────────────

export async function requestAttendanceCorrection(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  const input = z
    .object({
      employeeId: z.string().uuid(),
      attendanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      requestedIn: z.string().optional(),
      requestedOut: z.string().optional(),
      requestedStatus: z
        .enum(["present", "absent", "leave", "half_day", "sick", "late"])
        .optional(),
      reason: z.string().trim().min(1).max(500),
    })
    .refine((v) => v.requestedIn || v.requestedOut || v.requestedStatus, "nothing to correct")
    .parse(raw);
  const managesOthers = can(archetype, "attendance.manage");
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.attendance.correction.request",
        entityType: "attendance",
        entityId: r.id,
        summary: `Requested an attendance correction for ${input.attendanceDate}`,
      }),
    },
    async (tx) => {
      if (!managesOthers) {
        const self = (await tx.execute(sql`
          select 1 from public.employee
          where id = ${input.employeeId} and org_id = ${ctx.orgId} and user_id = ${ctx.userId}
        `)) as unknown as unknown[];
        if (self.length === 0) {
          throw new HrError("you can only request corrections for yourself", "forbidden");
        }
      }
      const rows = (await tx.execute(sql`
        insert into public.attendance_correction
          (org_id, employee_id, attendance_date, requested_in, requested_out,
           requested_status, reason, created_by)
        values (${ctx.orgId}, ${input.employeeId}, ${input.attendanceDate},
                ${input.requestedIn ?? null}::timestamptz, ${input.requestedOut ?? null}::timestamptz,
                ${input.requestedStatus ?? null}, ${input.reason}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

/** Manager decision. Approval APPLIES the correction as manual-sourced truth. */
export async function decideAttendanceCorrection(
  ctx: Ctx,
  archetype: RoleArchetype,
  correctionId: string,
  outcome: "approved" | "rejected",
): Promise<void> {
  assertCan(archetype, "attendance.manage");
  await command(
    ctx,
    {
      audit: {
        action: "hr.attendance.correction.decide",
        entityType: "attendance",
        entityId: correctionId,
        summary: `Attendance correction ${outcome}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.attendance_correction
        set status = ${outcome}, decided_by = ${ctx.userId}, decided_at = now()
        where id = ${correctionId} and org_id = ${ctx.orgId} and status = 'pending'
        returning employee_id::text as employee_id, attendance_date::text as d,
                  requested_in, requested_out, requested_status
      `)) as unknown as Array<Record<string, unknown>>;
      const r = rows[0];
      if (!r) throw new HrError("only a pending correction can be decided", "invalid_state");
      if (outcome !== "approved") return;

      await tx.execute(sql`
        insert into public.attendance
          (org_id, employee_id, attendance_date, status, source, marked_by,
           check_in, check_out, note)
        values (${ctx.orgId}, ${r.employee_id as string}, ${r.d as string}::date,
                coalesce(${(r.requested_status as string | null) ?? null}, 'present'), 'manual',
                ${ctx.userId},
                ${r.requested_in as string | null}, ${r.requested_out as string | null},
                ${`correction ${correctionId}`})
        on conflict (org_id, employee_id, attendance_date) do update
          set status = coalesce(${(r.requested_status as string | null) ?? null}, public.attendance.status),
              check_in = coalesce(excluded.check_in, public.attendance.check_in),
              check_out = coalesce(excluded.check_out, public.attendance.check_out),
              source = 'manual', marked_by = excluded.marked_by,
              note = excluded.note, missing_punch = false, updated_at = now()
      `);
    },
  );
}

// ── overtime ─────────────────────────────────────────────────────────────────

export async function submitOvertimeRequest(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; decided: boolean }> {
  const input = z
    .object({
      employeeId: z.string().uuid(),
      workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      minutes: z.number().int().min(1).max(960),
      reason: z.string().trim().min(1).max(500),
    })
    .parse(raw);
  const managesOthers = can(archetype, "attendance.manage");
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.overtime.request",
        entityType: "overtime_request",
        entityId: r.id,
        summary: `Requested ${input.minutes} overtime minutes for ${input.workDate}`,
      }),
    },
    async (tx) => {
      if (!managesOthers) {
        const self = (await tx.execute(sql`
          select 1 from public.employee
          where id = ${input.employeeId} and org_id = ${ctx.orgId} and user_id = ${ctx.userId}
        `)) as unknown as unknown[];
        if (self.length === 0) {
          throw new HrError("you can only request overtime for yourself", "forbidden");
        }
      }
      const rows = (await tx.execute(sql`
        insert into public.overtime_request
          (org_id, employee_id, work_date, minutes, reason, status, created_by)
        values (${ctx.orgId}, ${input.employeeId}, ${input.workDate}, ${input.minutes},
                ${input.reason}, 'pending', ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;
      const res = await submitForApproval(tx, ctx, {
        subjectType: "overtime_request",
        subjectId: id,
        subjectSummary: { title: `Overtime — ${input.minutes} min on ${input.workDate}` },
      });
      return { id, decided: res.decided };
    },
  );
}

// ── reads ────────────────────────────────────────────────────────────────────

export type AttendanceDayRow = {
  employeeId: string;
  employeeName: string;
  date: string;
  status: string | null;
  source: string | null;
  checkIn: string | null;
  checkOut: string | null;
  workedMinutes: number | null;
  lateMinutes: number | null;
  missingPunch: boolean;
};

export async function attendanceForDate(
  ctx: Ctx,
  archetype: RoleArchetype,
  date: string,
): Promise<AttendanceDayRow[]> {
  assertCan(archetype, "attendance.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select e.id::text as employee_id, e.name as employee_name,
             a.status, a.source, a.check_in::text as check_in, a.check_out::text as check_out,
             a.worked_minutes, a.late_minutes, coalesce(a.missing_punch, false) as missing_punch
      from public.employee e
      left join public.attendance a
        on a.org_id = e.org_id and a.employee_id = e.id and a.attendance_date = ${date}::date
      where e.org_id = ${ctx.orgId} and e.active
      order by e.name
      limit 1000
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    employeeId: r.employee_id as string,
    employeeName: r.employee_name as string,
    date,
    status: (r.status as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    checkIn: (r.check_in as string | null) ?? null,
    checkOut: (r.check_out as string | null) ?? null,
    workedMinutes: r.worked_minutes === null ? null : Number(r.worked_minutes),
    lateMinutes: r.late_minutes === null ? null : Number(r.late_minutes),
    missingPunch: r.missing_punch === true,
  }));
}

/** One employee's own day (self-service card): RLS makes it self-or-manager. */
export async function myAttendanceDay(
  ctx: Ctx,
  date: string,
): Promise<{ status: string | null; checkIn: string | null; checkOut: string | null } | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select a.status, a.check_in::text as check_in, a.check_out::text as check_out
      from public.attendance a
      join public.employee e on e.id = a.employee_id and e.org_id = a.org_id
      where a.org_id = ${ctx.orgId} and e.user_id = ${ctx.userId}
        and a.attendance_date = ${date}::date
    `),
  )) as unknown as Array<Record<string, string | null>>;
  if (!rows[0]) return null;
  return {
    status: rows[0].status ?? null,
    checkIn: rows[0].check_in ?? null,
    checkOut: rows[0].check_out ?? null,
  };
}
