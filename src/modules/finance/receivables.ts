/**
 * H24D — receivables and payables as OPEN ITEMS over canonical documents.
 *
 * Nothing here is a second financial truth: outstanding amounts recompute
 * from invoices, payments and allocations every time (D1). Allocations
 * explain which money settled which document; they never move money.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { FinanceError } from "./ledger";

// ── allocation ───────────────────────────────────────────────────────────────

/**
 * Allocate one customer payment across invoices (bill-by-bill). The legacy
 * fast path (payment.invoice_id) keeps working; allocations extend it for
 * multi-invoice, advances and unapplied cash.
 */
export async function allocatePayment(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ allocated: number }> {
  assertCan(archetype, "finance.reconcile");
  const input = z
    .object({
      paymentId: z.string().uuid(),
      allocations: z
        .array(z.object({ invoiceId: z.string().uuid(), amountMinor: z.number().int().positive() }))
        .min(1)
        .max(100),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "finance.ar.allocate",
        entityType: "payment",
        entityId: input.paymentId,
        summary: `Allocated payment across ${input.allocations.length} invoice(s)`,
      },
    },
    async (tx) => {
      const pay = (await tx.execute(sql`
        select customer_id::text as customer_id, amount_minor::text as amount,
               invoice_id::text as direct_invoice, status
        from public.payment
        where id = ${input.paymentId} and org_id = ${ctx.orgId}
        for update
      `)) as unknown as Array<Record<string, string | null>>;
      const p = pay[0];
      if (!p) throw new FinanceError("payment not found", "not_found");
      if (p.status === "void" || p.status === "rejected") {
        throw new FinanceError(`a ${p.status} payment cannot be allocated`);
      }
      const already = (await tx.execute(sql`
        select coalesce(sum(amount_minor), 0)::text as s from public.settlement_allocation
        where org_id = ${ctx.orgId} and payer_type = 'payment' and payer_id = ${input.paymentId}
          and voided_at is null
      `)) as unknown as Array<{ s: string }>;
      const directClaim = p.direct_invoice ? Number(p.amount) : 0;
      void directClaim; // the direct link is superseded once explicit allocations exist
      const remaining = Number(p.amount) - Number(already[0]!.s);
      const total = input.allocations.reduce((a, x) => a + x.amountMinor, 0);
      if (total > remaining) {
        throw new FinanceError(
          `allocation ${total} exceeds the payment's unallocated ${remaining}`,
          "unbalanced",
        );
      }
      for (const a of input.allocations) {
        const inv = (await tx.execute(sql`
          select customer_id::text as customer_id, total_minor::text as total, status
          from public.invoice
          where id = ${a.invoiceId} and org_id = ${ctx.orgId} and kind = 'invoice'
        `)) as unknown as Array<Record<string, string | null>>;
        if (!inv[0]) throw new FinanceError("invoice not found", "not_found");
        if (inv[0].status === "draft" || inv[0].status === "cancelled") {
          throw new FinanceError("only an issued invoice can be settled");
        }
        if (p.customer_id && inv[0].customer_id && p.customer_id !== inv[0].customer_id) {
          throw new FinanceError("payment and invoice belong to different customers");
        }
        await tx.execute(sql`
          insert into public.settlement_allocation
            (org_id, payer_type, payer_id, target_type, target_id,
             amount_minor, base_amount_minor, created_by)
          values (${ctx.orgId}, 'payment', ${input.paymentId}, 'invoice', ${a.invoiceId},
                  ${a.amountMinor}, ${a.amountMinor}, ${ctx.userId})
        `);
      }
      return { allocated: total };
    },
  );
}

// ── open items and ageing ────────────────────────────────────────────────────

export type OpenInvoice = {
  invoiceId: string;
  reference: string;
  customerId: string | null;
  customerName: string | null;
  issuedOn: string | null;
  dueDate: string | null;
  totalMinor: number;
  settledMinor: number;
  outstandingMinor: number;
  daysOverdue: number;
};

/**
 * The AR open-item list, recomputed: total minus direct payments (legacy
 * payment.invoice_id), minus explicit allocations, minus credit notes that
 * correct the invoice. Server-side aggregation — correct at any volume.
 */
