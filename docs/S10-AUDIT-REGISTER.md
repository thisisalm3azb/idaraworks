## LENS  — 15 findings
- [MATERIAL] doc10 #12 org-closure pipeline — PARTIAL: 'purged' is a billing_state flip only; no data/storage purge executor, no export-first bundle, no verify step — src/workers/functions/subscription-worker.ts:57
  FIX: Minimal governed implementation: a platform purge worker that, after advance_subscription→purged succeeds, (1) writes an export bundle (JSON/CSV per entity via the future export writer) to a closure prefix, (2) deletes org-prefixed objects via objectStore().list/del per bucket, (
- [MINOR] doc10 #1 perf harness — PARTIAL: harness exists but CI never runs it, and report-submit<10s is asserted nowhere — tooling/scripts/s5-perf-harness.ts:137
  FIX: Add a CI step in the integration job (local stack is co-located): PERF_COLOCATED=1 pnpm tsx tooling/scripts/s5-perf-harness.ts at a pinned volume, and add a timed submitReport loop asserting <10s.
- [MINOR] doc10 #5 trial-abuse — PARTIAL: per-IP signup throttle exists (durability = Upstash owner-action, fail-open), but no disposable-email screening and zero trial-org restrictions — src/app/(auth)/actions.ts:77
  FIX: Minimal: a small disposable-domain denylist check in signupAction; a trial-specific entitlement override (e.g. limit.storage_gb=2 while billing_state='trialing'); an 'upload' RATE_RULES scope checked in signUpload.
- [MINOR] doc10 #6 retention pruning — PARTIAL: only the domain_event outbox is pruned; notification/exception/ai-spend/digest rows grow forever — src/platform/events/relay.ts:26
  FIX: One nightly per-org pruning worker with the doc-10 windows as constants (notification 90d read/12mo all, exception cleared>24mo, ai tables 90d detail/12mo aggregate, digest 90d), each via an assert_platform_task DEFINER delete.
- [MINOR] doc10 #3 session management — PARTIAL: remote sign-out exists, refresh rotation on (local config), but no device/session list — src/app/(auth)/actions.ts:107
  FIX: Minimal: an account-page list read from Supabase auth admin sessions (or GoTrue /user sessions endpoint) with per-session revoke; record the hosted rotation setting in runbooks/ as OA evidence.
- [MINOR] doc10 #7 self-service export — MISSING: no per-entity CSV/export code exists anywhere; feat.audit_export is a dead flag — src/platform/entitlements/catalogue.ts:32
  FIX: Minimal: one governed route handler per entity family (jobs, reports+lines, expenses, invoices/payments, audit_log) streaming CSV through withCtx paged reads, gated by an authz action and feat.audit_export for the audit table.
- [MINOR] doc10 #9 document malware-scan seam — MISSING: the promised S4 landing never happened; uploads stay images-only with no scan interface — src/platform/files/classmap.ts:24
  FIX: Minimal seam: a scanDocument(buffer) adapter in platform/files (default pass-through, env-gated provider later) called in the ingest worker before flip-to-ready, with a 'quarantined' file status.
- [MINOR] doc10 #10 backup monitors — MISSING: health/ops surface has no backup-status check; restore drill is an explicit stub — src/platform/observability/health.ts:41
  FIX: Minimal: a nightly ops check (extend an existing cron) that calls the Supabase management API for backup/PITR status and raises the standard Sentry alarm on failure; record it in the health report as a non-gating check.
- [MINOR] doc10 #15 break-glass + rotation runbooks — PARTIAL: rotation runbook complete; break-glass exists only as a note, not a runbook — runbooks/restore-drill.md:29
  FIX: Minimal: promote the restore-drill note into runbooks/break-glass.md — trigger conditions, two-party approval record format, DIRECT_URL-only access rule, post-hoc tenant notification, and the audit entries to write.
- [MINOR] doc10 #11 recycle-bin for drafts (30d) — MISSING: void-never-delete design has no restore path or window anywhere — src/platform/authz/matrix.data.ts:17
  FIX: Minimal: an 'unvoid within 30 days' DEFINER per voidable entity (guard: voided_at > now()-'30 days', legal_hold-aware, audited) plus a trash listing filtered on voided_at.
- [NIT] doc10 #2 storage quota metering — EXISTS: transactional byte counter, warn80/block100 at signUpload, nightly reconcile with leak detection — src/platform/files/storage.ts:271
- [NIT] doc10 #4 legal hold — EXISTS at both file and org level, suspending deletion incl. the storage-object paths that exist — supabase/migrations/0059_s9_legal_hold_purge_guard.sql:41
- [NIT] doc10 #8 CSV formula-injection guard — MISSING as an egress guard, but no CSV writer exists to inject through; input-side lead-char rejection exists only for config strings — src/platform/config/sanitize.ts:27
  FIX: When building #7, route every cell through one shared csvEscape() that quotes and prefixes ' to leading = + - @ TAB CR.
- [NIT] doc10 #13 egress cache-control on image derivatives — MISSING: derivative objects are PUT with Content-Type only; no Cache-Control metadata ever set — src/platform/tenancy/storage.ts:98
  FIX: Add 'Cache-Control: private, max-age=3600' (thumb/medium) as a header on the derivative PUTs — Supabase S3 protocol persists it as object metadata served on GET.
- [NIT] doc10 #14 OAuth sign-in — MISSING: email/password (+MFA) only; no signInWithOAuth anywhere — src/app/(auth)/actions.ts:61
  FIX: If wanted pre-E-tier: enable the Google provider in Supabase auth and add a signInWithOAuth redirect action beside loginAction — no schema change needed.
SUMMARY: Doc-10 gap inventory over C:/Users/abdul/Desktop/idaraworks (read-only; real code verified, no writes run). Verdicts: EXISTS (2): #2 storage quota metering (org_storage_usage counter + warn80/block100 in signUpload + nightly reconcile with leak detection) and #4 legal hold (file-level DEFINER hold + org-level purge guard 0059, tested). PARTIAL (6): #1 perf harness exists (Today/costing p95<1.5s asserted co-located, nightly<5min) but CI never runs it and report-submit<10s is asserted nowhere; #3 
## LENS  — 12 findings
- [MATERIAL] invoice.corrects_invoice_id has no index — credit-note offset is an O(N²) correlated scan in four hot money paths — supabase/migrations/0042_s6_invoices.sql:66
  FIX: Add `create index invoice_corrects_idx on public.invoice (corrects_invoice_id) where corrects_invoice_id is not null;` (or (org_id, corrects_invoice_id)). Optionally rewrite the per-invoice correlated sums as a single grouped LEFT JOIN over credit notes.
- [MINOR] goods_receipt_line.po_line_id has no index — receipt math scans all of an org's GRN lines per PO — supabase/migrations/0035_s4_supply.sql:214
  FIX: Add index on public.goods_receipt_line (org_id, po_line_id) — it also covers the FK.
- [MINOR] listJobs is unbounded (no LIMIT, no paging) and feeds the jobs page plus three picker pages — src/modules/jobs/service.ts:244
  FIX: Add limit/cursor to listJobs (status filter + server paging on the jobs page); pickers should use a bounded brief query like listActiveJobsBrief (expenses/service.ts:263 already does this correctly).
- [MINOR] No list surface has server paging — hard caps silently truncate; rows past the cap are unreachable in the UI — src/modules/invoices/service.ts:449
  FIX: Add cursor-based paging (created_at,id keyset) to the billing/supply list services and a load-more/pager in the UI, or at minimum a reference search.
- [MINOR] Nightly rollup reconcile recomputes every 'done' job forever — per-job transactions grow with lifetime job count — src/modules/costing/service.ts:222
  FIX: Reconcile only 'active'/'on_hold' jobs plus jobs done within a trailing window (e.g. 30 days), or jobs whose rollup computed_at predates the last source mutation.
- [MINOR] E-01 missing-report evaluator aggregates over the org's entire daily_report history every night — src/modules/exceptions/service.ts:715
  FIX: Use a correlated `(select max(report_date) ...)` with an index on (org_id, job_id, status, report_date) — or simply restrict the join to `r.report_date >= current_date - 30` since only recent reports matter for the gap.
- [MINOR] listMyNotifications reads the recipient's whole notification history with no LIMIT — src/platform/notifications/notify.ts:81
  FIX: Add `limit` (default ~50) + unread-first keyset paging now, before a consumer bakes in the unbounded contract; add a retention purge alongside the domain_event one.
- [MINOR] listComments loads and renders every comment on an entity with no cap — src/platform/comments/service.ts:99
  FIX: Cap at the newest N (e.g. 50) with a 'show older' keyset fetch; comment_org_entity_idx (org_id, entity_type, entity_id, created_at) already supports it.
- [NIT] listJobReports is unbounded per job (~365 rows/year) — latent, no UI consumer yet — src/modules/reports/service.ts:540
  FIX: Add a default limit + keyset paging before a consumer appears; daily_report_job_date_uq (org_id, job_id, report_date) supports it directly.
- [NIT] quote.converted_job_id FK has no index — every costing read scans the org's converted quotes — supabase/migrations/0041_s6_quotes.sql:61
  FIX: Add index on public.quote (org_id, converted_job_id) where converted_job_id is not null.
- [NIT] Report line replacement issues up to ~253 sequential single-row statements per submit — src/modules/reports/service.ts:337
  FIX: Batch each line table into one multi-row INSERT (sql.join of value tuples) or one insert ... select from jsonb_to_recordset.
- [NIT] Today manager/foreman 'missing today' computes the filter in app instead of SQL — src/modules/today/service.ts:160
  FIX: Push `having coalesce(max(r.report_date),'') < ${asOf}` (or the correlated comparison) into SQL and cap items like the other cards.
SUMMARY: Pagination/aggregation/index audit of idaraworks (raw SQL via drizzle/postgres.js — the PostgREST 1,000-row cap does NOT apply to this app; unbounded reads instead cost memory/latency). Overall discipline is good: most lists are capped (200/500), digest/AR/usage metering aggregate in SQL, the week view batch-fetches to avoid N+1, the outbox relay pages by SKIP LOCKED batches, and hot paths (approval inbox, open exceptions, report idempotency, payment-by-invoice) are indexed. Top offenders: (1) M
## LENS  — 5 findings
- [MATERIAL] Production serves the FAKE billing provider — prod guard tests wrong APP_ENV string ("production" vs the actual "prod") — src/platform/billing/adapter.ts:209
  FIX: Gate on the real production sentinel used everywhere else — `APP_ENV === "prod"` (or invert to an allowlist of non-prod). Apply the same fix to the two sibling seams below. Add a test that asserts getBillingProvider() with APP_ENV=prod (no BILLING_PROVIDER) returns the disabled p
- [MATERIAL] Same broken APP_ENV guard leaves e-invoice and AI-narration FAKE providers active in production — src/platform/einvoice/adapter.ts:94
  FIX: Change both guards to `APP_ENV === "prod"` (matching the rest of the codebase). Ideally centralize the 'is production' check in one helper so all provider seams cannot drift again.
- [MINOR] Billing webhook is unauthenticated with no rate limit and an unbounded body read — src/app/api/billing/webhook/route.ts:19
  FIX: Add a Content-Length / byte cap before/around request.text() (reject oversized bodies with 413) and a per-IP rateLimit("webhook", ip) scope; keep returning 200 only for governed outcomes after the cap/limit checks.
- [MINOR] Every rate limiter is per-instance in-memory absent Upstash; one rule is dead and invite_send keys on a spoofable header — src/platform/http/rateLimit.ts:62
  FIX: OA-4 (require Upstash before pilots) covers durability; additionally remove the dead otp_send rule or wire it, and switch invite_send to the same trusted-IP order (clientIpFromHeaders) used by the auth actions.
- [MINOR] Subscription server actions swallow failures with no log or Sentry capture — src/app/(app)/o/[orgId]/settings/subscription/actions.ts:21
  FIX: Log the caught error via requestLogger/logger.error (identifiers only) and/or call captureRequestError before redirecting to notice=error, so these swallowed mutations still emit a correlated observability signal.
SUMMARY: The headline defect is MATERIAL and cross-cutting: the billing, e-invoice, and AI-narration provider seams all gate their production 'disabled' behavior on `process.env.APP_ENV === \"production\"`, but the canonical production value in this codebase is \"prod\" (proven by .env.example:8, the live inngest route guard at api/inngest/route.ts:27 which uses \"prod\", and runbooks/sentry-provisioning.md). Because the inngest deploy path works with \"prod\", production definitively runs APP_ENV=prod, 
## LENS  — 9 findings
- [MINOR] events-outbox relay test asserts on GLOBAL outbox state against a shared, persistent hosted dev DB — the flake is backlog-dependent, not timing — tests/integration/events-outbox.test.ts:143
  FIX: Make the test event-scoped and the pre-state deterministic: (1) in beforeAll, drain the queue with `while ((await relayOutbox(noop)).claimed > 0) {}`; (2) assert on the specific row — look up the domain_event id by nonce, assert `sent` contains that id and the row's processed_at 
- [MINOR] invoice/issued consumer re-submits the e-invoice to the provider on every retry/redelivery — compute+send with no idempotency guard on the send (latent behind the fake-provider seam) — src/modules/invoices/service.ts:328
  FIX: Before provider.submit, read einvoice_submission for (org_id, invoice_id) and short-circuit when a terminal status/external_id exists; additionally pass invoiceId as an idempotency key through the EInvoiceProvider interface so real adapters can dedup server-side.
- [MINOR] dispatchNightly fan-out has no per-org fault isolation — one failed inngest.send aborts dispatch for every remaining org — src/workers/functions/exception-engine.ts:186
  FIX: Wrap the send in try/catch per org, count and log failures, continue the loop; return { dispatched, failed }.
- [MINOR] runReconciliation: per-org provider network fetch unguarded in the loop — one org's provider error aborts reconciliation for the rest of the fleet — src/workers/functions/subscription-worker.ts:122
  FIX: try/catch per row: log the org + error, continue; optionally record a 'recon_fetch_failed' finding for the org.
- [MINOR] sweepLifecycle's dunning branch sits outside the per-org error guard, contradicting its own 'per-org fault-isolated' contract — src/workers/functions/subscription-worker.ts:49
  FIX: Move the recordDunning call inside the same per-org try/catch that guards applyTransition (or its own).
- [NIT] verifyOrgPayload throws retriable errors for permanent failures — Inngest burns all retries on payloads that can never verify — src/workers/harness.ts:63
  FIX: Wrap verifyOrgPayload failures (OrgVerificationError, ZodError) in inngest's NonRetriableError inside defineOrgFunction.
- [NIT] checkDeadLetters re-alarms the SAME dead-lettered events every minute for up to 30 days — src/platform/events/relay.ts:92
  FIX: Alarm only on deltas — e.g. track the last-seen dead-letter count/max(id) in the relay run output, or add a `alerted_at` stamp / `where last_attempt_at > now() - interval '2 minutes'` filter to the DB function.
- [NIT] applyTransition: state advance and its platform audit row are two separate statements on a pooled client, not one transaction — src/modules/subscription/service.ts:190
  FIX: Run both statements in one transaction (db.transaction / a combined DEFINER function that advances and audits atomically).
- [NIT] s6-bill and s7-improve integration suites never clean their orgs or domain_event rows — the outbox backlog feeder (and those orgs are permanently undeletable) — tests/integration/s6-bill.test.ts:81
  FIX: Mirror the s1-s5 afterAll cleanup (delete domain_event, audit_log, feature rows, membership, org) in s6-bill and s7-improve.
SUMMARY: Workers/events/outbox reliability audit of C:/Users/abdul/Desktop/idaraworks (read-only; no files modified, no DB access). VERDICTS BY CHECK: (1) Registry parity — CLEAN: exactly 22 Inngest functions are defined (grep of inngest.createFunction/defineOrgFunction across src) and all 22 appear in workerFunctions (src/workers/index.ts:65-88); /api/inngest serves that exact array (src/app/api/inngest/route.ts) with a correct both-keys-or-503 guard; no import-but-not-registered dead functions (sweepSt
## LENS  — 11 findings
- [MATERIAL] applyOnboarding has no concurrency claim; duplicate 'always' approval rules pass the in-tx ambiguity check and permanently wedge rule config — src/modules/onboarding/service.ts:196
  FIX: Claim the session first (guarded UPDATE status 'proposed'→'applying' RETURNING, mirroring acceptQuote), and add a partial unique index on approval_rule (org_id, subject_type) WHERE condition_kind='always' AND active (plus map 23505 to RuleValidationError). Add a deactivate path f
- [MINOR] app.advance_subscription has no compare-and-set on the from-state — concurrent webhook/sweep writers can persist illegal billing transitions (latent until D1/Inngest activation) — supabase/migrations/0053_s9_subscription_events.sql:101
  FIX: Add p_expected_from to advance_subscription and no-op/raise when v_old <> p_expected_from (or re-run nextForEvent legality inside the function after the FOR UPDATE).
- [MINOR] Webhook processing is at-most-once: a failure after the first-wins inbox insert permanently swallows the billing transition (latent until D1) — src/modules/subscription/service.ts:113
  FIX: Make the duplicate path re-check status: if the existing row is unprocessed and verified, reprocess it; or claim-and-process in one transaction; or add an unprocessed-inbox sweeper.
- [MINOR] Unverified-event inbox poisoning confirmed still present: unverified rows squat the (provider, provider_event_id) idempotency namespace and the duplicate short-circuit precedes the verified gate (latent until D1) — src/modules/subscription/service.ts:107
  FIX: Record unverified events in a separate namespace (e.g. prefix the event id, or a verified flag in the unique), or on 'duplicate' allow a verified delivery to upgrade-and-process an unverified/unprocessed row.
- [MINOR] withdrawApproval resets the subject's status unconditionally (no cfg.live guard) — can resurrect a voided payment into AR when it gets wired to the UI — src/modules/approvals/service.ts:702
  FIX: Mirror decide: `where ... and status = ${cfg.live}` on the withdraw subject UPDATE (and for MR, `status='submitted'`).
- [MINOR] recordPayment has no idempotency key — a duplicate submission mints two payments that immediately count toward the invoice — src/modules/payments/service.ts:45
  FIX: Add a client-generated idempotency key column + partial unique (org_id, idempotency_key) mirroring daily_report, dedup on 23505.
- [MINOR] usage_event tenant INSERT policy accepts arbitrary (including negative) deltas with caller-chosen dedup keys — poisonable billing meter, currently unexploited — supabase/migrations/0054_s9_usage_audit.sql:28
  FIX: Add `check (delta > 0)` to the tenant policy's WITH CHECK (or a table check + a platform-only DEFINER for negative corrections) before any consumer ships.
- [MINOR] acceptQuote crash window strands the quote in 'converting' with no recovery path (and can orphan the created job) — src/modules/quotes/service.ts:252
  FIX: Add a converting-timeout release (e.g. a guarded 'converting' → 'approved' reset for rows older than N minutes, or store claimed_at and let acceptQuote re-claim stale converting rows).
- [MINOR] changePlan always drives the change through the FAKE provider's signed event — with a real provider enabled it silently no-ops while reporting success — src/modules/subscription/service.ts:320
  FIX: Route plan changes through the provider adapter (add changePlan to BillingProvider) and/or check the returned WebhookOutcome and fail loudly on 'unverified'.
- [NIT] cancelGoodsReceipt's cancel UPDATE has no status guard and its status pre-check precedes the PO lock — concurrent double-cancel duplicates audit rows and GOODS_RECEIPT_CANCELLED events — src/modules/supply/service.ts:695
  FIX: Guard the UPDATE with `and status='recorded'` + RETURNING and throw SupplyStateError on 0 rows.
- [NIT] startOnboarding per-org call cap and platform spend breaker are both read-then-act TOCTOUs (bounded overage; free provider today) — src/modules/onboarding/service.ts:86
  FIX: Move the count + insert into one transaction under a per-org advisory lock (pattern already used for jobs.create), or accept and document the bounded overage.
SUMMARY: Concurrency/idempotency audit of idaraworks (read-only; no DB writes, no org data touched). The core mutation spine is genuinely well-guarded: 0037 partial uniques back the approval engine (one live approval per subject, one PO per MR) with 23505 mapping to typed errors; report submit is exactly-once via client idempotency key + partial unique + FOR UPDATE + a rollback sentinel; decide/review/issue/void/convert/claim transitions all use guarded UPDATE...RETURNING; GRN receipts serialize on a PO 
## LENS  — 15 findings
- [MATERIAL] Arabic UI is unreachable: no language switcher is wired and user_profile.locale is never written — src/app/(auth)/actions.ts:33
  FIX: Wire a visible language toggle (e.g. in the org layout header / account page) that calls setActiveLocaleAction, and persist the choice to user_profile.locale. The 'later slice' comment covers only the durable profile editor — the switcher seam was built and orphaned; S11 pilot re
- [MATERIAL] Remove-material button is announced as "Add" to screen readers (destructive mislabel) — src/app/(app)/o/[orgId]/reports/new/ReportComposer.tsx:415
  FIX: Add a `remove` key to ComposerDict/messages (e.g. common.remove exists as jobs.crew.remove) and use it as the aria-label.
- [MINOR] Notification and email content is hardcoded English (titles interpolate raw enums) — src/modules/approvals/service.ts:473
  FIX: Route notification/email copy through t() with the recipient's stored locale (recipient user_profile.locale is available at createNotificationIn time); never interpolate enum values into prose.
- [MINOR] Hardcoded English notices bypass t() on auth surfaces — src/app/(auth)/login/page.tsx:20
  FIX: Add auth.login.confirm_email_notice and auth.account.others_signed_out keys to en/ar catalogs and use t().
- [MINOR] Approvals card renders raw subject type + role key with a hardcoded LTR arrow — src/app/(app)/o/[orgId]/approvals/page.tsx:92
  FIX: Use existing keys (nav.purchase_orders / nav.material_requests or onboarding.subject.*) for the subject label; resolve assignedRole through role_definition display names; mirror the arrow per direction as done in quotes.converted_job.
- [MINOR] Arabic catalog language defects: broken passive, wrong plural agreement, wrong term for minor units, Arabic-Indic digit, ambiguous link label — src/platform/i18n/messages/ar.json:611
  FIX: Rewrite csv_note passive; convert imports.apply to ICU plural ({n, plural, one {...} two {...} few {...} many {...} other {...}}); standardize on (صغرى); replace ٦ with 6; reword converted_job (e.g. "الانتقال إلى {job} المُحوَّل ←").
- [MINOR] Sibling <label> without htmlFor across all client field flows — controls have no accessible name — src/app/(app)/o/[orgId]/reports/new/ReportComposer.tsx:272
  FIX: Either nest the control inside the <label> (pattern already used in imports/customer-updates pages) or add useId()+htmlFor; give per-row hours/qty inputs contextual aria-labels (e.g. `${name} — ${dict.normal_hours}`).
- [MINOR] Attendance date filter cannot be applied on phones (GET form with no submit control) — src/app/(app)/o/[orgId]/attendance/page.tsx:44
  FIX: Add a small submit Button (or prev/next day links like week/page.tsx uses).
- [MINOR] Chip toggle buttons expose no pressed state to assistive tech — src/app/(app)/o/[orgId]/reports/new/ReportComposer.tsx:290
  FIX: Add aria-pressed={on} to each chip button (they are already type=button, so this is a one-attribute change).
- [MINOR] "As of" times rendered as raw UTC HH:MM and business "today" hardcodes Asia/Dubai instead of the org timezone — src/app/(app)/o/[orgId]/page.tsx:104
  FIX: Thread resolved org timezone into formatDateTime/today computations; format computedAt with formatDateTime(..., { timeZone: orgTz }) instead of ISO slicing.
- [MINOR] Raw English backend errors surface untranslated in UI (zod import row errors, Supabase MFA errors) — src/modules/imports/service.ts:126
  FIX: Map zod issue codes to i18n keys at render time (status enum is already translated — do the same for error categories); map known Supabase MFA error codes to auth.mfa.* keys with a generic translated fallback.
- [MINOR] Price adjustments render raw minor-unit integers instead of formatMoney — src/app/(app)/o/[orgId]/jobs/[jobId]/page.tsx:462
  FIX: Use formatMoney(adj.amountMinor, currency) like the rest of the pricing card.
- [MINOR] Header actions row overflows at 375px; BottomNav is dead code but AppShell still pads for it — src/app/(app)/o/[orgId]/layout.tsx:113
  FIX: Collapse header actions into the burger/overflow pattern on <md, or actually mount BottomNav with role-scoped items; align pb-24 with whichever chrome ships.
- [NIT] Mixed-language content announced with wrong lang: global-error hardcodes lang="en" around Arabic text; public share page switches dir but not lang — src/app/global-error.tsx:24
  FIX: Wrap each language run in <span lang="ar">/<span lang="en">, and set lang on the share page main alongside dir.
- [NIT] Untranslated fixed strings in shared primitives and minor surfaces — src/platform/ui/BottomNav.tsx:22
  FIX: Accept label props on BottomNav/Spinner defaults; add countries to the catalogs; aria-label the ✓ button; translate diff kinds; add aria-current="page" to the active job tab.
SUMMARY: i18n/RTL/a11y/mobile audit of C:/Users/abdul/Desktop/idaraworks (src/app, src/platform/ui, src/platform/i18n). Foundations are genuinely strong: en/ar catalogs are in perfect 654-key parity with no empty or machine-placeholder Arabic values (the 12 identical entries are intentional terminology-variable pass-throughs); zero physical direction classes exist anywhere (grep for ml-/mr-/pl-/pr-/text-left/right/left-/right- returns nothing — logical ms/me/ps/pe/text-start/end used throughout); Latin n
## LENS  — 5 findings
- [MATERIAL] 0058 lifecycle_scan / subscription_recon_scan are SECURITY DEFINER, granted to app_user, with NO platform-task guard and no org filter — cross-org billing leak (prior finding, still unfixed after 0060) — supabase/migrations/0058_s9_platform_scans.sql:7
  FIX: Convert both to language plpgsql and add `perform app.assert_platform_task();` as the first statement (matching 0036/0039), or embed an `app.assert_platform_task() is null`-style guard; keep the grant to app_user only after the guard is in place.
- [MINOR] approval.rule_id is a plain FK to approval_rule(id) without the (id, org_id) composite pin the rest of S2–S9 uses — supabase/migrations/0034_s4_approvals.sql:71
  FIX: Replace with a composite FK: `foreign key (rule_id, org_id) references public.approval_rule (id, org_id)` (rule_id is nullable, so MATCH SIMPLE skips the check when null).
- [MINOR] usage_event tenant INSERT permits arbitrary (incl. negative) delta — self-org meter deflation / metered-limit bypass at the DB grant layer — supabase/migrations/0054_s9_usage_audit.sql:28
  FIX: Either add `check (delta >= 0)` and route corrections through a platform DEFINER writer, or drop the tenant INSERT grant/policy and make usage_event platform-written only (mirroring domain_event / subscription_event).
- [MINOR] Several SECURITY DEFINER helpers use `search_path = public, pg_temp` instead of the house-standard `search_path = ''` — supabase/migrations/0047_s7_customer_updates.sql:117
  FIX: Standardise on `set search_path = ''` with fully-qualified references (these bodies already qualify public.* and use only pg_catalog built-ins), or at minimum drop pg_temp / place pg_catalog explicitly first.
- [MINOR] start_impersonation binds the acting staff to caller-supplied p_staff, not an authenticated principal; DEFINER granted to app_user (latent — no start route wired) — supabase/migrations/0056_s9_impersonation.sql:65
  FIX: When a route is added, derive the staff user id from the authenticated platform session server-side and pass that (never a client-supplied p_staff); consider asserting the caller principal inside the DEFINER against a platform-session GUC.
SUMMARY: Audited all 61 migrations (0000-0060), the tenancy harness (db.ts/withCtx.ts/ctx.ts/resolve.ts), the audit command chokepoint, and every caller of the platform DEFINER functions. Overall tenancy posture is strong: every tenant table has org-scoped RLS with WITH CHECK, app_user holds no DELETE grant on any table (soft-delete/void discipline), append-only streams (audit_log, activity, config_revision, domain_event, ai_interaction, usage_event) have explicit revoke of update/delete, the cost/HR wal
## LENS  — 5 findings
- [MINOR] Approval money visibility rides po.view for ALL subject types, including price-walled quote_send and payment amounts — src/modules/approvals/service.ts:760
  FIX: Gate amountMinor per subject type: po.view for material_request/purchase_order, ctx.pricePrivileged for quote_send, can(archetype,'payments.view') for payment; add the rule-scope filter to getApproval; optionally reject quote_send/payment rules assigned below the O/A wall at crea
- [MINOR] listImportRows returns staged item unit costs and selling prices un-redacted to any imports.manage holder (includes non-privileged manager) — src/modules/imports/service.ts:246
  FIX: Redact unitCostMinor/sellingPriceMinor from mapped in listImportRows when !ctx.costPrivileged / !ctx.pricePrivileged (mirror the listItems serializer), or restrict item-batch row reads to privileged sessions.
- [MINOR] getOwnerDigest serves the owner-audience payload items (owner-audience exception ids, jobIds, all-org job references) to every digest.view archetype with no F-6 job-scope narrowing — src/modules/digest/service.ts:297
  FIX: Strip items[] (or audience-narrow them) in getOwnerDigest for non-owner/admin archetypes, keeping counts + redacted money as the universal digest surface.
- [NIT] AR money value used as the Today card `count` (ar_summary, collections) — src/modules/today/service.ts:295
  FIX: Use the number of outstanding invoices as count and keep money in items[] (already redacted), rendering a lock/redacted marker when null.
- [NIT] listOpenExceptions/dismissException enforce audience only — the job-scope narrowing the authz matrix documents for manager/foreman is absent — src/modules/exceptions/service.ts:876
  FIX: Add the assignedJobCondition narrowing for manager/foreman archetypes in listOpenExceptions and the dismiss guard, or amend the matrix comment to match the shipped audience-only behavior.
SUMMARY: Redaction-wall audit of C:/Users/abdul/Desktop/idaraworks (read-only; real code, no docs trusted). All primary walls verified INTACT in code: labour/salary behind RLS on app.cost_priv GUC (employee_terms 0020, report_labour_cost 0029, cost_rollup_labour 0040) with DEFINER-only crossings (freeze_report_labour_costs, refresh_cost_rollup, margin_drift_candidates returning percentages only); getJobCosting redacts labour/total behind ctx.costPrivileged and quoted/margin behind pricePrivileged; quotes

## VERIFY VERDICTS
- CONFIRMED ::  :: Confirmed by reading the real code. supabase/migrations/0042_s6_invoices.sql:65-67 creates the FK (corrects_invoice_id, org_id) but no index on corrects_invoice_id exists anywhere 
- CONFIRMED ::  :: CONFIRMED, not refuted. Every factual assertion checks out in code: (1) purge_pending→purged routes solely through applyTransition (src/workers/functions/subscription-worker.ts:52-
- CONFIRMED ::  :: CONFIRMED. Both selectors gate on process.env.APP_ENV === "production" (einvoice/adapter.ts:94, ai/adapter.ts:104), but the codebase's canonical prod value is "prod": .env.example:
- CONFIRMED ::  :: Confirmed by direct code reading. supabase/migrations/0042_s6_invoices.sql creates only (org_id,status,issued_at), (org_id,customer_id), (org_id,job_id), and partial (org_id,due_da
- CONFIRMED ::  :: CONFIRMED by code reading. (1) purge_pending→purged is solely a state flip: sweepLifecycle (src/workers/functions/subscription-worker.ts:57) → applyTransition (src/modules/subscrip
- CONFIRMED ::  :: CONFIRMED, not refuted. The guards at src/platform/einvoice/adapter.ts:94 and src/platform/ai/adapter.ts:104 test APP_ENV === "production", but the repo's env contract is dev|previ
- CONFIRMED ::  :: CONFIRMED, not refuted. Reading the real code corroborated every link. src/platform/billing/adapter.ts:209 gates on APP_ENV === "production", but the canonical prod value is "prod"
- CONFIRMED ::  :: Confirmed in code: ReportComposer.tsx:415 puts aria-label={dict.add} on the ✕ button that calls removeMaterial(idx) (line 413); page.tsx:118 maps dict.add to t("common.add"), which
- CONFIRMED ::  :: Confirmed in code. ReportComposer.tsx:415 puts aria-label={dict.add} on the ✕ button whose onClick is removeMaterial(idx) (row deletion via filter at lines 180-182, no confirm/undo
- CONFIRMED ::  :: CONFIRMED. adapter.ts:209 literally gates on `process.env.APP_ENV === "production"`, but the canonical prod value is "prod" — proven by .env.example:8 (`dev | preview | prod`), the
- CONFIRMED ::  :: CONFIRMED. setActiveLocaleAction (src/app/(auth)/actions.ts:33-35) has zero call sites repo-wide (grep: definition only), and no language-switcher UI exists (platform/ui has no loc
- CONFIRMED ::  :: Confirmed by direct code reading. setActiveLocaleAction (src/app/(auth)/actions.ts:33-35) has zero call sites repo-wide (grep: definition is the only hit; no switcher UI in account
- CONFIRMED ::  :: CONFIRMED on every load-bearing element. (1) applyOnboarding (src/modules/onboarding/service.ts:194-197) gates re-apply only via a plain read of session.status — no claiming UPDATE
- CONFIRMED ::  :: CONFIRMED. 0058_s9_platform_scans.sql:7-21 and :24-38 define app.lifecycle_scan() and app.subscription_recon_scan() as `language sql` SECURITY DEFINER functions selecting from publ
- REFUTED ::  :: Refuted as MATERIAL; the code facts are accurate but the failure scenario cannot be concretely reproduced by any actor. Verified true: 0058:7-19/24-36 define both scans as language
- CONFIRMED ::  :: CONFIRMED with a corrected reproduction path. Every mechanism claim verified in code: (1) applyOnboarding's only re-apply guard is a plain read (src/modules/onboarding/service.ts:1