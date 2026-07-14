/**
 * Quotes (doc 01 L4; doc 11 S6 "Bill"). A quote is authored with lines (grouped by a
 * config quote_section), routed through the approval engine as `quote_send`, sent, and
 * ACCEPTED with evidence — acceptance converts it to a job (total → selling_price,
 * terms → payment_terms, billing_points seeded from the preset). Money in minor units,
 * VAT recorded per line; multi-currency with the base amount FROZEN at issuance and an
 * immutable exchange_rate (OP-8). No-hard-delete. Prices redact behind pricePrivileged
 * (finance.viewPrices) at read; every mutation runs through command()+audit+outbox.
 */
import { z } from "zod";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { command } from "@/platform/audit/command";
import { assertCan } from "@/platform/authz/can";
import { requireCapability } from "@/platform/entitlements";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { submitForApproval } from "@/modules/approvals/service";
import { createJobFromPreset } from "@/modules/jobs/service";
import { QUOTE_ACCEPTED } from "@/platform/events";
import type { CurrencyCode, RoleArchetype } from "@/platform/registries";
import { CURRENCY_CODES } from "@/platform/registries";

export class QuoteNotFoundError extends Error {
  constructor() {
    super("quote not found");
    this.name = "QuoteNotFoundError";
  }
}
export class QuoteStateError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "QuoteStateError";
  }
}
export class InvalidQuoteInputError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "InvalidQuoteInputError";
  }
}

const QuoteLineInput = z.object({
  sectionKey: z.string().trim().max(60).optional(),
  itemId: z.string().uuid().optional(),
  description: z.string().trim().min(1).max(300),
  qty: z.number().positive(),
  unit: z.string().trim().min(1).max(16),
  unitPriceMinor: z.number().int().nonnegative(),
  vatRate: z.number().min(0).max(100).default(0),
});
export const CreateQuoteInput = z.object({
  customerId: z.string().uuid().optional(),
  presetId: z.string().uuid().optional(),
  currency: z.enum(CURRENCY_CODES as unknown as [string, ...string[]]).optional(),
  exchangeRate: z.number().positive().default(1),
  terms: z.string().trim().max(2000).optional(),
  validUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  lines: z.array(QuoteLineInput).min(1),
});
export type CreateQuoteInput = z.infer<typeof CreateQuoteInput>;

/** Line/VAT/total math — pure, in minor units, no floats near money. */
export function computeQuoteTotals(
  lines: Array<{ qty: number; unitPriceMinor: number; vatRate: number }>,
  exchangeRate: number,
): {
  lines: Array<{ lineTotalMinor: number; lineVatMinor: number }>;
  subtotalMinor: number;
  vatAmountMinor: number;
  totalMinor: number;
  baseTotalMinor: number;
} {
  const computed = lines.map((l) => {
    const lineTotalMinor = Math.round(l.qty * l.unitPriceMinor);
    const lineVatMinor = Math.round((lineTotalMinor * l.vatRate) / 100);
    return { lineTotalMinor, lineVatMinor };
  });
  const subtotalMinor = computed.reduce((s, l) => s + l.lineTotalMinor, 0);
  const vatAmountMinor = computed.reduce((s, l) => s + l.lineVatMinor, 0);
  const totalMinor = subtotalMinor + vatAmountMinor;
  const baseTotalMinor = Math.round(totalMinor * exchangeRate);
  return { lines: computed, subtotalMinor, vatAmountMinor, totalMinor, baseTotalMinor };
}

