/**
 * Invoices + AR (doc 01 L4; doc 11 S6 "Bill"). An invoice is IMMUTABLE once issued
 * (§4.7): a cleared invoice is never cancelled — it is corrected by a credit_note
 * (F-8). Cancel is pre-issuance only. VAT is recorded per document and depends on the
 * org's VAT registration + the is_export zero-rating flag (a non-registered org and an
 * export supply both carry zero VAT). Multi-currency: the BASE amount is frozen at
 * issuance (OP-8). AR is a DB-side aggregate over invoice + payment (F-30). The
 * e-invoice submission runs through the provider-agnostic adapter (D4) — fake in S6.
 * invoice_issue is a direct permissioned action, NOT an approval subject (C-1).
 */
import { z } from "zod";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { command } from "@/platform/audit/command";
import { assertCan } from "@/platform/authz/can";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { getEInvoiceProvider } from "@/platform/einvoice/adapter";
import { INVOICE_ISSUED, INVOICE_VOIDED, CREDIT_NOTE_ISSUED } from "@/platform/events";
import type { CurrencyCode, RoleArchetype } from "@/platform/registries";
import { CURRENCY_CODES } from "@/platform/registries";

export class InvoiceNotFoundError extends Error {
  constructor() {
    super("invoice not found");
    this.name = "InvoiceNotFoundError";
  }
}
export class InvoiceStateError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "InvoiceStateError";
  }
}
export class InvalidInvoiceInputError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "InvalidInvoiceInputError";
  }
}

const InvoiceLineInput = z.object({
  description: z.string().trim().min(1).max(300),
  qty: z.number().positive(),
  unit: z.string().trim().min(1).max(16),
  unitPriceMinor: z.number().int().nonnegative(),
  vatRate: z.number().min(0).max(100).default(0),
});
export const CreateInvoiceInput = z.object({
  customerId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  quoteId: z.string().uuid().optional(),
  isExport: z.boolean().default(false),
  currency: z.enum(CURRENCY_CODES as unknown as [string, ...string[]]).optional(),
  exchangeRate: z.number().positive().default(1),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  lines: z.array(InvoiceLineInput).min(1),
});

/** Whether the org charges VAT at all (VAT-registered). A non-registered org issues
 * zero-VAT invoices (VAT-disabled mode). Mirrors costing's resolveVatBasis source. */
async function orgIsVatRegistered(tx: TenantTx, ctx: Ctx): Promise<boolean> {
  const rows = (await tx.execute(sql`
    select value from public.app_settings where org_id = ${ctx.orgId} and key = 'finance.vat_registered'
  `)) as unknown as Array<{ value: unknown }>;
  return rows[0] === undefined ? true : rows[0].value !== false;
}

export function computeInvoiceTotals(
  lines: Array<{ qty: number; unitPriceMinor: number; vatRate: number }>,
  opts: { vatApplies: boolean; exchangeRate: number },
): {
  lines: Array<{ lineTotalMinor: number; effectiveVatRate: number }>;
  subtotalMinor: number;
  vatAmountMinor: number;
  totalMinor: number;
  baseTotalMinor: number;
} {
  const computed = lines.map((l) => {
    const lineTotalMinor = Math.round(l.qty * l.unitPriceMinor);
    // No VAT when the org is not VAT-registered OR the supply is zero-rated (export).
    const effectiveVatRate = opts.vatApplies ? l.vatRate : 0;
    return { lineTotalMinor, effectiveVatRate };
  });
  const subtotalMinor = computed.reduce((s, l) => s + l.lineTotalMinor, 0);
  const vatAmountMinor = computed.reduce(
    (s, l) => s + Math.round((l.lineTotalMinor * l.effectiveVatRate) / 100),
    0,
  );
  const totalMinor = subtotalMinor + vatAmountMinor;
  const baseTotalMinor = Math.round(totalMinor * opts.exchangeRate);
  return { lines: computed, subtotalMinor, vatAmountMinor, totalMinor, baseTotalMinor };
}

