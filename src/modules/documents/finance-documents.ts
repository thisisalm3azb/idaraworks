/**
 * H24L — the finance document builders: vouchers, statements, working papers.
 *
 * Same law as every other document: ONE render model feeds preview, print and
 * PDF. These are INTERNAL documents (none is in SHAREABLE_KINDS — books leave
 * as a PDF a person hands over, never as a public link) and render under the
 * organization's current identity, the on-demand-letter precedent from H23F.
 * Statement documents recompute from the posted ledger on every render; the
 * tax working papers render the STORED working data — exactly what the
 * reviewer saw — plus their standing disclaimer. Nothing here posts, files,
 * or claims compliance.
 *
 * Every finance read goes through @/modules/finance/service (the door); only
 * document-shaped rows (party names, tax-return headers, reconciliation
 * headers) are read here directly, the hr-documents precedent.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import type { DocLanguage, DocumentRenderModel, DocumentSection } from "@/platform/documents";
import { formatDate, formatMoney } from "@/platform/format";
import {
  journalEntryDetail,
  trialBalance,
  balanceSheet,
  profitAndLoss,
  customerStatement,
  apOpenItems,
  computeCtWorkpaper,
} from "@/modules/finance/service";
import { resolveIssuer } from "./issuer-resolve";
import { DocumentNotFoundError } from "./service";

type Currency = Parameters<typeof formatMoney>[1];
const t = (language: DocLanguage, en: string, ar: string) => (language === "en" ? en : ar);
const dateLocale = (language: DocLanguage): "en" | "ar" => (language === "en" ? "en" : "ar");
const fdate = (language: DocLanguage, iso: string) =>
  formatDate(iso.slice(0, 10), { locale: dateLocale(language) });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_RE = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/;

async function orgBaseCurrency(ctx: Ctx): Promise<Currency> {
  const rows = await withCtx(
    ctx,
    async (tx) =>
      (await tx.execute(sql`
        select base_currency from public.org where id = ${ctx.orgId}
      `)) as unknown as Array<{ base_currency: string }>,
  );
  return (rows[0]?.base_currency ?? "AED") as Currency;
}

/** Current-identity issuer — the on-demand-document rule (never a snapshot). */
async function liveIssuer(ctx: Ctx) {
  return (await resolveIssuer(ctx, null, false)).issuer;
}

const internalNotice = (language: DocLanguage) =>
  t(language, "Internal management document.", "مستند إداري داخلي.");

// ── journal voucher ──────────────────────────────────────────────────────────

async function journalVoucherModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  const e = await journalEntryDetail(ctx, archetype, id);
  const money = (minor: number) =>
    minor === 0 ? "" : formatMoney(minor, e.currency as Currency, { locale: "en" });
  return {
    kind: "journal_voucher",
    language,
    issuer: await liveIssuer(ctx),
    titleEn: "Journal voucher",
    titleAr: "سند قيد",
    reference: e.entryNo,
    dateText: fdate(language, e.entryDate),
    statusText: e.status,
    watermark: e.status === "draft" ? "draft" : e.status === "cancelled" ? "cancelled" : null,
    noticeText: internalNotice(language),
    fields: [
      { label: t(language, "Journal", "اليومية"), value: e.journalKind, ltr: true },
      ...(e.sourceType
        ? [{ label: t(language, "Source", "المصدر"), value: e.sourceType, ltr: true }]
        : []),
      ...(e.exchangeRate !== 1
        ? [
            {
              label: t(language, "Exchange rate", "سعر الصرف"),
              value: `${e.currency} @ ${e.exchangeRate}`,
              ltr: true,
            },
          ]
        : []),
    ],
    sections: [
      {
        columns: [
          "#",
          t(language, "Account", "الحساب"),
          t(language, "Debit", "مدين"),
          t(language, "Credit", "دائن"),
        ],
        lines: e.lines.map((l) => ({
          position: String(l.lineNo),
          description: `${l.accountCode} — ${
            language === "ar" && l.accountNameAr ? l.accountNameAr : l.accountNameEn
          }`,
          detail: l.description,
          unitPrice: money(l.debitMinor),
          amount: money(l.creditMinor),
        })),
        emptyText: t(language, "No lines.", "لا توجد بنود."),
      },
    ],
    totals: [
      {
        label: t(language, "Total", "الإجمالي"),
        value: formatMoney(
          e.lines.reduce((s, l) => s + l.debitMinor, 0),
          e.currency as Currency,
          { locale: "en" },
        ),
        strong: true,
      },
    ],
    notesTitle: e.memo ? t(language, "Memo", "ملاحظة") : null,
    notes: e.memo,
    showSignatory: true,
  };
}

