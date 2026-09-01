/**
 * H23A — the people foundation service.
 *
 * Extends the canonical employee model from S1 (masters). Nothing here creates
 * a second person concept: the employee row is still the person, employee_terms
 * is still the current wage projection, and the walls are the two the database
 * already enforces — cost privilege for money, owner/admin for identity.
 *
 * The one structural addition is HISTORY. A compensation change writes an
 * effective-dated row (the payroll source of truth) AND updates employee_terms
 * in the same transaction, so costing keeps reading what it always has and the
 * two can never disagree. Every lifecycle change leaves an append-only
 * employee_event; the database refuses to edit or delete one.
 *
 * Audit rows about pay carry identifiers only, never amounts (§5.9).
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import type { RoleArchetype } from "@/platform/registries";

export class HrError extends Error {
  constructor(
    message: string,
    public readonly code:
      "not_found" | "invalid_state" | "duplicate" | "not_linked" | "forbidden" = "invalid_state",
  ) {
    super(message);
    this.name = "HrError";
  }
}

// ── organizational structure ─────────────────────────────────────────────────

const StructureNameInput = z.object({
  nameEn: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
});

export async function createDepartment(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "employees.manage");
  const input = StructureNameInput.extend({
    parentId: z.string().uuid().optional(),
    code: z.string().trim().max(24).optional(),
    costCentre: z.string().trim().max(60).optional(),
  }).parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.department.create",
        entityType: "employee",
        entityId: r.id,
        summary: `Created department ${input.nameEn}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.department (org_id, parent_id, name_en, name_ar, code, cost_centre)
        values (${ctx.orgId}, ${input.parentId ?? null}, ${input.nameEn},
                ${input.nameAr ?? null}, ${input.code ?? null}, ${input.costCentre ?? null})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export async function createPosition(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "employees.manage");
  const input = StructureNameInput.extend({
    departmentId: z.string().uuid().optional(),
    grade: z.string().trim().max(40).optional(),
  }).parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.position.create",
        entityType: "employee",
        entityId: r.id,
        summary: `Created position ${input.nameEn}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.position (org_id, name_en, name_ar, department_id, grade)
        values (${ctx.orgId}, ${input.nameEn}, ${input.nameAr ?? null},
                ${input.departmentId ?? null}, ${input.grade ?? null})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export async function createWorkLocation(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "employees.manage");
  const input = StructureNameInput.extend({
    address: z.string().trim().max(400).optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  }).parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.location.create",
        entityType: "employee",
        entityId: r.id,
        summary: `Created work location ${input.nameEn}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.work_location (org_id, name_en, name_ar, address, country)
        values (${ctx.orgId}, ${input.nameEn}, ${input.nameAr ?? null},
                ${input.address ?? null}, ${input.country ?? null})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export type StructureRow = {
  id: string;
  nameEn: string;
  nameAr: string | null;
  active: boolean;
};

export async function listStructure(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<{ departments: StructureRow[]; positions: StructureRow[]; locations: StructureRow[] }> {
  assertCan(archetype, "employees.view");
  return withCtx(ctx, async (tx) => {
    const read = async (table: "department" | "position" | "work_location") =>
      (
        (await tx.execute(sql`
        select id::text as id, name_en, name_ar, active
        from ${sql.raw(`public.${table}`)}
        where org_id = ${ctx.orgId}
        order by active desc, sort, name_en
        limit 500
      `)) as unknown as Array<Record<string, unknown>>
      ).map((r) => ({
        id: r.id as string,
        nameEn: r.name_en as string,
        nameAr: (r.name_ar as string | null) ?? null,
        active: r.active as boolean,
      }));
    return {
      departments: await read("department"),
      positions: await read("position"),
      locations: await read("work_location"),
    };
  });
}

// ── the extended profile ─────────────────────────────────────────────────────

export const EmployeeProfileInput = z.object({
  legalName: z.string().trim().max(160).optional(),
  nameAr: z.string().trim().max(160).optional(),
  email: z.string().trim().email().max(160).optional(),
  phone: z.string().trim().max(32).optional(),
  emergencyContactName: z.string().trim().max(160).optional(),
  emergencyContactPhone: z.string().trim().max(32).optional(),
  emergencyContactRelation: z.string().trim().max(60).optional(),
  nationality: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  residencyStatus: z.enum(["citizen", "resident", "work_permit", "visitor", "other"]).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  positionId: z.string().uuid().nullable().optional(),
  workLocationId: z.string().uuid().nullable().optional(),
  costCentre: z.string().trim().max(60).nullable().optional(),
  managerEmployeeId: z.string().uuid().nullable().optional(),
  employmentType: z
    .enum(["full_time", "part_time", "contractor", "intern", "temporary", "other"])
    .optional(),
  hireDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  probationEndDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});
export type EmployeeProfileInput = z.infer<typeof EmployeeProfileInput>;

/**
 * Give an employee their stable number and extended profile.
 *
 * The number is allocated once, from the org's own sequence (EMP-001…), and is
 * never reused: an archived employee keeps their number forever.
 */
