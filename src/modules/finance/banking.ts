/**
 * H24E — cash, banking and reconciliation.
 *
 * money_transaction is the canonical voucher for money outside customer
 * invoice receipts. Statements import from CSV with duplicate detection at
 * file AND line level. Suggestions show confidence and evidence; a human
 * confirms every match; completion locks the session (truth map D9). No live
 * bank connection exists or is claimed — the adapter seam is manual import.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { requireCapability } from "@/platform/entitlements";
import { FinanceError, postFromSourceIn, systemAccountIn } from "./ledger";
import { POSTING_RULES_VERSION, reverseSourcePostingIn } from "./posting";

// ── bank & cash accounts ─────────────────────────────────────────────────────

export async function createBankAccount(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; glAccountId: string }> {
  assertCan(archetype, "finance.manage");
  await requireCapability(ctx, "cap.finance");
  const input = z
    .object({
      name: z.string().trim().min(1).max(120),
      kind: z.enum(["bank", "cash", "petty_cash", "card_clearing"]).default("bank"),
      currency: z.string().length(3).optional(),
      accountNo: z.string().trim().max(40).optional(),
      iban: z.string().trim().max(40).optional(),
      bankName: z.string().trim().max(120).optional(),
      chequesEnabled: z.boolean().default(false),
      glCode: z.string().trim().min(1).max(20),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "finance.bank_account.create",
        entityType: "bank_account",
        entityId: r.id,
        summary: `Created ${input.kind} account ${input.name}`,
      }),
    },
    async (tx) => {
      const org = (await tx.execute(sql`
        select base_currency from public.org where id = ${ctx.orgId}
      `)) as unknown as Array<{ base_currency: string }>;
      const currency = input.currency ?? org[0]!.base_currency;
      const gl = (await tx.execute(sql`
        insert into public.gl_account
          (org_id, code, name_en, account_type, normal_balance, is_control, control_kind,
           currency, created_by)
        values (${ctx.orgId}, ${input.glCode}, ${input.name}, 'asset', 'debit', true,
                ${input.kind === "bank" || input.kind === "card_clearing" ? "bank" : "cash"},
                ${currency}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const rows = (await tx.execute(sql`
        insert into public.bank_account
          (org_id, name, kind, gl_account_id, currency, account_no, iban, bank_name,
           cheques_enabled, created_by)
        values (${ctx.orgId}, ${input.name}, ${input.kind}, ${gl[0]!.id}, ${currency},
                ${input.accountNo ?? null}, ${input.iban ?? null}, ${input.bankName ?? null},
                ${input.chequesEnabled}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id, glAccountId: gl[0]!.id };
    },
  );
}

async function bankGlIn(tx: TenantTx, ctx: Ctx, bankAccountId: string) {
  const rows = (await tx.execute(sql`
    select gl_account_id::text as gl, currency from public.bank_account
    where id = ${bankAccountId} and org_id = ${ctx.orgId} and active
  `)) as unknown as Array<{ gl: string; currency: string }>;
  if (!rows[0]) throw new FinanceError("bank account not found", "not_found");
  return rows[0];
}

// ── money transactions ───────────────────────────────────────────────────────

export const MoneyTransactionInput = z.object({
  kind: z.enum(["receipt", "payment", "transfer", "bank_charge", "bank_interest"]),
  bankAccountId: z.string().uuid(),
  counterBankAccountId: z.string().uuid().optional(),
  partyKind: z.enum(["customer", "supplier", "employee", "other"]).optional(),
  customerId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  contraAccountId: z.string().uuid().optional(),
  txnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountMinor: z.number().int().positive(),
  memo: z.string().trim().max(500).optional(),
  chequeNo: z.string().trim().max(40).optional(),
  chequeDueOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

/**
 * Record AND post one money voucher. The mapping is explicit:
 *   receipt  from customer → DR bank / CR AR (customer)
 *   receipt  other         → DR bank / CR contra account
 *   payment  to supplier   → DR GRNI (AP) / CR bank
 *   payment  to employee   → DR employee advances / CR bank
 *   payment  other         → DR contra account / CR bank
 *   transfer               → DR counter bank / CR bank
 *   bank_charge            → DR bank charges / CR bank
 *   bank_interest          → DR bank / CR other income
 */