// ── receipt / payment vouchers ───────────────────────────────────────────────

async function moneyVoucherModel(
  ctx: Ctx,
  kind: "receipt_voucher" | "payment_voucher",
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  const rows = await withCtx(
    ctx,
    async (tx) =>
      (await tx.execute(sql`
        select m.reference, m.kind, m.txn_date::text as d, m.amount_minor::text as amount,
               m.currency, m.memo, m.cheque_no, m.cheque_due_on::text as cheque_due,
               m.status, b.name as bank_name,
               coalesce(c.name, s.name, emp.name) as party_name
        from public.money_transaction m
        join public.bank_account b on b.id = m.bank_account_id and b.org_id = m.org_id
        left join public.customer c on c.id = m.customer_id and c.org_id = m.org_id
        left join public.supplier s on s.id = m.supplier_id and s.org_id = m.org_id
        left join public.employee emp on emp.id = m.employee_id and emp.org_id = m.org_id
        where m.id = ${id} and m.org_id = ${ctx.orgId}
      `)) as unknown as Array<Record<string, string | null>>,
  );
  const m = rows[0];
  if (!m) throw new DocumentNotFoundError(kind, id);
  const inbound = m.kind === "receipt" || m.kind === "bank_interest";
  if ((kind === "receipt_voucher") !== inbound) throw new DocumentNotFoundError(kind, id);
  const amount = formatMoney(Number(m.amount), m.currency as Currency, { locale: "en" });
  return {
    kind,
    language,
    issuer: await liveIssuer(ctx),
    recipient: m.party_name ? { name: m.party_name } : null,
    titleEn: inbound ? "Receipt voucher" : "Payment voucher",
    titleAr: inbound ? "سند قبض" : "سند صرف",
    reference: m.reference!,
    dateText: fdate(language, m.d!),
    statusText: m.status!,
    watermark: m.status === "void" ? "void" : null,
    noticeText: internalNotice(language),
    fields: [
      { label: t(language, "Bank account", "الحساب البنكي"), value: m.bank_name!, ltr: true },
      { label: t(language, "Type", "النوع"), value: m.kind!, ltr: true },
      ...(m.cheque_no
        ? [{ label: t(language, "Cheque no.", "رقم الشيك"), value: m.cheque_no, ltr: true }]
        : []),
      ...(m.cheque_due
        ? [
            {
              label: t(language, "Cheque due", "استحقاق الشيك"),
              value: fdate(language, m.cheque_due),
              ltr: true,
            },
          ]
        : []),
    ],
    sections: [
      {
        columns: [t(language, "Description", "الوصف"), t(language, "Amount", "المبلغ")],
        lines: [
          {
            description:
              m.memo ??
              t(
                language,
                inbound ? "Money received" : "Money paid",
                inbound ? "مبلغ مستلم" : "مبلغ مدفوع",
              ),
            amount,
          },
        ],
        emptyText: null,
      },
    ],
    totals: [{ label: t(language, "Amount", "المبلغ"), value: amount, strong: true }],
    showSignatory: true,
  };
}

// ── party statements ─────────────────────────────────────────────────────────

