# S6–S9 autonomous build — progress checkpoint

Resume protection for the multi-slice run (S6 Bill → S7 Improve/Intelligence → S8 AI
Onboarding → S9 Commercial Wiring). Updated after every slice, before any forced
interruption, and around deploy/cleanup. **Never redo a completed, green, deployed,
cleaned slice.**

## Current position
- **Current slice:** S7 — Improve / Intelligence (S6 DONE)
- **Current task:** begin S7 scope freeze (read governing docs), then implement automatically
- **Completed slices (this run):** S6 — Bill ✅ (deployed ee5eb7a; CI green; prod DoD demo passed; baseline restored)
- **New baseline:** hosted migrations 0000-0044, next 0045 · deployed ee5eb7a · prod orgs [Alpha Marine, TESTING] only

## Verified baseline (start of run)
- Deployed S5 commit: `e98a34c` (prod alias serves it)
- Local HEAD: `e98a34c` · main synced with origin/main · tree clean
- Highest migration: `0040_s5_cost_rollup.sql` · **next migration: `0041`**
- CI (S5): run `29243923828` green · unit 242/242 · S5 integration 16/16
- Production orgs (must stay untouched): `Alpha Marine`, `TESTING`
- Production baseline clean (S5 tables all 0; only the two orgs above exist)

## Strict order (do not mix slices)
1. S6 — Bill  ← in progress
2. S7 — Improve / Intelligence
3. S8 — AI Onboarding
4. S9 — Commercial Wiring
Do NOT start S10 (Hardening) or S11 (Pilot Readiness).

## Per-slice completion gate (all 15 must hold)
implemented · review findings fixed · local gates green · hosted integration green ·
logical commits · pushed · CI green · exact commit deployed · prod health confirms it ·
Arabic prod DoD demo passes · only that slice's synthetic data removed · pre/post
baseline match · Alpha Marine + TESTING untouched · tree clean · report written.

## Standing owner actions (documented, NOT blocking — build seam + continue)
Inngest keys · production PDF runtime · Sentry DSN · Upstash · password rotation ·
PB-3 ex-VAT sign-off · org pricing/tax/thresholds · payment-provider creds · AI-provider
creds · email/WhatsApp creds · e-invoice/government creds · delete 4 junk Vercel projects.

## Slice log
### S6 — Bill — STATUS: implementation ~70% (UI + tests remain)
- Migrations 0041-0044 applied to hosted (quote/quote_line; invoice/invoice_line/einvoice_submission;
  payment/payment_receipt; exception rule_key widened for E-09/E-10). Hosted at 0000-0044. Next: 0045.
  (customer got composite (id,org_id) unique in 0041; payment_reject_ck dropped — reason in approval note.)
- Services built: platform/einvoice/adapter (fake + disabled), modules/quotes (create/submit→quote_send
  approval/markSent/accept→convert+C-10/reject/reads), modules/invoices (create/issue[immutable]/void/
  credit_note/submitEInvoice[adapter]/computeAR[DB-side buckets]/reconcile/reads + Arabic invoice template
  + buildInvoiceHtmlInternal), modules/payments (record[+OP-7 approval]/void/receipt/reads/reconcile).
- Approval SUBJECTS: quote_send (onReject→draft) + payment (onApprove→confirmed) added.
- Events: quote/accepted, invoice/issued+voided, credit_note/issued, payment/recorded (registry+inngest+index).
- Workers: invoiceOnIssued (e-invoice submit + Arabic PDF seam, gated), paymentReconcileOnDecision. Registered.
- Exception engine: E-09 billing_point_uninvoiced + E-10 overdue_invoice added to nightly (+ self-heal).
- Authz: quotes.view/manage, invoices.view/manage, payments.view/manage, ar.view added to MATRIX +
  EXPECTED_MATRIX; today.view extended to accounts+procurement.
- Today composer: owner/accounts/procurement screens added (AR summary, invoices-to-issue E-09, overdue E-10,
  approvals-pending, payments-week, open-POs). Money shown for price-privileged owner/accounts.
- Typecheck clean at each step.
- **UI DONE:** quotes list/new/detail, invoices list/new/detail, payments list/new, AR aging — all en/ar/RTL/
  375px; nav links gated (quotes/invoices/payments/ar); i18n keys added to en.json+ar.json (parity + banned-noun
  test green). Job-noun labels use `{job}` terminology variable (invoices/new job picker) — no hardcoded nouns.