export async function ensureEmployeeNumber(tx: TenantTx, ctx: Ctx, employeeId: string) {
  const rows = (await tx.execute(sql`
    select employee_no from public.employee
    where id = ${employeeId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ employee_no: string | null }>;
  if (!rows[0]) throw new HrError("employee not found", "not_found");
  if (rows[0].employee_no) return rows[0].employee_no;
  const seq = await allocateReference(tx, ctx, "employee_no");
  const no = formatRef("EMP", seq);
  await tx.execute(sql`
    update public.employee set employee_no = ${no}, updated_at = now()
    where id = ${employeeId} and org_id = ${ctx.orgId}
  `);
  return no;
}

export async function updateEmployeeProfile(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "employees.manage");
  const p = EmployeeProfileInput.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "hr.profile.update",
        entityType: "employee",
        entityId: employeeId,
        summary: "Updated employee profile",
      },
    },
    async (tx) => {
      await ensureEmployeeNumber(tx, ctx, employeeId);
      await tx.execute(sql`
        update public.employee set
          legal_name = coalesce(${p.legalName ?? null}, legal_name),
          name_ar = coalesce(${p.nameAr ?? null}, name_ar),
          email = coalesce(${p.email ?? null}, email),
          phone = coalesce(${p.phone ?? null}, phone),
          emergency_contact_name = coalesce(${p.emergencyContactName ?? null}, emergency_contact_name),
          emergency_contact_phone = coalesce(${p.emergencyContactPhone ?? null}, emergency_contact_phone),
          emergency_contact_relation = coalesce(${p.emergencyContactRelation ?? null}, emergency_contact_relation),
          nationality = coalesce(${p.nationality ?? null}, nationality),
          residency_status = coalesce(${p.residencyStatus ?? null}, residency_status),
          department_id = case when ${p.departmentId !== undefined} then ${p.departmentId ?? null} else department_id end,
          position_id = case when ${p.positionId !== undefined} then ${p.positionId ?? null} else position_id end,
          work_location_id = case when ${p.workLocationId !== undefined} then ${p.workLocationId ?? null} else work_location_id end,
          cost_centre = case when ${p.costCentre !== undefined} then ${p.costCentre ?? null} else cost_centre end,
          manager_employee_id = case when ${p.managerEmployeeId !== undefined} then ${p.managerEmployeeId ?? null} else manager_employee_id end,
          employment_type = coalesce(${p.employmentType ?? null}, employment_type),
          hire_date = coalesce(${p.hireDate ?? null}, hire_date),
          probation_end_date = case when ${p.probationEndDate !== undefined} then ${p.probationEndDate ?? null} else probation_end_date end,
          updated_at = now()
        where id = ${employeeId} and org_id = ${ctx.orgId}
      `);
    },
  );
}

// ── lifecycle ────────────────────────────────────────────────────────────────

const LIFECYCLE_EVENT: Record<string, string> = {
  active: "activated",
  suspended: "suspended",
  notice: "notice_given",
  terminated: "terminated",
  archived: "archived",
};

export const LifecycleInput = z.object({
  to: z.enum(["active", "suspended", "notice", "terminated", "archived"]),
  effectiveDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  finalWorkingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Move an employee through the lifecycle. The database trigger is the law on
 * which moves are legal; this records the event and keeps the dates coherent.
 * Withdrawing notice is `to: "active"` from `notice` — the trigger allows it
 * and the event log says `notice_withdrawn` so history reads honestly.
 */
export async function transitionEmployee(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "employees.manage");
  const input = LifecycleInput.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "hr.lifecycle.transition",
        entityType: "employee",
        entityId: employeeId,
        summary: `Employee moved to ${input.to}`,
      },
    },
    async (tx) => {
      const cur = (await tx.execute(sql`
        select lifecycle from public.employee
        where id = ${employeeId} and org_id = ${ctx.orgId}
        for update
      `)) as unknown as Array<{ lifecycle: string }>;
      if (!cur[0]) throw new HrError("employee not found", "not_found");
      const from = cur[0].lifecycle;

      await tx.execute(sql`
        update public.employee set
          lifecycle = ${input.to},
          notice_date = case when ${input.to} = 'notice' then coalesce(${input.effectiveDate ?? null}::date, current_date) else notice_date end,
          end_date = case when ${input.to} = 'terminated' then coalesce(${input.endDate ?? null}::date, current_date) else end_date end,
          final_working_date = coalesce(${input.finalWorkingDate ?? null}::date, final_working_date),
          updated_at = now()
        where id = ${employeeId} and org_id = ${ctx.orgId}
      `);

      const event =
        from === "notice" && input.to === "active"
          ? "notice_withdrawn"
          : (LIFECYCLE_EVENT[input.to] ?? "note");
      await tx.execute(sql`
        insert into public.employee_event (org_id, employee_id, event, effective_date, detail, created_by)
        values (${ctx.orgId}, ${employeeId}, ${event},
                coalesce(${input.effectiveDate ?? null}::date, current_date),
                ${JSON.stringify({ from, to: input.to, reason: input.reason ?? null })}::jsonb,
                ${ctx.userId})
      `);
    },
  );
}

/** Confirm an employee after probation — a date plus its history event. */
export async function confirmEmployee(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
  confirmationDate?: string,
): Promise<void> {
  assertCan(archetype, "employees.manage");
  await command(
    ctx,
    {
      audit: {
        action: "hr.probation.confirm",
        entityType: "employee",
        entityId: employeeId,
        summary: "Employee confirmed after probation",
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.employee
        set confirmation_date = coalesce(${confirmationDate ?? null}::date, current_date),
            updated_at = now()
        where id = ${employeeId} and org_id = ${ctx.orgId} and lifecycle = 'active'
      `);
      await tx.execute(sql`
        insert into public.employee_event (org_id, employee_id, event, effective_date, created_by)
        values (${ctx.orgId}, ${employeeId}, 'confirmed',
                coalesce(${confirmationDate ?? null}::date, current_date), ${ctx.userId})
      `);
    },
  );
}