async function customerStatementModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  const rows = await withCtx(
    ctx,
    async (tx) =>
      (await tx.execute(sql`
        select name, tax_reg_no from public.customer
        where id = ${id} and org_id = ${ctx.orgId}
      `)) as unknown as Array<{ name: string; tax_reg_no: string | null }>,
  );
  if (!rows[0]) throw new DocumentNotFoundError("customer_statement", id);
  const currency = await orgBaseCurrency(ctx);
  const money = (minor: number) =>
    minor === 0 ? "" : formatMoney(minor, currency, { locale: "en" });
  const st = await customerStatement(ctx, archetype, { customerId: id });
  const today = new Date().toISOString().slice(0, 10);
  return {
    kind: "customer_statement",
    language,
    issuer: await liveIssuer(ctx),
    recipient: { name: rows[0].name, trn: rows[0].tax_reg_no },
    titleEn: "Statement of account",
    titleAr: "كشف حساب",
    reference: `SOA ${today}`,
    dateText: fdate(language, today),
    noticeText: internalNotice(language),
    sections: [
      {
        columns: [
          t(language, "Date", "التاريخ"),
          t(language, "Document", "المستند"),
          t(language, "Debit", "مدين"),
          t(language, "Credit", "دائن"),
          t(language, "Balance", "الرصيد"),
        ],
        lines: st.rows.map((r) => ({
          position: fdate(language, r.date),
          description: r.reference,
          detail: r.kind,
          quantity: money(r.debitMinor),
          unitPrice: money(r.creditMinor),
          amount: formatMoney(r.balanceMinor, currency, { locale: "en" }),
        })),
        emptyText: t(language, "No transactions.", "لا توجد حركات."),
      },
    ],
    totals: [
      {
        label: t(language, "Balance due", "الرصيد المستحق"),
        value: formatMoney(st.closingMinor, currency, { locale: "en" }),
        strong: true,
      },
    ],
    showSignatory: false,
  };
}

async function supplierStatementModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  const rows = await withCtx(
    ctx,
    async (tx) =>
      (await tx.execute(sql`
        select name, tax_reg_no from public.supplier
        where id = ${id} and org_id = ${ctx.orgId}
      `)) as unknown as Array<{ name: string; tax_reg_no: string | null }>,
  );
  if (!rows[0]) throw new DocumentNotFoundError("supplier_statement", id);
  const currency = await orgBaseCurrency(ctx);
  const open = (await apOpenItems(ctx, archetype, { supplierId: id })).filter(
    (o) => o.supplierId === id,
  );
  const money = (minor: number) => formatMoney(minor, currency, { locale: "en" });
  const today = new Date().toISOString().slice(0, 10);
  return {
    kind: "supplier_statement",
    language,
    issuer: await liveIssuer(ctx),
    recipient: { name: rows[0].name, trn: rows[0].tax_reg_no },
    titleEn: "Supplier statement — open items",
    titleAr: "كشف مورد — بنود مفتوحة",
    reference: `SUP ${today}`,
    dateText: fdate(language, today),
    noticeText: internalNotice(language),
    sections: [
      {
        columns: [
          t(language, "Received", "تاريخ الاستلام"),
          t(language, "Goods receipt", "سند الاستلام"),
          t(language, "Value", "القيمة"),
          t(language, "Settled", "المسدد"),
          t(language, "Outstanding", "المتبقي"),
        ],
        lines: open.map((o) => ({
          position: fdate(language, o.receivedOn),
          description: o.reference,
          quantity: money(o.valueMinor),
          unitPrice: money(o.settledMinor),
          amount: money(o.outstandingMinor),
        })),
        emptyText: t(language, "Nothing outstanding.", "لا توجد مستحقات."),
      },
    ],
    totals: [
      {
        label: t(language, "Total outstanding", "إجمالي المستحق"),
        value: money(open.reduce((s, o) => s + o.outstandingMinor, 0)),
        strong: true,
      },
    ],
    showSignatory: false,
  };
}

// ── statement documents (trial balance, balance sheet, P&L) ──────────────────

