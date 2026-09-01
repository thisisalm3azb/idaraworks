/**
 * H23D — the payroll run lifecycle.
 *
 * draft → review (calculate) → awaiting_approval (engine) → approved →
 * finalized (locks + issues payslips), with the status machine ALSO enforced by
 * a database trigger so no code path can bend it. Finalization runs under an
 * advisory lock and a guarded transition, so two users finalizing the same run
 * produce exactly one finalized run and one clean error.
 *
 * Calculation reads: compensation history (effective at period end), recurring
 * components, approved overtime, unpaid-leave days from the leave ledger's
 * types, reasoned adjustments, claim reimbursements, loan installments, and the
 * versioned country pack — and snapshots ALL of it per line. Audit summaries
 * carry identifiers and counts, never amounts (§5.9).
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { requireCapability } from "@/platform/entitlements";
import type { RoleArchetype } from "@/platform/registries";
import { submitForApproval, supersedeApprovalsForSubjectIn } from "@/modules/approvals/service";
import { HrError } from "@/modules/hr/service";
import { getDocumentProfile } from "@/modules/branding/service";
import { captureIssuerSnapshot } from "@/platform/documents/issuer";
import { AE_PACK } from "./packs/ae";
import type { CountryPack } from "./packs/types";
import { calculateLine, calculateGratuity, type EngineInputs } from "./engine";

const PACKS: Record<string, CountryPack> = { AE: AE_PACK };

/** The pack for an org: its country when we ship one, else null (no claims). */
export function packFor(country: string | null): CountryPack | null {
  return country ? (PACKS[country] ?? null) : null;
}

// ── groups and periods ───────────────────────────────────────────────────────

