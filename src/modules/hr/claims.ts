/**
 * H23E — employee expense claims, mileage and cash advances.
 *
 * A claim is a WORKFLOW around money the org already knows how to count. It is
 * born draft, submitted through the approval engine (the engine is the sole
 * writer of submitted→approved/returned), and then settled exactly once:
 *
 *   payroll       — the next pay run picks it up as a reimbursement line and
 *                   finalization stamps settled_pay_run_id (payroll/service.ts);
 *   expense_book  — accounts posts one canonical `expense` row PER LINE (right
 *                   category, right job — job cost stays true) and stamps each
 *                   line + the claim.
 *
 * Claims are in the ORG BASE CURRENCY only (locked decision D3: payroll is
 * base-currency-only and a claim must be able to route there). VAT on employee
 * receipts is not split out — the reimbursed gross posts as the expense net
 * with zero VAT, because inventing a VAT split from an unstructured receipt
 * would be a lie the tax report repeats.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, can } from "@/platform/authz";
import { sql, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { emitEvent } from "@/platform/events/outbox";
import { EXPENSE_CREATED } from "@/platform/events";
import { submitForApproval, supersedeApprovalsForSubjectIn } from "@/modules/approvals/service";
import { resolveCategoryMapping } from "@/modules/expenses/service";
import { HrError } from "./people";

const ClaimLineInput = z.object({
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  categoryKey: z.string().min(1).max(60),
  description: z.string().trim().min(1).max(500),
  /** Plain receipt line — amount entered directly. */
  amountMinor: z.number().int().positive().optional(),
  /** Mileage line — km entered, amount = km × the org rate on that date. */
  mileageKm: z.number().positive().max(99999).optional(),
  receiptFileId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
});

const CreateClaimInput = z.object({
  employeeId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  settlementRoute: z.enum(["payroll", "expense_book"]).default("payroll"),
  lines: z.array(ClaimLineInput).min(1).max(100),
});

export type DuplicateWarning = {
  claimReference: string;
  expenseDate: string;
  amountMinor: number;
  description: string;
};

async function assertSelfOrManager(
  tx: TenantTx,
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
): Promise<void> {
  if (can(archetype, "expenses.view")) return;
  const self = (await tx.execute(sql`
    select 1 from public.employee
    where id = ${employeeId} and org_id = ${ctx.orgId} and user_id = ${ctx.userId}
  `)) as unknown as unknown[];
  if (self.length === 0) {
    throw new HrError("you can only file claims for yourself", "forbidden");
  }
}

/** The org mileage rate effective on a date — configured, never assumed. */
async function mileageRateOn(tx: TenantTx, ctx: Ctx, date: string): Promise<number> {
  const rows = (await tx.execute(sql`
    select rate_minor_per_km::text as rate from public.mileage_rate
    where org_id = ${ctx.orgId} and effective_from <= ${date}::date
    order by effective_from desc limit 1
  `)) as unknown as Array<{ rate: string }>;
  if (!rows[0]) {
    throw new HrError(
      "no mileage rate is configured for that date — set one under expense settings first",
      "invalid_state",
    );
  }
  return Number(rows[0].rate);
}

