"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import {
  installFinanceSetup,
  installUaeVatPack,
  setVatProfile,
  createAccount,
  createJournalEntry,
  postJournalEntry,
  cancelDraftJournal,
  reverseJournalEntry,
  createBankAccount,
  recordMoneyTransaction,
  voidMoneyTransaction,
  startReconciliation,
  addMatch,
  completeReconciliation,
  allocatePayment,
  allocateSupplierPayment,
  prepareVatReturn,
  setReturnStatus,
  amendVatReturn,
  prepareCtWorkpaper,
  addCtAdjustment,
  saveBudget,
  setBudgetStatus,
} from "@/modules/finance/service";

/**
 * H24K server actions. One shape for all of them: resolve, call the service
 * (which enforces permission, entitlement, and every ledger invariant), and
 * land back with ?ok= or ?error=. NOTHING here decides anything financial —
 * a stale or forged form can at worst hit a service refusal.
 */
type Resolved = Exclude<Awaited<ReturnType<typeof resolveCtxForAction>>, string>;

async function resolveOrRedirect(orgId: string): Promise<Resolved> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  return resolved;
}

const isRedirect = (err: unknown) =>
  (err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT") ?? false;

function fail(base: string, err: unknown): never {
  if (isRedirect(err)) throw err;
  const message = err instanceof Error ? err.message : "failed";
  redirect(`${base}?error=${encodeURIComponent(message.slice(0, 160))}`);
}

// ── setup ────────────────────────────────────────────────────────────────────

export async function installFinanceAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/setup`;
  try {
    await installFinanceSetup(resolved.ctx, resolved.archetype, {
      booksStartDate: String(formData.get("books_start_date") ?? ""),
    });
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(`/o/${orgId}/finance`);
  redirect(`/o/${orgId}/finance?ok=installed`);
}

export async function installVatPackAction(orgId: string): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/setup`;
  try {
    await installUaeVatPack(resolved.ctx, resolved.archetype);
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=vat_pack`);
}

export async function setVatProfileAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/setup`;
  try {
    await setVatProfile(resolved.ctx, resolved.archetype, {
      trn: String(formData.get("trn") ?? ""),
      emirate: String(formData.get("emirate") ?? "DXB"),
      periodicity: String(formData.get("periodicity") ?? "quarterly"),
      registered: formData.get("registered") === "on",
    });
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=profile`);
}

// ── accounts ─────────────────────────────────────────────────────────────────

export async function createAccountAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/accounts`;
  try {
    await createAccount(resolved.ctx, resolved.archetype, {
      code: String(formData.get("code") ?? ""),
      nameEn: String(formData.get("name_en") ?? ""),
      nameAr: String(formData.get("name_ar") ?? "") || undefined,
      accountType: String(formData.get("account_type") ?? "expense"),
    });
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=created`);
}

// ── journals ─────────────────────────────────────────────────────────────────

export async function createJournalAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/journals`;
  // Up to 10 form rows; blank rows are skipped. Amounts arrive in MAJOR units
  // and are converted to integer minors here — the one UI-side convenience.
  const lines: Array<{ accountId: string; debitMinor: number; creditMinor: number }> = [];
  for (let i = 0; i < 10; i++) {
    const accountId = String(formData.get(`line_${i}_account`) ?? "");
    if (!accountId) continue;
    const debit = Math.round(Number(formData.get(`line_${i}_debit`) || 0) * 100);
    const credit = Math.round(Number(formData.get(`line_${i}_credit`) || 0) * 100);
    if (debit === 0 && credit === 0) continue;
    lines.push({ accountId, debitMinor: debit, creditMinor: credit });
  }
  let id = "";
  try {
    const r = await createJournalEntry(resolved.ctx, resolved.archetype, {
      entryDate: String(formData.get("entry_date") ?? ""),
      memo: String(formData.get("memo") ?? "") || undefined,
      lines,
    });
    id = r.id;
  } catch (err) {
    fail(`${base}/new`, err);
  }
  revalidatePath(base);
  redirect(`${base}/${id}?ok=created`);
}

export async function journalStepAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const entryId = String(formData.get("entry_id") ?? "");
  const step = String(formData.get("step") ?? "");
  const base = `/o/${orgId}/finance/journals/${entryId}`;
  try {
    if (step === "post") await postJournalEntry(resolved.ctx, resolved.archetype, entryId);
    else if (step === "cancel") await cancelDraftJournal(resolved.ctx, resolved.archetype, entryId);
    else if (step === "reverse") {
      await reverseJournalEntry(resolved.ctx, resolved.archetype, {
        entryId,
        date: String(formData.get("date") ?? ""),
        memo: String(formData.get("memo") ?? "reversal"),
      });
    } else redirect(`${base}?error=unknown_step`);
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  revalidatePath(`/o/${orgId}/finance/journals`);
  redirect(`${base}?ok=${step}`);
}

// ── banking ──────────────────────────────────────────────────────────────────

export async function createBankAccountAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/banking`;
  try {
    await createBankAccount(resolved.ctx, resolved.archetype, {
      name: String(formData.get("name") ?? ""),
      kind: String(formData.get("kind") ?? "bank"),
      glCode: String(formData.get("gl_code") ?? ""),
      bankName: String(formData.get("bank_name") ?? "") || undefined,
    });
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=account`);
}

export async function recordMoneyTransactionAction(
  orgId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/banking`;
  // The party kind follows whichever party the form named; with no party the
  // service DEMANDS an explicit contra account — never a silent default.
  const customerId = String(formData.get("customer_id") ?? "") || undefined;
  const supplierId = String(formData.get("supplier_id") ?? "") || undefined;
  const partyKind = customerId ? "customer" : supplierId ? "supplier" : undefined;
  try {
    await recordMoneyTransaction(resolved.ctx, resolved.archetype, {
      kind: String(formData.get("kind") ?? "receipt"),
      bankAccountId: String(formData.get("bank_account_id") ?? ""),
      counterBankAccountId: String(formData.get("counter_bank_account_id") ?? "") || undefined,
      partyKind,
      customerId,
      supplierId,
      contraAccountId: String(formData.get("contra_account_id") ?? "") || undefined,
      txnDate: String(formData.get("txn_date") ?? ""),
      amountMinor: Math.round(Number(formData.get("amount") || 0) * 100),
      memo: String(formData.get("memo") ?? "") || undefined,
    });
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=recorded`);
}