export async function arOpenItems(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { customerId?: string; asOf?: string } = {},
): Promise<OpenInvoice[]> {
  assertCan(archetype, "finance.view");
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select i.id::text as id, i.reference, i.customer_id::text as customer_id,
             i.customer_name, i.issued_at::date::text as issued_on, i.due_date::text as due_date,
             i.total_minor::text as total,
             coalesce((select sum(p.amount_minor) from public.payment p
                       where p.org_id = i.org_id and p.invoice_id = i.id
                         and p.status in ('recorded', 'confirmed')
                         and not exists (select 1 from public.settlement_allocation sa
                                         where sa.org_id = p.org_id and sa.payer_type = 'payment'
                                           and sa.payer_id = p.id and sa.voided_at is null)), 0)::text as direct_paid,
             coalesce((select sum(sa.amount_minor) from public.settlement_allocation sa
                       where sa.org_id = i.org_id and sa.target_type = 'invoice'
                         and sa.target_id = i.id and sa.voided_at is null), 0)::text as allocated,
             coalesce((select sum(cn.total_minor) from public.invoice cn
                       where cn.org_id = i.org_id and cn.corrects_invoice_id = i.id
                         and cn.kind = 'credit_note' and cn.status <> 'cancelled'), 0)::text as credited
      from public.invoice i
      where i.org_id = ${ctx.orgId} and i.kind = 'invoice'
        and i.status in ('issued', 'partially_paid', 'paid')
        ${opts.customerId ? sql`and i.customer_id = ${opts.customerId}` : sql``}
      order by i.issued_at
    `),
  )) as unknown as Array<Record<string, string | null>>;
  const out: OpenInvoice[] = [];
  for (const r of rows) {
    const total = Number(r.total);
    const settled = Number(r.direct_paid) + Number(r.allocated) + Number(r.credited);
    const outstanding = total - settled;
    if (outstanding <= 0) continue;
    const due = r.due_date ?? r.issued_on;
    const daysOverdue =
      due && due < asOf ? Math.floor((Date.parse(asOf) - Date.parse(due)) / 86_400_000) : 0;
    out.push({
      invoiceId: r.id!,
      reference: r.reference!,
      customerId: r.customer_id ?? null,
      customerName: r.customer_name ?? null,
      issuedOn: r.issued_on ?? null,
      dueDate: r.due_date ?? null,
      totalMinor: total,
      settledMinor: settled,
      outstandingMinor: outstanding,
      daysOverdue,
    });
  }
  return out;
}

export type AgeingBucket = { label: string; totalMinor: number; count: number };

export async function arAgeing(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { asOf?: string } = {},
): Promise<{ buckets: AgeingBucket[]; totalMinor: number }> {
  const items = await arOpenItems(ctx, archetype, opts);
  const buckets: AgeingBucket[] = [
    { label: "current", totalMinor: 0, count: 0 },
    { label: "1-30", totalMinor: 0, count: 0 },
    { label: "31-60", totalMinor: 0, count: 0 },
    { label: "61-90", totalMinor: 0, count: 0 },
    { label: "90+", totalMinor: 0, count: 0 },
  ];
  let total = 0;
  for (const i of items) {
    const b =
      i.daysOverdue <= 0
        ? 0
        : i.daysOverdue <= 30
          ? 1
          : i.daysOverdue <= 60
            ? 2
            : i.daysOverdue <= 90
              ? 3
              : 4;
    buckets[b]!.totalMinor += i.outstandingMinor;
    buckets[b]!.count++;
    total += i.outstandingMinor;
  }
  return { buckets, totalMinor: total };
}

/** Unapplied customer money: payments not linked and not (fully) allocated. */
export async function arUnappliedPayments(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<
  Array<{
    paymentId: string;
    reference: string;
    customerName: string | null;
    unappliedMinor: number;
  }>
> {
  assertCan(archetype, "finance.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select p.id::text as id, p.reference, p.customer_name,
             p.amount_minor::text as amount, p.invoice_id::text as direct_invoice,
             coalesce((select sum(sa.amount_minor) from public.settlement_allocation sa
                       where sa.org_id = p.org_id and sa.payer_type = 'payment'
                         and sa.payer_id = p.id and sa.voided_at is null), 0)::text as allocated
      from public.payment p
      where p.org_id = ${ctx.orgId} and p.status in ('recorded', 'confirmed')
      order by p.payment_date
    `),
  )) as unknown as Array<Record<string, string | null>>;
  const out = [];
  for (const r of rows) {
    if (r.direct_invoice && Number(r.allocated) === 0) continue; // fully applied via the fast path
    const unapplied =
      Number(r.amount) - Number(r.allocated) - (r.direct_invoice ? Number(r.amount) : 0);
    if (unapplied <= 0) continue;
    out.push({
      paymentId: r.id!,
      reference: r.reference!,
      customerName: r.customer_name ?? null,
      unappliedMinor: unapplied,
    });
  }
  return out;
}

// ── customer statement ───────────────────────────────────────────────────────

export type StatementRow = {
  date: string;
  kind: "invoice" | "credit_note" | "payment";
  reference: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
};

