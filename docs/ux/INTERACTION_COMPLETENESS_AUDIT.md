# Interaction Completeness Audit

**Microstep 003A — audit and design only. No code was changed.**
Date: 2026-08-27 · Repo state: `main` @ `03dc842` · Dashboard microsteps 002C–002G are paused; interaction completeness is the priority.

## 0. Method and honesty rules

Every claim below was verified in code, at three layers reported separately — **service implemented**, **server action implemented**, **UI exposed** — because in this codebase they diverge constantly (e.g. `updateCustomer` is fully implemented and audited in the service and callable by nothing). A capability counts as **complete** only when a user can find it, use it, understand it, and recover from mistakes, end to end. Evidence citations are `file:line` as inspected on this commit.

**The product-wide interaction law** — every user-facing entity must answer:
1. What is this? 2. What state is it in? 3. What can I do now? 4. What happens next? 5. Can I correct it? 6. Can I archive/cancel/void/delete it? 7. If deletion is unsafe, what is the safe alternative? 8. Can required related data be created without abandoning this workflow? 9. Can I preview/print/download/share/export the resulting document? 10. Can I recover from a mistake without technical assistance?

**Lifecycle classification (no universal hard-delete).** All recommendations in this document follow it:

| Class | Correction model |
|---|---|
| Master data (customers, suppliers, items, employees, teams) | edit + deactivate/archive + reactivate; hard-delete only when genuinely unreferenced and safe (note: **no `*.delete` permission key and no DELETE grant exists anywhere today** — consistent with this law) |
| Draft commercial documents (draft quote, draft invoice, draft MR, draft PO) | fully editable; cancellable; duplicable; deletable only when nothing references them |
| Approved/sent documents | preserve history; revise/supersede/expire/reject/cancel via explicit transitions |
| Issued invoices & legal financial records | immutable; void-before-issue, credit note, reversal, replacement |
| Payments | void/reverse with reason; never delete (already correct in code) |
| Operational reports & audited events | correction/revision workflow with audit history (the daily-report return loop is the house model) |
| Configuration | validated configuration revisions (the pipeline already does this; the UI doesn't expose it) |

All existing laws are preserved: server-side data access, pooled `org_id` tenancy + RLS, permissions/entitlements, immutable financial history, audited mutations through `command()`, EN/AR parity, terminology resolution, module boundaries, and the constitutional AI boundary (AI configures; never code/SQL/DDL/RLS/migrations).

---

## 1. Entity–action matrix

Legend: **✅** complete end-to-end · **◐** partial or hidden (exists at some layer or with significant deficiency — see note) · **❌** missing at every layer · **N/A** intentionally prohibited (safe alternative stated in §1.6).
Columns: List · Search/filter · View details · Create · Edit · Duplicate · Archive/deactivate · Reactivate · Delete · Cancel · Void/reverse · Revise/supersede · Status transitions · Audit history (user-visible) · Attachments · Preview · Print/PDF · Download · Share/send · **Severity**.

### 1.1 Master data

| Entity | List | Srch | View | Create | Edit | Dup | Arch | React | Del | Cancel | Void | Revise | Status | Hist | Attach | Prev | PDF | Down | Send | Sev |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Customers | ✅ | ❌ | ❌ | ✅ | ◐¹ | ❌ | ◐² | ◐² | N/A | N/A | N/A | N/A | N/A | ◐³ | ❌ | N/A | N/A | ✅⁴ | N/A | **Critical** |
| Suppliers | ✅ | ❌ | ❌ | ✅ | ❌⁵ | ❌ | ◐² | ◐² | N/A | N/A | N/A | N/A | N/A | ◐³ | ❌ | N/A | N/A | ✅⁴ | N/A | **High** |
| Items / catalogue | ✅ | ❌ | ❌ | ◐⁶ | ❌⁵ | ❌ | ◐² | ◐² | N/A | N/A | N/A | N/A | N/A | ◐³ | ❌ | N/A | N/A | ❌⁷ | N/A | **High** |
| Employees | ✅ | ❌ | ✅ | ◐⁸ | ✅ | ❌ | ◐⁹ | ◐⁹ | N/A | N/A | N/A | N/A | N/A | ◐³ | ❌ | N/A | N/A | ❌⁷ | N/A | Medium |
| Teams | ✅ | ❌ | ❌ | ◐¹⁰ | ❌⁵ | ❌ | ❌ | ❌ | N/A | N/A | N/A | N/A | N/A | ◐³ | N/A | N/A | N/A | ❌⁷ | N/A | Medium |
| Org members | ✅ | ❌ | ❌ | ✅¹¹ | ❌¹² | N/A | ✅¹³ | ❌⁵ | N/A | N/A | N/A | N/A | ◐ | ◐³ | N/A | N/A | N/A | ❌⁷ | ✅ invite | **High** |
| Branding | N/A | N/A | ✅ | N/A | ✅ | N/A | N/A | N/A | ✅ logo | N/A | N/A | N/A | N/A | ◐³ | ✅ logo | ✅ | N/A | N/A | N/A | — complete |

Notes — ¹ `updateCustomer` fully implemented + audited (`masters/service.ts:330`) but **no action or UI calls it** (dead code; cheapest gap in the app). Also `listCustomers` projects only `id,name,country,active` — phone/email/tax/contact are write-only; an edit form cannot pre-populate without widening the read. ² `active` boolean exists on all masters; **no UI can set it** (only `updateEmployee` ever writes `active`); no archived filter on any list. ³ Every mutation is audited via `command()`, but no per-entity history UI exists anywhere; `audit_log` is never rendered on any page (export-only). ⁴ CSV export exists (`settings/export`), without the `active` column. ⁵ Missing at **every** layer — no `updateSupplier`, `updateItem`, `updateTeam`, `reactivateMember`, or role-change function exists. ⁶ Create form silently disappears when zero item categories are configured (`items/page.tsx:75`) with no explanation. ⁷ Not in the export catalogue (items, employees, teams, members are all absent). ⁸ Create works but uses the legacy error pattern — all typed data lost on failure, generic error banner. ⁹ Deactivate/reactivate is an unlabeled `active` checkbox inside the employee edit form — functional but not discoverable as "archive". ¹⁰ Form posts `name` only; `kind` is never posted, so `"line"` teams are unreachable; `sort` unreachable. ¹¹ Invite is rate-limited; when no mail provider is configured the raw token is placed in the URL (`members/actions.ts:29` — browser-history leak). ¹² Role is immutable after invite (no service function). ¹³ Deactivate exists with correct guards (not owner, not self) but **no confirmation dialog** and no reactivate.

### 1.2 Commercial documents

| Entity | List | Srch | View | Create | Edit | Dup | Arch | React | Del | Cancel | Void | Revise | Status | Hist | Attach | Prev | PDF | Down | Send | Sev |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Quotes | ✅ | ❌ | ◐¹ | ◐² | ❌³ | ❌ | N/A | N/A | ◐⁴ | ❌ | N/A | ◐⁵ | ◐⁶ | ◐ | ◐⁷ | ❌ | ◐⁸ | ❌ | ◐⁹ | **Critical** |
| Invoices | ✅ | ❌ | ◐¹⁰ | ◐² | ◐¹¹ | ❌ | N/A | N/A | N/A | ✅ draft void | ✅¹² | N/A | ✅ issue | ◐ | ❌ | ❌ | ◐⁸ | ❌ | ◐¹³ | **Critical** |
| Credit notes | ◐¹⁴ | ❌ | ◐¹⁵ | ✅¹⁶ | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | ◐ | ❌ | ❌ | ◐⁸ | ❌ | ◐¹³ | High |
| Payments | ✅ | ❌ | ❌¹⁷ | ◐¹⁸ | N/A | N/A | N/A | N/A | N/A | N/A | ◐¹⁹ | N/A | ◐²⁰ | ◐ | ❌ | ❌ | ❌²¹ | ❌ | N/A | **High** |
| AR / receivables | ✅²² | ❌ | ❌ | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | ❌ | ❌ | N/A | Medium |

Notes — ¹ Detail page omits terms, valid-until, preset, VAT breakdown, subtotal, created date, and the rejection reason; every status badge is hardcoded `tone="info"`; `converting` status has no i18n key (renders `⟦quotes.status.converting⟧`). ² Form hardcodes **exactly one line item** while service + DB support up to 100/∞; currency forced to org base though the service is multi-currency; `valid_until` never collected; all input destroyed on validation failure. ³ **No edit at any layer** — no `updateQuote`, nothing updates `quote_line` anywhere in `src/`; no edit route. A draft with a typo is unfixable. ⁴ No DELETE grant on `quote` (0041:76-80) — deletion is structurally impossible; drafts need cancel instead (status `cancelled` is not in the quote CHECK; see §5). ⁵ `revision_of_id` column exists (0041:27) and is written by nothing. ⁶ Machine exists and is engine-enforced, but `accepted` and `expired` are unreachable dead statuses, and there is no lifecycle explanation or stepper in the UI. ⁷ `acceptance_evidence_file_id` column exists; the accept action never sends it and no upload control exists. ⁸ Bilingual branded HTML template exists; **no renderer, no stored file, no route** (§6). ⁹ "Mark as sent" is a status flip that transmits nothing (`markQuoteSent` = one UPDATE + audit). ¹⁰ Invoice detail **never renders its line items** (fetched by `getInvoice`, discarded by the page); no due date, issued date, payments applied, or remaining balance shown. ¹¹ Draft-line editing is explicitly permitted by RLS (`0042:108-113`, draft-only window) — **dead capability, nothing exercises it**. ¹² Draft → void with reason; issued → credit note; correct model, correctly enforced by column-scoped grants. ¹³ E-invoice submit goes to a fake adapter (real partner credential-gated); no email/delivery exists. ¹⁴ Interleaved in the invoices list with only a small badge. ¹⁵ A credit-note detail page renders **zero actions**. ¹⁶ Full-amount copy only — no partial credit, no line selection. ¹⁷ No `payments/[paymentId]` route and no `getPayment`; the receipt (`RCP-…`, minted on every payment) is never displayed anywhere. ¹⁸ Invoice select shows reference only — no customer, amount, or outstanding balance; no over/under-payment guard; `customerId`/`jobId` accepted by service, unreachable from UI. ¹⁹ Void works but is unrestricted by status (even `rejected` can be voided) and a failed void is **silent** (list page never renders `?error`). ²⁰ `confirmed` requires a payment approval rule; without one, payments stay `recorded` forever (which AR counts anyway). ²¹ `payment_receipt.pdf_file_id` exists, never written. ²² Two cards (total + aging buckets) with no drill-down, no invoice list, no per-customer aging, no as-of control, UTC-dated.

### 1.3 Procurement & money-out

| Entity | List | Srch | View | Create | Edit | Dup | Arch | React | Del | Cancel | Void | Revise | Status | Hist | Attach | Prev | PDF | Down | Send | Sev |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Material requests | ✅ | ❌ | ◐¹ | ✅² | ❌³ | ❌ | N/A | N/A | N/A | ◐⁴ | N/A | N/A | ✅⁵ | ◐ | ❌ | N/A | N/A | ❌⁶ | N/A | **High** |
| Purchase orders | ✅ | ❌ | ✅⁷ | ✅² | ❌³ | ❌ | N/A | N/A | N/A | ◐⁴ | N/A | N/A | ◐⁸ | ◐ | ❌ | ❌ | ◐⁹ | ❌ | ❌⁸ | **High** |
| Goods receipts | ❌¹⁰ | ❌ | ❌¹⁰ | ◐¹¹ | N/A | N/A | N/A | N/A | N/A | ◐¹² | ◐¹² | N/A | ◐ | ❌ | ❌ | N/A | N/A | ❌⁶ | N/A | **Critical** |
| Expenses | ✅ | ❌ | ✅ | ◐¹³ | N/A | ❌ | N/A | N/A | N/A | N/A | ✅ | N/A | ◐¹⁴ | ◐ | ◐¹⁵ | N/A | N/A | ✅ | N/A | Medium |
| Job costing | ✅ | N/A | ✅ | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | ❌ | N/A | Low¹⁶ |

Notes — ¹ MR detail **never renders `?error`** — submit and convert failures are completely silent; `pendingApprovalId` fetched and unused; UI restricts submit to the creator (stricter than the service — an admin cannot submit someone's MR). ² The two best create forms in the app: client components with multi-line editors and **no data loss on failure** — but no remove-line control, one generic error message for every cause, and money entered in raw **minor units** ("Unit cost (minor)") while expenses take major units. ³ No `updateMaterialRequest`/`updatePurchaseOrder` at any layer — a draft with a wrong line cannot be corrected, only abandoned (and it can't be cancelled either → permanent list clutter). ⁴ `cancelled` is in both DB CHECKs and **written by nothing**. ⁵ draft → submitted → approved/rejected → converted, engine-enforced; withdraw exists in the service only. ⁶ MRs/POs/GRNs absent from the export catalogue. ⁷ Good detail: per-line ordered/received table, awaiting-approval badge. ⁸ `sent` is read by six call sites and written by nothing — "mark sent" does not exist as a transition; no close; no cancel. ⁹ The "Download LPO PDF" element is an **inert `<span>`**, permanently showing "LPO PDF pending render" (Arabic: "قيد الإنشاء" — an in-progress claim with no renderer behind it). The one misleading document claim in the app. ¹⁰ **No GRN UI exists at all** — no route, list, or detail; a receipt's reference, date, notes and per-line values are unreachable the moment it is recorded. ¹¹ Recording happens via an inline card on the PO page: quantities only (damaged/rejected never collected though the cost rollup subtracts them), hidden UTC date, no notes, all quantities lost on error, not gated by `cap.goods_receipts` (fails generically). ¹² `cancelGoodsReceipt` (`grn.cancel`, owner/admin) is implemented and tested — **no action, no UI**. A mis-keyed receipt permanently overstates job cost. ¹³ Plain server form: all six fields wiped on failure; `receiptFileId` supported and has no upload control; raw category keys shown in list/detail. ¹⁴ `payment_status` (`unpaid`/`paid`) is modelled, granted, read by dashboards and export — and written by nothing; "unpaid expenses" permanently equals "all expenses". ¹⁵ Receipt attachment schema-supported, no UI. ¹⁶ Costing is deliberately read-only and correctly redacted; its gap is continuity (no drill-down to the POs/GRNs/expenses behind each figure — §8).

### 1.4 Operations

| Entity | List | Srch | View | Create | Edit | Dup | Arch | React | Del | Cancel | Void | Revise | Status | Hist | Attach | Prev | PDF | Down | Send | Sev |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Jobs | ✅ | ◐¹ | ✅ | ◐² | ✅³ | ❌ | ◐⁴ | ◐⁴ | N/A | ✅⁵ | N/A | N/A | ✅ | ✅⁶ | ✅ | N/A | N/A | ✅ | N/A | Medium |
| Stages / presets | ✅ | N/A | ✅ | ◐⁷ | ◐⁷ | ❌ | ◐⁷ | ◐⁷ | N/A | N/A | N/A | ✅⁸ | ✅ | ◐ | N/A | N/A | N/A | N/A | N/A | Medium |
| Daily reports | ◐⁹ | ❌ | ✅ | ✅¹⁰ | ✅¹¹ | ❌ | N/A | N/A | N/A | N/A | N/A | ✅¹¹ | ✅ | ◐ | ◐ | N/A | N/A | ✅ | N/A | Medium |
| Attendance | ✅ | ◐ | N/A | ✅ | ✅¹² | N/A | N/A | N/A | ❌¹³ | N/A | N/A | N/A | N/A | ❌ | N/A | N/A | N/A | ❌ | N/A | Low |
| Issues | ✅ | ❌ | ❌ | ◐¹⁴ | ❌³ | ❌ | N/A | N/A | N/A | N/A | N/A | N/A | ◐¹⁵ | ◐ | ❌ | N/A | N/A | ❌ | N/A | **High** |
| Approvals | ✅¹⁶ | ❌ | ❌¹⁷ | N/A | N/A | N/A | N/A | N/A | N/A | ◐¹⁸ | N/A | N/A | ✅ | ❌¹⁷ | N/A | N/A | N/A | N/A | N/A | **High** |
| Customer updates | ✅ | ❌ | ✅ | ✅ | ✅ draft | ❌ | N/A | N/A | N/A | N/A | ✅ revoke | N/A | ✅ | ◐ | ◐¹⁹ | ✅²⁰ | N/A | N/A | ◐²¹ | Medium |

Notes — ¹ Stage/overdue filters via query params; no search, no archived view. ² Create form omits start/due dates and manager though the service accepts them; no `jobs/new` route (inline form). ³ Jobs are the best-edited entity (full core edit + status + stages + crew + pricing + override). Issues are the worst: title/description/severity/blocker are frozen at creation. ⁴ `archived` column read by every list (`archived = false`) and written by nothing — jobs accumulate forever; `done`/`cancelled` statuses are the workaround. ⁵ Via the generic status select (covers hold/resume/complete/cancel) — works, but is one anonymous dropdown, not explicit labeled transitions. ⁶ The job Activity tab is the **only** per-entity history surface in the entire app. ⁷ Presets/stage templates: the config pipeline fully supports create/edit/retire with referential guards and revisions (`pipeline.ts:323-404`) — **no UI exists post-onboarding**; onboarding renders stages read-only. ⁸ Config revisions + undo — the house revision model. ⁹ **No `/reports` index route** (404); no reports list on the job page (`listJobReports` has zero callers); entry points are only `/reports/new` and `/reports/review`. ¹⁰ The report composer is the best form in the app: client state, localStorage draft, offline retry, result-object action. ¹¹ The correction loop exists and is correct: draft/returned editable (lines soft-superseded, never deleted), submitted immutable to author, reviewer returns with required reason → author edits and resubmits. The DB additionally allows reviewer material-line correction on submitted reports (0031:64-75) — **unimplemented at service/action/UI**. ¹² Correction = overwrite by re-clicking a status chip (manual wins over derived). ¹³ No way to clear a day back to "unmarked"; note field accepted by service, never posted. ¹⁴ The form **never posts `job_id`** (the action reads it; no control is rendered) — every UI-raised issue is org-wide and job-less; no raise-issue control on the job page. ¹⁵ Only `resolved` and `open` reachable; `in_progress`/`closed` unreachable; `assignIssue` service-only (issues can never be assigned). ¹⁶ Pending inbox only. ¹⁷ No `approvals/[approvalId]` route (`getApproval` orphaned), no decided/history view, and the subject deep-link is hardcoded — **`quote_send` and `payment` approvals link to a nonexistent `/material-requests/<id>` URL**. ¹⁸ `withdrawApproval` service-only — a requester cannot pull back their own pending request. ¹⁹ Shared snapshot's `photoFileIds` hardcoded `[]` — photos can never be shared. ²⁰ The public `/s/[token]` page is the one true customer-facing document surface (safe snapshot, rate-limited, no enumeration). ²¹ Share link revealed once; **unrecoverable after leaving the page** (re-send is draft-only, so revoke + re-send cannot re-mint).

### 1.5 Administration

| Entity | List | Srch | View | Create | Edit | Dup | Arch | React | Del | Cancel | Void | Revise | Status | Hist | Attach | Prev | PDF | Down | Send | Sev |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Imports | ✅ | N/A | ✅ preview | ✅¹ | N/A | N/A | N/A | N/A | N/A | N/A | ❌² | N/A | ✅ | ◐ | ❌³ | ✅ | N/A | N/A | N/A | Medium |
| Configuration / onboarding | ✅ | N/A | ✅ | ✅ install | ◐⁴ | N/A | N/A | N/A | N/A | N/A | N/A | ✅ undo | ✅ | ✅⁵ | N/A | ✅ diff | N/A | N/A | N/A | Medium |
| Subscription | ✅ | N/A | ✅ | ✅ | ✅ | N/A | N/A | N/A | N/A | ✅⁶ | N/A | ✅ | ✅ | ✅⁷ | N/A | N/A | N/A | N/A | N/A | — complete |
| Data export | ✅ | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | ✅⁸ | N/A | Low |

Notes — ¹ Paste-only (no file upload); three kinds (customers, employees, items); staged → previewed → applied through the governed masters services; row-level errors, re-runnable, concurrency-safe. ² No undo after apply — by design; the safe alternative is managing the created records individually, **which is currently impossible** (no master-data edit/archive UI) — imports compound the §1.1 gaps. ³ CSV text only. ⁴ The revision engine covers 13 artifact types with guards and undo; the UI exposes **terminology only** (+ undo of listed revisions). Stages, statuses, categories, reference patterns, custom fields, roles, holidays: engine-ready, UI-absent. Template switching is blocked post-install ("post-MVP migration story"). ⁵ Revision history with truncated diffs and per-revision undo — the best history UI in the app. ⁶ Cancellation through the real state machine; removals scheduled to period end; never deletes data. ⁷ 40-entry subscription audit history rendered in-page. ⁸ Eight CSV entities; missing items/employees/teams/members/MRs/POs/GRNs; no date range; no bundle.

### 1.6 N/A cells — the safe alternative for each

- **Master-data delete** → deactivate (`active=false`) + archived filter + reactivate; hard-delete may be offered later only for records with zero references (requires a reference check that does not exist yet — not recommended for pilot).
- **Quote/MR/PO delete** → cancel transition with reason (statuses already exist in the DB CHECKs for MR/PO; quotes need a `cancelled` status decision — §5/§11); history preserved.
- **Invoice edit-after-issue / delete** → void before issue (exists), credit note after issue (exists); replacement invoice = new draft (duplicate action, to be built).
- **Payment edit/delete** → void with reason (exists); re-record correctly.
- **Report edit-after-submit** → reviewer returns with reason → author revises and resubmits (exists).
- **GRN edit** → cancel the receipt and re-record (service exists — needs action + UI).
- **Attendance delete** → overwrite with the correct status (exists); "clear to unmarked" is a real gap, not an N/A.
- **Customer-update edit-after-send** → revoke the share token (exists) + send a corrected update (needs "duplicate as new draft").
- **Configuration edit** → validated config revisions + undo (exists; expose more artifact types).

### 1.7 Service/DB capabilities that exist with no UI (build-ready inventory)

These need **no migration and no new service logic** — only actions/UI (unless noted):

| Capability | Where it exists | Missing |
|---|---|---|
| Edit customer | `updateCustomer` (`masters/service.ts:330`), audited | action + UI (and a wider `listCustomers`/`getCustomer` read) |
| Cancel goods receipt | `cancelGoodsReceipt` (`supply/service.ts:665`), tested, `grn.cancel` perm | action + UI |
| Withdraw approval | `withdrawApproval` (`approvals/service.ts:669`), `onWithdraw` configured for all 4 subjects | action + UI |
| Assign issue | `assignIssue` (`issues/service.ts:176`), `issues.resolve` perm | action + UI |
| Approval detail | `getApproval` (`approvals/service.ts:855`) | `approvals/[approvalId]` route |
| Server-side report drafts | `saveReportDraft` (`reports/service.ts:420`) | action + composer wiring |
| Draft-invoice line editing | RLS window `0042:108-113` (draft-only) | service fn + action + UI |
| Reviewer material-line correction | RLS window `0031:64-75` (submitted) | service fn + action + UI |
| Quote multi-line, multi-currency, `valid_until`, acceptance evidence, `revision_of_id` | service/schema (`quotes/service.ts:62`, 0041) | form fields + actions |
| MR/PO/quote `cancelled`, PO `sent` statuses | DB CHECKs (0035, 0041*) | status-writer service fns + UI (*quote `cancelled` not in CHECK — needs decision) |
| Expense `payment_status='paid'` | column + grant (0038:30-31,69) | service fn + action + UI |
| Payment `customerId`/`jobId`, expense `receiptFileId`, MR/PO line `itemId` | input schemas | form fields |
| Attendance `note` | `MarkAttendanceInput:37` | form field + action wiring |
| Employee/customer/supplier/team missing fields (`notes`, `contactName`, `termsText`, `minQty`, team `kind`/`sort`) | input schemas | form fields |
| Approval-rule management | `createApprovalRule`/`listApprovalRules`/`validateRules` | settings UI (post-pilot candidate) |
| Config artifacts beyond terminology | `pipeline.ts` closed registry, guarded | settings UI (staged; §10) |
| Customer-update body suggestion | `suggestBody` (`customer-updates/service.ts:122`) | UI button |
| Team `"line"` kind | `TeamInput` | form field |
| Member reactivate / role change | **nothing — needs new service functions** (platform `identity.ts`) | all three layers |
| Supplier/item/team edit | **nothing — needs new service functions** | all three layers |

---

## 2. Dependency interruption audit

Current behavior when a required/related record does not exist, per form. "Data lost?" refers to what happens if the user navigates away to create the missing record.

| Form → dependency | Behavior when missing | Must leave form? | Data lost? | Perm to create dep | Proposed inline create |
|---|---|---|---|---|---|
| Quote → customer | Select shows only "—"; no link, no hint | Yes (`/customers`) | **Yes** — server form, everything retyped | `customers.manage` (owner/admin/manager — same roles as `quotes.manage` ✅) | **Yes** — flagship case (§3) |
| Quote → preset | Optional at create, **required at accept** — a preset-less quote is a dead end diagnosed only as a generic error | n/a (presets not user-creatable at all) | — | none (onboarding-only) | **No** — fix by rule, not creation: warn at create ("cannot be converted without a workflow"), block accept with a specific message, or make conversion preset-optional (§11-D2) |
| Invoice → customer / job | Both optional selects, existing-only, no link | Yes | **Yes** | `customers.manage` / `jobs.create` | Customer: yes. Job: no — link out (job creation is a real workflow) |
| Job → customer / preset / foreman | Customer select hidden when list empty; preset required (exists post-onboarding); foreman select hidden when no members | Yes | **Yes** (inline server form) | `customers.manage` / — / `members.invite` (multi-day: invite → accept) | Customer: yes. Foreman: no — show "invite a teammate" link + allow foreman-less create (already allowed) |
| MR → job / item | Job optional; lines accept **free-text item names** with optional catalogue link | No | No (client form) | — | Not needed — free-text lines are already the correct interruption-free design; add optional "save to catalogue" later |
| PO → supplier / item / MR | **Supplier required, existing-only; zero suppliers = dead form** with only "—" | Yes | No (client form retains state) — but the round trip is still a workflow break | `catalog.manage` (owner/admin/manager/**procurement** ✅ — procurement can create suppliers) | **Yes** — second flagship case |
| PO ← MR (convert) | Supplier select on MR detail; same zero-supplier dead end; failure is **silent** (`?error` never rendered) | Yes | Yes (supplier + VAT re-picked) | `catalog.manage` | Yes — same component |
| Expense → job / supplier | Job optional (= Overhead). Supplier: **N/A by design** (F-2 disjoint channels — expense vs PO receipt) | No | — | — | Not needed |
| Payment → invoice / customer | Invoice optional; list shows references only (no amount/customer/balance); customer field unreachable | No | — | — | Not creation — **context**: show customer + outstanding balance per invoice option; wire `customerId` |
| Report → job / employees / items | Job required (picker step exists ✅); workers from crew (add crew on job page); materials free-text + catalogue ✅ | Partially (crew) | No (localStorage draft ✅) | `crew.manage` | No — report composer already survives interruption; add "manage crew" link |
| Issue → job / assignee | Job control **never rendered** (bug — action reads `job_id`); assignee has no UI at all | n/a | Yes | — | Not creation — render the job select; add raise-issue on the job page (pre-scoped); wire `assignIssue` |
| Employee → team | Team select hidden when no teams; team create form is adjacent on the same page ✅ | No | **Yes** (separate forms — submitting one clears the other via redirect) | `employees.manage` (same key ✅) | Acceptable as-is once error handling stops wiping forms |
| Customer update → customer / job | Both optional, existing-only | Yes | Yes | `customers.manage` | Customer: yes (same component) |

**Failure/duplicate handling common to all inline creates:** duplicate display names are legal for customers/suppliers (by design; only item SKU is unique) — so the inline dialog must *offer* near-matches ("Use existing / create anyway") rather than error; validation failures keep both parent and child state (§3); permission/entitlement absence hides the "add new" affordance entirely (never a dead button).

---

## 3. Inline-create interaction standard (one reusable pattern)

**Platform gap:** no dialog/drawer primitive exists today (`src/platform/ui/` has only the header popover `Menu`). The standard therefore specifies two new platform pieces, built once and reused everywhere:

1. **`Dialog`** (`src/platform/ui/Dialog.tsx`) — accessible modal on `<dialog>`/focus-trap semantics: Escape + backdrop close with confirm-if-dirty, focus returned to the opener, `≥44px` targets, logical properties only (RTL-safe), motion-safe transitions, **bottom-sheet presentation at mobile widths**. No portal-side data access — purely presentational.
2. **`RelationshipField`** (client) — wraps a `<select>` (options server-supplied) plus, when the caller passes `canCreate: true`, a trailing **"+ Add new {term}"** item that opens the Dialog with a small child form.

**Contract (applies to every use):**
- **Where it appears:** inside the selector, as the last option / adjacent button — never a separate page link.
- **State preservation:** the child form lives in the Dialog; the parent form's DOM/client state is untouched because **no navigation occurs**. Child submission uses a **typed server action returning a result object** (`{ok:true, id, label} | {ok:false, error, correlationId}`) — the established branding/subscription/MrForm pattern, not a redirect. Server-side boundary is unchanged: the action calls the existing audited `command()`-based create service (e.g. `createCustomer`); **no browser-side Supabase access, ever**.
- **On success:** dialog closes, the new `{id, label}` is appended to the select's options client-side and selected; a small "created" note names it. No full-page reload required; a `router.refresh()` may follow to reconcile server truth.
- **On validation failure:** the error renders inside the dialog against the offending field (the `Field` primitive already supports `error`); child input is retained; parent untouched. Correlation id shown for `server_error`.
- **Duplicates:** before submitting, the child form shows existing near-matches (case-insensitive contains over the already-loaded options — no new query) with "use this instead"; server 23505 (items/SKU) maps to the `duplicate` message with field focus.
- **Permissions & entitlements:** the server page computes `canCreate = can(archetype, "<entity>.manage")` (+ capability where relevant, e.g. `cap.items`) and passes a boolean; without it the affordance does not render. The server action re-asserts regardless (defense in depth — already how every service works).
- **Mobile & RTL:** bottom-sheet ≤640px; logical properties; Arabic labels via the same i18n keys; numbers stay LTR islands.
- **Scope of the child form: minimum viable fields only** (customer: name + phone; supplier: name) with an "open full form" link for the rest — the created record is immediately valid because the underlying Zod schema's required set is exactly that small.

**When inline create is appropriate:** master-data dependencies with ≤4 required fields and no side effects — customers (from quote/invoice/job/customer-update), suppliers (from PO/MR-convert), items (from catalogue-linked lines), teams (from employee form).
**When a full-page workflow is required:** anything with financial/legal consequence (invoices, payments), multi-step or stateful creation (jobs, onboarding, imports), records needing file upload as a first-class step, or anything whose creation triggers approvals. There the standard is a **link out + returning deep-link** (`?return=<current-url>`) only if the origin form is a state-preserving client form; otherwise don't offer the detour at all — fix the origin form first.

---

## 4. Editability standard

Uniform rules, to be applied by every slice in §10 (current violations in parentheses):

1. **Every list row is clickable** and opens the record's detail page (violated: customers, suppliers, items, teams, payments, issues — plain `<li>`s today).
2. **Every mutable record's detail page carries Edit** — inline form or edit route (violated: customers, suppliers, items, teams, quotes, invoices, MRs, POs, issues).
3. **Rows with more than one action get an accessible actions menu** (the existing `Menu` primitive) — list rows never carry bare destructive buttons (violated: members deactivate, payments void are naked list-row forms today).
4. **Forms support Save and Cancel**; Cancel returns without saving and warns when dirty (nothing implements dirty-warning today; add to the Dialog and rich client forms first).
5. **Validation failures preserve input** — §9 sets the single standard.
6. **Successful changes return to a predictable place**: detail page of the thing changed (create → its new detail; edit → same page with a saved note; destructive → the list with a note naming the record).
7. **Destructive/irreversible actions require explicit confirmation that explains impact** ("Void payment PMT-0007 — the linked invoice INV-0004 returns to Partially paid. Requires a reason."). Applies to: void invoice/payment/expense, cancel GRN/MR/PO/quote, deactivate member/employee/customer/supplier/item, issue invoice (irreversible the other way — §7).
8. **Archived/deactivated records stay discoverable** via an explicit filter (Active ▾ / All / Archived) on every master list; archived rows are visually muted and offer Reactivate.
9. **Referenced history never changes**: deactivating a customer/supplier/item never alters existing quotes, invoices, jobs, POs, or reports (all documents snapshot names/costs already ✅ — keep it that way); deactivation only removes the record from *pickers*.
10. **Immutable fields are explained, not mysteriously disabled**: issued invoice amounts, submitted report lines, employee↔user link, preset `code`, role archetype, in-use status semantics — each shows a one-line reason ("Issued invoices are legal records — correct with a credit note") instead of a silently missing control. The status-badge tones must also tell the truth: replace both detail pages' hardcoded `tone="info"` with the list pages' existing tone maps, and add the missing `converting` key.

---

## 5. Quote lifecycle audit

### 5.1 The lifecycle as actually implemented (verified in code)

DB CHECK (0041:24-26): `draft · pending_approval · approved · sent · converting · accepted · rejected · expired · converted`.

```
draft ──submit──► pending_approval ──approve (engine)──► approved ──mark sent──► sent
  ▲                    │  └─ auto-approve: ONLY when a matched approval rule       │
  │                    │     has auto_approve_below_minor > amount; a fresh org    │
  │                    │     with no rules routes everything to the owner          │
  │◄─ engine reject ───┘                                                           │
  │                     approved/sent ──accept (requires preset)──► converting ──► converted (terminal)
  │                          │                  └─(job creation fails)──► approved
  └─ resubmit ◄── rejected ◄─┴── reject (reason required; "terminal" per docstring, resubmittable in code)
UNREACHABLE: accepted, expired  (no writer anywhere; no expiry worker; valid_until never populated)
```

- **Approval:** through the approvals module (`quote_send` subject); the engine is the sole writer of the decided transition; the submitter-side auto-approve advance happens in the same transaction.
- **Conversion requirements:** `preset_id is not null` + `quotes.manage` + **transitively `jobs.create`**; foreman NOT required. Creates a job from the preset (stages + billing points seeded), copies quote total → job selling price and terms, stamps `converted_job_id`, emits `QUOTE_ACCEPTED`, then **redirects the user away to the job**.
- **After conversion:** nothing on the quote side; the terminal state offers only a "View converted →" link. The `QUOTE_ACCEPTED` event triggers a PDF worker that builds HTML and discards it (§6).
- **"Mark sent"** is one guarded UPDATE + an audit row. Nothing is transmitted to anyone.
- **Acceptance is recorded internally** (a note field; the evidence-file column is never supplied). There is no customer portal and no share link for quotes — "accepted" means "someone in the office says the customer accepted".

### 5.2 Confirmed gaps

1. **No lifecycle explanation anywhere** — no stepper, no next-action hint; detail-page badges are all `tone="info"`; `converting` renders a raw `⟦quotes.status.converting⟧` marker.
2. **No draft editing** at any layer (no service fn; nothing anywhere updates `quote_line`). The only forward move for a typo'd draft is submit-for-approval.
3. **No duplicate/revise** — `revision_of_id` exists in the schema, written by nothing.
4. **No cancel/expire** — `expired` unreachable, no `cancelled` in the quote CHECK, drafts accumulate forever.
5. **Customer cannot be created inline**; the customer is even optional, producing quotes with no customer that read as broken.
6. **Single-line form confirmed** — the page statically renders one line; service/DB accept up to 100.
7. **Approval behavior invisible** — the submitter can't see who it's waiting on or how long; the approvals inbox deep-link for `quote_send` is broken (points at material-requests).
8. **"Mark sent" doesn't send** (§5.1) — truthful relabeling required.
9. **Acceptance is internal** — fine for the pilot, but the UI should say so ("Record the customer's decision") rather than imply a portal.
10. **PDF/preview/download: none** (§6); the branded bilingual template exists and is reachable by no user.
11. **Preset requirement surfaces as a generic error** at the last possible moment (accept), though it is knowable at create time.
12. **Rejected → resubmit** leaves the old `rejected_reason` in place, and the docstring contradicts the code on terminality.
13. Stranded `converting` (crash between claim and finalize) has no recovery action and renders no buttons at all.

### 5.3 Designed customer-facing workflow (target)

1. **Create & edit draft** — multi-line editor (client component, MrForm pattern: add/remove/reorder rows, item catalogue link optional, free descriptions), customer via `RelationshipField` (inline create, §3), optional `valid_until` (default from settings), preset picker with an honest hint: *"Choose a workflow now so an accepted quote can start work; you can also add it before accepting."* Draft is editable until submitted (`updateQuoteDraft` service fn: draft/rejected-only guarded update; lines replaced via the report-composer's soft-supersede idiom or delete-and-reinsert while draft — decision recorded in §10 003C).
2. **Lifecycle stepper** on the detail page: Draft → Approval → Approved → Sent → Decision → Converted, current step highlighted, dead paths (rejected/expired/cancelled) shown as exits, one **primary next action** per state (draft: "Submit for approval"; pending: "Waiting for {role} — {n} days" + withdraw; approved: "Preview & send"; sent: "Record customer decision"; converted: "Open {job}").
3. **Preview** — a print-fallback route rendering the existing `quoteHtml` template (§6): branded, bilingual, opened from Draft onward, watermarked "DRAFT" until approved.
4. **Submit for approval** with visible progress (who, since when) via a quote-side approval card reusing `getApproval`; withdraw available to the requester.
5. **Download/print** — browser print / Save-as-PDF from the preview route now; a real stored PDF later (§6).
6. **Send** — "Mark as sent manually" wording until a provider exists; record method (email/WhatsApp/in person) as a note.
7. **Record decision** — Accepted (with optional evidence upload once PDFs/images are allowed for that class) / Rejected (reason) / Expired (manual, or automatic when `valid_until` passes once workers run).
8. **Convert** — validated up front; on success land on the job **with a persistent "created from quote QT-…" back-link on the job**, and a "Converted → JOB-…" banner on the quote.
9. **Duplicate / revise** — "Duplicate" copies lines into a new draft; "Revise" does the same and sets `revision_of_id`, offering to mark the original superseded/cancelled. History never destroyed.

Every quote detail page shows the stepper and exactly one primary action; secondary actions live in an actions menu.

---

## 6. PDF and document-delivery truth

### 6.1 Layer-by-layer truth (verified)

| Layer | Quote | Invoice | Purchase order (LPO) | Customer update |
|---|---|---|---|---|
| HTML template | ✅ full doc, bilingual, branded (`quote-template.ts`) | ◐ **fragment** (no `<html>` wrapper); ZATCA QR renders as truncated *text*, not an image | ✅ full doc, bilingual, branded (`lpo-template.ts`) | ❌ (React share page instead) |
| Worker seam | ✅ wired to `QUOTE_ACCEPTED` | ✅ wired to `INVOICE_ISSUED` | ✅ wired to `PURCHASE_ORDER_APPROVED` | ❌ (`CUSTOMER_UPDATE_SENT` has no consumer) |
| Actual PDF renderer | ❌ **no PDF library exists in the dependency tree** (only `@playwright/test` as a devDependency for e2e) | ❌ | ❌ | n/a |
| Stored PDF | ❌ `pdf_file_id` columns exist on PO/invoice/receipt — **never written by any code**; the upload allowlist is images-only (PDF mime forbidden); no download route exists | ❌ | ❌ | ❌ |
| User can download | ❌ | ❌ | ❌ — worse: an **inert `<span>`** claims "LPO PDF pending render" forever | n/a |
| User can print / Save-as-PDF | ❌ — no print route, no `@media print` CSS, no print button anywhere in the app | ❌ | ❌ | ◐ (the share page prints as a webpage) |
| Email/send provider | Resend REST wrapper exists; **its only caller is the membership invite email**; plain-text only; key unprovisioned | same | same | same |
| Inngest dependency | The workers — and the **outbox relay itself** — are Inngest functions. Unprovisioned ⇒ events accumulate in `domain_event` and the async half of the product never runs | same | same | same |
| Production provisioning | `INNGEST_SIGNING_KEY`/`INNGEST_EVENT_KEY`, `RESEND_API_KEY` — standing owner actions; serve route correctly 503s meanwhile | same | same | same |

**Bottom line: no user can obtain any document from IdaraWorks today.** Three good templates terminate at a `logger.info` inside workers that cannot execute. The only customer-deliverable artifact is the customer-update share *page*, delivered by manual copy-paste. Also note `addon.branding_docs` is sold as "your logo on printed quotes, invoices and purchase orders" — the slots exist, but no printed document does; the print-fallback below makes that add-on observable.

### 6.2 Launch-safe fallback (recommended, no new dependencies)

1. **Branded print/preview routes** — server-rendered pages that reuse the existing template builders (wrapped for the invoice fragment): `quotes/[quoteId]/print`, `invoices/[invoiceId]/print`, `purchase-orders/[id]/print`. Permission = the entity's `.view` key; DRAFT watermark pre-approval; `@media print` CSS (hide chrome); a "Print / Save as PDF" button calling `window.print()`.
2. **"Download PDF" appears only when a real file exists** — i.e. nowhere, today. Replace the PO detail's inert span with a truthful "Print / Save as PDF →" link to the print route.
3. **"Mark as sent manually"** wording on quotes (and later invoices) until a provider actually transmits; the confirmation states "IdaraWorks does not send this for you yet."
4. E-invoice UI must say the provider is a stub until the ZATCA partner is credentialed.

### 6.3 The later real solution (post-provisioning)

Once Inngest + Resend are provisioned (owner actions) and a renderer is chosen: a rendering worker (headless-chromium class, e.g. playwright-core/@sparticuz on a worker runtime — dependency decision at that time) renders the same HTML → uploads to the `tenant-docs` bucket under the `financial_doc` class (extend the upload allowlist to `application/pdf` for **worker-generated** files only), writes `pdf_file_id` transactionally, a signed download route serves it, and "Download PDF" lights up truthfully. Email delivery then attaches or links it; `CUSTOMER_UPDATE_SENT` gets a consumer. The print-fallback routes remain as the preview surface — nothing is wasted.

---

## 7. Invoice lifecycle audit

**Verified:** draft create ✅ (single-line form; multi-line service). Draft **editing ❌** (RLS window exists for draft lines; nothing exercises it — the only correction today is void + re-create, losing the reference number). Issue ✅ (`draft → issued`, stamps `issued_at`, emits `INVOICE_ISSUED`). **Immutability after issue ✅ and enforced at the grant level** — amounts/lines/customer are not updatable by `app_user` in any status; only status/cancel/pdf columns are grant-updatable. Void ✅ draft-only with reason ("issued → credit note" is the service's own error text). Credit note ✅ — a new `invoice` row (`kind='credit_note'`, `CN-…` ref, auto-issued, full-amount copy; **no partial credit**); reconciliation counts it. Payments ✅ recorded/voided with correct reconciliation (`paid + credited >= total → paid`; void reopens). Partially-paid ✅ derived, never stored wrong. PDF/print ❌ (§6). E-invoice: adapter is a stub; real partner credential-gated. **Next action seen by the user: none** — the detail page renders totals and buttons with no guidance, and doesn't even render line items, due date, payments applied, or remaining balance.

**The good news:** an issued invoice shows **no misleading Edit or Delete today** — the requirement "never offer them" is already met by absence. The work is to *add* what's missing without breaking that: draft edit (draft-only, guarded like the RLS window), an **issue confirmation dialog** that explains irreversibility ("This becomes a legal record — correct it afterwards with a credit note"), rendered line items/due date/payment history/remaining balance, a credit-note back-link pair, an explained-immutability note on issued invoices (§4 rule 10), print/preview (§6), and next-action guidance (draft → "Issue"; issued unpaid → "Record payment"; paid → "Done ✓").

---

## 8. Workflow continuity standard

Every completed action offers the logical next step. Current state, verified:

| Continuity | Today | Gap |
|---|---|---|
| Customer created → create quote/job | ❌ generic saved-banner on the list | Offer "Create quote / job for {name}" |
| Quote accepted → open converted job | ✅ redirect + link | Keep; add the reverse link on the job ("from QT-…" — currently **no link back**) |
| Job completed → create invoice | ❌ nothing | On status→done (with `cap.invoicing` + `invoices.manage`): "Invoice this {job}" pre-filled via the existing-but-unused `quoteId`/job linkage |
| Invoice issued → record payment | ❌ nothing | "Record payment" pre-selecting the invoice |
| Payment recorded → open reconciled invoice | ❌ lands on payments list; payment rows don't even link to their invoice | Land on the invoice with its new status; link payment rows |
| MR approved → create PO | ✅ convert card on MR detail | Keep; fix silent errors; add supplier inline-create |
| PO received → open receipt / job cost | ❌ GRN invisible; costing unreachable from PO | GRN list on PO detail; "View job costing" link when job-linked |
| Issue resolved → return to job | ❌ issues aren't even job-linked from the UI | Fix job linkage first; then link back |
| Report submitted → open job / submit another | ◐ composer confirms; job quick-form lies (`?notice=submitted` even when deduped) | "Open {job} / Next report" actions; make the quick-form report dedup truthfully |
| Approval decided → notify requester with reason | ✅ notification carries the note | Add the approval detail route so the notification has somewhere to land |
| Costing figure → contributing POs/GRNs/expenses | ❌ bare numbers | Drill-down links (read-only, existing permissions) |
| Job detail → its MRs/POs/expenses/costing/reports | ❌ none of these are reachable from the job | Job-detail links/tabs for each (respecting each surface's own permission) |

---

## 9. Error-recovery audit

Three incompatible idioms coexist:

| Idiom | Data survives? | Field-level? | Duplicate explained? | Permission message? | Ref id? | Used by |
|---|---|---|---|---|---|---|
| A. `failMasterDataAction` (redirect + echo) | ◐ — all except `SENSITIVE_ECHO` fields (email/phone/tax/cost/price are wiped — often the failing field itself) | ✅ focus + message | ✅ (23505; names legal-dup aware) | ✅ specific + read-only-billing + not-entitled | ✅ | customers, suppliers, items |
| B. Typed result object (no redirect) | ✅ fully | ✅ (subscription: 15 codes; branding: 9) | ✅ | ✅ | ✅ | branding, subscription, report composer, MR/PO create (**but these collapse every code to one generic message**) |
| C. Legacy `?error=<code>` redirect | ❌ everything wiped | ❌ | ❌ | ❌ generic | ❌ (and **no server logging**) | people (5), members (3), quotes, invoices, payments, expenses, jobs, issues, attendance, approvals, customer-updates, imports, reports review — the majority |

Additional confirmed defects: the MR detail page **never renders `?error` at all** (silent submit/convert failures); the payments list renders `?ok` but not `?error` (silent void failures); the GRN inline form loses all quantities; state-transition conflicts (`?error=state`) never say which state is required; specific service messages ("quote has no preset to convert from") never reach users; MFA-lapsed users on MR/PO create get a dead generic error instead of the `/mfa` redirect every other form performs; retry safety exists only where idempotency keys exist (reports ✅, payments ✅, everything else relies on double-submit luck).

**Standard going forward (per slice):** rich/multi-field forms → idiom B (client form + typed result, per-field errors, nothing lost — the report composer is the model); simple 1–3-field server forms → idiom A extended (widen `MasterEntity`, keep the denylist but compensate: because sensitive fields cannot ride the URL, any form containing them should graduate to idiom B rather than wipe them); every page that receives `?error` must render it, specifically; every state-conflict message names the required state; every destructive action's failure is visible. `SENSITIVE_ECHO` itself stays — it is a correct privacy control; the fix is pattern choice, not weakening it.

---

## 10. Prioritized implementation plan — independently deployable slices

Ordering rationale: 003B unblocks the owner's named defect and builds the two reusable foundations (Dialog/RelationshipField + the error standard) everything else consumes; 003C is the flagship commercial workflow; 003D completes money-in; 003E protects cost integrity (GRN correction is a financial-truth issue); 003F sweeps operations; 003G hardens cross-cutting behavior. Each slice ships alone behind the normal gates (format/lint/typecheck/unit/build + CI) and is rollback-safe by revert because none changes existing data semantics.

### 003B — Customer completeness + reusable inline-create foundation
**Scope:** widen `listCustomers`/add `getCustomer`; customer detail page with edit (wire the orphaned `updateCustomer`), deactivate/reactivate with confirmation, archived filter; clickable rows; `Dialog` + `RelationshipField` platform primitives; inline customer creation from the quote form (and the quote form becomes a state-preserving client form as the carrier); error idiom A/B applied.
**Files/modules:** `modules/masters/service.ts` (reads only — update exists), `app/…/customers/*` (new `[customerId]/`), `platform/ui/Dialog.tsx` + `RelationshipField.tsx`, `app/…/quotes/new/*` (client form shell), i18n en/ar, unit + e2e tests.
**Migration:** none expected — `updateCustomer` already works, `active` column exists; **verify UPDATE grants for customer columns before coding** (if a grant is missing → sequential migration `0074+`, append-only).
**Permissions:** none new — `customers.manage`/`customers.view` already cover everything.
**Audit events:** already emitted by `updateCustomer` via `command()`; deactivation audits as an update (`active`).
**Tests:** service (deactivate hides from pickers, history untouched), action (error echo/typed result), render (RTL/mobile dialog), e2e (create-customer-inside-quote round trip preserving quote fields).
**Risk:** low (additive routes + one new primitive). **Rollback:** revert commit; no data shape changes.

### 003C — Quote workspace
**Scope:** multi-line editable draft (`updateQuoteDraft` + line replacement for draft/rejected only), lifecycle stepper + one primary action, preview/print route (§6.2), truthful "Mark as sent manually", duplicate + revise (`revision_of_id`), cancel/expire per owner decisions D1/D2, converted-job continuity (both directions), fix `converting` i18n + tone maps, withdraw-approval action, fix the approvals deep-link, preset-requirement surfaced at create/accept with specific messages.
**Files:** `modules/quotes/service.ts` (+update/duplicate/cancel fns), `app/…/quotes/*` (form → client component, `[quoteId]` restructure, `print/` route), `modules/approvals` (withdraw action only), i18n, tests.
**Migration:** likely **one** (`0074`): quote `cancelled` status in the CHECK (if D1 approves) — everything else (multi-line, `valid_until`, `revision_of_id`, evidence) already exists in schema. Draft-line editing needs an UPDATE/DELETE-while-draft grant on `quote_line` mirroring the invoice pattern → include in the same migration if absent.
**Permissions:** none new (`quotes.manage` covers all transitions).
**Audit:** new commands audit via `command()` (edit-draft, duplicate, revise, cancel) — required for each.
**Tests:** status-machine unit tests incl. cancel/expire and stranded-`converting` recovery; print-route render snapshot (bilingual, DRAFT watermark); e2e draft→edit→submit→approve→send→accept→job.
**Risk:** medium (touches the status machine — mitigated by the engine remaining sole writer of approval transitions). **Rollback:** revert; new statuses only ever written by the new actions.

### 003D — Invoice workspace
**Scope:** editable draft (service fn exercising the existing draft-only RLS window), issue confirmation dialog (explains immutability), detail page renders lines/due date/issued date/payments/remaining balance/credit-note links, print/preview route, void/credit-note guidance text, payment continuity (issued → record payment pre-filled; payment rows link to invoices; land on the reconciled invoice), payment detail/receipt page (render the minted `RCP-…`), e-invoice honesty copy.
**Files:** `modules/invoices/service.ts` (+`updateInvoiceDraft`), `modules/payments/service.ts` (+`getPayment`), `app/…/invoices/*`, `app/…/payments/*` (new `[paymentId]/`), i18n, tests.
**Migration:** none — the draft-edit RLS window and all columns exist.
**Permissions:** none new. **Audit:** draft-edit command audited.
**Tests:** immutability regression (issued invoice rejects edit at service AND grant level), reconciliation with edits, receipt render, e2e draft→edit→issue→pay→reconciled.
**Risk:** medium (financial surface — protected by existing grant-level immutability, which must not be touched). **Rollback:** revert.

### 003E — Supplier/item/procurement completeness
**Scope:** `updateSupplier`/`updateItem` (+ single-row reads), supplier/item detail pages with edit + deactivate/reactivate + archived filter, inline supplier create from PO/MR-convert, MR/PO draft edit + cancel writers (statuses exist), PO mark-sent (manual wording) + close decision, **GRN visibility + correction**: GRN list on PO detail, damaged/rejected inputs, receive-date field, `cancelGoodsReceipt` action + UI with impact explanation, MR detail error rendering, withdraw-MR, major-units money entry everywhere, export additions (MR/PO/GRN) if cheap.
**Files:** `modules/masters`, `modules/supply`, `app/…/{suppliers,items,material-requests,purchase-orders}/*`, i18n, tests.
**Migration:** **verify grants** — supplier/item UPDATE grants and MR/PO header-update grants may be missing (masters agent found no updaters to prove them) → one sequential migration if so.
**Permissions:** none new (`catalog.manage`, `po.manage`, `mr.create`, `grn.cancel` all exist).
**Audit:** every new mutation through `command()`; GRN cancel emits the existing `GOODS_RECEIPT_CANCELLED` (rollup invalidation — already wired).
**Tests:** cost-rollup regression after GRN cancel/damaged; deactivated supplier hidden from PO picker but intact on history; e2e MR→PO→receive→correct.
**Risk:** medium (cost rollup touched only via existing invalidation events). **Rollback:** revert.

### 003F — Jobs/reports/issues/expenses/payments completeness
**Scope:** job archive/unarchive writer + archived filter; job-detail continuity links (MRs/POs/expenses/costing/reports lists); issue job-link + raise-from-job + assign + edit + in_progress/closed; `/reports` index + job reports list; reviewer material-line correction (service for the existing RLS window) or explicitly retire that window; attendance note + clear-to-unmarked decision; expense mark-paid writer + receipt upload (images allowed today) + localized category labels; approval detail route + history list; member reactivate + role change (new `identity.ts` functions); people/members error-pattern upgrade.
**Migration:** none expected (columns exist; attendance "clear" = DELETE decision → prefer a `cleared` status or overwrite-to-null via grant check first).
**Permissions:** reuse existing keys; role change gated `members.invite`+`members.deactivate` (or a decision to add `members.manage` — flag at implementation, needs matrix change if so).
**Audit:** all via `command()`. **Tests:** per-surface unit + the §8 continuity e2e chains. **Risk:** low-medium, breadth not depth. **Rollback:** revert.

### 003G — Cross-application interaction hardening
**Scope:** search/filter on every list (server-side, paged — respect the 1,000-row law); archived views everywhere; unsaved-changes protection (dirty guard in Dialog + client forms); consistent confirmation dialogs for all destructive actions (§4 rule 7); accessibility/RTL/mobile sweep of every new surface; status-tone truthfulness everywhere; error idiom completion (no page ignores `?error`); end-to-end workflow tests for the §8 chains; export catalogue completion.
**Migration:** none. **Permissions:** none. **Risk:** low. **Rollback:** revert.

---

## 11. Owner decisions required

> **Resolved 2026-08-27 — the owner decided every item below; the rulings are recorded in §12.2.** The questions are kept as the record of what was asked.

Only matters of genuine business judgment — everything dictated by accounting integrity, security, a11y, or existing architecture is already decided above.

- **D1 — Quote cancel:** may a draft/approved/sent quote be explicitly cancelled (new `cancelled` status, one small migration), or is letting drafts sit forever acceptable for the pilot? Recommendation: yes, add cancel with reason.
- **D2 — Preset-less quotes:** (a) require a preset at quote creation, (b) allow preset-less quotes but require choosing one at accept-time (extra picker on the accept dialog), or (c) allow conversion to a preset-less ad-hoc job. Recommendation: (b) — least constraining, honest at both ends.
- **D3 — Quote expiry:** manual "mark expired" only (works today), or automatic expiry from `valid_until` (requires Inngest provisioning)? Recommendation: manual now, automatic later; also set a default validity (e.g. 30 days) — your call on the number.
- **D4 — Partial credit notes:** is full-amount-only credit acceptable for the pilot, or do you need amount/line-level credits before first customers? (Line-level is meaningful work + VAT allocation decisions.)
- **D5 — Document strategy timing:** confirm the launch order — print/preview fallback first (no dependencies, ships in 003C/003D), real stored PDFs + email only after you provision Inngest + Resend (standing owner actions OA-4 / runbooks). Any different order costs weeks.
- **D6 — Member role change:** needed for the pilot, or is deactivate + re-invite acceptable initially? (Reactivate is included regardless.)
- **D7 — Approval-rule management UI:** expose rule viewing/editing to owners in 003F, or keep onboarding-seeded rules fixed for the pilot? Recommendation: view-only list first.
- **D8 — Hard delete:** confirm that the pilot ships with **no hard-delete anywhere** (archive/cancel/void only), deferring "delete genuinely unused record" to a later slice with reference-checking. Recommendation: confirm.

---

## 12. Universal document & export contract (owner amendment, 2026-08-27)

### 12.1 The binding requirement

The audit is accepted, with one product-wide addition that binds every slice from 003B onward:

1. **Every record or report that reasonably requires a formal document or a data export must be exportable in an appropriate format.** Formal documents print/PDF; tabular data CSV (XLSX later). PDF is never forced onto data that is better served as CSV.
2. **All formal documents carry the organization's actual identity**: the onboarding logo, legal/trading names, TRN, address and configured document details — for **every** organization, as a core product capability, not a premium add-on.
3. Advanced *visual customization* (accent styling, letterhead/cover layout) may remain an add-on — but the basic logo, legal identity, TRN and address appear on every organization's formal documents regardless of entitlements. `feat.branding_docs` is accordingly redefined as **advanced document styling**; it no longer gates the presence of issuer identity. In-app branding (`feat.branding_app`) keeps its existing entitlement behavior — this decision concerns formal documents only.

### 12.2 Owner decisions (all eight §11 items ruled)

- **D1 approved** — quote cancellation with a required reason.
- **D2 = (b)** — preset-less quotes allowed while drafting; the preset is selected at acceptance.
- **D3** — expiry is manual initially; **default validity 30 days**.
- **D4** — partial credit notes are **required before real paid billing**, but are not part of 003B.1.
- **D5 confirmed** — print/preview fallback first; stored PDFs + email only after Inngest/Resend provisioning.
- **D6** — member role changes **are required**.
- **D7** — approval-rule UI begins **view-only**.
- **D8 confirmed** — no hard-delete for the pilot; archive/cancel/void/reversal only.

### 12.3 Universal export catalogue

The authoritative, typed catalogue lives at `src/platform/documents/catalogue.ts`; every entry declares identifier, EN/AR name, source, allowed formats, required permission, entitlement behavior, redaction, document-profile usage, status eligibility, draft-watermark behavior, issuer-snapshot requirement, and honest availability (`available` — wired today; `foundation_ready` — schema/template/profile exist, route pending; `future`). **The catalogue may never claim an export is available before its route ships** (pinned by test).

**Formal print/PDF documents (17):** quote · invoice · credit note · payment receipt · purchase order (LPO) · goods receipt · material request · expense voucher · daily/site report · customer update · customer statement · project/job status report · attendance/timesheet report · costing report · sales report · receivables/aging report · cover letter/letterhead. *(None is `available` yet — print routes begin in 003B.2.)*

**Data exports (20):** customers · suppliers · items · employees · teams · members · jobs · quotes · invoices · payments · expenses · material requests · purchase orders · goods receipts · daily reports · attendance · issues · approvals history · audit log · configuration revisions. *(8 are `available` today via `settings/export`: jobs, customers, suppliers, invoices, payments, expenses, daily reports, audit log — the rest are foundation-ready or future.)*

### 12.4 Document profile & historical integrity (implemented from 003B.1)

One canonical issuer model: **`company` (default row) owns legal identity** — legal name, TRN (`tax_reg_no`, the only TRN source), licence, structured bilingual address, contacts, signatory, payment instructions, default document language; **`org_branding` owns visual identity** — logo, accent, trading display name, footer. Document-profile reads compose the two. The legacy `org_branding.legal_name` field is **frozen** (no writer remains); resolution is `company.legal_name → org_branding.legal_name (legacy) → company.name (seeded)`, so two legal names can never silently drift.

Historical-document integrity rule (writers land with the first print/export routes in 003B.2): draft previews always use the **current** profile; the moment a commercial/legal document becomes formal it captures an **immutable issuer snapshot** (schema: `src/platform/documents/issuer.ts`); later profile changes never rewrite issued documents; re-renders use the stored snapshot; documents issued before snapshot support render through an **explicit legacy fallback** — the current profile is never silently retrofitted as historical truth.

---

*End of audit. Implementation proceeds per §10 with the §12 contract binding; 003B.1 (document profile foundation) is the first slice.*
