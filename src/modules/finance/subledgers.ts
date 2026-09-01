/**
 * H24F — subledger posting rules: stock, payroll, depreciation, and the
 * reconciliations that keep every subledger honest against its control
 * account. Reports drift; never repairs it (truth map D1).
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { FinanceError, postFromSourceIn, systemAccountIn } from "./ledger";
import { POSTING_RULES_VERSION } from "./posting";
import { financeConfigIn } from "./chart";

// ── stock movements → the books ─────────────────────────────────────────────

type StockGl = { debitKey: string; creditKey: string } | null;

/**
 * The GL meaning of each movement type. Transfers and assembly moves are
 * net-zero inside the inventory account — no entry. Reversal movements
 * (reverses_movement_id set) mirror their original's mapping by sign.
 */
function stockGlMap(movementType: string, qtyPositive: boolean): StockGl {
  switch (movementType) {
    case "goods_receipt":
      return { debitKey: "inventory", creditKey: "grni" };
    case "supplier_return":
      return { debitKey: "grni", creditKey: "inventory" };
    case "opening_balance":
      return qtyPositive
        ? { debitKey: "inventory", creditKey: "opening_balance_equity" }
        : { debitKey: "opening_balance_equity", creditKey: "inventory" };
    case "material_issue":
    case "job_consumption":
      return { debitKey: "direct_costs", creditKey: "inventory" };
    case "job_return":
      return { debitKey: "inventory", creditKey: "direct_costs" };
    case "adjustment_increase":
      return { debitKey: "inventory", creditKey: "stock_adjustment" };
    case "adjustment_decrease":
      return { debitKey: "stock_adjustment", creditKey: "inventory" };
    case "count_correction":
      return qtyPositive
        ? { debitKey: "inventory", creditKey: "stock_adjustment" }
        : { debitKey: "stock_adjustment", creditKey: "inventory" };
    default:
      return null; // transfers, assembly internals — inventory-neutral
  }
}

/**
 * Post one stock movement's value. Called from the ONE place movements are
 * written (inventory ledger). No-ops for inventory-neutral moves, zero-value
 * moves, orgs without finance, and movements dated before the books start.
 */
