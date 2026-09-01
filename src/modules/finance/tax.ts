/**
 * H24H — the versioned tax engine and the UAE country packs.
 *
 * Facts over inference: tax_entry rows are captured when documents post;
 * returns are COMPUTED from those facts plus a reconciliation against the
 * VAT control accounts and an exception list of documents the engine could
 * not classify. A prepared return is a WORKING PAPER — review → lock →
 * amend — and nothing here files anything with any authority.
 *
 * Sources and verification tiers: docs/H24-EVIDENCE-LOG.md. Unverified
 * figures never auto-apply; every CT adjustment is an explicit reviewed row.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { FinanceError } from "./ledger";
import { financeConfigIn } from "./chart";

export const AE_VAT_PACK_VERSION = "AE-VAT-2026-09-01";
export const AE_CT_PACK_VERSION = "AE-CT-2026-09-01";

/** VAT201 box map (FTA VAT Returns User Guide — evidence log entry 2). */
export const VAT201_BOXES = {
  "1a": "Standard rated supplies — Abu Dhabi",
  "1b": "Standard rated supplies — Dubai",
  "1c": "Standard rated supplies — Sharjah",
  "1d": "Standard rated supplies — Ajman",
  "1e": "Standard rated supplies — Umm Al Quwain",
  "1f": "Standard rated supplies — Ras Al Khaimah",
  "1g": "Standard rated supplies — Fujairah",
  "2": "Tax refunds provided to tourists",
  "3": "Supplies subject to the reverse charge",
  "4": "Zero rated supplies",
  "5": "Exempt supplies",
  "6": "Goods imported into the UAE",
  "7": "Adjustments to goods imported",
  "9": "Standard rated expenses (recoverable input tax)",
  "10": "Supplies subject to the reverse charge (input)",
} as const;

const EMIRATE_BOX: Record<string, string> = {
  AUH: "1a",
  DXB: "1b",
  SHJ: "1c",
  AJM: "1d",
  UAQ: "1e",
  RAK: "1f",
  FUJ: "1g",
};

export type VatProfile = {
  trn: string | null;
  emirate: keyof typeof EMIRATE_BOX | string;
  periodicity: "monthly" | "quarterly";
  registered: boolean;
};

export async function vatProfileIn(tx: TenantTx, ctx: Ctx): Promise<VatProfile | null> {
  const rows = (await tx.execute(sql`
    select value from public.app_settings
    where org_id = ${ctx.orgId} and key = 'config.tax.vat'
  `)) as unknown as Array<{ value: VatProfile }>;
  return rows[0]?.value ?? null;
}

export async function setVatProfile(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "tax.prepare");
  const input = z
    .object({
      trn: z.string().trim().max(20).nullable(),
      emirate: z.enum(["AUH", "DXB", "SHJ", "AJM", "UAQ", "RAK", "FUJ"]),
      periodicity: z.enum(["monthly", "quarterly"]).default("quarterly"),
      registered: z.boolean(),
    })
    .parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "finance.tax.profile",
        entityType: "tax_code",
        entityId: ctx.orgId,
        summary: `VAT profile: ${input.registered ? "registered" : "not registered"}, ${input.emirate}, ${input.periodicity}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        insert into public.app_settings (org_id, key, value)
        values (${ctx.orgId}, 'config.tax.vat', ${JSON.stringify(input)}::jsonb)
        on conflict (org_id, key) do update set value = excluded.value
      `),
  );
}

