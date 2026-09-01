# H24 — TallyPrime functional parity matrix

_Sources: official TallyPrime feature and help pages (see H24-EVIDENCE-LOG).
Classification: **covered** (IdaraWorks already has it), **H24** (built in this
phase), **later** (deliberately deferred), **different** (IdaraWorks does it
another, better-integrated way). No Tally UI, terminology arrangement or
interaction model is copied — coverage is functional only._

| Tally capability | Class | IdaraWorks answer |
| --- | --- | --- |
| Ledgers & groups (chart of accounts) | **H24** | Hierarchical `gl_account` with EN/AR names, codes, types, control/system accounts, org templates. |
| Voucher types (sales, purchase, receipt, payment, contra, journal, debit/credit note) | **H24** | One journal engine + typed entry flows; sales/purchase vouchers are POSTINGS of the existing invoice/expense/PO documents rather than a parallel entry world (**different** by design). |
| Day book / journal register | **H24** | Ledger reports with drill-down to source documents. |
| Bill-by-bill AR/AP, ageing, allocation | **H24** | `payment_allocation` + open-item AR/AP, ageing, statements, advances/unapplied cash. |
| Credit limits & payment terms | **H24** | On customer/supplier financial profiles. |
| Interest calculation | **H24** (basic) | Explicit org policy (simple interest on overdue open items, report-first); auto-posting deferred. |
| Banking: cheque mgmt, PDC | **H24** (tracking) | Cheque/PDC fields on payments where enabled; printing deferred (**later**). |
| Bank reconciliation (auto/manual) | **H24** | CSV statement import, hash dedup, suggestion engine with confidence + human confirm, reconciliation sessions with locking. |
| Live bank feeds | **later** | Adapter seam only; no live-bank claim. |
| Inventory accounting (stock groups, godowns, batches, reorder) | **covered** | H22 stock system (warehouses, bins, lots/serials, reservations, costing ledger). |
| Inventory → books integration | **H24** | Posting rules: GRNI, inventory asset, COGS, adjustments, returns, transfers at cost. |
| Manufacturing/BOM | **covered** | H22D assemblies/disassemblies. |
| Multi-currency with forex gain/loss | **H24** | Rate book + per-posting snapshots, realized FX on settlement, explicit period-end revaluation. |
| Cost centres & cost categories | **H24** | `cost_centre` + rich native dimensions (job, department, employee, customer, supplier, item, custom). |
| Budgets & scenarios | **H24** | Versioned budgets per account/period/dimension + variance + rolling forecast. |
| Payroll | **covered** | H23 payroll (runs, payslips, loans, WPS seam). |
| Payroll accounting | **H24** | Pay-run finalization posts salary expense, allowances, employer contributions, deductions, net payable, clearing. |
| GST / India taxation | **different** | Not an India product: configurable tax engine + UAE VAT/CT packs; other jurisdictions via custom (clearly non-certified) configuration. |
| e-Invoice / e-Way bill | **later** | Jurisdiction-specific e-invoicing not claimed. |
| VAT (Gulf editions) | **H24** | UAE VAT pack with VAT201-oriented working report, box mapping, exception + reconciliation reports. |
| Financial statements (BS, P&L, cash flow, trial balance) | **H24** | Computed from the ledger, comparative periods, dimension filters, drill-down, EN/AR PDF. |
| Ratio analysis / dashboards | **H24** | Finance dashboard: cash position, ageing, margins, tax exposure, obligations, exceptions — each drillable. |
| Edit log / audit (TallyPrime Edit Log) | **H24** | Immutable posted entries + full `command()` audit trail with before/after on masters (**different**: immutability at the database, not a log beside editable rows). |
| Multi-company | **different** | One org = one company with absolute isolation; group/consolidation is an explicit architecture (deferred implementation, **later**) rather than weakened boundaries. |
| Remote access / TallyVault etc. | **different** | Cloud-native app with role-based access; encryption at platform level. |
| Data export (Excel/CSV/PDF/XML) | **covered/H24** | Existing export door + finance reports CSV; branded PDFs. |
| Import from Tally | **H24** | TallyPrime XML (Masters + Day Book vouchers) and generic CSV — guided, validated, dry-run, idempotent (see D15). |
| ODBC / API integrations | **later** | Export seams only; no live integration claimed. |
