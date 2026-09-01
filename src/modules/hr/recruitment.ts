/**
 * H23B — recruitment and offboarding.
 *
 * A deliberately compact pipeline: requisition → candidate → interview → offer
 * → employee, whose whole reason to exist is the last arrow. Accepting an offer
 * creates the employee, the first compensation row, the contract shell and the
 * employment history in ONE transaction, so nobody ever retypes a person the
 * org already interviewed.
 *
 * Offboarding is the checklist that protects the exit: outstanding assets from
 * the H22E register (read-only — returning them is still the asset module's
 * job), access revocation, settlement inputs, handovers.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import type { RoleArchetype } from "@/platform/registries";
import { HrError, ensureEmployeeNumber } from "./people";

// ── requisitions and candidates ──────────────────────────────────────────────

export async function createRequisition(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "employees.manage");
  const input = z
    .object({
      title: z.string().trim().min(1).max(160),
      departmentId: z.string().uuid().optional(),
      positionId: z.string().uuid().optional(),
      headcount: z.number().int().min(1).max(100).default(1),
      notes: z.string().trim().max(2000).optional(),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.requisition.create",
        entityType: "employee",
        entityId: r.id,
        summary: `Opened requisition ${r.reference}: ${input.title}`,
      }),
    },
    async (tx) => {
      const seq = await allocateReference(tx, ctx, "job_requisition");
      const reference = formatRef("REQ", seq);
      const rows = (await tx.execute(sql`
        insert into public.job_requisition
          (org_id, reference, title, department_id, position_id, headcount, notes, created_by)
        values (${ctx.orgId}, ${reference}, ${input.title}, ${input.departmentId ?? null},
                ${input.positionId ?? null}, ${input.headcount}, ${input.notes ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id, reference };
    },
  );
}

export async function addCandidate(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "employees.manage");
  const input = z
    .object({
      requisitionId: z.string().uuid(),
      name: z.string().trim().min(1).max(160),
      email: z.string().trim().email().max(160).optional(),
      phone: z.string().trim().max(32).optional(),
      notes: z.string().trim().max(4000).optional(),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.candidate.add",
        entityType: "employee",
        entityId: r.id,
        summary: `Added candidate ${input.name}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.candidate (org_id, requisition_id, name, email, phone, notes, created_by)
        values (${ctx.orgId}, ${input.requisitionId}, ${input.name}, ${input.email ?? null},
                ${input.phone ?? null}, ${input.notes ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

const STAGE_ORDER = ["applied", "screening", "interview", "offer", "hired"] as const;

export async function moveCandidate(
  ctx: Ctx,
  archetype: RoleArchetype,
  candidateId: string,
  stage: "screening" | "interview" | "offer" | "rejected" | "withdrawn",
): Promise<void> {
  assertCan(archetype, "employees.manage");
  await command(
    ctx,
    {
      audit: {
        action: "hr.candidate.move",
        entityType: "employee",
        entityId: candidateId,
        summary: `Candidate moved to ${stage}`,
      },
    },
    async (tx) => {
      const cur = (await tx.execute(sql`
        select stage from public.candidate
        where id = ${candidateId} and org_id = ${ctx.orgId} for update
      `)) as unknown as Array<{ stage: string }>;
      if (!cur[0]) throw new HrError("candidate not found", "not_found");
      if (cur[0].stage === "hired") {
        throw new HrError("a hired candidate's pipeline is closed", "invalid_state");
      }
      // Forward-only through the pipeline; rejected/withdrawn always allowed.
      if (stage !== "rejected" && stage !== "withdrawn") {
        const from = STAGE_ORDER.indexOf(cur[0].stage as (typeof STAGE_ORDER)[number]);
        const to = STAGE_ORDER.indexOf(stage);
        if (to <= from) {
          throw new HrError(
            `cannot move a candidate from ${cur[0].stage} to ${stage}`,
            "invalid_state",
          );
        }
      }
      await tx.execute(sql`
        update public.candidate set stage = ${stage}, updated_at = now()
        where id = ${candidateId} and org_id = ${ctx.orgId}
      `);
    },
  );
}

export async function recordInterview(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "employees.manage");
  const input = z
    .object({
      candidateId: z.string().uuid(),
      scheduledAt: z.string(),
      interviewerEmployeeId: z.string().uuid().optional(),
      kind: z.enum(["screening", "general", "technical", "final"]).default("general"),
      outcome: z.enum(["advance", "reject", "hold"]).optional(),
      feedback: z.string().trim().max(4000).optional(),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.interview.record",
        entityType: "employee",
        entityId: r.id,
        summary: `Recorded a ${input.kind} interview`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.candidate_interview
          (org_id, candidate_id, scheduled_at, interviewer_employee_id, kind, outcome, feedback, created_by)
        values (${ctx.orgId}, ${input.candidateId}, ${input.scheduledAt}::timestamptz,
                ${input.interviewerEmployeeId ?? null}, ${input.kind},
                ${input.outcome ?? null}, ${input.feedback ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

// ── offers (cost wall) ───────────────────────────────────────────────────────

export async function extendOffer(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "employees.terms.manage");
  const input = z
    .object({
      candidateId: z.string().uuid(),
      positionId: z.string().uuid().optional(),
      salaryMinor: z.number().int().min(0),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      probationMonths: z.number().int().min(0).max(6).optional(),
      notes: z.string().trim().max(2000).optional(),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.offer.extend",
        entityType: "employee",
        entityId: r.id,
        // Identifiers only, never the salary (§5.9).
        summary: "Extended an offer",
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.candidate_offer
          (org_id, candidate_id, position_id, salary_minor, start_date, probation_months,
           status, notes, created_by)
        values (${ctx.orgId}, ${input.candidateId}, ${input.positionId ?? null},
                ${input.salaryMinor}, ${input.startDate}, ${input.probationMonths ?? null},
                'extended', ${input.notes ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      await tx.execute(sql`
        update public.candidate set stage = 'offer', updated_at = now()
        where id = ${input.candidateId} and org_id = ${ctx.orgId}
          and stage not in ('hired', 'rejected', 'withdrawn')
      `);
      return { id: rows[0]!.id };
    },
  );
}

/**
 * The arrow the pipeline exists for: an accepted offer becomes an employee.
 *
 * One transaction creates the employee (with number), the hire compensation
 * row + terms projection, a draft contract carrying the offer's dates, marks
 * the candidate hired, and writes the employment history — no retyping.
 */
