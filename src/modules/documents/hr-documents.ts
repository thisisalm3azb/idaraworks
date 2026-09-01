/**
 * H23F — the HR document builders: payslip, letters, register, settlement.
 *
 * Same law as every other document: ONE render model feeds preview, print and
 * PDF; an issued record (a payslip) renders from the snapshot frozen when it
 * was issued; an on-demand letter renders from live records under the current
 * identity, exactly like a draft. None of these kinds is shareable outside the
 * organization (SHAREABLE_KINDS does not include them) — pay and identity data
 * leave as a PDF a person hands over, never as a public link.
 *
 * Access: the route checks the COARSE action (hr.self for self-capable kinds);
 * each builder narrows to the caller's own employee row unless the wider
 * action also holds — the weekPlanModel precedent: the fine check lives with
 * the data.
 */
import { ForbiddenError, can } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import type { DocLanguage, DocumentRenderModel } from "@/platform/documents";
import { formatDate, formatMoney } from "@/platform/format";
import { resolveIssuer } from "./issuer-resolve";
import { DocumentNotFoundError } from "./service";

type Currency = Parameters<typeof formatMoney>[1];
const t = (language: DocLanguage, en: string, ar: string) => (language === "en" ? en : ar);
const dateLocale = (language: DocLanguage): "en" | "ar" => (language === "en" ? "en" : "ar");
const fdate = (language: DocLanguage, iso: string) =>
  formatDate(iso.slice(0, 10), { locale: dateLocale(language) });

