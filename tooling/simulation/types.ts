/**
 * Types for the simulation factory: the fictional SCENARIO definitions (committed,
 * non-secret) and the deterministic PLAN the generator produces from a scenario +
 * as-of date. The plan is a plain data structure of typed rows keyed by
 * deterministic ids — pure output that can be invariant-checked and diffed
 * without any database. `apply.ts` writes it; `invariants.ts` validates it.
 */

export type Locale = "en" | "ar";
export type DocLanguage = "en" | "ar" | "bilingual";

/** A template stage descriptor copied from the org's installed template so the
 * factory can seed job_stage snapshots without reading the DB (kept in sync with
 * the template by an apply-time assertion). */
export type StageDef = { key: string; en: string; ar: string; weight: number };

/** A billing point copied from the template preset (Σpct = 100). */
export type BillingPoint = { trigger: "on_acceptance" | { stage_key: string }; pct: number };

export type PresetDef = {
  code: string;
  en: string;
  ar: string;
  skipped: string[]; // default_skipped_stage_keys
  billing: BillingPoint[];
};

/** A catalog item template (fictional). */
export type ItemDef = {
  sku: string;
  name: string;
  categoryKey: string;
  unit: string;
  unitCostMajor: number;
  sellingPriceMajor: number;
};

/** One fictional customer. */
export type CustomerDef = {
  name: string;
  contactName?: string;
  segment?: string; // narrative only (no DB column) — used to shape quotes
};

/** One fictional supplier. */
export type SupplierDef = { name: string; terms?: string; category: string };

/** A fictional worker (name + rough monthly salary in major units, for cost freeze). */
export type EmployeeDef = { name: string; trade: string; salaryMajor: number; otRate: number };

/**
 * A complete fictional business. All content here is invented; no real company,
 * person, TRN, IBAN, phone, address or inbox. Committed to the repo.
 */
export type Scenario = {
  key: string; // stable scenario key → org marker + deterministic ids
  templateKey: string; // installTemplate key (food_beverage_v1 / service_business_v1 / agriculture_v1)
  displayName: string; // trading name (fictional)
  legalName: string; // legal entity name (fictional)
  tagline: string; // short human description of the business
  personality: string; // the dashboard "personality" this scenario should present
  country: string; // ISO-2 (fictional-safe: AE)
  currency: string; // base currency
  locale: Locale; // owner's default UI language (drives RTL for 'ar')
  languages: Locale[]; // org.languages
  docLanguage: DocLanguage; // company.doc_language (document rendering)
  accentColor: string; // #rrggbb brand accent
  vatRegistered: boolean; // finance.vat_registered
  ownerName: string; // fictional owner full name
  ownerEmailLocal: string; // local-part of the (non-deliverable) login email
  contact: {
    // fictional, plausible, clearly non-real
    phone: string;
    email: string;
    website: string;
    addressEn: string;
    addressAr: string;
    city: string;
  };
  historyMonths: number; // how far back history stretches
  richDays: number; // 60–90: dense recent operational window

  // Template config subset (matches the installed template).
  stages: StageDef[];
  presets: PresetDef[];
  itemCategories: string[]; // valid category_key values for items
  quoteSectionKeys: string[];

  // Fictional domain content the generator draws from.
  customers: CustomerDef[];
  suppliers: SupplierDef[];
  items: ItemDef[];
  employees: EmployeeDef[];
  // Short service/order titles used for job & quote names (bilingual pairs).
  workTitles: { en: string; ar: string }[];
};

// ── Plan row types (deterministic; ids are uuidv5 strings) ───────────────────

export type CustomerRow = {
  id: string;
  name: string;
  country: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  taxRegNo: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
};

export type SupplierRow = {
  id: string;
  name: string;
  taxRegNo: string | null;
  termsText: string | null;
  phone: string | null;
  email: string | null;
  active: boolean;
  createdAt: string;
};

export type ItemRow = {
  id: string;
  sku: string;
  name: string;
  categoryKey: string;
  unit: string;
  unitCostMinor: number | null;
  sellingPriceMinor: number | null;
  active: boolean;
  createdAt: string;
};

export type EmployeeRow = {
  id: string;
  name: string;
  phone: string | null;
  active: boolean;
  createdAt: string;
  salaryMinor: number;
  hourlyCostMinor: number;
  otRate: number;
};

export type StageRow = {
  id: string;
  stageKey: string;
  en: string;
  ar: string;
  weight: number;
  sort: number;
  status: "not_started" | "in_progress" | "completed" | "skipped";
  startedAt: string | null;
  completedAt: string | null;
};

export type JobRow = {
  id: string;
  presetCode: string;
  reference: string;
  name: string;
  customerId: string | null;
  statusKey: string;
  statusCategory: "draft" | "active" | "on_hold" | "done" | "cancelled";
  startDate: string | null;
  dueDate: string | null;
  completedDate: string | null;
  sellingPriceMinor: number | null;
  paymentTerms: string | null;
  billingPoints: BillingPoint[];
  createdAt: string;
  updatedAt: string;
  currentStageKey: string | null;
  stages: StageRow[];
  crew: string[]; // employee ids
};