export async function createPayGroup(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "payroll.manage");
  const input = z
    .object({
      nameEn: z.string().trim().min(1).max(120),
      nameAr: z.string().trim().max(120).optional(),
      frequency: z.enum(["monthly", "weekly", "biweekly", "custom"]).default("monthly"),
      roundingMinor: z.union([
        z.literal(1), z.literal(5), z.literal(10), z.literal(25), z.literal(50), z.literal(100),
      ]).default(1),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "payroll.group.create",
        entityType: "pay_run",
        entityId: r.id,
        summary: `Created pay group ${input.nameEn}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.pay_group (org_id, name_en, name_ar, frequency, rounding_minor)
        values (${ctx.orgId}, ${input.nameEn}, ${input.nameAr ?? null},
                ${input.frequency}, ${input.roundingMinor})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

async function ensurePeriod(
  tx: TenantTx,
  ctx: Ctx,
  payGroupId: string,
  periodStart: string,
  periodEnd: string,
): Promise<string> {
  const rows = (await tx.execute(sql`
    insert into public.pay_period (org_id, pay_group_id, period_start, period_end)
    values (${ctx.orgId}, ${payGroupId}, ${periodStart}, ${periodEnd})
    on conflict (org_id, pay_group_id, period_start) do update set period_end = excluded.period_end
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

// ── the run ──────────────────────────────────────────────────────────────────

export async function createPayRun(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "payroll.manage");
  const input = z
    .object({
      payGroupId: z.string().uuid(),
      periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      runKind: z.enum(["regular", "off_cycle", "final_settlement", "reversal"]).default("regular"),
      reversesRunId: z.string().uuid().optional(),
    })
    .parse(raw);
  await requireCapability(ctx, "cap.payroll");
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "payroll.run.create",
        entityType: "pay_run",
        entityId: r.id,
        summary: `Created pay run ${r.reference}`,
      }),
    },
    async (tx) => {
      const org = (await tx.execute(sql`
        select country, base_currency from public.org where id = ${ctx.orgId}
      `)) as unknown as Array<{ country: string | null; base_currency: string }>;
      const pack = packFor(org[0]?.country ?? null);
      const periodId = await ensurePeriod(tx, ctx, input.payGroupId, input.periodStart, input.periodEnd);
      const seq = await allocateReference(tx, ctx, "pay_run");
      const reference = formatRef("PAY", seq);
      const rows = (await tx.execute(sql`
        insert into public.pay_run
          (org_id, pay_group_id, period_id, reference, run_kind, reverses_run_id,
           pack_version, currency, created_by)
        values (${ctx.orgId}, ${input.payGroupId}, ${periodId}, ${reference},
                ${input.runKind}, ${input.reversesRunId ?? null},
                ${pack?.version ?? "core-unpacked"}, ${org[0]!.base_currency}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id, reference };
    },
  );
}

/** Gather every input for one employee — each read is stated, none inferred. */
async function inputsFor(
  tx: TenantTx,
  ctx: Ctx,
  employee: { id: string; name: string; nationality: string | null },
  periodStart: string,
  periodEnd: string,
  runId: string,
  pack: CountryPack | null,
): Promise<EngineInputs> {
  const comp = (await tx.execute(sql`
    select salary_minor::text as s, hourly_cost_minor::text as h, ot_rate::text as ot
    from public.employee_compensation
    where org_id = ${ctx.orgId} and employee_id = ${employee.id}
      and superseded_at is null and effective_date <= ${periodEnd}::date
    order by effective_date desc limit 1
  `)) as unknown as Array<{ s: string; h: string; ot: string }>;

  const recurring = (await tx.execute(sql`
    select d.key, d.label, d.kind, d.calc, d.percent::text as percent,
           c.amount_minor::text as amount
    from public.employee_pay_component c
    join public.pay_component_def d on d.id = c.component_id and d.org_id = c.org_id
    where c.org_id = ${ctx.orgId} and c.employee_id = ${employee.id}
      and d.active and d.recurring
      and c.effective_from <= ${periodEnd}::date
      and (c.effective_to is null or c.effective_to >= ${periodStart}::date)
  `)) as unknown as Array<Record<string, unknown>>;

  const ot = (await tx.execute(sql`
    select coalesce(sum(minutes), 0)::int as m from public.overtime_request
    where org_id = ${ctx.orgId} and employee_id = ${employee.id}
      and status = 'approved' and work_date between ${periodStart}::date and ${periodEnd}::date
  `)) as unknown as Array<{ m: number }>;

  // Unpaid leave: attendance days resolved from requests whose TYPE is unpaid.
  const unpaid = (await tx.execute(sql`
    select coalesce(count(*), 0)::int as d
    from public.attendance a
    join public.leave_request r on r.id::text = a.note and r.org_id = a.org_id
    join public.leave_type t on t.id = r.leave_type_id and t.org_id = r.org_id
    where a.org_id = ${ctx.orgId} and a.employee_id = ${employee.id}
      and a.source = 'leave_request' and t.paid = false
      and a.attendance_date between ${periodStart}::date and ${periodEnd}::date
  `)) as unknown as Array<{ d: number }>;

  const adjustments = (await tx.execute(sql`
    select kind, label, amount_minor::text as amount
    from public.payroll_adjustment
    where org_id = ${ctx.orgId} and employee_id = ${employee.id} and pay_run_id = ${runId}
  `)) as unknown as Array<Record<string, string>>;

  const reimbursements = (await tx.execute(sql`
    select id::text as id, reference, total_minor::text as amount
    from public.expense_claim
    where org_id = ${ctx.orgId} and employee_id = ${employee.id}
      and status = 'approved' and settlement_route = 'payroll' and settled_pay_run_id is null
  `)) as unknown as Array<Record<string, string>>;

  const loans = (await tx.execute(sql`
    select l.id::text as id, l.reference, l.installment_minor::text as inst,
           l.principal_minor::text as principal,
           coalesce((select sum(r.amount_minor) from public.loan_repayment r
                     where r.org_id = l.org_id and r.loan_id = l.id), 0)::text as repaid
    from public.employee_loan l
    where l.org_id = ${ctx.orgId} and l.employee_id = ${employee.id}
      and l.status = 'active' and l.starts_on <= ${periodEnd}::date
  `)) as unknown as Array<Record<string, string>>;

  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = new Date(`${periodEnd}T00:00:00Z`);
  const periodCalendarDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;

  return {
    employeeId: employee.id,
    employeeName: employee.name,
    nationality: employee.nationality,
    periodStart,
    periodEnd,
    basicMonthlyMinor: comp[0] ? Number(comp[0].s) : 0,
    otRate: comp[0] ? Number(comp[0].ot) : 1.25,
    hourlyDivisor: pack?.monthlyToHourlyDivisor ?? 208,
    recurring: recurring.map((r) => {
      const label = r.label as { en?: string; ar?: string };
      return {
        key: r.key as string,
        labelEn: label.en ?? (r.key as string),
        labelAr: label.ar ?? label.en ?? (r.key as string),
        kind: r.kind as "earning" | "deduction" | "employer_contribution",
        calc: r.calc as "fixed" | "percent_of_basic",
        amountMinor: r.amount == null ? null : Number(r.amount),
        percent: r.percent == null ? null : Number(r.percent),
      };
    }),
    overtimeMinutes: ot[0]?.m ?? 0,
    unpaidLeaveDays: unpaid[0]?.d ?? 0,
    periodCalendarDays,
    adjustments: adjustments.map((a) => ({
      label: a.label!,
      kind: a.kind as "earning" | "deduction",
      amountMinor: Number(a.amount),
    })),
    reimbursements: reimbursements.map((r) => ({
      claimId: r.id!,
      label: `Claim ${r.reference}`,
      amountMinor: Number(r.amount),
    })),
    loanInstallments: loans
      .map((l) => {
        const balance = Number(l.principal) - Number(l.repaid);
        const due = Math.min(Number(l.inst), Math.max(0, balance));
        return { loanId: l.id!, reference: l.reference!, amountMinor: due };
      })
      .filter((l) => l.amountMinor > 0),
  };
}

/**
 * Calculate (or recalculate) a run: wipe draft lines, compute one line per
 * active employee with pay, snapshot everything, total the run, and move it to
 * review. Recalculation is only possible in draft/review — the DB trigger
 * refuses to touch lines of anything later.
 */
export async function calculatePayRun(
  ctx: Ctx,
  archetype: RoleArchetype,
  runId: string,
): Promise<{ lines: number; exceptions: number }> {
  assertCan(archetype, "payroll.manage");
  if (!ctx.costPrivileged) throw new HrError("payroll requires cost privilege", "forbidden");
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "payroll.run.calculate",
        entityType: "pay_run",
        entityId: runId,
        summary: `Calculated pay run (${r.lines} line(s), ${r.exceptions} exception(s))`,
      }),
    },
    async (tx) => {
      await tx.execute(sql`
        select pg_advisory_xact_lock(hashtextextended(${`${ctx.orgId}:payrun:${runId}`}, 0))
      `);
      const runs = (await tx.execute(sql`
        select r.status, r.run_kind, r.pack_version, r.currency,
               p.period_start::text as ps, p.period_end::text as pe,
               g.rounding_minor, o.country
        from public.pay_run r
        join public.pay_period p on p.id = r.period_id and p.org_id = r.org_id
        join public.pay_group g on g.id = r.pay_group_id and g.org_id = r.org_id
        join public.org o on o.id = r.org_id
        where r.id = ${runId} and r.org_id = ${ctx.orgId}
        for update of r
      `)) as unknown as Array<Record<string, unknown>>;
      const run = runs[0];
      if (!run) throw new HrError("pay run not found", "not_found");
      if (run.status !== "draft" && run.status !== "review") {
        throw new HrError(`a ${run.status as string} run cannot be recalculated`, "invalid_state");
      }
      const pack = packFor((run.country as string | null) ?? null);

      await tx.execute(sql`
        delete from public.pay_run_line where org_id = ${ctx.orgId} and pay_run_id = ${runId}
      `);

      const employees = (await tx.execute(sql`
        select id::text as id, name, nationality from public.employee
        where org_id = ${ctx.orgId} and lifecycle in ('active', 'notice')
        order by name
        limit 2000
      `)) as unknown as Array<{ id: string; name: string; nationality: string | null }>;

      let gross = 0, ded = 0, employer = 0, net = 0, exceptionCount = 0, lines = 0;
      for (const emp of employees) {
        const inputs = await inputsFor(
          tx, ctx, emp, run.ps as string, run.pe as string, runId, pack,
        );
        if (inputs.basicMonthlyMinor === 0 && inputs.recurring.length === 0) {
          continue; // no pay set up — not an exception, simply not on this payroll
        }
        const result = calculateLine(inputs, pack ?? AE_PACK, Number(run.rounding_minor));
        // With no pack the AE floor validation is inert; record the honesty.
        const snapshot = {
          inputs,
          result: { components: result.components, working: result.working },
          packVersion: run.pack_version,
          calculatedBy: ctx.userId,
        };
        await tx.execute(sql`
          insert into public.pay_run_line
            (org_id, pay_run_id, employee_id, snapshot, gross_minor, deduction_minor,
             employer_minor, net_minor, exceptions)
          values (${ctx.orgId}, ${runId}, ${emp.id}, ${JSON.stringify(snapshot)}::jsonb,
                  ${result.grossMinor}, ${result.deductionMinor}, ${result.employerMinor},
                  ${result.netRoundedMinor}, ${JSON.stringify(result.exceptions)}::jsonb)
        `);
        gross += result.grossMinor;
        ded += result.deductionMinor;
        employer += result.employerMinor;
        net += result.netRoundedMinor;
        exceptionCount += result.exceptions.length;
        lines++;
      }

      await tx.execute(sql`
        update public.pay_run
        set status = 'review', gross_total_minor = ${gross}, deduction_total_minor = ${ded},
            employer_total_minor = ${employer}, net_total_minor = ${net},
            exception_count = ${exceptionCount}, calculated_at = now(), updated_at = now()
        where id = ${runId} and org_id = ${ctx.orgId} and status in ('draft', 'review')
      `);
      return { lines, exceptions: exceptionCount };
    },
  );
}

/** Send a reviewed run into the org's approval engine. */
export async function submitPayRunForApproval(
  ctx: Ctx,
  archetype: RoleArchetype,
  runId: string,
): Promise<{ decided: boolean }> {
  assertCan(archetype, "payroll.manage");
  return command(
    ctx,
    {
      audit: {
        action: "payroll.run.submit",
        entityType: "pay_run",
        entityId: runId,
        summary: "Submitted pay run for approval",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.pay_run set status = 'awaiting_approval', updated_at = now()
        where id = ${runId} and org_id = ${ctx.orgId} and status = 'review'
        returning reference, net_total_minor::text as net
      `)) as unknown as Array<{ reference: string; net: string }>;
      if (!rows[0]) throw new HrError("only a reviewed run can be submitted", "invalid_state");
      const res = await submitForApproval(tx, ctx, {
        subjectType: "pay_run",
        subjectId: runId,
        subjectSummary: { title: `Payroll ${rows[0].reference}` },
        amountMinor: Number(rows[0].net),
      });
      return { decided: res.decided };
    },
  );
}

