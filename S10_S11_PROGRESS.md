# S10–S11 autonomous build — progress checkpoint

Resume protection for the S10 (Hardening) → S11 (Pilot Readiness) run. Updated after every
major milestone. **Never redo a completed, green, deployed, cleaned slice. Do not begin any
post-S11 work. Stop after S11.**

## Owner directive (governing this run)
Finish S9 → verify → begin S10 automatically → complete fully → begin S11 automatically →
complete fully → STOP. No routine approvals. D1 remains an activation gate. Missing credentials
(Inngest/PDF/e-invoice/payment/AI/Sentry/Upstash/messaging) are NOT blockers — safe disabled
seams. Never activate real payments/D1-gated functions. Every prod demo: inventory baseline
first, hard-exclude Alpha Marine (`d22b2098-2e09-436d-ab9e-ee26c8719cd5`) + TESTING
(`9fcaa697-becd-41ec-97d4-6ce2851ead36`) by name AND UUID, dry-run cleanup before apply,
remove only synthetic data (incl. explicitly-authorized synthetic outbox + fake-provider
residue), confirm baseline + health after. If the safety classifier blocks a destructive
cleanup: pause ONLY at that approval point with dry-run evidence; never bypass.

## S10 — FROZEN SCOPE (from phase2/11 §S10 + BUILD_BIBLE + doc 10 + 12-AUDIT/13-FREEZE + S6–S9 deferred items; 6-reader workflow wf_d8687ba5)

**Objective (verbatim):** "production-quality, not feature-complete-quality." No new features except OAuth. AC (audit F-49): the enumerated launch-criteria evidence — perf budgets met at synthetic volume, all doc 10 DRILL/REV items green, restore-drill evidence with measured RPO/RTO, zero open sev-1 Arabic issues.

