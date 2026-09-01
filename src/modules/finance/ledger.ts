/**
 * H24B — the ledger service: drafts, posting, reversal, periods, accounts.
 *
 * Every invariant that MATTERS lives in the database (0100): balance in both
 * currencies, at least two lines, open period, org-scoped accounts, one event
 * one posting, immutability after posting, reversal-only correction. This
 * layer adds the human contract — permissions, segregation of duties,
 * references, audit — and the `postFromSourceIn` bridge every subledger
 * posting rule drives through.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, can } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { requireCapability } from "@/platform/entitlements";

export class FinanceError extends Error {
  constructor(
    message: string,
    public code: "not_found" | "invalid_state" | "forbidden" | "unbalanced" = "invalid_state",
  ) {
    super(message);
    this.name = "FinanceError";
  }
}

// ── accounts ─────────────────────────────────────────────────────────────────

export const AccountInput = z.object({
  code: z.string().trim().min(1).max(20),
  nameEn: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
  parentId: z.string().uuid().optional(),
  accountType: z.enum(["asset", "liability", "equity", "income", "expense"]),
  normalBalance: z.enum(["debit", "credit"]).optional(),
  isControl: z.boolean().default(false),
  controlKind: z.enum(["ar", "ap", "bank", "cash", "inventory", "tax", "payroll"]).optional(),
  systemKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,40}$/)
    .optional(),
  currency: z.string().length(3).optional(),
  description: z.string().trim().max(500).optional(),
});

/** The conventional side an account type grows on. */
export function defaultNormalBalance(t: string): "debit" | "credit" {
  return t === "asset" || t === "expense" ? "debit" : "credit";
}