- **Worker registration fix:** invoiceOnIssued + paymentReconcileOnDecision were imported but MISSING from the
  workerFunctions array (Inngest would never serve them) — added. Also registered costRollupOnGoodsReceiptCancel
  (latent S5 gap: GRN cancel never invalidated the cost rollup) — closes an S5 guarantee hole.
- **BUG FOUND & FIXED (caught by integration test):** `invoice_issued_ck` CHECK `(status='draft' or issued_at
  is not null)` made draft-cancellation impossible (cancelled draft has null issued_at). Relaxed to
  `status in ('draft','cancelled') or issued_at is not null` in 0042 (uncommitted) + applied delta on hosted.
  Regression coverage = the draft-void assertion in s6-bill integration test.
- **TESTS GREEN:** unit `tests/unit/s6-bill.test.ts` (money golden both VAT bases + role gating) 11/11 +
  authz-matrix + i18n parity. Integration `tests/integration/s6-bill.test.ts` 13/13 (full loop quote→approve→
  accept→convert→invoice→issue→e-invoice[cleared]→payment→AR→credit-note; immutability; redaction; E-09/E-10
  raise+self-heal; ref continuity). Bleed harness 2/2 (7 new tables seeded + isolated + registry guard).
- **REVIEW DONE (5-lens adversarial, all findings independently verified + fixed + regression-covered):**
  1. computeAR credit notes were a global lump → now attributed per corrects_invoice_id, folded into the same
     net that feeds buckets (outstanding == Σbuckets, never negative). [reg: S6 integ #1]
  2. reconcile/E-10 ignored credit notes → reconcileInvoiceStatus now counts paid+credited (fully-credited
     settles to 'paid'); createCreditNote re-reconciles; E-10 raise+self-heal gained a positive-net-balance
     predicate. [reg: S6 integ #2]
  3. submitEInvoice had NO assertCan → split public submitEInvoice(ctx,archetype,id)+assertCan('invoices.manage')
     vs trusted submitEInvoiceInternal (worker); action passes archetype. [reg: S6 integ #3]
  4. approval SOLE-WRITER subject UPDATE had no pre-state guard (voided payment could be resurrected) → SUBJECTS
     gained `live` (MR 'submitted', PO 'draft', quote 'pending_approval', payment 'recorded'); UPDATE guarded on
     it + RETURNING no-op; PO event gated on actual transition. [reg: S6 integ #4; S4 integ still green 37/37]
  5. acceptQuote non-atomic (orphan job on concurrent/retry) → claim quote into transient 'converting' via one
     guarded UPDATE BEFORE createJobFromPreset; release on job-create failure. Added 'converting' to quote CHECK
     (0041 + hosted delta). [reg: S6 integ #5 double-accept → exactly 1 job]
  6. submitQuote/recordPayment ignored res.decided (auto-approve stranded the subject) → advance subject in-tx
     when decided (mirrors S4). [reg: S6 integ #6]
  7. AR page/computeAR rendered money with no pricePrivileged gate → computeAR returns null money when
     !pricePrivileged; AR page + accounts/owner Today cards redact. [reg: S6 unit computeAR redaction]
- Migration deltas applied to hosted: 0042 invoice_issued_ck relaxed (draft-cancel); 0041 quote status +
  'converting'. Hosted now 0000-0044 (with these two in-place amendments to uncommitted 0041/0042). Next: 0045.
- **GATES:** format ✓ · lint 0-err ✓ · typecheck ✓ · unit 254/254 ✓ · build ✓ · S6 integ 19/19 ✓ ·
  S4 integ 37/37 (no regression) ✓ · bleed 2/2 ✓ · FULL hosted integration RUNNING.
- REMAINING: confirm full integration green · logical commits · push · CI green · deploy exact commit ·
  prod health · Arabic full-loop DoD demo (s6-prod-demo.ts) · remove only S6 synthetic data · verify Alpha
  Marine+TESTING untouched · memory · report. Then auto-begin S7.

## Resume instruction
If interrupted during S6 scope freeze: re-read phase2/01,05,06,09,10,12,13 + BUILD_BIBLE
for the Bill slice; the reader-workflow output (if present) is under the session
subagents/workflows dir. Then restate the freeze and continue implementation
automatically (scope restatement is informational only — do not wait for approval).