export async function setMileageRate(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "expenses.create");
  const input = z
    .object({
      rateMinorPerKm: z.number().int().min(0),
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "hr.mileage_rate.set",
        entityType: "mileage_rate",
        entityId: r.id,
        summary: `Mileage rate ${input.rateMinorPerKm}/km from ${input.effectiveFrom}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.mileage_rate (org_id, rate_minor_per_km, effective_from, created_by)
        values (${ctx.orgId}, ${input.rateMinorPerKm}, ${input.effectiveFrom}, ${ctx.userId})
        on conflict (org_id, effective_from)
          do update set rate_minor_per_km = excluded.rate_minor_per_km
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export async function createClaim(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; reference: string; totalMinor: number }> {
  const input = CreateClaimInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string; reference: string }) => ({
        action: "hr.claim.create",
        entityType: "expense_claim",
        entityId: r.id,
        // §5.9: identifiers only — pay-adjacent amounts stay out of audit summaries.
        summary: `Expense claim ${r.reference} (${input.lines.length} line(s))`,
      }),
    },
    async (tx) => {
      await assertSelfOrManager(tx, ctx, archetype, input.employeeId);
      const org = (await tx.execute(sql`
        select base_currency from public.org where id = ${ctx.orgId}
      `)) as unknown as Array<{ base_currency: string }>;
      const currency = org[0]!.base_currency;

      // Resolve every line to an amount BEFORE any write: category must exist,
      // mileage lines get the configured rate, plain lines an entered amount.
      const resolved: Array<{
        line: z.infer<typeof ClaimLineInput>;
        amountMinor: number;
        mileageRateMinor: number | null;
      }> = [];
      for (const line of input.lines) {
        await resolveCategoryMapping(tx, ctx, line.categoryKey); // throws on unknown
        if (line.mileageKm != null) {
          if (line.amountMinor != null) {
            throw new HrError("a line is mileage OR an amount, not both", "invalid_state");
          }
          const rate = await mileageRateOn(tx, ctx, line.expenseDate);
          resolved.push({
            line,
            amountMinor: Math.floor(line.mileageKm * rate + 0.5),
            mileageRateMinor: rate,
          });
        } else if (line.amountMinor != null) {
          resolved.push({ line, amountMinor: line.amountMinor, mileageRateMinor: null });
        } else {
          throw new HrError("every line needs an amount or mileage", "invalid_state");
        }
      }
      const totalMinor = resolved.reduce((a, r) => a + r.amountMinor, 0);

      const seq = await allocateReference(tx, ctx, "expense_claim");
      const reference = formatRef("CLM", seq);
      const rows = (await tx.execute(sql`
        insert into public.expense_claim
          (org_id, employee_id, reference, title, currency, base_currency,
           total_minor, base_total_minor, settlement_route, created_by)
        values (${ctx.orgId}, ${input.employeeId}, ${reference}, ${input.title},
                ${currency}, ${currency}, ${totalMinor}, ${totalMinor},
                ${input.settlementRoute}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;
      for (const r of resolved) {
        await tx.execute(sql`
          insert into public.expense_claim_line
            (org_id, claim_id, expense_date, category_key, description, amount_minor,
             mileage_km, mileage_rate_minor, receipt_file_id, job_id)
          values (${ctx.orgId}, ${id}, ${r.line.expenseDate}, ${r.line.categoryKey},
                  ${r.line.description}, ${r.amountMinor},
                  ${r.line.mileageKm ?? null}, ${r.mileageRateMinor},
                  ${r.line.receiptFileId ?? null}, ${r.line.jobId ?? null})
        `);
      }
      return { id, reference, totalMinor };
    },
  );
}

/**
 * Same employee, same date, same amount on ANOTHER live claim — surfaced to the
 * approver, never silently blocked (two identical taxi fares happen).
 */
export async function duplicateWarningsFor(
  tx: TenantTx,
  ctx: Ctx,
  claimId: string,
): Promise<DuplicateWarning[]> {
  const rows = (await tx.execute(sql`
    select other_claim.reference as claim_reference, other_line.expense_date::text as expense_date,
           other_line.amount_minor::text as amount_minor, other_line.description
    from public.expense_claim_line mine
    join public.expense_claim my_claim
      on my_claim.id = mine.claim_id and my_claim.org_id = mine.org_id
    join public.expense_claim other_claim
      on other_claim.org_id = my_claim.org_id
     and other_claim.employee_id = my_claim.employee_id
     and other_claim.id <> my_claim.id
     and other_claim.status not in ('cancelled', 'returned')
    join public.expense_claim_line other_line
      on other_line.claim_id = other_claim.id and other_line.org_id = other_claim.org_id
     and other_line.expense_date = mine.expense_date
     and other_line.amount_minor = mine.amount_minor
    where mine.claim_id = ${claimId} and mine.org_id = ${ctx.orgId}
    limit 20
  `)) as unknown as Array<Record<string, string>>;
  return rows.map((r) => ({
    claimReference: r.claim_reference!,
    expenseDate: r.expense_date!,
    amountMinor: Number(r.amount_minor),
    description: r.description!,
  }));
}

