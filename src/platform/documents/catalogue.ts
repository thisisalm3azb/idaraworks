/**
 * Universal export catalogue (003B.1 — audit §12.3). The authoritative,
 * typed classification of every exportable surface in the product: formal
 * print/PDF documents and tabular data exports.
 *
 * HONESTY LAW (tested): `availability` may say "available" ONLY when the
 * export is actually wired end-to-end today. Data exports are available iff
 * they are served by the existing CSV route (platform/export/service.ts —
 * EXPORT_ENTITIES). No formal document is available yet: print routes begin
 * in 003B.2; templates/shell/profile existing does NOT make a document
 * "available" (that is exactly the inert-span lie this program removes).
 *
 *  - "available"        — a user can obtain it in the product today.
 *  - "foundation_ready" — source data + redaction rules (and for documents:
 *                          profile/shell/template) exist; the route is pending.
 *  - "future"           — needs new report/query or template design.
 *
 * PDF is never forced onto tabular data; CSV is never offered for a formal
 * document. XLSX is a declared future format, live nowhere.
 */
import type { Action } from "@/platform/authz";

export type ExportFormat = "print" | "pdf" | "csv" | "xlsx";
export type ExportAvailability = "available" | "foundation_ready" | "future";

export type ExportCatalogueEntry = {
  /** Stable identifier (snake_case, unique across the catalogue). */
  id: string;
  kind: "document" | "data";
  nameEn: string;
  nameAr: string;
  /** Source entity/report the export is produced from. */
  source: string;
  /** Allowed formats — "pdf" here means print→Save-as-PDF until a real
   * renderer exists; a stored-PDF download only ever appears when a real
   * file exists (audit §6.2). */
  formats: readonly ExportFormat[];
  /** Permission required to produce the export (compile-time matrix key). */
  permission: Action;
  /** Entitlement feature that gates it, or null. Reads never hard-gate
   * (FR-9); the note states the exact behavior. */
  entitlementFeature: string | null;
  entitlementNote: string;
  /** What must be redacted and for whom. */
  redaction: string;
  /** Formal documents render through the shared document profile/shell. */
  usesDocumentProfile: boolean;
  /** Which record statuses may produce the export. */
  statusEligibility: string;
  /** Whether non-final statuses render with the DRAFT watermark. */
  draftWatermark: boolean;
  /** Formal commercial/legal documents re-render from an immutable issuer
   * snapshot once formalized (audit §12.4). */
  requiresIssuerSnapshot: boolean;
  availability: ExportAvailability;
};

const DOC = ["print", "pdf"] as const;
const DATA = ["csv", "xlsx"] as const;

const doc = (
  e: Omit<ExportCatalogueEntry, "kind" | "formats" | "usesDocumentProfile">,
): ExportCatalogueEntry => ({ ...e, kind: "document", formats: DOC, usesDocumentProfile: true });

const data = (
  e: Omit<
    ExportCatalogueEntry,
    | "kind"
    | "formats"
    | "usesDocumentProfile"
    | "statusEligibility"
    | "draftWatermark"
    | "requiresIssuerSnapshot"
  > &
    Partial<Pick<ExportCatalogueEntry, "statusEligibility">>,
): ExportCatalogueEntry => ({
  statusEligibility: "all rows; archived/voided flagged in columns",
  ...e,
  kind: "data",
  formats: DATA,
  usesDocumentProfile: false,
  draftWatermark: false,
  requiresIssuerSnapshot: false,
});