/**
 * Finalize: the one-way door. Advisory lock + guarded transition = exactly one
 * winner under concurrency; payslips are issued inside the same transaction
 * with the org identity frozen; loan repayments post; claim reimbursements are
 * marked settled so nothing can pay them twice.
 */
export async function finalizePayRun(
  ctx: Ctx,
  archetype: RoleArchetype,
  runId: string,
): Promise<{ payslips: number }> {
  assertCan(archetype, "payroll.approve");
  if (!ctx.costPrivileged) throw new HrError("payroll requires cost privilege", "forbidden");
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "payroll.run.finalize",
        entityType: "pay_run",
        entityId: runId,
        summary: `Finalized pay run; ${r.payslips} payslip(s) issued`,
      }),
    },
    async (tx) => {
      await tx.execute(sql`
        select pg_advisory_xact_lock(hashtextextended(${`${ctx.orgId}:payrun:${runId}`}, 0))
      `);
      const won = (await tx.execute(sql`
        update public.pay_run
        set status = 'finalized', finalized_at = now(), finalized_by = ${ctx.userId},
            updated_at = now()
        where id = ${runId} and org_id = ${ctx.orgId} and status = 'approved'
        returning currency
      `)) as unknown as Array<{ currency: string }>;
      if (!won[0]) {
        throw new HrError("only an approved run can be finalized (or it already was)", "invalid_state");
      }

      /*
       * The org identity, captured through the SAME profile and snapshot shape
       * the quote/invoice issuance rule uses — one issuer concept, never a
       * payroll-local copy that could drift from the documents' law.
       */
      const profile = await getDocumentProfile(ctx);
      const issuer = captureIssuerSnapshot(profile.identity, new Date().toISOString());

      const period = (await tx.execute(sql`
        select p.period_start::text as ps, p.period_end::text as pe
        from public.pay_run r join public.pay_period p on p.id = r.period_id and p.org_id = r.org_id
        where r.id = ${runId} and r.org_id = ${ctx.orgId}
      `)) as unknown as Array<{ ps: string; pe: string }>;

      const lines = (await tx.execute(sql`
        select id::text as id, employee_id::text as employee_id, snapshot,
               net_minor::text as net
        from public.pay_run_line
        where org_id = ${ctx.orgId} and pay_run_id = ${runId}
        order by created_at
      `)) as unknown as Array<Record<string, unknown>>;

      // Every claim this run is about to pay must STILL be approved, payroll-
      // routed and unsettled — a claim snapshotted into two concurrently
      // calculated runs must not be paid by both (the loser recalculates).
      const claimIds: string[] = [];
      for (const line of lines) {
        const snapC = line.snapshot as {
          inputs?: { reimbursements?: Array<{ claimId?: string }> };
        };
        for (const r of snapC.inputs?.reimbursements ?? []) {
          if (r.claimId) claimIds.push(r.claimId);
        }
      }
      if (claimIds.length > 0) {
        const payable = (await tx.execute(sql`
          select count(*)::int as n from public.expense_claim
          where org_id = ${ctx.orgId}
            and id = any(${"{" + claimIds.join(",") + "}"}::uuid[])
            and status = 'approved' and settlement_route = 'payroll'
            and settled_pay_run_id is null
        `)) as unknown as Array<{ n: number }>;
        if ((payable[0]?.n ?? 0) !== claimIds.length) {
          throw new HrError(
            "a claim in this run was settled elsewhere since calculation — recalculate the run",
            "invalid_state",
          );
        }
      }

      let payslips = 0;
      for (const line of lines) {
        const seq = await allocateReference(tx, ctx, "payslip");
        const slipNo = formatRef("PSL", seq, 4);
        await tx.execute(sql`
          insert into public.payslip
            (org_id, pay_run_id, pay_run_line_id, employee_id, slip_no,
             issuer_snapshot, snapshot, net_minor, currency, period_start, period_end, issued_by)
          values (${ctx.orgId}, ${runId}, ${line.id as string}, ${line.employee_id as string},
                  ${slipNo}, ${JSON.stringify(issuer)}::jsonb, ${JSON.stringify(line.snapshot)}::jsonb,
                  ${Number(line.net)}, ${won[0]!.currency},
                  ${period[0]!.ps}::date, ${period[0]!.pe}::date, ${ctx.userId})
        `);
        payslips++;

        // Post loan repayments from the snapshot (append-only).
        const snap = line.snapshot as {
          inputs?: { loanInstallments?: Array<{ loanId: string; amountMinor: number }> };
        };
        for (const inst of snap.inputs?.loanInstallments ?? []) {
          await tx.execute(sql`
            insert into public.loan_repayment (org_id, loan_id, pay_run_id, amount_minor)
            values (${ctx.orgId}, ${inst.loanId}, ${runId}, ${inst.amountMinor})
          `);
          await tx.execute(sql`
            update public.employee_loan l set status = 'settled', updated_at = now()
            where l.org_id = ${ctx.orgId} and l.id = ${inst.loanId}
              and l.principal_minor <= coalesce((select sum(r.amount_minor)
                from public.loan_repayment r
                where r.org_id = l.org_id and r.loan_id = l.id), 0)
          `);
        }
      }

      // Stamp the verified claims settled — the no-double-pay latch.
      if (claimIds.length > 0) {
        await tx.execute(sql`
          update public.expense_claim
          set settled_pay_run_id = ${runId}, status = 'paid', updated_at = now()
          where org_id = ${ctx.orgId}
            and id = any(${"{" + claimIds.join(",") + "}"}::uuid[])
            and status = 'approved' and settlement_route = 'payroll'
            and settled_pay_run_id is null
        `);
      }

      return { payslips };
    },
  );
}

