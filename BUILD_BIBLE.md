# IdaraWorks Build Bible — The Engineering Constitution

**Status:** In force from the architecture freeze (phase2/13) · Maintained alongside the architecture · Binding on every engineer, AI coding agent, reviewer, and architect, present and future.
**Relationship to other documents:** the phase2 package defines *what* we build; this document defines *how we build anything*. Where they conflict, flag it — one of them has a defect. Changes to this document follow the same change-control rule as the freeze (security / scale / pilot evidence), except additive clarifications.
**How to read it:** rules are written as testable statements. "MUST" is enforced by CI or review checklist; "PREFER" is the default that requires a written reason to deviate.

---

## 1. Engineering Philosophy

**Why IdaraWorks exists.** Small industrial companies run real operations — boats, fabrication, sites — through WhatsApp, spreadsheets, paper, and walking the floor. IdaraWorks is the daily operational control system that replaces that chaos: what is happening today, what is late, who is responsible, what materials are needed, what awaits approval, what it costs, whether the operation is on track.

**Operations-first, always.** We are not building an ERP (departments and transactions), not a project-management tool (tasks and boards), not a no-code platform (canvases and builders). We model **work being performed** and attach everything — people, materials, approvals, money, evidence — to it.

**What the product is:** the system through which a business plans, assigns, supplies, executes, reports, inspects, approves, measures, bills, and improves its work.
**What the product is not:** a general ledger, a payroll engine, an app builder, a dashboard product, a chat tool, or a place where AI acts without evidence and approval.

**Long-term vision:** the operational intelligence layer for industrial SMBs — earned one truthful Today screen at a time, one vertical at a time. The vision never justifies building ahead of a paying vertical.

**The expected mindset:** you are building a *factory tool that handles money*. The foreman's 6 pm report on a phone with one bar of signal, and the owner's 7 am margin number, are the two moments that matter. Boring, correct, and fast beats clever. If you feel clever, stop and re-read §19.

## 2. Non-Negotiable Principles

**P1 — The Job is the centre of the system.**
*Description:* every operational and financial record attaches to a `job` (or is explicitly org-level overhead). *Rationale:* the product's value is connection; an orphaned record answers no owner question. *Example:* an expense form defaults to job attribution; "overhead" is a deliberate choice, not an omission. *Anti-patterns:* entities that reference each other but not the job; features organised by department ("the HR module"); a second "centre" (e.g., making invoices the root of anything).

**P2 — Daily reports are the operational heartbeat.**
*Description:* the report is the atomic input; costing, progress, attendance, and intelligence derive from it. *Rationale:* if reporting stops, the product goes blind — so nothing may make reporting slower or more fragile. *Example:* any change touching the report flow must keep the CI tap-count budget and the offline suite green. *Anti-patterns:* adding a required field to the report for another feature's convenience; making report submission depend on network, inventory state, or any third system.

**P3 — No feature may bypass tenant isolation. Ever.**
*Description:* every read/write is org-scoped at the app layer AND the database layer (phase2/10 items 1–14). *Rationale:* one cross-tenant leak is a company-ending event. *Example:* a new table ships with its RLS policy, its bleed-test seed, and its repository accessor in the same PR. *Anti-patterns:* service-role client "just for this query"; caching by record id without org prefix; a quick admin script that iterates all orgs in one connection context.

**P4 — One source of truth for every business concept; derived values are computed, never typed.**
*Description:* progress, availability, cost, margin, "missing items" are derivations with exactly one computing owner; the only escape hatches are frozen snapshots and audited overrides (phase2/01 D-1.4). *Rationale:* hand-entered status is how operations systems drift into fiction. *Example:* the costing engine is the sole writer of MoneyRollup. *Anti-patterns:* a second code path that "also updates the total"; UI that lets anyone edit a derived number; storing what can be computed.

**P5 — No duplicated business logic.**
*Description:* a rule lives in one function/module and is imported, never re-implemented. *Rationale:* the second copy is where the bug lives. *Example:* `assigned_job()` is one resolver (phase2/06 F-6) used by API, RLS mirrors, and UI gating. *Anti-patterns:* re-deriving VAT in a PDF template; copy-pasting threshold logic into a Today card.

