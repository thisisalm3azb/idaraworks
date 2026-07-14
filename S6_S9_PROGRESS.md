# S6–S9 autonomous build — progress checkpoint

Resume protection for the multi-slice run (S6 Bill → S7 Improve/Intelligence → S8 AI
Onboarding → S9 Commercial Wiring). Updated after every slice, before any forced
interruption, and around deploy/cleanup. **Never redo a completed, green, deployed,
cleaned slice.**

## Current position
- **Current slice:** **S9 — Commercial Wiring IN PROGRESS** (S6/S7/S8 DONE). Baseline verified e6b4306, migrations 0000-0051, orgs=[Alpha Marine,TESTING], health green. **Do NOT begin S10/S11.**

## S9 — Commercial Wiring — FROZEN SCOPE + D1 ANALYSIS (full: docs/S9-SCOPE-FREEZE.md)
**Objective (verbatim):** "the business can charge money and support customers governably." Only slice hard-blocked by legal paperwork (D1/OA-5).
**D1 RULING (authoritative, phase2/00-INDEX.md:54):** D1 = incorporation & merchant of record — blocks "Stripe wiring + DPA/data-residency final choice" but **"does NOT block any schema or capability design."** → **D1 is an ACTIVATION gate, NOT an implementation gate.** Build full governed logic NOW behind a provider seam DISABLED in prod (fake adapter in dev/test). Activation = owner supplies secrets + price IDs + enables adapter; NO schema/logic change needed.
**Resolved contradictions (governed defaults):** (1) plans: keep 3 rows starter/growth/business; trial = billing_state not a plan; enterprise = override bundle later. (2) states: reconcile to `internal_pilot, trialing, active, past_due, grace, suspended, cancelled, purge_pending, purged`; DEFER `paused` (S10+). (3) windows configurable: trial 14d, past_due ~14d dunning, grace short buffer, cancelled read-only 60d then purge_pending→2 warnings→purged. (4) catalogue drift (cap.week_plan, P3 caps, feat.sso, limit.exception_rules_tuned, limit.automation_runs_month): DEFER — keep shipped 17 feat/9 limit keys (no backing features yet; adding = noise + risks DB⇔code parity test). (5) doc10 gaps: ADD webhook-signature-verification + no-card-data/PCI items to checklist; implement sig-verify in adapter. (6) pricing numbers = D3/OP-2 owner decision → placeholders, labelled non-final.
**Existing foundation (EXTEND not duplicate):** entitlement_def/plan/plan_entitlement/org_plan_state(plan_key+billing_state 7-state CHECK+period_start/end)/org_entitlement_override (0005/0007); resolve.ts hasFeature/getLimit/checkLimit (FR-9: never block reads/exports; checkLimit=ADD only) + 60s TTL cache (same-process invalidate only). **GAP: billing_state STORED+RESOLVED but NOT ENFORCED — no transition fn, nothing advances period_end, no consumer gates on it. No provider columns. No usage-meter table. No dunning. No impersonation. No platform write path. No cross-instance cache invalidation.**
**Build plan (migrations from 0052):** 0052 org_plan_state extend (provider/customer/subscription id cols + state CHECK reconcile + grace_until/suspend_at/purge_at) · 0053 subscription_event webhook-inbox (idempotency) · 0054 usage_meter · 0055 dunning_attempt · 0056 impersonation_session (consent+banner+dual-log+break-glass) · 0057 reconciliation + commercial telemetry · 0058 platform write-path DEFINER RPC + plan_price catalogue (per plan×interval×currency, minor units, placeholder, versioned). Provider-neutral adapter (fake + disabled-prod, Zod webhook parse + signature verify). Services: subscription state machine (webhook-driven, command()-audited, events-after-commit, idempotent), entitlement enforcement (hard-stop security feats / soft-warn-block-adds growth limits / never reads), upgrade(immediate+proration)/downgrade(period-end never-delete), impersonation (consent+banner+dual-log). Workers: dunning, purge(legal-hold-checked), reconciliation, cache-invalidate. UI en/ar/RTL/375px: owner billing/plan admin, subscription+meter settings, upgrade/downgrade/cancel, impersonation banner, disabled-checkout state, telemetry. Then review→gates→deploy→Arabic demo(trial→paid→past_due→recovery + support session in tenant audit)→cleanup→report.
**Bucket 4 (must NOT do before D1):** store real card data; enable prod provider adapter / accept real webhooks / take real money; commit price IDs or provider keys; hard-code a merchant/tax assumption. Webhook signature verification MUST exist before adapter is ever enabled.
**RESUME INSTRUCTION:** S9 not started building yet (scope frozen only). NEXT: migration 0052 (org_plan_state extend + state reconcile). All S9 work is Bucket-1 (implement-now). Nothing pushed for S9 yet; HEAD e6b4306.

