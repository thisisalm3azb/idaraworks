# 11 — MVP Engineering Implementation Plan (v2)

**Reissued per audit (doc 12) §5/§6.** This is the implementation-mode plan: vertical slices, each with objective, deliverables, dependencies, database changes, APIs, UI work, testing, Definition of Done, estimated effort, and risks. It supersedes the v1 delivery plan. Governed by `13-ARCHITECTURE-FREEZE.md` and `../BUILD_BIBLE.md`. **Optimises for shipping a working, production-quality MVP — not for adding features.**

## Capacity honesty (PB-6)

Estimates below are **builder-weeks (bw)** of focused work. Total: **~53 bw**.

- **Two builders:** ~26–28 calendar weeks (with realistic parallel efficiency).
- **One full-time builder:** ~12 months as scoped; **or** defer S8 (AI onboarding — pilots are founder-onboarded anyway per the playbook) and S9's Stripe wiring to P2 → ~10 months. **A solo part-time builder cannot deliver this MVP in two quarters; that is a staffing decision, not an estimation problem.**

> **OP-9 CLOSED (2026-07-11):** implementation is **one human + Claude Code as AI development partner** — a single implementation stream, with AI reviewer agents for code review, testing, and security verification. S4∥S5 and S7∥S8 parallelisation notes therefore do not apply; slices run sequentially. Builder-week estimates stand; calendar expectations follow the single-stream math above, adjusted by observed AI-assisted velocity after S0–S2 (measure, don't assume). OP-8's multi-currency closure adds ~1 bw to S6.

## Scope guard (frozen — audit §5 cuts applied)

**In:** template #1 only · offline outbox for **daily reports + photos only** · Foreman as the sole field archetype · deterministic digest + narration · price adjustments (not change orders) · phone-OTP field auth.
**Absent from every slice** (building any of these = the slice has left the plan): GL, payroll, stock levels/warehouses (catalog + `cost_only` mode is the MVP truth), QC, workflow/report builders, public API, multi-company UI, white-label, WhatsApp digests, Worker archetype, `week_plan` entity, `insight` entity, `branch`, date-ranged assignments, templates #2–3, E-11/E-12, evening digest.

## Standing rules (apply to every slice)

- **Definition of Done (uniform):** slice ACs demonstrated on the dev tenant · doc 10 items owned by this slice landed with CI green · **indexes defined for this slice's hot queries + EXPLAIN reviewed** (audit F-29) · Arabic + English + RTL verified on new screens · matrix runner extended · money paths (if touched) have golden-file coverage · spec divergence fixed in code *or* docs, never silently · docs 01–10 amended if the build discovered a spec error.
- **Standing test infrastructure** (created in S0, grown every slice): two-org bleed harness (doc 10 #11) · matrix runner (doc 06 as data) · money golden files (incl. Najolatech `boatFinance()` parity fixtures) · offline/idempotency suite · RTL/pseudo-locale snapshots · calendar fixtures (UAE Mon–Fri, KSA Sun–Thu, 6-day, Eid, Ramadan) · Playwright smoke pack (grows to: full loop + five field flows + approvals inbox), run per merge.
- **Perf budget harness from S5** (audit F-29): synthetic volume (200 jobs, 50k reports, 200k lines, 2 orgs) seeded in CI; Today p95 < 1.5 s and report submit < 10 s under throttled-3G profile, asserted from S5 onward — not discovered at S10.

## Dependency spine & external calendar

`S0 → S1 → S2 → S3 → (S4 ∥ S5) → S6 → (S7 ∥ S8) → S9 → S10 → S11`. S4∥S5 and S7∥S8 parallelise only with two builders.

External dependencies (owner actions, from audit F-50): e-invoice partner decision **now** (blocks S6; also decide per pilot country whether the satellite may run unfilled) · incorporation/merchant opened **at S0** (blocks S9) · pen test **booked by S6** (used S11) · SMS/OTP provider chosen **at S0** (PB-7) · real Najolatech foreman scheduled for the S3 gate · Arabic native reviewer for S4 (PDFs) and S10 · pilot recruitment ongoing from S6.

---

### S0 — Bedrock (6 bw)

**Objective:** the platform substrate every later slice stands on — tenancy that provably cannot leak, identity, entitlements, audit, storage, language.
**Deliverables:** repo with boundary lint; CI skeleton with the standing test infra; auth (email+password, **phone-OTP** for field seats, TOTP MFA); org/membership (+deactivation flow); entitlement service (keys resolve from plans-as-data, no billing yet); audit+activity single command path; **RLS mechanism per doc 10 #1** (GUC, init-plan policies, service-role ban) + migration test harness; storage helper (upload path, access classes, quota counter skeleton, EXIF strip, derivative queue); i18n + terminology resolver (numerals pinned `latn`); RTL design-system primitives; task-queue + domain-event bus tables.
**Depends on:** SMS provider (PB-7); hosting-region decision recorded (doc 10 #43).
**DB:** org, company, user, membership, role_assignment, entitlement_*, audit_log, activity, file, comment, notification (+preference), app_settings, org_holiday_calendar, config_revision, task-queue/event tables. RLS template applied to all.
**APIs:** auth flows; org bootstrap; membership CRUD; entitlement resolve; file sign-upload/sign-read.
**UI:** auth screens (both languages), org shell, settings skeleton — deliberately minimal.
**Testing:** wrong-ctx DB-block test (doc 10 #1); two-org bleed harness runs (even with 5 entities); matrix runner scaffold; storage pipeline tests incl. EXIF assertion; OTP flow test.
**DoD/AC:** two orgs, two users, role resolves via matrix runner; audit row on every mutation via the command path; a photo uploads → compressed → EXIF-stripped → thumbnail exists; `term('job')` renders per template stub in en/ar.
**Risks:** the audit's #1 realism flag — this slice is 3 slices wearing one label; anything cuttable here isn't (it's all doc-10-mandated). Mitigate by strictly deferring OAuth (S10) and any UI polish.

### S1 — Config substrate, people & the walking skeleton (5 bw)

**Objective:** the configuration pipeline that makes template #1 installable — plus a thin end-to-end proof that the whole stack composes (audit F-48).
**Deliverables:** config-revision pipeline (validate → preview → apply → undo) with schemas 1–5, 10–11, 13–14 (doc 09) and the **config-string sanitiser** (doc 10 #24); template loader; template #1 identity/stages/terms/roles/categories/calendars installed; employees (+privileged side-tables), teams, customers, suppliers, item catalog; **walking skeleton:** one job created from a preset + one hardcoded-form daily report, live on RLS, in Arabic.
**Depends on:** S0.
**DB:** template/config tables, employee (+terms✱, hr✱), team, customer, supplier, item; job + daily_report minimal columns (fleshed in S2/S3).
**APIs:** config apply/undo; masters CRUD; skeleton job+report endpoints.
**UI:** settings → configuration (revision list + diff view, minimal); masters list/detail; skeleton job page.
**Testing:** schema validation suite; sanitiser tests (markup/ICU/formula cases); terminology coverage test (every key resolves en+ar for template #1); undo restores prior config with data intact.
**DoD/AC:** fresh org installs template #1 — stages, terms, roles, categories, holiday calendar appear; a config edit produces a diffable, undoable revision; **the walking skeleton demo runs end-to-end on a phone in Arabic at week ~4.**
**Risks:** schema over-perfection — schemas are outlines-made-Zod, not research projects; timebox each.

### S2 — Plan & Assign (4 bw)

**Objective:** jobs as the operational spine.
**Deliverables:** jobs (presets, reference patterns, status sets, custom fields, **billing_points seeded from preset**, price adjustments); job stages (weights, progress incl. override, **reopen transition with reason**); tasks; `job_crew`; week view (derived); job page (header/status/tabs: overview, stages, tasks, activity, files, comments).
**Depends on:** S1.
**DB:** job (full), job_stage, task, job_crew; indexes per DoD.
**APIs:** job CRUD + stage transitions (guard-slot ready) + reopen; task CRUD; crew management; week-view aggregate (SQL-side).
**UI:** jobs list (mobile-first cards + desktop table), job page, stage board, week view; create-job-from-preset flow (skips applied).
**Testing:** progress unit tests (weights/skips/override/reopen recompute); reference-pattern generator tests; billing_points Σ=100 validation; permission snapshots for job page per role.
**DoD/AC:** create boat 24C-001 from preset with Upholstery auto-skipped; progress math matches doc 01 U7 fixtures; reopen past a billing point raises the placeholder exception event; foreman sees only assigned jobs.
**Risks:** job-page scope creep — tabs beyond the listed five are P3.

### S3 — Report: the heartbeat (6 bw)

**Objective:** the atomic input of the whole product, phone-first, connection-tolerant.
**Deliverables:** daily report flow (work lines with stage refs, labour lines with frozen snapshots✱, material lines with `cost_only`/`cost_source` semantics, photos); review flow (`submitted → reviewed | returned`); issues (+`is_blocker`); attendance derivation from labour lines + manager manual grid; **offline outbox for reports + photos** (idempotency keys, resume drafts, compressed blobs); admin backfill.
**Depends on:** S2.
**DB:** daily_report + 3 line tables (+labour side-table✱ RLS-privileged), issue, attendance; unique(job, date, author); hot-path indexes `(org_id, job_id, report_date)`.
**APIs:** report create/submit/review/return; issue CRUD; attendance grid; outbox replay endpoint (re-runs `can()` per doc 10 #20).
**UI:** the foreman report flow at 375px (≤ N screens, one-thumb, choice chips), photo capture, issue raise-from-anywhere, review screen with per-line chips, attendance grid.
**Testing:** outbox suite (airplane-mode mid-entry → reconnect → exactly-once submit; conflict on duplicate); snapshot-freeze test (rate change ≠ historical cost change); returned-state edit-window tests; labour side-table RLS test; report tap/screen-count budget in CI (audit F-49).
**DoD/AC:** **gate: a real Najolatech foreman completes a report unaided after ≤10 min intro** (wall-clock target moves to pilot telemetry); labour lines appear in the attendance grid; airplane-mode scenario passes in CI.
**Risks:** the classic 3× feature (offline). Contained by the narrowed scope (reports+photos only) and by treating conflict semantics as already specced (last-write-wins + idempotency, v1 §9) — no invention allowed mid-slice.

### S4 — Supply & Approve (5 bw)

**Objective:** materials stop stalling work; decisions move at phone speed.
**Deliverables:** approval engine (registry per doc 05 final: MR, expense, quote_send, PO, payment_receipt-off; **self-approval guard**); approvals inbox (+ redacted subject summaries); MRs; POs (serial starts, **MR-less POs enter the registry**); goods receipts (partial-receipt math); push notifications (+preferences, redacted bodies); **Arabic PDF pipeline v1** (headless-Chromium in task-queue; LPO PDF bilingual) with Arabic-native rendering review; E-03 evaluator stub (event-triggered age check).
**Depends on:** S3 (issues/notifications patterns); parallelisable with S5 given two builders.
**DB:** approval, approval_rule, material_request(+lines), purchase_order(+lines), goods_receipt(+lines); partial index on pending approvals.
**APIs:** submit/decide/withdraw; MR→PO convert; GRN record; PDF render queue.
**UI:** approvals inbox (badge, age×amount order), MR flow (phone-capable), PO form + PDF, GRN receive flow, notification preferences.
**Testing:** doc 05 invariant test (sole-writer, atomic transitions); rule-validator ambiguity rejection; self-approval escalation tests; receipt math property tests; PDF snapshot incl. bidi (Latin serials in RTL text); notification redaction shape tests.
**DoD/AC:** MR over threshold routes to owner, under to manager, requester never self-decides; decision advances both records atomically; GRN partials reconcile; E-03 stub raises within an hour; LPO PDF passes Arabic review.
**Risks:** PDF pipeline is new infrastructure — timebox to LPO only (invoice PDFs are S6); if Chromium-in-queue fights the platform, fall back to a render microservice (same seam).

### S5 — Measure (5 bw)

**Objective:** the keystone — work becomes cost, truthfully, on the Today screen.
**Deliverables:** costing engine (spine per doc 01 dedup rules, **ex-VAT basis pending PB-3 sign-off**, single-writer rollups as DB-side aggregates, reconciliation alarm); expenses (+void, categories with costing_mapping, **no-PO-reference validation**); exception engine core (E-01…E-04, E-07 with raise+clear, dedup, holiday-calendar awareness); Today composer + **foreman and manager screens**; perf budget harness live.
**Depends on:** S3, S4.
**DB:** expense, exception, cost-rollup cache tables; partial index on open exceptions.
**APIs:** costing read (redacted per role), expense CRUD, Today per-role endpoints (server-composed, 60s cache, freshness stamps).
**UI:** foreman + manager Today screens (cards per doc 03), job costing page (privileged), expense entry (receipt photo).
**Testing:** **costing golden files incl. Najolatech `boatFinance()` parity cases**; dedup rule cases (PO+expense rejection, po-sourced consumption excluded); redaction snapshots (doc 10 #17); E-rule unit tests incl. Eid/Ramadan fixtures; drift alarm test; perf assertions at synthetic volume.
**DoD/AC:** job cost equals hand-computed fixture to the minor unit under both VAT bases; manager Today shows missing-report and blocker cards with freshness stamps; cost fields absent from foreman/manager payloads without 🔒; nightly evaluation completes < 5 min/org at synthetic volume, staggered.
**Risks:** PB-3 (accountant sign-off) must land before golden files freeze — schedule the accountant session at S4.

### S6 — Bill: the full-loop gate (6 bw)

**Objective:** work becomes money; the loop closes end-to-end.
**Deliverables:** quotes (+lines, sections, **revisions + acceptance evidence**, quote_send approval, quote→job conversion per doc 01 mapping); invoices (**kind incl. credit_note**, bilingual Arabic-primary PDF + partner QR field, e-invoice submission satellite + adapter contract against a fake provider, is_export, VAT-disabled org mode); payments (+payment_receipt wrapper per PB-8 default-off); AR views; owner/accounts/procurement Today screens (digest card dark until S7); E-09/E-10 rules.
**Depends on:** S5; **e-invoice partner decision (PB from D4) due now** — code ships against the adapter contract regardless.
**DB:** quote(+lines), invoice(+lines), payment, payment_receipt, einvoice_submission.
**APIs:** quote lifecycle; convert; invoice issue (prefilled from billing_points reached); payment record; AR aggregates (SQL-side).
**UI:** quote builder (sections from template, per-preset quote templates), invoice form + PDF, payments, AR aging, three Today screens.
**Testing:** money-path suite — recorded-not-assumed VAT cases, export zero-rating, VAT-disabled orgs, credit-note AR math, void exclusion, serial continuity (paper-start numbers); adapter contract tests incl. credit notes and clearance-failure states; billing-point → E-09 flow.
**DoD/AC:** **full-loop demo:** quote → accept (evidence) → boat → reports → MR→PO→GRN → expenses → live margin → billing point reached → invoice (bilingual PDF) → payment → AR updates — one sitting, no dev tools. KSA-mode invoice renders Arabic-primary bilingual with QR slot.
**Risks:** the gate slice; partner slippage is absorbed by the fake-provider contract but **pilot-country mandate timing must be verified** (audit F-50a) before promising compliance in sales conversations.

### S7 — Improve & intelligence (4 bw)

**Objective:** the system starts telling the owner where to look.
**Deliverables:** remaining MVP E-rules (E-05 with C-10 precedence, E-06, E-08, E-13); staggered nightly scheduler; deterministic digest + AI narration (numbers-subset validator, per-role redaction at collection, credit metering); customer-update drafts + **the tokenized share surface per doc 04/F-22**; quote-vs-actual view; owner Today digest card live.
**Depends on:** S5, S6; parallelisable with S8 given two builders.
**DB:** digest; share tokens.
**APIs:** digest fetch; share page (public, rate-limited, `noindex`); narration + draft endpoints (Layer B, closed payloads).
**UI:** digest card + full view with evidence links; customer-update composer (curated photos, watermarked previews); share page.
**Testing:** numbers-subset validator tests; two-org digest isolation (full bleed test); share-token expiry/revocation/content tests; narration Arabic review; credit-meter tests.
**DoD/AC:** **the thirteen-questions gate:** CI asserts each question's mapped card against a golden fixture dataset; then the live demo — the owner answers all thirteen from Today, unprompted, on seeded pilot-like data.
**Risks:** narration quality in Arabic — the deterministic fallback is always shippable; narration is polish, not a gate.

### S8 — AI onboarding & imports (4 bw) — *deferrable to P2 in the one-builder variant*

**Objective:** "how does your business operate?" → configured workspace, ≤ 30 minutes, template #1 only.
**Deliverables:** Layer-A pipeline (intake → template grounding → ConfigProposal → validate incl. F-28 caps → preview/edit → apply-as-revision → undo); trial abuse controls (doc 10 #32); guided CSV imports (customers/employees/items); first-run sequence (land on Today, seeded checklist).
**Depends on:** S1 config pipeline, S7.
**DB:** ai_interaction_log; import staging.
**APIs:** intake conversation; proposal validate/apply; import mapping.
**UI:** onboarding conversation + the preview screen ("the best screen in the app" per v2 §16), import wizards.
**Testing:** ConfigProposal schema + safety tests (no out-of-preset grants, auto-approve caps, entitlement closure); rejection-loop test (invalid proposal → validator errors → retry); e2e on 3 canned intakes; **template #1 parity test (doc 08 gate: reproduce a real historical boat, costing within rounding of legacy `boatFinance()`)**; timed onboarding runs by ≥2 non-builder operators.
**DoD/AC:** cold org → configured workspace with real first job < 30 min without the builder present; undo restores; parity test green.
**Risks:** none novel — the pipeline is deliberately a validator around templates, not an agent.

### S9 — Commercial wiring (3 bw)

**Objective:** the business can charge money and support customers governably.
**Deliverables:** Stripe (or per D1 outcome) subscription integration → entitlement states (trial → active → past_due → grace → suspended, per v1 §13); dunning emails; support impersonation (consent-gated, banner, dual-logged); DPA + PDPL posture docs (doc 10 #43); pilot telemetry dashboards (§12 metrics + per-card instrumentation + egress metric).
**Depends on:** S6; **D1 (incorporation/merchant) closed**.
**Testing:** billing-webhook state machine tests (every transition, idempotent replays); impersonation banner/log assertions; entitlement downgrade semantics (block adds, never reads).
**DoD/AC:** trial→paid→past_due→recovery lifecycle demonstrated on a test org; a support session is visible in the tenant's own audit log.
**Risks:** D1 slippage — this slice is the only one hard-blocked by legal paperwork; sequence it late deliberately.

### S10 — Hardening (3 bw)

**Objective:** production-quality, not feature-complete-quality.
**Deliverables:** perf pass to budgets (fix, not measure — measuring started S5); Arabic native review fixes across all surfaces (**AC: zero open sev-1 language issues**); OAuth (Google/Microsoft) added; **first restore drill — database AND storage** (doc 10 #47); incident tabletop; backup monitors verified; pen-test prep pack; recycle-bin/closure walkthrough.
**Depends on:** S7–S9.
**DoD/AC:** drill evidence filed with measured RPO/RTO; all doc 10 `DRILL`/`REV` items pre-launch state green; budgets met at synthetic volume.
**Risks:** hardening discovers S3/S6 debt — the 2 bw buffer in S11 exists for exactly this.

### S11 — Pilot readiness (2 bw + buffer)

**Objective:** external validation before external customers.
**Deliverables:** full regression (money, tenancy, offline, RTL suites); **external pen test window** (booked at S6) + criticals fixed; pilot onboarding playbook rehearsal (founder watches, doesn't drive); launch-criteria checklist walked and signed (v2 §12 + the thirteen-questions live pass + parity test + drill evidence).
**DoD/AC:** pen-test criticals = 0; every launch criterion checked by name; **P2 pilot phase begins.**
**Risks:** pen-test findings landing late — scope was pre-agreed at S6 booking; criticals block, mediums get dated fixes.

---

**Effort summary:** S0:6 · S1:5 · S2:4 · S3:6 · S4:5 · S5:5 · S6:6 · S7:4 · S8:4 · S9:3 · S10:3 · S11:2 ≈ **53 bw**. Gates: S1 walking skeleton (wk ~4) · S3 real-foreman test · S6 full-loop demo · S7 thirteen questions · S8 parity + 30-min onboarding · S11 launch criteria → pilots.