**P6 — Simplicity over cleverness; readability over micro-optimisation.**
*Description:* code is written for the next reader, who may be an AI agent with no context. *Rationale:* this codebase must survive a decade of contributors. *Example:* a boring explicit switch over the closed approvable registry beats a reflective dispatcher. *Anti-patterns:* metaprogramming over registries; premature generic engines (the R16 trap); "temporary" abbreviations in names.

**P7 — Money paths are sacred.**
*Description:* anything touching amounts, VAT, invoices, payments, or costing gets golden-file tests, stricter review, and audit coverage before merge. *Rationale:* one wrong margin number destroys the trust the whole product sells. *Example:* changing a costing rule requires updating golden fixtures *and* the parity test. *Anti-patterns:* "drive-by" refactors inside money modules; floats anywhere near money.

**P8 — The customer never sees the abstraction.**
*Description:* users see their words ("Boat", "LPO", "القارب") via the terminology layer; canonical names live only in code and schema. *Rationale:* operations-first means speaking the trade's language. *Anti-patterns:* hardcoded domain nouns in UI strings (CI-linted); leaking enum values into labels.

**P9 — Every decision must preserve maintainability.**
*Description:* if a change makes the system harder to understand, test, or evolve, it needs a written justification in the PR. *Rationale:* velocity today is borrowed from whoever maintains this in year five. *Anti-patterns:* skipping the spec-divergence rule; merging with a red flaky test "because it's flaky".

**P10 — Truth over polish.**
*Description:* stale or missing data is displayed as such (freshness stamps, "no report since Tuesday"); the system never presents old data as current or invented data as real. *Rationale:* the product's entire claim is that the owner can trust the screen. *Anti-patterns:* hiding staleness; AI narration asserting anything outside its closed payload.

## 3. Architecture Rules

