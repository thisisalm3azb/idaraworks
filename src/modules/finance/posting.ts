/**
 * H24D/F — the posting rules: business documents → journal entries.
 *
 * Versioned, idempotent, source-linked (truth map D2/D8). Every rule:
 *   - no-ops when the org has not adopted finance (no config);
 *   - refuses nothing silently once adopted — a document that cannot post
 *     fails its business action loudly (books never diverge quietly);
 *   - honours the books start date (D7): documents dated before it never
 *     post; they belong to reviewed opening balances.
 */
import { sql, type Ctx, type TenantTx } from "@/platform/tenancy";
import { FinanceError, postFromSourceIn, systemAccountIn } from "./ledger";
import { financeConfigIn } from "./chart";

export const POSTING_RULES_VERSION = "core-1";

type PostOutcome = { posted: boolean; entryId?: string; skipped?: string };

async function shouldPost(
  tx: TenantTx,
  ctx: Ctx,
  docDate: string,
): Promise<{ ok: boolean; reason?: string }> {
  const config = await financeConfigIn(tx, ctx);
  if (!config) return { ok: false, reason: "finance not set up" };
  if (docDate < config.booksStartDate) {
    return { ok: false, reason: `dated before books start ${config.booksStartDate}` };
  }
  return { ok: true };
}

/** cash | bank_transfer | card | cheque | other → the account money lands in. */
async function moneyAccountForMethodIn(tx: TenantTx, ctx: Ctx, method: string): Promise<string> {
  if (method === "cash") return systemAccountIn(tx, ctx, "cash_on_hand");
  if (method === "bank_transfer") return systemAccountIn(tx, ctx, "bank_default");
  return systemAccountIn(tx, ctx, "undeposited_funds");
}

// ── sales: invoices and credit notes ─────────────────────────────────────────

/**
 * Invoice issued: DR AR (customer) total / CR revenue subtotal / CR VAT output.
 * Credit note issued: the exact mirror. One event each.
 */
