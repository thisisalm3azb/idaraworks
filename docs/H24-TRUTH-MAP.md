# H24 Truth Map — where money facts live today, and the finance architecture

_Date: 2026-09-01 · Pre-implementation commit (H24A). Production at `53fec57`,
99 migrations, main == origin/main._

## 1. Canonical money records today (the audit)

| Record | Table(s) | Canonical for | Money columns | Notes |
| --- | --- | --- | --- | --- |
| Quote | `quote` | offered price | subtotal/vat/total/base, currency+rate, issuer snapshot | Not an accounting event. |
| Invoice / credit note | `invoice` (+`invoice_line`) | revenue + output VAT + receivable amount | subtotal/vat/total/base, per-line `vat_rate`, currency+rate | `kind` covers credit notes via `corrects_invoice_id`. Statuses issued/partially_paid/paid/cancelled. |
| Customer payment | `payment` | cash-in | amount/base, currency+rate, idempotency_key | **Links to ONE invoice** — no multi-invoice allocation (H24D adds allocation without breaking this). |
| Expense | `expense` | org/job cost + input VAT | amount(net)/vat/total, `costing_mapping` snapshot, payment_status | Void with reason; no bank/cash account identity. |
| Purchase order | `purchase_order` | committed purchase | vat/total/base, currency+rate (0087) | Approval flow; no bill/AP concept. |
| Goods receipt | `goods_receipt`(+lines) | received qty | — (values via PO lines) | **No GRNI**; receipt→stock posting exists (H22). |
| Stock ledger | `stock_movement` | quantity AND cost movement | unit_cost/base/cost_total, currency+rate, idempotency, reversal links | A real perpetual-inventory subledger already. |
| Pay run / payslip | `pay_run`, `pay_run_line`, `payslip` | gross/deduction/employer/net | integer minors, snapshots, immutable | No GL; `payout_batch` records payment intent. |
| Expense claim | `expense_claim`(+lines) | employee reimbursement | total, per-line amounts | Settles via payroll OR one `expense` row per line (latched once). |
| Asset | `asset` | acquisition cost + custody | acquisition/base cost, residual, useful life, depreciation_start | **Depreciation fields exist, no schedule/entries.** |
| Org identity | `org`, `company` | base currency, country, TRN, legal identity | — | `company.tax_reg_no` = TRN. |
| Costing engine | computed | job profitability | reads expense/stock/labour | Computed-on-read; no stored totals to drift. |

**Projections (recomputed, never canonical):** job cost/profit, dashboards,
missing-items, report aggregates, `employee_terms` (projection of
compensation history), attention feeds.

## 2. Where financial facts can disagree today

1. `invoice.status` (paid/partially_paid) vs the sum of its payments — status
   is advanced by code, not derived; a report trusting status can drift.
2. `expense.payment_status` is a flag with no cash account — "paid from what?"
   is unanswerable.
3. No ledger: revenue, VAT, payables, payroll cost exist only inside their
   source tables, so cross-domain statements (P&L, balance sheet) are
   impossible without re-implementing each domain's rules per report.
4. PO-002 (production): receipt saved, stock movement missing — an existing
   subledger drift case. **H24 records it as a reconciliation exception; it is
   never repaired or posted implicitly.**
5. Asset cost lives on `asset`; nothing accumulates depreciation.
6. FX: each document snapshots a manual rate; there is no rate book and no
   revaluation, so foreign-currency balances silently age.

## 3. Locked architecture decisions (D-numbers cited in code)

- **D1 — One ledger, subledgers stay canonical.** New `journal_entry` /
  `journal_line` is the accounting truth. Business documents remain the
  operational truth and are POSTED via versioned posting rules; nothing
  editable is created beside them. Reports read the ledger; reconciliations
  compare ledger control accounts to subledger sums and REPORT drift.
- **D2 — Posting is idempotent and source-linked.** Unique
  `(org, source_type, source_id, event_key)` on posted entries; retries and
  concurrent posts collapse to one row; every entry carries its source.
- **D3 — Immutable after posting; explicit reversal.** DB triggers freeze
  posted entries/lines; no app role holds UPDATE on posted money columns or
  DELETE anywhere; corrections = reversal entry (linked) + replacement.
  Draft entries are editable; draft line removal goes through a guarded
  SECURITY DEFINER (no DELETE grants, D-1.7).
