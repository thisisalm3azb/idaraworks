/**
 * H24C — the chart-of-accounts template, guided finance setup, opening
 * balances, reversing journals and memorized/recurring templates.
 *
 * The template is VERSIONED CODE (truth map D6): system accounts the posting
 * rules resolve by key. Installation is per-organization, idempotent, and
 * never overwrites an account the org already shaped.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { requireCapability } from "@/platform/entitlements";
import {
  FinanceError,
  createFiscalYear,
  postFromSourceIn,
  systemAccountIn,
  defaultNormalBalance,
} from "./ledger";

export const CHART_TEMPLATE_VERSION = "core-2026-09-01";

type TemplateAccount = {
  code: string;
  nameEn: string;
  nameAr: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  systemKey?: string;
  control?: "ar" | "ap" | "bank" | "cash" | "inventory" | "tax" | "payroll";
  parent?: string; // code of parent
};

/** The seeded chart. Codes are conventional 4-digit; orgs extend freely. */
export const CHART_TEMPLATE: readonly TemplateAccount[] = [
  // Assets
  { code: "1000", nameEn: "Assets", nameAr: "الأصول", type: "asset" },
  {
    code: "1100",
    nameEn: "Cash on hand",
    nameAr: "النقد في الصندوق",
    type: "asset",
    parent: "1000",
    systemKey: "cash_on_hand",
    control: "cash",
  },
  {
    code: "1110",
    nameEn: "Bank accounts",
    nameAr: "الحسابات البنكية",
    type: "asset",
    parent: "1000",
    systemKey: "bank_default",
    control: "bank",
  },
  {
    code: "1120",
    nameEn: "Undeposited funds",
    nameAr: "مقبوضات قيد الإيداع",
    type: "asset",
    parent: "1000",
    systemKey: "undeposited_funds",
    control: "cash",
  },
  {
    code: "1200",
    nameEn: "Accounts receivable",
    nameAr: "الذمم المدينة",
    type: "asset",
    parent: "1000",
    systemKey: "ar_control",
    control: "ar",
  },
  {
    code: "1300",
    nameEn: "Inventory",
    nameAr: "المخزون",
    type: "asset",
    parent: "1000",
    systemKey: "inventory",
    control: "inventory",
  },
  {
    code: "1400",
    nameEn: "VAT recoverable (input)",
    nameAr: "ضريبة القيمة المضافة القابلة للاسترداد",
    type: "asset",
    parent: "1000",
    systemKey: "vat_input",
    control: "tax",
  },
  {
    code: "1500",
    nameEn: "Prepaid expenses",
    nameAr: "مصروفات مدفوعة مقدمًا",
    type: "asset",
    parent: "1000",
    systemKey: "prepaid_expenses",
  },
  {
    code: "1600",
    nameEn: "Employee advances",
    nameAr: "سلف الموظفين",
    type: "asset",
    parent: "1000",
    systemKey: "employee_advances",
  },
  {
    code: "1700",
    nameEn: "Fixed assets",
    nameAr: "الأصول الثابتة",
    type: "asset",
    parent: "1000",
    systemKey: "fixed_assets",
  },
  {
    code: "1750",
    nameEn: "Accumulated depreciation",
    nameAr: "مجمع الإهلاك",
    type: "asset",
    parent: "1000",
    systemKey: "accumulated_depreciation",
  },
  // Liabilities
  { code: "2000", nameEn: "Liabilities", nameAr: "الالتزامات", type: "liability" },
  {
    code: "2100",
    nameEn: "Accounts payable",
    nameAr: "الذمم الدائنة",
    type: "liability",
    parent: "2000",
    systemKey: "ap_control",
    control: "ap",
  },
  {
    code: "2150",
    nameEn: "Goods received not invoiced",
    nameAr: "بضائع مستلمة غير مفوترة",
    type: "liability",
    parent: "2000",
    systemKey: "grni",
    control: "ap",
  },
  {
    code: "2200",
    nameEn: "VAT payable (output)",
    nameAr: "ضريبة القيمة المضافة المستحقة",
    type: "liability",
    parent: "2000",
    systemKey: "vat_output",
    control: "tax",
  },
  {
    code: "2300",
    nameEn: "Accrued expenses",
    nameAr: "مصروفات مستحقة",
    type: "liability",
    parent: "2000",
    systemKey: "accrued_expenses",
  },
  {
    code: "2400",
    nameEn: "Employee net pay payable",
    nameAr: "صافي رواتب مستحقة",
    type: "liability",
    parent: "2000",
    systemKey: "payroll_net_payable",
    control: "payroll",
  },
  {
    code: "2410",
    nameEn: "Payroll deductions payable",
    nameAr: "استقطاعات رواتب مستحقة",
    type: "liability",
    parent: "2000",
    systemKey: "payroll_deductions_payable",
    control: "payroll",
  },
  {
    code: "2420",
    nameEn: "Employer contributions payable",
    nameAr: "مساهمات صاحب العمل المستحقة",
    type: "liability",
    parent: "2000",
    systemKey: "employer_contrib_payable",
    control: "payroll",
  },
  {
    code: "2500",
    nameEn: "Corporate tax payable",
    nameAr: "ضريبة الشركات المستحقة",
    type: "liability",
    parent: "2000",
    systemKey: "corporate_tax_payable",
  },
  // Equity
  { code: "3000", nameEn: "Equity", nameAr: "حقوق الملكية", type: "equity" },
  {
    code: "3100",
    nameEn: "Owner capital",
    nameAr: "رأس المال",
    type: "equity",
    parent: "3000",
    systemKey: "owner_capital",
  },
  {
    code: "3200",
    nameEn: "Retained earnings",
    nameAr: "الأرباح المحتجزة",
    type: "equity",
    parent: "3000",
    systemKey: "retained_earnings",
  },
  {
    code: "3300",
    nameEn: "Opening balance equity",
    nameAr: "حقوق أرصدة افتتاحية",
    type: "equity",
    parent: "3000",
    systemKey: "opening_balance_equity",
  },
  // Income
  { code: "4000", nameEn: "Income", nameAr: "الإيرادات", type: "income" },
  {
    code: "4100",
    nameEn: "Sales revenue",
    nameAr: "إيرادات المبيعات",
    type: "income",
    parent: "4000",
    systemKey: "sales_revenue",
  },
  {
    code: "4200",
    nameEn: "Other income",
    nameAr: "إيرادات أخرى",
    type: "income",
    parent: "4000",
    systemKey: "other_income",
  },
  {
    code: "4300",
    nameEn: "Foreign exchange gains",
    nameAr: "أرباح فروق العملة",
    type: "income",
    parent: "4000",
    systemKey: "fx_gain",
  },
  // Expenses
  { code: "5000", nameEn: "Cost of sales", nameAr: "تكلفة المبيعات", type: "expense" },
  {
    code: "5100",
    nameEn: "Cost of goods sold",
    nameAr: "تكلفة البضاعة المباعة",
    type: "expense",
    parent: "5000",
    systemKey: "cogs",
  },
  {
    code: "5200",
    nameEn: "Direct job costs",
    nameAr: "تكاليف مباشرة",
    type: "expense",
    parent: "5000",
    systemKey: "direct_costs",
  },
  {
    code: "5300",
    nameEn: "Inventory adjustments",
    nameAr: "تسويات المخزون",
    type: "expense",
    parent: "5000",
    systemKey: "stock_adjustment",
  },
  { code: "6000", nameEn: "Operating expenses", nameAr: "المصروفات التشغيلية", type: "expense" },
  {
    code: "6100",
    nameEn: "Overheads",
    nameAr: "مصروفات عمومية",
    type: "expense",
    parent: "6000",
    systemKey: "overhead_expense",
  },
  {
    code: "6200",
    nameEn: "Salaries and wages",
    nameAr: "الرواتب والأجور",
    type: "expense",
    parent: "6000",
    systemKey: "salary_expense",
  },
  {
    code: "6210",
    nameEn: "Employer contributions",
    nameAr: "مساهمات صاحب العمل",
    type: "expense",
    parent: "6000",
    systemKey: "employer_contrib_expense",
  },
  {
    code: "6300",
    nameEn: "Depreciation expense",
    nameAr: "مصروف الإهلاك",
    type: "expense",
    parent: "6000",
    systemKey: "depreciation_expense",
  },
  {
    code: "6400",
    nameEn: "Bank charges",
    nameAr: "رسوم بنكية",
    type: "expense",
    parent: "6000",
    systemKey: "bank_charges",
  },
  {
    code: "6500",
    nameEn: "Foreign exchange losses",
    nameAr: "خسائر فروق العملة",
    type: "expense",
    parent: "6000",
    systemKey: "fx_loss",
  },
  {
    code: "6900",
    nameEn: "Rounding differences",
    nameAr: "فروق التقريب",
    type: "expense",
    parent: "6000",
    systemKey: "rounding",
  },
] as const;