export async function voidMoneyTransactionAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/banking`;
  try {
    await voidMoneyTransaction(resolved.ctx, resolved.archetype, {
      id: String(formData.get("id") ?? ""),
      reason: String(formData.get("reason") ?? ""),
    });
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=voided`);
}

export async function startReconciliationAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/banking`;
  let id = "";
  try {
    const closing = formData.get("statement_closing");
    const r = await startReconciliation(resolved.ctx, resolved.archetype, {
      bankAccountId: String(formData.get("bank_account_id") ?? ""),
      label: String(formData.get("label") ?? ""),
      statementClosingMinor: closing ? Math.round(Number(closing) * 100) : undefined,
    });
    id = r.id;
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}/${id}?ok=started`);
}

export async function addMatchAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const reconId = String(formData.get("reconciliation_id") ?? "");
  const base = `/o/${orgId}/finance/banking/${reconId}`;
  try {
    await addMatch(resolved.ctx, resolved.archetype, {
      reconciliationId: reconId,
      statementLineId: String(formData.get("statement_line_id") ?? ""),
      journalLineId: String(formData.get("journal_line_id") ?? ""),
      amountMinor: Number(formData.get("amount_minor") ?? 0),
    });
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=matched`);
}

export async function completeReconciliationAction(
  orgId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const reconId = String(formData.get("reconciliation_id") ?? "");
  const base = `/o/${orgId}/finance/banking/${reconId}`;
  try {
    await completeReconciliation(resolved.ctx, resolved.archetype, reconId);
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=completed`);
}