/** Seed the AE VAT codes (idempotent). Verified-primary facts only. */
export async function installUaeVatPack(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<{ created: number }> {
  assertCan(archetype, "tax.prepare");
  const CODES = [
    {
      code: "AE-STD",
      nameEn: "UAE standard rate 5%",
      nameAr: "النسبة الأساسية 5٪",
      treatment: "standard",
      rate: 5,
      recoverable: true,
      box: "1x",
    },
    {
      code: "AE-ZERO",
      nameEn: "UAE zero rated",
      nameAr: "الخاضع لنسبة الصفر",
      treatment: "zero_rated",
      rate: 0,
      recoverable: true,
      box: "4",
    },
    {
      code: "AE-EXEMPT",
      nameEn: "UAE exempt",
      nameAr: "المعفى",
      treatment: "exempt",
      rate: 0,
      recoverable: false,
      box: "5",
    },
    {
      code: "AE-OOS",
      nameEn: "Out of scope",
      nameAr: "خارج النطاق",
      treatment: "out_of_scope",
      rate: 0,
      recoverable: false,
      box: null,
    },
    {
      code: "AE-RC",
      nameEn: "Reverse charge",
      nameAr: "الاحتساب العكسي",
      treatment: "reverse_charge",
      rate: 5,
      recoverable: true,
      box: "3",
    },
  ] as const;
  return command(
    ctx,
    {
      audit: (r: { created: number }) => ({
        action: "finance.tax.pack_install",
        entityType: "tax_code",
        entityId: ctx.orgId,
        summary: `UAE VAT pack ${AE_VAT_PACK_VERSION}: ${r.created} code(s) seeded`,
      }),
    },
    async (tx) => {
      let created = 0;
      for (const c of CODES) {
        const inserted = (await tx.execute(sql`
          insert into public.tax_code
            (org_id, code, name_en, name_ar, jurisdiction, pack_version, tax_type, treatment,
             rate_percent, recoverable, reporting_box, effective_from, is_custom, created_by)
          values (${ctx.orgId}, ${c.code}, ${c.nameEn}, ${c.nameAr}, 'AE',
                  ${AE_VAT_PACK_VERSION}, 'vat', ${c.treatment}, ${c.rate}, ${c.recoverable},
                  ${c.box}, '2018-01-01', false, ${ctx.userId})
          on conflict (org_id, code, effective_from) do nothing
          returning id
        `)) as unknown as unknown[];
        if (inserted.length > 0) created++;
      }
      return { created };
    },
  );
}

/**
 * Capture the tax FACTS for a posted document. Called from the posting rules
 * in the same transaction. Classification is honest:
 *   vat > 0            → the AE standard code (box 1a–1g by the org emirate
 *                        for outputs, box 9 for inputs)
 *   vat = 0 + export   → zero-rated (box 4)
 *   vat = 0 otherwise  → NOT captured; the document appears in the return's
 *                        exception list for a human to classify.
 */
export async function captureTaxEntryIn(
  tx: TenantTx,
  ctx: Ctx,
  params: {
    journalEntryId: string;
    sourceType: string;
    sourceId: string;
    direction: "output" | "input";
    baseMinor: number;
    taxMinor: number;
    txnDate: string;
    isExport?: boolean;
  },
): Promise<{ captured: boolean }> {
  const profile = await vatProfileIn(tx, ctx);
  if (!profile?.registered) return { captured: false };
  let codeRow: Array<Record<string, unknown>>;
  let box: string | null;
  if (params.taxMinor !== 0) {
    codeRow = (await tx.execute(sql`
      select id::text as id, code, treatment, rate_percent::text as rate, pack_version, recoverable
      from public.tax_code
      where org_id = ${ctx.orgId} and code = 'AE-STD' and active
        and effective_from <= ${params.txnDate}::date
      order by effective_from desc limit 1
    `)) as unknown as Array<Record<string, unknown>>;
    box = params.direction === "output" ? (EMIRATE_BOX[profile.emirate] ?? "1a") : "9";
  } else if (params.isExport) {
    codeRow = (await tx.execute(sql`
      select id::text as id, code, treatment, rate_percent::text as rate, pack_version, recoverable
      from public.tax_code
      where org_id = ${ctx.orgId} and code = 'AE-ZERO' and active
        and effective_from <= ${params.txnDate}::date
      order by effective_from desc limit 1
    `)) as unknown as Array<Record<string, unknown>>;
    box = "4";
  } else {
    return { captured: false }; // uncategorized → exception report
  }
  if (!codeRow[0]) return { captured: false }; // pack not installed → exceptions
  await tx.execute(sql`
    insert into public.tax_entry
      (org_id, journal_entry_id, source_type, source_id, tax_code_id, direction,
       base_minor, tax_minor, txn_date, reporting_box, emirate, code_snapshot)
    values (${ctx.orgId}, ${params.journalEntryId}, ${params.sourceType}, ${params.sourceId},
            ${codeRow[0].id as string}, ${params.direction}, ${params.baseMinor},
            ${params.taxMinor}, ${params.txnDate}, ${box},
            ${params.direction === "output" ? profile.emirate : null},
            ${JSON.stringify(codeRow[0])}::jsonb)
    on conflict (org_id, source_type, source_id, direction, tax_code_id) do nothing
  `);
  return { captured: true };
}

// ── the VAT201 working report ────────────────────────────────────────────────

export type VatReturnWorking = {
  packVersion: string;
  boxes: Record<string, { label: string; baseMinor: number; taxMinor: number }>;
  totals: {
    outputTaxMinor: number;
    inputTaxMinor: number;
    netPayableMinor: number;
  };
  exceptions: Array<{ sourceType: string; reference: string; reason: string }>;
  reconciliation: {
    vatOutputControlMinor: number;
    vatInputControlMinor: number;
    outputDriftMinor: number;
    inputDriftMinor: number;
  };
};

export async function prepareVatReturn(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ returnId: string; reference: string; working: VatReturnWorking }> {
  assertCan(archetype, "tax.prepare");
  const input = z
    .object({
      periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { returnId: string; reference: string }) => ({
        action: "finance.tax.prepare_vat",
        entityType: "tax_return",
        entityId: r.returnId,
        summary: `VAT working paper ${r.reference} (${input.periodStart}..${input.periodEnd})`,
      }),
    },
    async (tx) => {
      const config = await financeConfigIn(tx, ctx);
      if (!config) throw new FinanceError("run finance setup first");
      const profile = await vatProfileIn(tx, ctx);
      if (!profile?.registered) {
        throw new FinanceError("the organization is not marked VAT-registered in its tax profile");
      }

      const facts = (await tx.execute(sql`
        select reporting_box, direction,
               coalesce(sum(base_minor), 0)::text as base,
               coalesce(sum(tax_minor), 0)::text as tax
        from public.tax_entry
        where org_id = ${ctx.orgId}
          and txn_date between ${input.periodStart}::date and ${input.periodEnd}::date
        group by reporting_box, direction
      `)) as unknown as Array<Record<string, string>>;

      const boxes: VatReturnWorking["boxes"] = {};
      let outputTax = 0;
      let inputTax = 0;
      for (const f of facts) {
        const key = f.reporting_box ?? "unboxed";
        const label = (VAT201_BOXES as Record<string, string>)[key] ?? key;
        boxes[key] = boxes[key] ?? { label, baseMinor: 0, taxMinor: 0 };
        boxes[key]!.baseMinor += Number(f.base);
        boxes[key]!.taxMinor += Number(f.tax);
        if (f.direction === "output") outputTax += Number(f.tax);
        else inputTax += Number(f.tax);
      }

      // Exceptions: money documents in the period with NO captured tax fact.
      const exceptions = (await tx.execute(sql`
        select 'invoice' as source_type, i.reference,
               'no tax classification captured' as reason
        from public.invoice i
        where i.org_id = ${ctx.orgId} and i.status not in ('draft', 'cancelled')
          and coalesce(i.issued_at::date, i.created_at::date)
              between ${input.periodStart}::date and ${input.periodEnd}::date
          and not exists (select 1 from public.tax_entry t
                          where t.org_id = i.org_id and t.source_type = 'invoice'
                            and t.source_id = i.id)
        union all
        select 'expense', e.reference, 'no tax classification captured'
        from public.expense e
        where e.org_id = ${ctx.orgId} and e.voided_at is null
          and e.expense_date between ${input.periodStart}::date and ${input.periodEnd}::date
          and not exists (select 1 from public.tax_entry t
                          where t.org_id = e.org_id and t.source_type = 'expense'
                            and t.source_id = e.id)
        limit 500
      `)) as unknown as Array<Record<string, string>>;

      // Reconciliation vs the VAT control accounts in the same period.
      const control = (await tx.execute(sql`
        select a.system_key,
               coalesce(sum(l.base_credit_minor - l.base_debit_minor), 0)::text as net_credit
        from public.journal_line l
        join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
        join public.gl_account a on a.id = l.account_id and a.org_id = l.org_id
        where l.org_id = ${ctx.orgId} and a.system_key in ('vat_output', 'vat_input')
          and e.status in ('posted', 'reversed')
          and e.entry_date between ${input.periodStart}::date and ${input.periodEnd}::date
        group by a.system_key
      `)) as unknown as Array<{ system_key: string; net_credit: string }>;
      const vatOutCtl = Number(control.find((c) => c.system_key === "vat_output")?.net_credit ?? 0);
      const vatInCtl = -Number(control.find((c) => c.system_key === "vat_input")?.net_credit ?? 0);

      const working: VatReturnWorking = {
        packVersion: AE_VAT_PACK_VERSION,
        boxes,
        totals: {
          outputTaxMinor: outputTax,
          inputTaxMinor: inputTax,
          netPayableMinor: outputTax - inputTax,
        },
        exceptions: exceptions.map((e) => ({
          sourceType: e.source_type!,
          reference: e.reference!,
          reason: e.reason!,
        })),
        reconciliation: {
          vatOutputControlMinor: vatOutCtl,
          vatInputControlMinor: vatInCtl,
          outputDriftMinor: outputTax - vatOutCtl,
          inputDriftMinor: inputTax - vatInCtl,
        },
      };

      const seq = await allocateReference(tx, ctx, "tax_return");
      const reference = formatRef("VAT", seq, 4);
      const rows = (await tx.execute(sql`
        insert into public.tax_return
          (org_id, reference, tax_type, period_start, period_end, pack_version, working,
           prepared_by)
        values (${ctx.orgId}, ${reference}, 'vat', ${input.periodStart}, ${input.periodEnd},
                ${AE_VAT_PACK_VERSION}, ${JSON.stringify(working)}::jsonb, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { returnId: rows[0]!.id, reference, working };
    },
  );
}

/** draft → under_review (preparer) → locked (tax.review only). */
export async function setReturnStatus(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  const input = z
    .object({
      returnId: z.string().uuid(),
      status: z.enum(["under_review", "locked"]),
      note: z.string().trim().max(2000).optional(),
    })
    .parse(raw);
  assertCan(archetype, input.status === "locked" ? "tax.review" : "tax.prepare");
  await command(
    ctx,
    {
      audit: {
        action: "finance.tax.status",
        entityType: "tax_return",
        entityId: input.returnId,
        summary: `Return → ${input.status}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.tax_return
        set status = ${input.status},
            reviewed_by = ${input.status === "locked" ? ctx.userId : sql`reviewed_by`},
            reviewed_at = ${input.status === "locked" ? sql`now()` : sql`reviewed_at`},
            locked_at = ${input.status === "locked" ? sql`now()` : sql`locked_at`},
            notes = coalesce(${input.note ?? null}, notes),
            updated_at = now()
        where id = ${input.returnId} and org_id = ${ctx.orgId}
          and status in ('draft', 'under_review')
        returning id
      `)) as unknown as unknown[];
      if (rows.length === 0) {
        throw new FinanceError("return not found or already locked", "invalid_state");
      }
    },
  );
}

/** Amend a LOCKED return: mark it amended and prepare a fresh linked draft. */
export async function amendVatReturn(
  ctx: Ctx,
  archetype: RoleArchetype,
  returnId: string,
): Promise<{ returnId: string; reference: string }> {
  assertCan(archetype, "tax.prepare");
  const prior = await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select period_start::text as ps, period_end::text as pe, tax_type, status
      from public.tax_return where id = ${returnId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, string>>;
    return rows[0] ?? null;
  });
  if (!prior) throw new FinanceError("return not found", "not_found");
  if (prior.status !== "locked") throw new FinanceError("only a locked return can be amended");
  const fresh = await prepareVatReturn(ctx, archetype, {
    periodStart: prior.ps,
    periodEnd: prior.pe,
  });
  await command(
    ctx,
    {
      audit: {
        action: "finance.tax.amend",
        entityType: "tax_return",
        entityId: returnId,
        summary: `Amended by ${fresh.reference}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.tax_return set status = 'amended', updated_at = now()
        where id = ${returnId} and org_id = ${ctx.orgId} and status = 'locked'
      `);
      await tx.execute(sql`
        update public.tax_return set amends_return_id = ${returnId}, updated_at = now()
        where id = ${fresh.returnId} and org_id = ${ctx.orgId}
      `);
    },
  );
  return { returnId: fresh.returnId, reference: fresh.reference };
}

// ── UAE Corporate Tax working paper ─────────────────────────────────────────

/** The adjustment catalogue: rule key → legal source (evidence log entry 10).
 *  Amounts are ALWAYS explicit reviewed inputs; nothing is auto-derived. */
export const CT_ADJUSTMENT_RULES: Record<
  string,
  { label: string; legalSource: string; direction: "add" | "deduct" }
> = {
  entertainment_50: {
    label: "Entertainment expenditure — 50% non-deductible portion",
    legalSource: "Federal Decree-Law 47/2022 Art. 32 (as summarized; verify against current text)",
    direction: "add",
  },
  fines_penalties: {
    label: "Fines and penalties — non-deductible",
    legalSource: "Federal Decree-Law 47/2022 Art. 33",
    direction: "add",
  },
  non_business_expense: {
    label: "Expenditure not for business purposes",
    legalSource: "Federal Decree-Law 47/2022 Art. 28",
    direction: "add",
  },
  related_party: {
    label: "Related-party / connected-person adjustment (arm's length)",
    legalSource: "Federal Decree-Law 47/2022 Arts. 34-36",
    direction: "add",
  },
  interest_limitation: {
    label: "Net interest above the general interest deduction limitation",
    legalSource: "Federal Decree-Law 47/2022 Art. 30 + MD guidance",
    direction: "add",
  },
  exempt_income: {
    label: "Exempt income (participation and other exemptions)",
    legalSource: "Federal Decree-Law 47/2022 Arts. 22-23",
    direction: "deduct",
  },
  unrealized_election: {
    label: "Unrealized gains/losses election adjustment",
    legalSource: "Federal Decree-Law 47/2022 Art. 20 elections",
    direction: "deduct",
  },
  loss_carryforward: {
    label: "Tax losses utilized (subject to the 75% set-off cap)",
    legalSource: "Federal Decree-Law 47/2022 Arts. 37-39",
    direction: "deduct",
  },
  foreign_tax_credit: {
    label: "Foreign tax credit (reduces tax, entered as reviewed input)",
    legalSource: "Federal Decree-Law 47/2022 Art. 47",
    direction: "deduct",
  },
  other_add: {
    label: "Other addition (documented)",
    legalSource: "as documented in evidence",
    direction: "add",
  },
  other_deduct: {
    label: "Other deduction (documented)",
    legalSource: "as documented in evidence",
    direction: "deduct",
  },
};

/** 0% to AED 375,000, 9% above — the ONLY auto-computed bracket (verified). */
export function computeCtTax(taxableMinor: number): number {
  const threshold = 375_000_00;
  if (taxableMinor <= threshold) return 0;
  return Math.floor(((taxableMinor - threshold) * 9) / 100);
}

export async function prepareCtWorkpaper(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ returnId: string; reference: string; accountingIncomeMinor: number }> {
  assertCan(archetype, "tax.prepare");
  const input = z
    .object({
      periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { returnId: string; reference: string }) => ({
        action: "finance.tax.prepare_ct",
        entityType: "tax_return",
        entityId: r.returnId,
        summary: `Corporate-tax workpaper ${r.reference}`,
      }),
    },
    async (tx) => {
      const config = await financeConfigIn(tx, ctx);
      if (!config) throw new FinanceError("run finance setup first");
      // Accounting income = ledger P&L for the period (income − expense).
      const pl = (await tx.execute(sql`
        select a.account_type,
               coalesce(sum(l.base_credit_minor - l.base_debit_minor), 0)::text as net_credit
        from public.journal_line l
        join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
        join public.gl_account a on a.id = l.account_id and a.org_id = l.org_id
        where l.org_id = ${ctx.orgId} and a.account_type in ('income', 'expense')
          and e.status in ('posted', 'reversed')
          and e.entry_date between ${input.periodStart}::date and ${input.periodEnd}::date
        group by a.account_type
      `)) as unknown as Array<{ account_type: string; net_credit: string }>;
      const income = Number(pl.find((r) => r.account_type === "income")?.net_credit ?? 0);
      const expense = -Number(pl.find((r) => r.account_type === "expense")?.net_credit ?? 0);
      const accountingIncome = income - expense;

      const working = {
        packVersion: AE_CT_PACK_VERSION,
        startingPoint: {
          label: "Accounting income (ledger P&L for the period)",
          incomeMinor: income,
          expenseMinor: expense,
          accountingIncomeMinor: accountingIncome,
        },
        rates: { thresholdMinor: 375_000_00, ratePercentAbove: 9 },
        smallBusinessRelief: {
          note: "Election requires: explicit election, revenue <= AED 3,000,000, period ending on or before 2026-12-31 (MD 73/2023). Never auto-elected.",
          elected: false,
        },
        freeZone: {
          note: "Qualifying free-zone treatment requires explicit reviewed eligibility inputs. Never inferred.",
          claimed: false,
        },
        disclaimer:
          "Working paper only. Calculated from verified rules; requires professional review; IdaraWorks does not file returns or guarantee compliance.",
      };

      const seq = await allocateReference(tx, ctx, "tax_return");
      const reference = formatRef("CT", seq, 4);
      const rows = (await tx.execute(sql`
        insert into public.tax_return
          (org_id, reference, tax_type, period_start, period_end, pack_version, working, prepared_by)
        values (${ctx.orgId}, ${reference}, 'corporate', ${input.periodStart}, ${input.periodEnd},
                ${AE_CT_PACK_VERSION}, ${JSON.stringify(working)}::jsonb, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { returnId: rows[0]!.id, reference, accountingIncomeMinor: accountingIncome };
    },
  );
}

export async function addCtAdjustment(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "tax.prepare");
  const input = z
    .object({
      returnId: z.string().uuid(),
      ruleKey: z.string().min(1).max(60),
      sourceAmountMinor: z.number().int(),
      adjustmentMinor: z.number().int().min(0),
      calculation: z.string().trim().min(1).max(500),
      evidence: z.string().trim().max(1000).optional(),
      label: z.string().trim().max(200).optional(),
    })
    .parse(raw);
  const rule = CT_ADJUSTMENT_RULES[input.ruleKey];
  if (!rule) throw new FinanceError(`unknown adjustment rule ${input.ruleKey}`);
  return command(
    ctx,
    {
      audit: () => ({
        action: "finance.tax.ct_adjustment",
        entityType: "tax_return",
        entityId: input.returnId,
        summary: `CT adjustment ${input.ruleKey}`,
      }),
    },
    async (tx) => {
      const ret = (await tx.execute(sql`
        select status, tax_type from public.tax_return
        where id = ${input.returnId} and org_id = ${ctx.orgId}
      `)) as unknown as Array<{ status: string; tax_type: string }>;
      if (!ret[0] || ret[0].tax_type !== "corporate") {
        throw new FinanceError("corporate-tax return not found", "not_found");
      }
      if (ret[0].status === "locked" || ret[0].status === "amended") {
        throw new FinanceError("a locked return's adjustments are history");
      }
      const rows = (await tx.execute(sql`
        insert into public.ct_adjustment
          (org_id, return_id, rule_key, label, direction, source_amount_minor,
           adjustment_minor, legal_source, calculation, evidence, created_by)
        values (${ctx.orgId}, ${input.returnId}, ${input.ruleKey},
                ${input.label ?? rule.label}, ${rule.direction}, ${input.sourceAmountMinor},
                ${input.adjustmentMinor}, ${rule.legalSource}, ${input.calculation},
                ${input.evidence ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export type CtComputation = {
  accountingIncomeMinor: number;
  additionsMinor: number;
  deductionsMinor: number;
  taxableIncomeMinor: number;
  taxMinor: number;
  sbrApplied: boolean;
  adjustments: Array<{
    ruleKey: string;
    label: string;
    direction: string;
    sourceAmountMinor: number;
    adjustmentMinor: number;
    legalSource: string;
    calculation: string;
    evidence: string | null;
  }>;
};

/** Recompute the workpaper from its stored starting point + live adjustments. */
export async function computeCtWorkpaper(
  ctx: Ctx,
  archetype: RoleArchetype,
  returnId: string,
  opts: { sbrElected?: boolean; sbrRevenueMinor?: number } = {},
): Promise<CtComputation> {
  assertCan(archetype, "tax.prepare");
  return withCtx(ctx, async (tx) => {
    const ret = (await tx.execute(sql`
      select working, period_end::text as pe from public.tax_return
      where id = ${returnId} and org_id = ${ctx.orgId} and tax_type = 'corporate'
    `)) as unknown as Array<{
      working: { startingPoint: { accountingIncomeMinor: number } };
      pe: string;
    }>;
    if (!ret[0]) throw new FinanceError("corporate-tax return not found", "not_found");
    const base = ret[0].working.startingPoint.accountingIncomeMinor;
    const adj = (await tx.execute(sql`
      select rule_key, label, direction, source_amount_minor::text as src,
             adjustment_minor::text as amt, legal_source, calculation, evidence
      from public.ct_adjustment
      where org_id = ${ctx.orgId} and return_id = ${returnId} and voided_at is null
      order by created_at
    `)) as unknown as Array<Record<string, string | null>>;
    let additions = 0;
    let deductions = 0;
    for (const a of adj) {
      if (a.direction === "add") additions += Number(a.amt);
      else deductions += Number(a.amt);
    }
    const taxable = base + additions - deductions;
    // SBR: explicit election + revenue test SHOWN + period-end window (MD 73/2023).
    const sbrEligibleWindow = ret[0].pe <= "2026-12-31";
    const sbrApplied =
      opts.sbrElected === true &&
      sbrEligibleWindow &&
      (opts.sbrRevenueMinor ?? Number.MAX_SAFE_INTEGER) <= 3_000_000_00;
    const tax = sbrApplied ? 0 : computeCtTax(Math.max(taxable, 0));
    return {
      accountingIncomeMinor: base,
      additionsMinor: additions,
      deductionsMinor: deductions,
      taxableIncomeMinor: taxable,
      taxMinor: tax,
      sbrApplied,
      adjustments: adj.map((a) => ({
        ruleKey: a.rule_key!,
        label: a.label!,
        direction: a.direction!,
        sourceAmountMinor: Number(a.src),
        adjustmentMinor: Number(a.amt),
        legalSource: a.legal_source!,
        calculation: a.calculation!,
        evidence: a.evidence ?? null,
      })),
    };
  });
}
