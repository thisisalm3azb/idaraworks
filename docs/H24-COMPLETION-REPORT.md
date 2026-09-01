# H24 — Accounting, finance, banking and taxation: completion report

_Status: engine complete on `verify/h24`; production deployment section is
filled in as each gate passes. Nothing in this report is claimed before it
happened._

## 1. What was built (slices A–M)

- **H24A — truth first.** `docs/H24-TRUTH-MAP.md`: every place money already
  lived, six disagreement points, and fifteen locked decisions (one ledger,
  idempotent source-linked posting, reversal-only correction, dual-currency
  integer minors, fiscal periods, books-start gate, versioned tax packs,
  honesty rules for banking and AI). `docs/H24-EVIDENCE-LOG.md`: FTA and
  Tally sources with verification tiers — nothing unverified auto-applies.
- **H24B — the ledger (0100).** Balanced-in-both-currencies journal with
  database invariants: the ONLY path to `posted` is a SECURITY DEFINER
  function; born-draft trigger; posted rows immutable even against the table
  owner; one business event posts once (partial unique index, concurrency
  race resolved inside PL/pgSQL); reversal-only correction with two-way
  links; no DELETE grants anywhere.
- **H24C/D — bookkeeping (0102).** Org chart of accounts from a versioned
  template (~40 bilingual accounts with system keys), fiscal years/periods
  with locked-period protection, manual journals born as drafts, opening
  balances through a VISIBLE equity-offset journal, recurring journal
  templates a human materializes, payment-terms/credit-limit party profiles,
  bill-by-bill settlement allocation. Posting rules for invoices, credit
  notes, payments and expenses — all no-ops until an org installs its books,
  and never for documents dated before the books start.
- **H24E — banking (0103).** Bank/cash accounts each tied to a control
  account; money transactions frozen at record (void = explicit reversal);
  statement import with file+line SHA-256 dedupe; reconciliation where
  suggestions carry evidence and NEVER auto-apply; completed reconciliations
  freeze their matches. No live-bank integration is claimed anywhere.
- **H24F — subledgers (0104).** Stock movements, payroll finalization and
  straight-line depreciation post through the same bridge; subledger-vs-
  control reconciliations REPORT drift, never repair it.
- **H24G/H — rates, budgets, tax (0105).** Effective-dated rate book (rates
  are suggestions; every posting snapshots its own rate); versioned budgets
  that freeze on approval with ledger-recomputed variance; a configurable,
  versioned tax engine with UAE packs: VAT201-oriented working papers
  (official boxes, control-account reconciliation, exceptions for anything
  unclassifiable) and a CT workpaper starting from ledger accounting profit
  with explicit, legally-cited adjustments — 0%/9% bracket is the only
  auto-math; small-business relief needs an explicit election and the
  revenue test. No filing capability is claimed; every paper says so.
- **H24I — statements.** Balance sheet, P&L (comparative), indirect cash
  flow whose three groups sum EXACTLY to the cash movement, trial balance,
  paged journal register and account ledger with pagination-stable running
  balances, entry drill-down, computed closing checklist. All recomputed
  from posted lines with server-side aggregation. Exports: chart of accounts
  + journal entries through the paged CSV door (catalogue 25 data exports).
- **H24J — Tally migration (0106).** Guided import for exactly three stated
  formats (Tally XML masters, Tally XML Day Book vouchers with the negative-
  amount-is-debit convention, generic CSV): inspect → human ledger mapping →
  dry run with per-account totals for trial-balance comparison and named
  exceptions → explicit approval posting idempotently. Pre-books-start and
  unbalanced vouchers are exceptions, never postings.
- **H24K — surfaces.** 13 routes (overview, setup, accounts, journals ×3,
  banking ×2, receivables, payables, reports, tax, budgets, Tally import),
  EN/AR, mobile-first, all behind `FEATURE_FINANCE_SURFACES === "1"`
  (default OFF; near-miss spellings pinned off by unit test) AND the
  cap.finance entitlement AND the finance permission lanes.
- **H24L — documents.** Eleven finance document kinds through the ONE
  render pipeline (journal voucher, receipt/payment vouchers, customer/
  supplier statements, trial balance, balance sheet, P&L, VAT working
  paper, CT workpaper, reconciliation summary) — EN/AR, internal-only,
  never shareable links.
- **H24M — verification.** Bleed seeders for all 24 new org-scoped tables
  (registry-completeness test enforces no tenant table ships without one);
  adversarial audit fixes; read-only production transition report.

## 2. Roles and segregation of duties

Nine finance actions mapped onto the existing archetypes (matrix.ts, D14):
`finance.view` (owner/admin/manager/accounts/viewer), `finance.manage/post/
reconcile`, `tax.prepare`, `budget.manage` (owner/admin/accounts),
`finance.approve/close`, `tax.review` (owner/admin). Posting ≠ approving;
journal entries are approvable subjects; tax papers need the preparation
lane even to read.

## 3. AI posture

The platform's model layer (A1) has no model-directed tool channel; there
is no path by which AI can post, finalize, reconcile, or file anything.
Every financial state change goes through a human-invoked service function
with permission checks and audit.

## 4. Historical transition — deliberately NOT performed

`docs/H24-TRANSITION-REPORT.md` (read-only, generated 2026-09-02): 78
invoices + 63 payments + 51 expenses + 13 goods receipts across 39 orgs;
what is mechanically reconstructable; four named ambiguities (5 zero-VAT
expenses, 13 GRNs with no stock movements, pre-profile invoices, unknown
VAT filing history); PO-002 recorded exactly as found (GRN-001 accepted 20
— the state the mandate described — plus a pre-existing GRN-002 accepted
14; zero accounting entries; untouched). Because ambiguity exists, the
engine ships gated and **no production history was converted, no opening
balances posted, no org's books installed.**

## 5. Verification record

- Unit: 1402/1402 (includes registry/matrix/i18n/flag transcription laws).
- Integration (hosted test project `zwnnqaryouevnzuwtyaj`): h24b 7/7 —
  adversarial DB-invariant proofs including two concurrent posts → one
  winner and replica-mode corruption REPORTED not repaired; h24cd 10/10;
  h24e 3/3; h24f 3/3; h24gh 3/3; h24i 7/7; h24l 4/4; h24j 2/2; bleed
  harness with every H24 table seeded in two orgs; regression suites s5/s6/
  h22b green.
- Lint 0 problems; tsc clean; prettier clean; production build green with
  all 13 finance routes.
- Migrations 0100–0106 audited: purely additive (new tables/functions/
  nullable columns/entitlement rows); the only UPDATE/DELETE statements
  live inside the definer functions that ARE the posting discipline.

## 6. Production deployment record

- Pre-flight health: **HEALTHY** (2026-09-02; 3 orphaned auth records left
  by H23's own smoke runs were identified and removed first — the H24 smoke
  cleanup now deletes identities/sessions too).
- Migration dry run: exactly 0100–0106 pending, nothing else.
- CI on `verify/h24`: _[filled in at deploy]_
- Guarded apply (0100–0106): _[filled in at deploy]_
- Deploy + tested==deployed proof: _[filled in at deploy]_
- Backend smoke (marked fixture, self-destructing): _[filled in at deploy]_
- `FEATURE_FINANCE_SURFACES=1` enabled AFTER smoke: _[filled in at deploy]_
- Post-enable verification: _[filled in at deploy]_

## 7. What was deliberately not done

- No production history conversion (see §4) — waiting on the owner's
  rulings listed in the transition report.
- No live-bank integration, no e-invoicing, no direct tax filing — the
  product never claims them; adapters remain seams.
- H25 not started.
