# 12 — Final Cross-Document Architecture Audit

**Method:** three independent passes over docs 00–11 as one system — an author pass and two adversarial cold reads (consistency/completeness/delivery; security/scale/storage/GCC) — merged and deduplicated here. **No production code or migrations were written.** The operations-first design law was the audit's constitution: no finding below redesigns IdaraWorks toward ERP, no-code, or generic workflow; every resolution stays inside the job-and-event-stream model.

**Classifications:** 🟥 **BLOCKER** (resolve before coding starts) · 🟧 **MUST-FIX-MVP** (resolve during build, deadline slice stated) · 🟨 **PILOT-VALIDATE** · 🟩 **DEFER**.

---

## 1. Verdict: **CONDITIONAL GO**

The architecture's shape survives the audit: the job-centred spine, container contract, unified approvals, deterministic exception engine, layered enforcement, and template mechanics all held under adversarial review — no finding requires structural redesign. What did not survive: **six load-bearing definitions are missing** (they read as decided but aren't buildable as written), **several defaults were copied from Najolatech's specific reality and presented as GCC-general** (working week, currency, email-based foremen), and **the 22-week schedule hides roughly 30–40 builder-weeks of scope**. All are fixable with days of spec work and a scope decision — hence conditional, not no-go.

**GO becomes unconditional when the seven pre-build conditions (§4, PB-1…PB-7) are closed.** Estimated effort to close: 3–5 working days of specification plus two owner decisions (capacity, scope cuts).

---

## 2. Consolidated contradiction register