/**
 * Pull a submitted or approved (but NOT finalized) run back to review — the
 * legal path when finalize refuses because an input changed under it (e.g. a
 * claim settled elsewhere). Supersedes any still-pending approval.
 */
export async function reopenPayRun(
  ctx: Ctx,
  archetype: RoleArchetype,
  runId: string,
): Promise<void> {
  assertCan(archetype, "payroll.manage");
  return command(
    ctx,
    {
      audit: {
        action: "payroll.run.reopen",
        entityType: "pay_run",
        entityId: runId,
        summary: "Reopened pay run for recalculation",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.pay_run set status = 'review', updated_at = now()
        where id = ${runId} and org_id = ${ctx.orgId}
          and status in ('awaiting_approval', 'approved')
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) {
        throw new HrError("only a submitted or approved run can be reopened", "invalid_state");
      }
      await supersedeApprovalsForSubjectIn(tx, ctx, {
        subjectType: "pay_run",
        subjectId: runId,
        reason: "pay run reopened for recalculation",
      });
    },
  );
}

/** A reversal run: negates a finalized run line for line. */
export async function createReversalRun(
  ctx: Ctx,
  archetype: RoleArchetype,
  originalRunId: string,
  reason: string,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "payroll.approve");
  return command(
    ctx,
    {
      audit: (r) => ({
        action: "payroll.run.reverse",
        entityType: "pay_run",
        entityId: r.id,
        summary: `Created reversal run ${r.reference}`,
      }),
    },
    async (tx) => {
      const orig = (await tx.execute(sql`
        select r.pay_group_id::text as g, r.period_id::text as p, r.pack_version, r.currency,
               r.status
        from public.pay_run r where r.id = ${originalRunId} and r.org_id = ${ctx.orgId}
      `)) as unknown as Array<Record<string, string>>;
      if (!orig[0]) throw new HrError("original run not found", "not_found");
      if (orig[0].status !== "finalized") {
        throw new HrError("only a finalized run can be reversed", "invalid_state");
      }
      const seq = await allocateReference(tx, ctx, "pay_run");
      const reference = formatRef("PAY", seq);
      const rows = (await tx.execute(sql`
        insert into public.pay_run
          (org_id, pay_group_id, period_id, reference, run_kind, reverses_run_id,
           pack_version, currency, created_by)
        values (${ctx.orgId}, ${orig[0].g}, ${orig[0].p}, ${reference}, 'reversal',
                ${originalRunId}, ${orig[0].pack_version}, ${orig[0].currency}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const revId = rows[0]!.id;

      const lines = (await tx.execute(sql`
        select employee_id::text as e, snapshot, gross_minor::text as g,
               deduction_minor::text as d, employer_minor::text as emp, net_minor::text as n
        from public.pay_run_line where org_id = ${ctx.orgId} and pay_run_id = ${originalRunId}
      `)) as unknown as Array<Record<string, unknown>>;
      let net = 0;
      for (const l of lines) {
        const snap = {
          reversalOf: originalRunId,
          reason,
          original: l.snapshot,
        };
        // A reversal records NEGATIVE net; gross/deduction swap to keep the
        // net = gross - deduction identity intact with integers.
        await tx.execute(sql`
          insert into public.pay_run_line
            (org_id, pay_run_id, employee_id, snapshot, gross_minor, deduction_minor,
             employer_minor, net_minor, exceptions)
          values (${ctx.orgId}, ${revId}, ${l.e as string}, ${JSON.stringify(snap)}::jsonb,
                  ${Number(l.d)}, ${Number(l.g)}, ${0}, ${Number(l.d) - Number(l.g)}, '[]'::jsonb)
        `);
        net += Number(l.d) - Number(l.g);
      }
      await tx.execute(sql`
        update public.pay_run set status = 'review', net_total_minor = ${net},
               calculated_at = now(), updated_at = now()
        where id = ${revId} and org_id = ${ctx.orgId}
      `);
      return { id: revId, reference };
    },
  );
}

// ── final settlement ─────────────────────────────────────────────────────────

/**
 * Preview a final settlement: gratuity from the pack bands + unused annual
 * leave encashment + the recorded inputs. A PREVIEW — the payable run is an
 * off-cycle run whose adjustments a human confirms, because a legally
 * consequential number must pass a person, not a default.
 */
export async function previewFinalSettlement(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
): Promise<{
  gratuityMinor: number | null;
  gratuityWorking: unknown;
  leaveEncashmentDays: number;
  inputs: Array<{ kind: string; label: string; quantity: string | null; amountMinor: number | null }>;
  packVersion: string | null;
}> {
  assertCan(archetype, "payroll.manage");
  if (!ctx.costPrivileged) throw new HrError("payroll requires cost privilege", "forbidden");
  return withCtx(ctx, async (tx) => {
    const emp = (await tx.execute(sql`
      select e.hire_date::text as hire, coalesce(e.final_working_date, e.end_date)::text as last,
             o.country
      from public.employee e join public.org o on o.id = e.org_id
      where e.id = ${employeeId} and e.org_id = ${ctx.orgId}
    `)) as unknown as Array<{ hire: string | null; last: string | null; country: string | null }>;
    if (!emp[0]) throw new HrError("employee not found", "not_found");
    const pack = packFor(emp[0].country);

    const comp = (await tx.execute(sql`
      select salary_minor::text as s from public.employee_compensation
      where org_id = ${ctx.orgId} and employee_id = ${employeeId} and superseded_at is null
      order by effective_date desc limit 1
    `)) as unknown as Array<{ s: string }>;

    let gratuity: { amountMinor: number; working: unknown } | null = null;
    if (pack && emp[0].hire && emp[0].last && comp[0]) {
      const days = Math.round(
        (new Date(emp[0].last).getTime() - new Date(emp[0].hire).getTime()) / 86_400_000,
      );
      gratuity = calculateGratuity(pack, days, Number(comp[0].s));
    }

    const annual = (await tx.execute(sql`
      select coalesce(sum(l.days), 0)::text as d
      from public.leave_ledger l
      join public.leave_type t on t.id = l.leave_type_id and t.org_id = l.org_id
      where l.org_id = ${ctx.orgId} and l.employee_id = ${employeeId} and t.key like 'annual%'
    `)) as unknown as Array<{ d: string }>;

    const inputs = (await tx.execute(sql`
      select kind, label, quantity::text as q, amount_minor::text as a
      from public.final_settlement_input
      where org_id = ${ctx.orgId} and employee_id = ${employeeId}
      order by created_at
    `)) as unknown as Array<Record<string, string | null>>;

    return {
      gratuityMinor: gratuity?.amountMinor ?? null,
      gratuityWorking: gratuity?.working ?? null,
      leaveEncashmentDays: Number(annual[0]?.d ?? 0),
      inputs: inputs.map((i) => ({
        kind: i.kind!,
        label: i.label!,
        quantity: i.q ?? null,
        amountMinor: i.a == null ? null : Number(i.a),
      })),
      packVersion: pack?.version ?? null,
    };
  });
}

// ── reads ────────────────────────────────────────────────────────────────────

export type PayRunRow = {
  id: string;
  reference: string;
  runKind: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  lines: number;
  netTotalMinor: number;
  exceptionCount: number;
};

export async function listPayRuns(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { limit?: number } = {},
): Promise<PayRunRow[]> {
  assertCan(archetype, "payroll.view");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select r.id::text as id, r.reference, r.run_kind, r.status,
             p.period_start::text as ps, p.period_end::text as pe,
             (select count(*)::int from public.pay_run_line l
              where l.org_id = r.org_id and l.pay_run_id = r.id) as lines,
             r.net_total_minor::text as net, r.exception_count
      from public.pay_run r
      join public.pay_period p on p.id = r.period_id and p.org_id = r.org_id
      where r.org_id = ${ctx.orgId}
      order by r.created_at desc
      limit ${limit}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    reference: r.reference as string,
    runKind: r.run_kind as string,
    status: r.status as string,
    periodStart: r.ps as string,
    periodEnd: r.pe as string,
    lines: Number(r.lines),
    netTotalMinor: ctx.costPrivileged ? Number(r.net) : 0,
    exceptionCount: Number(r.exception_count),
  }));
}

/** An employee's own payslips (self-service) or anyone's for the privileged. */
export async function listPayslips(
  ctx: Ctx,
  opts: { employeeId?: string; limit?: number } = {},
): Promise<
  Array<{ id: string; slipNo: string; periodStart: string; periodEnd: string; netMinor: number; currency: string }>
> {
  const limit = Math.min(Math.max(opts.limit ?? 24, 1), 100);
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, slip_no, period_start::text as ps, period_end::text as pe,
             net_minor::text as net, currency
      from public.payslip
      where org_id = ${ctx.orgId}
        and (${opts.employeeId ?? null}::uuid is null or employee_id = ${opts.employeeId ?? null}::uuid)
      order by issued_at desc
      limit ${limit}
    `),
  )) as unknown as Array<Record<string, string>>;
  return rows.map((r) => ({
    id: r.id!,
    slipNo: r.slip_no!,
    periodStart: r.ps!,
    periodEnd: r.pe!,
    netMinor: Number(r.net),
    currency: r.currency!,
  }));
}

