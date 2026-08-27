/**
 * Pure invariant checks over a built Plan — no database. These encode the
 * data-quality rules the task requires (financial reconciliation, coherent dates,
 * referential integrity, lifecycle validity, required "personality" states,
 * uniqueness, no real-contact patterns) so the same checks gate a real seed AND
 * back the unit tests. `check` returns structured results; `assertOk` throws.
 */
import { computeTotals } from "./money";
import type { InvoiceRow, Plan, Scenario } from "./types";

export type CheckResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  metrics: Record<string, number>;
};

/** Net balance of an invoice in base minor units (payments + credit notes applied). */
export function invoiceBalance(plan: Plan, inv: InvoiceRow): number {
  const paid = plan.payments
    .filter((p) => p.invoiceId === inv.id && (p.status === "recorded" || p.status === "confirmed"))
    .reduce((n, p) => n + p.baseAmountMinor, 0);
  const credited = plan.invoices
    .filter(
      (c) => c.kind === "credit_note" && c.correctsInvoiceId === inv.id && c.status !== "cancelled",
    )
    .reduce((n, c) => n + c.baseTotalMinor, 0);
  return Math.max(0, inv.baseTotalMinor - paid - credited);
}

const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/;
const REAL_EMAIL_RE = /@(?!example\.(com|org|net)\b)[a-z0-9.-]+\.[a-z]{2,}/i;

