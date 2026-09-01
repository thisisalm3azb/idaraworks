/**
 * H23C — leave: types, versioned policies, the balance ledger, and requests
 * that ride the org's one approval engine and resolve into the canonical
 * attendance table.
 *
 * The balance is a SUM over an append-only ledger — no stored balance column
 * anywhere, so nothing can drift and every number can show its working. Nothing
 * is silently inferred: whether a type is paid, how it accrues, and how days
 * are counted are explicit, versioned policy rows.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { requireCapability } from "@/platform/entitlements";
import { assertCan, can } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { submitForApproval, supersedeApprovalsForSubjectIn } from "@/modules/approvals/service";
import { HrError } from "./people";

// ── types and policies ───────────────────────────────────────────────────────

export async function createLeaveType(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "employees.manage");
  const input = z
    .object({
      key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
      labelEn: z.string().trim().min(1).max(80),
      labelAr: z.string().trim().min(1).max(80),
      paid: z.boolean().default(true),
      requiresAttachment: z.boolean().default(false),
      countBasis: z.enum(["working_days", "calendar_days"]).default("working_days"),
      allowHalfDay: z.boolean().default(true),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.leave_type.create",
        entityType: "employee",
        entityId: r.id,
        summary: `Created leave type ${input.key}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.leave_type
          (org_id, key, label, paid, requires_attachment, count_basis, allow_half_day)
        values (${ctx.orgId}, ${input.key},
                ${JSON.stringify({ en: input.labelEn, ar: input.labelAr })}::jsonb,
                ${input.paid}, ${input.requiresAttachment}, ${input.countBasis},
                ${input.allowHalfDay})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export async function setLeavePolicy(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; version: number }> {
  assertCan(archetype, "employees.manage");
  const input = z
    .object({
      leaveTypeId: z.string().uuid(),
      accrualBasis: z.enum(["annual_fixed", "monthly_accrual", "none"]).default("annual_fixed"),
      annualDays: z.number().min(0).max(365).optional(),
      monthlyAccrualDays: z.number().min(0).max(31).optional(),
      carryoverCapDays: z.number().min(0).optional(),
      minServiceMonths: z.number().int().min(0).optional(),
      rules: z.record(z.string(), z.unknown()).default({}),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.leave_policy.set",
        entityType: "employee",
        entityId: r.id,
        summary: `Set leave policy v${r.version}`,
      }),
    },
    async (tx) => {
      const prev = (await tx.execute(sql`
        update public.leave_policy set active = false
        where org_id = ${ctx.orgId} and leave_type_id = ${input.leaveTypeId} and active
        returning version
      `)) as unknown as Array<{ version: number }>;
      const version = (prev[0]?.version ?? 0) + 1;
      const rows = (await tx.execute(sql`
        insert into public.leave_policy
          (org_id, leave_type_id, version, accrual_basis, annual_days, monthly_accrual_days,
           carryover_cap_days, min_service_months, rules, created_by)
        values (${ctx.orgId}, ${input.leaveTypeId}, ${version}, ${input.accrualBasis},
                ${input.annualDays ?? null}, ${input.monthlyAccrualDays ?? null},
                ${input.carryoverCapDays ?? null}, ${input.minServiceMonths ?? null},
                ${JSON.stringify(input.rules)}::jsonb, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id, version };
    },
  );
}

// ── the ledger ───────────────────────────────────────────────────────────────

export async function postLeaveLedger(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "employees.manage");
  const input = z
    .object({
      employeeId: z.string().uuid(),
      leaveTypeId: z.string().uuid(),
      kind: z.enum(["opening", "accrual", "carryover", "adjustment", "expiry"]),
      days: z.number().refine((d) => d !== 0, "zero-day entries are noise"),
      effectiveDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      note: z.string().trim().max(300).optional(),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.leave_ledger.post",
        entityType: "employee",
        entityId: input.employeeId,
        summary: `Posted a ${input.kind} leave entry`,
        after: { ledgerId: r.id },
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.leave_ledger
          (org_id, employee_id, leave_type_id, kind, days, effective_date, note, created_by)
        values (${ctx.orgId}, ${input.employeeId}, ${input.leaveTypeId}, ${input.kind},
                ${input.days}, coalesce(${input.effectiveDate ?? null}::date, current_date),
                ${input.note ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export type LeaveBalance = {
  leaveTypeId: string;
  key: string;
  labelEn: string;
  labelAr: string;
  balanceDays: number;
  pendingDays: number;
};

export async function leaveBalances(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
): Promise<LeaveBalance[]> {
  // RLS narrows a self-viewer to their own rows; org roles read anyone.
  void archetype;
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select t.id::text as leave_type_id, t.key, t.label,
             coalesce((select sum(l.days) from public.leave_ledger l
                       where l.org_id = t.org_id and l.employee_id = ${employeeId}
                         and l.leave_type_id = t.id), 0)::text as balance,
             coalesce((select sum(r.days) from public.leave_request r
                       where r.org_id = t.org_id and r.employee_id = ${employeeId}
                         and r.leave_type_id = t.id and r.status = 'pending'), 0)::text as pending
      from public.leave_type t
      where t.org_id = ${ctx.orgId} and t.active
      order by t.sort, t.key
    `),
  )) as unknown as Array<{
    leave_type_id: string;
    key: string;
    label: unknown;
    balance: string;
    pending: string;
  }>;
  return rows.map((r) => {
    const label = r.label as { en?: string; ar?: string };
    return {
      leaveTypeId: r.leave_type_id,
      key: r.key,
      labelEn: label.en ?? r.key,
      labelAr: label.ar ?? label.en ?? r.key,
      balanceDays: Number(r.balance),
      pendingDays: Number(r.pending),
    };
  });
}

// ── day counting ─────────────────────────────────────────────────────────────

/**
 * The concrete days a request covers, honouring the type's counting basis:
 * working days skip non-working weekdays (from the org's default pattern) and
 * org holidays; calendar days count everything. Half-day flags subtract halves.
 */