/** The caller's own employee row id, or null when they are not an employee. */
async function ownEmployeeId(tx: TenantTx, ctx: Ctx): Promise<string | null> {
  const rows = (await tx.execute(sql`
    select id::text as id from public.employee
    where org_id = ${ctx.orgId} and user_id = ${ctx.userId}
  `)) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/** Self unless the wider action ALSO holds — the narrowing every letter uses. */
async function assertSelfOr(
  tx: TenantTx,
  ctx: Ctx,
  archetype: RoleArchetype,
  widerAction: Parameters<typeof can>[1],
  employeeId: string,
): Promise<void> {
  if (can(archetype, widerAction)) return;
  const own = await ownEmployeeId(tx, ctx);
  if (own !== employeeId) throw new ForbiddenError(widerAction);
}

type EmployeeRow = {
  id: string;
  name: string;
  name_ar: string | null;
  legal_name: string | null;
  employee_no: string | null;
  nationality: string | null;
  hire_date: string | null;
  lifecycle: string;
  end_date: string | null;
  position_name: string | null;
  position_name_ar: string | null;
  department_name: string | null;
};

async function employeeRow(tx: TenantTx, ctx: Ctx, employeeId: string): Promise<EmployeeRow> {
  const rows = (await tx.execute(sql`
    select e.id::text as id, e.name, e.name_ar, e.legal_name, e.employee_no,
           e.nationality, e.hire_date::text as hire_date, e.lifecycle,
           e.end_date::text as end_date,
           p.name_en as position_name, p.name_ar as position_name_ar,
           d.name_en as department_name
    from public.employee e
    left join public.position p on p.id = e.position_id and p.org_id = e.org_id
    left join public.department d on d.id = e.department_id and d.org_id = e.org_id
    where e.id = ${employeeId} and e.org_id = ${ctx.orgId}
  `)) as unknown as Array<EmployeeRow>;
  if (!rows[0]) throw new DocumentNotFoundError("employee", employeeId);
  return rows[0];
}

const displayName = (e: EmployeeRow, language: DocLanguage) =>
  language === "ar" && e.name_ar ? e.name_ar : (e.legal_name ?? e.name);

/** Letters address the org itself — a To-whom-it-may-concern block. */
const concernRecipient = (language: DocLanguage) => ({
  name: t(language, "To whom it may concern", "إلى من يهمه الأمر"),
});

// ── payslip ──────────────────────────────────────────────────────────────────

type PayslipComponent = {
  key: string;
  labelEn: string;
  labelAr: string;
  kind: "earning" | "deduction" | "employer_contribution";
  qty?: number;
  amountMinor: number;
};

async function payslipModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select s.id::text as id, s.slip_no, s.employee_id::text as employee_id,
             s.issuer_snapshot, s.snapshot, s.net_minor::text as net, s.currency,
             s.period_start::text as ps, s.period_end::text as pe,
             s.issued_at::text as issued_at
      from public.payslip s
      where s.id = ${id} and s.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    const row = rows[0];
    // The payslip RLS policy already hides other people's slips from the
    // unprivileged, so a stranger's id reads as not-found, not as forbidden —
    // no oracle for probing slip ids. The explicit narrow below is for the
    // privileged-but-not-cost case the policy cannot express.
    if (!row) throw new DocumentNotFoundError("payslip", id);
    if (!(can(archetype, "payroll.view") && ctx.costPrivileged)) {
      const own = await ownEmployeeId(tx, ctx);
      if (own !== (row.employee_id as string)) throw new ForbiddenError("payroll.view");
    }
    const emp = await employeeRow(tx, ctx, row.employee_id as string);
    const { issuer, notice } = await resolveIssuer(ctx, row.issuer_snapshot, true);
    const currency = row.currency as Currency;
    const money = (minor: number) => formatMoney(minor, currency, { locale: "en" });
    const snap = row.snapshot as {
      result?: { components?: PayslipComponent[] };
      packVersion?: string;
    };
    const components = snap.result?.components ?? [];
    const label = (c: PayslipComponent) => t(language, c.labelEn, c.labelAr || c.labelEn);
    const gross = components.filter((c) => c.kind === "earning");
    const deductions = components.filter((c) => c.kind === "deduction");

    return {
      kind: "payslip",
      language,
      issuer,
      recipient: { name: displayName(emp, language) },
      titleEn: "Payslip",
      titleAr: "قسيمة الراتب",
      reference: row.slip_no as string,
      dateText: fdate(language, row.issued_at as string),
      noticeText: notice,
      fields: [
        ...(emp.employee_no
          ? [{ label: t(language, "Employee no.", "الرقم الوظيفي"), value: emp.employee_no, ltr: true }]
          : []),
        {
          label: t(language, "Pay period", "فترة الراتب"),
          value: `${fdate(language, row.ps as string)} – ${fdate(language, row.pe as string)}`,
          ltr: language === "en",
        },
        ...(snap.packVersion
          ? [{ label: t(language, "Rule set", "حزمة القواعد"), value: snap.packVersion, ltr: true }]
          : []),
      ],
      sections: [
        {
          title: t(language, "Earnings", "الاستحقاقات"),
          columns: [t(language, "Description", "الوصف"), t(language, "Amount", "المبلغ")],
          lines: gross.map((c) => ({ description: label(c), amount: money(c.amountMinor) })),
          emptyText: t(language, "No earnings.", "لا توجد استحقاقات."),
        },
        {
          title: t(language, "Deductions", "الاستقطاعات"),
          columns: [t(language, "Description", "الوصف"), t(language, "Amount", "المبلغ")],
          lines: deductions.map((c) => ({ description: label(c), amount: money(c.amountMinor) })),
          emptyText: t(language, "No deductions.", "لا توجد استقطاعات."),
        },
      ],
      totals: [
        {
          label: t(language, "Total earnings", "إجمالي الاستحقاقات"),
          value: money(gross.reduce((a, c) => a + c.amountMinor, 0)),
        },
        {
          label: t(language, "Total deductions", "إجمالي الاستقطاعات"),
          value: money(deductions.reduce((a, c) => a + c.amountMinor, 0)),
        },
        { label: t(language, "Net pay", "صافي الراتب"), value: money(Number(row.net)), strong: true },
      ],
      showSignatory: false,
      showPaymentInstructions: false,
    };
  });
}