export async function recordMoneyTransaction(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "finance.post");
  await requireCapability(ctx, "cap.finance");
  const input = MoneyTransactionInput.parse(raw);
  if (input.kind === "transfer" && !input.counterBankAccountId) {
    throw new FinanceError("a transfer needs the destination account");
  }
  if (
    (input.kind === "receipt" || input.kind === "payment") &&
    (input.partyKind === "other" || !input.partyKind) &&
    !input.contraAccountId
  ) {
    throw new FinanceError(
      "a receipt/payment without a customer, supplier or employee needs an explicit account — nothing is defaulted",
    );
  }
  return command(
    ctx,
    {
      audit: (r: { id: string; reference: string }) => ({
        action: "finance.money.record",
        entityType: "bank_account",
        entityId: input.bankAccountId,
        summary: `${input.kind} ${r.reference}`,
      }),
    },
    async (tx) => {
      const bank = await bankGlIn(tx, ctx, input.bankAccountId);
      const seq = await allocateReference(tx, ctx, "money_transaction");
      const reference = formatRef("MT", seq, 4);
      const rows = (await tx.execute(sql`
        insert into public.money_transaction
          (org_id, reference, kind, bank_account_id, counter_bank_account_id, party_kind,
           customer_id, supplier_id, employee_id, contra_account_id, txn_date,
           amount_minor, currency, exchange_rate, base_amount_minor, memo,
           cheque_no, cheque_due_on, idempotency_key, created_by)
        values (${ctx.orgId}, ${reference}, ${input.kind}, ${input.bankAccountId},
                ${input.counterBankAccountId ?? null}, ${input.partyKind ?? null},
                ${input.customerId ?? null}, ${input.supplierId ?? null},
                ${input.employeeId ?? null}, ${input.contraAccountId ?? null},
                ${input.txnDate}, ${input.amountMinor}, ${bank.currency}, 1,
                ${input.amountMinor}, ${input.memo ?? null}, ${input.chequeNo ?? null},
                ${input.chequeDueOn ?? null}, ${input.idempotencyKey ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;

      let debit: { accountId: string; dims?: Record<string, string | undefined> };
      let credit: { accountId: string; dims?: Record<string, string | undefined> };
      if (input.kind === "transfer") {
        const counter = await bankGlIn(tx, ctx, input.counterBankAccountId!);
        debit = { accountId: counter.gl };
        credit = { accountId: bank.gl };
      } else if (input.kind === "bank_charge") {
        debit = { accountId: await systemAccountIn(tx, ctx, "bank_charges") };
        credit = { accountId: bank.gl };
      } else if (input.kind === "bank_interest") {
        debit = { accountId: bank.gl };
        credit = { accountId: await systemAccountIn(tx, ctx, "other_income") };
      } else if (input.kind === "receipt") {
        debit = { accountId: bank.gl };
        credit =
          input.partyKind === "customer"
            ? {
                accountId: await systemAccountIn(tx, ctx, "ar_control"),
                dims: { customerId: input.customerId },
              }
            : { accountId: input.contraAccountId! };
      } else {
        // payment
        credit = { accountId: bank.gl };
        debit =
          input.partyKind === "supplier"
            ? {
                accountId: await systemAccountIn(tx, ctx, "grni"),
                dims: { supplierId: input.supplierId },
              }
            : input.partyKind === "employee"
              ? {
                  accountId: await systemAccountIn(tx, ctx, "employee_advances"),
                  dims: { employeeId: input.employeeId },
                }
              : { accountId: input.contraAccountId! };
      }
      await postFromSourceIn(tx, ctx, {
        sourceType: "money_transaction",
        sourceId: id,
        eventKey: "recorded",
        ruleKey: `money.${input.kind}`,
        ruleVersion: POSTING_RULES_VERSION,
        journalKind:
          input.kind === "transfer" ? "contra" : input.kind === "receipt" ? "receipt" : "payment",
        entryDate: input.txnDate,
        currency: bank.currency,
        exchangeRate: 1,
        memo: `${input.kind} ${reference}${input.memo ? ` — ${input.memo}` : ""}`,
        controlOk: true,
        lines: [
          {
            accountId: debit.accountId,
            debitMinor: input.amountMinor,
            description: reference,
            customerId: debit.dims?.customerId,
            supplierId: debit.dims?.supplierId,
            employeeId: debit.dims?.employeeId,
          },
          {
            accountId: credit.accountId,
            creditMinor: input.amountMinor,
            description: reference,
            customerId: credit.dims?.customerId,
            supplierId: credit.dims?.supplierId,
            employeeId: credit.dims?.employeeId,
          },
        ],
      });
      return { id, reference };
    },
  );
}

export async function voidMoneyTransaction(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "finance.post");
  const input = z
    .object({ id: z.string().uuid(), reason: z.string().trim().min(1).max(300) })
    .parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "finance.money.void",
        entityType: "bank_account",
        entityId: input.id,
        summary: `Voided money transaction: ${input.reason}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.money_transaction
        set status = 'void', voided_at = now(), void_reason = ${input.reason},
            voided_by = ${ctx.userId}, updated_at = now()
        where id = ${input.id} and org_id = ${ctx.orgId} and status = 'recorded'
        returning id
      `)) as unknown as unknown[];
      if (rows.length === 0) {
        throw new FinanceError("money transaction not found or already void", "not_found");
      }
      await reverseSourcePostingIn(tx, ctx, {
        sourceType: "money_transaction",
        sourceId: input.id,
        eventKey: "recorded",
        reason: `Voided: ${input.reason}`,
      });
    },
  );
}

// ── statement import ─────────────────────────────────────────────────────────

export type StatementCsvRow = {
  date: string;
  description: string;
  /** Signed major-units string or minor int — the caller maps columns. */
  amountMinor: number;
  balanceMinor?: number;
  externalRef?: string;
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Import one statement (already parsed to rows by the caller/UI mapping
 * step). The whole FILE dedupes on its hash; each LINE dedupes on
 * (date|amount|description|ref) per bank account — an overlapping export
 * cannot double-import a bank line.
 */
export async function importBankStatement(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ statementId: string; imported: number; duplicates: number }> {
  assertCan(archetype, "finance.reconcile");
  const input = z
    .object({
      bankAccountId: z.string().uuid(),
      label: z.string().trim().min(1).max(120),
      fileText: z.string().min(1),
      rows: z
        .array(
          z.object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            description: z.string().trim().min(1).max(500),
            amountMinor: z
              .number()
              .int()
              .refine((n) => n !== 0, "zero-amount line"),
            balanceMinor: z.number().int().optional(),
            externalRef: z.string().trim().max(120).optional(),
          }),
        )
        .min(1)
        .max(5000),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { statementId: string; imported: number; duplicates: number }) => ({
        action: "finance.statement.import",
        entityType: "bank_statement",
        entityId: r.statementId,
        summary: `Imported ${r.imported} line(s), ${r.duplicates} duplicate(s) skipped — ${input.label}`,
      }),
    },
    async (tx) => {
      await bankGlIn(tx, ctx, input.bankAccountId);
      const fileHash = sha256(input.fileText);
      const stmt = (await tx.execute(sql`
        insert into public.bank_statement
          (org_id, bank_account_id, label, file_hash, line_count, imported_by)
        values (${ctx.orgId}, ${input.bankAccountId}, ${input.label}, ${fileHash},
                ${input.rows.length}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const statementId = stmt[0]!.id;
      let imported = 0;
      let duplicates = 0;
      let lineNo = 1;
      for (const r of input.rows) {
        const lineHash = sha256(
          `${r.date}|${r.amountMinor}|${r.description}|${r.externalRef ?? ""}`,
        );
        const inserted = (await tx.execute(sql`
          insert into public.bank_statement_line
            (org_id, statement_id, bank_account_id, line_no, txn_date, description,
             amount_minor, running_balance_minor, external_ref, line_hash)
          values (${ctx.orgId}, ${statementId}, ${input.bankAccountId}, ${lineNo}, ${r.date},
                  ${r.description}, ${r.amountMinor}, ${r.balanceMinor ?? null},
                  ${r.externalRef ?? null}, ${lineHash})
          on conflict (org_id, bank_account_id, line_hash) do nothing
          returning id
        `)) as unknown as unknown[];
        if (inserted.length > 0) imported++;
        else duplicates++;
        lineNo++;
      }
      const last = input.rows[input.rows.length - 1];
      await tx.execute(sql`
        update public.bank_statement
        set line_count = ${imported},
            closing_balance_minor = ${last?.balanceMinor ?? null}
        where id = ${statementId} and org_id = ${ctx.orgId}
      `);
      return { statementId, imported, duplicates };
    },
  );
}

// ── reconciliation ───────────────────────────────────────────────────────────

export async function startReconciliation(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "finance.reconcile");
  const input = z
    .object({
      bankAccountId: z.string().uuid(),
      label: z.string().trim().min(1).max(120),
      statementClosingMinor: z.number().int().optional(),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "finance.reconciliation.start",
        entityType: "bank_reconciliation",
        entityId: r.id,
        summary: `Started reconciliation ${input.label}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.bank_reconciliation
          (org_id, bank_account_id, label, statement_closing_minor, started_by)
        values (${ctx.orgId}, ${input.bankAccountId}, ${input.label},
                ${input.statementClosingMinor ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export type MatchSuggestion = {
  statementLineId: string;
  journalLineId: string;
  confidence: "exact" | "near";
  evidence: string;
};

/**
 * Suggestions, never actions: unmatched statement lines against unmatched
 * ledger lines on the bank account. Exact = same amount AND date; near = same
 * amount within ±5 days. Every suggestion names its evidence.
 */
export async function suggestMatches(
  ctx: Ctx,
  archetype: RoleArchetype,
  bankAccountId: string,
): Promise<MatchSuggestion[]> {
  assertCan(archetype, "finance.reconcile");
  return withCtx(ctx, async (tx) => {
    const bank = await bankGlIn(tx, ctx, bankAccountId);
    const rows = (await tx.execute(sql`
      with unmatched_stmt as (
        select sl.id, sl.txn_date, sl.amount_minor, sl.description
        from public.bank_statement_line sl
        where sl.org_id = ${ctx.orgId} and sl.bank_account_id = ${bankAccountId}
          and not exists (select 1 from public.bank_match m
                          where m.org_id = sl.org_id and m.statement_line_id = sl.id
                            and m.voided_at is null)
      ),
      unmatched_gl as (
        select l.id, e.entry_date,
               (l.debit_minor - l.credit_minor) as signed_minor, e.entry_no
        from public.journal_line l
        join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
        where l.org_id = ${ctx.orgId} and l.account_id = ${bank.gl}
          and e.status = 'posted'
          and not exists (select 1 from public.bank_match m
                          where m.org_id = l.org_id and m.journal_line_id = l.id
                            and m.voided_at is null)
      )
      select s.id::text as sid, g.id::text as gid,
             (s.txn_date = g.entry_date) as exact_date,
             s.txn_date::text as sdate, g.entry_date::text as gdate,
             s.amount_minor::text as amount, g.entry_no
      from unmatched_stmt s
      join unmatched_gl g
        on g.signed_minor = s.amount_minor
       and abs(s.txn_date - g.entry_date) <= 5
      order by s.txn_date
      limit 500
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      statementLineId: r.sid as string,
      journalLineId: r.gid as string,
      confidence: r.exact_date === true ? ("exact" as const) : ("near" as const),
      evidence: `amount ${r.amount} · bank ${r.sdate} vs ledger ${r.gdate} (${r.entry_no})`,
    }));
  });
}