export type ReportWorkLine = {
  stageKey: string | null;
  description: string;
  progressNote: string | null;
};
export type ReportMaterialLine = {
  itemId: string | null;
  itemName: string;
  qty: number;
  unit: string;
  unitCostMinor: number | null;
  costSource: "catalog" | "manual" | "none";
};
export type ReportLabourLine = {
  employeeId: string;
  normalHours: number;
  otHours: number;
  hourlyCostMinor: number;
  otRate: number;
  labourCostMinor: number;
};
export type ReportRow = {
  id: string;
  jobId: string;
  reportDate: string;
  summary: string;
  blockers: string | null;
  nextSteps: string | null;
  status: "draft" | "submitted" | "reviewed" | "returned";
  submittedAt: string;
  reviewedAt: string | null;
  createdAt: string;
  idempotencyKey: string;
  workLines: ReportWorkLine[];
  materialLines: ReportMaterialLine[];
  labourLines: ReportLabourLine[];
};

export type AttendanceRow = {
  id: string;
  employeeId: string;
  date: string;
  status: "present" | "absent" | "leave" | "half_day" | "sick" | "late";
  source: "labour_line" | "manual";
  note: string | null;
};

export type IssueRow = {
  id: string;
  jobId: string | null;
  title: string;
  description: string | null;
  severity: "low" | "medium" | "high" | "critical";
  isBlocker: boolean;
  status: "open" | "in_progress" | "resolved" | "closed";
  resolvedAt: string | null;
  createdAt: string;
};

export type ApprovalRuleRow = {
  id: string;
  subjectType: "material_request" | "expense" | "quote_send" | "purchase_order" | "payment";
  conditionKind: "always" | "amount_gte" | "urgency_in";
  amountGteMinor: number | null;
  urgencyIn: string[] | null;
  assignedRole: string;
  autoApproveBelowMinor: number | null;
};

export type ApprovalRow = {
  id: string;
  subjectType: ApprovalRuleRow["subjectType"];
  subjectId: string;
  subjectSummary: Record<string, unknown>;
  assignedRole: string;
  state: "pending" | "approved" | "rejected" | "withdrawn" | "superseded";
  decidedAt: string | null;
  decisionNote: string | null;
  selfApproved: boolean;
  createdAt: string;
};

export type MrLine = {
  itemId: string | null;
  itemName: string;
  qty: number;
  unit: string;
  estUnitCostMinor: number | null;
  sort: number;
};
export type MaterialRequestRow = {
  id: string;
  reference: string;
  jobId: string | null;
  status: "draft" | "submitted" | "approved" | "rejected" | "converted" | "cancelled";
  urgency: "low" | "normal" | "high" | "urgent";
  requiredDate: string | null;
  totalMinor: number;
  convertedPoId: string | null;
  createdAt: string;
  lines: MrLine[];
};

export type PoLine = {
  id: string;
  itemId: string | null;
  itemName: string;
  qty: number;
  unit: string;
  unitCostMinor: number;
  lineTotalMinor: number;
  sort: number;
};
export type PurchaseOrderRow = {
  id: string;
  reference: string;
  supplierId: string;
  jobId: string | null;
  mrId: string | null;
  status: "draft" | "approved" | "sent" | "partially_received" | "received" | "cancelled";
  vatMinor: number;
  totalMinor: number;
  approvedAt: string | null;
  createdAt: string;
  lines: PoLine[];
};

export type GrnLine = {
  poLineId: string;
  orderedQty: number;
  previouslyReceived: number;
  receivedQty: number;
  damagedQty: number;
  rejectedQty: number;
  sort: number;
};
export type GoodsReceiptRow = {
  id: string;
  reference: string;
  poId: string;
  jobId: string | null;
  status: "draft" | "recorded" | "cancelled";
  receivedDate: string;
  createdAt: string;
  lines: GrnLine[];
};

export type ExpenseRow = {
  id: string;
  reference: string;
  jobId: string | null;
  jobName: string | null;
  categoryKey: string;
  costingMapping: "job_materials" | "job_other" | "overhead";
  description: string;
  expenseDate: string;
  amountMinor: number;
  vatAmountMinor: number;
  totalMinor: number;
  paymentStatus: "unpaid" | "paid";
  createdAt: string;
};