// ── salary certificate ───────────────────────────────────────────────────────

async function salaryCertificateModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  return withCtx(ctx, async (tx) => {
    await assertSelfOr(tx, ctx, archetype, "employees.view", employeeId);
    const emp = await employeeRow(tx, ctx, employeeId);
    /*
     * The certified figures come from the LATEST ISSUED PAYSLIP, not from live
     * terms: a certificate states what the employer actually pays, and the
     * payslip is the record of exactly that — self-readable under its own row
     * policy, so an employee can certify themselves without a cost-privilege
     * hole. No payslip yet → no certificate, said plainly.
     */
    const slips = (await tx.execute(sql`
      select snapshot, net_minor::text as net, currency, period_end::text as pe
      from public.payslip
      where org_id = ${ctx.orgId} and employee_id = ${employeeId}
      order by issued_at desc limit 1
    `)) as unknown as Array<Record<string, unknown>>;
    if (!slips[0]) {
      throw new DocumentNotFoundError("payslip to certify from — none issued yet for employee", employeeId);
    }
    const snap = slips[0].snapshot as { inputs?: { basicMonthlyMinor?: number } };
    const basic = snap.inputs?.basicMonthlyMinor ?? null;
    const currency = slips[0].currency as Currency;
    const money = (minor: number) => formatMoney(minor, currency, { locale: "en" });
    const { issuer } = await resolveIssuer(ctx, null, false);
    const name = displayName(emp, language);

    return {
      kind: "salary_certificate",
      language,
      issuer,
      recipient: concernRecipient(language),
      titleEn: "Salary certificate",
      titleAr: "شهادة راتب",
      reference: emp.employee_no ?? emp.id.slice(0, 8),
      dateText: fdate(language, new Date().toISOString()),
      fields: [
        { label: t(language, "Employee", "الموظف"), value: name },
        ...(emp.employee_no
          ? [{ label: t(language, "Employee no.", "الرقم الوظيفي"), value: emp.employee_no, ltr: true }]
          : []),
        ...(emp.position_name
          ? [
              {
                label: t(language, "Position", "المسمى الوظيفي"),
                value: t(language, emp.position_name, emp.position_name_ar ?? emp.position_name),
              },
            ]
          : []),
        ...(emp.hire_date
          ? [{ label: t(language, "Employed since", "تاريخ الالتحاق"), value: fdate(language, emp.hire_date) }]
          : []),
      ],
      sections: [
        {
          columns: [t(language, "Item", "البند"), t(language, "Amount", "المبلغ")],
          lines: [
            ...(basic != null
              ? [{ description: t(language, "Basic monthly salary", "الراتب الأساسي الشهري"), amount: money(basic) }]
              : []),
            {
              description: t(language, "Last net monthly pay", "آخر صافي راتب شهري"),
              amount: money(Number(slips[0].net)),
            },
          ],
          emptyText: null,
        },
      ],
      notesTitle: null,
      notes: t(
        language,
        `This is to certify that ${name} is employed by the organization named above. ` +
          `Figures are as per the most recent issued payslip (period ending ${fdate(language, slips[0].pe as string)}). ` +
          `This certificate is issued upon the employee's request and carries no further obligation.`,
        `نشهد بأن ${name} يعمل لدى المنشأة المذكورة أعلاه. الأرقام الواردة وفق آخر قسيمة راتب صادرة ` +
          `(للفترة المنتهية في ${fdate(language, slips[0].pe as string)}). صدرت هذه الشهادة بناءً على طلب الموظف دون أي التزام إضافي.`,
      ),
      showSignatory: true,
      showPaymentInstructions: false,
    };
  });
}

// ── employment contract ──────────────────────────────────────────────────────