export async function submitClaim(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; decided: boolean; warnings: DuplicateWarning[] }> {
  const input = z.object({ claimId: z.string().uuid() }).parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "hr.claim.submit",
        entityType: "expense_claim",
        entityId: input.claimId,
        summary: "Submitted expense claim for approval",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select c.employee_id::text as employee_id, c.reference, c.total_minor::text as total_minor,
               c.status, e.name as employee_name
        from public.expense_claim c
        join public.employee e on e.id = c.employee_id and e.org_id = c.org_id
        where c.id = ${input.claimId} and c.org_id = ${ctx.orgId}
      `)) as unknown as Array<Record<string, string>>;
      const c = rows[0];
      if (!c) throw new HrError("claim not found", "not_found");
      await assertSelfOrManager(tx, ctx, archetype, c.employee_id!);
      if (c.status !== "draft" && c.status !== "returned") {
        throw new HrError(`a ${c.status} claim cannot be submitted`, "invalid_state");
      }
      const lineCount = (await tx.execute(sql`
        select count(*)::int as n from public.expense_claim_line
        where claim_id = ${input.claimId} and org_id = ${ctx.orgId}
      `)) as unknown as Array<{ n: number }>;
      if ((lineCount[0]?.n ?? 0) === 0) {
        throw new HrError("a claim needs at least one line", "invalid_state");
      }

      const warnings = await duplicateWarningsFor(tx, ctx, input.claimId);
      await tx.execute(sql`
        update public.expense_claim set status = 'submitted', updated_at = now()
        where id = ${input.claimId} and org_id = ${ctx.orgId}
      `);
      const res = await submitForApproval(tx, ctx, {
        subjectType: "expense_claim",
        subjectId: input.claimId,
        subjectSummary: {
          title:
            `Claim ${c.reference} — ${c.employee_name}` +
            (warnings.length > 0 ? ` (⚠ ${warnings.length} possible duplicate(s))` : ""),
          amountMinor: Number(c.total_minor),
        },
      });
      return { id: input.claimId, decided: res.decided, warnings };
    },
  );
}

export async function cancelClaim(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  const input = z.object({ claimId: z.string().uuid() }).parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "hr.claim.cancel",
        entityType: "expense_claim",
        entityId: input.claimId,
        summary: "Cancelled expense claim",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select employee_id::text as employee_id, status from public.expense_claim
        where id = ${input.claimId} and org_id = ${ctx.orgId}
      `)) as unknown as Array<{ employee_id: string; status: string }>;
      const c = rows[0];
      if (!c) throw new HrError("claim not found", "not_found");
      await assertSelfOrManager(tx, ctx, archetype, c.employee_id);
      if (!["draft", "returned", "submitted"].includes(c.status)) {
        throw new HrError(`a ${c.status} claim cannot be cancelled`, "invalid_state");
      }
      if (c.status === "submitted") {
        await supersedeApprovalsForSubjectIn(tx, ctx, {
          subjectType: "expense_claim",
          subjectId: input.claimId,
          reason: "claim cancelled by requester",
        });
      }
      await tx.execute(sql`
        update public.expense_claim set status = 'cancelled', updated_at = now()
        where id = ${input.claimId} and org_id = ${ctx.orgId}
      `);
      return { id: input.claimId };
    },
  );
}

/**
 * Post an approved expense_book-routed claim into the org expense book — one
 * canonical `expense` row per line, then the claim flips to paid in the same
 * transaction. The database guards make this once-only: the claim trigger
 * demands approved→paid with a latch, and a second call finds status 'paid'.
 */