## (superseded) prior current-position
- **S8 CLOSED (2026-07-14):** deployed `6760e6e`, CI green, 18/18 prod smoke, Arabic DoD demo PASS (cold→configured, 20 revisions + 2 always-rules, first job, **PARITY 290000/395000**, guided import, call-cap, undo). 3-lens adversarial review → 5 findings fixed (approval-rule inverted, circuit-breaker fail-open→0051 DEFINER, validator rule-b dead→privilege check, applyImport race→atomic claim, stale comment). Baseline RESTORED: 5 synthetic orgs + 5 users + 495 rows removed; inventory = 2 orgs (Alpha Marine + TESTING), S7+S8 tables 0. Migrations **0000-0051** (next 0052). Report: docs/S8-ONBOARDING-COMPLETION.md.

## (historical) S8 build detail
- **Current slice:** S8 — AI Onboarding (S6 DONE, **S7 DONE**)
- **S7 CLOSED (2026-07-14):** deployed `63bff3d` (code `a5485ab`), CI green (run 29290957958), 18/18 prod smoke,
  Arabic DoD demo PASS (E-05/06/13 raised, 13/13 questions, narration validated+metered, money wall HELD, share
  safe+revoke-dead, C-10 divergence). **Baseline RESTORED:** 15 synthetic orgs + 25 users + 2175 rows (incl. 149
  synthetic outbox events) removed via `tooling/scripts/s7-cleanup.ts --apply` (owner-approved); inventory = 2
  orgs (Alpha Marine + TESTING), S7 tables 0, S7 exceptions 0, queue unprocessed 0. Migrations 0000-0049 (next 0050).
- **NEXT (S8 — AI Onboarding):** Layer-A ConfigProposal pipeline + guided imports + manual fallback. Freeze scope
  from docs (PROJECT/BUILD_BIBLE S8), build, adversarial review, tests, CI, deploy, Arabic prod demo, cleanup.
  Do NOT begin S9. Old S7 sub-log below retained for history.

## S8 — BUILD STATE (updated live)
- **DONE:** migration **0050** (onboarding_session, import_batch/import_row, ai_interaction feature widen, limit.ai_onboarding_calls) applied to hosted. Modules: onboarding (proposal/validate/provider/service — Layer-A pipeline propose→validate→apply→undo, F-28 cap, cap+breaker) + imports (stage→validate→apply via masters). Platform: authz onboarding.run(owner/admin)+imports.manage(owner/admin/manager) both matrices; AUDIT_ENTITY_TYPES; entitlement catalogue. UI: onboarding intake + preview screen + import wizard + first-run checklist + nav + en/ar i18n. Bleed seeders for the 3 tables. Tests: **unit 282/282** (9 S8), **s8 hosted integration 5/5** (cold→configured, PARITY 290000/395000, guided import, call-cap, guard-respecting undo). Gates: format/lint(0)/typecheck/build green. s8-prod-demo.ts written.
- **2 bugs fixed during hosted run:** drizzle array-inlining (`()` empty-array syntax error) → jsonb→array bind; undo tripped D-9.2 field-removal guard → best-effort undo catches ConfigGuardError (install marker still reverts).
- **REVIEW DONE (3-lens) + fixes applied.** 5 findings: (MATERIAL) approval-rule inverted → `always`+auto_approve_below; (MATERIAL latent) circuit breaker fail-open → migration **0051** SECURITY DEFINER; (false-assurance) validator rule-b dead code → cost/price-privilege check; (MINOR) applyImport race → atomic claim; (stale) entitlement comment. Terminology-override gap documented (non-blocking). Migrations hosted **0000-0051** (next 0052).
- **Commits PUSHED:** e94edb8 (tests+demo) + **6760e6e** (review fixes). HEAD 6760e6e on origin/main.
- **NOW:** CI running on 6760e6e (monitor blf0rzr8c) + deploy-wait (bqwtjt6op). Gates green: format/lint(0)/typecheck/unit 282/build/s8-integ 5/5 (PARITY 290000/395000). Report drafted docs/S8-ONBOARDING-COMPLETION.md.
- **NEXT:** CI green → prod smoke → Arabic s8-prod-demo → remove S8 synthetic (demo org + "S8 Org" integ leftover; baseline=[Alpha Marine,TESTING]) → finalize report + memory → STOP. Do NOT begin S9.