async function employmentContractModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select c.id::text as id, c.employee_id::text as employee_id, c.contract_no,
             c.contract_type, c.start_date::text as start_date, c.end_date::text as end_date,
             c.probation_months, c.status, c.issued_at::text as issued_at,
             c.accepted_at::text as accepted_at, c.notes
      from public.employee_contract c
      where c.id = ${id} and c.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) throw new DocumentNotFoundError("employment_contract", id);
    await assertSelfOr(tx, ctx, archetype, "employees.hr.manage", row.employee_id as string);
    const emp = await employeeRow(tx, ctx, row.employee_id as string);
    const issued = row.status !== "draft";
    // Contracts carry no issuer snapshot column: they render under the current
    // identity with a draft watermark until issued (the signed copy is the
    // uploaded file; this document is the working record).
    const { issuer } = await resolveIssuer(ctx, null, false);
    const typeText: Record<string, [string, string]> = {
      fixed_term: ["Fixed term", "محدد المدة"],
      part_time_contract: ["Part time", "دوام جزئي"],
      temporary_contract: ["Temporary", "مؤقت"],
      other: ["Other", "أخرى"],
    };
    const tt = typeText[row.contract_type as string] ?? ["—", "—"];

    return {
      kind: "employment_contract",
      language,
      issuer,
      recipient: { name: displayName(emp, language) },
      titleEn: "Employment contract",
      titleAr: "عقد عمل",
      reference: row.contract_no as string,
      dateText: row.issued_at ? fdate(language, row.issued_at as string) : undefined,
      statusText: row.status as string,
      watermark: issued ? null : "draft",
      fields: [
        { label: t(language, "Contract type", "نوع العقد"), value: t(language, tt[0], tt[1]) },
        { label: t(language, "Start date", "تاريخ البدء"), value: fdate(language, row.start_date as string) },
        ...(row.end_date
          ? [{ label: t(language, "End date", "تاريخ الانتهاء"), value: fdate(language, row.end_date as string) }]
          : []),
        ...(row.probation_months != null
          ? [
              {
                label: t(language, "Probation", "فترة التجربة"),
                value: t(language, `${row.probation_months} month(s)`, `${row.probation_months} شهر`),
                ltr: language === "en",
              },
            ]
          : []),
        ...(row.accepted_at
          ? [{ label: t(language, "Accepted on", "تاريخ القبول"), value: fdate(language, row.accepted_at as string) }]
          : []),
      ],
      sections: [],
      notesTitle: t(language, "Terms", "الشروط"),
      notes:
        (row.notes as string | null) ??
        t(
          language,
          "Detailed terms as per the signed contract copy on file.",
          "التفاصيل وفق نسخة العقد الموقعة المحفوظة في الملف.",
        ),
      showSignatory: true,
      showPaymentInstructions: false,
    };
  });
}

// ── experience letter ────────────────────────────────────────────────────────