export async function createAccount(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "finance.manage");
  await requireCapability(ctx, "cap.finance");
  const input = AccountInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "finance.account.create",
        entityType: "gl_account",
        entityId: r.id,
        summary: `Created account ${input.code} ${input.nameEn}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.gl_account
          (org_id, code, name_en, name_ar, parent_id, account_type, normal_balance,
           is_control, control_kind, system_key, currency, description, created_by)
        values (${ctx.orgId}, ${input.code}, ${input.nameEn}, ${input.nameAr ?? null},
                ${input.parentId ?? null}, ${input.accountType},
                ${input.normalBalance ?? defaultNormalBalance(input.accountType)},
                ${input.isControl}, ${input.controlKind ?? null}, ${input.systemKey ?? null},
                ${input.currency ?? null}, ${input.description ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export async function archiveAccount(
  ctx: Ctx,
  archetype: RoleArchetype,
  accountId: string,
): Promise<void> {
  assertCan(archetype, "finance.manage");
  await command(
    ctx,
    {
      audit: {
        action: "finance.account.archive",
        entityType: "gl_account",
        entityId: accountId,
        summary: "Archived account (history preserved)",
      },
    },
    async (tx) => {
      const posted = (await tx.execute(sql`
        select 1 from public.journal_line l
        join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
        where l.account_id = ${accountId} and l.org_id = ${ctx.orgId}
          and e.status = 'draft'
        limit 1
      `)) as unknown as unknown[];
      if (posted.length > 0) {
        throw new FinanceError("drafts still use this account — repoint them first");
      }
      await tx.execute(sql`
        update public.gl_account set archived_at = now(), updated_at = now()
        where id = ${accountId} and org_id = ${ctx.orgId} and archived_at is null
      `);
    },
  );
}

export type AccountRow = {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  parentId: string | null;
  accountType: string;
  normalBalance: string;
  isControl: boolean;
  controlKind: string | null;
  systemKey: string | null;
  archived: boolean;
};

export async function listAccounts(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { includeArchived?: boolean } = {},
): Promise<AccountRow[]> {
  assertCan(archetype, "finance.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, code, name_en, name_ar, parent_id::text as parent_id,
             account_type, normal_balance, is_control, control_kind, system_key,
             (archived_at is not null) as archived
      from public.gl_account
      where org_id = ${ctx.orgId}
        ${opts.includeArchived ? sql`` : sql`and archived_at is null`}
      order by code
      limit 2000
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    code: r.code as string,
    nameEn: r.name_en as string,
    nameAr: (r.name_ar as string | null) ?? null,
    parentId: (r.parent_id as string | null) ?? null,
    accountType: r.account_type as string,
    normalBalance: r.normal_balance as string,
    isControl: r.is_control === true,
    controlKind: (r.control_kind as string | null) ?? null,
    systemKey: (r.system_key as string | null) ?? null,
    archived: r.archived === true,
  }));
}

/** Resolve a template-seeded system account, in-transaction (posting rules). */
export async function systemAccountIn(tx: TenantTx, ctx: Ctx, key: string): Promise<string> {
  const rows = (await tx.execute(sql`
    select id::text as id from public.gl_account
    where org_id = ${ctx.orgId} and system_key = ${key} and archived_at is null
  `)) as unknown as Array<{ id: string }>;
  if (!rows[0]) {
    throw new FinanceError(
      `the chart of accounts has no '${key}' system account — run finance setup first`,
    );
  }
  return rows[0].id;
}

// ── fiscal calendar ──────────────────────────────────────────────────────────

export async function createFiscalYear(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; periods: number }> {
  assertCan(archetype, "finance.close");
  await requireCapability(ctx, "cap.finance");
  const input = z
    .object({
      label: z.string().trim().min(1).max(40),
      startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string; periods: number }) => ({
        action: "finance.fiscal_year.create",
        entityType: "fiscal_year",
        entityId: r.id,
        summary: `Fiscal year ${input.label} (${r.periods} periods)`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.fiscal_year (org_id, label, starts_on, ends_on, created_by)
        values (${ctx.orgId}, ${input.label}, ${input.startsOn}, ${input.endsOn}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const yearId = rows[0]!.id;
      // Monthly periods covering the span exactly (last period absorbs stub days).
      const start = new Date(`${input.startsOn}T00:00:00Z`);
      const end = new Date(`${input.endsOn}T00:00:00Z`);
      let periodNo = 1;
      let cursor = new Date(start);
      while (cursor <= end && periodNo <= 13) {
        const pStart = new Date(cursor);
        const pEnd = new Date(Date.UTC(pStart.getUTCFullYear(), pStart.getUTCMonth() + 1, 0));
        const isLast = pEnd >= end || periodNo === 13;
        const actualEnd = isLast ? end : pEnd;
        await tx.execute(sql`
          insert into public.fiscal_period
            (org_id, fiscal_year_id, period_no, starts_on, ends_on)
          values (${ctx.orgId}, ${yearId}, ${periodNo},
                  ${pStart.toISOString().slice(0, 10)}, ${actualEnd.toISOString().slice(0, 10)})
        `);
        if (isLast) break;
        cursor = new Date(
          Date.UTC(pEnd.getUTCFullYear(), pEnd.getUTCMonth(), pEnd.getUTCDate() + 1),
        );
        periodNo++;
      }
      return { id: yearId, periods: periodNo };
    },
  );
}

export async function setPeriodStatus(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "finance.close");
  const input = z
    .object({
      periodId: z.string().uuid(),
      status: z.enum(["open", "soft_closed", "locked"]),
      reason: z.string().trim().max(500).optional(),
    })
    .parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "finance.period.status",
        entityType: "fiscal_period",
        entityId: input.periodId,
        summary: `Period → ${input.status}${input.reason ? ` (${input.reason})` : ""}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select status from public.fiscal_period
        where id = ${input.periodId} and org_id = ${ctx.orgId}
        for update
      `)) as unknown as Array<{ status: string }>;
      if (!rows[0]) throw new FinanceError("period not found", "not_found");
      const from = rows[0].status;
      const to = input.status;
      const reopening = (from === "soft_closed" || from === "locked") && to === "open";
      const unlocking = from === "locked";
      if (reopening || unlocking) {
        if (!input.reason) {
          throw new FinanceError("reopening a period requires a reason");
        }
      }
      if (from === "locked") {
        // The DB guard only allows locked → soft_closed with reason+reopener;
        // going all the way to open is two audited steps by design.
        await tx.execute(sql`
          update public.fiscal_period
          set status = 'soft_closed', reopened_by = ${ctx.userId}, reopened_at = now(),
              reopen_reason = ${input.reason}
          where id = ${input.periodId} and org_id = ${ctx.orgId}
        `);
        if (to === "soft_closed") return;
      }
      await tx.execute(sql`
        update public.fiscal_period
        set status = ${to},
            closed_by = ${to === "open" ? null : ctx.userId},
            closed_at = ${to === "open" ? null : sql`now()`},
            reopened_by = ${reopening ? ctx.userId : sql`reopened_by`},
            reopened_at = ${reopening ? sql`now()` : sql`reopened_at`},
            reopen_reason = ${reopening ? (input.reason ?? null) : sql`reopen_reason`}
        where id = ${input.periodId} and org_id = ${ctx.orgId}
      `);
    },
  );
}

// ── journal drafts, posting, reversal ────────────────────────────────────────

export const JournalLineInput = z.object({
  accountId: z.string().uuid(),
  description: z.string().trim().max(500).optional(),
  debitMinor: z.number().int().min(0).default(0),
  creditMinor: z.number().int().min(0).default(0),
  jobId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  itemId: z.string().uuid().optional(),
  costCentreId: z.string().uuid().optional(),
  dims: z.record(z.string(), z.string()).optional(),
});

export const JournalEntryInput = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  journalKind: z
    .enum([
      "general",
      "sales",
      "purchase",
      "receipt",
      "payment",
      "contra",
      "opening",
      "adjustment",
      "accrual",
      "depreciation",
      "payroll",
      "inventory",
      "tax",
      "revaluation",
      "closing",
    ])
    .default("general"),
  memo: z.string().trim().max(1000).optional(),
  currency: z.string().length(3).optional(),
  exchangeRate: z.number().positive().default(1),
  lines: z.array(JournalLineInput).min(2).max(200),
});

function toBase(minor: number, rate: number): number {
  return Math.floor(minor * rate + 0.5);
}

async function orgBaseCurrency(tx: TenantTx, ctx: Ctx): Promise<string> {
  const rows = (await tx.execute(sql`
    select base_currency from public.org where id = ${ctx.orgId}
  `)) as unknown as Array<{ base_currency: string }>;
  return rows[0]!.base_currency;
}

async function insertLinesIn(
  tx: TenantTx,
  ctx: Ctx,
  entryId: string,
  lines: Array<z.infer<typeof JournalLineInput>>,
  rate: number,
): Promise<void> {
  let n = 1;
  for (const l of lines) {
    if (l.debitMinor > 0 === l.creditMinor > 0) {
      throw new FinanceError("each line is a debit OR a credit, exactly one", "unbalanced");
    }
    await tx.execute(sql`
      insert into public.journal_line
        (org_id, entry_id, line_no, account_id, description,
         debit_minor, credit_minor, base_debit_minor, base_credit_minor,
         job_id, department_id, employee_id, customer_id, supplier_id, item_id,
         cost_centre_id, dims)
      values (${ctx.orgId}, ${entryId}, ${n}, ${l.accountId}, ${l.description ?? null},
              ${l.debitMinor}, ${l.creditMinor},
              ${toBase(l.debitMinor, rate)}, ${toBase(l.creditMinor, rate)},
              ${l.jobId ?? null}, ${l.departmentId ?? null}, ${l.employeeId ?? null},
              ${l.customerId ?? null}, ${l.supplierId ?? null}, ${l.itemId ?? null},
              ${l.costCentreId ?? null}, ${JSON.stringify(l.dims ?? {})}::jsonb)
    `);
    n++;
  }
}

export async function createJournalEntry(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; entryNo: string }> {
  assertCan(archetype, "finance.post");
  await requireCapability(ctx, "cap.finance");
  const input = JournalEntryInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string; entryNo: string }) => ({
        action: "finance.journal.create",
        entityType: "journal_entry",
        entityId: r.id,
        summary: `Draft journal ${r.entryNo} (${input.lines.length} line(s))`,
      }),
    },
    async (tx) => {
      const base = await orgBaseCurrency(tx, ctx);
      const currency = input.currency ?? base;
      const rate = currency === base ? 1 : input.exchangeRate;
      if (currency !== base && input.exchangeRate === 1) {
        throw new FinanceError(
          `a ${currency} entry needs an explicit exchange rate to ${base} — rates are never invented`,
        );
      }
      const seq = await allocateReference(tx, ctx, "journal_entry");
      const entryNo = formatRef("JRN", seq, 5);
      const rows = (await tx.execute(sql`
        insert into public.journal_entry
          (org_id, entry_no, entry_date, journal_kind, memo, currency, base_currency,
           exchange_rate, rate_source, created_by)
        values (${ctx.orgId}, ${entryNo}, ${input.entryDate}, ${input.journalKind},
                ${input.memo ?? null}, ${currency}, ${base}, ${rate},
                ${currency === base ? "base" : "manual"}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;
      await insertLinesIn(tx, ctx, id, input.lines, rate);
      return { id, entryNo };
    },
  );
}