export async function settleClaimToExpenseBook(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; expenseReferences: string[] }> {
  assertCan(archetype, "expenses.create");
  const input = z.object({ claimId: z.string().uuid() }).parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string; expenseReferences: string[] }) => ({
        action: "hr.claim.settle",
        entityType: "expense_claim",
        entityId: r.id,
        summary: `Settled claim to expense book (${r.expenseReferences.length} expense(s))`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select reference, status, settlement_route, employee_id::text as employee_id
        from public.expense_claim
        where id = ${input.claimId} and org_id = ${ctx.orgId}
        for update
      `)) as unknown as Array<Record<string, string>>;
      const c = rows[0];
      if (!c) throw new HrError("claim not found", "not_found");
      if (c.status !== "approved") {
        throw new HrError(`only an approved claim can settle (this one is ${c.status})`, "invalid_state");
      }
      if (c.settlement_route !== "expense_book") {
        throw new HrError("this claim settles through payroll, not the expense book", "invalid_state");
      }
      const lines = (await tx.execute(sql`
        select id::text as id, expense_date::text as expense_date, category_key, description,
               amount_minor::text as amount_minor, receipt_file_id::text as receipt_file_id,
               job_id::text as job_id
        from public.expense_claim_line
        where claim_id = ${input.claimId} and org_id = ${ctx.orgId} and settled_expense_id is null
        order by expense_date, id
      `)) as unknown as Array<Record<string, string | null>>;
      if (lines.length === 0) throw new HrError("nothing left to settle", "invalid_state");

      const expenseReferences: string[] = [];
      let firstExpenseId: string | null = null;
      for (const l of lines) {
        const mapping = await resolveCategoryMapping(tx, ctx, l.category_key!);
        let jobName: string | null = null;
        if (l.job_id) {
          const jobRows = (await tx.execute(sql`
            select name from public.job where id = ${l.job_id} and org_id = ${ctx.orgId}
          `)) as unknown as Array<{ name: string }>;
          jobName = jobRows[0]?.name ?? null;
        }
        const seq = await allocateReference(tx, ctx, "expense");
        const reference = formatRef("EXP", seq);
        // Gross reimbursed = net, VAT 0 — no invented VAT split (header comment).
        const exp = (await tx.execute(sql`
          insert into public.expense
            (org_id, reference, job_id, job_name, category_key, costing_mapping, description,
             expense_date, amount_minor, vat_amount_minor, total_minor, receipt_file_id,
             payment_status, created_by)
          values (${ctx.orgId}, ${reference}, ${l.job_id}, ${jobName}, ${l.category_key},
                  ${mapping}, ${`${c.reference}: ${l.description}`}, ${l.expense_date},
                  ${Number(l.amount_minor)}, 0, ${Number(l.amount_minor)},
                  ${l.receipt_file_id}, 'paid', ${ctx.userId})
          returning id::text as id
        `)) as unknown as Array<{ id: string }>;
        const expenseId = exp[0]!.id;
        firstExpenseId ??= expenseId;
        expenseReferences.push(reference);
        await tx.execute(sql`
          update public.expense_claim_line set settled_expense_id = ${expenseId}
          where id = ${l.id} and org_id = ${ctx.orgId}
        `);
        await emitEvent(tx, ctx, {
          name: EXPENSE_CREATED,
          payload: { expenseId, jobId: l.job_id ?? undefined },
        });
      }
      await tx.execute(sql`
        update public.expense_claim
        set status = 'paid', settled_expense_id = ${firstExpenseId}, updated_at = now()
        where id = ${input.claimId} and org_id = ${ctx.orgId} and status = 'approved'
      `);
      return { id: input.claimId, expenseReferences };
    },
  );
}

// ── cash advances ────────────────────────────────────────────────────────────

export async function recordCashAdvance(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "expenses.create");
  const input = z
    .object({
      employeeId: z.string().uuid(),
      amountMinor: z.number().int().positive(),
      purpose: z.string().trim().min(1).max(500),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string; reference: string }) => ({
        action: "hr.advance.record",
        entityType: "cash_advance",
        entityId: r.id,
        summary: `Cash advance ${r.reference}`,
      }),
    },
    async (tx) => {
      const seq = await allocateReference(tx, ctx, "cash_advance");
      const reference = formatRef("ADV", seq);
      const rows = (await tx.execute(sql`
        insert into public.cash_advance (org_id, employee_id, reference, amount_minor, purpose, created_by)
        values (${ctx.orgId}, ${input.employeeId}, ${reference}, ${input.amountMinor},
                ${input.purpose}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id, reference };
    },
  );
}

/**
 * Close an open advance: either it was accounted for by an approved claim, or
 * it converts into a payroll salary-advance loan recovered in installments.
 * Either way the advance row records which — money never just disappears.
 */