async function trialBalanceModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  if (!DATE_RE.test(id)) throw new DocumentNotFoundError("trial_balance", id);
  const currency = await orgBaseCurrency(ctx);
  const tb = await trialBalance(ctx, archetype, { to: id });
  const money = (minor: number) =>
    minor === 0 ? "" : formatMoney(minor, currency, { locale: "en" });
  return {
    kind: "trial_balance",
    language,
    issuer: await liveIssuer(ctx),
    titleEn: "Trial balance",
    titleAr: "ميزان المراجعة",
    reference: `TB ${id}`,
    dateText: fdate(language, id),
    noticeText: internalNotice(language),
    sections: [
      {
        columns: [
          t(language, "Code", "الرمز"),
          t(language, "Account", "الحساب"),
          t(language, "Debit", "مدين"),
          t(language, "Credit", "دائن"),
        ],
        lines: tb.rows.map((r) => ({
          position: r.code,
          description: language === "ar" && r.nameAr ? r.nameAr : r.nameEn,
          unitPrice: money(r.debitMinor),
          amount: money(r.creditMinor),
        })),
        emptyText: t(language, "No posted activity.", "لا توجد حركات مرحّلة."),
      },
    ],
    totals: [
      {
        label: t(language, "Total debits", "إجمالي المدين"),
        value: formatMoney(tb.totalDebitMinor, currency, { locale: "en" }),
      },
      {
        label: t(language, "Total credits", "إجمالي الدائن"),
        value: formatMoney(tb.totalCreditMinor, currency, { locale: "en" }),
        strong: true,
      },
    ],
    showSignatory: false,
  };
}

function statementSectionToDoc(
  language: DocLanguage,
  title: string,
  rows: Array<{ code: string; nameEn: string; nameAr: string | null; amountMinor: number }>,
  money: (minor: number) => string,
  emptyText: string,
): DocumentSection {
  return {
    title,
    columns: [
      t(language, "Code", "الرمز"),
      t(language, "Account", "الحساب"),
      t(language, "Amount", "المبلغ"),
    ],
    lines: rows.map((r) => ({
      position: r.code,
      description: language === "ar" && r.nameAr ? r.nameAr : r.nameEn,
      amount: money(r.amountMinor),
    })),
    emptyText,
  };
}

async function balanceSheetModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  if (!DATE_RE.test(id)) throw new DocumentNotFoundError("balance_sheet", id);
  const currency = await orgBaseCurrency(ctx);
  const bs = await balanceSheet(ctx, archetype, { asOf: id });
  const money = (minor: number) => formatMoney(minor, currency, { locale: "en" });
  const empty = t(language, "Nothing recorded.", "لا يوجد.");
  return {
    kind: "balance_sheet",
    language,
    issuer: await liveIssuer(ctx),
    titleEn: "Balance sheet (management)",
    titleAr: "الميزانية العمومية (إدارية)",
    reference: `BS ${id}`,
    dateText: fdate(language, id),
    noticeText: internalNotice(language),
    sections: [
      statementSectionToDoc(
        language,
        t(language, "Assets", "الأصول"),
        bs.assets.rows,
        money,
        empty,
      ),
      statementSectionToDoc(
        language,
        t(language, "Liabilities", "الالتزامات"),
        bs.liabilities.rows,
        money,
        empty,
      ),
      statementSectionToDoc(
        language,
        t(language, "Equity", "حقوق الملكية"),
        bs.equity.rows,
        money,
        empty,
      ),
    ],
    totals: [
      { label: t(language, "Total assets", "إجمالي الأصول"), value: money(bs.assets.totalMinor) },
      {
        label: t(language, "Liabilities + equity", "الالتزامات وحقوق الملكية"),
        value: money(bs.liabilities.totalMinor + bs.equity.totalMinor),
        strong: true,
      },
    ],
    showSignatory: false,
  };
}