**A. Explicit doc-11 S10 deliverables:**
1. **Perf pass to budgets (fix, not measure)** at synthetic volume 200 jobs/50k reports/200k lines/2 orgs: Today p95 <1.5s compose; report submit <10s; approvals inbox <800ms, decide <1.2s; API reads <500ms writes <1s; costing <1.5s; search <1s; nightly <5min/org. EXPLAIN evidence for hot queries (F-29). Budgets must hold DESPITE Seoul latency (region frozen A-B7; a measured miss is the only change-control trigger).
2. **Arabic review all surfaces** (AC: zero sev-1) — AI review pass now; human native reviewer = owner action (F-50).
3. **OAuth Google/Microsoft** — the ONE net-new build (deferred from S0). Build flow/UI credential-gated (provider secrets = owner, Supabase dashboard).
4. **First restore drill — DB AND storage** to plain Postgres + plain S3 (doc 10 #47), measured RPO/RTO vs published objectives RPO≤1h/RTO≤4h (#48), evidence filed.
5. **Incident tabletop** (#50: detect→contain→per-tenant scope→notify→post-mortem, runbook + tabletop evidence).
6. **Backup monitors verified** (#46: PITR, nightly logical backup, bucket replication+manifest — second-provider replication is credential-gated: build seam + document).
7. **Recycle-bin/closure walkthrough** (#40: 30d draft bin; closure export-first purge; storage-object deletion verified). Gates on #41 legal hold + #42 export.
8. **Pen-test prep pack** (#51a; scope = items 1-14, 15-22, 27, 30). Booking (due S6) = owner escalation if absent.
9. **All doc 10 DRILL/REV items green** (rotation runbook+drill #37, break-glass runbook #45, staff-access drill #44, PDPL REV #43=owner).

**B. Build-if-missing (doc 10 items no slice ever claimed):** #25 CSV/Excel formula-injection guard in the export layer; #27 document malware-scan seam + origin isolation confirm; #30 session device list + remote sign-out + refresh rotation (verify Supabase, harden gaps); #36 retention pruning jobs per doc 01 App B (monitored; financial audit rows ≥6y floor); #39 storage quota metering completeness; #41 legal hold suspends ALL deletion pipelines incl. storage; **#42 full self-service export (CSV/Excel + files manifest, every tier, completeness test over the entity catalogue, redaction walls apply — exports are a serialization boundary F-23)**; doc-10 text additions: webhook-signature-verification + no-card-data/PCI items (code shipped in S9; checklist text never added — grep-verified absent).

**C. S6–S9 deferred engineering (from reports/checkpoint):** cross-instance entitlement-cache invalidation (60s TTL is same-process only); platform-task least-privilege (DEFINER fns granted to app_user behind assert_platform_task — decide dedicated role vs documented acceptance); deflake events-outbox relay-timing test; fix full-integration wrapper exit-code propagation; recover + triage the 9 S9 review MINORs from wf_b583ff85 (only 2 enumerated anywhere); per-tenant telemetry (AI spend/org, storage+egress/org, approval latency, reports/day/org — governed minimal surface) + egress cache-control headers (F-37); advisory-lock TOCTOU standardization or documented softness per limit; test-teardown self-cleaning convention (stop leaking orgs → stop classifier-blocked sweeps); hosted tenancy-harness in routine gates (S9 lesson); catalogue-drift reconciliation (add release-gated keys or record-deferred; parity test stays green); terminology.overrides config-pipeline handler (S8 gap); AI-spend breaker regression; grace-window day-count documented; trial-abuse verify (per-IP/device signup throttle, disposable-email screening, trial-org restrictions) — build gaps; 7-row fake-provider purge (batched at demo-cleanup approval).
**Decisions taken (governed defaults):** `paused` billing state stays DEFERRED (v1 "if offered", not committed); partitioning NOT implemented (frozen decision, volume-triggered); E-tier keys (sso/white_label/multi_company/api/add-on SKUs) recorded-deferred, not built; limit.automation_runs_month DROPPED from v1 catalogue (no code counterpart; record in freeze log).

**D. Verify-only sweep (re-prove, never rebuild):** RLS second wall + wrong-ctx; tenancy/bleed coverage completeness; matrix runner; redaction at all 4 boundaries (inbox/notifications/digest/files) + exports; sanitiser/CSV/prompt-injection; share surface; photo EXIF; immutability set; sole-writers; FK/no-hard-delete; worker registration parity; security headers; health; calendar fixtures; money goldens; session revocation; IDOR harness; DEFINER search_path audit (doc 10 law — Bible delegates).

**E. MUST NOT (scope guard FS-1/FS-2 + freeze):** GL, payroll, stock, QC, builders, public API, multi-company, white-label, WhatsApp, Worker archetype, week_plan, insight, branch, date-ranged assignments, templates #2–3, E-11/E-12/E-14/E-15, evening digest, change orders, offline approvals, region migration, implementing partitions, real payments/D1 activation. Frozen decisions change only via dated amendment (security issue / measured budget miss / pilot evidence) with owner approval.

**F. Owner actions surfaced by the freeze (report at S10 close):** Arabic native reviewer; pen-test booking confirmation (was due S6 — escalation); OAuth provider credentials; second-provider backup credentials; Supabase PITR plan confirmation; AI-provider no-training contract terms evidence; carried set (Inngest keys, PDF runtime, Sentry, Upstash, rotation, junk Vercel projects, D1/D3/tax/KSA/DPA, PB-3/OP-5, OP-4 name check, pilot cohort).

## Current position
- **Current stage:** S10 — scope FROZEN (above). Next: Phase 1 audits.
- **S9 CLOSED:** code deployed+verified `7e56bca` (CI green, 18/18 prod smoke incl.
  deployed-commit match); docs commit `17bcfd8` CI green + prod serves it. Baseline =
  [Alpha Marine, TESTING]; S9 org-scoped tables 0. Report: docs/S9-COMMERCIAL-COMPLETION.md.
- **Local HEAD / deployed:** 17bcfd8 / 17bcfd8. **Migrations:** highest 0060, next 0061
  (ledger verified: `pnpm db:migrate` → applied [none]).
- **Pending classifier-gated purge:** 7 inert `subscription_event` rows (org_id=NULL,
  provider='fake' — S9 test webhook residue; dry-run evidence in
  tooling/scripts/s9-residue-purge.ts output). Owner directive authorizes removal; the
  auto-mode classifier blocked `--apply` twice. **Batch this request into the next
  classifier approval point (S10 demo cleanup).** Rows are inert: fake provider disabled in
  prod, unreadable by tenants (0060 deny policy + no grant).
- **Exact next task:** S10 Phase 1 — (a) recover the 9 S9 review MINORs from the wf_b583ff85
  journal (session subagents/workflows dir); (b) launch the multi-lens hardening AUDIT
  workflows over the real codebase (security/tenancy/DEFINER-search_path lens, concurrency/
  idempotency lens, pagination/aggregation/index lens, redaction lens, worker/outbox/retry
  lens, i18n/a11y lens) → findings register; (c) verify-first checks: perf harness liveness,
  quota metering, session mgmt, legal hold, trial-abuse controls. Then Phase 2 builds
  (OAuth seam, export #42 + CSV guard #25, retention #36, cache invalidation, telemetry,
  terminology handler, wrapper fix, deflake, teardown convention), Phase 3 drills, Phase 4
  perf pass, Phase 5 Arabic sweep, Phase 6 review→gates→CI→deploy→demo→cleanup→report.
- **S10 phase plan:** 1 audits → 2 builds → 3 drills/runbooks → 4 perf → 5 Arabic/a11y →
  6 close (review, gates, deploy, Arabic prod demo, cleanup incl. batched 7-row purge, report).

## Test counts at S9 close (baseline for regression)
unit 299/299 · S9 integ 21/21 · tenancy+bleed 17/17 · full integration + e2e green on CI ·
prod smoke 18/18.

## Remaining owner actions (carried from S9 close)
D1 entity + merchant of record; D3 pricing numbers + tier limits (placeholders live); tax
mechanism; KSA lawful-transfer basis pre-KSA-pilot; DPA/PDPL posture doc; merchant/provider
secrets + per-currency price IDs + Inngest keys (secret store only); e-invoice/ZATCA partner
+ creds; payment-provider creds; org pricing/tax/VAT-registration config; PB-3 accountant
VAT sign-off; Sentry DSN; Upstash; password rotation before pilots; delete 4 junk Vercel
projects.

## Resume instruction
Read this file top-to-bottom, verify HEAD + deployed commit + migration ledger match the
"Current position" block, then continue from "Exact next task." Do not repeat completed work.

## S10 build log
- **Wave A DONE (commit 30e8e6d, hosted 0000-0063, NOT pushed yet).** 8-lens audit
  (wf_1374bc82; 6 confirmed material, ~40 minor, doc-10 gap inventory → docs/S10-AUDIT-REGISTER.md;
  23 S9 findings recovered → docs/S9-REVIEW-FINDINGS-RECOVERED.md). Fixed: APP_ENV prod-guard on
  3 provider seams (CRITICAL — prod served fake providers; isProd() helper + regressions), missing
  indexes 0061, DEFINER platform-task guard + usage_event delta>=0 (0062), onboarding double-apply
  claim + approval_rule one-always partial-unique + payment idempotency (0063 + services), worker
  per-org fault isolation ×3, aria-label remove fix. Gates green: typecheck/lint(0)/unit 303/303/
  tenancy+bleed 17/17/s8 5/5. Migration-ledger lesson: `status IN (...)` normalises to `= ANY(ARRAY)`
  so match CHECK-drop DO-blocks on a literal enum value, not on 'in'.
- **REMAINING S10 waves:** B = Arabic language switcher (MATERIAL) + redaction refinements +
  withdraw/GRN-cancel guards + webhook cap/limit + subscription-action logging + Arabic sev-1 +
  E-01/reconcile window + notif/auth i18n + terminology.overrides handler + events-outbox determinism
  + s6/s7 afterAll cleanup. C(builds) = retention pruning #36, export #42 + CSV guard #25, recycle-bin/
  closure #40/#11, backup monitor #46, egress headers #37, malware seam #27, OAuth #28, cross-instance
  cache invalidation, telemetry-min, perf CI step. Phase 3 drills+runbooks, 4 perf pass, 5 Arabic sweep,
  6 review/gates/deploy/demo/cleanup(+7-row purge)/report. Documented residuals: advance_subscription
  CAS (latent/D1), approval rule_id composite FK (unreachable), dedicated platform DB role (guarded),
  paused state (deferred), partitions (frozen).
- **Phase 1 started.** Milestone commit c541e00 (scope freeze + purge tooling). The 23 S9
  review findings RECOVERED from wf_b583ff85 → docs/S9-REVIEW-FINDINGS-RECOVERED.md (the
  9 MINOR + 4 NIT now enumerated; notable: BILLING_PROVIDER=fake env-override order vs prod
  guard; unauthenticated webhook DB work w/o rate limit; 0058 scan fns granted to app_user;
  in-memory signup throttle; usage_event negative-delta tenant INSERT; dedup w/o period_key).
- **Audit workflow wf_1374bc82-86c running** (8 lenses: tenancy-rls, concurrency,
  paging-index, redaction, workers-outbox, i18n-a11y, errors-observability, gap-inventory;
  materials get 2-refuter adversarial verify).
- **Verify-first facts established:** (a) NO perf step in ci.yml — S5 harness exists
  (tooling/scripts/s5-perf-harness.ts, self-cleaning, asserts Today p95<1.5s / costing
  p95<1.5s / nightly<5min; default fast proxy volume 30j/10r/4l; full volume via PERF_JOBS
  etc. env) but is not asserted per-merge → Phase 4 wires a CI perf step + adds report-submit
  <10s + approvals-inbox <800ms assertions + one full-volume evidence run. (b) Runbooks
  existing from Phase I: deployment-and-rollback, incident-response, dead-letter-recovery,
  secret-rotation, restore-drill (STUB), inngest/sentry-provisioning + README — Phase 3
  executes drills + fills evidence; break-glass runbook MISSING (#45) → write. (c) No local
  pg_dump/psql/Docker → restore drill approach: install PostgreSQL 17 locally (winget) as
  the plain-Postgres target + client tools; storage restore via S3 creds to a scratch
  local dir with manifest verification. (d) test:integration is plain vitest — the S6
  exit-code trap was shell piping (`| tail` w/o pipefail); institutionalize via a gates
  runner script + pipefail discipline in Phase 2.