export type FinanceConfig = {
  booksStartDate: string;
  chartTemplateVersion: string;
  setupAt: string;
  setupBy: string;
};

export async function financeConfigIn(tx: TenantTx, ctx: Ctx): Promise<FinanceConfig | null> {
  const rows = (await tx.execute(sql`
    select value from public.app_settings
    where org_id = ${ctx.orgId} and key = 'config.finance'
  `)) as unknown as Array<{ value: FinanceConfig }>;
  return rows[0]?.value ?? null;
}

export async function financeConfig(ctx: Ctx): Promise<FinanceConfig | null> {
  return withCtx(ctx, (tx) => financeConfigIn(tx, ctx));
}

/**
 * Guided setup, idempotent: seed missing template accounts, create the first
 * fiscal year if none covers the books start, and record the ONE finance
 * config (D7: posting rules apply to documents dated on/after booksStartDate).
 */
export async function installFinanceSetup(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ accountsCreated: number; fiscalYearCreated: boolean }> {
  assertCan(archetype, "finance.manage");
  await requireCapability(ctx, "cap.finance");
  const input = z
    .object({
      booksStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .parse(raw);

  const yearStart = input.booksStartDate;
  const start = new Date(`${yearStart}T00:00:00Z`);
  const yearEnd = new Date(
    Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate() - 1),
  );

  const result = await command(
    ctx,
    {
      audit: (r: { accountsCreated: number }) => ({
        action: "finance.setup.install",
        entityType: "config",
        entityId: ctx.orgId,
        summary: `Finance setup: chart ${CHART_TEMPLATE_VERSION}, books start ${input.booksStartDate}, ${r.accountsCreated} account(s) seeded`,
      }),
    },
    async (tx) => {
      const existing = (await tx.execute(sql`
        select code from public.gl_account where org_id = ${ctx.orgId}
      `)) as unknown as Array<{ code: string }>;
      const have = new Set(existing.map((r) => r.code));
      const idByCode = new Map<string, string>();
      let created = 0;
      for (const a of CHART_TEMPLATE) {
        if (have.has(a.code)) {
          const row = (await tx.execute(sql`
            select id::text as id from public.gl_account
            where org_id = ${ctx.orgId} and code = ${a.code}
          `)) as unknown as Array<{ id: string }>;
          idByCode.set(a.code, row[0]!.id);
          continue;
        }
        const rows = (await tx.execute(sql`
          insert into public.gl_account
            (org_id, code, name_en, name_ar, parent_id, account_type, normal_balance,
             is_control, control_kind, system_key, created_by)
          values (${ctx.orgId}, ${a.code}, ${a.nameEn}, ${a.nameAr},
                  ${a.parent ? (idByCode.get(a.parent) ?? null) : null},
                  ${a.type}, ${defaultNormalBalance(a.type)},
                  ${!!a.control}, ${a.control ?? null}, ${a.systemKey ?? null}, ${ctx.userId})
          returning id::text as id
        `)) as unknown as Array<{ id: string }>;
        idByCode.set(a.code, rows[0]!.id);
        created++;
      }
      const config: FinanceConfig = {
        booksStartDate: input.booksStartDate,
        chartTemplateVersion: CHART_TEMPLATE_VERSION,
        setupAt: new Date().toISOString(),
        setupBy: ctx.userId,
      };
      await tx.execute(sql`
        insert into public.app_settings (org_id, key, value)
        values (${ctx.orgId}, 'config.finance', ${JSON.stringify(config)}::jsonb)
        on conflict (org_id, key) do update set value = excluded.value
      `);
      return { accountsCreated: created };
    },
  );

  // Fiscal year outside the command tx (its own audited action, idempotent).
  let fiscalYearCreated = false;
  const covered = await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select 1 from public.fiscal_year
      where org_id = ${ctx.orgId} and starts_on <= ${yearStart}::date and ends_on >= ${yearStart}::date
    `)) as unknown as unknown[];
    return rows.length > 0;
  });
  if (!covered) {
    await createFiscalYear(ctx, archetype, {
      label: `FY ${start.getUTCFullYear()}`,
      startsOn: yearStart,
      endsOn: yearEnd.toISOString().slice(0, 10),
    });
    fiscalYearCreated = true;
  }
  return { accountsCreated: result.accountsCreated, fiscalYearCreated };
}

// ── opening balances ─────────────────────────────────────────────────────────

/**
 * Reviewed opening balances (D7): one 'opening' journal as of the books start
 * date. The offset to Opening Balance Equity is computed AND SHOWN as its own
 * line — visible mechanics, not silent balancing. Control accounts are
 * allowed here because opening an AR/AP position is exactly what this is for.
 */
export async function postOpeningBalances(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ entryId: string; entryNo: string; offsetMinor: number }> {
  assertCan(archetype, "finance.close");
  const input = z
    .object({
      lines: z
        .array(
          z.object({
            accountId: z.string().uuid(),
            debitMinor: z.number().int().min(0).default(0),
            creditMinor: z.number().int().min(0).default(0),
            description: z.string().trim().max(500).optional(),
            customerId: z.string().uuid().optional(),
            supplierId: z.string().uuid().optional(),
          }),
        )
        .min(1)
        .max(500),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { entryId: string; entryNo: string }) => ({
        action: "finance.opening.post",
        entityType: "journal_entry",
        entityId: r.entryId,
        summary: `Opening balances ${r.entryNo} (${input.lines.length} line(s))`,
      }),
    },
    async (tx) => {
      const config = await financeConfigIn(tx, ctx);
      if (!config) throw new FinanceError("run finance setup first");
      const equity = await systemAccountIn(tx, ctx, "opening_balance_equity");
      let d = 0;
      let c = 0;
      for (const l of input.lines) {
        if (l.debitMinor > 0 === l.creditMinor > 0) {
          throw new FinanceError("each opening line is a debit OR a credit", "unbalanced");
        }
        d += l.debitMinor;
        c += l.creditMinor;
      }
      const offset = d - c;
      const base = (await tx.execute(sql`
        select base_currency from public.org where id = ${ctx.orgId}
      `)) as unknown as Array<{ base_currency: string }>;
      const lines = input.lines.map((l) => ({
        accountId: l.accountId,
        description: l.description,
        debitMinor: l.debitMinor,
        creditMinor: l.creditMinor,
        customerId: l.customerId,
        supplierId: l.supplierId,
      }));
      if (offset !== 0) {
        lines.push({
          accountId: equity,
          description: "Opening balance equity (offset — shown, never hidden)",
          debitMinor: offset < 0 ? -offset : 0,
          creditMinor: offset > 0 ? offset : 0,
          customerId: undefined,
          supplierId: undefined,
        });
      }
      const posted = await postFromSourceIn(tx, ctx, {
        sourceType: "opening_balance",
        sourceId: ctx.orgId,
        eventKey: `opening:${config.booksStartDate}`,
        ruleKey: "opening.v1",
        ruleVersion: CHART_TEMPLATE_VERSION,
        journalKind: "opening",
        entryDate: config.booksStartDate,
        currency: base[0]!.base_currency,
        exchangeRate: 1,
        memo: "Reviewed opening balances",
        controlOk: true,
        lines,
      });
      if (posted.alreadyPosted) {
        throw new FinanceError(
          "opening balances were already posted for this books start date — correct by reversal",
        );
      }
      return { entryId: posted.entryId, entryNo: posted.entryNo, offsetMinor: offset };
    },
  );
}

// ── reversing journals (accruals) ───────────────────────────────────────────

/**
 * Post an accrual now and create its dated mirror as a DRAFT — a human posts
 * the reversal (or it waits, visibly, in drafts). Nothing self-posts.
 */
export async function createReversingJournal(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ entryId: string; reversalDraftId: string }> {
  assertCan(archetype, "finance.post");
  const input = z
    .object({
      entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reversalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      memo: z.string().trim().min(1).max(1000),
      lines: z
        .array(
          z.object({
            accountId: z.string().uuid(),
            description: z.string().trim().max(500).optional(),
            debitMinor: z.number().int().min(0).default(0),
            creditMinor: z.number().int().min(0).default(0),
          }),
        )
        .min(2)
        .max(100),
    })
    .parse(raw);
  if (input.reversalDate <= input.entryDate) {
    throw new FinanceError("the reversal must be dated after the accrual");
  }
  return command(
    ctx,
    {
      audit: (r: { entryId: string }) => ({
        action: "finance.accrual.create",
        entityType: "journal_entry",
        entityId: r.entryId,
        summary: `Accrual with reversing draft dated ${input.reversalDate}`,
      }),
    },
    async (tx) => {
      const base = (await tx.execute(sql`
        select base_currency from public.org where id = ${ctx.orgId}
      `)) as unknown as Array<{ base_currency: string }>;
      const currency = base[0]!.base_currency;

      const seq1 = await allocateReference(tx, ctx, "journal_entry");
      const no1 = formatRef("JRN", seq1, 5);
      const main = (await tx.execute(sql`
        insert into public.journal_entry
          (org_id, entry_no, entry_date, journal_kind, memo, currency, base_currency, created_by)
        values (${ctx.orgId}, ${no1}, ${input.entryDate}, 'accrual', ${input.memo},
                ${currency}, ${currency}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      let n = 1;
      for (const l of input.lines) {
        await tx.execute(sql`
          insert into public.journal_line
            (org_id, entry_id, line_no, account_id, description,
             debit_minor, credit_minor, base_debit_minor, base_credit_minor)
          values (${ctx.orgId}, ${main[0]!.id}, ${n}, ${l.accountId}, ${l.description ?? null},
                  ${l.debitMinor}, ${l.creditMinor}, ${l.debitMinor}, ${l.creditMinor})
        `);
        n++;
      }
      await tx.execute(sql`select app.post_journal_entry(${main[0]!.id})`);

      const seq2 = await allocateReference(tx, ctx, "journal_entry");
      const no2 = formatRef("JRN", seq2, 5);
      const mirror = (await tx.execute(sql`
        insert into public.journal_entry
          (org_id, entry_no, entry_date, journal_kind, memo, currency, base_currency, created_by)
        values (${ctx.orgId}, ${no2}, ${input.reversalDate}, 'accrual',
                ${"Reverses accrual " + no1 + ": " + input.memo},
                ${currency}, ${currency}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      n = 1;
      for (const l of input.lines) {
        await tx.execute(sql`
          insert into public.journal_line
            (org_id, entry_id, line_no, account_id, description,
             debit_minor, credit_minor, base_debit_minor, base_credit_minor)
          values (${ctx.orgId}, ${mirror[0]!.id}, ${n}, ${l.accountId}, ${l.description ?? null},
                  ${l.creditMinor}, ${l.debitMinor}, ${l.creditMinor}, ${l.debitMinor})
        `);
        n++;
      }
      return { entryId: main[0]!.id, reversalDraftId: mirror[0]!.id };
    },
  );
}

// ── memorized / recurring templates ─────────────────────────────────────────

export async function saveJournalTemplate(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "finance.post");
  const input = z
    .object({
      name: z.string().trim().min(1).max(120),
      journalKind: z.string().default("general"),
      memo: z.string().trim().max(1000).optional(),
      lines: z.array(z.record(z.string(), z.unknown())).min(2).max(100),
      recurrence: z.enum(["monthly", "quarterly", "yearly"]).optional(),
      nextRunOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "finance.template.save",
        entityType: "journal_entry",
        entityId: r.id,
        summary: `Saved journal template ${input.name}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.journal_template
          (org_id, name, journal_kind, memo, lines, recurrence, next_run_on, created_by)
        values (${ctx.orgId}, ${input.name}, ${input.journalKind}, ${input.memo ?? null},
                ${JSON.stringify(input.lines)}::jsonb, ${input.recurrence ?? null},
                ${input.nextRunOn ?? null}, ${ctx.userId})
        on conflict (org_id, name) do update
          set journal_kind = excluded.journal_kind, memo = excluded.memo,
              lines = excluded.lines, recurrence = excluded.recurrence,
              next_run_on = excluded.next_run_on, updated_at = now()
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

/** Recurring templates whose next run is due — computed on read, no worker. */
export async function dueTemplates(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<Array<{ id: string; name: string; nextRunOn: string }>> {
  assertCan(archetype, "finance.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, next_run_on::text as next_run_on
      from public.journal_template
      where org_id = ${ctx.orgId} and active and recurrence is not null
        and next_run_on <= current_date
      order by next_run_on
      limit 100
    `),
  )) as unknown as Array<{ id: string; name: string; next_run_on: string }>;
  return rows.map((r) => ({ id: r.id, name: r.name, nextRunOn: r.next_run_on }));
}

/** Materialize a DRAFT from a template and advance its schedule. */
export async function materializeTemplate(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ entryId: string; entryNo: string }> {
  assertCan(archetype, "finance.post");
  const input = z
    .object({
      templateId: z.string().uuid(),
      entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { entryId: string; entryNo: string }) => ({
        action: "finance.template.materialize",
        entityType: "journal_entry",
        entityId: r.entryId,
        summary: `Draft ${r.entryNo} from template`,
      }),
    },
    async (tx) => {
      const t = (await tx.execute(sql`
        select name, journal_kind, memo, lines, recurrence, next_run_on::text as next_run_on
        from public.journal_template
        where id = ${input.templateId} and org_id = ${ctx.orgId} and active
        for update
      `)) as unknown as Array<Record<string, unknown>>;
      if (!t[0]) throw new FinanceError("template not found", "not_found");
      const base = (await tx.execute(sql`
        select base_currency from public.org where id = ${ctx.orgId}
      `)) as unknown as Array<{ base_currency: string }>;
      const currency = base[0]!.base_currency;
      const seq = await allocateReference(tx, ctx, "journal_entry");
      const entryNo = formatRef("JRN", seq, 5);
      const entry = (await tx.execute(sql`
        insert into public.journal_entry
          (org_id, entry_no, entry_date, journal_kind, memo, currency, base_currency, created_by)
        values (${ctx.orgId}, ${entryNo}, ${input.entryDate}, ${t[0].journal_kind as string},
                ${(t[0].memo as string | null) ?? (t[0].name as string)}, ${currency}, ${currency},
                ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const lines = t[0].lines as Array<Record<string, unknown>>;
      let n = 1;
      for (const l of lines) {
        const dm = Number(l.debitMinor ?? 0);
        const cm = Number(l.creditMinor ?? 0);
        await tx.execute(sql`
          insert into public.journal_line
            (org_id, entry_id, line_no, account_id, description,
             debit_minor, credit_minor, base_debit_minor, base_credit_minor)
          values (${ctx.orgId}, ${entry[0]!.id}, ${n}, ${l.accountId as string},
                  ${(l.description as string | null) ?? null}, ${dm}, ${cm}, ${dm}, ${cm})
        `);
        n++;
      }
      if (t[0].recurrence) {
        const next = new Date(`${t[0].next_run_on as string}T00:00:00Z`);
        const months = t[0].recurrence === "monthly" ? 1 : t[0].recurrence === "quarterly" ? 3 : 12;
        next.setUTCMonth(next.getUTCMonth() + months);
        await tx.execute(sql`
          update public.journal_template
          set next_run_on = ${next.toISOString().slice(0, 10)}, updated_at = now()
          where id = ${input.templateId} and org_id = ${ctx.orgId}
        `);
      }
      return { entryId: entry[0]!.id, entryNo };
    },
  );
}
