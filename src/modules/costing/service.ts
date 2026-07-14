/**
 * The costing engine (doc 01 costing spine; doc 11 S5 "Measure"). Work becomes cost,
 * truthfully: it sums a job's cost from source (manual report materials + frozen
 * labour✱ + PO receipts + non-void job expenses), applies the org's VAT basis
 * (ex-VAT for VAT-registered orgs, inc-VAT otherwise — F-53/PB-3), and is the SOLE
 * writer of the cached rollups (BUILD_BIBLE §4.8) — via the DEFINER
 * app.refresh_cost_rollup, so at the database there is exactly one writer and the
 * labour-cost wall is preserved (cost_rollup_labour✱ is RLS-cost-privileged).
 *
 * Reads are REDACTED per role (F-23 / D-6.2): a caller sees ex-labour cost only,
 * unless costPrivileged (labour + full total) / pricePrivileged (quoted + margin).
 * quotedMinor follows the C-10 precedence: accepted quote (S6) → selling price +
 * audited adjustments → null; a divergence RAISES an exception, never silently picks.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz/can";
import type { CurrencyCode, RoleArchetype } from "@/platform/registries";
import { logger } from "@/platform/logger";
import { raiseQuoteDivergence, clearQuoteDivergence } from "@/modules/exceptions/service";

export type VatBasis = "ex_vat" | "inc_vat";

export class CostingNotFoundError extends Error {
  constructor() {
    super("job not found");
    this.name = "CostingNotFoundError";
  }
}

/** The org's costing VAT basis: VAT-registered → ex-VAT (input VAT recoverable),
 * else inc-VAT (F-53). Stored as app_settings 'finance.vat_registered' (default
 * true = registered/ex-VAT; the pilot-accountant sign-off PB-3 ratifies it). */
export async function resolveVatBasis(ctx: Ctx): Promise<VatBasis> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select value from public.app_settings
      where org_id = ${ctx.orgId} and key = 'finance.vat_registered'
    `)) as unknown as Array<{ value: unknown }>;
    const registered = rows[0] === undefined ? true : rows[0].value !== false;
    return registered ? "ex_vat" : "inc_vat";
  });
}

/**
 * Refresh a job's cached rollup — the SINGLE-WRITER path (the DEFINER recomputes
 * from source and upserts both rollup tables). Returns whether the cached total
 * DRIFTED from a prior value (a missed invalidation) so the reconcile can alarm.
 */
export async function refreshRollup(ctx: Ctx, jobId: string): Promise<{ drifted: boolean }> {
  const basis = await resolveVatBasis(ctx);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select app.refresh_cost_rollup(${ctx.orgId}, ${jobId}, ${basis}) as drifted
    `)) as unknown as Array<{ drifted: boolean }>;
    return { drifted: rows[0]?.drifted ?? false };
  });
}

/**
 * quotedMinor precedence (C-10): accepted-quote total (S6; null in S5) → selling
 * price + audited adjustments → null. A DIVERGENCE between an accepted quote and a
 * manually-set selling price is flagged (never silently resolved) — the costing
 * service raises the C-10 exception on divergence. Pure + unit-tested.
 */
export function resolveQuotedMinor(params: {
  acceptedQuoteTotalMinor: number | null;
  sellingPriceMinor: number | null;
  adjustmentsMinor: number;
}): { quotedMinor: number | null; divergence: boolean } {
  const { acceptedQuoteTotalMinor, sellingPriceMinor, adjustmentsMinor } = params;
  const sellingComposite = sellingPriceMinor === null ? null : sellingPriceMinor + adjustmentsMinor;
  if (acceptedQuoteTotalMinor !== null) {
    const divergence = sellingComposite !== null && acceptedQuoteTotalMinor !== sellingComposite;
    // Precedence: the accepted quote wins as the quoted figure; divergence is raised
    // as an exception, not silently discarded (owner ruling).
    return { quotedMinor: acceptedQuoteTotalMinor, divergence };
  }
  return { quotedMinor: sellingComposite, divergence: false };
}

export type CostingView = {
  jobId: string;
  costBasis: VatBasis;
  currency: CurrencyCode;
  materialCostMinor: number;
  poCostMinor: number;
  expenseCostMinor: number;
  totalExLabourMinor: number;
  computedAt: string | null;
  // Cost-privileged only:
  labourCostMinor: number | null;
  totalCostMinor: number | null;
  // Price-privileged only:
  quotedMinor: number | null;
  // Both cost + price privileged:
  marginMinor: number | null;
};

/**
 * A job's costing, REDACTED per the caller's role. Ensures the rollup exists (a
 * first read computes it), then reads the ex-labour rollup always, the labour✱
 * rollup only under the RLS cost wall, and job pricing only if price-privileged.
 */