async function experienceLetterModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  return withCtx(ctx, async (tx) => {
    await assertSelfOr(tx, ctx, archetype, "employees.hr.manage", employeeId);
    const emp = await employeeRow(tx, ctx, employeeId);
    const { issuer } = await resolveIssuer(ctx, null, false);
    const name = displayName(emp, language);
    const since = emp.hire_date ? fdate(language, emp.hire_date) : t(language, "(not recorded)", "(غير مسجل)");
    const still = emp.lifecycle !== "terminated";
    const until = emp.end_date ? fdate(language, emp.end_date) : null;
    const position = emp.position_name
      ? t(language, emp.position_name, emp.position_name_ar ?? emp.position_name)
      : null;

    return {
      kind: "experience_letter",
      language,
      issuer,
      recipient: concernRecipient(language),
      titleEn: "Experience letter",
      titleAr: "شهادة خبرة",
      reference: emp.employee_no ?? emp.id.slice(0, 8),
      dateText: fdate(language, new Date().toISOString()),
      fields: [
        { label: t(language, "Employee", "الموظف"), value: name },
        ...(position ? [{ label: t(language, "Position", "المسمى الوظيفي"), value: position }] : []),
        { label: t(language, "Employed since", "تاريخ الالتحاق"), value: since },
        ...(until ? [{ label: t(language, "Employed until", "حتى تاريخ"), value: until }] : []),
      ],
      sections: [],
      notes: still
        ? t(
            language,
            `This is to certify that ${name} has been employed by the organization named above since ${since}` +
              (position ? `, in the position of ${position}` : "") +
              `. Their service continues to date. This letter is issued upon the employee's request.`,
            `نشهد بأن ${name} يعمل لدى المنشأة المذكورة أعلاه منذ ${since}` +
              (position ? ` في وظيفة ${position}` : "") +
              `. ولا يزال على رأس عمله حتى تاريخه. صدرت هذه الشهادة بناءً على طلبه.`,
          )
        : t(
            language,
            `This is to certify that ${name} was employed by the organization named above from ${since}` +
              (until ? ` until ${until}` : "") +
              (position ? `, in the position of ${position}` : "") +
              `. This letter is issued upon the employee's request.`,
            `نشهد بأن ${name} عمل لدى المنشأة المذكورة أعلاه من ${since}` +
              (until ? ` حتى ${until}` : "") +
              (position ? ` في وظيفة ${position}` : "") +
              `. صدرت هذه الشهادة بناءً على طلبه.`,
          ),
      showSignatory: true,
      showPaymentInstructions: false,
    };
  });
}

// ── warning letter ───────────────────────────────────────────────────────────

async function warningLetterModel(
  ctx: Ctx,
  _archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  // VIEW_ACTION is employees.hr.manage and the disciplinary table's own policy
  // is the owner/admin wall — the double gate is intentional for this kind.
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select d.id::text as id, d.employee_id::text as employee_id, d.kind,
             d.occurred_on::text as occurred_on, d.summary, d.detail, d.outcome,
             d.voided_at::text as voided_at
      from public.disciplinary_record d
      where d.id = ${id} and d.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) throw new DocumentNotFoundError("warning_letter", id);
    const emp = await employeeRow(tx, ctx, row.employee_id as string);
    const { issuer } = await resolveIssuer(ctx, null, false);
    const kindText: Record<string, [string, string]> = {
      verbal_warning: ["Verbal warning (recorded)", "إنذار شفهي (مسجل)"],
      written_warning: ["Written warning", "إنذار كتابي"],
      final_warning: ["Final warning", "إنذار نهائي"],
      grievance: ["Grievance record", "سجل تظلم"],
      investigation: ["Investigation record", "سجل تحقيق"],
      note: ["File note", "ملاحظة"],
    };
    const kt = kindText[row.kind as string] ?? ["Record", "سجل"];

    return {
      kind: "warning_letter",
      language,
      issuer,
      recipient: { name: displayName(emp, language) },
      titleEn: kt[0],
      titleAr: kt[1],
      reference: (row.id as string).slice(0, 8),
      dateText: fdate(language, row.occurred_on as string),
      watermark: row.voided_at ? "cancelled" : null,
      fields: [
        { label: t(language, "Employee", "الموظف"), value: displayName(emp, language) },
        ...(emp.employee_no
          ? [{ label: t(language, "Employee no.", "الرقم الوظيفي"), value: emp.employee_no, ltr: true }]
          : []),
        { label: t(language, "Date of matter", "تاريخ الواقعة"), value: fdate(language, row.occurred_on as string) },
      ],
      sections: [],
      notesTitle: t(language, "Subject", "الموضوع"),
      notes: [row.summary, row.detail, row.outcome ? `${t(language, "Outcome", "النتيجة")}: ${row.outcome}` : null]
        .filter(Boolean)
        .join("\n\n"),
      showSignatory: true,
      showPaymentInstructions: false,
    };
  });
}

// ── leave confirmation ───────────────────────────────────────────────────────