async function profitLossModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  const m = RANGE_RE.exec(id);
  if (!m) throw new DocumentNotFoundError("profit_loss", id);
  const currency = await orgBaseCurrency(ctx);
  const pl = await profitAndLoss(ctx, archetype, { from: m[1]!, to: m[2]! });
  const money = (minor: number) => formatMoney(minor, currency, { locale: "en" });
  const empty = t(language, "Nothing recorded.", "لا يوجد.");
  return {
    kind: "profit_loss",
    language,
    issuer: await liveIssuer(ctx),
    titleEn: "Profit and loss (management)",
    titleAr: "الأرباح والخسائر (إداري)",
    reference: `PL ${m[1]} to ${m[2]}`,
    dateText: `${fdate(language, m[1]!)} — ${fdate(language, m[2]!)}`,
    noticeText: internalNotice(language),
    sections: [
      statementSectionToDoc(
        language,
        t(language, "Income", "الإيرادات"),
        pl.income.rows,
        money,
        empty,
      ),
      statementSectionToDoc(
        language,
        t(language, "Expenses", "المصروفات"),
        pl.expenses.rows,
        money,
        empty,
      ),
    ],
    totals: [
      { label: t(language, "Income", "الإيرادات"), value: money(pl.income.totalMinor) },
      { label: t(language, "Expenses", "المصروفات"), value: money(pl.expenses.totalMinor) },
      {
        label: t(language, "Net profit", "صافي الربح"),
        value: money(pl.netProfitMinor),
        strong: true,
      },
    ],
    showSignatory: false,
  };
}

// ── tax working papers ───────────────────────────────────────────────────────

type StoredVatWorking = {
  boxes?: Record<string, { label: string; baseMinor: number; taxMinor: number }>;
  totals?: { outputTaxMinor?: number; inputTaxMinor?: number; netPayableMinor?: number };
  reconciliation?: { outputDriftMinor?: number; inputDriftMinor?: number };
  exceptions?: Array<{ sourceType: string; reference: string; reason: string }>;
  disclaimer?: string;
};

async function taxReturnRow(ctx: Ctx, id: string, taxType: "vat" | "corporate") {
  const rows = await withCtx(
    ctx,
    async (tx) =>
      (await tx.execute(sql`
        select reference, period_start::text as ps, period_end::text as pe,
               pack_version, status, working
        from public.tax_return
        where id = ${id} and org_id = ${ctx.orgId} and tax_type = ${taxType}
      `)) as unknown as Array<{
        reference: string;
        ps: string;
        pe: string;
        pack_version: string;
        status: string;
        working: unknown;
      }>,
  );
  if (!rows[0])
    throw new DocumentNotFoundError(taxType === "vat" ? "vat_working" : "ct_workpaper", id);
  return rows[0];
}