export const EXPORT_CATALOGUE: readonly ExportCatalogueEntry[] = [
  // ── Formal print/PDF documents ─────────────────────────────────────────────
  doc({
    id: "doc_quote",
    nameEn: "Quotation",
    nameAr: "عرض سعر",
    source: "quote + quote_line (quote-template.ts)",
    permission: "quotes.view",
    entitlementFeature: null,
    entitlementNote:
      "cap.quoting gates creating quotes; viewing/printing an existing one never gates (FR-9).",
    redaction: "Only price-visible roles hold quotes.view; money renders as stored.",
    statusEligibility: "any status",
    draftWatermark: true,
    requiresIssuerSnapshot: true,
    availability: "available",
  }),
  doc({
    id: "doc_invoice",
    nameEn: "Tax invoice",
    nameAr: "فاتورة ضريبية",
    source: "invoice (kind=invoice) + invoice_line (invoice-template.ts)",
    permission: "invoices.view",
    entitlementFeature: null,
    entitlementNote:
      "cap.invoicing gates create/issue; printing an existing invoice never gates (FR-9).",
    redaction: "invoices.view roles are price-privileged by matrix design.",
    statusEligibility: "any status; issued+ is the formal document",
    draftWatermark: true,
    requiresIssuerSnapshot: true,
    availability: "available",
  }),
  doc({
    id: "doc_credit_note",
    nameEn: "Credit note",
    nameAr: "إشعار دائن",
    source: "invoice (kind=credit_note) — same template path with CREDIT watermark",
    permission: "invoices.view",
    entitlementFeature: null,
    entitlementNote: "Never gated — corrections are always reachable (FR-9).",
    redaction: "as invoices",
    statusEligibility: "issued (credit notes are born issued)",
    draftWatermark: false,
    requiresIssuerSnapshot: true,
    availability: "available",
  }),
  doc({
    id: "doc_payment_receipt",
    nameEn: "Payment receipt",
    nameAr: "إيصال دفع",
    source: "payment + payment_receipt (RCP reference; body template pending)",
    permission: "payments.view",
    entitlementFeature: null,
    entitlementNote: "cap.payments gates recording; printing an existing receipt never gates.",
    redaction: "payments.view roles are price-privileged by matrix design.",
    statusEligibility: "recorded/confirmed; voided prints with VOID watermark",
    draftWatermark: false,
    requiresIssuerSnapshot: true,
    availability: "foundation_ready",
  }),
  doc({
    id: "doc_purchase_order",
    nameEn: "Purchase order (LPO)",
    nameAr: "أمر شراء",
    source: "purchase_order + po_line (lpo-template.ts)",
    permission: "po.view",
    entitlementFeature: null,
    entitlementNote: "cap.purchase_orders gates creating POs; printing never gates.",
    redaction: "po.view is the cost-visibility predicate for supply documents.",
    statusEligibility: "any status; approved+ is the formal document",
    draftWatermark: true,
    requiresIssuerSnapshot: true,
    availability: "foundation_ready",
  }),
  doc({
    id: "doc_goods_receipt",
    nameEn: "Goods receipt note",
    nameAr: "سند استلام بضائع",
    source: "goods_receipt + goods_receipt_line (internal document; body pending)",
    permission: "po.view",
    entitlementFeature: null,
    entitlementNote: "cap.goods_receipts gates recording; printing never gates.",
    redaction: "quantities only for grn.create-only roles; costs require po.view.",
    statusEligibility: "recorded; cancelled prints with CANCELLED watermark",
    draftWatermark: false,
    requiresIssuerSnapshot: false,
    availability: "future",
  }),
  doc({
    id: "doc_material_request",
    nameEn: "Material request",
    nameAr: "طلب مواد",
    source: "material_request + mr_line (internal document; body pending)",
    permission: "mr.create",
    entitlementFeature: null,
    entitlementNote: "cap.material_requests gates creating MRs; printing never gates.",
    redaction: "est. costs null unless the caller holds po.view (existing MR redaction).",
    statusEligibility: "any status",
    draftWatermark: true,
    requiresIssuerSnapshot: false,
    availability: "future",
  }),
  doc({
    id: "doc_expense_voucher",
    nameEn: "Expense voucher",
    nameAr: "سند مصروف",
    source: "expense (internal document; body pending)",
    permission: "expenses.view",
    entitlementFeature: null,
    entitlementNote: "cap.expenses gates creating expenses; printing never gates.",
    redaction: "expenses.view holders see amounts (cost-privileged by matrix).",
    statusEligibility: "active; voided prints with VOID watermark",
    draftWatermark: false,
    requiresIssuerSnapshot: false,
    availability: "future",
  }),
  doc({
    id: "doc_daily_report",
    nameEn: "Daily report",
    nameAr: "تقرير يومي",
    source: "daily_report + work/labour/material lines (body pending)",
    permission: "jobs.view",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "labour costs only for cost-privileged readers (existing report redaction).",
    statusEligibility: "submitted/reviewed; draft/returned print with DRAFT watermark",
    draftWatermark: true,
    requiresIssuerSnapshot: false,
    availability: "future",
  }),
  doc({
    id: "doc_week_plan",
    nameEn: "Weekly work plan",
    nameAr: "خطة العمل الأسبوعية",
    source: "week_plan + week_plan_job (week-plan-document.ts)",
    permission: "week.view",
    entitlementFeature: null,
    entitlementNote: "Never gated — planning the week is core to running the work.",
    redaction:
      "Operational only: work, tasks and crew. Carries no money, so no cost redaction applies. " +
      "INTERNAL — it names employees and spans every customer's work that week, so it cannot be " +
      "given a public share link (SHAREABLE_KINDS in the documents service).",
    statusEligibility: "any status; issued is the circulated document",
    draftWatermark: true,
    requiresIssuerSnapshot: true,
    availability: "available",
  }),
  doc({
    id: "doc_customer_update",
    nameEn: "Customer update",
    nameAr: "تحديث للعميل",
    source: "customer_update frozen safe-content snapshot (share page exists; print pending)",
    permission: "customer_updates.draft",
    entitlementFeature: "cap.customer_updates",
    entitlementNote:
      "cap.customer_updates gates drafting/sending; printing a sent update never gates.",
    redaction: "safeContent() only — never costs, workers or internal issues.",
    statusEligibility: "sent (drafts preview with DRAFT watermark)",
    draftWatermark: true,
    requiresIssuerSnapshot: false,
    availability: "foundation_ready",
  }),
  doc({
    id: "doc_customer_statement",
    nameEn: "Customer statement",
    nameAr: "كشف حساب عميل",
    source: "invoices + credit notes + payments per customer (new query needed)",
    permission: "ar.view",
    entitlementFeature: null,
    entitlementNote: "Never gated for viewing; requires price privilege.",
    redaction: "price-privileged only (computeAR redaction law).",
    statusEligibility: "issued documents only",
    draftWatermark: false,
    requiresIssuerSnapshot: false,
    availability: "future",
  }),
  doc({
    id: "doc_job_status_report",
    nameEn: "Work status report",
    nameAr: "تقرير حالة العمل",
    source: "job + stages + progress + recent reports (new composition)",
    permission: "jobs.view",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "no money unless price/cost privileged sections are included.",
    statusEligibility: "any job status",
    draftWatermark: false,
    requiresIssuerSnapshot: false,
    availability: "future",
  }),
  doc({
    id: "doc_attendance_report",
    nameEn: "Attendance / timesheet report",
    nameAr: "تقرير الحضور والدوام",
    source: "attendance rows per period (new query needed)",
    permission: "attendance.view",
    entitlementFeature: "cap.attendance",
    entitlementNote: "cap.attendance gates marking; reporting on recorded data never gates.",
    redaction: "no pay data — attendance statuses only.",
    statusEligibility: "recorded days",
    draftWatermark: false,
    requiresIssuerSnapshot: false,
    availability: "future",
  }),
  doc({
    id: "doc_costing_report",
    nameEn: "Costing report",
    nameAr: "تقرير التكاليف",
    source: "cost rollup per job (getJobCosting)",
    permission: "costing.view",
    entitlementFeature: "cap.costing",
    entitlementNote: "cap.costing gates the costing surface (page-level today).",
    redaction: "labour/total cost require cost privilege; quoted/margin require price privilege.",
    statusEligibility: "any job status",
    draftWatermark: false,
    requiresIssuerSnapshot: false,
    availability: "future",
  }),
  doc({
    id: "doc_sales_report",
    nameEn: "Sales report",
    nameAr: "تقرير المبيعات",
    source: "quotes + invoices per period (new query needed)",
    permission: "invoices.view",
    entitlementFeature: null,
    entitlementNote: "Never gated for viewing recorded data.",
    redaction: "price-privileged only.",
    statusEligibility: "issued documents only",
    draftWatermark: false,
    requiresIssuerSnapshot: false,
    availability: "future",
  }),
  doc({
    id: "doc_receivables_aging",
    nameEn: "Receivables / aging report",
    nameAr: "تقرير أعمار الذمم المدينة",
    source: "computeAR buckets + per-invoice detail (drill-down query needed)",
    permission: "ar.view",
    entitlementFeature: null,
    entitlementNote: "Never gated for viewing.",
    redaction: "fully redacted unless price-privileged (existing computeAR law).",
    statusEligibility: "issued/partially_paid invoices",
    draftWatermark: false,
    requiresIssuerSnapshot: false,
    availability: "future",
  }),
  doc({
    id: "doc_letterhead",
    nameEn: "Cover letter / letterhead",
    nameAr: "ورق رسمي / خطاب",
    source: "document profile alone (shell cover mode)",
    permission: "config.view",
    entitlementFeature: "feat.branding_docs",
    entitlementNote:
      "Basic letterhead identity is core; feat.branding_docs adds advanced styling (accent, cover layout).",
    redaction: "issuer identity only — no operational data.",
    statusEligibility: "n/a",
    draftWatermark: false,
    requiresIssuerSnapshot: false,
    availability: "foundation_ready",
  }),

  // ── Data exports (CSV now, XLSX future) ────────────────────────────────────
  data({
    id: "data_customers",
    nameEn: "Customers",
    nameAr: "العملاء",
    source: "customer",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated (FR-9: reads/exports always available).",
    redaction: "none (no money columns).",
    availability: "available",
  }),
  data({
    id: "data_suppliers",
    nameEn: "Suppliers",
    nameAr: "الموردون",
    source: "supplier",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "none.",
    availability: "available",
  }),
  data({
    id: "data_items",
    nameEn: "Items / catalogue",
    nameAr: "الأصناف",
    source: "item",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "unit cost requires cost privilege; selling price requires price privilege.",
    availability: "foundation_ready",
  }),
  data({
    id: "data_employees",
    nameEn: "Employees",
    nameAr: "الموظفون",
    source: "employee (never terms/HR columns)",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "salary terms and HR identity documents are NEVER exported here.",
    availability: "foundation_ready",
  }),
  data({
    id: "data_teams",
    nameEn: "Teams",
    nameAr: "الفرق",
    source: "team",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "none.",
    availability: "foundation_ready",
  }),
  data({
    id: "data_members",
    nameEn: "Workspace members",
    nameAr: "أعضاء مساحة العمل",
    source: "membership + user_profile (names/roles/status only)",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote:
      "Never gated; additionally requires members.view semantics (no emails of other members for non-admins).",
    redaction: "no auth identifiers; role + status + display name only.",
    availability: "foundation_ready",
  }),
  data({
    id: "data_jobs",
    nameEn: "Work records",
    nameAr: "سجلات العمل",
    source: "job",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "selling price column nulled unless price-privileged (PRICE_COLS).",
    availability: "available",
  }),
  data({
    id: "data_quotes",
    nameEn: "Quotations",
    nameAr: "عروض الأسعار",
    source: "quote + quote_line",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "money columns nulled unless price-privileged.",
    availability: "foundation_ready",
  }),
  data({
    id: "data_invoices",
    nameEn: "Invoices",
    nameAr: "الفواتير",
    source: "invoice",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "money columns nulled unless price-privileged (PRICE_COLS).",
    availability: "available",
  }),
  data({
    id: "data_payments",
    nameEn: "Payments",
    nameAr: "المدفوعات",
    source: "payment",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "amount nulled unless price-privileged (PRICE_COLS).",
    availability: "available",
  }),
  data({
    id: "data_expenses",
    nameEn: "Expenses",
    nameAr: "المصروفات",
    source: "expense",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "amounts nulled unless cost-privileged (COST_COLS).",
    availability: "available",
  }),
  data({
    id: "data_material_requests",
    nameEn: "Material requests",
    nameAr: "طلبات المواد",
    source: "material_request + mr_line",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "estimated costs nulled unless po.view-equivalent cost visibility.",
    availability: "foundation_ready",
  }),
  data({
    id: "data_purchase_orders",
    nameEn: "Purchase orders",
    nameAr: "أوامر الشراء",
    source: "purchase_order + po_line",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "costs nulled unless cost-privileged.",
    availability: "foundation_ready",
  }),
  data({
    id: "data_goods_receipts",
    nameEn: "Goods receipts",
    nameAr: "سندات الاستلام",
    source: "goods_receipt + goods_receipt_line",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "quantities always; line costs follow PO cost redaction.",
    availability: "foundation_ready",
  }),
  data({
    id: "data_daily_reports",
    nameEn: "Daily reports",
    nameAr: "التقارير اليومية",
    source: "daily_report",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "labour costs excluded (existing export shape).",
    availability: "available",
  }),
  data({
    id: "data_attendance",
    nameEn: "Attendance",
    nameAr: "الحضور",
    source: "attendance",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "statuses only; no pay data.",
    availability: "foundation_ready",
  }),
  data({
    id: "data_issues",
    nameEn: "Issues",
    nameAr: "المشكلات",
    source: "issue",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "none.",
    availability: "foundation_ready",
  }),
  data({
    id: "data_approvals_history",
    nameEn: "Approvals history",
    nameAr: "سجل الموافقات",
    source: "approval (decided + pending)",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "amounts follow per-subject redaction (payment/quote amounts price-gated).",
    availability: "foundation_ready",
  }),
  data({
    id: "data_audit_log",
    nameEn: "Audit log",
    nameAr: "سجل التدقيق",
    source: "audit_log",
    permission: "data.export",
    entitlementFeature: "feat.audit_export",
    entitlementNote:
      "The ONE entitlement-gated export (explicit 403 addon_required, never a silent 404).",
    redaction: "before/after payloads excluded; summary rows only (existing shape).",
    availability: "available",
  }),
  data({
    id: "data_config_revisions",
    nameEn: "Configuration revisions",
    nameAr: "مراجعات الإعدادات",
    source: "config_revision",
    permission: "data.export",
    entitlementFeature: null,
    entitlementNote: "Never gated.",
    redaction: "none (tenant's own configuration).",
    availability: "foundation_ready",
  }),
];

/** Convenience views. */
export const DOCUMENT_EXPORTS = EXPORT_CATALOGUE.filter((e) => e.kind === "document");
export const DATA_EXPORTS = EXPORT_CATALOGUE.filter((e) => e.kind === "data");