// ── compensation (cost wall) ─────────────────────────────────────────────────

export const CompensationChangeInput = z.object({
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  salaryMinor: z.number().int().min(0),
  hourlyCostMinor: z.number().int().min(0).optional(),
  otRate: z.number().min(0).max(10).optional(),
  reason: z
    .enum(["hire", "annual_review", "promotion", "adjustment", "correction", "transfer"])
    .default("adjustment"),
  note: z.string().trim().max(500).optional(),
});

/**
 * Record a compensation change, effective from a date.
 *
 * Writes the append-only history row (payroll's source of truth) AND, when the
 * change is current or past, updates employee_terms — the projection costing
 * reads — in the same transaction. A future-dated change leaves terms alone
 * until it takes effect (payroll reads the history by date; costing follows the
 * projection, which the next current-dated write refreshes).
 */
export async function recordCompensationChange(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "employees.terms.manage");
  const input = CompensationChangeInput.parse(raw);
  const hourly = input.hourlyCostMinor ?? Math.round(input.salaryMinor / 208);
  const ot = input.otRate ?? 1.25;
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.compensation.change",
        entityType: "employee",
        entityId: employeeId,
        // Identifiers and dates only — NEVER amounts (§5.9).
        summary: `Recorded a compensation change effective ${input.effectiveDate}`,
        after: { compensationId: r.id },
      }),
    },
    async (tx) => {
      // Supersede a live row on the same effective date (a correction).
      await tx.execute(sql`
        update public.employee_compensation
        set superseded_at = now()
        where org_id = ${ctx.orgId} and employee_id = ${employeeId}
          and effective_date = ${input.effectiveDate} and superseded_at is null
      `);
      const rows = (await tx.execute(sql`
        insert into public.employee_compensation
          (org_id, employee_id, effective_date, salary_minor, hourly_cost_minor,
           ot_rate, reason, note, created_by)
        values (${ctx.orgId}, ${employeeId}, ${input.effectiveDate}, ${input.salaryMinor},
                ${hourly}, ${ot}, ${input.reason}, ${input.note ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;

      // The current projection follows the LATEST effective row not in the future.
      await tx.execute(sql`
        insert into public.employee_terms (employee_id, org_id, salary_minor, hourly_cost_minor, ot_rate)
        select c.employee_id, c.org_id, c.salary_minor, c.hourly_cost_minor, c.ot_rate
        from public.employee_compensation c
        where c.org_id = ${ctx.orgId} and c.employee_id = ${employeeId}
          and c.superseded_at is null and c.effective_date <= current_date
        order by c.effective_date desc limit 1
        on conflict (employee_id) do update
          set salary_minor = excluded.salary_minor,
              hourly_cost_minor = excluded.hourly_cost_minor,
              ot_rate = excluded.ot_rate,
              updated_at = now()
      `);

      await tx.execute(sql`
        insert into public.employee_event (org_id, employee_id, event, effective_date, detail, created_by)
        values (${ctx.orgId}, ${employeeId}, 'compensation_changed', ${input.effectiveDate},
                ${JSON.stringify({ reason: input.reason })}::jsonb, ${ctx.userId})
      `);
      return { id: rows[0]!.id };
    },
  );
}

/** The compensation history, cost wall enforced by RLS (empty for the unprivileged). */
export async function listCompensationHistory(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
): Promise<
  Array<{
    id: string;
    effectiveDate: string;
    salaryMinor: number;
    hourlyCostMinor: number;
    otRate: string;
    reason: string;
    supersededAt: string | null;
  }>
> {
  assertCan(archetype, "employees.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, effective_date::text as effective_date,
             salary_minor::text as salary_minor, hourly_cost_minor::text as hourly_cost_minor,
             ot_rate::text as ot_rate, reason, superseded_at::text as superseded_at
      from public.employee_compensation
      where org_id = ${ctx.orgId} and employee_id = ${employeeId}
      order by effective_date desc, created_at desc
      limit 200
    `),
  )) as unknown as Array<Record<string, string | null>>;
  return rows.map((r) => ({
    id: r.id!,
    effectiveDate: r.effective_date!,
    salaryMinor: Number(r.salary_minor),
    hourlyCostMinor: Number(r.hourly_cost_minor),
    otRate: r.ot_rate!,
    reason: r.reason!,
    supersededAt: r.superseded_at ?? null,
  }));
}