async function customerName(tx: TenantTx, ctx: Ctx, customerId: string): Promise<string> {
  const rows = (await tx.execute(sql`
    select name from public.customer where id = ${customerId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ name: string }>;
  if (!rows[0]) throw new InvalidQuoteInputError("customer not found");
  return rows[0].name;
}

export async function createQuote(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "quotes.manage");
  // Add-on gate (FR-9): CREATE only — reads/exports and in-flight quotes never gate.
  await requireCapability(ctx, "cap.quoting");
  const input = CreateQuoteInput.parse(raw);
  const currency = (input.currency ?? "AED") as CurrencyCode;
  const totals = computeQuoteTotals(input.lines, input.exchangeRate);

  return command(
    ctx,
    {
      audit: (r: { id: string; reference: string }) => ({
        action: "quote.create",
        entityType: "quote",
        entityId: r.id,
        summary: `Quote ${r.reference}`,
        after: { totalMinor: totals.totalMinor, currency },
      }),
    },
    async (tx) => {
      const custName = input.customerId ? await customerName(tx, ctx, input.customerId) : null;
      const seq = await allocateReference(tx, ctx, "quote");
      const reference = formatRef("QT", seq);
      const rows = (await tx.execute(sql`
        insert into public.quote
          (org_id, reference, customer_id, customer_name, preset_id, currency, exchange_rate,
           subtotal_minor, vat_amount_minor, total_minor, base_total_minor, terms, valid_until, created_by)
        values (${ctx.orgId}, ${reference}, ${input.customerId ?? null}, ${custName},
                ${input.presetId ?? null}, ${currency}, ${input.exchangeRate},
                ${totals.subtotalMinor}, ${totals.vatAmountMinor}, ${totals.totalMinor},
                ${totals.baseTotalMinor}, ${input.terms ?? null}, ${input.validUntil ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;
      for (let i = 0; i < input.lines.length; i++) {
        const l = input.lines[i]!;
        const c = totals.lines[i]!;
        await tx.execute(sql`
          insert into public.quote_line
            (org_id, quote_id, section_key, item_id, description, qty, unit, unit_price_minor, vat_rate, line_total_minor, sort)
          values (${ctx.orgId}, ${id}, ${l.sectionKey ?? null}, ${l.itemId ?? null}, ${l.description},
                  ${l.qty}, ${l.unit}, ${l.unitPriceMinor}, ${l.vatRate}, ${c.lineTotalMinor}, ${i})
        `);
      }
      return { id, reference };
    },
  );
}

/** Submit a draft quote for the quote_send approval (always → owner/admin, D-5.3). */
export async function submitQuote(
  ctx: Ctx,
  archetype: RoleArchetype,
  quoteId: string,
): Promise<{ approvalId: string }> {
  assertCan(archetype, "quotes.manage");
  return command(
    ctx,
    {
      audit: {
        action: "quote.submit",
        entityType: "quote",
        entityId: quoteId,
        summary: "Submitted quote for send approval",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.quote set status = 'pending_approval', updated_at = now()
        where id = ${quoteId} and org_id = ${ctx.orgId} and status in ('draft', 'rejected')
        returning reference, total_minor, customer_name
      `)) as unknown as Array<{
        reference: string;
        total_minor: string;
        customer_name: string | null;
      }>;
      if (!rows[0]) throw new QuoteStateError("only a draft quote can be submitted");
      const res = await submitForApproval(tx, ctx, {
        subjectType: "quote_send",
        subjectId: quoteId,
        subjectSummary: {
          title: `Quote ${rows[0].reference}${rows[0].customer_name ? ` — ${rows[0].customer_name}` : ""}`,
          amountMinor: Number(rows[0].total_minor),
        },
        amountMinor: Number(rows[0].total_minor),
      });
      // Auto-approve (rule below threshold) decides at submission with NO human
      // decideApproval — the engine hands the subject advance back to the caller
      // (mirrors S4 supply). Without this the quote is stranded in pending_approval
      // forever: never sendable, never acceptable, with no pending approval to act on.
      if (res.decided) {
        await tx.execute(sql`
          update public.quote set status = 'approved', updated_at = now()
          where id = ${quoteId} and org_id = ${ctx.orgId} and status = 'pending_approval'
        `);
      }
      return { approvalId: res.approvalId };
    },
  );
}

/** Mark a sendable (approved) quote as sent to the customer. */
export async function markQuoteSent(
  ctx: Ctx,
  archetype: RoleArchetype,
  quoteId: string,
): Promise<void> {
  assertCan(archetype, "quotes.manage");
  await command(
    ctx,
    {
      audit: {
        action: "quote.send",
        entityType: "quote",
        entityId: quoteId,
        summary: "Sent quote",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.quote set status = 'sent', updated_at = now()
        where id = ${quoteId} and org_id = ${ctx.orgId} and status = 'approved'
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new QuoteStateError("only an approved quote can be sent");
    },
  );
}

export const AcceptQuoteInput = z.object({
  note: z.string().trim().max(2000).optional(),
  evidenceFileId: z.string().uuid().optional(),
  jobName: z.string().trim().min(1).max(160).optional(),
});

/**
 * Accept a quote WITH EVIDENCE and convert it to a job. To keep the accept ATOMIC
 * (createJobFromPreset commits its own transaction, so it cannot share the convert
 * tx), the quote is first CLAIMED into a transient 'converting' state by one guarded
 * UPDATE: concurrent accepts / retries race on it and only one wins, so a second
 * (orphan) job can never be created. The job is then built from the quote's preset
 * (stages + billing_points), its selling price (frozen base) + terms are set, and the
 * quote is linked + marked converted. On a job-creation failure the claim is released.
 */
export async function acceptQuote(
  ctx: Ctx,
  archetype: RoleArchetype,
  quoteId: string,
  raw: unknown,
): Promise<{ jobId: string }> {
  assertCan(archetype, "quotes.manage");
  const input = AcceptQuoteInput.parse(raw);

  // CLAIM: atomically move approved/sent → converting (only if it has a preset and is
  // not already converting/converted). The single guarded UPDATE is the serialization
  // point — a losing racer matches 0 rows and never reaches createJobFromPreset.
  const claimed = await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      update public.quote set status = 'converting', accepted_at = now(),
          accepted_note = ${input.note ?? null},
          acceptance_evidence_file_id = ${input.evidenceFileId ?? null}, updated_at = now()
      where id = ${quoteId} and org_id = ${ctx.orgId}
        and status in ('approved', 'sent') and converted_job_id is null and preset_id is not null
      returning preset_id::text as preset_id, customer_id::text as customer_id,
                base_total_minor, terms, reference
    `)) as unknown as Array<{
      preset_id: string;
      customer_id: string | null;
      base_total_minor: string;
      terms: string | null;
      reference: string;
    }>;
    return rows[0];
  });
  if (!claimed) {
    // Diagnose the 0-row claim (rare path) to preserve the precise error.
    const [q] = (await withCtx(ctx, (tx) =>
      tx.execute(sql`
        select status, preset_id::text as preset_id, converted_job_id::text as converted_job_id
        from public.quote where id = ${quoteId} and org_id = ${ctx.orgId}
      `),
    )) as unknown as Array<{
      status: string;
      preset_id: string | null;
      converted_job_id: string | null;
    }>;
    if (!q) throw new QuoteNotFoundError();
    if (q.converted_job_id || q.status === "converted") {
      throw new QuoteStateError("quote already converted");
    }
    if (!q.preset_id) throw new QuoteStateError("quote has no preset to convert from");
    throw new QuoteStateError(`only an approved/sent quote can be accepted (was ${q.status})`);
  }

  let job: { id: string; reference: string };
  try {
    job = await createJobFromPreset(ctx, archetype, {
      presetId: claimed.preset_id,
      name: input.jobName ?? `${claimed.reference}`,
      customerId: claimed.customer_id ?? undefined,
    });
  } catch (err) {
    // createJobFromPreset is atomic — on throw NO job was committed, so it is safe to
    // RELEASE the claim (converting → approved) and let the accept be retried.
    await withCtx(ctx, (tx) =>
      tx.execute(sql`
        update public.quote set status = 'approved', updated_at = now()
        where id = ${quoteId} and org_id = ${ctx.orgId} and status = 'converting'
      `),
    );
    throw err;
  }

  await command(
    ctx,
    {
      audit: {
        action: "quote.accept",
        entityType: "quote",
        entityId: quoteId,
        summary: `Accepted quote ${claimed.reference} → job ${job.reference}`,
      },
      events: [{ name: QUOTE_ACCEPTED, payload: { quoteId, jobId: job.id } }],
    },
    async (tx) => {
      await tx.execute(sql`
        update public.job set selling_price_minor = ${Number(claimed.base_total_minor)},
          payment_terms = ${claimed.terms}, updated_at = now()
        where id = ${job.id} and org_id = ${ctx.orgId}
      `);
      const rows = (await tx.execute(sql`
        update public.quote
        set status = 'converted', converted_job_id = ${job.id}, updated_at = now()
        where id = ${quoteId} and org_id = ${ctx.orgId} and status = 'converting'
          and converted_job_id is null
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new QuoteStateError("quote is no longer acceptable");
      return { jobId: job.id };
    },
  );
  return { jobId: job.id };
}

/** Record a CUSTOMER rejection of a sent quote (reason required, terminal). */
export async function rejectQuote(
  ctx: Ctx,
  archetype: RoleArchetype,
  quoteId: string,
  reason: string,
): Promise<void> {
  assertCan(archetype, "quotes.manage");
  if (!reason.trim()) throw new InvalidQuoteInputError("a rejection reason is required");
  await command(
    ctx,
    {
      audit: {
        action: "quote.reject",
        entityType: "quote",
        entityId: quoteId,
        summary: `Customer rejected: ${reason}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.quote set status = 'rejected', rejected_reason = ${reason}, updated_at = now()
        where id = ${quoteId} and org_id = ${ctx.orgId} and status in ('approved', 'sent')
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new QuoteStateError("only an approved/sent quote can be rejected");
    },
  );
}

/** Customers + presets for the quote/invoice forms (bounded masters — bare select ok). */
export async function listQuoteFormOptions(ctx: Ctx): Promise<{
  customers: Array<{ id: string; name: string }>;
  presets: Array<{ id: string; name: string }>;
}> {
  return withCtx(ctx, async (tx) => {
    const customers = (await tx.execute(sql`
      select id::text as id, name from public.customer where org_id = ${ctx.orgId} and active = true order by name limit 500
    `)) as unknown as Array<{ id: string; name: string }>;
    const presets = (await tx.execute(sql`
      select id::text as id, coalesce(names->>'en', code) as name from public.job_preset
      where org_id = ${ctx.orgId} order by code limit 200
    `)) as unknown as Array<{ id: string; name: string }>;
    return { customers, presets };
  });
}

// ── reads (price-redacted for non-viewPrices) ─────────────────────────────────
export type QuoteRow = {
  id: string;
  reference: string;
  customerName: string | null;
  status: string;
  currency: string;
  totalMinor: number | null;
  createdAt: string;
};

export async function listQuotes(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { limit?: number } = {},
): Promise<QuoteRow[]> {
  assertCan(archetype, "quotes.view");
  const seesPrice = ctx.pricePrivileged;
  const limit = Math.min(opts.limit ?? 200, 500);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, reference, customer_name, status, currency,
             total_minor, created_at::text as created_at
      from public.quote where org_id = ${ctx.orgId}
      order by created_at desc limit ${limit}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      reference: r.reference as string,
      customerName: (r.customer_name as string | null) ?? null,
      status: r.status as string,
      currency: r.currency as string,
      totalMinor: seesPrice ? Number(r.total_minor) : null,
      createdAt: r.created_at as string,
    }));
  });
}