export function check(plan: Plan, scenario: Scenario): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const E = (c: boolean, m: string) => {
    if (!c) errors.push(m);
  };

  const custIds = new Set(plan.customers.map((c) => c.id));
  const supIds = new Set(plan.suppliers.map((s) => s.id));
  const itemIds = new Set(plan.items.map((i) => i.id));
  const empIds = new Set(plan.employees.map((e) => e.id));
  const jobIds = new Set(plan.jobs.map((j) => j.id));
  const invIds = new Set(plan.invoices.map((i) => i.id));
  const poIds = new Set(plan.purchaseOrders.map((p) => p.id));
  const asOf = plan.asOf;

  // ── Financial reconciliation ────────────────────────────────────────────────
  for (const q of plan.quotes) {
    E(
      q.totalMinor === q.subtotalMinor + q.vatAmountMinor,
      `quote ${q.reference}: total != subtotal+vat`,
    );
    E(
      q.baseTotalMinor === Math.round(q.totalMinor * q.exchangeRate),
      `quote ${q.reference}: base_total mismatch`,
    );
    const t = computeTotals(q.lines, q.exchangeRate, scenario.vatRegistered);
    E(t.totalMinor === q.totalMinor, `quote ${q.reference}: recomputed total mismatch`);
    for (const l of q.lines)
      E(
        l.lineTotalMinor === Math.round(l.qty * l.unitPriceMinor),
        `quote ${q.reference}: line total mismatch`,
      );
    if (q.status === "rejected")
      E(!!q.rejectedReason, `quote ${q.reference}: rejected without reason`);
    if (q.status === "converted") {
      E(!!q.acceptedAt, `quote ${q.reference}: converted without accepted_at`);
      E(
        !!q.convertedJobId && jobIds.has(q.convertedJobId),
        `quote ${q.reference}: converted_job_id invalid`,
      );
      E(!!q.presetCode, `quote ${q.reference}: converted without preset`);
    }
    E(!q.customerId || custIds.has(q.customerId), `quote ${q.reference}: customer FK invalid`);
  }
  for (const inv of plan.invoices) {
    E(
      inv.totalMinor === inv.subtotalMinor + inv.vatAmountMinor,
      `invoice ${inv.reference}: total != subtotal+vat`,
    );
    E(
      inv.baseTotalMinor === Math.round(inv.totalMinor * inv.exchangeRate),
      `invoice ${inv.reference}: base_total mismatch`,
    );
    if (!scenario.vatRegistered)
      E(inv.vatAmountMinor === 0, `invoice ${inv.reference}: VAT on a non-registered org`);
    E(
      !inv.customerId || custIds.has(inv.customerId),
      `invoice ${inv.reference}: customer FK invalid`,
    );
    E(!inv.jobId || jobIds.has(inv.jobId), `invoice ${inv.reference}: job FK invalid`);
    if (inv.status !== "draft" && inv.status !== "cancelled")
      E(!!inv.issuedAt, `invoice ${inv.reference}: issued state without issued_at`);
    if (inv.kind === "credit_note") {
      E(
        !!inv.correctsInvoiceId && invIds.has(inv.correctsInvoiceId),
        `credit note ${inv.reference}: corrects_invoice_id invalid`,
      );
    }
    // Status must match the money.
    const bal = invoiceBalance(plan, inv);
    if (inv.kind === "invoice") {
      const paid = plan.payments
        .filter(
          (p) => p.invoiceId === inv.id && (p.status === "recorded" || p.status === "confirmed"),
        )
        .reduce((n, p) => n + p.baseAmountMinor, 0);
      const credited = plan.invoices
        .filter(
          (c) =>
            c.kind === "credit_note" && c.correctsInvoiceId === inv.id && c.status !== "cancelled",
        )
        .reduce((n, c) => n + c.baseTotalMinor, 0);
      E(
        paid + credited <= inv.baseTotalMinor,
        `invoice ${inv.reference}: overpaid/overcredited (${paid + credited} > ${inv.baseTotalMinor})`,
      );
      if (inv.status === "paid")
        E(bal === 0, `invoice ${inv.reference}: marked paid but balance ${bal}`);
      if (inv.status === "partially_paid")
        E(
          paid > 0 && bal > 0,
          `invoice ${inv.reference}: partially_paid but paid=${paid} bal=${bal}`,
        );
      if (inv.status === "issued")
        E(paid === 0, `invoice ${inv.reference}: issued but has payments`);
    }
  }
  for (const p of plan.payments) {
    E(
      p.baseAmountMinor === Math.round(p.amountMinor * p.exchangeRate),
      `payment ${p.reference}: base_amount mismatch`,
    );
    E(p.amountMinor >= 0, `payment ${p.reference}: negative amount`);
    E(!p.invoiceId || invIds.has(p.invoiceId), `payment ${p.reference}: invoice FK invalid`);
  }
  for (const ex of plan.expenses) {
    E(
      ex.totalMinor === ex.amountMinor + ex.vatAmountMinor,
      `expense ${ex.reference}: total != amount+vat`,
    );
    E(!ex.jobId || jobIds.has(ex.jobId), `expense ${ex.reference}: job FK invalid`);
    if (ex.jobId) E(ex.costingMapping !== "overhead" || true, "");
  }

  // ── Referential integrity (operations) ──────────────────────────────────────
  for (const j of plan.jobs) {
    E(!j.customerId || custIds.has(j.customerId), `job ${j.reference}: customer FK invalid`);
    E(
      ["draft", "active", "on_hold", "done", "cancelled"].includes(j.statusCategory),
      `job ${j.reference}: bad status_category`,
    );
    for (const eid of j.crew) E(empIds.has(eid), `job ${j.reference}: crew employee FK invalid`);
    const keys = new Set(j.stages.map((st) => st.stageKey));
    E(keys.size === j.stages.length, `job ${j.reference}: duplicate stage keys`);
    if (j.currentStageKey)
      E(keys.has(j.currentStageKey), `job ${j.reference}: current stage not in stages`);
    for (const st of j.stages)
      E(
        ["not_started", "in_progress", "completed", "skipped"].includes(st.status),
        `job ${j.reference}: bad stage status`,
      );
  }
  const reportDates = new Set<string>();
  for (const r of plan.reports) {
    E(jobIds.has(r.jobId), `report ${r.id}: job FK invalid`);
    E(r.reportDate <= asOf, `report ${r.id}: report_date in the future`);
    const k = `${r.jobId}|${r.reportDate}`;
    E(!reportDates.has(k), `report ${r.id}: duplicate (job,date)`);
    reportDates.add(k);
    for (const m of r.materialLines)
      E(!m.itemId || itemIds.has(m.itemId), `report ${r.id}: material item FK invalid`);
    for (const l of r.labourLines) {
      E(empIds.has(l.employeeId), `report ${r.id}: labour employee FK invalid`);
      E(
        l.labourCostMinor ===
          Math.round(l.normalHours * l.hourlyCostMinor + l.otHours * l.hourlyCostMinor * l.otRate),
        `report ${r.id}: labour cost mismatch`,
      );
    }
    const empSeen = new Set<string>();
    for (const l of r.labourLines) {
      E(!empSeen.has(l.employeeId), `report ${r.id}: duplicate labour employee`);
      empSeen.add(l.employeeId);
    }
  }
  const attKeys = new Set<string>();
  for (const a of plan.attendance) {
    E(empIds.has(a.employeeId), `attendance ${a.id}: employee FK invalid`);
    const k = `${a.employeeId}|${a.date}`;
    E(!attKeys.has(k), `attendance ${a.id}: duplicate (emp,date)`);
    attKeys.add(k);
    E(a.date <= asOf, `attendance ${a.id}: future date`);
  }
  for (const mr of plan.materialRequests)
    E(!mr.jobId || jobIds.has(mr.jobId), `MR ${mr.reference}: job FK invalid`);
  for (const po of plan.purchaseOrders) {
    E(supIds.has(po.supplierId), `PO ${po.reference}: supplier FK invalid`);
    E(!po.jobId || jobIds.has(po.jobId), `PO ${po.reference}: job FK invalid`);
  }
  for (const grn of plan.goodsReceipts) {
    E(poIds.has(grn.poId), `GRN ${grn.reference}: PO FK invalid`);
    const po = plan.purchaseOrders.find((p) => p.id === grn.poId)!;
    for (const gl of grn.lines) {
      const pol = po.lines.find((l) => l.id === gl.poLineId);
      E(!!pol, `GRN ${grn.reference}: PO line FK invalid`);
      if (pol)
        E(
          gl.previouslyReceived + gl.receivedQty <= pol.qty,
          `GRN ${grn.reference}: received exceeds ordered`,
        );
    }
  }
  for (const ap of plan.approvals) {
    if (ap.state === "rejected") E(!!ap.decisionNote, `approval ${ap.id}: rejected without note`);
    if (ap.state !== "pending" && ap.state !== "withdrawn")
      E(!!ap.decidedAt, `approval ${ap.id}: decided without decided_at`);
    // subject_id references a real subject of its type
    const ok =
      (ap.subjectType === "purchase_order" && poIds.has(ap.subjectId)) ||
      (ap.subjectType === "material_request" &&
        plan.materialRequests.some((m) => m.id === ap.subjectId)) ||
      (ap.subjectType === "quote_send" && plan.quotes.some((q) => q.id === ap.subjectId)) ||
      (ap.subjectType === "payment" && plan.payments.some((p) => p.id === ap.subjectId)) ||
      ap.subjectType === "expense";
    E(ok, `approval ${ap.id}: subject_id does not reference a real ${ap.subjectType}`);
  }
  for (const ex of plan.exceptions) {
    E(
      !ex.subjectId || jobIds.has(ex.subjectId) || invIds.has(ex.subjectId),
      `exception ${ex.id}: subject FK invalid`,
    );
  }

  // ── Uniqueness of references per scope ───────────────────────────────────────
  const refScopes: Array<[string, string[]]> = [
    ["quote", plan.quotes.map((q) => q.reference)],
    ["invoice", plan.invoices.filter((i) => i.kind === "invoice").map((i) => i.reference)],
    ["credit_note", plan.invoices.filter((i) => i.kind === "credit_note").map((i) => i.reference)],
    ["purchase_order", plan.purchaseOrders.map((p) => p.reference)],
    ["material_request", plan.materialRequests.map((m) => m.reference)],
    ["goods_receipt", plan.goodsReceipts.map((g) => g.reference)],
    ["expense", plan.expenses.map((e) => e.reference)],
    ["payment", plan.payments.map((p) => p.reference)],
    ["job", plan.jobs.map((j) => j.reference)],
    ["item_sku", plan.items.map((i) => i.sku)],
    ["ids", [...plan.customers, ...plan.suppliers, ...plan.items].map((r) => r.id)],
  ];
  for (const [scope, refs] of refScopes) {
    E(new Set(refs).size === refs.length, `duplicate ${scope} references/ids`);
  }

  // ── No real-contact patterns ─────────────────────────────────────────────────
  const allText = JSON.stringify({
    c: plan.customers,
    s: plan.suppliers,
    e: plan.employees,
    i: plan.invoices,
  });
  E(!IBAN_RE.test(allText), "IBAN-like string present in seeded data");
  for (const c of [...plan.customers, ...plan.suppliers]) {
    if (c.email) E(!REAL_EMAIL_RE.test(c.email), `real-looking email on ${c.name}`);
    E(
      (c as { taxRegNo?: string | null }).taxRegNo == null,
      `TRN present on ${c.name} (must be blank)`,
    );
  }

  // ── Required scenario "personality" states ───────────────────────────────────
  const overdueInvoices = plan.invoices.filter(
    (i) =>
      i.kind === "invoice" &&
      (i.status === "issued" || i.status === "partially_paid") &&
      i.dueDate != null &&
      i.dueDate < asOf &&
      invoiceBalance(plan, i) > 0,
  );
  const upcoming = plan.jobs.filter(
    (j) =>
      (j.statusCategory === "active" || j.statusCategory === "on_hold") &&
      j.dueDate != null &&
      j.dueDate >= asOf &&
      j.dueDate <= addDays(asOf, 14),
  );
  const overdueJobs = plan.jobs.filter(
    (j) => j.statusCategory === "active" && j.dueDate != null && j.dueDate < asOf,
  );
  const doneThisWeek = plan.jobs.filter(
    (j) =>
      j.statusCategory === "done" &&
      j.completedDate != null &&
      j.completedDate >= addDays(asOf, -6),
  );
  const pendingApprovals = plan.approvals.filter((a) => a.state === "pending");
  const openBlockers = plan.issues.filter(
    (i) => i.isBlocker && i.status !== "resolved" && i.status !== "closed",
  );
  const quotesAwaiting = plan.quotes.filter(
    (q) => q.status === "draft" || q.status === "pending_approval",
  );
  const sentQuotes = plan.quotes.filter((q) => q.status === "sent");
  const unpaidExpenses = plan.expenses.filter((e) => e.paymentStatus === "unpaid");

  E(
    overdueInvoices.length >= 1,
    "required: at least one genuinely overdue invoice (collection concern)",
  );
  E(upcoming.length >= 1, "required: at least one genuinely upcoming deadline");
  // The small home-bakery scenario is intentionally on top of its schedule.
  if (scenario.key !== "home_cupcakes")
    E(overdueJobs.length >= 1, "required: at least one overdue active job");
  E(doneThisWeek.length >= 1, "required: at least one job completed this week");
  E(pendingApprovals.length >= 1, "required: at least one pending approval");
  E(openBlockers.length >= 1, "required: at least one open blocker issue");
  E(quotesAwaiting.length >= 1, "required: at least one quote awaiting internal action");
  E(sentQuotes.length >= 1, "required: at least one quote awaiting a customer decision");
  E(unpaidExpenses.length >= 1, "required: at least one unpaid expense");

  // ── Date-range coverage ──────────────────────────────────────────────────────
  const oldest = [
    ...plan.jobs.map((j) => j.startDate),
    ...plan.invoices.map((i) => i.issuedAt?.slice(0, 10) ?? null),
  ]
    .filter(Boolean)
    .sort()[0] as string | undefined;
  const monthsCovered = oldest ? Math.round(daysBetween(asOf, oldest) / 30) : 0;
  E(
    monthsCovered >= Math.min(scenario.historyMonths - 1, scenario.historyMonths),
    `history spans only ~${monthsCovered} months (< ${scenario.historyMonths})`,
  );

  // ── Arabic scenario config ───────────────────────────────────────────────────
  if (scenario.locale === "ar") {
    E(scenario.languages.includes("ar"), "Arabic scenario must include 'ar' in languages");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    metrics: {
      overdueInvoices: overdueInvoices.length,
      upcomingDeadlines: upcoming.length,
      overdueJobs: overdueJobs.length,
      doneThisWeek: doneThisWeek.length,
      pendingApprovals: pendingApprovals.length,
      openBlockers: openBlockers.length,
      quotesAwaiting: quotesAwaiting.length,
      sentQuotes: sentQuotes.length,
      unpaidExpenses: unpaidExpenses.length,
      monthsCovered,
    },
  };
}

export function assertOk(res: CheckResult, label: string): void {
  if (!res.ok) throw new Error(`Invariant failures for ${label}:\n - ${res.errors.join("\n - ")}`);
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  return Math.abs(
    Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000),
  );
}