export async function customerStatement(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { customerId: string; from?: string; to?: string },
): Promise<{ rows: StatementRow[]; closingMinor: number }> {
  assertCan(archetype, "finance.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select d, kind, reference, debit::text as debit, credit::text as credit from (
        select coalesce(issued_at::date, created_at::date)::text as d,
               kind, reference,
               case when kind = 'invoice' then total_minor else 0 end as debit,
               case when kind = 'credit_note' then total_minor else 0 end as credit
        from public.invoice
        where org_id = ${ctx.orgId} and customer_id = ${opts.customerId}
          and status not in ('draft', 'cancelled')
        union all
        select payment_date::text as d, 'payment' as kind, reference, 0 as debit,
               amount_minor as credit
        from public.payment
        where org_id = ${ctx.orgId} and customer_id = ${opts.customerId}
          and status in ('recorded', 'confirmed')
      ) t
      where true
        ${opts.from ? sql`and d >= ${opts.from}` : sql``}
        ${opts.to ? sql`and d <= ${opts.to}` : sql``}
      order by d, kind
    `),
  )) as unknown as Array<Record<string, string>>;
  let balance = 0;
  const out: StatementRow[] = rows.map((r) => {
    balance += Number(r.debit) - Number(r.credit);
    return {
      date: r.d!,
      kind: r.kind as StatementRow["kind"],
      reference: r.reference!,
      debitMinor: Number(r.debit),
      creditMinor: Number(r.credit),
      balanceMinor: balance,
    };
  });
  return { rows: out, closingMinor: balance };
}

// ── credit control ───────────────────────────────────────────────────────────

/** Exposure vs the configured limit — a WARNING input, never a silent block. */
export async function customerCreditCheck(
  ctx: Ctx,
  archetype: RoleArchetype,
  customerId: string,
): Promise<{ limitMinor: number | null; exposureMinor: number; overLimit: boolean }> {
  assertCan(archetype, "finance.view");
  const limit = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select credit_limit_minor::text as l from public.customer
      where id = ${customerId} and org_id = ${ctx.orgId}
    `),
  )) as unknown as Array<{ l: string | null }>;
  const items = await arOpenItems(ctx, archetype, { customerId });
  const exposure = items.reduce((a, i) => a + i.outstandingMinor, 0);
  const lim = limit[0]?.l != null ? Number(limit[0].l) : null;
  return { limitMinor: lim, exposureMinor: exposure, overLimit: lim != null && exposure > lim };
}

// ── payables (open items over received orders) ──────────────────────────────

export type OpenPayable = {
  goodsReceiptId: string;
  reference: string;
  supplierId: string | null;
  receivedOn: string;
  valueMinor: number;
  settledMinor: number;
  outstandingMinor: number;
};

/**
 * AP open items: each recorded goods receipt valued at received qty × PO unit
 * cost plus its proportional share of the order's VAT — minus explicit
 * allocations from supplier payments (H24E money transactions).
 */
export async function apOpenItems(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { supplierId?: string } = {},
): Promise<OpenPayable[]> {
  assertCan(archetype, "finance.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select g.id::text as id, g.reference, po.supplier_id::text as supplier_id,
             g.received_date::text as received_on,
             coalesce(sum(grl.accepted_qty * pol.unit_cost_minor), 0)::text as ex_vat,
             po.total_minor::text as po_total, po.vat_minor::text as po_vat,
             (select coalesce(sum(l2.qty * l2.unit_cost_minor), 0)
              from public.purchase_order_line l2
              where l2.po_id = po.id and l2.org_id = po.org_id)::text as po_subtotal,
             coalesce((select sum(sa.amount_minor) from public.settlement_allocation sa
                       where sa.org_id = g.org_id and sa.target_type = 'goods_receipt'
                         and sa.target_id = g.id and sa.voided_at is null), 0)::text as allocated
      from public.goods_receipt g
      join public.purchase_order po on po.id = g.po_id and po.org_id = g.org_id
      join public.goods_receipt_line grl on grl.grn_id = g.id and grl.org_id = g.org_id
      join public.purchase_order_line pol on pol.id = grl.po_line_id and pol.org_id = g.org_id
      where g.org_id = ${ctx.orgId} and g.status = 'recorded'
        ${opts.supplierId ? sql`and po.supplier_id = ${opts.supplierId}` : sql``}
      group by g.id, g.reference, po.supplier_id, g.received_date, po.total_minor,
               po.vat_minor, po.id
      order by g.received_date
    `),
  )) as unknown as Array<Record<string, string | null>>;
  const out: OpenPayable[] = [];
  for (const r of rows) {
    const exVat = Number(r.ex_vat);
    const poSubtotal = Number(r.po_subtotal);
    const vatShare = poSubtotal > 0 ? Math.floor((Number(r.po_vat) * exVat) / poSubtotal + 0.5) : 0;
    const value = exVat + vatShare;
    const settled = Number(r.allocated);
    const outstanding = value - settled;
    if (outstanding <= 0) continue;
    out.push({
      goodsReceiptId: r.id!,
      reference: r.reference!,
      supplierId: r.supplier_id ?? null,
      receivedOn: r.received_on!,
      valueMinor: value,
      settledMinor: settled,
      outstandingMinor: outstanding,
    });
  }
  return out;
}