export async function postInvoiceIssuedIn(
  tx: TenantTx,
  ctx: Ctx,
  invoiceId: string,
): Promise<PostOutcome> {
  const rows = (await tx.execute(sql`
    select kind, customer_id::text as customer_id, job_id::text as job_id,
           currency, exchange_rate::text as rate,
           subtotal_minor::text as subtotal, vat_amount_minor::text as vat,
           total_minor::text as total, coalesce(issued_at::date, current_date)::text as d,
           reference
    from public.invoice where id = ${invoiceId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<Record<string, string | null>>;
  const inv = rows[0];
  if (!inv) throw new FinanceError("invoice not found", "not_found");
  const gate = await shouldPost(tx, ctx, inv.d!);
  if (!gate.ok) return { posted: false, skipped: gate.reason };

  const ar = await systemAccountIn(tx, ctx, "ar_control");
  const revenue = await systemAccountIn(tx, ctx, "sales_revenue");
  const vatOut = await systemAccountIn(tx, ctx, "vat_output");
  const isCredit = inv.kind === "credit_note";
  const total = Number(inv.total);
  const subtotal = Number(inv.subtotal);
  const vat = Number(inv.vat);

  const lines = isCredit
    ? [
        {
          accountId: revenue,
          debitMinor: subtotal,
          jobId: inv.job_id ?? undefined,
          customerId: inv.customer_id ?? undefined,
          description: `Credit note ${inv.reference}`,
        },
        ...(vat > 0 ? [{ accountId: vatOut, debitMinor: vat, description: "VAT reversal" }] : []),
        {
          accountId: ar,
          creditMinor: total,
          customerId: inv.customer_id ?? undefined,
          description: `Credit note ${inv.reference}`,
        },
      ]
    : [
        {
          accountId: ar,
          debitMinor: total,
          customerId: inv.customer_id ?? undefined,
          description: `Invoice ${inv.reference}`,
        },
        {
          accountId: revenue,
          creditMinor: subtotal,
          jobId: inv.job_id ?? undefined,
          customerId: inv.customer_id ?? undefined,
          description: `Invoice ${inv.reference}`,
        },
        ...(vat > 0 ? [{ accountId: vatOut, creditMinor: vat, description: "VAT output" }] : []),
      ];

  const r = await postFromSourceIn(tx, ctx, {
    sourceType: "invoice",
    sourceId: invoiceId,
    eventKey: "issued",
    ruleKey: isCredit ? "sales.credit_note" : "sales.invoice",
    ruleVersion: POSTING_RULES_VERSION,
    journalKind: "sales",
    entryDate: inv.d!,
    currency: inv.currency!,
    exchangeRate: Number(inv.rate ?? 1),
    memo: `${isCredit ? "Credit note" : "Invoice"} ${inv.reference}`,
    controlOk: true,
    lines,
  });
  return { posted: !r.alreadyPosted, entryId: r.entryId };
}

// ── receipts: customer payments ──────────────────────────────────────────────

export async function postPaymentReceivedIn(
  tx: TenantTx,
  ctx: Ctx,
  paymentId: string,
): Promise<PostOutcome> {
  const rows = (await tx.execute(sql`
    select customer_id::text as customer_id, method, payment_date::text as d,
           amount_minor::text as amount, currency, exchange_rate::text as rate, reference
    from public.payment where id = ${paymentId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<Record<string, string | null>>;
  const p = rows[0];
  if (!p) throw new FinanceError("payment not found", "not_found");
  const gate = await shouldPost(tx, ctx, p.d!);
  if (!gate.ok) return { posted: false, skipped: gate.reason };

  const money = await moneyAccountForMethodIn(tx, ctx, p.method!);
  const ar = await systemAccountIn(tx, ctx, "ar_control");
  const amount = Number(p.amount);
  const r = await postFromSourceIn(tx, ctx, {
    sourceType: "payment",
    sourceId: paymentId,
    eventKey: "received",
    ruleKey: "ar.receipt",
    ruleVersion: POSTING_RULES_VERSION,
    journalKind: "receipt",
    entryDate: p.d!,
    currency: p.currency!,
    exchangeRate: Number(p.rate ?? 1),
    memo: `Customer payment ${p.reference}`,
    controlOk: true,
    lines: [
      { accountId: money, debitMinor: amount, description: `Payment ${p.reference}` },
      {
        accountId: ar,
        creditMinor: amount,
        customerId: p.customer_id ?? undefined,
        description: `Payment ${p.reference}`,
      },
    ],
  });
  return { posted: !r.alreadyPosted, entryId: r.entryId };
}

/** Voiding a payment reverses its posting (if one exists), dated today. */
export async function reverseSourcePostingIn(
  tx: TenantTx,
  ctx: Ctx,
  params: { sourceType: string; sourceId: string; eventKey: string; reason: string },
): Promise<PostOutcome> {
  const rows = (await tx.execute(sql`
    select id::text as id from public.journal_entry
    where org_id = ${ctx.orgId} and source_type = ${params.sourceType}
      and source_id = ${params.sourceId} and event_key = ${params.eventKey}
      and status = 'posted'
  `)) as unknown as Array<{ id: string }>;
  if (!rows[0]) return { posted: false, skipped: "no posted entry to reverse" };
  const { allocateReference, formatRef } = await import("@/platform/reference/sequence");
  const seq = await allocateReference(tx, ctx, "journal_entry");
  const no = formatRef("JRN", seq, 5);
  const rev = (await tx.execute(sql`
    select app.reverse_journal_entry(${rows[0].id}, current_date, ${no}, ${params.reason})::text as id
  `)) as unknown as Array<{ id: string }>;
  return { posted: true, entryId: rev[0]!.id };
}

// ── expenses ─────────────────────────────────────────────────────────────────

export async function postExpenseRecordedIn(
  tx: TenantTx,
  ctx: Ctx,
  expenseId: string,
): Promise<PostOutcome> {
  const rows = (await tx.execute(sql`
    select job_id::text as job_id, costing_mapping, expense_date::text as d,
           amount_minor::text as net, vat_amount_minor::text as vat,
           total_minor::text as total, payment_status, reference
    from public.expense where id = ${expenseId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<Record<string, string | null>>;
  const e = rows[0];
  if (!e) throw new FinanceError("expense not found", "not_found");
  const gate = await shouldPost(tx, ctx, e.d!);
  if (!gate.ok) return { posted: false, skipped: gate.reason };

  const expenseAccount =
    e.costing_mapping === "overhead"
      ? await systemAccountIn(tx, ctx, "overhead_expense")
      : await systemAccountIn(tx, ctx, "direct_costs");
  const vatIn = await systemAccountIn(tx, ctx, "vat_input");
  const credit =
    e.payment_status === "paid"
      ? await systemAccountIn(tx, ctx, "cash_on_hand")
      : await systemAccountIn(tx, ctx, "accrued_expenses");
  const net = Number(e.net);
  const vat = Number(e.vat);
  const total = Number(e.total);

  const r = await postFromSourceIn(tx, ctx, {
    sourceType: "expense",
    sourceId: expenseId,
    eventKey: "recorded",
    ruleKey: "expense.recorded",
    ruleVersion: POSTING_RULES_VERSION,
    journalKind: "purchase",
    entryDate: e.d!,
    currency: (
      (await tx.execute(
        sql`select base_currency from public.org where id = ${ctx.orgId}`,
      )) as unknown as Array<{ base_currency: string }>
    )[0]!.base_currency,
    exchangeRate: 1,
    memo: `Expense ${e.reference}`,
    controlOk: true,
    lines: [
      {
        accountId: expenseAccount,
        debitMinor: net,
        jobId: e.job_id ?? undefined,
        description: `Expense ${e.reference}`,
      },
      ...(vat > 0 ? [{ accountId: vatIn, debitMinor: vat, description: "VAT input" }] : []),
      { accountId: credit, creditMinor: total, description: `Expense ${e.reference}` },
    ],
  });
  return { posted: !r.alreadyPosted, entryId: r.entryId };
}
