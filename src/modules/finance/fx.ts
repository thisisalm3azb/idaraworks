/**
 * H24G — the rate book, realized/unrealized FX, budgets.
 *
 * Rates are suggestions with effective timestamps; postings snapshot their
 * own explicit rate. Revaluation takes EXPLICIT rates as input and posts a
 * reversible pair — nothing is defaulted (truth map D10).
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { FinanceError, postFromSourceIn, systemAccountIn } from "./ledger";
import { POSTING_RULES_VERSION } from "./posting";
import { arOpenItems } from "./receivables";

export async function setCurrencyRate(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "finance.manage");
  const input = z
    .object({
      fromCurrency: z.string().length(3),
      toCurrency: z.string().length(3),
      rate: z.number().positive(),
      effectiveAt: z.string(),
      source: z.enum(["manual", "import"]).default("manual"),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "finance.rate.set",
        entityType: "currency_rate",
        entityId: r.id,
        summary: `${input.fromCurrency}→${input.toCurrency} rate recorded (${input.source})`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.currency_rate
          (org_id, from_currency, to_currency, rate, effective_at, source, created_by)
        values (${ctx.orgId}, ${input.fromCurrency}, ${input.toCurrency}, ${input.rate},
                ${input.effectiveAt}::timestamptz, ${input.source}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

/** The latest recorded rate at/before a moment — a SUGGESTION for forms. */
export async function latestRate(
  ctx: Ctx,
  fromCurrency: string,
  toCurrency: string,
  at?: string,
): Promise<{ rate: number; effectiveAt: string; source: string } | null> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select rate::text as rate, effective_at::text as at, source
      from public.currency_rate
      where org_id = ${ctx.orgId} and from_currency = ${fromCurrency}
        and to_currency = ${toCurrency}
        and effective_at <= coalesce(${at ?? null}::timestamptz, now())
      order by effective_at desc limit 1
    `)) as unknown as Array<Record<string, string>>;
    return rows[0]
      ? { rate: Number(rows[0].rate), effectiveAt: rows[0].at!, source: rows[0].source! }
      : null;
  });
}

/**
 * Period-end unrealized FX on open FOREIGN-currency receivables, using rates
 * the caller states explicitly. Posts one revaluation entry and creates its
 * dated reversing DRAFT (the standard next-day washout a human posts).
 */
export async function runFxRevaluation(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ entryId: string | null; unrealizedMinor: number }> {
  assertCan(archetype, "finance.post");
  const input = z
    .object({
      asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      rates: z
        .array(z.object({ currency: z.string().length(3), rate: z.number().positive() }))
        .min(1),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { unrealizedMinor: number }) => ({
        action: "finance.fx.revalue",
        entityType: "journal_entry",
        entityId: ctx.orgId,
        summary: `FX revaluation as of ${input.asOf} (${r.unrealizedMinor} minor units)`,
      }),
    },
    async (tx) => {
      const base = (await tx.execute(sql`
        select base_currency from public.org where id = ${ctx.orgId}
      `)) as unknown as Array<{ base_currency: string }>;
      const rateMap = new Map(input.rates.map((r) => [r.currency, r.rate]));

      // Open FX invoices with their snapshot rates.
      const open = await arOpenItems(ctx, archetype, { asOf: input.asOf });
      const fx = (await tx.execute(sql`
        select id::text as id, currency, exchange_rate::text as rate
        from public.invoice
        where org_id = ${ctx.orgId} and currency <> ${base[0]!.base_currency}
      `)) as unknown as Array<Record<string, string>>;
      const invRate = new Map(
        fx.map((f) => [f.id!, { currency: f.currency!, rate: Number(f.rate) }]),
      );

      let unrealized = 0;
      for (const item of open) {
        const meta = invRate.get(item.invoiceId);
        if (!meta) continue;
        const newRate = rateMap.get(meta.currency);
        if (!newRate) {
          throw new FinanceError(
            `no rate stated for ${meta.currency} — revaluation never invents rates`,
          );
        }
        // outstanding is stored in TXN minor units × snapshot rate inside
        // base-outstanding computation; approximate txn outstanding:
        const txnOutstanding = Math.floor(item.outstandingMinor / meta.rate + 0.5);
        unrealized += Math.floor(txnOutstanding * (newRate - meta.rate) + 0.5);
      }
      if (unrealized === 0) return { entryId: null, unrealizedMinor: 0 };

      const ar = await systemAccountIn(tx, ctx, "ar_control");
      const gain = await systemAccountIn(tx, ctx, "fx_gain");
      const loss = await systemAccountIn(tx, ctx, "fx_loss");
      const value = Math.abs(unrealized);
      const posted = await postFromSourceIn(tx, ctx, {
        sourceType: "fx_revaluation",
        sourceId: ctx.orgId,
        eventKey: `ar:${input.asOf}`,
        ruleKey: "fx.revaluation.ar",
        ruleVersion: POSTING_RULES_VERSION,
        journalKind: "revaluation",
        entryDate: input.asOf,
        currency: base[0]!.base_currency,
        exchangeRate: 1,
        memo: `Unrealized FX on receivables as of ${input.asOf}`,
        controlOk: true,
        lines:
          unrealized > 0
            ? [
                { accountId: ar, debitMinor: value, description: "FX revaluation" },
                { accountId: gain, creditMinor: value, description: "Unrealized FX gain" },
              ]
            : [
                { accountId: loss, debitMinor: value, description: "Unrealized FX loss" },
                { accountId: ar, creditMinor: value, description: "FX revaluation" },
              ],
      });

      // The reversing DRAFT dated the next day (a human posts it).
      const next = new Date(`${input.asOf}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const seq = await allocateReference(tx, ctx, "journal_entry");
      const no = formatRef("JRN", seq, 5);
      const mirror = (await tx.execute(sql`
        insert into public.journal_entry
          (org_id, entry_no, entry_date, journal_kind, memo, currency, base_currency, created_by)
        values (${ctx.orgId}, ${no}, ${next.toISOString().slice(0, 10)}, 'revaluation',
                ${"Reverses FX revaluation of " + input.asOf}, ${base[0]!.base_currency},
                ${base[0]!.base_currency}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      await tx.execute(sql`
        insert into public.journal_line
          (org_id, entry_id, line_no, account_id, description,
           debit_minor, credit_minor, base_debit_minor, base_credit_minor)
        select org_id, ${mirror[0]!.id}, line_no, account_id, description,
               credit_minor, debit_minor, base_credit_minor, base_debit_minor
        from public.journal_line
        where entry_id = ${posted.entryId} and org_id = ${ctx.orgId}
      `);
      return { entryId: posted.entryId, unrealizedMinor: unrealized };
    },
  );
}

// ── budgets ──────────────────────────────────────────────────────────────────

export async function saveBudget(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "budget.manage");
  const input = z
    .object({
      fiscalYearId: z.string().uuid(),
      name: z.string().trim().min(1).max(120),
      version: z.number().int().min(1).default(1),
      lines: z
        .array(
          z.object({
            accountId: z.string().uuid(),
            periodNo: z.number().int().min(1).max(13).optional(),
            amountMinor: z.number().int(),
            jobId: z.string().uuid().optional(),
            departmentId: z.string().uuid().optional(),
            costCentreId: z.string().uuid().optional(),
            note: z.string().trim().max(300).optional(),
          }),
        )
        .min(1)
        .max(2000),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "finance.budget.save",
        entityType: "budget",
        entityId: r.id,
        summary: `Budget ${input.name} v${input.version} (${input.lines.length} line(s))`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.budget (org_id, fiscal_year_id, name, version, created_by)
        values (${ctx.orgId}, ${input.fiscalYearId}, ${input.name}, ${input.version}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;
      for (const l of input.lines) {
        await tx.execute(sql`
          insert into public.budget_line
            (org_id, budget_id, account_id, period_no, amount_minor, job_id,
             department_id, cost_centre_id, note)
          values (${ctx.orgId}, ${id}, ${l.accountId}, ${l.periodNo ?? null}, ${l.amountMinor},
                  ${l.jobId ?? null}, ${l.departmentId ?? null}, ${l.costCentreId ?? null},
                  ${l.note ?? null})
        `);
      }
      return { id };
    },
  );
}

export async function setBudgetStatus(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  const input = z
    .object({ budgetId: z.string().uuid(), status: z.enum(["approved", "locked"]) })
    .parse(raw);
  assertCan(archetype, input.status === "locked" ? "finance.approve" : "budget.manage");
  await command(
    ctx,
    {
      audit: {
        action: "finance.budget.status",
        entityType: "budget",
        entityId: input.budgetId,
        summary: `Budget → ${input.status}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        update public.budget
        set status = ${input.status},
            approved_by = coalesce(approved_by, ${ctx.userId}),
            approved_at = coalesce(approved_at, now()),
            updated_at = now()
        where id = ${input.budgetId} and org_id = ${ctx.orgId}
      `),
  );
}

export type BudgetVsActualRow = {
  accountId: string;
  code: string;
  nameEn: string;
  budgetMinor: number;
  actualMinor: number;
  varianceMinor: number;
};

/** Actuals recomputed from the ledger (income/expense signed by normal side). */
export async function budgetVsActual(
  ctx: Ctx,
  archetype: RoleArchetype,
  budgetId: string,
): Promise<BudgetVsActualRow[]> {
  assertCan(archetype, "finance.view");
  return withCtx(ctx, async (tx) => {
    const b = (await tx.execute(sql`
      select fy.starts_on::text as s, fy.ends_on::text as e
      from public.budget b
      join public.fiscal_year fy on fy.id = b.fiscal_year_id and fy.org_id = b.org_id
      where b.id = ${budgetId} and b.org_id = ${ctx.orgId}
    `)) as unknown as Array<{ s: string; e: string }>;
    if (!b[0]) throw new FinanceError("budget not found", "not_found");
    const rows = (await tx.execute(sql`
      select a.id::text as id, a.code, a.name_en, a.normal_balance,
             coalesce(sum(bl.amount_minor), 0)::text as budget,
             coalesce((select sum(case when a.normal_balance = 'debit'
                                       then l.base_debit_minor - l.base_credit_minor
                                       else l.base_credit_minor - l.base_debit_minor end)
                       from public.journal_line l
                       join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
                       where l.org_id = a.org_id and l.account_id = a.id
                         and e.status in ('posted', 'reversed')
                         and e.entry_date between ${b[0].s}::date and ${b[0].e}::date), 0)::text as actual
      from public.budget_line bl
      join public.gl_account a on a.id = bl.account_id and a.org_id = bl.org_id
      where bl.org_id = ${ctx.orgId} and bl.budget_id = ${budgetId}
      group by a.id, a.code, a.name_en, a.normal_balance
      order by a.code
    `)) as unknown as Array<Record<string, string>>;
    return rows.map((r) => ({
      accountId: r.id!,
      code: r.code!,
      nameEn: r.name_en!,
      budgetMinor: Number(r.budget),
      actualMinor: Number(r.actual),
      varianceMinor: Number(r.actual) - Number(r.budget),
    }));
  });
}

/**
 * Cash-flow forecast from REAL commitments: open AR by due date (in), open AP
 * (out), approved POs not yet received (out), next payroll estimate from the
 * latest finalized run (out). Buckets by week for the horizon.
 */
export async function cashFlowForecast(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { weeks?: number } = {},
): Promise<{
  openingMinor: number;
  weeks: Array<{ start: string; inMinor: number; outMinor: number; closingMinor: number }>;
}> {
  assertCan(archetype, "finance.view");
  const weeks = Math.min(Math.max(opts.weeks ?? 8, 1), 26);
  return withCtx(ctx, async (tx) => {
    const opening = (await tx.execute(sql`
      select coalesce(sum(l.base_debit_minor - l.base_credit_minor), 0)::text as bal
      from public.journal_line l
      join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
      join public.gl_account a on a.id = l.account_id and a.org_id = l.org_id
      where l.org_id = ${ctx.orgId} and a.control_kind in ('bank', 'cash')
        and e.status in ('posted', 'reversed')
    `)) as unknown as Array<{ bal: string }>;

    const inflows = (await tx.execute(sql`
      select coalesce(i.due_date, i.issued_at::date + 30)::text as due,
             (i.total_minor
              - coalesce((select sum(p.amount_minor) from public.payment p
                          where p.org_id = i.org_id and p.invoice_id = i.id
                            and p.status in ('recorded','confirmed')), 0)
              - coalesce((select sum(sa.amount_minor) from public.settlement_allocation sa
                          where sa.org_id = i.org_id and sa.target_type = 'invoice'
                            and sa.target_id = i.id and sa.voided_at is null), 0))::text as amt
      from public.invoice i
      where i.org_id = ${ctx.orgId} and i.kind = 'invoice'
        and i.status in ('issued', 'partially_paid')
    `)) as unknown as Array<{ due: string; amt: string }>;

    const outflows = (await tx.execute(sql`
      select (g.received_date + 30)::text as due,
             coalesce(sum(grl.accepted_qty * pol.unit_cost_minor), 0)::text as amt
      from public.goods_receipt g
      join public.goods_receipt_line grl on grl.grn_id = g.id and grl.org_id = g.org_id
      join public.purchase_order_line pol on pol.id = grl.po_line_id and pol.org_id = g.org_id
      where g.org_id = ${ctx.orgId} and g.status = 'recorded'
      group by g.id, g.received_date
    `)) as unknown as Array<{ due: string; amt: string }>;

    const payroll = (await tx.execute(sql`
      select net_total_minor::text as amt from public.pay_run
      where org_id = ${ctx.orgId} and status = 'finalized'
      order by created_at desc limit 1
    `)) as unknown as Array<{ amt: string }>;

    const today = new Date();
    const start = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    const buckets = Array.from({ length: weeks }, (_, i) => {
      const s = new Date(start);
      s.setUTCDate(s.getUTCDate() + i * 7);
      return { start: s.toISOString().slice(0, 10), inMinor: 0, outMinor: 0, closingMinor: 0 };
    });
    const bucketFor = (iso: string) => {
      const t = Date.parse(iso);
      const idx = Math.floor((t - start.getTime()) / (7 * 86_400_000));
      return idx < 0 ? 0 : idx >= weeks ? -1 : idx;
    };
    for (const f of inflows) {
      const amt = Number(f.amt);
      if (amt <= 0) continue;
      const b = bucketFor(f.due);
      if (b >= 0) buckets[b]!.inMinor += amt;
    }
    for (const f of outflows) {
      const b = bucketFor(f.due);
      if (b >= 0) buckets[b]!.outMinor += Number(f.amt);
    }
    // Payroll estimate lands at each month end inside the horizon.
    if (payroll[0]) {
      for (const b of buckets) {
        const d = new Date(`${b.start}T00:00:00Z`);
        const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
        if (monthEnd >= d && monthEnd < new Date(d.getTime() + 7 * 86_400_000)) {
          b.outMinor += Number(payroll[0].amt);
        }
      }
    }
    let running = Number(opening[0]!.bal);
    for (const b of buckets) {
      running += b.inMinor - b.outMinor;
      b.closingMinor = running;
    }
    return { openingMinor: Number(opening[0]!.bal), weeks: buckets };
  });
}