// ── contracts ────────────────────────────────────────────────────────────────

export const ContractInput = z.object({
  contractType: z
    .enum(["fixed_term", "part_time_contract", "temporary_contract", "other"])
    .default("fixed_term"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  probationMonths: z.number().int().min(0).max(6).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export async function createContract(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
  raw: unknown,
): Promise<{ id: string; contractNo: string }> {
  assertCan(archetype, "employees.manage");
  const input = ContractInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.contract.create",
        entityType: "employee",
        entityId: employeeId,
        summary: `Created contract ${r.contractNo}`,
      }),
    },
    async (tx) => {
      const seq = await allocateReference(tx, ctx, "employee_contract");
      const contractNo = formatRef("CTR", seq);
      const rows = (await tx.execute(sql`
        insert into public.employee_contract
          (org_id, employee_id, contract_no, contract_type, start_date, end_date,
           probation_months, notes, created_by)
        values (${ctx.orgId}, ${employeeId}, ${contractNo}, ${input.contractType},
                ${input.startDate}, ${input.endDate ?? null},
                ${input.probationMonths ?? null}, ${input.notes ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id, contractNo };
    },
  );
}

/** Issue, then record acceptance. Terms freeze at issue (DB trigger). */
export async function issueContract(
  ctx: Ctx,
  archetype: RoleArchetype,
  contractId: string,
): Promise<void> {
  assertCan(archetype, "employees.manage");
  await command(
    ctx,
    {
      audit: {
        action: "hr.contract.issue",
        entityType: "employee",
        entityId: contractId,
        summary: "Issued employment contract",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.employee_contract
        set status = 'issued', issued_at = now(), updated_at = now()
        where id = ${contractId} and org_id = ${ctx.orgId} and status = 'draft'
        returning employee_id::text as employee_id
      `)) as unknown as Array<{ employee_id: string }>;
      if (!rows[0]) throw new HrError("only a draft contract can be issued", "invalid_state");
      await tx.execute(sql`
        insert into public.employee_event (org_id, employee_id, event, created_by)
        values (${ctx.orgId}, ${rows[0].employee_id}, 'contract_issued', ${ctx.userId})
      `);
    },
  );
}