export async function getJobCosting(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  currency: CurrencyCode,
): Promise<CostingView> {
  assertCan(archetype, "costing.view");
  const basis = await resolveVatBasis(ctx);

  const view = await withCtx(ctx, async (tx) => {
    const jobRows = (await tx.execute(sql`
      select selling_price_minor, price_adjustments
      from public.job where id = ${jobId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<{
      selling_price_minor: string | number | null;
      price_adjustments: Array<{ amount_minor?: number }> | null;
    }>;
    if (!jobRows[0]) throw new CostingNotFoundError();

    let rollup = (await tx.execute(sql`
      select cost_basis, material_cost_minor, po_cost_minor, expense_cost_minor,
             total_ex_labour_minor, computed_at::text as computed_at
      from public.cost_rollup where org_id = ${ctx.orgId} and job_id = ${jobId}
    `)) as unknown as Array<Record<string, unknown>>;
    if (!rollup[0]) {
      await tx.execute(sql`select app.refresh_cost_rollup(${ctx.orgId}, ${jobId}, ${basis})`);
      rollup = (await tx.execute(sql`
        select cost_basis, material_cost_minor, po_cost_minor, expense_cost_minor,
               total_ex_labour_minor, computed_at::text as computed_at
        from public.cost_rollup where org_id = ${ctx.orgId} and job_id = ${jobId}
      `)) as unknown as Array<Record<string, unknown>>;
    }
    const rr = rollup[0]!;

    // Labour rollup is behind the RLS cost wall — a non-cost-privileged session
    // reads ZERO rows here, so labour/total redact to null without a code branch.
    const labourRows = (await tx.execute(sql`
      select labour_cost_minor, total_cost_minor
      from public.cost_rollup_labour where org_id = ${ctx.orgId} and job_id = ${jobId}
    `)) as unknown as Array<{
      labour_cost_minor: string | number;
      total_cost_minor: string | number;
    }>;

    const adjustments = (jobRows[0].price_adjustments ?? []).reduce(
      (s, a) => s + Number(a.amount_minor ?? 0),
      0,
    );
    const sellingPriceMinor =
      jobRows[0].selling_price_minor === null ? null : Number(jobRows[0].selling_price_minor);
    // C-10 precedence: the accepted quote (S6) wins as the quoted figure; a divergence
    // between it and a manually-set selling price is raised as an exception, never
    // silently resolved (raiseQuoteDivergence, below).
    const acceptedQuote = (await tx.execute(sql`
      select base_total_minor from public.quote
      where org_id = ${ctx.orgId} and converted_job_id = ${jobId} and status = 'converted'
      order by accepted_at desc nulls last limit 1
    `)) as unknown as Array<{ base_total_minor: string | number }>;
    const acceptedQuoteTotalMinor = acceptedQuote[0]
      ? Number(acceptedQuote[0].base_total_minor)
      : null;
    const { quotedMinor, divergence } = resolveQuotedMinor({
      acceptedQuoteTotalMinor,
      sellingPriceMinor,
      adjustmentsMinor: adjustments,
    });

    const labourCostMinor =
      ctx.costPrivileged && labourRows[0] ? Number(labourRows[0].labour_cost_minor) : null;
    const totalCostMinor =
      ctx.costPrivileged && labourRows[0] ? Number(labourRows[0].total_cost_minor) : null;
    const quotedRedacted = ctx.pricePrivileged ? quotedMinor : null;
    const marginMinor =
      ctx.costPrivileged &&
      ctx.pricePrivileged &&
      totalCostMinor !== null &&
      quotedRedacted !== null
        ? quotedRedacted - totalCostMinor
        : null;

    return {
      jobId,
      costBasis: rr.cost_basis as VatBasis,
      currency,
      materialCostMinor: Number(rr.material_cost_minor),
      poCostMinor: Number(rr.po_cost_minor),
      expenseCostMinor: Number(rr.expense_cost_minor),
      totalExLabourMinor: Number(rr.total_ex_labour_minor),
      computedAt: (rr.computed_at as string | null) ?? null,
      labourCostMinor,
      totalCostMinor,
      quotedMinor: quotedRedacted,
      marginMinor,
      _divergence: divergence,
    };
  });
  // C-10: surface (or clear) the quote-vs-selling-price divergence as its own exception —
  // idempotent (dedup key), owner/admin audience. Kept OUT of the read tx above.
  if (view._divergence) {
    await raiseQuoteDivergence(ctx, { jobId, evidence: [{ acceptedQuote: true }] });
  } else {
    await clearQuoteDivergence(ctx, jobId);
  }
  const { _divergence, ...costingView } = view;
  void _divergence;
  return costingView satisfies CostingView;
}

/**
 * Nightly reconciliation (doc 10 #49 / D-2.2): recompute every active job's rollup
 * from source and PAGE-worthy-alarm on drift (a missed invalidation). Returns the
 * counts; drift is logged at error level (Sentry when configured — the MVP paging
 * hook; §15.4).
 */
export async function reconcileOrgRollups(ctx: Ctx): Promise<{ jobs: number; drifted: number }> {
  const basis = await resolveVatBasis(ctx);
  const jobIds = await withCtx(ctx, async (tx) => {
    // S10 perf: a 'done' job's cost inputs are frozen, so its rollup can't drift after a settling
    // period — reconcile 'active'/'on_hold' always, but only RECENTLY-touched 'done' jobs. This
    // keeps the nightly per-job transaction count bounded instead of growing with lifetime jobs.
    const rows = (await tx.execute(sql`
      select id::text as id from public.job
      where org_id = ${ctx.orgId}
        and (status_category in ('active', 'on_hold')
             or (status_category = 'done' and updated_at > now() - interval '30 days'))
    `)) as unknown as Array<{ id: string }>;
    return rows.map((r) => r.id);
  });
  let drifted = 0;
  for (const jobId of jobIds) {
    const res = await withCtx(ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        select app.refresh_cost_rollup(${ctx.orgId}, ${jobId}, ${basis}) as drifted
      `)) as unknown as Array<{ drifted: boolean }>;
      return rows[0]?.drifted ?? false;
    });
    if (res) {
      drifted++;
      logger.error(
        { org_id: ctx.orgId, job_id: jobId, request_id: ctx.requestId },
        "cost rollup drift detected — cache differed from recompute (missed invalidation)",
      );
    }
  }
  return { jobs: jobIds.length, drifted };
}

// Re-export so the C-10 raise/clear lives with the costing engine's callers.
export { raiseQuoteDivergence, clearQuoteDivergence };