async function customerSnapshot(tx: TenantTx, ctx: Ctx, customerId: string) {
  const rows = (await tx.execute(sql`
    select name, tax_reg_no from public.customer where id = ${customerId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ name: string; tax_reg_no: string | null }>;
  if (!rows[0]) throw new InvalidInvoiceInputError("customer not found");
  return { name: rows[0].name, taxRegNo: rows[0].tax_reg_no };
}

export async function createInvoice(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "invoices.manage");
  const input = CreateInvoiceInput.parse(raw);
  const currency = (input.currency ?? "AED") as CurrencyCode;

  return command(
    ctx,
    {
      audit: (r: { id: string; reference: string }) => ({
        action: "invoice.create",
        entityType: "invoice",
        entityId: r.id,
        summary: `Invoice ${r.reference} (draft)`,
      }),
    },
    async (tx) => {
      const vatApplies = (await orgIsVatRegistered(tx, ctx)) && !input.isExport;
      const totals = computeInvoiceTotals(input.lines, {
        vatApplies,
        exchangeRate: input.exchangeRate,
      });
      const snap = input.customerId ? await customerSnapshot(tx, ctx, input.customerId) : null;
      const seq = await allocateReference(tx, ctx, "invoice");
      const reference = formatRef("INV", seq);
      const rows = (await tx.execute(sql`
        insert into public.invoice
          (org_id, reference, kind, customer_id, customer_name, customer_tax_reg_no, job_id, quote_id,
           is_export, currency, exchange_rate, subtotal_minor, vat_amount_minor, total_minor,
           base_total_minor, due_date, created_by)
        values (${ctx.orgId}, ${reference}, 'invoice', ${input.customerId ?? null}, ${snap?.name ?? null},
                ${snap?.taxRegNo ?? null}, ${input.jobId ?? null}, ${input.quoteId ?? null},
                ${input.isExport}, ${currency}, ${input.exchangeRate}, ${totals.subtotalMinor},
                ${totals.vatAmountMinor}, ${totals.totalMinor}, ${totals.baseTotalMinor},
                ${input.dueDate ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;
      for (let i = 0; i < input.lines.length; i++) {
        const l = input.lines[i]!;
        const c = totals.lines[i]!;
        await tx.execute(sql`
          insert into public.invoice_line
            (org_id, invoice_id, description, qty, unit, unit_price_minor, vat_rate, line_total_minor, sort)
          values (${ctx.orgId}, ${id}, ${l.description}, ${l.qty}, ${l.unit}, ${l.unitPriceMinor},
                  ${c.effectiveVatRate}, ${c.lineTotalMinor}, ${i})
        `);
      }
      return { id, reference };
    },
  );
}

/** Issue a draft invoice — the immutable transition. Sets issued_at; emits invoice/issued. */
export async function issueInvoice(
  ctx: Ctx,
  archetype: RoleArchetype,
  invoiceId: string,
): Promise<void> {
  assertCan(archetype, "invoices.manage");
  await command(
    ctx,
    {
      audit: {
        action: "invoice.issue",
        entityType: "invoice",
        entityId: invoiceId,
        summary: "Issued invoice",
      },
      events: (r: { jobId: string | null }) => [
        { name: INVOICE_ISSUED, payload: { invoiceId, jobId: r.jobId ?? undefined } },
      ],
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.invoice set status = 'issued', issued_at = now(), updated_at = now()
        where id = ${invoiceId} and org_id = ${ctx.orgId} and status = 'draft'
        returning job_id::text as job_id
      `)) as unknown as Array<{ job_id: string | null }>;
      if (!rows[0]) throw new InvoiceStateError("only a draft invoice can be issued");
      return { jobId: rows[0].job_id };
    },
  );
}

/** Cancel a DRAFT invoice (pre-issuance only, reason required). Issued invoices are
 * corrected by a credit_note, never cancelled (F-8). */
export async function voidInvoice(
  ctx: Ctx,
  archetype: RoleArchetype,
  invoiceId: string,
  reason: string,
): Promise<void> {
  assertCan(archetype, "invoices.manage");
  if (!reason.trim()) throw new InvalidInvoiceInputError("a cancel reason is required");
  await command(
    ctx,
    {
      audit: {
        action: "invoice.void",
        entityType: "invoice",
        entityId: invoiceId,
        summary: `Cancelled draft invoice: ${reason}`,
      },
      events: [{ name: INVOICE_VOIDED, payload: { invoiceId } }],
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.invoice set status = 'cancelled', cancelled_at = now(),
          cancel_reason = ${reason}, updated_at = now()
        where id = ${invoiceId} and org_id = ${ctx.orgId} and status = 'draft'
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) {
        throw new InvoiceStateError("only a draft invoice can be cancelled (issued → credit note)");
      }
    },
  );
}

/** Issue a credit_note that corrects an ISSUED invoice (F-8): a new immutable record. */
export async function createCreditNote(
  ctx: Ctx,
  archetype: RoleArchetype,
  correctsInvoiceId: string,
  reason: string,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "invoices.manage");
  if (!reason.trim()) throw new InvalidInvoiceInputError("a credit-note reason is required");
  return command(
    ctx,
    {
      audit: (r: { id: string; reference: string }) => ({
        action: "invoice.credit_note",
        entityType: "invoice",
        entityId: r.id,
        summary: `Credit note ${r.reference} for invoice: ${reason}`,
      }),
      events: (r) => [
        { name: CREDIT_NOTE_ISSUED, payload: { invoiceId: r.id, correctsInvoiceId } },
      ],
    },
    async (tx) => {
      const src = (await tx.execute(sql`
        select customer_id::text as customer_id, customer_name, customer_tax_reg_no,
               job_id::text as job_id, currency, exchange_rate, subtotal_minor, vat_amount_minor,
               total_minor, base_total_minor, status
        from public.invoice where id = ${correctsInvoiceId} and org_id = ${ctx.orgId}
      `)) as unknown as Array<Record<string, unknown>>;
      if (!src[0]) throw new InvoiceNotFoundError();
      if (src[0].status === "draft" || src[0].status === "cancelled") {
        throw new InvoiceStateError("only an issued invoice is corrected by a credit note");
      }
      const s = src[0];
      const seq = await allocateReference(tx, ctx, "credit_note");
      const reference = formatRef("CN", seq);
      const rows = (await tx.execute(sql`
        insert into public.invoice
          (org_id, reference, kind, corrects_invoice_id, customer_id, customer_name, customer_tax_reg_no,
           job_id, currency, exchange_rate, subtotal_minor, vat_amount_minor, total_minor, base_total_minor,
           status, issued_at, notes, created_by)
        values (${ctx.orgId}, ${reference}, 'credit_note', ${correctsInvoiceId}, ${s.customer_id ?? null},
                ${s.customer_name ?? null}, ${s.customer_tax_reg_no ?? null}, ${s.job_id ?? null},
                ${s.currency}, ${s.exchange_rate}, ${Number(s.subtotal_minor)}, ${Number(s.vat_amount_minor)},
                ${Number(s.total_minor)}, ${Number(s.base_total_minor)}, 'issued', now(), ${reason}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      // Copy the corrected invoice's lines onto the credit note (same magnitude).
      await tx.execute(sql`
        insert into public.invoice_line
          (org_id, invoice_id, description, qty, unit, unit_price_minor, vat_rate, line_total_minor, sort)
        select org_id, ${rows[0]!.id}, description, qty, unit, unit_price_minor, vat_rate, line_total_minor, sort
        from public.invoice_line where invoice_id = ${correctsInvoiceId} and org_id = ${ctx.orgId}
      `);
      // Re-reconcile the CORRECTED invoice now that a credit offsets it: a fully-
      // credited invoice settles to 'paid' (leaving the collectible/overdue set), so
      // E-10 and AR agree with the credit note without waiting for a payment.
      await reconcileInvoiceStatus(tx, ctx, correctsInvoiceId);
      return { id: rows[0]!.id, reference };
    },
  );
}

/**
 * Submit an issued invoice to the e-invoice provider (fake in S6) through the adapter.
 * PUBLIC entry point — gated on invoices.manage (every other billing mutation is; this
 * writes an einvoice_submission and, in production, transmits a legal tax document).
 */
export async function submitEInvoice(
  ctx: Ctx,
  archetype: RoleArchetype,
  invoiceId: string,
): Promise<{ status: string; qr: string | null }> {
  assertCan(archetype, "invoices.manage");
  return submitEInvoiceInternal(ctx, invoiceId);
}

/**
 * TRUSTED internal path (no archetype gate) — for the INVOICE_ISSUED worker, whose
 * trigger already required invoices.manage. Never call from a request without gating.
 */
export async function submitEInvoiceInternal(
  ctx: Ctx,
  invoiceId: string,
): Promise<{ status: string; qr: string | null }> {
  const provider = getEInvoiceProvider();
  // Load the invoice OUTSIDE any tx, call the provider (a network op — never inside a
  // DB tx, §4.12), then persist the result.
  const inv = await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select reference, kind, corrects_invoice_id::text as corrects, customer_name, customer_tax_reg_no,
             currency, is_export, subtotal_minor, vat_amount_minor, total_minor,
             coalesce(issued_at, now())::text as issued_at, status
      from public.invoice where id = ${invoiceId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows[0];
  });
  if (!inv) throw new InvoiceNotFoundError();
  if (inv.status === "draft")
    throw new InvoiceStateError("issue the invoice before e-invoice submission");

  const result = await provider.submit({
    invoiceId,
    reference: inv.reference as string,
    kind: inv.kind as "invoice" | "credit_note",
    correctsReference: (inv.corrects as string | null) ?? null,
    customerName: (inv.customer_name as string | null) ?? null,
    customerTaxRegNo: (inv.customer_tax_reg_no as string | null) ?? null,
    currency: inv.currency as string,
    isExport: inv.is_export as boolean,
    subtotalMinor: Number(inv.subtotal_minor),
    vatMinor: Number(inv.vat_amount_minor),
    totalMinor: Number(inv.total_minor),
    issuedAt: inv.issued_at as string,
  });

  await withCtx(ctx, (tx) =>
    tx.execute(sql`
      insert into public.einvoice_submission
        (org_id, invoice_id, provider, status, external_id, cleared_at, error, attempts)
      values (${ctx.orgId}, ${invoiceId}, ${provider.name}, ${result.status},
              ${result.externalId}, ${result.clearedAt}, ${result.error}, 1)
      on conflict (org_id, invoice_id) do update set
        status = excluded.status, external_id = excluded.external_id, cleared_at = excluded.cleared_at,
        error = excluded.error, attempts = public.einvoice_submission.attempts + 1, updated_at = now()
    `),
  );
  return { status: result.status, qr: result.qr };
}

// ── AR (accounts receivable) — DB-side aggregate over invoice + payment (F-30) ──
// Money fields are null for a viewer without price privilege (redaction, like every
// other money read in this module) — ar.view and pricePrivileged are independent flags.
export type ARSummary = {
  outstandingMinor: number | null;
  current: number | null;
  d1_30: number | null;
  d31_60: number | null;
  d61_90: number | null;
  over90: number | null;
};

const REDACTED_AR: ARSummary = {
  outstandingMinor: null,
  current: null,
  d1_30: null,
  d31_60: null,
  d61_90: null,
  over90: null,
};

export async function computeAR(
  ctx: Ctx,
  archetype: RoleArchetype,
  asOf: string,
): Promise<ARSummary> {
  assertCan(archetype, "ar.view");
  if (!ctx.pricePrivileged) return REDACTED_AR;
  return withCtx(ctx, async (tx) => {
    // Each credit note is attributed to the invoice it corrects (corrects_invoice_id)
    // and reduces ONLY that invoice's net balance (floored at 0) — the same net that
    // feeds the aging buckets, so `outstanding` always equals the sum of its buckets,
    // never goes negative, and a credit note never offsets an unrelated invoice.
    const rows = (await tx.execute(sql`
      with inv as (
        select i.id,
          greatest(0,
            i.base_total_minor
            - coalesce((select sum(p.base_amount_minor) from public.payment p
                        where p.invoice_id = i.id and p.org_id = ${ctx.orgId}
                          and p.status in ('recorded','confirmed')), 0)
            - coalesce((select sum(cn.base_total_minor) from public.invoice cn
                        where cn.corrects_invoice_id = i.id and cn.org_id = ${ctx.orgId}
                          and cn.kind = 'credit_note' and cn.status <> 'cancelled'), 0)
          ) as bal,
          greatest(0, (${asOf}::date - coalesce(i.due_date, i.issued_at::date))) as age_days
        from public.invoice i
        where i.org_id = ${ctx.orgId} and i.kind = 'invoice'
          and i.status in ('issued','partially_paid')
      ),
      outstanding as (select id, bal, age_days from inv where bal > 0)
      select
        coalesce(sum(o.bal),0)::bigint as outstanding,
        coalesce(sum(o.bal) filter (where o.age_days <= 0),0)::bigint as current,
        coalesce(sum(o.bal) filter (where o.age_days between 1 and 30),0)::bigint as d1_30,
        coalesce(sum(o.bal) filter (where o.age_days between 31 and 60),0)::bigint as d31_60,
        coalesce(sum(o.bal) filter (where o.age_days between 61 and 90),0)::bigint as d61_90,
        coalesce(sum(o.bal) filter (where o.age_days > 90),0)::bigint as over90
      from outstanding o
    `)) as unknown as Array<Record<string, string>>;
    const r = rows[0]!;
    return {
      outstandingMinor: Number(r.outstanding),
      current: Number(r.current),
      d1_30: Number(r.d1_30),
      d31_60: Number(r.d31_60),
      d61_90: Number(r.d61_90),
      over90: Number(r.over90),
    };
  });
}

// ── reads (price-redacted) ────────────────────────────────────────────────────
export type InvoiceRow = {
  id: string;
  reference: string;
  kind: string;
  customerName: string | null;
  status: string;
  currency: string;
  totalMinor: number | null;
  dueDate: string | null;
  issuedAt: string | null;
};

export async function listInvoices(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { limit?: number } = {},
): Promise<InvoiceRow[]> {
  assertCan(archetype, "invoices.view");
  const seesPrice = ctx.pricePrivileged;
  const limit = Math.min(opts.limit ?? 200, 500);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, reference, kind, customer_name, status, currency, total_minor,
             due_date::text as due_date, issued_at::text as issued_at
      from public.invoice where org_id = ${ctx.orgId}
      order by created_at desc limit ${limit}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      reference: r.reference as string,
      kind: r.kind as string,
      customerName: (r.customer_name as string | null) ?? null,
      status: r.status as string,
      currency: r.currency as string,
      totalMinor: seesPrice ? Number(r.total_minor) : null,
      dueDate: (r.due_date as string | null) ?? null,
      issuedAt: (r.issued_at as string | null) ?? null,
    }));
  });
}