export async function postStockMovementIn(
  tx: TenantTx,
  ctx: Ctx,
  movementId: string,
): Promise<{ posted: boolean; skipped?: string }> {
  const config = await financeConfigIn(tx, ctx);
  if (!config) return { posted: false, skipped: "finance not set up" };
  const rows = (await tx.execute(sql`
    select movement_type, qty_delta::text as qty, cost_total_minor::text as cost,
           effective_at::date::text as d, reverses_movement_id::text as reverses,
           currency, exchange_rate::text as rate
    from public.stock_movement
    where id = ${movementId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<Record<string, string | null>>;
  const m = rows[0];
  if (!m) throw new FinanceError("stock movement not found", "not_found");
  const cost = Number(m.cost ?? 0);
  if (!cost) return { posted: false, skipped: "no cost value" };
  if (m.d! < config.booksStartDate) return { posted: false, skipped: "before books start" };
  const qtyPositive = Number(m.qty) >= 0;
  let map = stockGlMap(m.movement_type!, qtyPositive);
  if (!map) return { posted: false, skipped: "inventory-neutral movement" };
  // A reversal movement mirrors the original entry.
  if (m.reverses) map = { debitKey: map.creditKey, creditKey: map.debitKey };

  const debit = await systemAccountIn(tx, ctx, map.debitKey);
  const credit = await systemAccountIn(tx, ctx, map.creditKey);
  const value = Math.abs(cost);
  const r = await postFromSourceIn(tx, ctx, {
    sourceType: "stock_movement",
    sourceId: movementId,
    eventKey: "valued",
    ruleKey: `stock.${m.movement_type}`,
    ruleVersion: POSTING_RULES_VERSION,
    journalKind: "inventory",
    entryDate: m.d!,
    currency: (
      (await tx.execute(
        sql`select base_currency from public.org where id = ${ctx.orgId}`,
      )) as unknown as Array<{ base_currency: string }>
    )[0]!.base_currency,
    exchangeRate: 1,
    memo: `Stock ${m.movement_type} (${m.qty})`,
    controlOk: true,
    lines: [
      { accountId: debit, debitMinor: value, description: m.movement_type! },
      { accountId: credit, creditMinor: value, description: m.movement_type! },
    ],
  });
  return { posted: !r.alreadyPosted };
}

// ── payroll → the books ──────────────────────────────────────────────────────

/**
 * Pay-run finalized (rule payroll.finalized v core-1):
 *   DR salary expense           gross
 *   DR employer contrib expense employer
 *   CR employee net payable     net
 *   CR payroll deductions       gross − net
 *   CR employer contrib payable employer
 * Reimbursements ride inside gross by H23's engine; this rule states that
 * simplification openly rather than splitting what the snapshot did not.
 */
export async function postPayRunFinalizedIn(
  tx: TenantTx,
  ctx: Ctx,
  runId: string,
): Promise<{ posted: boolean; skipped?: string }> {
  const config = await financeConfigIn(tx, ctx);
  if (!config) return { posted: false, skipped: "finance not set up" };
  const rows = (await tx.execute(sql`
    select r.reference, r.currency, r.gross_total_minor::text as gross,
           r.deduction_total_minor::text as ded, r.employer_total_minor::text as employer,
           r.net_total_minor::text as net, p.period_end::text as d
    from public.pay_run r
    join public.pay_period p on p.id = r.period_id and p.org_id = r.org_id
    where r.id = ${runId} and r.org_id = ${ctx.orgId}
  `)) as unknown as Array<Record<string, string | null>>;
  const run = rows[0];
  if (!run) throw new FinanceError("pay run not found", "not_found");
  if (run.d! < config.booksStartDate) return { posted: false, skipped: "before books start" };
  const gross = Number(run.gross);
  const employer = Number(run.employer);
  const net = Number(run.net);
  const deductions = gross - net;
  if (gross === 0 && employer === 0) return { posted: false, skipped: "zero-value run" };

  const lines = [
    {
      accountId: await systemAccountIn(tx, ctx, "salary_expense"),
      debitMinor: gross,
      description: `Payroll ${run.reference} gross`,
    },
    ...(employer > 0
      ? [
          {
            accountId: await systemAccountIn(tx, ctx, "employer_contrib_expense"),
            debitMinor: employer,
            description: "Employer contributions",
          },
        ]
      : []),
    {
      accountId: await systemAccountIn(tx, ctx, "payroll_net_payable"),
      creditMinor: net,
      description: `Payroll ${run.reference} net pay`,
    },
    ...(deductions > 0
      ? [
          {
            accountId: await systemAccountIn(tx, ctx, "payroll_deductions_payable"),
            creditMinor: deductions,
            description: "Deductions withheld",
          },
        ]
      : []),
    ...(employer > 0
      ? [
          {
            accountId: await systemAccountIn(tx, ctx, "employer_contrib_payable"),
            creditMinor: employer,
            description: "Employer contributions payable",
          },
        ]
      : []),
  ];
  const r = await postFromSourceIn(tx, ctx, {
    sourceType: "pay_run",
    sourceId: runId,
    eventKey: "finalized",
    ruleKey: "payroll.finalized",
    ruleVersion: POSTING_RULES_VERSION,
    journalKind: "payroll",
    entryDate: run.d!,
    currency: run.currency!,
    exchangeRate: 1,
    memo: `Payroll ${run.reference}`,
    controlOk: true,
    lines,
  });
  return { posted: !r.alreadyPosted };
}

// ── depreciation ─────────────────────────────────────────────────────────────

/**
 * Straight-line monthly depreciation for one period across the register.
 * amount = (base cost − residual) / useful_life_months, capped so accumulated
 * never exceeds the depreciable base; assets start at depreciation_start_on
 * (or acquired_on). One run per span; posts ONE entry.
 */
export async function runDepreciation(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ runId: string; totalMinor: number; assets: number; entryId: string | null }> {
  assertCan(archetype, "finance.post");
  const input = z
    .object({
      periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { runId: string; totalMinor: number; assets: number }) => ({
        action: "finance.depreciation.run",
        entityType: "asset_depreciation_run",
        entityId: r.runId,
        summary: `Depreciation ${input.periodStart}..${input.periodEnd}: ${r.assets} asset(s)`,
      }),
    },
    async (tx) => {
      const assets = (await tx.execute(sql`
        select a.id::text as id, a.asset_no,
               coalesce(a.base_acquisition_cost_minor, a.acquisition_cost_minor, 0)::text as cost,
               coalesce(a.residual_value_minor, 0)::text as residual,
               a.useful_life_months,
               coalesce(a.depreciation_start_on, a.acquired_on)::text as starts,
               coalesce((select sum(l.amount_minor) from public.asset_depreciation_line l
                         join public.asset_depreciation_run r
                           on r.id = l.run_id and r.org_id = l.org_id and r.status = 'posted'
                         where l.org_id = a.org_id and l.asset_id = a.id), 0)::text as accumulated
        from public.asset a
        where a.org_id = ${ctx.orgId}
          and a.status in ('in_service', 'in_storage', 'under_maintenance')
          and a.useful_life_months is not null and a.useful_life_months > 0
          and coalesce(a.depreciation_start_on, a.acquired_on) is not null
          and coalesce(a.depreciation_start_on, a.acquired_on) <= ${input.periodEnd}::date
      `)) as unknown as Array<Record<string, string | null>>;

      const seq = await allocateReference(tx, ctx, "asset_depreciation_run");
      const reference = formatRef("DEP", seq, 4);
      const run = (await tx.execute(sql`
        insert into public.asset_depreciation_run
          (org_id, reference, period_start, period_end, total_minor, created_by)
        values (${ctx.orgId}, ${reference}, ${input.periodStart}, ${input.periodEnd}, 0, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const runId = run[0]!.id;

      let total = 0;
      let count = 0;
      for (const a of assets) {
        const cost = Number(a.cost);
        const residual = Number(a.residual);
        const life = Number(a.useful_life_months);
        const accumulated = Number(a.accumulated);
        const base = cost - residual;
        if (base <= 0 || accumulated >= base) continue;
        const monthly = Math.floor(base / life);
        const amount = Math.min(monthly, base - accumulated);
        if (amount <= 0) continue;
        await tx.execute(sql`
          insert into public.asset_depreciation_line
            (org_id, run_id, asset_id, amount_minor, accumulated_after_minor)
          values (${ctx.orgId}, ${runId}, ${a.id}, ${amount}, ${accumulated + amount})
        `);
        total += amount;
        count++;
      }
      await tx.execute(sql`
        update public.asset_depreciation_run set total_minor = ${total}
        where id = ${runId} and org_id = ${ctx.orgId}
      `);

      let entryId: string | null = null;
      if (total > 0) {
        const posted = await postFromSourceIn(tx, ctx, {
          sourceType: "asset_depreciation_run",
          sourceId: runId,
          eventKey: "posted",
          ruleKey: "assets.depreciation",
          ruleVersion: POSTING_RULES_VERSION,
          journalKind: "depreciation",
          entryDate: input.periodEnd,
          currency: (
            (await tx.execute(
              sql`select base_currency from public.org where id = ${ctx.orgId}`,
            )) as unknown as Array<{ base_currency: string }>
          )[0]!.base_currency,
          exchangeRate: 1,
          memo: `Depreciation ${reference} (${input.periodStart}..${input.periodEnd})`,
          lines: [
            {
              accountId: await systemAccountIn(tx, ctx, "depreciation_expense"),
              debitMinor: total,
              description: reference,
            },
            {
              accountId: await systemAccountIn(tx, ctx, "accumulated_depreciation"),
              creditMinor: total,
              description: reference,
            },
          ],
        });
        entryId = posted.entryId;
        await tx.execute(sql`
          update public.asset_depreciation_run set journal_entry_id = ${entryId}
          where id = ${runId} and org_id = ${ctx.orgId}
        `);
      }
      return { runId, totalMinor: total, assets: count, entryId };
    },
  );
}

// ── subledger reconciliations (report, never repair) ────────────────────────

export type SubledgerReconciliation = {
  name: string;
  subledgerMinor: number;
  controlMinor: number;
  driftMinor: number;
};

async function controlBalanceIn(tx: TenantTx, ctx: Ctx, systemKey: string): Promise<number> {
  const rows = (await tx.execute(sql`
    select coalesce(sum(l.base_debit_minor - l.base_credit_minor), 0)::text as bal
    from public.journal_line l
    join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
    join public.gl_account a on a.id = l.account_id and a.org_id = l.org_id
    where l.org_id = ${ctx.orgId} and a.system_key = ${systemKey}
      and e.status in ('posted', 'reversed')
  `)) as unknown as Array<{ bal: string }>;
  return Number(rows[0]?.bal ?? 0);
}

/**
 * Inventory / payroll / depreciation subledgers vs their control accounts.
 * PO-002-class drift (a receipt without its movement) appears HERE as
 * inventory drift — named, quantified, never silently fixed.
 */
export async function subledgerReconciliations(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<SubledgerReconciliation[]> {
  assertCan(archetype, "finance.view");
  return withCtx(ctx, async (tx) => {
    const config = await financeConfigIn(tx, ctx);
    const since = config?.booksStartDate ?? "0001-01-01";
    const out: SubledgerReconciliation[] = [];

    const stock = (await tx.execute(sql`
      select coalesce(sum(cost_total_minor * sign(qty_delta)), 0)::text as v
      from public.stock_movement
      where org_id = ${ctx.orgId} and effective_at::date >= ${since}::date
        and movement_type not in ('transfer_out', 'transfer_in')
    `)) as unknown as Array<{ v: string }>;
    const inventoryControl = await controlBalanceIn(tx, ctx, "inventory");
    out.push({
      name: "inventory",
      subledgerMinor: Number(stock[0]!.v),
      controlMinor: inventoryControl,
      driftMinor: Number(stock[0]!.v) - inventoryControl,
    });

    const dep = (await tx.execute(sql`
      select coalesce(sum(total_minor), 0)::text as v from public.asset_depreciation_run
      where org_id = ${ctx.orgId} and status = 'posted'
    `)) as unknown as Array<{ v: string }>;
    const accDep = await controlBalanceIn(tx, ctx, "accumulated_depreciation");
    out.push({
      name: "accumulated_depreciation",
      subledgerMinor: Number(dep[0]!.v),
      controlMinor: -accDep, // credit-normal
      driftMinor: Number(dep[0]!.v) + accDep,
    });

    return out;
  });
}