- **D4 — Integer minor units, dual balance.** Every line stores debit XOR
  credit in transaction minor units AND base minor units; both sides must
  balance exactly (DB constraint + posting check). Rounding differences post
  to the system rounding account, visibly.
- **D5 — Periods.** `fiscal_year` + `fiscal_period` (monthly), states
  open → soft_closed → locked; DB trigger blocks posting into non-open
  periods; reopening is an audited action with reason (finance-admin only).
- **D6 — Chart of accounts is org-owned, template-seeded.** Hierarchical
  `gl_account` (EN/AR names, code, type, normal balance, control/system
  flags). A versioned template seeds system accounts (`system_key`: AR, AP,
  VAT output/input, inventory, GRNI, COGS, payroll clearing, salary expense,
  rounding, FX gain/loss, retained earnings, opening balance equity, cash,
  bank…) during guided finance setup — per org, not at migration time.
  Accounts archive; they never delete.
- **D7 — Books start at a transition date.** Posting rules apply to documents
  dated on/after the org's reviewed `books_start_date`. History before it
  enters ONLY as reviewed opening balances. A read-only transition report
  quantifies production history first; **no silent conversion, ever** —
  PO-002 appears there as a named exception.
- **D8 — Tax is an engine, not scattered ifs.** Versioned `tax_code`
  (jurisdiction pack, treatment, rate, effective dates, reporting box,
  recoverability); posting writes `tax_entry` facts (base, tax, direction,
  box, code version) so returns are computed from captured facts, not
  re-derived guesses. Custom org taxes allowed, never labelled
  government-compliant. UAE packs: `AE-VAT-2026-09-01`,
  `AE-CT-2026-09-01` with verification tiers; unverified never auto-applies.
- **D9 — Banking.** `bank_account` maps 1:1 to a `gl_account`; statements
  import (CSV) with file+line hash dedup; reconciliation sessions match
  statement lines to ledger lines (1:1, 1:N, N:1, partial), lock on
  completion; suggestions show confidence and never auto-reconcile. Bank API
  connections are an adapter seam — none is claimed.
- **D10 — FX.** `currency_rate` book (manual/imported, effective timestamps)
  provides SUGGESTIONS; every posting snapshots its explicit rate; no
  invented rates. Realized FX posts on settlement; unrealized FX is an
  explicit period-end revaluation run creating reversible entries.
- **D11 — Dimensions.** `journal_line` carries job, department, employee,
  customer, supplier, item, cost_centre (new bounded table) + `dims jsonb`
  for org-defined custom dimensions. Reports filter/aggregate on them.
- **D12 — Budgets.** `budget` (year, version, status draft/approved/locked) +
  `budget_line` (account × period × optional dimension). Actual-vs-budget
  reads the ledger. Cash-flow forecast composes real AR/AP due dates,
  payroll and PO commitments.
- **D13 — Release gate.** `FEATURE_FINANCE_SURFACES === "1"` (strict, unit
  tested like stock/HR). Entitlement `cap.finance` seeded enabled on all
  plans (same law as D8/H23); surfaces hidden until the whole workflow is
  verified.
- **D14 — Roles map onto existing archetypes.** finance admin=owner/admin;
  accountant/bookkeeper/AR/AP/cashier=accounts (+cost privilege where money
  is visible); auditor=viewer (read-only); manager=manager. New actions:
  `finance.view/manage/post/approve/close/reconcile`, `tax.prepare/review`,
  `budget.manage`. Segregation: post≠approve, prepare≠review, reopen≠post —
  enforced in the matrix and services.
- **D15 — Tally interop, honestly scoped.** Importer supports **TallyPrime
  XML exports** (Masters via List of Accounts export; Vouchers via Day Book
  export — the TALLYMESSAGE envelope) plus **generic CSV** (chart, parties,
  opening balances, trial balance). Guided flow: upload → inspect → map →
  validate → dry-run → trial-balance comparison → approve → idempotent import
  → reconciliation report. Anything else is stated as unsupported.

## 4. Existing records: integration, not recreation

- Invoices/credit notes, payments, expenses, POs/receipts, stock movements,
  pay runs, claims and assets each get ONE posting rule (H24D–F); their
  tables gain nothing but posting linkage.
- `payment.invoice_id` stays; H24D adds `payment_allocation` for
  multi-invoice/advance cases — the single-invoice fast path keeps working.
- Asset depreciation uses the existing asset fields; H24F adds the schedule +
  run tables and posts through the same journal engine.
