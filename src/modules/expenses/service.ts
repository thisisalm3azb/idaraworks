/**
 * Expenses (doc 01 L4; doc 11 S5 "Measure"). An expense is a COST channel DISJOINT
 * from purchase orders (audit F-2): there is no po_id to set — an expense can never
 * reference a PO, so a purchase is counted once (as a PO receipt) or as an expense,
 * never both. Each expense snapshots its category's costing_mapping (which expenses
 * feed job cost). Money in minor units, VAT recorded per document (D-1.3). No-hard-
 * delete: void with a mandatory reason (D-1.7) — owner/admin/accounts only (ruling).
 * Every mutation runs through the command path (audit, doc 10 #33) and emits an
 * outbox event that invalidates the job's cost rollup.
 */
import { z } from "zod";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { command } from "@/platform/audit/command";
import { assertCan } from "@/platform/authz/can";
import { requireCapability } from "@/platform/entitlements";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { EXPENSE_CREATED, EXPENSE_VOIDED } from "@/platform/events";
import type { RoleArchetype } from "@/platform/registries";

export type CostingMapping = "job_materials" | "job_other" | "overhead";

export class ExpenseNotFoundError extends Error {
  constructor() {
    super("expense not found");
    this.name = "ExpenseNotFoundError";
  }
}
export class ExpenseStateError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ExpenseStateError";
  }
}
export class InvalidExpenseInputError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "InvalidExpenseInputError";
  }
}

export const CreateExpenseInput = z.object({
  // null / absent = org overhead (P1: overhead is a deliberate choice).
  jobId: z.string().uuid().nullable().optional(),
  categoryKey: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(500),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountMinor: z.number().int().nonnegative(),
  vatAmountMinor: z.number().int().nonnegative().default(0),
  receiptFileId: z.string().uuid().nullable().optional(),
  // NOTE: there is deliberately no poId — the disjoint-channel invariant (F-2).
});
export type CreateExpenseInput = z.infer<typeof CreateExpenseInput>;

export const VoidExpenseInput = z.object({
  expenseId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
});

/** Resolve a category's costing_mapping from the org's expense CategorySet config
 * (blob artifact). Rejects an unknown/retired category — the mapping is authoritative,
 * never client-supplied (which would let a caller mis-route cost). */
async function resolveCategoryMapping(
  tx: TenantTx,
  ctx: Ctx,
  categoryKey: string,
): Promise<CostingMapping> {
  const rows = (await tx.execute(sql`
    select value from public.app_settings
    where org_id = ${ctx.orgId} and key = 'config.categories.expense'
  `)) as unknown as Array<{ value: { categories?: Array<Record<string, unknown>> } }>;
  const categories = rows[0]?.value?.categories ?? [];
  const cat = categories.find((c) => c.key === categoryKey && c.retired !== true);
  if (!cat || typeof cat.costing_mapping !== "string") {
    throw new InvalidExpenseInputError(`unknown expense category: ${categoryKey}`);
  }
  return cat.costing_mapping as CostingMapping;
}