export type PayRunDetail = {
  id: string;
  reference: string;
  runKind: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  packVersion: string | null;
  grossTotalMinor: number;
  deductionTotalMinor: number;
  netTotalMinor: number;
  exceptionCount: number;
  lines: Array<{
    id: string;
    employeeId: string;
    employeeName: string;
    grossMinor: number;
    deductionMinor: number;
    netMinor: number;
    exceptions: string[];
    payslipId: string | null;
  }>;
};

export async function getPayRun(
  ctx: Ctx,
  archetype: RoleArchetype,
  runId: string,
): Promise<PayRunDetail | null> {
  assertCan(archetype, "payroll.view");
  if (!ctx.costPrivileged) throw new HrError("payroll requires cost privilege", "forbidden");
  return withCtx(ctx, async (tx) => {
    const runs = (await tx.execute(sql`
      select r.id::text as id, r.reference, r.run_kind, r.status, r.currency, r.pack_version,
             r.gross_total_minor::text as gross, r.deduction_total_minor::text as ded,
             r.net_total_minor::text as net, r.exception_count,
             p.period_start::text as ps, p.period_end::text as pe
      from public.pay_run r
      join public.pay_period p on p.id = r.period_id and p.org_id = r.org_id
      where r.id = ${runId} and r.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    const r = runs[0];
    if (!r) return null;
    const lines = (await tx.execute(sql`
      select l.id::text as id, l.employee_id::text as employee_id, e.name,
             l.gross_minor::text as g, l.deduction_minor::text as d, l.net_minor::text as n,
             l.exceptions, s.id::text as payslip_id
      from public.pay_run_line l
      join public.employee e on e.id = l.employee_id and e.org_id = l.org_id
      left join public.payslip s on s.pay_run_line_id = l.id and s.org_id = l.org_id
      where l.pay_run_id = ${runId} and l.org_id = ${ctx.orgId}
      order by e.name
    `)) as unknown as Array<Record<string, unknown>>;
    return {
      id: r.id as string,
      reference: r.reference as string,
      runKind: r.run_kind as string,
      status: r.status as string,
      periodStart: r.ps as string,
      periodEnd: r.pe as string,
      currency: r.currency as string,
      packVersion: (r.pack_version as string | null) ?? null,
      grossTotalMinor: Number(r.gross),
      deductionTotalMinor: Number(r.ded),
      netTotalMinor: Number(r.net),
      exceptionCount: Number(r.exception_count),
      lines: lines.map((l) => ({
        id: l.id as string,
        employeeId: l.employee_id as string,
        employeeName: l.name as string,
        grossMinor: Number(l.g),
        deductionMinor: Number(l.d),
        netMinor: Number(l.n),
        exceptions: (l.exceptions as string[]) ?? [],
        payslipId: (l.payslip_id as string | null) ?? null,
      })),
    };
  });
}

/** The pay groups (bounded org config). */
export async function listPayGroups(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<Array<{ id: string; nameEn: string; frequency: string; roundingMinor: number }>> {
  assertCan(archetype, "payroll.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name_en, frequency, rounding_minor from public.pay_group
      where org_id = ${ctx.orgId} and active
      order by name_en
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    nameEn: r.name_en as string,
    frequency: r.frequency as string,
    roundingMinor: Number(r.rounding_minor),
  }));
}