async function leaveConfirmationModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select r.id::text as id, r.employee_id::text as employee_id,
             r.start_date::text as start_date, r.end_date::text as end_date,
             r.days::text as days, r.status,
             lt.label->>'en' as type_en, lt.label->>'ar' as type_ar
      from public.leave_request r
      join public.leave_type lt on lt.id = r.leave_type_id and lt.org_id = r.org_id
      where r.id = ${id} and r.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) throw new DocumentNotFoundError("leave_confirmation", id);
    await assertSelfOr(tx, ctx, archetype, "attendance.view", row.employee_id as string);
    if (row.status !== "approved") {
      throw new DocumentNotFoundError("approved leave request", id);
    }
    const emp = await employeeRow(tx, ctx, row.employee_id as string);
    const { issuer } = await resolveIssuer(ctx, null, false);
    const typeName = t(language, row.type_en as string, (row.type_ar as string | null) ?? (row.type_en as string));

    return {
      kind: "leave_confirmation",
      language,
      issuer,
      recipient: { name: displayName(emp, language) },
      titleEn: "Leave confirmation",
      titleAr: "تأكيد إجازة",
      reference: (row.id as string).slice(0, 8),
      dateText: fdate(language, new Date().toISOString()),
      fields: [
        { label: t(language, "Employee", "الموظف"), value: displayName(emp, language) },
        { label: t(language, "Leave type", "نوع الإجازة"), value: typeName },
        { label: t(language, "From", "من"), value: fdate(language, row.start_date as string) },
        { label: t(language, "To", "إلى"), value: fdate(language, row.end_date as string) },
        { label: t(language, "Days", "الأيام"), value: String(Number(row.days)), ltr: true },
      ],
      sections: [],
      notes: t(
        language,
        "The leave above has been approved through the organization's approval process.",
        "تمت الموافقة على الإجازة المذكورة أعلاه وفق إجراءات الاعتماد المعمول بها في المنشأة.",
      ),
      showSignatory: true,
      showPaymentInstructions: false,
    };
  });
}

// ── expense claim summary ────────────────────────────────────────────────────

async function expenseClaimSummaryModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select c.id::text as id, c.employee_id::text as employee_id, c.reference, c.title,
             c.currency, c.total_minor::text as total, c.status, c.settlement_route,
             c.created_at::text as created_at
      from public.expense_claim c
      where c.id = ${id} and c.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) throw new DocumentNotFoundError("expense_claim", id);
    await assertSelfOr(tx, ctx, archetype, "expenses.view", row.employee_id as string);
    const emp = await employeeRow(tx, ctx, row.employee_id as string);
    const { issuer } = await resolveIssuer(ctx, null, false);
    const currency = row.currency as Currency;
    const money = (minor: number) => formatMoney(minor, currency, { locale: "en" });
    const lines = (await tx.execute(sql`
      select expense_date::text as d, description, amount_minor::text as amount,
             mileage_km::text as km
      from public.expense_claim_line
      where claim_id = ${id} and org_id = ${ctx.orgId}
      order by expense_date, created_at
    `)) as unknown as Array<Record<string, string | null>>;
    const statusText: Record<string, [string, string]> = {
      draft: ["Draft", "مسودة"],
      submitted: ["Submitted", "مقدَّم"],
      returned: ["Returned", "معاد"],
      approved: ["Approved", "معتمد"],
      paid: ["Paid", "مدفوع"],
      cancelled: ["Cancelled", "ملغى"],
    };
    const st = statusText[row.status as string] ?? ["—", "—"];

    return {
      kind: "expense_claim_summary",
      language,
      issuer,
      recipient: { name: displayName(emp, language) },
      titleEn: "Expense claim",
      titleAr: "مطالبة مصروفات",
      reference: row.reference as string,
      dateText: fdate(language, row.created_at as string),
      statusText: t(language, st[0], st[1]),
      watermark: ["draft", "submitted", "returned"].includes(row.status as string)
        ? "draft"
        : row.status === "cancelled"
          ? "cancelled"
          : null,
      fields: [{ label: t(language, "Title", "العنوان"), value: row.title as string }],
      sections: [
        {
          columns: [
            t(language, "Date", "التاريخ"),
            t(language, "Description", "الوصف"),
            t(language, "Amount", "المبلغ"),
          ],
          lines: lines.map((l) => ({
            position: fdate(language, l.d!),
            description: l.km ? `${l.description} (${l.km} km)` : l.description!,
            amount: money(Number(l.amount)),
          })),
          emptyText: t(language, "No lines.", "لا توجد بنود."),
        },
      ],
      totals: [
        { label: t(language, "Total", "الإجمالي"), value: money(Number(row.total)), strong: true },
      ],
      showSignatory: false,
      showPaymentInstructions: false,
    };
  });
}