/**
 * Segregation of duties: when the org routes journals through the approval
 * engine (an active rule for 'journal_entry' exists), a poster without
 * finance.approve needs a decided approval for this entry.
 */
async function assertJournalApprovedIn(
  tx: TenantTx,
  ctx: Ctx,
  archetype: RoleArchetype,
  entryId: string,
): Promise<void> {
  if (can(archetype, "finance.approve")) return;
  const rules = (await tx.execute(sql`
    select 1 from public.approval_rule
    where org_id = ${ctx.orgId} and subject_type = 'journal_entry' and active
    limit 1
  `)) as unknown as unknown[];
  if (rules.length === 0) return;
  const approved = (await tx.execute(sql`
    select 1 from public.approval
    where org_id = ${ctx.orgId} and subject_type = 'journal_entry'
      and subject_id = ${entryId} and state = 'approved'
    limit 1
  `)) as unknown as unknown[];
  if (approved.length === 0) {
    throw new FinanceError(
      "this organization requires journal approval before posting",
      "forbidden",
    );
  }
}

export async function postJournalEntry(
  ctx: Ctx,
  archetype: RoleArchetype,
  entryId: string,
): Promise<void> {
  assertCan(archetype, "finance.post");
  await command(
    ctx,
    {
      audit: {
        action: "finance.journal.post",
        entityType: "journal_entry",
        entityId: entryId,
        summary: "Posted journal entry",
      },
    },
    async (tx) => {
      await assertJournalApprovedIn(tx, ctx, archetype, entryId);
      await tx.execute(sql`select app.post_journal_entry(${entryId})`);
    },
  );
}