export async function createExpense(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "expenses.create");
  // Add-on gate (FR-9): CREATE only — the expense book and voiding never gate.
  await requireCapability(ctx, "cap.expenses");
  const input = CreateExpenseInput.parse(raw);
  const totalMinor = input.amountMinor + input.vatAmountMinor;

  return command(
    ctx,
    {
      audit: (r: { id: string; reference: string }) => ({
        action: "expense.create",
        entityType: "expense",
        entityId: r.id,
        summary: `Expense ${r.reference} (${input.categoryKey})`,
        after: {
          jobId: input.jobId ?? null,
          categoryKey: input.categoryKey,
          amountMinor: input.amountMinor,
          vatAmountMinor: input.vatAmountMinor,
          totalMinor,
        },
      }),
      events: (r) => [
        { name: EXPENSE_CREATED, payload: { expenseId: r.id, jobId: input.jobId ?? undefined } },
      ],
    },
    async (tx) => {
      const mapping = await resolveCategoryMapping(tx, ctx, input.categoryKey);
      let jobName: string | null = null;
      if (input.jobId) {
        const jobRows = (await tx.execute(sql`
          select name from public.job where id = ${input.jobId} and org_id = ${ctx.orgId}
        `)) as unknown as Array<{ name: string }>;
        if (!jobRows[0]) throw new InvalidExpenseInputError("job not found");
        jobName = jobRows[0].name;
      }
      const seq = await allocateReference(tx, ctx, "expense");
      const reference = formatRef("EXP", seq);
      const rows = (await tx.execute(sql`
        insert into public.expense
          (org_id, reference, job_id, job_name, category_key, costing_mapping, description,
           expense_date, amount_minor, vat_amount_minor, total_minor, receipt_file_id, created_by)
        values (${ctx.orgId}, ${reference}, ${input.jobId ?? null}, ${jobName},
                ${input.categoryKey}, ${mapping}, ${input.description}, ${input.expenseDate},
                ${input.amountMinor}, ${input.vatAmountMinor}, ${totalMinor},
                ${input.receiptFileId ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id, reference };
    },
  );
}

export async function voidExpense(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; jobId: string | null }> {
  assertCan(archetype, "expenses.void");
  const input = VoidExpenseInput.parse(raw);

  return command(
    ctx,
    {
      audit: {
        action: "expense.void",
        entityType: "expense",
        entityId: input.expenseId,
        summary: `Voided expense: ${input.reason}`,
      },
      events: (r: { id: string; jobId: string | null }) => [
        { name: EXPENSE_VOIDED, payload: { expenseId: r.id, jobId: r.jobId ?? undefined } },
      ],
    },
    async (tx) => {
      // Guarded: only an un-voided expense flips to voided (a second void is a no-op
      // that must not re-emit / re-audit).
      const rows = (await tx.execute(sql`
        update public.expense
        set voided_at = now(), void_reason = ${input.reason}, voided_by = ${ctx.userId}
        where id = ${input.expenseId} and org_id = ${ctx.orgId} and voided_at is null
        returning id::text as id, job_id::text as job_id
      `)) as unknown as Array<{ id: string; job_id: string | null }>;
      if (!rows[0]) {
        const exists = (await tx.execute(sql`
          select 1 from public.expense where id = ${input.expenseId} and org_id = ${ctx.orgId}
        `)) as unknown as Array<{ "?column?": number }>;
        if (exists.length > 0) throw new ExpenseStateError("expense already voided");
        throw new ExpenseNotFoundError();
      }
      return { id: rows[0].id, jobId: rows[0].job_id };
    },
  );
}

export type ExpenseView = {
  id: string;
  reference: string;
  jobId: string | null;
  jobName: string | null;
  categoryKey: string;
  costingMapping: string;
  description: string;
  expenseDate: string;
  amountMinor: number;
  vatAmountMinor: number;
  totalMinor: number;
  paymentStatus: string;
  voided: boolean;
  voidReason: string | null;
  createdAt: string;
};

export async function listExpenses(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { jobId?: string; includeVoided?: boolean; limit?: number } = {},
): Promise<ExpenseView[]> {
  assertCan(archetype, "expenses.view");
  const limit = Math.min(opts.limit ?? 200, 500);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, reference, job_id::text as job_id, job_name, category_key,
             costing_mapping, description, expense_date::text as expense_date,
             amount_minor, vat_amount_minor, total_minor, payment_status,
             (voided_at is not null) as voided, void_reason, created_at::text as created_at
      from public.expense
      where org_id = ${ctx.orgId}
        ${opts.jobId ? sql`and job_id = ${opts.jobId}` : sql``}
        ${opts.includeVoided ? sql`` : sql`and voided_at is null`}
      order by expense_date desc, created_at desc
      limit ${limit}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapExpense);
  });
}

export async function getExpense(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<ExpenseView | null> {
  assertCan(archetype, "expenses.view");
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, reference, job_id::text as job_id, job_name, category_key,
             costing_mapping, description, expense_date::text as expense_date,
             amount_minor, vat_amount_minor, total_minor, payment_status,
             (voided_at is not null) as voided, void_reason, created_at::text as created_at
      from public.expense where id = ${id} and org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows[0] ? mapExpense(rows[0]) : null;
  });
}

/** Non-retired expense categories (+ their costing_mapping) for the expense form. */
export async function listExpenseCategories(
  ctx: Ctx,
): Promise<Array<{ key: string; labelEn: string; labelAr: string; costingMapping: string }>> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select value from public.app_settings
      where org_id = ${ctx.orgId} and key = 'config.categories.expense'
    `)) as unknown as Array<{
      value: { categories?: Array<Record<string, unknown>> };
    }>;
    const cats = rows[0]?.value?.categories ?? [];
    return cats
      .filter((c) => c.retired !== true)
      .map((c) => {
        const labels = (c.labels ?? {}) as { en?: string; ar?: string };
        return {
          key: String(c.key),
          labelEn: labels.en ?? String(c.key),
          labelAr: labels.ar ?? labels.en ?? String(c.key),
          costingMapping: String(c.costing_mapping ?? "overhead"),
        };
      });
  });
}

/** Active jobs (id/reference/name) for the expense job picker (bounded per org). */
export async function listActiveJobsBrief(
  ctx: Ctx,
): Promise<Array<{ id: string; reference: string; name: string }>> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, reference, name from public.job
      where org_id = ${ctx.orgId} and status_category = 'active' and archived = false
      order by reference limit 500
    `)) as unknown as Array<{ id: string; reference: string; name: string }>;
    return rows;
  });
}

function mapExpense(r: Record<string, unknown>): ExpenseView {
  return {
    id: r.id as string,
    reference: r.reference as string,
    jobId: (r.job_id as string | null) ?? null,
    jobName: (r.job_name as string | null) ?? null,
    categoryKey: r.category_key as string,
    costingMapping: r.costing_mapping as string,
    description: r.description as string,
    expenseDate: r.expense_date as string,
    amountMinor: Number(r.amount_minor),
    vatAmountMinor: Number(r.vat_amount_minor),
    totalMinor: Number(r.total_minor),
    paymentStatus: r.payment_status as string,
    voided: r.voided as boolean,
    voidReason: (r.void_reason as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}