export async function recordContractAcceptance(
  ctx: Ctx,
  archetype: RoleArchetype,
  contractId: string,
  channel: "signed_paper" | "in_app" | "email" | "other",
): Promise<void> {
  assertCan(archetype, "employees.manage");
  await command(
    ctx,
    {
      audit: {
        action: "hr.contract.accept",
        entityType: "employee",
        entityId: contractId,
        summary: `Recorded contract acceptance (${channel})`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.employee_contract
        set status = 'accepted', accepted_at = now(), accepted_channel = ${channel},
            updated_at = now()
        where id = ${contractId} and org_id = ${ctx.orgId} and status = 'issued'
        returning employee_id::text as employee_id
      `)) as unknown as Array<{ employee_id: string }>;
      if (!rows[0]) throw new HrError("only an issued contract can be accepted", "invalid_state");
      await tx.execute(sql`
        insert into public.employee_event (org_id, employee_id, event, created_by)
        values (${ctx.orgId}, ${rows[0].employee_id}, 'contract_accepted', ${ctx.userId})
      `);
    },
  );
}

// ── the profile read (tiered by wall) ────────────────────────────────────────

export type EmployeeFullProfile = {
  id: string;
  employeeNo: string | null;
  name: string;
  legalName: string | null;
  nameAr: string | null;
  email: string | null;
  phone: string | null;
  lifecycle: string;
  employmentType: string;
  hireDate: string | null;
  probationEndDate: string | null;
  confirmationDate: string | null;
  endDate: string | null;
  departmentName: string | null;
  positionName: string | null;
  locationName: string | null;
  managerName: string | null;
  costCentre: string | null;
  nationality: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  linkedUserId: string | null;
  events: Array<{ event: string; effectiveDate: string; detail: unknown }>;
  contracts: Array<{
    id: string;
    contractNo: string;
    contractType: string;
    startDate: string;
    endDate: string | null;
    status: string;
  }>;
};

export async function getEmployeeProfile(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
): Promise<EmployeeFullProfile | null> {
  // Managers and above read anyone; a linked member may read THEMSELF.
  const canOrgWide = ["owner", "admin", "manager", "accounts"].includes(archetype);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select e.id::text as id, e.employee_no, e.name, e.legal_name, e.name_ar,
             e.email, e.phone, e.lifecycle, e.employment_type,
             e.hire_date::text as hire_date, e.probation_end_date::text as probation_end_date,
             e.confirmation_date::text as confirmation_date, e.end_date::text as end_date,
             e.cost_centre, e.nationality,
             e.emergency_contact_name, e.emergency_contact_phone,
             e.user_id::text as user_id,
             d.name_en as department_name, p.name_en as position_name,
             w.name_en as location_name, m.name as manager_name
      from public.employee e
      left join public.department d on d.id = e.department_id and d.org_id = e.org_id
      left join public.position p on p.id = e.position_id and p.org_id = e.org_id
      left join public.work_location w on w.id = e.work_location_id and w.org_id = e.org_id
      left join public.employee m on m.id = e.manager_employee_id and m.org_id = e.org_id
      where e.id = ${employeeId} and e.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, string | null>>;
    const e = rows[0];
    if (!e) return null;
    if (!canOrgWide && e.user_id !== ctx.userId) return null;

    const events = (await tx.execute(sql`
      select event, effective_date::text as effective_date, detail
      from public.employee_event
      where org_id = ${ctx.orgId} and employee_id = ${employeeId}
      order by effective_date desc, created_at desc
      limit 100
    `)) as unknown as Array<{ event: string; effective_date: string; detail: unknown }>;

    const contracts = (await tx.execute(sql`
      select id::text as id, contract_no, contract_type,
             start_date::text as start_date, end_date::text as end_date, status
      from public.employee_contract
      where org_id = ${ctx.orgId} and employee_id = ${employeeId}
      order by start_date desc
      limit 50
    `)) as unknown as Array<Record<string, string | null>>;

    return {
      id: e.id!,
      employeeNo: e.employee_no ?? null,
      name: e.name!,
      legalName: e.legal_name ?? null,
      nameAr: e.name_ar ?? null,
      email: e.email ?? null,
      phone: e.phone ?? null,
      lifecycle: e.lifecycle!,
      employmentType: e.employment_type!,
      hireDate: e.hire_date ?? null,
      probationEndDate: e.probation_end_date ?? null,
      confirmationDate: e.confirmation_date ?? null,
      endDate: e.end_date ?? null,
      departmentName: e.department_name ?? null,
      positionName: e.position_name ?? null,
      locationName: e.location_name ?? null,
      managerName: e.manager_name ?? null,
      costCentre: e.cost_centre ?? null,
      nationality: e.nationality ?? null,
      emergencyContactName: e.emergency_contact_name ?? null,
      emergencyContactPhone: e.emergency_contact_phone ?? null,
      linkedUserId: e.user_id ?? null,
      events: events.map((x) => ({
        event: x.event,
        effectiveDate: x.effective_date,
        detail: x.detail,
      })),
      contracts: contracts.map((c) => ({
        id: c.id!,
        contractNo: c.contract_no!,
        contractType: c.contract_type!,
        startDate: c.start_date!,
        endDate: c.end_date ?? null,
        status: c.status!,
      })),
    };
  });
}

/** Link (or unlink) an employee to a member login — the surface 0020 deferred. */
export async function linkEmployeeToMember(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
  userId: string | null,
): Promise<void> {
  assertCan(archetype, "employees.manage");
  await command(
    ctx,
    {
      audit: {
        action: "hr.link.member",
        entityType: "employee",
        entityId: employeeId,
        summary: userId ? "Linked employee to a member login" : "Unlinked employee from login",
      },
    },
    async (tx) => {
      if (userId) {
        const member = (await tx.execute(sql`
          select 1 from public.membership
          where org_id = ${ctx.orgId} and user_id = ${userId} and deactivated_at is null
        `)) as unknown as unknown[];
        if (member.length === 0) {
          throw new HrError(
            "that person is not an active member of this organization",
            "not_linked",
          );
        }
      }
      await tx.execute(sql`
        update public.employee set user_id = ${userId}, updated_at = now()
        where id = ${employeeId} and org_id = ${ctx.orgId}
      `);
    },
  );
}

/** The caller's own employee row, or null when they are not one. */
export async function myEmployee(
  ctx: Ctx,
): Promise<{ id: string; name: string; employeeNo: string | null } | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, employee_no from public.employee
      where org_id = ${ctx.orgId} and user_id = ${ctx.userId}
    `),
  )) as unknown as Array<{ id: string; name: string; employee_no: string | null }>;
  const r = rows[0];
  return r ? { id: r.id, name: r.name, employeeNo: r.employee_no } : null;
}