// ── settlement allocation ────────────────────────────────────────────────────

export async function allocatePaymentAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/receivables`;
  try {
    await allocatePayment(resolved.ctx, resolved.archetype, {
      paymentId: String(formData.get("payment_id") ?? ""),
      allocations: [
        {
          invoiceId: String(formData.get("invoice_id") ?? ""),
          amountMinor: Math.round(Number(formData.get("amount") || 0) * 100),
        },
      ],
    });
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=allocated`);
}

export async function allocateSupplierPaymentAction(
  orgId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/payables`;
  try {
    await allocateSupplierPayment(resolved.ctx, resolved.archetype, {
      moneyTransactionId: String(formData.get("money_transaction_id") ?? ""),
      allocations: [
        {
          goodsReceiptId: String(formData.get("goods_receipt_id") ?? ""),
          amountMinor: Math.round(Number(formData.get("amount") || 0) * 100),
        },
      ],
    });
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=allocated`);
}

// ── tax ──────────────────────────────────────────────────────────────────────

export async function prepareVatReturnAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/tax`;
  try {
    await prepareVatReturn(resolved.ctx, resolved.archetype, {
      periodStart: String(formData.get("period_start") ?? ""),
      periodEnd: String(formData.get("period_end") ?? ""),
    });
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=prepared`);
}

export async function taxReturnStepAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/tax`;
  const returnId = String(formData.get("return_id") ?? "");
  const step = String(formData.get("step") ?? "");
  try {
    if (step === "amend") await amendVatReturn(resolved.ctx, resolved.archetype, returnId);
    else {
      await setReturnStatus(resolved.ctx, resolved.archetype, { returnId, status: step });
    }
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=${step}`);
}

export async function prepareCtWorkpaperAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/tax`;
  try {
    await prepareCtWorkpaper(resolved.ctx, resolved.archetype, {
      periodStart: String(formData.get("period_start") ?? ""),
      periodEnd: String(formData.get("period_end") ?? ""),
    });
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=prepared`);
}

export async function addCtAdjustmentAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/tax`;
  try {
    await addCtAdjustment(resolved.ctx, resolved.archetype, {
      returnId: String(formData.get("return_id") ?? ""),
      ruleKey: String(formData.get("rule_key") ?? ""),
      sourceAmountMinor: Math.round(Number(formData.get("source_amount") || 0) * 100),
      adjustmentMinor: Math.round(Number(formData.get("adjustment") || 0) * 100),
      calculation: String(formData.get("calculation") ?? ""),
      evidence: String(formData.get("evidence") ?? "") || undefined,
    });
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=adjustment`);
}

// ── budgets ──────────────────────────────────────────────────────────────────

export async function saveBudgetAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/budgets`;
  const lines: Array<{ accountId: string; amountMinor: number }> = [];
  for (let i = 0; i < 10; i++) {
    const accountId = String(formData.get(`line_${i}_account`) ?? "");
    const amount = Number(formData.get(`line_${i}_amount`) || 0);
    if (!accountId || !amount) continue;
    lines.push({ accountId, amountMinor: Math.round(amount * 100) });
  }
  try {
    await saveBudget(resolved.ctx, resolved.archetype, {
      fiscalYearId: String(formData.get("fiscal_year_id") ?? ""),
      name: String(formData.get("name") ?? ""),
      lines,
    });
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=saved`);
}

export async function budgetStatusAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOrRedirect(orgId);
  const base = `/o/${orgId}/finance/budgets`;
  try {
    await setBudgetStatus(resolved.ctx, resolved.archetype, {
      budgetId: String(formData.get("budget_id") ?? ""),
      status: String(formData.get("status") ?? ""),
    });
  } catch (err) {
    fail(base, err);
  }
  revalidatePath(base);
  redirect(`${base}?ok=status`);
}