async function vatWorkingModel(
  ctx: Ctx,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  const ret = await taxReturnRow(ctx, id, "vat");
  const w = ret.working as StoredVatWorking;
  const currency = await orgBaseCurrency(ctx);
  const money = (minor: number) => formatMoney(minor, currency, { locale: "en" });
  const boxes = Object.entries(w.boxes ?? {}).sort(([a], [b]) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
  const exceptions = w.exceptions ?? [];
  const sections: DocumentSection[] = [
    {
      title: t(language, "VAT201 boxes", "خانات الإقرار VAT201"),
      columns: [
        t(language, "Box", "الخانة"),
        t(language, "Description", "الوصف"),
        t(language, "Amount", "المبلغ"),
        t(language, "VAT", "الضريبة"),
      ],
      lines: boxes.map(([key, b]) => ({
        position: key,
        description: b.label,
        unitPrice: money(b.baseMinor),
        amount: money(b.taxMinor),
      })),
      emptyText: t(language, "No classified activity.", "لا توجد حركات مصنّفة."),
    },
  ];
  if (exceptions.length > 0) {
    sections.push({
      title: t(language, "Exceptions — needs classification", "استثناءات — تحتاج تصنيفاً"),
      columns: [t(language, "Document", "المستند"), t(language, "Reason", "السبب")],
      lines: exceptions.map((e) => ({
        position: e.reference,
        description: e.reason,
      })),
      emptyText: null,
    });
  }
  return {
    kind: "vat_working",
    language,
    issuer: await liveIssuer(ctx),
    titleEn: "VAT return working paper",
    titleAr: "ورقة عمل إقرار ضريبة القيمة المضافة",
    reference: ret.reference,
    dateText: `${fdate(language, ret.ps)} — ${fdate(language, ret.pe)}`,
    statusText: ret.status,
    watermark: ret.status === "draft" || ret.status === "under_review" ? "draft" : null,
    fields: [
      { label: t(language, "Rule pack", "حزمة القواعد"), value: ret.pack_version, ltr: true },
      {
        label: t(language, "Control drift", "انحراف الرقابة"),
        value: `${w.reconciliation?.outputDriftMinor ?? 0} / ${w.reconciliation?.inputDriftMinor ?? 0}`,
        ltr: true,
      },
    ],
    sections,
    totals: [
      {
        label: t(language, "Output tax", "ضريبة المخرجات"),
        value: money(w.totals?.outputTaxMinor ?? 0),
      },
      {
        label: t(language, "Recoverable input tax", "ضريبة المدخلات القابلة للاسترداد"),
        value: money(w.totals?.inputTaxMinor ?? 0),
      },
      {
        label: t(language, "Net payable", "صافي المستحق"),
        value: money(w.totals?.netPayableMinor ?? 0),
        strong: true,
      },
    ],
    termsTitle: t(language, "Notice", "تنبيه"),
    terms:
      w.disclaimer ??
      "Working paper only — prepared for review; IdaraWorks does not file returns or guarantee compliance.",
    showSignatory: true,
  };
}

async function ctWorkpaperModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  const ret = await taxReturnRow(ctx, id, "corporate");
  const c = await computeCtWorkpaper(ctx, archetype, id);
  const currency = await orgBaseCurrency(ctx);
  const money = (minor: number) => formatMoney(minor, currency, { locale: "en" });
  const w = ret.working as { disclaimer?: string };
  return {
    kind: "ct_workpaper",
    language,
    issuer: await liveIssuer(ctx),
    titleEn: "Corporate tax workpaper",
    titleAr: "ورقة عمل ضريبة الشركات",
    reference: ret.reference,
    dateText: `${fdate(language, ret.ps)} — ${fdate(language, ret.pe)}`,
    statusText: ret.status,
    watermark: ret.status === "draft" || ret.status === "under_review" ? "draft" : null,
    fields: [
      { label: t(language, "Rule pack", "حزمة القواعد"), value: ret.pack_version, ltr: true },
      {
        label: t(language, "Small business relief", "إعفاء الأعمال الصغيرة"),
        value: c.sbrApplied
          ? t(language, "Elected and applied", "تم اختياره وتطبيقه")
          : t(language, "Not elected", "لم يُختر"),
      },
    ],
    sections: [
      {
        title: t(language, "Adjustments to accounting income", "تعديلات على الدخل المحاسبي"),
        columns: [
          t(language, "Rule", "القاعدة"),
          t(language, "Adjustment", "التعديل"),
          t(language, "Amount", "المبلغ"),
        ],
        lines: c.adjustments.map((a) => ({
          position: a.direction === "add" ? "+" : "−",
          description: a.label,
          detail: `${a.calculation} — ${a.legalSource}`,
          amount: money(a.adjustmentMinor),
        })),
        emptyText: t(language, "No adjustments recorded.", "لا توجد تعديلات."),
      },
    ],
    totals: [
      {
        label: t(language, "Accounting income", "الدخل المحاسبي"),
        value: money(c.accountingIncomeMinor),
      },
      { label: t(language, "Additions", "الإضافات"), value: money(c.additionsMinor) },
      { label: t(language, "Deductions", "الخصومات"), value: money(c.deductionsMinor) },
      { label: t(language, "Taxable income", "الدخل الخاضع"), value: money(c.taxableIncomeMinor) },
      {
        label: t(language, "Corporate tax", "ضريبة الشركات"),
        value: money(c.taxMinor),
        strong: true,
      },
    ],
    termsTitle: t(language, "Notice", "تنبيه"),
    terms:
      w.disclaimer ??
      "Working paper only — begins from ledger accounting profit; requires professional review; nothing is filed.",
    showSignatory: true,
  };
}

// ── bank reconciliation summary ──────────────────────────────────────────────