## S8 — AI Onboarding & Imports — FROZEN SCOPE (doc 11 S8; doc 09 #12/F-28; doc 10 #32; doc 08 parity gate)
**Objective:** "how does your business operate?" → configured workspace in ≤30 min, template #1 only, WITHOUT the builder present. The pipeline is a **validator around templates, not an agent** (doc 11 risk note).
1. **Layer-A ConfigProposal artifact** — `{ intake_summary, template_key, artifacts:[subset of config artifacts 1–11 as full docs], rationale_per_artifact, requires_upgrade: feature_keys[] }`; Zod schema.
2. **Grounded proposal builder (provider seam)** — deterministic FAKE/disabled provider mirroring S7 `getNarrationProvider` (works with NO AI creds = the manual fallback): grounds structured intake answers onto template #1 (`TEMPLATE_BOATBUILDING`) + org overrides (terminology/currency/calendar/VAT/thresholds). Optional real provider disabled in prod.
3. **Validator** — every artifact through its S1 schema (`StageTemplateSchema`… in config/schemas/artifacts) PLUS proposal-level rules: (a) **no permission grants beyond preset bounds**, (b) **no capability outside entitlements** → `requires_upgrade` instead, (c) **referential closure**, (d) **F-28: AI `auto_approve_below` capped at 2× template default → REJECT (never silently clamp)**.
4. **Pipeline** — intake → ground → propose → validate → **preview/edit** (`previewConfigChange`) → **apply-as-revision** (`applyConfigChange` with `aiFlag:true`, undoable) → **undo** (`undoRevision`). Reuses S1; each artifact applied as its own revision.
5. **Trial-abuse controls (doc 10 #32, F-26/F-27):** `feat.ai_onboarding` free but **per-org ~30-call cap** (new `limit.ai_onboarding_calls`); disposable-email screening + per-IP/device signup throttle; **platform daily AI-spend circuit breaker**; trialing orgs = deterministic digest only + small storage/short TTL (already S7).
6. **Guided CSV imports** (customers / employees / items): **import_batch staging** + row-level mapping + validate (per-row errors) + apply through the governed services; re-runnable.
7. **First-run sequence:** cold org lands on **Today** with a **seeded onboarding checklist**.
8. **DB:** `onboarding_session` (intake + proposal + status), `import_batch`(+`import_row`); widen `ai_interaction.feature` to add the onboarding metering key; entitlement `limit.ai_onboarding_calls`.
9. **UI (en/ar/RTL/375px):** onboarding conversation/questionnaire + the **preview screen** ("best screen in the app") + import wizards.
10. **Platform wiring:** authz actions in BOTH matrix transcriptions; events; entitlement enforcement; worker/registry parity; terminology variables.
**Testing:** ConfigProposal schema + safety (no out-of-preset grants, F-28 caps, entitlement closure), rejection-loop (invalid proposal → validator errors → retry), **template #1 PARITY test (doc 08 gate: reproduce a real historical boat → costing within rounding of legacy `boatFinance()`)**, guided-import tests, e2e on ≥3 canned intakes, bleed/authz/tenancy. **DoD/AC:** cold org → configured workspace with a real first job <30 min without builder; undo restores; parity green. **Then:** adversarial multi-lens review + fixes → full gates → deploy → **Arabic prod demo** → remove S8 synthetic data (baseline=[Alpha Marine,TESTING]) → report. **Do NOT begin S9.** Migrations start at **0050**. Config apply API: `applyConfigChange(ctx, artifactKey, next|fn, {summary?, aiFlag?})`, `previewConfigChange(ctx, key, next)`, `undoRevision(ctx, revisionId)`; artifact keys = `CONFIG_ARTIFACT_KEYS`.

## (historical) S7 build task log
- **Current slice:** S7 — Improve / Intelligence (S6 DONE)
- **S7 STATUS: CODE COMPLETE + DEPLOYED + DEMOED; one action (synthetic-org cleanup) PENDING owner approval.**
  - Deployed `a5485ab` (prod /api/health commit + 18/18 smoke:prod incl. "deployed commit matches"). CI GREEN
    (run 29290957958: full integration on local Supabase + e2e + all static gates). s7-improve hosted integ 10/10.
  - Arabic thirteen-questions prod demo PASS: E-05 margin=1, E-06 late=4, E-13 docExpiry=1; 13/13; narration
    generated+validated+metered; money wall HELD; customer share safe+revoke-dead; C-10 divergence; 0 leftovers.
  - **PENDING owner:** `tooling/scripts/s7-cleanup.ts --apply` — removes 15 synthetic test orgs (8 S7 Org, 1 S7
    Org B, 3 S6 Org, 2 S4 Org, 1 S3 Org) + 25 users + 2175 rows, restoring baseline to [Alpha Marine, TESTING].
    Dry-run verified; protected orgs excluded by name+UUID. **The harness auto-mode classifier BLOCKED the prod
    DELETE — owner must run it or grant permission.** Until then pre/post baseline does NOT match.
  - NEXT after cleanup approved: run cleanup → s7-inventory (expect 2 orgs, S7 tables 0) → S7 fully closed. Then
    STOP (do NOT begin S8; await explicit S8 approval).
- **(historical) Current task:** S7 implemented + 6 adversarial-review findings FIXED + regression-covered.
  - **Fixes applied (all in working tree, NOT yet committed):** #1 narration money-leak (`buildNarrationInputs`
    counts-only, digest/service.ts) · #2 numbers-subset fail-CLOSED (numbers-subset.ts tightened regex + NaN→offending)
    · #3 share rate-limit IP (new `platform/http/clientIp.ts` `clientIpFromHeaders`, used by s/[token]/page.tsx)
    · #4 DEFINER org self-check (migration **0049** — applied to hosted) · #5 digest headline COUNT(*) not LIMIT-10
    length (digest/service.ts riskCount/awaitingCount) · #6 owner Today `card_as_of` i18n (o/[orgId]/page.tsx).
  - **Regressions added:** 4 unit (buildNarrationInputs money-exclusion, numbers-subset sentence-final/decimal,
    clientIpFromHeaders precedence) + 2 integration (cross-org DEFINER returns 0 rows, digest count>10 items≤10).
  - **Local gates GREEN:** format ✓ · lint 0 errors ✓ · typecheck ✓ · **unit 273/273** ✓ · build ✓.
  - **Hosted integration:** ENVIRONMENTAL WALL — Seoul network is ~15-20× normal latency right now (10-21s PER
    test). Long test files exceed 2-4 min; the FULL multi-file suite would take >1h. Proven NOT a code bug: a
    ZERO-S7 control file (s3-report) behaves identically (passes tests then my own `timeout` SIGTERMs it). The
    earlier "20-min hang" was the default reporter buffering file-summaries over slow DB-only tests, not a hang.
    PLAN (matches S6 precedent): validate s7-improve file in isolation vs hosted (RUNNING bg bemj3zx0e, verbose,
    monitor bdsgp6de2) + rely on **GitHub CI** (fast local ephemeral Supabase) for the full-suite green.
  - **NEXT:** confirm s7-improve isolation green → commit review fixes → push (S7 commits af88959..c6efe9c + fix
    commit; all LOCAL/unpushed) → CI green → deploy (Vercel auto on push) → prod `/api/health` commit → Arabic
    thirteen-questions demo (tooling/scripts/s7-prod-demo.ts) → cleanup S7 synthetic → report (docs/S7-IMPROVE-COMPLETION.md drafted).