| # | Contradiction (doc ↔ doc) | Resolution adopted | Class |
|---|---|---|---|
| C-1 | Approvable registry: 00-INDEX U5 (3 types) ↔ doc 05 D-5.3 (4 types, incl. `receipt`, no `invoice_issue`) | Doc 05 is source of truth; U5 updated. `invoice_issue` explicitly **out** of the enum for MVP | 🟧 pre-S4 |
| C-2 | "Receipt" means money voucher (docs 01/05/08) ↔ material-arrival confirmation (docs 03/06 foreman "receipt-confirm") | Rename money entity **`payment_receipt`** everywhere. Foreman confirming arrivals = GRN *creation* (existing permission), not an approval; docs 03/06 wording fixed | 🟧 pre-S4 |
| C-3 | Attendance write paths: U3 (labour lines + manager grid only) ↔ doc 06 (Worker "C own", Foreman "C own crew" check-in) | U3 stands; doc 06 attendance-mark rows → "−" for Worker/Foreman in MVP | 🟧 pre-S3 |
| C-4 | Working week "Sat–Thu GCC default" (00-INDEX, 04, 08) ↔ reality (UAE Sat–Sun weekend since 2022; KSA Fri–Sat; Najolatech's 6-day week is workshop-specific) | **Factual error.** Working week is an onboarding question with country-aware defaults; calendar test fixtures extended to Mon–Fri (UAE) and Sun–Thu (KSA) | 🟧 pre-S0 (doc fix now) |
| C-5 | Daily-report stage: doc 01 header `stage?` **and** per-stage work lines ↔ doc 08 "stage required on header" | Work lines own stage references; header stage dropped | 🟧 pre-S3 |
| C-6 | "Returned for correction" report state (doc 03 foreman card) ↔ doc 01 review flow has no return transition + doc 10 item 14 immutability | Add `submitted → returned → resubmitted` transition (author edits while returned); immutability applies after `reviewed` | 🟧 pre-S3 |
| C-7 | Manager card 6 "intra-day E-01 variant" (doc 03) ↔ E-01 is nightly-only (doc 04), no cutoff param anywhere | Card becomes a **plain query** (no exception lifecycle needed); `report_cutoff_time` added to org settings | 🟧 pre-S5 |
| C-8 | E-04 triggers on severity "`blocking`" (docs 03/04) ↔ issue model has severity enum + separate `is_blocker` flag (doc 01) | E-04 condition = `is_blocker = true`; "blocking" purged as a severity value | 🟧 pre-S5 |
| C-9 | Template #1 renames `purchase_order`→"LPO" (docs 07/08) ↔ `purchase_order` absent from doc 07's renameable key catalogue (template #1 would fail its own coverage test) | Catalogue extended: `purchase_order, goods_receipt, expense, payment, task` | 🟧 pre-S1 |
| C-10 | Two "quoted" money sources: `MoneyRollup.quotedMinor` from accepted quote (doc 02) ↔ `job.selling_price_minor` (doc 01); E-05 reads "quote" | Precedence: accepted quote total, else selling_price, else null — computed only by the costing engine; divergence between the two raises an exception, never silently picked | 🟧 pre-S5 |
| C-11 | E-05 "before final phase" (doc 04) ↔ "pre-finishing" (doc 08) — different phases in template #1 | "Pre-finishing" (the operationally useful one); doc 04 aligned | 🟩 wording |
| C-12 | Owner card "cash position" (doc 03) ↔ no bank data exists in the model | Card renamed "Collections & receivables" | 🟩 wording |

---

## 3. Findings register (merged, by requested dimension)

### D1 — Contradictions
Covered by §2 above.

### D2 — Missing entities, states, permissions, workflows

- **F-1 🟥 Billing milestones are load-bearing and undefined.** E-09, the Accounts Today card, the invoice-prefill, and the S6 gate all depend on "billing milestones" that no entity carries — and template #1's own "60% initial / 40% prior to delivery" isn't stage-shaped (60% is due at acceptance, before any stage). **Resolution (adopted into doc 01/08):** optional `billing_points [{trigger: on_acceptance | stage_key, pct}]` on the job, seeded from preset, editable per job; template #1 encodes `on_acceptance:60, stage:delivery:40`.
- **F-2 🟥 Costing dedup rule under-specified on the keystone.** The same physical purchase can enter as PO receipt, expense (category Materials), *and* consumed report line — doc 01's "flagged at entry" names no mechanism. **Resolution:** (1) PO-linked receipts cost the job directly; (2) an expense may not reference a PO (disjoint acquisition channels, validated at entry); (3) report material lines for PO-supplied items record consumption as *evidence* (`cost_source=po`, excluded from cost sum); manual/`cost_only` lines (`cost_source=manual`) are included. Doc 08's expense-category → costing mapping reconciled to this rule. S5 golden files cannot be written before this lands.
- **F-3 🟧 (pre-S4) PO approval escapes the unified engine** — exactly the per-document pattern doc 05 exists to kill — and PO-without-MR (weekly workshop reality) is unaddressed. **Resolution:** MR approval is the money gate; converting an approved MR auto-approves the PO; **MR-less POs are allowed but enter the registry** (`purchase_order` subject, over-threshold or MR-less → owner rule).
- **F-4 🟧 (pre-S4) No self-approval guard.** Rule added to doc 05: `decided_by ≠ requested_by`; if the only eligible approver is the requester, escalate one role up; Owner terminal self-approval allowed but flagged in activity/audit.
- **F-5 🟧 (pre-S2) Completed stages can't reopen** — a failed sea trial reopening Electrical Rigging is template #1's own domain. **Resolution:** `completed → in_progress` as manager action with required reason; progress recomputes; reopening past a consumed billing point raises an exception (never claws back an invoice).
- **F-6 🟧 (pre-S1) `assigned_job` condition has no defined source of truth** across `job.manager_id/foreman_id`, `assignment`, `task.assignee`, and the user↔employee split. **Resolution:** job.manager/foreman are **user** references; `assigned_job(user)` = manager ∨ foreman ∨ active crew membership via `employee.user_id` (see F-14's crew simplification).
- **F-7 🟧 (pre-S2) Member offboarding mid-job unmodelled.** Membership `deactivated_at`; deactivation flow reassigns open approvals by rule and flags active assignments to the manager; historical FKs untouched (D-1.6 snapshots already protect display).
- **F-8 🟧 (pre-S6) No credit-note path.** Cleared e-invoices can't be "cancelled" under GCC regimes; corrections are credit notes. **Resolution:** `invoice.kind = invoice|credit_note` + `corrects_invoice_id`; AR math and the e-invoice adapter contract include it; S6 money-path suite extended.
- **F-9 🟧 (pre-S6) Quote versioning & acceptance evidence missing** (promised in v2 §10, dropped in doc 01). **Resolution:** `quote.revision_of_id` + `accepted_at / accepted_note / evidence file`.
- **F-10 🟨 Mid-job scope change has no MVP expression** (change orders are P4), which would make E-05 cry wolf — the exact R18 failure. **Resolution:** audited **job price adjustment** (amount + reason, owner-only, folds into quotedMinor) — an override in the D-1.4 pattern; pilots validate whether it suffices before pulling change orders forward.
- **F-11 🟧 (pre-S0) Viewer seat class unassigned** in doc 09 limits (unpriceable). Viewer → free read-only class.
- **F-12 🟧 (pre-S4) Notification preferences entity missing** (v1 §16 promised per-user channel prefs; S4 push needs it).
- **F-13 🟨 Custom-values registry:** doc 01 shows `custom_values` on job only; v2 scoped MVP custom fields to job + customer. Registry fixed to `{job, customer}`.

### D3 — Unnecessary abstraction / premature complexity (cuts adopted)

- **F-14 🟧 `assignment` (job/stage × employee × date-range) is scheduling-grade for an MVP that needs crew lists.** Replaced by **`job_crew`** (job × employee membership); date-ranged assignments → P4 scheduling. E-12 (idle) derives from labour-line absence — and E-12 itself defers (F-24).
- **F-15 🟧 `week_plan` entity cut from MVP** — the week *view* derives from jobs/stages/tasks/crew; the Najolatech planning-grid ritual returns at P3 if pilots miss it.
- **F-16 🟧 `insight` entity cut** — exceptions are the MVP insights; the entity returns with P3 pattern detection.
- **F-17 🟧 Worker archetype cut from MVP build** (after C-3 it retained only own-task viewing). Enum slot reserved; Foreman is the field seat that matters.
- **F-18 🟧 `branch` cut from day-one schema; `company` kept** only as the org→company FK (financial documents need it; nothing else references it).
- **F-19 🟨 `PhaseSemantic` is an N=1 abstraction frozen as an enum.** Kept, but MVP engines may only consume two derived predicates (`isReportable`, `isPreFinal`) so re-cutting the vocabulary at template #2/#3 authoring touches no engine code.
- **F-20 🟩 Ceremony trims:** `payment_receipt` approval flow made template-optional-off-by-default *unless the owner confirms he wants the Najolatech draft→approve ritual kept* (it exists there for a trust reason — owner decision, not silent cut); Arabic `dual` metadata dropped from required schema; evening digest edition and narration A/B moved to pilot-phase.

### D4 — Multi-tenancy & security weaknesses

- **F-21 🟥 The "RLS second wall" is unspecified and likely inert as designed.** If the service layer uses the service-role key (the default server pattern), RLS never evaluates; if it passes user JWTs, active-org claims and Supavisor transaction-pooling GUC discipline are unhandled. **Resolution (adopted):** request-scoped `set_config('app.org_id', …)` inside one transaction per request, RLS policies read that GUC via init-plan-wrapped `(SELECT …)` (also the performance-correct pattern), service-role usage banned outside migrations/platform tasks; **new CI test: a repository call with a deliberately wrong ctx is blocked by the database, not just the app.** Checklist items 1–3 rewritten accordingly.
- **F-22 🟥 Customer progress updates are an unauthenticated share surface with zero specification.** **Resolution (mini-spec adopted):** per-update single-use page behind a ≥128-bit token; org-revocable; expiring **watermarked derivatives** only (never originals, never long-lived signed URLs that leak via WhatsApp forwarding); noindex; rate-limited; content is the safe-by-construction payload only; added to pen-test scope.
- **F-23 🟧 (pre-S5) Cost redaction has four uncovered serialization channels:** approval `subject_summary` amounts (foreman inbox), push-notification bodies, digest payload assembly, and file access by type. **Resolution:** one rule in doc 06 — *redaction applies at every serialization boundary* — plus **file access classes** per `attached_to` type (`job_media` / `financial_doc` requires viewPrices / `hr_doc` privileged / `customer_share` watermarked), enforced at signed-URL minting. Response-shape tests extended to all four.
- **F-24 🟧 (pre-S4) Offline approval replay lacks re-authorisation and subject binding.** Replay endpoint re-runs `can()` at execution time; queued decisions carry a subject content hash — mismatch → "changed since you reviewed."
- **F-25 🟧 (pre-S1) Tenant-authored config strings are an injection surface** beyond UI escaping: HTML→PDF pipelines, **CSV formula injection** in exports (`=`,`+`,`-`,`@` prefixes), ICU metacharacters breaking doc 07 interpolation, and prompt injection via stage/issue names entering LLM payloads. **Resolution:** one shared config-string sanitiser + export-layer defensive quoting + tenant strings delimited/attribute-quoted in prompts. New checklist item.
- **F-26 🟧 (pre-S8) Free AI onboarding + cardless trial = scriptable LLM cost drain.** Per-org onboarding-call hard cap, per-IP/device signup throttle, disposable-email screening, platform-level daily AI spend circuit breaker, trial orgs get deterministic digest only.
- **F-27 🟨 Trial storage abuse** (free seats + signed URLs = free photo host): small trial storage quota, short TTLs, MIME allowlist, per-org upload rate limit.
- **F-28 🟨 Layer-A can propose self-defeating approval config** (absurd `auto_approve_below`): AI-proposed values capped at a multiple of template defaults.

### D5 — Database scaling & query performance

- **F-29 🟧 (S0, grows per slice) No index plan exists.** Adopted: composite `(org_id, …)` leads every tenant index; named hot-path indexes — `daily_report(org_id, job_id, report_date)`, partial `approval(org_id, assigned_role) WHERE state='pending'`, partial `exception(org_id) WHERE resolved_at IS NULL`, `activity(org_id, entity_type, entity_id, created_at)`, event-bus `(org_id, processed)`. Each slice's DoD now includes "indexes for this slice's hot queries + EXPLAIN check."
- **F-30 🟧 (pre-S5) Costing rollups must be database-side aggregates** (SQL/RPC), not paged row-shipping — the 1,000-row paging discipline applies to *lists* only. Same for Today aggregates and E-05 math. (3-year volume estimate for one 50-person org: ~9k reports, ~36k labour lines, ~45k material lines — trivial for SQL aggregates, wrong shape for app-side summation.)
- **F-31 🟧 (S7) Nightly herd:** all GCC tenants share UTC+3/+4 — nightly sweeps/digests/recomputes stagger via queue fan-out with concurrency caps and a per-org runtime budget.
- **F-32 🟨 Partitioning decision recorded now, implemented when volume demands:** monthly range partitions for `activity`, `domain_event`, `notification`, `audit_log` (the ~1M-rows/org/3yr class).
- **F-33 🟩 Today cache** busts on role/config revision (not just 60s TTL).

### D6 — File upload & object storage (the package's thinnest area — mini-spec adopted)

- **F-34 🟥 Storage had no backup/replication plan** (checklist 35 covered the DB only) — photos are the evidentiary substrate of the product. **Adopted:** nightly incremental bucket replication to a second provider + manifest; storage restore joins the quarterly drill.
- **F-35 🟧 (S0/S3) Storage mini-spec** (new appendix to doc 01; checklist items added): client-side compress (max edge 2048px, ~q75, ≤500KB target) → server re-encode → **EXIF/GPS strip** (workshop photos currently carry employee geolocation PII) → queue-generated thumbnail (~200px) + medium (~1280px); Today photo strips render thumbnails only (the p95 target dies otherwise); offline outbox stores compressed blobs; originals kept only for `financial_doc`/`hr_doc` classes.
- **F-36 🟧 (S0) `limit.storage_gb` enforcement:** transactional per-org byte counter on file insert/void, nightly reconcile vs bucket listing; enforcement at signed-upload-URL issuance (warn 80%, block adds at 100%, never reads). Tier numbers flagged for D3 revisit — 25GB Starter is ~6 months for a photo-heavy org even compressed.
- **F-37 🟧 (S9) Egress cost visibility:** cache-control on derivatives; per-org monthly egress metric on the telemetry dashboard.
- **F-38 🟧 (S0) Lifecycle wiring:** legal hold suspends *storage* deletion too; account-closure purge enumerates and verifies object deletion; recycle-bin restore restores objects.

### D7 — Audit-log & event-volume growth (retention policies adopted)

- **F-39 🟧 (pre-S9)** `domain_event`: purge processed > 30–90 days (largest table otherwise) · `notification`: read > 90d, unread > 12mo · `exception`: 24 months, then monthly aggregates · `activity`: keep (tenant promise), monthly partitions, cold storage > 3yr · **`audit_log`: financial-mutation rows ≥ 6 years regardless of tier** (KSA ≥6yr / UAE ≥5yr VAT record requirements override "retention per tier") · `ai_interaction_log`: 90d raw, 12mo metadata · digest payloads: 90d full, headlines thereafter.

### D8 — Arabic / RTL / timezone / GCC gaps

- **F-40 🟧 (doc fix now)** Working-week factual error — see C-4.
- **F-41 🟧 (pre-S5) No holiday/Ramadan calendar exists.** E-01 would fire critical exceptions across every tenant during Eid — a synchronized trust-destroying noise event. **Adopted:** `org_holiday_calendar` (template-seeded per country, org-editable) consumed by all working-day math + a date-ranged working-hours profile (Ramadan legally reduces hours in UAE/KSA, skewing E-07 bands).
- **F-42 🟧 (pre-S4) Arabic PDF pipeline unspecified** though PDFs ship in S4 (LPO) and S6 (invoice): shaping, bidi (Latin serials inside RTL text), embedded fonts. **Adopted:** headless-Chromium HTML→PDF in the task-queue (not Vercel functions), Arabic-native rendering review before S4 exit.
- **F-43 🟧 (S6) ZATCA invoice rendering requirements:** KSA tax invoices Arabic-primary bilingual + partner-supplied TLV QR on the human-readable PDF; UAE PINT variant. Added to S6 ACs.
- **F-44 🟧 (S1) Numerals:** pin `u-nu-latn` (Western digits) as default under `ar` locales with per-org override — unpinned ICU renders ٥٬٠٠٠ in the first Arabic demo.
- **F-45 🟨 VAT-less orgs** (Qatar/Kuwait): explicit VAT-disabled org mode (hide fields, disable e-invoicing capability), rates country-derived at onboarding.
- **F-46 🟨 KSA PDPL residency:** Supabase has no KSA region — for KSA pilots holding visa/ID documents, document the lawful-transfer basis in the DPA before pilot; a KSA-region deployment is the enterprise-tier trigger v1 anticipated.
- **F-47 🟩 Hijri display and Arabic FTS stemming:** deferred with the limitation recorded (trigram covers references/names; Arabic stemming is the future Typesense trigger).

### D9–D11 — Slices, acceptance criteria, dependencies

- **F-48 🟧 S0+S1 deliver no loop value for ~4 weeks.** Adopted: a **walking skeleton** AC added to S1 — one job, one hardcoded daily report, on real RLS, in Arabic — integration risk surfaces at week 4, not week 8.
- **F-49 🟧 Vague ACs replaced with testable forms** (adopted into doc 11): S0 "role resolves" → matrix runner over all archetypes with deny-by-default assertions; S3 "report < 3 min" → CI tap/screen-count budget + wall-clock moves to pilot telemetry; S7 thirteen-questions → CI asserts each question's card against a golden fixture + the live owner demo stays as the human gate; S8 "< 30 min" → e2e on 3 canned intakes + timed runs by ≥2 non-builder operators; S9 "perf pass" → Today p95 < 1.5s and report submit < 10s under throttled-3G profile at seeded volume, as repeatable scripts; S10 "seed data polish" → replaced by the enumerated launch-criteria checklist.
- **F-50 🟧 External-dependency calendar** (owner actions, start dates): e-invoice partner decision **now** (needed S6, ~wk 12; also decide whether pilots may run with the satellite unfilled per country mandate timing); incorporation/merchant **start at S0** (legal lead time, blocks S9); pen-test **booked by S6** (4–8 wk lead); Arabic reviewer + real Najolatech foreman scheduled (S3/S9 gates); templates #2–3 reference businesses — resolved by F-52 instead.
- **F-51 🟧 Foreman auth reality:** GCC workshop foremen frequently have no email — **phone-OTP or admin-issued credentials** decided before S3's field test, or "activate in <10 min" dies at the login screen. (SMS provider becomes an S0 dependency.)
- **F-52 → see §5 scope decision.**
- **F-53 🟧 (pre-S5) Costing VAT basis:** input VAT is recoverable for VAT-registered orgs — counting expenses *incl.* VAT (doc 01, from Najolatech habit) inflates cost 5–15% and corrupts margin. Pilot accountant rules on **ex-VAT costing** (with incl-VAT for non-registered orgs) before S5 golden files freeze.
- **F-54 🟨 iOS push reality:** the Approve-step promise rides on installed-PWA web push; fallback (email-first, D14 WhatsApp later) specified for iPhone-owner pilots.
- **F-55 🟩 Minor sequencing notes:** E-03 stub is an explicit S4 deliverable; owner Today ships S6 with the digest card dark until S7.

### D12 — Scope realism

- **F-56 🟥 (planning) 22 weeks for S0–S10 with 1–2 builders is not credible as originally scoped** — S0 (auth+entitlements+audit+RLS harness+i18n+RTL system ≈ 4–6 wks labelled 2), S3 (offline outbox is the classic 3× feature), S6 (money correctness, the gate slice), S8 (AI pipeline + two ungrounded templates), S9 (six workstreams in one slice) hide ~30–40 builder-weeks. See §5 for the adopted correction.

---

## 4. Pre-build decision register (the GO conditions)

| # | Decision required | Proposed resolution (adopted into the package unless owner objects) | Owner sign-off? |
|---|---|---|---|
| PB-1 | **RLS enforcement mechanism** (F-21) | GUC-based request-scoped tenancy + init-plan policies + DB-level block test; service-role banned in request paths | Technical — decided |
| PB-2 | **Billing-points model** (F-1) | `billing_points` on job, template-seeded; template #1 = 60% acceptance / 40% delivery | Confirm the 60/40 encoding matches real contracts |
| PB-3 | **Costing dedup + VAT basis** (F-2, F-53) | Disjoint acquisition channels rule; ex-VAT costing for registered orgs | Accountant review required |
| PB-4 | **Storage mini-spec** (F-34…F-38) | As §3 D6 | Technical — decided; tier GBs await D3 |
| PB-5 | **Customer share-link surface** (F-22) | Tokenized watermarked-derivative page, revocable | Confirm channel (link vs PDF-only) |
| PB-6 | **Capacity & schedule** (F-56) | See §5 | **Owner must answer v1 Q10 (hours/hiring)** |
| PB-7 | **Foreman auth method** (F-51) | Phone-OTP (SMS provider) or admin-issued credentials | Owner knows his foremen — choose |
| PB-8 | Payment/receipt unification (C-2) + keep-or-cut the receipt-approval ritual (F-20) | `payment_receipt` rename; ritual default-off | Owner preference |
| PB-9 | Export/multi-currency quoting (carry-over) | MVP = org currency; **owner confirms AED-only quoting is pilot-acceptable** given international boat customers — else per-document display currency gets specced pre-S6 | **Owner** |
| PB-10 | Parked items unchanged from 00-INDEX: D1 (by S0-start for legal lead time), D3 (pre-pilot invoicing), D4 (by S6), D2′ (pre-pilot) | — | Owner |

## 5. Scope & schedule correction (adopted plan)

**Cuts that keep the loop intact** (all reversible at P2/P3): pilot ships on **template #1 only** — templates #2–3 + their AI grounding move to P2 (they lack reference businesses anyway; v2 §15 itself calls ungrounded templates "a guess wearing a costume"); Worker archetype, `week_plan`, `insight`, `branch`, date-ranged assignments, E-11/E-12, evening digest, narration A/B — cut per §3; S0 auth narrows to email/phone-OTP + TOTP (OAuth → S9); **offline outbox narrows to daily-report + photo only** (issues/MRs/approvals online-only in MVP; foreman cards survive); S9 splits honestly into two slices (billing+compliance / hardening+drills).

**Revised calendar:** ~24–26 weeks with **two** builders. With **one** part-time builder (the current reality until Q10 is answered): either +2 months, or additionally defer Layer-A AI onboarding to P2 (pilots are founder-onboarded per the playbook anyway — template-pick + manual config is honest for 8 companies) which brings one-builder MVP back inside ~26–28 weeks. **This choice is PB-6 and is the single decision most likely to determine whether the plan is real.**

## 6. Corrected build-readiness checklist

Coding (S0) may start when all are true:

1. ☐ PB-1…PB-5 resolutions merged into docs 01/02/05/06/08/10/11 (amendment list in §7).
2. ☐ PB-6 answered: named builder capacity + chosen scope variant from §5.
3. ☐ PB-7 foreman auth chosen (and SMS provider selected if OTP).
4. ☐ PB-8/PB-9 owner preferences recorded.
5. ☐ Contradictions C-1…C-10 patched in the affected docs.
6. ☐ Doc 10 checklist regenerated with the ~9 new items (RLS mechanism test, config-string sanitiser, CSV-injection guard, serialization-boundary redaction, share-link surface, storage backup/quota/EXIF, offline-replay re-auth, holiday-calendar tests, retention policies) — renumbered 1–51.
7. ☐ External-dependency calendar (F-50) started: e-invoice partner shortlist requested; incorporation process opened; pen-test provisionally booked.
8. ☐ D11 `job` naming veto window formally closed by the owner.
9. ☐ Najolatech foreman + Arabic reviewer availability confirmed for S3/S4 gates.
10. ☐ Delivery plan reissued (doc 11 v2) with §5 scope, walking-skeleton AC, testable ACs (F-49), and per-slice index DoD.

## 7. Document amendment list (to apply on owner GO)

- **00-INDEX:** U5 updated (C-1); C-4 constants fixed; audit doc added to reading order; status → "audited — conditional go".
- **01:** billing_points; costing dedup rule + ex-VAT basis; `payment_receipt` rename; report header stage removed; `returned` review state; stage reopen transition; `job_crew` replaces `assignment`; cut week_plan/insight/branch/Worker; membership deactivation; credit-note kind; quote revision/acceptance; notification prefs; holiday calendar; storage appendix; retention appendix.
- **02:** quotedMinor precedence; phase predicates (F-19).
- **03:** C-6/C-7/C-12 wording; thumbnails note; foreman card 4 rewording.
- **04:** E-01 fixtures per country calendars; E-04 condition; E-05 wording; holiday/Ramadan inputs; digest payload redaction note.
- **05:** registry final (C-1/F-3); self-approval rule; offline replay binding; inbox redaction.
- **06:** attendance rows; assigned_job definition; serialization-boundary redaction rule; Worker removal; Viewer class note.
- **07:** key catalogue extension; numeral pinning; dual dropped.
- **08:** billing points encoding; working week; category→costing mapping reconciled; receipt ritual flag.
- **09:** Viewer class; onboarding AI caps; storage/AI abuse limits; retention values.
- **10:** regenerate per §6 item 6.
- **11:** reissue per §6 item 10.

---

**Final recommendation: CONDITIONAL GO.** The system as designed is the product the strategy demands — operations-first, job-centred, honestly scoped in its architecture. The conditions are a week of specification, four owner decisions, and one honest conversation about capacity. Nothing found argues for redesign; everything found argues for closing gaps *before* they become migrations.