export type QuoteDetail = QuoteRow & {
  exchangeRate: number;
  subtotalMinor: number | null;
  vatAmountMinor: number | null;
  terms: string | null;
  validUntil: string | null;
  convertedJobId: string | null;
  lines: Array<{
    id: string;
    sectionKey: string | null;
    description: string;
    qty: number;
    unit: string;
    unitPriceMinor: number | null;
    vatRate: number;
    lineTotalMinor: number | null;
  }>;
};

export async function getQuote(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<QuoteDetail | null> {
  assertCan(archetype, "quotes.view");
  const seesPrice = ctx.pricePrivileged;
  return withCtx(ctx, async (tx) => {
    const q = (await tx.execute(sql`
      select id::text as id, reference, customer_name, status, currency, exchange_rate,
             subtotal_minor, vat_amount_minor, total_minor, terms, valid_until::text as valid_until,
             converted_job_id::text as converted_job_id, created_at::text as created_at
      from public.quote where id = ${id} and org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    if (!q[0]) return null;
    const lines = (await tx.execute(sql`
      select id::text as id, section_key, description, qty, unit, unit_price_minor, vat_rate, line_total_minor
      from public.quote_line where quote_id = ${id} and org_id = ${ctx.orgId} order by sort
    `)) as unknown as Array<Record<string, unknown>>;
    const r = q[0];
    return {
      id: r.id as string,
      reference: r.reference as string,
      customerName: (r.customer_name as string | null) ?? null,
      status: r.status as string,
      currency: r.currency as string,
      exchangeRate: Number(r.exchange_rate),
      subtotalMinor: seesPrice ? Number(r.subtotal_minor) : null,
      vatAmountMinor: seesPrice ? Number(r.vat_amount_minor) : null,
      totalMinor: seesPrice ? Number(r.total_minor) : null,
      terms: (r.terms as string | null) ?? null,
      validUntil: (r.valid_until as string | null) ?? null,
      convertedJobId: (r.converted_job_id as string | null) ?? null,
      createdAt: r.created_at as string,
      lines: lines.map((l) => ({
        id: l.id as string,
        sectionKey: (l.section_key as string | null) ?? null,
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
