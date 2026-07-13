/**
 * Attendance module service — S3 (doc 06 row 61; doc 01 U3/C-3).
 * Two write paths: the DERIVED write (labour lines → present, done by the
 * SECURITY DEFINER app.derive_attendance_from_report inside report submit) and
 * the MANUAL grid here (a manager marks non-job staff / corrects a day). Manual
 * ALWAYS wins — the derive is on-conflict-do-nothing, this is on-conflict-update.
 * Read is gated by attendance.view (O/A/M + accounts + viewer; foreman none).
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";

export class InvalidAttendanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAttendanceError";
  }
}

export const ATTENDANCE_STATUSES = [
  "present",
  "absent",
  "leave",
  "half_day",
  "sick",
  "late",
] as const;

export const MarkAttendanceInput = z.object({
  employeeId: z.string().uuid(),
  attendanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(ATTENDANCE_STATUSES),
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export async function markAttendance(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ employeeId: string; attendanceDate: string }> {
  assertCan(archetype, "attendance.manage");
  const data = MarkAttendanceInput.parse(input);
  return command<{ employeeId: string; attendanceDate: string }>(
    ctx,
    {
      audit: {
        action: "attendance.mark",
        entityType: "attendance",
        summary: `Marked ${data.employeeId} ${data.status} on ${data.attendanceDate}`,
      },
    },
    async (tx) => {
      // Employee must be in-org (the composite FK backs this, but a clear error first).
      const emp = (await tx.execute(sql`
        select id::text as id from public.employee
        where org_id = ${ctx.orgId} and id = ${data.employeeId}
      `)) as unknown as Array<{ id: string }>;
      if (!emp[0]) throw new InvalidAttendanceError(`unknown employee ${data.employeeId}`);
      // Manual mark wins over any derived row.
      await tx.execute(sql`
        insert into public.attendance
          (org_id, employee_id, attendance_date, status, source, marked_by, note)
        values (${ctx.orgId}, ${data.employeeId}, ${data.attendanceDate}, ${data.status},
                'manual', ${ctx.userId}, ${data.note ?? null})
        on conflict (org_id, employee_id, attendance_date) do update
          set status = excluded.status, source = 'manual',
              marked_by = ${ctx.userId}, note = excluded.note, updated_at = now()
      `);
      return { employeeId: data.employeeId, attendanceDate: data.attendanceDate };
    },
  );
}

export type AttendanceGridRow = {
  employeeId: string;
  employeeName: string;
  status: string | null;
  source: string | null;
  note: string | null;
};

/**
 * The grid for one day: every ACTIVE employee, left-joined to their attendance
 * row for that date (null status = not yet marked). Derived rows and manual rows
 * both appear; the `source` tells the manager which is which.
 */
export async function listAttendanceForDate(
  ctx: Ctx,
  archetype: RoleArchetype,
  attendanceDate: string,
): Promise<AttendanceGridRow[]> {
  assertCan(archetype, "attendance.view");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(attendanceDate)) {
    throw new InvalidAttendanceError("attendanceDate must be YYYY-MM-DD");
  }
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select e.id::text as employee_id, e.name as employee_name,
             a.status, a.source, a.note
      from public.employee e
      left join public.attendance a
        on a.employee_id = e.id and a.org_id = e.org_id and a.attendance_date = ${attendanceDate}
      where e.org_id = ${ctx.orgId} and e.active = true
      order by e.name asc
    `),
  )) as unknown as Array<{
    employee_id: string;
    employee_name: string;
    status: string | null;
    source: string | null;
    note: string | null;
  }>;
  return rows.map((r) => ({
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    status: r.status,
    source: r.source,
    note: r.note,
  }));
}