async function bankReconSummaryModel(
  ctx: Ctx,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  const data = await withCtx(ctx, async (tx) => {
    const recon = (await tx.execute(sql`
      select r.label, r.status, r.started_at::date::text as started,
             r.completed_at::date::text as completed, r.notes,
             r.statement_closing_minor::text as closing, b.name as bank_name, b.currency
      from public.bank_reconciliation r
      join public.bank_account b on b.id = r.bank_account_id and b.org_id = r.org_id
      where r.id = ${id} and r.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, string | null>>;
    if (!recon[0]) throw new DocumentNotFoundError("bank_recon_summary", id);
    const matches = (await tx.execute(sql`
      select sl.txn_date::text as d, sl.description, m.amount_minor::text as amount,
             e.entry_no
      from public.bank_match m
      join public.bank_statement_line sl
        on sl.id = m.statement_line_id and sl.org_id = m.org_id
      join public.journal_line jl on jl.id = m.journal_line_id and jl.org_id = m.org_id
      join public.journal_entry e on e.id = jl.entry_id and e.org_id = jl.org_id
      where m.reconciliation_id = ${id} and m.org_id = ${ctx.orgId} and m.voided_at is null
      order by sl.txn_date
    `)) as unknown as Array<Record<string, string | null>>;
    return { recon: recon[0], matches };
  });
  const currency = (data.recon.currency ?? "AED") as Currency;
  const money = (minor: number) => formatMoney(minor, currency, { locale: "en" });
  return {
    kind: "bank_recon_summary",
    language,
    issuer: await liveIssuer(ctx),
    titleEn: "Bank reconciliation summary",
    titleAr: "ملخص التسوية البنكية",
    reference: data.recon.label!,
    dateText: fdate(language, data.recon.completed ?? data.recon.started!),
    statusText: data.recon.status!,
    watermark: data.recon.status === "in_progress" ? "draft" : null,
    noticeText: internalNotice(language),
    fields: [
      {
        label: t(language, "Bank account", "الحساب البنكي"),
        value: data.recon.bank_name!,
        ltr: true,
      },
      ...(data.recon.closing
        ? [
            {
              label: t(language, "Statement closing", "رصيد الكشف الختامي"),
              value: money(Number(data.recon.closing)),
              ltr: true,
            },
          ]
        : []),
      {
        label: t(language, "Matched lines", "البنود المطابقة"),
        value: String(data.matches.length),
        ltr: true,
      },
    ],
    sections: [
      {
        title: t(language, "Matched statement lines", "بنود الكشف المطابقة"),
        columns: [
          t(language, "Date", "التاريخ"),
          t(language, "Description", "الوصف"),
          t(language, "Journal", "القيد"),
          t(language, "Amount", "المبلغ"),
        ],
        lines: data.matches.map((m) => ({
          position: fdate(language, m.d!),
          description: m.description ?? "",
          state: m.entry_no,
          amount: money(Number(m.amount)),
        })),
        emptyText: t(language, "No matches yet.", "لا توجد مطابقات بعد."),
      },
    ],
    notesTitle: data.recon.notes ? t(language, "Notes", "ملاحظات") : null,
    notes: data.recon.notes,
    showSignatory: true,
  };
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export async function financeDocumentModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  kind: string,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  switch (kind) {
    case "journal_voucher":
      return journalVoucherModel(ctx, archetype, id, language);
    case "receipt_voucher":
    case "payment_voucher":
      return moneyVoucherModel(ctx, kind, id, language);
    case "customer_statement":
      return customerStatementModel(ctx, archetype, id, language);
    case "supplier_statement":
      return supplierStatementModel(ctx, archetype, id, language);
    case "trial_balance":
      return trialBalanceModel(ctx, archetype, id, language);
    case "balance_sheet":
      return balanceSheetModel(ctx, archetype, id, language);
    case "profit_loss":
      return profitLossModel(ctx, archetype, id, language);
    case "vat_working":
      return vatWorkingModel(ctx, id, language);
    case "ct_workpaper":
      return ctWorkpaperModel(ctx, archetype, id, language);
    case "bank_recon_summary":
      return bankReconSummaryModel(ctx, id, language);
    default:
      throw new DocumentNotFoundError(kind, id);
  }
}