1. **Modular monolith.** One deployable, one database. Modules = capabilities (jobs, reports, approvals, costing, …) under `src/modules/<name>/`. No microservices without a freeze amendment.
2. **Layers inside each module:** `service.ts` (business logic; the only public surface) → `repository.ts` (the only code touching this module's tables) → `dto.ts`/`schema.ts` (Zod) → optional `events.ts`, `jobs.ts` (task-queue handlers), `components/` (module-owned UI). Route handlers are thin: parse → ctx → service → serialize.
3. **Dependency direction:** UI → API → service → repository → DB. Modules call other modules **only** through their service interfaces or domain events — never their repositories or tables. Enforced by `eslint-plugin-boundaries`; a violation is a build failure, not a warning.
4. **L2 is the centre:** execution modules (jobs, reports, issues, approvals) must not import from L4 (commercial) modules. Money looks at work; work never looks at money. The container contract (phase2/02) is the only cross-cutting interface engines consume.
5. **Folder structure (top level):** `src/modules/*`, `src/platform/*` (tenancy ctx, auth, entitlements, audit, files, notifications, terminology, i18n — the L1 substrate), `src/lib/*` (pure utilities only — no business logic, no IO), `src/app/*` (Next.js routes, thin), `src/workers/*` (task-queue entry points). Config schemas in `src/platform/config/schemas/`.
6. **Naming:** tables/columns `snake_case`; TypeScript `camelCase`; components `PascalCase`; canonical domain names from phase2/01 exactly (`job`, `job_stage`, `daily_report`, `job_crew`, `payment_receipt`…); background execution is `worker`/`task-queue`, never "job". Closed registries (`ContainerKind`, approvable types, attachable types, file access classes, term keys) are code-owned enums in `src/platform/registries.ts` — one file, one owner.
7. **Domain ownership:** every module has an owning conceptual area listed in its README stub; a business concept belongs to exactly one module (costing owns rollups; reports own lines; approvals own decisions).
8. **Shared libraries:** promotion into `src/lib` or `src/platform` requires two existing consumers, not one anticipated one.
9. **Circular dependencies are build failures.** If two modules need each other, one of them should be emitting a domain event instead.

## 4. Database Standards

1. **Tables:** `snake_case`, plural avoided (match phase2/01 names); every tenant table has `org_id uuid not null` + RLS policy in the same migration.
2. **Primary keys:** UUIDv7 (`id`). Human references (`reference`, `serial_no`) are separate, per-org, pattern-generated (phase2/07).
3. **Foreign keys:** always declared, `on delete restrict` by default (we archive/void, we don't cascade-delete history). Snapshot columns (`*_name`) accompany FKs where history must outlive masters (D-1.6).
4. **Indexes:** every FK indexed; composite indexes lead with `org_id`; partial indexes for hot filtered queries (pending approvals, open exceptions); every slice's PR includes its index plan + reviewed EXPLAIN (phase2/11 DoD).
5. **Audit & activity:** written by the platform command path decorator, never by feature code directly; append-only (no UPDATE/DELETE grants).
6. **Soft delete / void:** operational and financial records are never hard-deleted — `voided_at + void_reason` or `archived_at`; drafts may use the 30-day recycle bin. Voided rows are excluded from every aggregate by the owning engine, visibly struck through in UI.
7. **Immutable records:** reviewed reports, decided approvals, issued invoices, audit rows, config revisions. Corrections are new records (credit notes, returned-state resubmission, superseding approvals).
8. **Derived data:** not stored except as cached rollups with a single writer, event invalidation, and a nightly recompute-reconcile alarm.
9. **Money:** `bigint` minor units; explicit `vat_amount` recorded per document; currency on the org (MVP). No floats, no numeric-with-rounding-hope.
10. **Time:** `timestamptz` UTC in the database; org timezone at display; `date` (not timestamp) for business dates like `report_date`; all working-day math goes through the calendar service (working week + holidays + Ramadan profile) — never raw date arithmetic.
11. **Versioning:** config artifacts carry `schema_version`; migrations are forward-only, numbered, and never edited after merge.
12. **Transactions:** one command = one transaction; the approval engine's dual-transition, report submission with lines, and config apply are the canonical examples. Cross-module effects go through the event bus *after* commit.
13. **Locking:** prefer optimistic (updated_at checks) for user edits; `select … for update` only inside short service-layer transactions (serial allocation, stock in P3, quota counters).
14. **Migrations:** every migration ships with: RLS policy (new tables), rollback note (what to do, even if it's "restore from backup — destructive"), and passes the migration test harness (phase2/10 #2). No data migration and schema migration in the same file. Never run against prod outside the release process (§14).

## 5. Multi-Tenancy Rules

The full law is phase2/10 items 1–14. Operational summary every contributor must internalise:

1. **`org_id` propagation:** resolved once per request from the membership (never from client input), carried in an immutable `Ctx` object that every service and repository function takes as its first argument. Background workers receive `org_id` in the payload and **re-resolve + re-verify** before touching data.
2. **RLS:** the second wall, not the first. Request transactions run `set_config('app.org_id', ctx.orgId, true)`; policies read the GUC via init-plan-wrapped subselects. The service-role key is banned outside migrations/platform tasks (linted).
3. **Repository layer:** the only code that touches tables; no raw client imports elsewhere (linted); unbounded-growth tables readable only through paging helpers; aggregates via SQL/RPC.
4. **API layer:** schemas never accept `org_id`; by-id fetches verify ownership before acting (404 on foreign-org ids, never 403 — don't confirm existence).
5. **Storage:** paths `org_id/…`; access via class-checked signed URLs only.
6. **Search:** tenant-filtered in the repository; any future index carries org at index time.
7. **AI:** Layer-A context = intake + templates; Layer-B = closed payloads; no cross-tenant retrieval, ever.
8. **Cache:** keys prefixed `org:user:` (user because of cost redaction); busted on role/config changes.
9. **Logging:** every log line carries `org_id`, `user_id`, `request_id` — and **never** carries tenant business data values (names, amounts) at info level.

**The classic leaks and their standing preventions:** forgotten org filter → layers 2+3 + the two-org bleed test · client-supplied org/entity id → rule 4 · sequential ids → UUIDv7 · guessable storage paths → rule 5 · cross-tenant cache → rule 8 · scheduled fan-out accumulating state across orgs → per-org iteration + bleed test · AI context stuffing → rule 7 · support access → consent-gated impersonation only.

## 6. Security Standards

1. **Authentication:** email+password (breach-screened) and phone-OTP for field seats; TOTP MFA available to all, org-enforceable; sessions short-lived JWT + rotating refresh, server-side revocation, device list.
2. **Authorization:** `can(ctx, action, resource?)` is the only check; deny-by-default; conditions from the closed vocabulary only; UI gating mirrors but never substitutes; cost visibility redacted at **every serialization boundary** (phase2/06).
3. **Secrets:** platform secret store only; never in repo (scanned), never in logs, never in client bundles; quarterly rotation drill.
4. **Encryption:** TLS everywhere; at-rest via provider; field-level app encryption for integration credentials and (P5) payroll bank details.
5. **Rate limiting:** per-user and per-org at the edge; strict tiers on auth, AI, share-page, and upload endpoints; trial abuse controls per phase2/09.
6. **File uploads:** MIME allowlist, size caps, image re-encode, EXIF/GPS strip, document malware scan, never served from the app origin.
7. **Signed URLs:** short-lived, class-checked (job_media / financial_doc / hr_doc / customer_share), minted only by the storage helper after `can()`.
8. **Headers:** CSP (no unsafe-inline where avoidable), HSTS, frame-ancestors none (except the share page's own policy), nosniff, referrer-policy strict.
9. **Validation:** Zod at every boundary (API, config write path, worker payloads, webhooks). Parse, don't validate-and-hope.
10. **Input sanitisation:** the shared config-string sanitiser for all tenant-authored labels (no markup, ICU metachars, leading `=+-@`); CSV export defensive quoting; tenant strings delimited in LLM prompts.
11. **Output encoding:** rely on React escaping in UI; PDF templates escape explicitly; never `dangerouslySetInnerHTML` with tenant data (linted).
12. **Audit logs:** the §4.5 command path; coverage list in phase2/10 #33; support access dual-logged.
13. **OWASP:** the top-10 mapped in the review checklist (§18); IDOR is *our* #1 — every reviewer checks by-id ownership on every new endpoint.
14. **Security review:** required label on PRs touching authz, money, files, AI payloads, or the share surface; pen-test findings tracked to closure with dates.

## 7. File Storage Standards

The normative spec is phase2/01 Appendix A. Implementation rules:

1. **Buckets:** `tenant-media` (job media + derivatives), `tenant-docs` (financial/HR — private, originals kept), `platform` (templates, static). Hierarchy: `org_id/<class>/<entity_type>/<entity_id>/<file_id>[.variant].ext`.
2. **Upload flow:** client compress (≤2048px, ~q75, ≤500KB target) → signed-upload URL (quota-checked) → server re-encode + EXIF strip → derivative worker (thumb ~200px, medium ~1280px) → file row committed with byte size → quota counter updated transactionally.
3. **Serving:** thumbnails everywhere lists/strips appear; medium for detail views; originals only where the class demands; cache-control on derivatives.
4. **Lifecycle:** files follow parent void/archive; legal hold suspends storage deletion; closure purge enumerates + verifies; recycle-bin restore restores objects.
5. **Backup:** nightly incremental bucket replication + manifest to a second provider; restore is part of the quarterly drill.
6. **Quotas & monitoring:** per-org byte counter (nightly reconciled), warn 80% / block-adds 100% / never block reads; per-org monthly egress on the ops dashboard; alert on reconcile drift.
7. **Cost:** photo volume is the dominant cost — any feature adding image surfaces states its egress plan in the PR.

## 8. Backend Coding Standards

1. **Services:** pure business logic; take `Ctx` first; return typed results or throw typed domain errors (`DomainError` hierarchy: `NotFound`, `Forbidden`, `Conflict`, `ValidationFailed`, `LimitExceeded`) — mapped to HTTP in one place.
2. **Repositories:** no business logic; parameterised queries only; paging helpers for lists; SQL/RPC for aggregates.
3. **DTOs:** Zod schemas are the single type source (infer, don't duplicate); serializers are explicit per audience (privileged vs redacted shapes are different named types — redaction is a type, not an `if`).
4. **Error handling:** no swallowed errors; no `catch` that only logs at the call site *and* rethrows elsewhere; user-facing messages are translated and safe (no internals); every 5xx carries `request_id`.
5. **Logging:** structured JSON; levels mean something (error = page someone eventually, warn = investigate weekly, info = narrative, debug = off in prod); no tenant PII/values at info+.
6. **Events:** domain events are past-tense facts (`invoice.paid`), emitted after commit, with org_id + entity refs, versioned payloads; consumers are idempotent.
7. **Background jobs (task-queue):** every handler idempotent (keyed), org-scoped, bounded runtime, explicit retry policy (max attempts + backoff + dead-letter with alert); no handler both computes and sends without an idempotency guard on the send.
8. **Transactions:** open late, close early; no network calls (LLM, email, storage) inside a DB transaction.
9. **Caching:** only with an invalidation story written in the same PR; keys per §5.8; TTL is a backstop, not the strategy.
10. **Retry logic:** external calls (LLM, e-invoice, SMS, Stripe) wrapped with timeout + retry + circuit-breaker defaults from `src/platform/http`; never hand-rolled per call site.
11. **Idempotency:** every mutation endpoint that clients may retry (outbox replay, webhooks, payments) accepts an idempotency key and proves it in tests.
12. **Performance:** no N+1 (reviewer checks list endpoints); Supabase 1,000-row discipline (paging lint); measure before optimising, but never merge a known O(rows) response path on a growth table.
13. **Concurrency:** assume two foremen submit at once and the owner approves from two devices; unique constraints + idempotency + first-wins semantics are the pattern; "it's unlikely" is not a design.

## 9. Frontend Standards

1. **Components:** module-owned feature components; shared primitives only in the design system (`src/platform/ui`); server components by default, client components only for interactivity.
2. **Design system:** RTL-first (logical properties only — `margin-inline-start`, never `-left`); direction-aware icons; 44px minimum tap targets on field flows; tokens over ad-hoc values; both themes tested.
3. **State:** server state via query hooks per module API (one client per module); minimal client state; no global state library without a freeze-level justification; forms local.
4. **API layer:** typed client generated/inferred from the Zod route schemas; no `fetch` in components.
5. **Forms:** schema-driven (same Zod), optimistic only where the outbox pattern guarantees reconciliation; every form recoverable (drafts persist across navigation on field flows).
6. **Validation:** client mirrors server schemas for UX; the server remains the truth.
7. **Tables/lists:** server-paged always; mobile gets cards, not squeezed tables; every list has a designed empty state (CTA, not blank).
8. **Mobile:** the five field flows are designed at 375px first and reviewed on a real mid-range Android; desktop adapts from there for field surfaces, and vice versa for office surfaces.
9. **Offline:** outbox pattern only for the frozen scope (reports + photos); UI shows queued/synced states explicitly; never fake success.
10. **Accessibility:** semantic HTML, labelled inputs, visible focus, contrast AA; keyboard operability on office surfaces.
11. **RTL & i18n:** every string through `t()` with terminology variables (linted); no concatenated sentence fragments; pseudo-locale + long-Arabic snapshot tests; `latn` numerals default; dates/amounts through the shared formatters only.

## 10. AI Engineering Standards

1. **Prompts** live in versioned files (`src/platform/ai/prompts/`), reviewed like code, never inline strings; each has an owner, a purpose comment, and eval fixtures.
2. **Context:** closed payloads only (phase2/04 D-4.3) — the model receives structured documents we assembled; it never queries, browses, or retrieves across tenants. Tenant strings are delimited/quoted in prompts.
3. **Permissions:** AI output enters the system only through the same validated write paths as humans (Layer-A proposals through the config pipeline; drafts as drafts). AI has no standing write authority anywhere.
4. **Evidence:** every AI-surfaced claim links to the records that justify it; the numbers-subset validator gates narration; an insight without evidence_refs doesn't ship.
5. **Limitations honesty:** deterministic analytics are labelled as such; "AI" in UI copy only where a model actually contributed.
6. **Explainability:** "why am I seeing this?" is one tap on every AI/exception surface.
7. **Cost controls:** per-org credit metering (narration/drafts/conversation only), trial caps, per-IP throttles, platform daily spend circuit breaker; every call records org, feature, tokens, cost.
8. **Token discipline:** payload builders trim to what the prompt needs; no raw table dumps; long content summarised deterministically before the model sees it.
9. **Failure handling:** every AI feature has a deterministic fallback (templated digest, manual config path); AI outage degrades polish, never function.
10. **Logging:** prompts, payload refs, outputs, validator verdicts per interaction, org-scoped, retention per Appendix B.
11. **Human approval:** anything customer-visible or config-changing requires an explicit human action; the human's edit is the record of intent.

## 11. Performance Budgets

Measured in CI at synthetic volume (200 jobs / 50k reports / 200k lines / 2 orgs) and in prod telemetry; regressions block merge.

| Surface | Budget |
|---|---|
| Today screen (any role) | p95 < 1.5 s server compose; < 2.5 s interactive on throttled 3G |
| Daily report submit (online) | round-trip < 10 s incl. one photo on throttled 3G |
| Approvals inbox / decide | p95 < 800 ms / < 1.2 s |
| General API reads / writes | p95 < 500 ms / < 1 s |
| Job costing page | p95 < 1.5 s (cached rollup path) |
| Photo upload → thumbnail visible | < 30 s (queue) |
| Search/list pages | p95 < 1 s server-paged |
| Nightly evaluation + digest | < 5 min/org; whole fleet inside the night window, staggered |
| PDF render | < 20 s queued, user notified |
| Page load (office surfaces) | LCP < 2.5 s broadband |

## 12. Scalability Strategy

What changes at each order of magnitude — and what deliberately doesn't (the frozen core: pooled tenancy, modular monolith, one schema, derived-not-stored):

- **10 companies (pilots):** everything as built. Watch: exception precision, Today latency, storage growth.
- **100 companies:** tune indexes from real query stats; enable pgBouncer/Supavisor discipline review; start monthly partitions on activity/event tables; CDN posture on derivatives.
- **1,000 companies:** read replica for Reports/analytics surfaces; dedicated queue concurrency pools per work class (digest vs PDF vs derivatives); nightly herd re-staggered by measured runtime; possible dedicated DB compute tier.
- **10,000 companies:** search extraction (Typesense-class, tenant-filtered at index); analytics offload (replica or column store) for the Reports area; storage lifecycle tiering; entitlement resolution moves fully to cached-with-push invalidation; platform ops team exists — observability (§15) is their contract.
- **100,000 companies:** what breaks first is the *shared-everything database's* write hotspots and the nightly windows — shard by org (the pooled model with org_id everywhere and no cross-org joins is shard-ready by construction); event bus graduates to a real broker; per-region deployments for data-residency tiers (the KSA trigger may arrive much earlier as an enterprise tier — the Option-B extraction path from v1 §10 is the mechanism).
- **1,000,000 companies:** requires redesign of: the single-schema migration model (progressive rollout rings), the monolith's deploy unit (extract the highest-churn modules along the boundary lines we've enforced since day one — this is why §3 exists), and the config/template distribution (versioned artifact store). The domain model, the operational loop, and the tenancy invariants are designed to survive unchanged.

The honest note: nothing before 1,000 companies justifies *any* pre-building from the later tiers. This section exists so scaling is a plan, not a panic.

## 13. Testing Standards

1. **Unit tests:** every service function with logic; every E-rule (raise + clear + threshold edges + calendar fixtures); every derivation (progress, costing, availability).
2. **Golden files:** money paths — costing (incl. Najolatech parity), VAT cases, AR math, serials. Changing a golden file requires a money-path review label.
3. **RLS/tenancy:** the two-org bleed harness covers every entity, list, export, digest; the wrong-ctx DB-block test; migration harness on every schema change.
4. **Permission tests:** the matrix runner (doc 06 as data) + condition tests + redaction shape snapshots per boundary.
5. **Integration:** approval dual-transitions, report submission with lines + outbox replay, config apply/undo, webhook state machines — real database, transactional fixtures.
6. **E2E (Playwright):** the smoke pack — full loop + five field flows + approvals inbox — per merge; 375px + RTL profiles; throttled-3G profile for the field flows.
7. **Load/perf:** §11 budgets asserted at synthetic volume in CI (S5+); k6-class load on Today and report submit before launch.
8. **Regression:** every production bug gets a test that fails before the fix; no exceptions.
9. **Security tests:** IDOR sweep harness, CSV-injection cases, sanitiser suite, share-token expiry/revocation, replay re-auth.
10. **Gates:** coverage is judged per area, not by a vanity number — money, tenancy, authz, and the exception engine require exhaustive branch coverage; UI components require the snapshot suites; the merge gate is *all* suites green + no skipped tests without a linked issue and date.

## 14. CI/CD Standards

1. **Branching:** trunk-based; short-lived feature branches; `main` always deployable.
2. **PRs:** small (< ~600 lines diff preferred, split otherwise); description states *what*, *why*, spec references (doc §), and doc-10 items touched; the §18 checklist completed; AI-authored PRs held to the identical standard and labelled `ai-authored`.
3. **Review:** one approval minimum; two + security label on money/authz/files/AI-payload/share-surface diffs; the reviewer runs the anti-pattern scan (§19).
4. **Pipeline:** lint (boundaries, tenancy, i18n, raw-client) → typecheck → unit → integration (DB) → bleed/matrix/golden suites → build → E2E smoke → deploy preview. Red = no merge; flaky = quarantined *with issue + date*, never ignored.
5. **Releases:** continuous to staging; production releases tagged, with migration review; **migrations deploy before code that needs them** (expand → migrate → contract pattern for breaking changes).
6. **Feature flags:** per-org capability flags via the entitlement service (no second flag system); kill switches for AI narration, share pages, and e-invoice submission.
7. **Rollback:** app rollback = redeploy previous tag (always safe because migrations are expand-first); data rollback = restore procedure per the drill runbook; every release notes its rollback path.
8. **Database deployments:** no manual prod SQL — everything is a migration through the pipeline; break-glass access per phase2/10 #45.

## 15. Observability

1. **Logging:** structured, org/user/request-tagged, per §8.5; retention 30–90 d hot.
2. **Metrics:** the four golden signals per surface + product metrics (reports/day/org, Today opens, approval latency, exception precision feedback, AI spend/org, storage/egress per org).
3. **Tracing:** request-id propagation through services, queue jobs, and LLM calls; sampled traces on Today and report submit.
4. **Alerts:** page-worthy = tenancy test failures in prod canaries, rollup drift alarm, backup/replication failures, queue dead-letters, error-rate/latency budget burns, AI spend circuit breaker. Everything else is a ticket, not a page.
5. **Health checks:** app, DB, queue, storage, e-invoice adapter, SMS provider — on the ops dashboard with per-dependency status.
6. **Ops dashboards:** platform (above) + per-org operational health (report streaks, digest delivery) — the same data that powers pilot success metrics.
7. **Incident response:** the phase2/10 #50 runbook; severity ladder; tenant-scoped impact assessment first; blameless post-mortem with a regression test as the closing artifact.

## 16. Technical Debt Policy

- **Acceptable debt:** UI polish shortfalls, missing conveniences, deferred P3+ scope, TODOs with issue links and dates, performance above budget but below ideal.
- **Unacceptable debt (never merges):** anything violating §2 principles, tenancy/authz gaps, untested money paths, silent spec divergence, skipped-without-issue tests, hardcoded tenant nouns, duplicated business rules.
- **Refactoring:** opportunistic within the module you're touching (boy-scout rule); cross-module refactors are planned work with their own PRs — never riders on feature PRs.
- **Deprecation:** old paths get `@deprecated` + issue + removal date; two-release grace; the registry files never accumulate dead entries.
- **Architecture evolution:** through the freeze's change-control rule only; this Bible's §12 defines the sanctioned growth path.

## 17. Definition of Done (every feature)

☐ Functional requirements met against the spec doc (cited by section) · ☐ all test classes relevant to the change green, including bleed/matrix/golden where touched · ☐ security review label if §6.14 applies · ☐ performance within §11 budgets at synthetic volume · ☐ docs updated (spec amendment or code fix — divergence never silent) · ☐ no tenant leaks (harness green, new entities seeded in the bleed test) · ☐ mobile verified at 375px on the target flows · ☐ RTL + Arabic verified (snapshots + eyeball) · ☐ audit/activity trail correct for every new mutation · ☐ indexes + EXPLAIN for new hot queries · ☐ empty states designed · ☐ telemetry events added for new surfaces.

## 18. Engineering Review Checklist (before every merge — humans and AI agents alike)

1. Does this change serve a step of the operational loop, and does the PR say which?
2. Tenancy: new tables have RLS + bleed seeds? No raw client? No client-supplied org? By-id ownership checks?
3. Authz: every new endpoint calls `can()`? Redaction at every new serialization point? Matrix runner extended?
4. Money: golden files updated? VAT recorded-not-assumed? bigint minor units? Void semantics respected?
5. Derived data: computed by its single owner? No hand-set derived values?
6. Registry discipline: no new stringly-typed types; closed enums extended only in `registries.ts` with review?
7. Idempotency/concurrency: retries safe? Unique constraints where two-users-at-once applies?
8. i18n/RTL: all strings through `t()`? Terminology variables? Logical CSS? Numerals via formatters?
9. Errors/logging: typed errors? No PII in logs? request_id flows?
10. Performance: paging on lists? Aggregates in SQL? Indexes + EXPLAIN? Budget assertions still green?
11. Files: through the storage helper? Correct access class? Thumbnails for list surfaces?
12. AI: closed payloads? Validator gates? Fallback exists? Costs metered?
13. Tests: failing-first regression test for bug fixes? No new skips without issue+date?
14. Docs: spec divergence resolved? Doc-10 items named? CHANGELOG/PR description honest?
15. Would you be comfortable if the foreman's report or the owner's margin depended on this code tonight? (It does.)

## 19. Anti-Patterns (never acceptable)

- **The ERP reflex:** organising anything by department; adding a record-keeping screen with no loop step; "while we're at it" admin CRUD.
- **The generic engine:** a workflow/rules/object designer "for flexibility"; polymorphic tables for hypothetical kinds; config that configures config. (R16 — the audit's most-watched risk.)
- **The second writer:** any code besides the owning engine updating a rollup, status, or derived value.
- **The service-role shortcut:** "just this once" bypassing RLS/ctx for a script, report, or fix.
- **The silent divergence:** code that does something the spec doesn't say, merged without a doc amendment.
- **The hardcoded noun:** "Job"/"Boat"/"مشروع" in a string literal.
- **Float money. Assumed VAT. Client-computed totals.**
- **The hidden staleness:** serving cached/derived data without freshness truth.
- **The clever abstraction:** indirection that saves 20 lines and costs the next reader an hour; premature DRY across modules (duplication of *structure* is fine; duplication of *business rules* is not — know the difference).
- **The unlogged mutation:** any state change outside the command path.
- **The untested fix:** a bug fix without its failing-first test.
- **The scope smuggle:** MVP-excluded features (freeze FS-2) arriving disguised as refactors.
- **The AI freelancer:** model output entering the system outside the validated write paths, or narration asserting facts outside its payload.
- **The retry bomb:** external calls without timeout/backoff/idempotency.
- **The English-first patch:** shipping a surface "with Arabic to follow."

## 20. Future Contributors Guide

**Read, in order (one sitting each):** ① `OPERATIONS_FIRST_FOUNDATION_REPORT.md` §0–§8 (why and what) → ② `phase2/00-INDEX.md` + `13-ARCHITECTURE-FREEZE.md` (what is decided and how decisions change) → ③ `phase2/01` (the data model), `02` (the one abstraction), `05`–`07` (the engines you'll touch most) → ④ `phase2/10` (the law) → ⑤ this Bible → ⑥ `phase2/12` (the audit — read it to learn how this team thinks about its own work).

**Then, before your first PR:** run the app; create a job from template #1; submit a daily report on your phone; approve an MR; open the owner Today screen and trace one number on it all the way down to its source rows. If you can't trace it, that's your first question — not your first assumption.

**Working rules for newcomers (human or AI):** your first PRs stay inside one module; you extend registries and schemas before you invent mechanisms; you ask "which loop step is this?" before "how do I build this?"; when the spec and the code disagree, you file the divergence — deciding which is right is the reviewer's job, hiding it is nobody's.

**The one-sentence test** for any change, kept from the product's origin: *does this help someone plan, execute, report, approve, measure, or improve today's work — without making the foreman's evening report one tap slower or the owner's morning number one degree less true?*