export async function settleCashAdvance(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "expenses.create");
  const input = z
    .object({
      advanceId: z.string().uuid(),
      via: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("claim"), claimId: z.string().uuid() }),
        z.object({
          kind: z.literal("loan"),
          installmentMinor: z.number().int().positive(),
          startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
      ]),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "hr.advance.settle",
        entityType: "cash_advance",
        entityId: input.advanceId,
        summary: `Advance settled via ${input.via.kind}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select employee_id::text as employee_id, amount_minor::text as amount_minor, status
        from public.cash_advance
        where id = ${input.advanceId} and org_id = ${ctx.orgId}
        for update
      `)) as unknown as Array<Record<string, string>>;
      const adv = rows[0];
      if (!adv) throw new HrError("advance not found", "not_found");
      if (adv.status !== "open") throw new HrError("advance is already settled", "invalid_state");

      if (input.via.kind === "claim") {
        const claim = (await tx.execute(sql`
          select status, employee_id::text as employee_id from public.expense_claim
          where id = ${input.via.claimId} and org_id = ${ctx.orgId}
        `)) as unknown as Array<{ status: string; employee_id: string }>;
        if (!claim[0] || claim[0].employee_id !== adv.employee_id) {
          throw new HrError("claim not found for this employee", "not_found");
        }
        if (!["approved", "paid"].includes(claim[0].status)) {
          throw new HrError("only an approved claim can settle an advance", "invalid_state");
        }
        await tx.execute(sql`
          update public.cash_advance
          set status = 'settled', settled_claim_id = ${input.via.claimId}, updated_at = now()
          where id = ${input.advanceId} and org_id = ${ctx.orgId}
        `);
      } else {
        const seq = await allocateReference(tx, ctx, "employee_loan");
        const reference = formatRef("LN", seq);
        await tx.execute(sql`
          insert into public.employee_loan
            (org_id, employee_id, kind, reference, principal_minor, installment_minor,
             starts_on, reason, created_by)
          values (${ctx.orgId}, ${adv.employee_id}, 'salary_advance', ${reference},
                  ${Number(adv.amount_minor)}, ${input.via.installmentMinor},
                  ${input.via.startsOn}, 'Converted from cash advance', ${ctx.userId})
        `);
        await tx.execute(sql`
          update public.cash_advance set status = 'converted_to_loan', updated_at = now()
          where id = ${input.advanceId} and org_id = ${ctx.orgId}
        `);
      }
      return { id: input.advanceId };
    },
  );
}

// ── reads ────────────────────────────────────────────────────────────────────

export type ClaimListRow = {
  id: string;
  reference: string;
  title: string;
  employeeName: string;
  totalMinor: number;
  status: string;
  settlementRoute: string;
  createdAt: string;
};

export async function listClaims(
  ctx: Ctx,
  archetype: RoleArchetype,
  filter?: { status?: string; employeeId?: string },
): Promise<ClaimListRow[]> {
  const { withCtx } = await import("@/platform/tenancy");
  return withCtx(ctx, async (tx) => {
    const managesOthers = can(archetype, "expenses.view");
    const rows = (await tx.execute(sql`
      select c.id::text as id, c.reference, c.title, e.name as employee_name,
             c.total_minor::text as total_minor, c.status, c.settlement_route,
             c.created_at::text as created_at
      from public.expense_claim c
      join public.employee e on e.id = c.employee_id and e.org_id = c.org_id
      where c.org_id = ${ctx.orgId}
        ${managesOthers ? sql`` : sql`and e.user_id = ${ctx.userId}`}
        ${filter?.status ? sql`and c.status = ${filter.status}` : sql``}
        ${filter?.employeeId ? sql`and c.employee_id = ${filter.employeeId}` : sql``}
      order by c.created_at desc
      limit 500
    `)) as unknown as Array<Record<string, string>>;
    return rows.map((r) => ({
      id: r.id!,
      reference: r.reference!,
      title: r.title!,
      employeeName: r.employee_name!,
      totalMinor: Number(r.total_minor),
      status: r.status!,
      settlementRoute: r.settlement_route!,
      createdAt: r.created_at!,
    }));
  });
}