/** A human confirms one match (partial amounts allowed; 1:N and N:1 emerge
 *  from multiple rows). */
export async function addMatch(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "finance.reconcile");
  const input = z
    .object({
      reconciliationId: z.string().uuid(),
      statementLineId: z.string().uuid(),
      journalLineId: z.string().uuid(),
      amountMinor: z
        .number()
        .int()
        .refine((n) => n !== 0, "zero match"),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "finance.reconciliation.match",
        entityType: "bank_reconciliation",
        entityId: input.reconciliationId,
        summary: "Confirmed a statement match",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.bank_match
          (org_id, reconciliation_id, statement_line_id, journal_line_id, amount_minor, matched_by)
        values (${ctx.orgId}, ${input.reconciliationId}, ${input.statementLineId},
                ${input.journalLineId}, ${input.amountMinor}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export async function completeReconciliation(
  ctx: Ctx,
  archetype: RoleArchetype,
  reconciliationId: string,
): Promise<{ matched: number; unmatchedStatementLines: number }> {
  assertCan(archetype, "finance.reconcile");
  return command(
    ctx,
    {
      audit: {
        action: "finance.reconciliation.complete",
        entityType: "bank_reconciliation",
        entityId: reconciliationId,
        summary: "Completed and locked reconciliation",
      },
    },
    async (tx) => {
      const rec = (await tx.execute(sql`
        select bank_account_id::text as bank, status from public.bank_reconciliation
        where id = ${reconciliationId} and org_id = ${ctx.orgId}
        for update
      `)) as unknown as Array<{ bank: string; status: string }>;
      if (!rec[0]) throw new FinanceError("reconciliation not found", "not_found");
      if (rec[0].status !== "in_progress") {
        throw new FinanceError("reconciliation already completed");
      }
      const stats = (await tx.execute(sql`
        select
          (select count(*)::int from public.bank_match
           where org_id = ${ctx.orgId} and reconciliation_id = ${reconciliationId}
             and voided_at is null) as matched,
          (select count(*)::int from public.bank_statement_line sl
           where sl.org_id = ${ctx.orgId} and sl.bank_account_id = ${rec[0]!.bank}
             and not exists (select 1 from public.bank_match m
                             where m.org_id = sl.org_id and m.statement_line_id = sl.id
                               and m.voided_at is null)) as unmatched
      `)) as unknown as Array<{ matched: number; unmatched: number }>;
      await tx.execute(sql`
        update public.bank_reconciliation
        set status = 'completed', completed_by = ${ctx.userId}, completed_at = now()
        where id = ${reconciliationId} and org_id = ${ctx.orgId}
      `);
      return {
        matched: stats[0]!.matched,
        unmatchedStatementLines: stats[0]!.unmatched,
      };
    },
  );
}

/** What still needs a person: unmatched statement lines and unmatched ledger
 *  money — reported, never hidden. */
export async function unreconciledReport(
  ctx: Ctx,
  archetype: RoleArchetype,
  bankAccountId: string,
): Promise<{
  statementLines: Array<{ id: string; date: string; description: string; amountMinor: number }>;
  ledgerLines: Array<{ id: string; date: string; entryNo: string; signedMinor: number }>;
}> {
  assertCan(archetype, "finance.view");
  return withCtx(ctx, async (tx) => {
    const bank = await bankGlIn(tx, ctx, bankAccountId);
    const stmt = (await tx.execute(sql`
      select sl.id::text as id, sl.txn_date::text as d, sl.description,
             sl.amount_minor::text as a
      from public.bank_statement_line sl
      where sl.org_id = ${ctx.orgId} and sl.bank_account_id = ${bankAccountId}
        and not exists (select 1 from public.bank_match m
                        where m.org_id = sl.org_id and m.statement_line_id = sl.id
                          and m.voided_at is null)
      order by sl.txn_date limit 1000
    `)) as unknown as Array<Record<string, string>>;
    const gl = (await tx.execute(sql`
      select l.id::text as id, e.entry_date::text as d, e.entry_no,
             (l.debit_minor - l.credit_minor)::text as s
      from public.journal_line l
      join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
      where l.org_id = ${ctx.orgId} and l.account_id = ${bank.gl} and e.status = 'posted'
        and not exists (select 1 from public.bank_match m
                        where m.org_id = l.org_id and m.journal_line_id = l.id
                          and m.voided_at is null)
      order by e.entry_date limit 1000
    `)) as unknown as Array<Record<string, string>>;
    return {
      statementLines: stmt.map((r) => ({
        id: r.id!,
        date: r.d!,
        description: r.description!,
        amountMinor: Number(r.a),
      })),
      ledgerLines: gl.map((r) => ({
        id: r.id!,
        date: r.d!,
        entryNo: r.entry_no!,
        signedMinor: Number(r.s),
      })),
    };
  });
}

/** Cash position across all money accounts — recomputed from the ledger. */
export async function cashPosition(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<Array<{ bankAccountId: string; name: string; kind: string; balanceMinor: number }>> {
  assertCan(archetype, "finance.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select b.id::text as id, b.name, b.kind,
             coalesce(sum(l.base_debit_minor - l.base_credit_minor), 0)::text as bal
      from public.bank_account b
      left join public.journal_line l on l.account_id = b.gl_account_id and l.org_id = b.org_id
      left join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
        and e.status in ('posted', 'reversed')
      where b.org_id = ${ctx.orgId} and b.active
      group by b.id, b.name, b.kind
      order by b.name
    `),
  )) as unknown as Array<Record<string, string>>;
  return rows.map((r) => ({
    bankAccountId: r.id!,
    name: r.name!,
    kind: r.kind!,
    balanceMinor: Number(r.bal),
  }));
}

/** Allocate a supplier payment (money transaction) across received orders. */
export async function allocateSupplierPayment(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ allocated: number }> {
  assertCan(archetype, "finance.reconcile");
  const input = z
    .object({
      moneyTransactionId: z.string().uuid(),
      allocations: z
        .array(
          z.object({ goodsReceiptId: z.string().uuid(), amountMinor: z.number().int().positive() }),
        )
        .min(1)
        .max(100),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "finance.ap.allocate",
        entityType: "bank_account",
        entityId: input.moneyTransactionId,
        summary: `Allocated supplier payment across ${input.allocations.length} receipt(s)`,
      },
    },
    async (tx) => {
      const mt = (await tx.execute(sql`
        select supplier_id::text as supplier_id, amount_minor::text as amount, status, kind
        from public.money_transaction
        where id = ${input.moneyTransactionId} and org_id = ${ctx.orgId}
        for update
      `)) as unknown as Array<Record<string, string | null>>;
      const m = mt[0];
      if (!m) throw new FinanceError("money transaction not found", "not_found");
      if (m.status !== "recorded" || m.kind !== "payment" || !m.supplier_id) {
        throw new FinanceError("only a recorded supplier payment can be allocated");
      }
      const already = (await tx.execute(sql`
        select coalesce(sum(amount_minor), 0)::text as s from public.settlement_allocation
        where org_id = ${ctx.orgId} and payer_type = 'money_transaction'
          and payer_id = ${input.moneyTransactionId} and voided_at is null
      `)) as unknown as Array<{ s: string }>;
      const remaining = Number(m.amount) - Number(already[0]!.s);
      const total = input.allocations.reduce((a, x) => a + x.amountMinor, 0);
      if (total > remaining) {
        throw new FinanceError(
          `allocation ${total} exceeds unallocated ${remaining}`,
          "unbalanced",
        );
      }
      for (const a of input.allocations) {
        const grn = (await tx.execute(sql`
          select po.supplier_id::text as supplier_id
          from public.goods_receipt g
          join public.purchase_order po on po.id = g.po_id and po.org_id = g.org_id
          where g.id = ${a.goodsReceiptId} and g.org_id = ${ctx.orgId}
        `)) as unknown as Array<{ supplier_id: string | null }>;
        if (!grn[0]) throw new FinanceError("goods receipt not found", "not_found");
        if (grn[0].supplier_id !== m.supplier_id) {
          throw new FinanceError("payment and receipt belong to different suppliers");
        }
        await tx.execute(sql`
          insert into public.settlement_allocation
            (org_id, payer_type, payer_id, target_type, target_id,
             amount_minor, base_amount_minor, created_by)
          values (${ctx.orgId}, 'money_transaction', ${input.moneyTransactionId},
                  'goods_receipt', ${a.goodsReceiptId}, ${a.amountMinor}, ${a.amountMinor},
                  ${ctx.userId})
        `);
      }
      return { allocated: total };
    },
  );
}