export async function cancelDraftJournal(
  ctx: Ctx,
  archetype: RoleArchetype,
  entryId: string,
): Promise<void> {
  assertCan(archetype, "finance.post");
  await command(
    ctx,
    {
      audit: {
        action: "finance.journal.cancel",
        entityType: "journal_entry",
        entityId: entryId,
        summary: "Cancelled draft journal",
      },
    },
    (tx) => tx.execute(sql`select app.cancel_draft_journal_entry(${entryId})`),
  );
}

export async function reverseJournalEntry(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ reversalId: string; entryNo: string }> {
  assertCan(archetype, "finance.post");
  const input = z
    .object({
      entryId: z.string().uuid(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      memo: z.string().trim().min(1).max(1000),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { reversalId: string; entryNo: string }) => ({
        action: "finance.journal.reverse",
        entityType: "journal_entry",
        entityId: input.entryId,
        summary: `Reversed by ${r.entryNo}: ${input.memo}`,
      }),
    },
    async (tx) => {
      const seq = await allocateReference(tx, ctx, "journal_entry");
      const entryNo = formatRef("JRN", seq, 5);
      const rows = (await tx.execute(sql`
        select app.reverse_journal_entry(${input.entryId}, ${input.date}, ${entryNo},
                                         ${input.memo})::text as id
      `)) as unknown as Array<{ id: string }>;
      return { reversalId: rows[0]!.id, entryNo };
    },
  );
}