export type InvoiceDetail = InvoiceRow & {
  isExport: boolean;
  subtotalMinor: number | null;
  vatAmountMinor: number | null;
  customerTaxRegNo: string | null;
  correctsInvoiceId: string | null;
  eInvoiceStatus: string | null;
  lines: Array<{
    id: string;
    description: string;
    qty: number;
    unit: string;
    unitPriceMinor: number | null;
    vatRate: number;
    lineTotalMinor: number | null;
  }>;
};

export async function getInvoice(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<InvoiceDetail | null> {
  assertCan(archetype, "invoices.view");
  const seesPrice = ctx.pricePrivileged;
  return withCtx(ctx, async (tx) => {
    const q = (await tx.execute(sql`
      select i.id::text as id, i.reference, i.kind, i.customer_name, i.customer_tax_reg_no, i.status,
             i.currency, i.is_export, i.subtotal_minor, i.vat_amount_minor, i.total_minor,
             i.due_date::text as due_date, i.issued_at::text as issued_at,
             i.corrects_invoice_id::text as corrects_invoice_id,
             (select status from public.einvoice_submission e where e.invoice_id = i.id and e.org_id = ${ctx.orgId}) as einvoice_status
      from public.invoice i where i.id = ${id} and i.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    if (!q[0]) return null;
    const lines = (await tx.execute(sql`
      select id::text as id, description, qty, unit, unit_price_minor, vat_rate, line_total_minor
      from public.invoice_line where invoice_id = ${id} and org_id = ${ctx.orgId} order by sort
    `)) as unknown as Array<Record<string, unknown>>;
    const r = q[0];
    return {
      id: r.id as string,
      reference: r.reference as string,
      kind: r.kind as string,
      customerName: (r.customer_name as string | null) ?? null,
      customerTaxRegNo: (r.customer_tax_reg_no as string | null) ?? null,
      status: r.status as string,
      currency: r.currency as string,
      isExport: r.is_export as boolean,
      subtotalMinor: seesPrice ? Number(r.subtotal_minor) : null,
      vatAmountMinor: seesPrice ? Number(r.vat_amount_minor) : null,
      totalMinor: seesPrice ? Number(r.total_minor) : null,
      dueDate: (r.due_date as string | null) ?? null,
      issuedAt: (r.issued_at as string | null) ?? null,
      correctsInvoiceId: (r.corrects_invoice_id as string | null) ?? null,
      eInvoiceStatus: (r.einvoice_status as string | null) ?? null,
      lines: lines.map((l) => ({
        id: l.id as string,
        description: l.description as string,
        qty: Number(l.qty),
        unit: l.unit as string,
        unitPriceMinor: seesPrice ? Number(l.unit_price_minor) : null,
        vatRate: Number(l.vat_rate),
        lineTotalMinor: seesPrice ? Number(l.line_total_minor) : null,
      })),
    };
  });
}

/** INTERNAL (worker) — build the Arabic-primary invoice HTML from the RAW invoice +
 * lines (invoice amounts are service-redacted, NOT RLS-walled, so a direct read is
 * correct here). No assertCan: only the issue worker calls this. */
export async function buildInvoiceHtmlInternal(
  ctx: Ctx,
  invoiceId: string,
  qr: string | null,
): Promise<string | null> {
  return withCtx(ctx, async (tx) => {
    const inv = (await tx.execute(sql`
      select i.reference, i.kind, i.customer_name, i.customer_tax_reg_no, i.is_export, i.currency,
             i.subtotal_minor, i.vat_amount_minor, i.total_minor, i.issued_at::text as issued_at,
             i.due_date::text as due_date,
             (select reference from public.invoice c where c.id = i.corrects_invoice_id) as corrects_ref,
             (select name from public.org o where o.id = i.org_id) as org_name
      from public.invoice i where i.id = ${invoiceId} and i.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    if (!inv[0]) return null;
    const lines = (await tx.execute(sql`
      select description, qty, unit, unit_price_minor, vat_rate, line_total_minor
      from public.invoice_line where invoice_id = ${invoiceId} and org_id = ${ctx.orgId} order by sort
    `)) as unknown as Array<Record<string, unknown>>;
    const r = inv[0];
    const { invoiceHtml } = await import("./invoice-template");
    return invoiceHtml({
      reference: r.reference as string,
      kind: r.kind as "invoice" | "credit_note",
      correctsReference: (r.corrects_ref as string | null) ?? null,
      orgName: (r.org_name as string) ?? "",
      customerName: (r.customer_name as string | null) ?? null,
      customerTaxRegNo: (r.customer_tax_reg_no as string | null) ?? null,
      issuedAt: (r.issued_at as string | null) ?? null,
      dueDate: (r.due_date as string | null) ?? null,
      isExport: r.is_export as boolean,
      currency: r.currency as never,
      subtotalMinor: Number(r.subtotal_minor),
      vatMinor: Number(r.vat_amount_minor),
      totalMinor: Number(r.total_minor),
      qr,
      lines: lines.map((l) => ({
        description: l.description as string,
        qty: Number(l.qty),
        unit: l.unit as string,
        unitPriceMinor: Number(l.unit_price_minor),
        vatRate: Number(l.vat_rate),
        lineTotalMinor: Number(l.line_total_minor),
      })),
    });
  });
}

/** Reconcile an invoice's paid status from its payments (called after a payment). */
export async function reconcileInvoiceStatus(
  tx: TenantTx,
  ctx: Ctx,
  invoiceId: string,
): Promise<void> {
  // A credit note that corrects this invoice offsets it exactly like a payment
  // (F-8): a fully-credited invoice is settled even with no cash received, so the
  // 'paid' (terminal-settled) threshold counts paid + credited. The 'partially_paid'
  // label stays keyed on actual PAYMENTS; a partial credit leaves the invoice
  // 'issued' with the remaining net still collectible (and legitimately overdue-able).
  await tx.execute(sql`
    update public.invoice i set status = case
        when paid.total + credited.total >= i.base_total_minor then 'paid'
        when paid.total > 0 then 'partially_paid'
        else 'issued' end,
      updated_at = now()
    from (select coalesce(sum(base_amount_minor),0) as total from public.payment
          where invoice_id = ${invoiceId} and org_id = ${ctx.orgId} and status in ('recorded','confirmed')) paid,
         (select coalesce(sum(base_total_minor),0) as total from public.invoice
          where corrects_invoice_id = ${invoiceId} and org_id = ${ctx.orgId}
            and kind = 'credit_note' and status <> 'cancelled') credited
    where i.id = ${invoiceId} and i.org_id = ${ctx.orgId} and i.status in ('issued','partially_paid','paid')
  `);
}