async function requestDays(
  tx: TenantTx,
  ctx: Ctx,
  leaveTypeId: string,
  startDate: string,
  endDate: string,
  halfStart: boolean,
  halfEnd: boolean,
): Promise<{ days: number; dates: string[] }> {
  const t = (await tx.execute(sql`
    select count_basis from public.leave_type
    where id = ${leaveTypeId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ count_basis: string }>;
  if (!t[0]) throw new HrError("leave type not found", "not_found");

  const pattern = (await tx.execute(sql`
    select days from public.work_pattern
    where org_id = ${ctx.orgId} and is_default and active
    limit 1
  `)) as unknown as Array<{ days: Record<string, unknown> }>;
  const workingKeys = pattern[0]
    ? new Set(Object.keys(pattern[0].days).filter((k) => pattern[0]!.days[k] != null))
    : new Set(["mon", "tue", "wed", "thu", "fri"]); // conventional default, documented

  const holidays = (await tx.execute(sql`
    select starts_on::text as s, coalesce(ends_on, starts_on)::text as e
    from public.org_holiday_calendar
    where org_id = ${ctx.orgId}
      and starts_on <= ${endDate}::date and coalesce(ends_on, starts_on) >= ${startDate}::date
  `)) as unknown as Array<{ s: string; e: string }>;
  const isHoliday = (iso: string) => holidays.some((h) => iso >= h.s && iso <= h.e);

  const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  const dates: string[] = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (t[0].count_basis === "calendar_days") {
      dates.push(iso);
    } else if (workingKeys.has(DOW[d.getUTCDay()]!) && !isHoliday(iso)) {
      dates.push(iso);
    }
  }
  let days = dates.length;
  if (halfStart && dates.includes(startDate)) days -= 0.5;
  if (halfEnd && endDate !== startDate && dates.includes(endDate)) days -= 0.5;
  return { days, dates };
}

// ── requests ─────────────────────────────────────────────────────────────────

export const LeaveRequestInput = z.object({
  employeeId: z.string().uuid(),
  leaveTypeId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  halfDayStart: z.boolean().default(false),
  halfDayEnd: z.boolean().default(false),
  reason: z.string().trim().max(1000).optional(),
  attachmentFileId: z.string().uuid().optional(),
});

/**
 * Create + submit in one motion. A member may request for THEIR OWN employee
 * row (RLS backs this at the database); managers may request for anyone. The
 * request goes straight into the approval engine — the overlap exclusion, the
 * attachment requirement and the day count are all settled before it does.
 */
export async function submitLeaveRequest(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; days: number; decided: boolean }> {
  await requireCapability(ctx, "cap.leave");
  const input = LeaveRequestInput.parse(raw);
  const managesOthers = can(archetype, "attendance.manage");
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.leave.request",
        entityType: "leave_request",
        entityId: r.id,
        summary: `Requested ${r.days} day(s) of leave`,
      }),
    },
    async (tx) => {
      // Self-or-manager: the database insert policy enforces the same rule, but
      // failing here gives a human error instead of an RLS refusal.
      if (!managesOthers) {
        const self = (await tx.execute(sql`
          select 1 from public.employee
          where id = ${input.employeeId} and org_id = ${ctx.orgId} and user_id = ${ctx.userId}
        `)) as unknown as unknown[];
        if (self.length === 0) {
          throw new HrError("you can only request leave for yourself", "forbidden");
        }
      }
      const t = (await tx.execute(sql`
        select requires_attachment, allow_half_day from public.leave_type
        where id = ${input.leaveTypeId} and org_id = ${ctx.orgId} and active
      `)) as unknown as Array<{ requires_attachment: boolean; allow_half_day: boolean }>;
      if (!t[0]) throw new HrError("leave type not found", "not_found");
      if (t[0].requires_attachment && !input.attachmentFileId) {
        throw new HrError("this leave type requires a supporting document", "invalid_state");
      }
      if (!t[0].allow_half_day && (input.halfDayStart || input.halfDayEnd)) {
        throw new HrError("this leave type does not allow half days", "invalid_state");
      }

      const { days } = await requestDays(
        tx,
        ctx,
        input.leaveTypeId,
        input.startDate,
        input.endDate,
        input.halfDayStart,
        input.halfDayEnd,
      );
      if (days <= 0) {
        throw new HrError("the requested span contains no countable days", "invalid_state");
      }

      const policy = (await tx.execute(sql`
        select id::text as id from public.leave_policy
        where org_id = ${ctx.orgId} and leave_type_id = ${input.leaveTypeId} and active
      `)) as unknown as Array<{ id: string }>;

      const rows = (await tx.execute(sql`
        insert into public.leave_request
          (org_id, employee_id, leave_type_id, start_date, end_date,
           half_day_start, half_day_end, days, reason, attachment_file_id,
           policy_id, status, created_by)
        values (${ctx.orgId}, ${input.employeeId}, ${input.leaveTypeId},
                ${input.startDate}, ${input.endDate},
                ${input.halfDayStart}, ${input.halfDayEnd}, ${days},
                ${input.reason ?? null}, ${input.attachmentFileId ?? null},
                ${policy[0]?.id ?? null}, 'pending', ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;

      const emp = (await tx.execute(sql`
        select name from public.employee where id = ${input.employeeId} and org_id = ${ctx.orgId}
      `)) as unknown as Array<{ name: string }>;

      const res = await submitForApproval(tx, ctx, {
        subjectType: "leave_request",
        subjectId: id,
        subjectSummary: { title: `Leave — ${emp[0]?.name ?? "employee"} (${days}d)` },
      });
      if (res.decided) {
        // Auto-approved by rule: resolve immediately, exactly as a decision would.
        await applyLeaveApprovalIn(tx, ctx, id);
      }
      return { id, days, decided: res.decided };
    },
  );
}

/**
 * What an approval decision triggers: the ledger debit and the attendance
 * resolution. Called by the submit path on auto-approve; the approvals page
 * calls the exported wrapper after a human decision.
 */
export async function applyLeaveApprovalIn(
  tx: TenantTx,
  ctx: Ctx,
  requestId: string,
): Promise<void> {
  const rows = (await tx.execute(sql`
    select r.employee_id::text as employee_id, r.leave_type_id::text as leave_type_id,
           r.start_date::text as start_date, r.end_date::text as end_date,
           r.half_day_start, r.half_day_end, r.days::text as days, r.policy_id::text as policy_id,
           t.paid, t.key
    from public.leave_request r
    join public.leave_type t on t.id = r.leave_type_id and t.org_id = r.org_id
    where r.id = ${requestId} and r.org_id = ${ctx.orgId} and r.status = 'approved'
  `)) as unknown as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return; // not approved (or already handled) — nothing to apply

  const already = (await tx.execute(sql`
    select 1 from public.leave_ledger
    where org_id = ${ctx.orgId} and leave_request_id = ${requestId} and kind = 'request'
  `)) as unknown as unknown[];
  if (already.length > 0) return; // idempotent

  await tx.execute(sql`
    insert into public.leave_ledger
      (org_id, employee_id, leave_type_id, kind, days, effective_date,
       leave_request_id, policy_id, created_by)
    values (${ctx.orgId}, ${r.employee_id as string}, ${r.leave_type_id as string}, 'request',
            ${-Number(r.days)}, ${r.start_date as string}::date, ${requestId},
            ${(r.policy_id as string | null) ?? null}, ${ctx.userId})
  `);

  const { dates } = await requestDays(
    tx,
    ctx,
    r.leave_type_id as string,
    r.start_date as string,
    r.end_date as string,
    false,
    false,
  );
  const status = (r.key as string).includes("sick") ? "sick" : "leave";
  await tx.execute(sql`
    select app.resolve_leave_days(${ctx.orgId}::uuid, ${requestId}::uuid,
                                  ${r.employee_id as string}::uuid, ${status},
                                  ${"{" + dates.join(",") + "}"}::date[])
  `);
}

export async function applyLeaveApproval(
  ctx: Ctx,
  archetype: RoleArchetype,
  requestId: string,
): Promise<void> {
  assertCan(archetype, "approvals.decide");
  await command(
    ctx,
    {
      audit: {
        action: "hr.leave.apply_approval",
        entityType: "leave_request",
        entityId: requestId,
        summary: "Resolved approved leave into attendance",
      },
    },
    (tx) => applyLeaveApprovalIn(tx, ctx, requestId),
  );
}

/**
 * Cancel a request. Draft/pending simply close (superseding any waiting
 * approval); an APPROVED request refunds the ledger and un-marks the future
 * days — past days stand, because they happened.
 */
export async function cancelLeaveRequest(
  ctx: Ctx,
  archetype: RoleArchetype,
  requestId: string,
  reason: string,
): Promise<void> {
  const managesOthers = can(archetype, "attendance.manage");
  await command(
    ctx,
    {
      audit: {
        action: "hr.leave.cancel",
        entityType: "leave_request",
        entityId: requestId,
        summary: "Cancelled a leave request",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select r.status, r.employee_id::text as employee_id, r.leave_type_id::text as leave_type_id,
               r.days::text as days, r.start_date::text as start_date, e.user_id::text as user_id
        from public.leave_request r
        join public.employee e on e.id = r.employee_id and e.org_id = r.org_id
        where r.id = ${requestId} and r.org_id = ${ctx.orgId}
        for update of r
      `)) as unknown as Array<Record<string, string | null>>;
      const r = rows[0];
      if (!r) throw new HrError("leave request not found", "not_found");
      if (!managesOthers && r.user_id !== ctx.userId) {
        throw new HrError("you can only cancel your own request", "forbidden");
      }
      if (!["draft", "pending", "approved"].includes(r.status!)) {
        throw new HrError(`a ${r.status} request cannot be cancelled`, "invalid_state");
      }

      await tx.execute(sql`
        update public.leave_request
        set status = 'cancelled', cancelled_at = now(), cancel_reason = ${reason}, updated_at = now()
        where id = ${requestId} and org_id = ${ctx.orgId}
      `);
      await supersedeApprovalsForSubjectIn(tx, ctx, {
        subjectType: "leave_request",
        subjectId: requestId,
        reason,
      });

      if (r.status === "approved") {
        // Refund the ledger (append, never delete) and clear FUTURE day marks.
        await tx.execute(sql`
          insert into public.leave_ledger
            (org_id, employee_id, leave_type_id, kind, days, effective_date,
             leave_request_id, note, created_by)
          values (${ctx.orgId}, ${r.employee_id}, ${r.leave_type_id}, 'cancellation',
                  ${Number(r.days)}, current_date, ${requestId}, ${reason}, ${ctx.userId})
        `);
        await tx.execute(sql`
          select app.revert_leave_days(${ctx.orgId}::uuid, ${requestId}::uuid, ${r.employee_id}::uuid)
        `);
      }
    },
  );
}

export type LeaveRequestRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  typeKey: string;
  startDate: string;
  endDate: string;
  days: string;
  status: string;
};

export async function listLeaveRequests(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { employeeId?: string; status?: string; limit?: number } = {},
): Promise<LeaveRequestRow[]> {
  void archetype; // RLS scopes self-viewers to their own rows
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select r.id::text as id, r.employee_id::text as employee_id, e.name as employee_name,
             t.key as type_key, r.start_date::text as start_date, r.end_date::text as end_date,
             r.days::text as days, r.status
      from public.leave_request r
      join public.employee e on e.id = r.employee_id and e.org_id = r.org_id
      join public.leave_type t on t.id = r.leave_type_id and t.org_id = r.org_id
      where r.org_id = ${ctx.orgId}
        and (${opts.employeeId ?? null}::uuid is null or r.employee_id = ${opts.employeeId ?? null}::uuid)
        and (${opts.status ?? null}::text is null or r.status = ${opts.status ?? null})
      order by r.start_date desc
      limit ${limit}
    `),
  )) as unknown as Array<Record<string, string>>;
  return rows.map((r) => ({
    id: r.id!,
    employeeId: r.employee_id!,
    employeeName: r.employee_name!,
    typeKey: r.type_key!,
    startDate: r.start_date!,
    endDate: r.end_date!,
    days: r.days!,
    status: r.status!,
  }));
}

export type LeaveTypeRow = {
  id: string;
  key: string;
  labelEn: string;
  labelAr: string;
  paid: boolean;
  requiresAttachment: boolean;
  allowHalfDay: boolean;
};

/** The active leave types (bounded by design — org config, not growth data). */
export async function listLeaveTypes(ctx: Ctx): Promise<LeaveTypeRow[]> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, key, label, paid, requires_attachment, allow_half_day
      from public.leave_type
      where org_id = ${ctx.orgId} and active
      order by sort, key
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const label = r.label as { en?: string; ar?: string };
    return {
      id: r.id as string,
      key: r.key as string,
      labelEn: label.en ?? (r.key as string),
      labelAr: label.ar ?? label.en ?? (r.key as string),
      paid: r.paid === true,
      requiresAttachment: r.requires_attachment === true,
      allowHalfDay: r.allow_half_day === true,
    };
  });
}