- **Completed slices (this run):** S6 — Bill ✅ (deployed ee5eb7a; CI green; prod DoD demo passed; baseline restored)
- **Migrations:** hosted at **0000-0049** (0045-0048 = S7 core; **0049** = review-fix DEFINER org self-check, applied). Next: 0050.
- **New baseline (pre-S7):** deployed ee5eb7a · prod orgs [Alpha Marine, TESTING] only (must stay untouched)

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

## S7 — BUILD LOG
- **IMPLEMENTATION ~COMPLETE (commits af88959, 051950b, 27ab952, 137d07c, 833215c; migrations 0045-0048 hosted):**
  E-rules E-05/06/08/13 + staggered fan-out scheduler + events/authz (051950b); deterministic digest + AI narration
  seam + numbers-subset validator (27ab952); customer-update service + tokenized share surface + /s/[token] public
  page + sharp watermark + C-10 quote-vs-actual wiring (137d07c); owner digest card + customer-update UI + en/ar
  i18n (833215c). Typecheck/i18n-parity/build all green at each step.
- **REMAINING S7:** tests (unit: numbers-subset/stagger/watermark done-next; integration: E-rule lifecycles, digest
  compose/read/redaction/narration/credit-meter, customer-update draft→send→resolve→revoke→expire, share-token
  cross-org bleed, quote-vs-actual + divergence, worker direct-invocation; bleed seeders for digest/ai_interaction/
  customer_update/share_token; thirteen-questions golden fixture) · prod demo (s7-prod-demo.ts) · full gates ·
  multi-lens review + fixes · deploy · prod health · Arabic thirteen-questions DoD demo · cleanup · report.
  NOTE: af88959 + all S7 commits are LOCAL (unpushed) — push with the test commit once gates are green.