// ── payroll register ─────────────────────────────────────────────────────────

async function payrollRegisterModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  runId: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  // The register lists every employee's pay: the cost wall applies in full.
  if (!ctx.costPrivileged) throw new ForbiddenError("payroll.view");
  void archetype;
  return withCtx(ctx, async (tx) => {
    const runs = (await tx.execute(sql`
      select r.reference, r.status, r.run_kind, r.currency,
             r.gross_total_minor::text as gross, r.deduction_total_minor::text as ded,
             r.net_total_minor::text as net,
             p.period_start::text as ps, p.period_end::text as pe
      from public.pay_run r
      join public.pay_period p on p.id = r.period_id and p.org_id = r.org_id
      where r.id = ${runId} and r.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    const run = runs[0];
    if (!run) throw new DocumentNotFoundError("pay_run", runId);
    const currency = run.currency as Currency;
    const money = (minor: number) => formatMoney(minor, currency, { locale: "en" });
    const { issuer } = await resolveIssuer(ctx, null, false);
    const lines = (await tx.execute(sql`
      select l.gross_minor::text as g, l.deduction_minor::text as d, l.net_minor::text as n,
             e.name, e.name_ar, e.employee_no
      from public.pay_run_line l
      join public.employee e on e.id = l.employee_id and e.org_id = l.org_id
      where l.pay_run_id = ${runId} and l.org_id = ${ctx.orgId}
      order by e.name
    `)) as unknown as Array<Record<string, string | null>>;

    return {
      kind: "payroll_register",
      language,
      issuer,
      titleEn: "Payroll register",
      titleAr: "سجل الرواتب",
      reference: run.reference as string,
      dateText: `${fdate(language, run.ps as string)} – ${fdate(language, run.pe as string)}`,
      statusText: run.status as string,
      watermark: run.status === "finalized" ? null : "draft",
      sections: [
        {
          columns: [
            t(language, "Employee", "الموظف"),
            t(language, "No.", "الرقم"),
            t(language, "Gross", "الإجمالي"),
            t(language, "Deductions", "الاستقطاعات"),
            t(language, "Net", "الصافي"),
          ],
          lines: lines.map((l) => ({
            description: language === "ar" && l.name_ar ? l.name_ar : l.name!,
            position: l.employee_no ?? "—",
            quantity: money(Number(l.g)),
            unitPrice: money(Number(l.d)),
            amount: money(Number(l.n)),
          })),
          emptyText: t(language, "No lines calculated.", "لم تُحتسب أي بنود."),
        },
      ],
      totals: [
        { label: t(language, "Gross", "الإجمالي"), value: money(Number(run.gross)) },
        { label: t(language, "Deductions", "الاستقطاعات"), value: money(Number(run.ded)) },
        { label: t(language, "Net payable", "صافي المستحق"), value: money(Number(run.net)), strong: true },
      ],
      showSignatory: true,
      showPaymentInstructions: false,
    };
  });
}

// ── final settlement (preview) ───────────────────────────────────────────────

async function finalSettlementModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  if (!ctx.costPrivileged) throw new ForbiddenError("payroll.view");
  const { previewFinalSettlement } = await import("@/modules/payroll/service");
  const preview = await previewFinalSettlement(ctx, archetype, employeeId);
  return withCtx(ctx, async (tx) => {
    const emp = await employeeRow(tx, ctx, employeeId);
    const { issuer } = await resolveIssuer(ctx, null, false);
    const orgRows = (await tx.execute(sql`
      select base_currency from public.org where id = ${ctx.orgId}
    `)) as unknown as Array<{ base_currency: string }>;
    const currency = orgRows[0]!.base_currency as Currency;
    const money = (minor: number) => formatMoney(minor, currency, { locale: "en" });

    return {
      kind: "final_settlement",
      language,
      issuer,
      recipient: { name: displayName(emp, language) },
      titleEn: "Final settlement — preview",
      titleAr: "تسوية نهائية — معاينة",
      reference: emp.employee_no ?? emp.id.slice(0, 8),
      dateText: fdate(language, new Date().toISOString()),
      // ALWAYS watermarked: this document is a working paper. The payable
      // record is the off-cycle final-settlement pay run a human confirms.
      watermark: "draft",
      noticeText: t(
        language,
        "Preview only — amounts become payable through a confirmed final-settlement pay run.",
        "معاينة فقط — تصبح المبالغ مستحقة عبر مسير تسوية نهائية معتمد.",
      ),
      fields: [
        ...(preview.packVersion
          ? [{ label: t(language, "Rule set", "حزمة القواعد"), value: preview.packVersion, ltr: true }]
          : []),
        ...(emp.hire_date
          ? [{ label: t(language, "Employed since", "تاريخ الالتحاق"), value: fdate(language, emp.hire_date) }]
          : []),
      ],
      sections: [
        {
          columns: [t(language, "Item", "البند"), t(language, "Amount / quantity", "المبلغ / الكمية")],
          lines: [
            ...(preview.gratuityMinor != null
              ? [
                  {
                    description: t(language, "End-of-service gratuity", "مكافأة نهاية الخدمة"),
                    amount: money(preview.gratuityMinor),
                  },
                ]
              : []),
            {
              description: t(language, "Unused annual leave (days)", "رصيد الإجازة السنوية (أيام)"),
              amount: String(preview.leaveEncashmentDays),
            },
            ...preview.inputs.map((i) => ({
              description: i.label,
              amount: i.amountMinor != null ? money(i.amountMinor) : (i.quantity ?? "—"),
            })),
          ],
          emptyText: t(language, "Nothing recorded.", "لا يوجد."),
        },
      ],
      showSignatory: true,
      showPaymentInstructions: false,
    };
  });
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export async function hrDocumentModel(
  ctx: Ctx,
  archetype: RoleArchetype,
  kind: string,
  id: string,
  language: DocLanguage,
): Promise<DocumentRenderModel> {
  switch (kind) {
    case "payslip":
      return payslipModel(ctx, archetype, id, language);
    case "salary_certificate":
      return salaryCertificateModel(ctx, archetype, id, language);
    case "employment_contract":
      return employmentContractModel(ctx, archetype, id, language);
    case "experience_letter":
      return experienceLetterModel(ctx, archetype, id, language);
    case "warning_letter":
      return warningLetterModel(ctx, archetype, id, language);
    case "leave_confirmation":
      return leaveConfirmationModel(ctx, archetype, id, language);
    case "expense_claim_summary":
      return expenseClaimSummaryModel(ctx, archetype, id, language);
    case "payroll_register":
      return payrollRegisterModel(ctx, archetype, id, language);
    case "final_settlement":
      return finalSettlementModel(ctx, archetype, id, language);
    default:
      throw new DocumentNotFoundError(kind, id);
  }
}