// ── the bridge every posting rule drives through ─────────────────────────────

export type SourcePostingLine = {
  accountId: string;
  description?: string;
  debitMinor?: number;
  creditMinor?: number;
  jobId?: string;
  departmentId?: string;
  employeeId?: string;
  customerId?: string;
  supplierId?: string;
  itemId?: string;
  costCentreId?: string;
};

/**
 * Create AND post one entry from a business source, inside the caller's
 * command transaction. Idempotent by (source, event): a concurrent or retried
 * call hits the unique index and this function returns the existing entry
 * instead of failing the business action.
 */
export async function postFromSourceIn(
  tx: TenantTx,
  ctx: Ctx,
  params: {
    sourceType: string;
    sourceId: string;
    eventKey: string;
    ruleKey: string;
    ruleVersion: string;
    journalKind: string;
    entryDate: string;
    currency: string;
    exchangeRate: number;
    memo?: string;
    lines: SourcePostingLine[];
    /** Posting rules may hit control accounts; ordinary journals may not. */
    controlOk?: boolean;
  },
): Promise<{ entryId: string; entryNo: string; alreadyPosted: boolean }> {
  const existing = (await tx.execute(sql`
    select id::text as id, entry_no from public.journal_entry
    where org_id = ${ctx.orgId} and source_type = ${params.sourceType}
      and source_id = ${params.sourceId} and event_key = ${params.eventKey}
      and status in ('posted', 'reversed')
    limit 1
  `)) as unknown as Array<{ id: string; entry_no: string }>;
  if (existing[0]) {
    return { entryId: existing[0].id, entryNo: existing[0].entry_no, alreadyPosted: true };
  }

  const base = await orgBaseCurrency(tx, ctx);
  const rate = params.currency === base ? 1 : params.exchangeRate;
  if (params.currency !== base && !(rate > 0 && rate !== 1)) {
    // rate === 1 for a foreign currency is almost always a missing rate.
    if (params.exchangeRate === 1) {
      throw new FinanceError(
        `posting a ${params.currency} source needs its snapshot rate to ${base}`,
      );
    }
  }
  const seq = await allocateReference(tx, ctx, "journal_entry");
  const entryNo = formatRef("JRN", seq, 5);
  const rows = (await tx.execute(sql`
    insert into public.journal_entry
      (org_id, entry_no, entry_date, journal_kind, memo, currency, base_currency,
       exchange_rate, rate_source, source_type, source_id, event_key,
       rule_key, rule_version, created_by)
    values (${ctx.orgId}, ${entryNo}, ${params.entryDate}, ${params.journalKind},
            ${params.memo ?? null}, ${params.currency}, ${base}, ${rate},
            ${params.currency === base ? "base" : "manual"},
            ${params.sourceType}, ${params.sourceId}, ${params.eventKey},
            ${params.ruleKey}, ${params.ruleVersion}, ${ctx.userId})
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  const entryId = rows[0]!.id;
  await insertLinesIn(
    tx,
    ctx,
    entryId,
    params.lines.map((l) => ({
      accountId: l.accountId,
      description: l.description,
      debitMinor: l.debitMinor ?? 0,
      creditMinor: l.creditMinor ?? 0,
      jobId: l.jobId,
      departmentId: l.departmentId,
      employeeId: l.employeeId,
      customerId: l.customerId,
      supplierId: l.supplierId,
      itemId: l.itemId,
      costCentreId: l.costCentreId,
      dims: undefined,
    })),
    rate,
  );
  if (params.controlOk) {
    await tx.execute(sql`select set_config('app.gl_control_ok', '1', true)`);
  }
  const postedRows = (await tx.execute(sql`
    select app.post_journal_entry(${entryId})::text as id
  `)) as unknown as Array<{ id: string }>;
  if (params.controlOk) {
    await tx.execute(sql`select set_config('app.gl_control_ok', '', true)`);
  }
  const survivorId = postedRows[0]!.id;
  if (survivorId !== entryId) {
    // Lost the one-event race inside the posting function: adopt the winner
    // (our own draft was cancelled in there — nothing dangles).
    const winner = (await tx.execute(sql`
      select entry_no from public.journal_entry
      where id = ${survivorId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<{ entry_no: string }>;
    return { entryId: survivorId, entryNo: winner[0]!.entry_no, alreadyPosted: true };
  }
  return { entryId, entryNo, alreadyPosted: false };
}

// ── reads and reconciliation ─────────────────────────────────────────────────

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  accountType: string;
  debitMinor: number;
  creditMinor: number;
};

/** Recomputed from posted lines — never from a stored running total (D1). */
export async function trialBalance(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { from?: string; to?: string } = {},
): Promise<{ rows: TrialBalanceRow[]; totalDebitMinor: number; totalCreditMinor: number }> {
  assertCan(archetype, "finance.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select a.id::text as id, a.code, a.name_en, a.name_ar, a.account_type,
             coalesce(sum(l.base_debit_minor), 0)::text as d,
             coalesce(sum(l.base_credit_minor), 0)::text as c
      from public.gl_account a
      join public.journal_line l on l.account_id = a.id and l.org_id = a.org_id
      join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
      where a.org_id = ${ctx.orgId} and e.status in ('posted', 'reversed')
        ${opts.from ? sql`and e.entry_date >= ${opts.from}::date` : sql``}
        ${opts.to ? sql`and e.entry_date <= ${opts.to}::date` : sql``}
      group by a.id, a.code, a.name_en, a.name_ar, a.account_type
      order by a.code
    `),
  )) as unknown as Array<Record<string, string>>;
  let td = 0;
  let tc = 0;
  const out = rows.map((r) => {
    const d = Number(r.d);
    const c = Number(r.c);
    td += d;
    tc += c;
    return {
      accountId: r.id!,
      code: r.code!,
      nameEn: r.name_en!,
      nameAr: r.name_ar ?? null,
      accountType: r.account_type!,
      debitMinor: d,
      creditMinor: c,
    };
  });
  return { rows: out, totalDebitMinor: td, totalCreditMinor: tc };
}

export type LedgerDrift = {
  entryId: string;
  entryNo: string;
  kind: "totals_mismatch" | "unbalanced_lines";
  detail: string;
};

/** Reports drift; NEVER repairs (repair is an explicit, audited action). */
export async function ledgerReconciliation(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<{ drift: LedgerDrift[]; postedEntries: number }> {
  assertCan(archetype, "finance.view");
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select e.id::text as id, e.entry_no,
             e.total_debit_minor::text as td, e.total_credit_minor::text as tc,
             coalesce(sum(l.debit_minor), 0)::text as ld,
             coalesce(sum(l.credit_minor), 0)::text as lc,
             coalesce(sum(l.base_debit_minor), 0)::text as lbd,
             coalesce(sum(l.base_credit_minor), 0)::text as lbc
      from public.journal_entry e
      left join public.journal_line l on l.entry_id = e.id and l.org_id = e.org_id
      where e.org_id = ${ctx.orgId} and e.status in ('posted', 'reversed')
      group by e.id, e.entry_no, e.total_debit_minor, e.total_credit_minor
    `)) as unknown as Array<Record<string, string>>;
    const drift: LedgerDrift[] = [];
    for (const r of rows) {
      if (r.ld !== r.lc || r.lbd !== r.lbc) {
        drift.push({
          entryId: r.id!,
          entryNo: r.entry_no!,
          kind: "unbalanced_lines",
          detail: `lines D ${r.ld} / C ${r.lc} (base D ${r.lbd} / C ${r.lbc})`,
        });
      } else if (r.td !== r.ld || r.tc !== r.lc) {
        drift.push({
          entryId: r.id!,
          entryNo: r.entry_no!,
          kind: "totals_mismatch",
          detail: `stored D ${r.td} / C ${r.tc} vs lines D ${r.ld} / C ${r.lc}`,
        });
      }
    }
    return { drift, postedEntries: rows.length };
  });
}