- **Migrations 0045-0047 WRITTEN + APPLIED to hosted (DB now 0000-0047, next 0048):** 0045 exception rule_key widen
  (+margin_drift, late_po, late_supplier, unusual_expense, document_expiry) + subject index; 0046 `digest` (per org/audience/
  date, redacted-at-collection payload jsonb, narration seam nullable) + `ai_interaction` append-only credit ledger; 0047
  `customer_update` (draft/sent, frozen safe `content` jsonb at send, draft-only edit RLS) + `share_token` (token_hash only,
  expires/revoke, ≥128-bit) + **app.resolve_share_token(hash) SECURITY DEFINER** = the one no-auth public read path (returns
  ONLY safe columns of an active token's sent update). All org-scoped RLS, NO DELETE grants, composite (id,org_id) FKs.
- **DONE (commit pending): E-rules + scheduler + events + authz.** Migration 0048 (app.margin_drift_candidates +
  app.document_expiry_candidates DEFINER helpers so the nightly worker reads the labour/HR walls safely, returning
  percentages/ids only). E-05 margin_drift (nightly, critical, owner/accounts, C-10 quoted, suppressed when no quote),
  E-06 late_po + late_supplier (nightly, procurement/owner, approved_at+lead-time — no PO schema change), E-08
  unusual_expense (event-driven on expense/created, self-clear on voided, ≥4-sample 3×-median), E-13 document_expiry
  (nightly, admin/owner, 30 calendar days). All raise+dedup+self-heal; evidence carries percentages/ratios not raw money.
  Scheduler REFACTORED: exceptionNightlySweep (serial herd) → exceptionNightlyDispatch (cron fan-out) + nightlyOrgRun
  (defineOrgFunction, concurrency 10) + runOrgNightly (idempotent per-org unit) + computeStaggerSeconds (deterministic
  FNV offset across a 240-min window); sweepExceptions kept as the direct/on-demand path. defineOrgFunction gained a
  concurrency cap. Events NIGHTLY_ORG_DUE + CUSTOMER_UPDATE_SENT + SHARE_TOKEN_CREATED/REVOKED wired (registry+inngest+
  index, parity 4/4). Workers registered (expenseAnomalyOnCreate/Void, exceptionNightlyDispatch, nightlyOrgRun). Authz
  digest.view + customer_updates.draft/send/share/revoke in BOTH transcriptions (parity 8/8). Typecheck clean.
- REMAINING S7 (was): E-rule services (E-05/06/08/13 in exceptions/service.ts + expenses hook for E-08) · scheduler fan-out refactor
  (workers/functions/exception-engine.ts) · digest composer (modules/digest) + numbers-subset validator + src/platform/ai
  narration adapter (disabled seam) · customer_update service + share surface + /s/[token] public page + sharp watermark
  derivative · quote-vs-actual view (extend costing page) · owner digest card live · 13-question golden fixtures · authz
  (digest.view, customer_updates.*) + config (ExceptionThresholdSet params) + entitlement enforcement (feat.ai_narration/
  ai_drafts, limit.ai_credits_month) · events (customer_update/sent, share_token/created+revoked) · i18n en/ar · tests ·
  review · gates · deploy · Arabic DoD demo (thirteen-questions) · cleanup · report.

## S7 — Improve & intelligence — FROZEN SCOPE (informational; decisions taken for every ambiguity)
Scope-freeze reader workflow output: session subagents/workflows/wf_2f93988b-4ca. Objective: "the system starts
telling the owner where to look." Baseline: migrations 0000-0044 (next 0045), deployed ee5eb7a, prod=[Alpha Marine, TESTING].

**Four new E-rules (extend the S5 engine; versioned code + raise/clear + threshold unit tests):**
- E-05 margin_drift — NIGHTLY; subject job; dedup `margin_drift:{jobId}`; severity **critical**; audience owner,accounts;
  raise when (cost% − progress% > marginDriftPoints[15]) OR (cost > costOfQuotePct[90]% of quoted while isPreFinal
  [pre-finishing stage, template #1]); quoted via costing C-10 precedence; **DECISION: suppress when quoted is null**;
  clear when neither arm holds; DB-side SQL aggregate.
- E-06 late_supplier — NIGHTLY; two arms: per-PO `late_po:{poId}` warning audience procurement (PO past expected date
  w/o full GRN); aggregate `late_supplier:{supplierId}` warning audience procurement+owner (≥ lateCount[3] late POs in
  trailing 90 CALENDAR days). Clear per-PO on full receipt/close; aggregate when <3.
- E-08 unusual_expense — **DECISION: event-driven on expense create** (mirrors E-07); subject expense; dedup
  `unusual_expense:{expenseId}`; warning; audience accounts,owner; raise when amount > medianMultiple[3]× trailing median
  of same category on same job AND ≥ minSample[4] priors; clear on void / nightly recheck.
- E-13 document_expiry — NIGHTLY; subject employee; dedup `document_expiry:{employeeId}:{docType}` (id/passport/visa);
  warning; audience admin,owner; raise when any employee_hr expiry within windowDays[30] **CALENDAR** days; clear on
  renewal or deactivate. **Data source EXISTS: employee_hr.{id,passport,visa}_expiry (reserved in 0020 for E-13).**
- DEFERRED (NOT S7): E-11 (quote-vs-actual VARIANCE rule, P3), E-12, E-14, E-15.

**Staggered nightly scheduler:** refactor src/workers/functions/exception-engine.ts (today a single serial cron looping
all orgs — the F-31 herd) into a **fan-out dispatcher** (platform task) that enqueues one ORG-SCOPED child per org,
staggered by deterministic offset = hash(org_id) % windowMinutes + a concurrency cap + per-org runtime budget; each child
runs evaluateNightly + reconcile + **digest compose**. Keep dedicated-client org discovery + per-org isolation. DB-side
aggregates (F-30). Measured-runtime re-stagger + per-work-class pools DEFERRED (1000-company tier).

**Deterministic digest + AI narration seam:** new `digest` table (org_id, id, digest_date, audience/role, payload jsonb
[structured, redacted-at-collection per audience], narration text nullable, narration_status, computed_at). Composed in the
nightly window per org, **S7 surfaces the OWNER digest only** (per-role composition capability built; only owner card 6 lit).
Deterministic payload = ranked critical-exceptions → decisions-waiting → new-info → plan, cap ~10 + counts, evidence links
from the STRUCTURED source. **AI narration = DISABLED seam** (src/platform/ai adapter getNarrationProvider(), fake/disabled
like einvoice), generated LAZILY on card expand + cached on the digest row, gated feat.ai_narration + credits + non-trialing;
**numbers-subset validator** (canonical numeral normalization: Arabic-Indic→Latin, strip separators/symbols, compare numeric
VALUES) gates narration → deterministic fallback. **Deterministic digest is the always-shippable MVP.** Credit metering via
new `ai_interaction` ledger (org, feature, tokens, cost, validator verdict) + limit.ai_credits_month; analytics NEVER metered.
Platform daily-spend circuit-breaker = minimal dormant hook. Evening digest DEFERRED (F-20).

**Customer-update drafts + tokenized share surface (F-22):** `customer_update` table (org_id, id, job_id, customer snapshot,
title, body[editable], status draft|sent, curated photo file_ids, language). Body may be AI-drafted (disabled seam,
feat.ai_drafts+credits) OR manually written (fallback so the surface works w/o AI). Send is human → mints WATERMARKED
derivatives (customer_share file class via sharp watermark) + a `share_token` (org_id, id, customer_update_id, token_hash
[store hash not raw], expires_at [default 90d configurable], revoked_at, created_by; ≥128-bit random). **DECISION: "single-use"
= per-update-scoped revisitable-until-expiry/revoke link — PB-5 "revocable web link" (owner freeze decision) governs.**
Public page `/s/[token]`: no auth, **noindex**, rate-limited (30/min/IP, 10/min/token defaults), org resolved from token
server-side, renders ONLY the safe-by-construction payload (stage completions, progress%, watermarked photos, next
milestones — NEVER cost/labour/margin/internal/other-customer) + PDF (PB-5). Two-org bleed asserts token-A never surfaces B.
Authz customer_updates.draft/send/share/revoke = [owner,admin,manager] (row 62 governs; Accounts none); cap.customer_updates.

**Quote-vs-actual view:** extend the S5 job costing page with a quote-vs-actual section (MoneyRollup quotedMinor via C-10,
costMinor, invoicedMinor, paidMinor); gated finance.viewPrices + finance.viewCosts; server-side redaction (Manager sees
prices, cost/margin redacted unless viewCosts).

**Owner Today digest card (card 6) live:** headline+expand, source digest store, evidence links; collapses to notification-only
if AI narration disabled. **The digest content answers Q6/Q7/Q11** (the three §5 questions with no dedicated owner card) via
aggregated lines + deep-links — resolves the mapping gap WITHOUT adding cards (frozen 6-card design preserved).

**13-question → card mapping (authored S7 artifact, the DoD gate):** Q1→digest/ThisWeek; Q2→Card2(E-02); Q3→Card1; Q4→Card2;
Q5→Card5(MRs); Q6→Card5/digest(E-06); Q7→digest crew line; Q8→Card1(blocking issues); Q9→Card3(Yesterday); Q10→Card2(E-05)+
deep-link quote-vs-actual; Q11→digest customers-awaiting line; Q12→Card4(E-10); Q13→Card1. Golden-fixture CI asserts each
question's mapped card + payload vs a fixture dataset; live owner demo is the human gate (re-run S11).

**Authz new actions:** digest.view [owner,admin,manager,foreman,procurement,accounts]; customer_updates.draft/send/share/revoke
[owner,admin,manager]. Narration is server-automatic (entitlement-gated, no can() action). Config: ExceptionThresholdSet params
for E-05/06/08/13 (typed, minor-units, defaults above); TodayCardConfig lights owner digest card; digest cadence fixed
working-morning (non-configurable); limit.exception_rules_tuned unmetered in MVP.

**Migrations 0045+ (org-scoped RLS, NO DELETE grants, composite FKs):** digest; ai_interaction; customer_update; share_token;
exception rule_key widen (+margin_drift, late_po, late_supplier, unusual_expense, document_expiry). No new schema for E-13.
**Events:** customer_update/sent, share_token/created+revoked. **Entitlements:** enforce existing feat.ai_narration/ai_drafts +
limit.ai_credits_month (no new keys). **Owner actions (documented, non-blocking):** AI-provider creds (narration+drafts dormant;
deterministic digest + manual update + share surface all work without AI); watermark brand text; share expiry/rate-limit finals;
pen-test the public share surface.

## Resume instruction
If interrupted during S6 scope freeze: re-read phase2/01,05,06,09,10,12,13 + BUILD_BIBLE
for the Bill slice; the reader-workflow output (if present) is under the session
subagents/workflows dir. Then restate the freeze and continue implementation
automatically (scope restatement is informational only — do not wait for approval).