export type QuoteLine = {
  id: string;
  sectionKey: string | null;
  itemId: string | null;
  description: string;
  qty: number;
  unit: string;
  unitPriceMinor: number;
  vatRate: number;
  lineTotalMinor: number;
  sort: number;
};
export type QuoteRow = {
  id: string;
  reference: string;
  customerId: string | null;
  customerName: string | null;
  presetCode: string | null;
  status:
    | "draft"
    | "pending_approval"
    | "approved"
    | "sent"
    | "converting"
    | "accepted"
    | "rejected"
    | "expired"
    | "converted";
  currency: string;
  exchangeRate: number;
  subtotalMinor: number;
  vatAmountMinor: number;
  totalMinor: number;
  baseTotalMinor: number;
  terms: string | null;
  validUntil: string | null;
  acceptedAt: string | null;
  acceptedNote: string | null;
  rejectedReason: string | null;
  convertedJobId: string | null;
  notes: string | null;
  createdAt: string;
  lines: QuoteLine[];
};

export type InvoiceLine = {
  id: string;
  description: string;
  qty: number;
  unit: string;
  unitPriceMinor: number;
  vatRate: number;
  lineTotalMinor: number;
  sort: number;
};
export type InvoiceRow = {
  id: string;
  reference: string;
  kind: "invoice" | "credit_note";
  correctsInvoiceId: string | null;
  customerId: string | null;
  customerName: string | null;
  customerTaxRegNo: string | null;
  jobId: string | null;
  quoteId: string | null;
  status: "draft" | "issued" | "partially_paid" | "paid" | "cancelled";
  isExport: boolean;
  currency: string;
  exchangeRate: number;
  subtotalMinor: number;
  vatAmountMinor: number;
  totalMinor: number;
  baseTotalMinor: number;
  issuedAt: string | null;
  dueDate: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  notes: string | null;
  createdAt: string;
  lines: InvoiceLine[];
};

export type PaymentRow = {
  id: string;
  reference: string;
  invoiceId: string | null;
  customerId: string | null;
  customerName: string | null;
  status: "recorded" | "confirmed" | "rejected" | "void";
  method: "cash" | "bank_transfer" | "cheque" | "card" | "other";
  paymentDate: string;
  amountMinor: number;
  currency: string;
  exchangeRate: number;
  baseAmountMinor: number;
  createdAt: string;
  receiptId: string;
  receiptReference: string;
};

export type ActivityRow = {
  id: string;
  entityType: string;
  entityId: string;
  verb: string;
  summary: string;
  createdAt: string;
};

export type ExceptionRow = {
  id: string;
  ruleKey:
    | "missing_report"
    | "overdue_stage"
    | "approval_stuck"
    | "blocking_issue"
    | "labour_outlier"
    | "quote_divergence"
    | "billing_point_reopened";
  severity: "info" | "warning" | "critical";
  audienceRoles: string[];
  dedupKey: string;
  subjectType: string | null;
  subjectId: string | null;
  title: string;
  createdAt: string;
};

/** Reference-sequence high-water marks so in-app records continue the run. */
export type SequenceRow = { scopeKey: string; nextValue: number };

export type Plan = {
  scenarioKey: string;
  asOf: string;
  customers: CustomerRow[];
  suppliers: SupplierRow[];
  items: ItemRow[];
  employees: EmployeeRow[];
  jobs: JobRow[];
  reports: ReportRow[];
  attendance: AttendanceRow[];
  issues: IssueRow[];
  approvalRules: ApprovalRuleRow[];
  approvals: ApprovalRow[];
  materialRequests: MaterialRequestRow[];
  purchaseOrders: PurchaseOrderRow[];
  goodsReceipts: GoodsReceiptRow[];
  expenses: ExpenseRow[];
  quotes: QuoteRow[];
  invoices: InvoiceRow[];
  payments: PaymentRow[];
  activity: ActivityRow[];
  exceptions: ExceptionRow[];
  sequences: SequenceRow[];
};

/** Table-by-table counts for reporting. */
export function planCounts(plan: Plan): Record<string, number> {
  return {
    customers: plan.customers.length,
    suppliers: plan.suppliers.length,
    items: plan.items.length,
    employees: plan.employees.length,
    jobs: plan.jobs.length,
    job_stages: plan.jobs.reduce((n, j) => n + j.stages.length, 0),
    reports: plan.reports.length,
    report_lines: plan.reports.reduce(
      (n, r) => n + r.workLines.length + r.materialLines.length + r.labourLines.length,
      0,
    ),
    attendance: plan.attendance.length,
    issues: plan.issues.length,
    approvals: plan.approvals.length,
    material_requests: plan.materialRequests.length,
    purchase_orders: plan.purchaseOrders.length,
    goods_receipts: plan.goodsReceipts.length,
    expenses: plan.expenses.length,
    quotes: plan.quotes.length,
    quote_lines: plan.quotes.reduce((n, q) => n + q.lines.length, 0),
    invoices: plan.invoices.filter((i) => i.kind === "invoice").length,
    credit_notes: plan.invoices.filter((i) => i.kind === "credit_note").length,
    payments: plan.payments.length,
    activity: plan.activity.length,
    exceptions: plan.exceptions.length,
  };
}