export async function acceptOfferAndHire(
  ctx: Ctx,
  archetype: RoleArchetype,
  offerId: string,
): Promise<{ employeeId: string; employeeNo: string; contractId: string }> {
  assertCan(archetype, "employees.terms.manage");
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "hr.offer.accept_hire",
        entityType: "employee",
        entityId: r.employeeId,
        summary: `Offer accepted; employee ${r.employeeNo} created`,
      }),
    },
    async (tx) => {
      const offers = (await tx.execute(sql`
        select o.id, o.candidate_id::text as candidate_id, o.position_id::text as position_id,
               o.salary_minor::text as salary_minor, o.start_date::text as start_date,
               o.probation_months, c.name, c.email, c.phone, c.requisition_id::text as req_id
        from public.candidate_offer o
        join public.candidate c on c.id = o.candidate_id and c.org_id = o.org_id
        where o.id = ${offerId} and o.org_id = ${ctx.orgId} and o.status = 'extended'
        for update of o
      `)) as unknown as Array<Record<string, string | number | null>>;
      const offer = offers[0];
      if (!offer) throw new HrError("only an extended offer can be accepted", "invalid_state");

      const emp = (await tx.execute(sql`
        insert into public.employee (org_id, name, email, phone, position_id, hire_date,
                                     probation_end_date, lifecycle, employment_type)
        values (${ctx.orgId}, ${offer.name}, ${offer.email ?? null}, ${offer.phone ?? null},
                ${offer.position_id ?? null}, ${offer.start_date}::date,
                case when ${offer.probation_months ?? null}::int is not null
                     then (${offer.start_date}::date + (${offer.probation_months ?? 0}::int * interval '1 month'))::date
                     else null end,
                'active', 'full_time')
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const employeeId = emp[0]!.id;
      const employeeNo = await ensureEmployeeNumber(tx, ctx, employeeId);

      const salary = Number(offer.salary_minor);
      await tx.execute(sql`
        insert into public.employee_compensation
          (org_id, employee_id, effective_date, salary_minor, hourly_cost_minor, ot_rate,
           reason, created_by)
        values (${ctx.orgId}, ${employeeId}, ${offer.start_date}::date, ${salary},
                ${Math.round(salary / 208)}, 1.25, 'hire', ${ctx.userId})
      `);
      await tx.execute(sql`
        insert into public.employee_terms (employee_id, org_id, salary_minor, hourly_cost_minor, ot_rate)
        values (${employeeId}, ${ctx.orgId}, ${salary}, ${Math.round(salary / 208)}, 1.25)
        on conflict (employee_id) do update
          set salary_minor = excluded.salary_minor,
              hourly_cost_minor = excluded.hourly_cost_minor,
              updated_at = now()
      `);

      const seq = await allocateReference(tx, ctx, "employee_contract");
      const contractNo = formatRef("CTR", seq);
      const contract = (await tx.execute(sql`
        insert into public.employee_contract
          (org_id, employee_id, contract_no, start_date, probation_months, created_by)
        values (${ctx.orgId}, ${employeeId}, ${contractNo}, ${offer.start_date}::date,
                ${offer.probation_months ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;

      await tx.execute(sql`
        update public.candidate_offer set status = 'accepted', updated_at = now()
        where id = ${offerId} and org_id = ${ctx.orgId}
      `);
      await tx.execute(sql`
        update public.candidate set stage = 'hired', hired_employee_id = ${employeeId}, updated_at = now()
        where id = ${offer.candidate_id} and org_id = ${ctx.orgId}
      `);
      await tx.execute(sql`
        insert into public.employee_event (org_id, employee_id, event, effective_date, detail, created_by)
        values (${ctx.orgId}, ${employeeId}, 'created', ${offer.start_date}::date,
                ${JSON.stringify({ via: "recruitment", requisition: offer.req_id })}::jsonb, ${ctx.userId})
      `);
      return { employeeId, employeeNo, contractId: contract[0]!.id };
    },
  );
}

// ── offboarding ──────────────────────────────────────────────────────────────

/**
 * Open the exit checklist: one row per asset the H22E register still shows in
 * the employee's custody, plus the standard items. Read-only toward assets.
 */
export async function openOffboarding(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
): Promise<{ created: number }> {
  assertCan(archetype, "employees.manage");
  return command(
    ctx,
    {
      audit: {
        action: "hr.offboarding.open",
        entityType: "employee",
        entityId: employeeId,
        summary: "Opened the offboarding checklist",
      },
    },
    async (tx) => {
      const existing = (await tx.execute(sql`
        select count(*)::int as n from public.offboarding_item
        where org_id = ${ctx.orgId} and employee_id = ${employeeId}
      `)) as unknown as Array<{ n: number }>;
      if (existing[0]!.n > 0) return { created: 0 };

      // Outstanding assets: the employee row's linked member holds custody.
      const held = (await tx.execute(sql`
        select a.id::text as id, a.asset_no, a.name_en
        from public.asset a
        join public.employee e on e.org_id = a.org_id and e.id = ${employeeId}
        where a.org_id = ${ctx.orgId} and a.custodian_user_id = e.user_id
          and e.user_id is not null and a.status not in ('retired', 'disposed')
        limit 100
      `)) as unknown as Array<{ id: string; asset_no: string; name_en: string }>;

      let created = 0;
      for (const a of held) {
        await tx.execute(sql`
          insert into public.offboarding_item
            (org_id, employee_id, kind, title, asset_id, created_by)
          values (${ctx.orgId}, ${employeeId}, 'asset_return',
                  ${`Return ${a.asset_no} — ${a.name_en}`}, ${a.id}, ${ctx.userId})
        `);
        created++;
      }
      for (const [kind, title] of [
        ["access_revocation", "Revoke application and system access"],
        ["final_settlement_inputs", "Record final settlement inputs"],
        ["document_handover", "Collect company documents"],
        ["exit_interview", "Exit interview"],
      ] as const) {
        await tx.execute(sql`
          insert into public.offboarding_item (org_id, employee_id, kind, title, created_by)
          values (${ctx.orgId}, ${employeeId}, ${kind}, ${title}, ${ctx.userId})
        `);
        created++;
      }
      return { created };
    },
  );
}

export async function completeOffboardingItem(
  ctx: Ctx,
  archetype: RoleArchetype,
  itemId: string,
  note?: string,
): Promise<void> {
  assertCan(archetype, "employees.manage");
  await command(
    ctx,
    {
      audit: {
        action: "hr.offboarding.complete_item",
        entityType: "employee",
        entityId: itemId,
        summary: "Completed an offboarding item",
      },
    },
    (tx) =>
      tx.execute(sql`
        update public.offboarding_item
        set done_at = now(), done_by = ${ctx.userId}, note = coalesce(${note ?? null}, note)
        where id = ${itemId} and org_id = ${ctx.orgId} and done_at is null
      `),
  );
}

export async function listOffboarding(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
): Promise<
  Array<{ id: string; kind: string; title: string; doneAt: string | null; note: string | null }>
> {
  assertCan(archetype, "employees.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, kind, title, done_at::text as done_at, note
      from public.offboarding_item
      where org_id = ${ctx.orgId} and employee_id = ${employeeId}
      order by done_at nulls first, created_at
      limit 200
    `),
  )) as unknown as Array<Record<string, string | null>>;
  return rows.map((r) => ({
    id: r.id!,
    kind: r.kind!,
    title: r.title!,
    doneAt: r.done_at ?? null,
    note: r.note ?? null,
  }));
}
