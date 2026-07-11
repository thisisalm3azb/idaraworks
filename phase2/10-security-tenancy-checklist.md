# 10 — Security & Multi-Tenancy Checklist

**Regenerated per audit (doc 12) §6 item 6** — v1 items preserved, ~9 audit items integrated, renumbered 1–51. **Verification codes:** `CI` = automated test/lint blocking merge · `CI-mig` = automated check on every migration · `REV` = mandatory PR review-checklist item · `DRILL` = scheduled exercise with written evidence · `PEN` = external penetration-test scope item. Every item lands with the slice that creates its subject (doc 11); an item without its test is "not done." Frozen under doc 13 change control.

## Tenancy (the company-ending class)

1. **RLS enforcement mechanism (audit F-21):** request-scoped tenancy via `set_config('app.org_id', …)` inside one transaction per request; RLS policies read that GUC through **init-plan-wrapped `(SELECT …)` expressions** (uniform template — also the performance-correct pattern); **service-role credentials are banned outside migrations and platform-level tasks** — `CI` (lint on client construction) + `CI` (**the wrong-ctx test: a repository call with a deliberately wrong org ctx is blocked by the database itself**, not just the app layer).
2. RLS enabled with the standard template policy on **every** tenant table — `CI-mig`: migration test enumerates tables, fails on any tenant table without a policy.
3. No service-layer query path accepts an unscoped table handle; repository functions require tenant ctx as arg 1 — `CI` (raw-client import lint outside repository layer) + `REV`.
4. `org_id` never read from client input; derived from membership server-side — `CI` (API schema lint) + `PEN`.
5. Object-ownership check on every by-id fetch before any action — `CI` (foreign-org-id harness asserts 404) + `PEN` (IDOR sweep — the dominant SMB-SaaS failure mode).
6. UUIDv7 for all tenant-entity PKs; human serials per-org and non-enumerating across orgs — `CI-mig`.
7. Storage paths `org_id/…`; access only via signed URLs minted post-permission-check **per file access class** (`job_media` / `financial_doc` requires `finance.viewPrices` / `hr_doc` privileged / `customer_share` watermarked — doc 01 Appendix A, audit F-23) — `CI` (class-map test) + `PEN`.
8. Cache keys (incl. Today composer) prefixed org+user; explicit bust on role/config revision — `CI` (cache-helper key schema).
9. Task-queue payloads embed org_id; workers re-resolve tenant ctx and re-verify before acting — `CI` (worker harness).
10. Search/list queries tenant-filtered at the repository layer; any future search index carries org at index time — `REV` (standing rule).
11. Exports, digests, notifications, scheduled evaluations iterate per-org with no cross-org accumulation — `CI` (**the two-org bleed test**: every entity seeded in two orgs; every list/read/export/digest asserted org-pure — the package's single most important test).
12. **Paginate every unbounded list read** (Supabase 1,000-row silent cap); **aggregates execute database-side (SQL/RPC), never paged row-shipping** (audit F-30) — `CI` (repository lint + aggregate-path review).
13. AI layer: Layer-A context = intake + templates only; Layer-B payloads = closed structured documents; no cross-tenant retrieval; provider no-training terms; every AI interaction logged with org — `CI` (payload-builder tests) + `REV`.
14. **Customer share-link surface (audit F-22):** ≥128-bit single-use tokens, org-revocable, expiring, `noindex`, rate-limited; watermarked derivatives only; safe-by-construction payload — `CI` (token + content tests) + `PEN`.

## Authorization

15. Every doc 06 action string enforced in exactly one server-side check; deny-by-default — `CI` (matrix runner: archetype × action allow/deny table).
16. Condition tests: `assigned_job` (per the F-6 resolver), `own_record` (draft/returned edit windows), post-review immutability — `CI`.
17. **Cost redaction at every serialization boundary (audit F-23):** Today composer, costing reads, approval inbox summaries, push-notification bodies, digest payload collection, exports, file classes — `CI` (response-shape snapshots per role per boundary) + `PEN`. Labour-cost side-tables privileged at the RLS level too.
18. Hard-delete denied to all archetypes; void/archive paths require reason — `CI`.
19. Approval engine is sole writer of approval+subject transitions; invariant test; **self-approval guard `decided_by ≠ requested_by` with terminal-role exception stamped** (audit F-4) — `CI`.
20. **Offline/queued replay re-authorisation (audit F-24):** any outbox replay endpoint re-runs `can()` at execution time; approval-class replays (P3) bind a subject content hash — `CI` (revoked-role replay test).
21. Owner role irremovable by Admin; billing actions owner-only — `CI`.
22. Membership deactivation flow: open approvals reassigned by rule, crew roles flagged, history untouched (audit F-7) — `CI`.

## Input, output & injection

23. Input validation with Zod at every boundary — `CI`.
24. **Config-string sanitiser (audit F-25):** all tenant-authored labels/names/terms — no markup, no ICU metacharacters, no leading `= + - @` — applied at the single config write path — `CI` (sanitiser unit tests + schema-suite integration).
25. **CSV/Excel export injection guard:** export layer defensively prefixes `'` on formula-leading cells regardless of item 24 — `CI`.
26. Tenant strings entering LLM payloads are delimited/attribute-quoted (prompt-injection containment); narration numbers-subset validator enforced — `CI`.
27. Upload validation: type/size allowlist, image re-encode, document malware scan, no user content served from app origin — `CI` + `PEN`.

## Identity & sessions

28. Password policy + breach screening; **phone-OTP or admin-issued credentials for field seats (PB-7)**; OAuth (Google/Microsoft) deferred to S10 per audit §5 — `CI` + `PEN`.
29. TOTP MFA available; org-enforceable; admin MFA-reset audited — `CI` + `REV`.
30. Session revocation; device list + remote sign-out; refresh rotation — `PEN`.
31. Sign-in log — `CI`.
32. Rate limits: auth (strict), AI endpoints (credit + rate + **trial abuse controls per audit F-26**: onboarding call cap, IP/device signup throttle, disposable-email screening, platform daily AI spend circuit breaker), general per-user/org — `CI` + `PEN`.

## Audit, activity & retention

33. Audit log covers: auth events, role/permission changes, config revisions (incl. every AI-applied change), money-document mutations, voids with reasons, price adjustments, stage reopens, exports, deletions, support access, self-approvals — `CI` (command-path decorator test).
34. Audit rows append-only, not editable by org owners — `CI-mig` (no UPDATE/DELETE grants) + `REV`.
35. Activity stream on all L2/L4 entities via the single command path — `CI`.
36. **Retention policies implemented per doc 01 Appendix B** (event bus 30–90d, notifications 90d/12mo, exceptions 24mo→aggregates, activity partitioned+kept, **financial-mutation audit rows ≥ 6 years regardless of tier**, AI logs 90d/12mo, digests 90d) — `CI` (pruning jobs monitored) + `REV`.

## Data protection & lifecycle

37. Secrets in platform store only; repo secret-scanning; rotation runbook — `CI` + `DRILL` (quarterly).
38. **Photo pipeline (audit F-35):** client compression targets, server re-encode, **EXIF/GPS strip**, thumbnail + medium derivatives via task-queue; Today strips render thumbnails only — `CI` (pipeline tests incl. EXIF assertion).
39. **Storage quota metering (audit F-36):** transactional per-org byte counter, nightly bucket reconcile, enforcement at signed-upload-URL issuance (warn 80%, block adds, never reads) — `CI`.
40. Soft-delete recycle bin (30d) for drafts; account-closure hard-delete pipeline with export-first; **closure purge enumerates and verifies storage-object deletion** (audit F-38) — `REV` + `DRILL` (walkthrough before first paying customer).
41. **Legal hold suspends deletion pipelines including storage** — `CI`.
42. Full self-service export (all capabilities, CSV/Excel + files) at every tier — `CI` (completeness test enumerates the entity catalogue).
43. PDPL posture: hosting region recorded; **KSA lawful-transfer basis documented in the DPA before any KSA pilot holding visa/ID documents** (audit F-46); PII inventory — `REV` before pilot.

## Platform & staff access

44. Zero standing staff access; consent-gated, time-boxed impersonation with persistent banner, dual-logged — `CI` + `DRILL`.
45. Break-glass: two-party approval, post-hoc tenant notification — `REV` (runbook).

## Resilience

46. PITR on primary DB; nightly logical backups to second provider/region; **nightly incremental bucket replication + manifest for storage (audit F-34)** — `CI` (backup monitors).
47. **Quarterly restore drill covering database AND storage** to plain Postgres + plain S3 (doubles as vendor-exit rehearsal); first drill before pilot start — `DRILL`.
48. Recovery objectives published internally (RPO ≤ 1h, RTO ≤ 4h) and measured in drills — `DRILL`.
49. Money-rollup reconciliation alarm (D-2.2 drift check); **working-calendar/holiday correctness fixtures (UAE Mon–Fri, KSA Sun–Thu, 6-day, Eid, Ramadan — audit F-41)** — `CI` + prod monitor.
50. Incident-response runbook (detect → contain → per-tenant scope → notify within regulatory windows → post-mortem); tabletop tested — `DRILL` before launch.

## Assurance

51. Dependency + secret scanning in CI; review required on money-path and authz diffs; **external pen test before public launch** scoped to items 1–14, 15–22, 27, 30 (booked by S6 — lead time); this checklist is a living doc — every capability PR states which items it touches — `CI`/`REV`/`PEN`.
