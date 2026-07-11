# S0 Execution Checklist — Bedrock

**Governing documents:** phase2/11 (S0 scope), phase2/10 (checklist items owned by S0), phase2/13 (freeze + closed decisions OP-6/7/8/9), BUILD_BIBLE (all sections). This is an **implementation artifact**, not architecture. Status: awaiting owner approval; **no production code exists yet**.

**S0 objective (doc 11):** the platform substrate every later slice stands on — tenancy that provably cannot leak, identity, entitlements, audit, storage, language. **S0 exit = doc 11 S0 DoD/AC + validation checkpoints VC-1…VC-6 green.**

---

## 0. Owner actions required (blocking — before or during week 1)

| # | Action | Blocks |
|---|---|---|
| OA-1 | Create the **new GitHub repository `idaraworks`** (private). Product code never lives in the najolatech repo (AR-8) | everything |
| OA-2 | Create Supabase project — **confirm region (AR-9: recommend `ap-south-1` Mumbai, ~30–40 ms to the Gulf; alternative `eu-central-1`)**; enable PITR add-on | Phase B |
| OA-3 | Create Vercel project linked to the repo | Phase A CI |
| OA-4 | Accounts + API keys: **Inngest**, **Resend**, **Twilio** (Verify, for OTP — AR-10), **Upstash** (Redis/Ratelimit), **Sentry** | Phases C–G |
| OA-5 | Start incorporation/merchant process (OP-1 — legal lead time; blocks S9, not S0) | S9 |

## 1. Repository structure

```
idaraworks/                      (new repo — pnpm, Node 22 LTS, TypeScript strict)
├── src/                         (see §2)
├── supabase/
│   ├── migrations/              (§3 — numbered, forward-only)
│   ├── seed.sql                 (dev/demo seed: 2 orgs for the bleed harness)
│   └── config.toml              (local stack config for CI)
├── tests/
│   ├── unit/                    (vitest — colocated *.test.ts also allowed in src)
│   ├── integration/             (vitest against local Supabase: bleed, matrix, migration harness)
│   └── e2e/                     (Playwright: smoke pack, 375px + RTL + 3G profiles)
├── tooling/
│   ├── eslint-rules/            (custom: banned-nouns, raw-client, unbounded-read)
│   └── scripts/                 (check-rls.ts, seed-two-orgs.ts, reconcile-storage.ts)
├── .github/workflows/ci.yml
├── .github/PULL_REQUEST_TEMPLATE.md   (Build Bible §18 checklist + "doc-10 items touched")
├── drizzle.config.ts · next.config.ts · playwright.config.ts · vitest.config.ts
└── BUILD_BIBLE.md + phase2/ specs     (copied in at repo creation — the constitution travels with the code)
```

Conventions: trunk-based, `main` protected (CI green + 1 review — AI-reviewer output attached to PRs per OP-9); conventional commits; CODEOWNERS = owner.

## 2. Folder / module structure (Bible §3.5, S0 subset)

```
src/
├── app/                         Next.js routes (thin): (auth)/login,signup,otp,mfa · (app)/[org]/… shell · api/inngest · api/health
├── platform/
│   ├── tenancy/                 ctx.ts (Ctx type, resolver), withCtx.ts (GUC transaction wrapper), db.ts (drizzle clients)
│   ├── auth/                    session→user→membership resolution, invites, org switching, MFA helpers, sign-in log
│   ├── authz/                   can.ts, registries consumption, matrix data
│   ├── entitlements/            resolve.ts, hasFeature/getLimit/checkLimit, cache + invalidation
│   ├── audit/                   command.ts (the single command path), audit + activity writers
│   ├── files/                   storage.ts (sign-upload/read, access classes, quota), image pipeline workers
│   ├── events/                  outbox.ts (domain_event write), relay (outbox→Inngest), conventions
│   ├── notifications/           write + preference resolution (channels wired in S4)
│   ├── i18n/                    next-intl setup, formatters (money w/ currency exponents, dates, latn numerals)
│   ├── terminology/             resolver (org→template→default), term catalog types
│   ├── config/                  config_revision pipeline skeleton + schemas/ (S1 fills)
│   ├── registries.ts            ALL closed enums (one file, one owner — Bible §3.6)
│   ├── http/                    fetch wrapper (timeout/retry/breaker), rate-limit helpers
│   ├── logger.ts                pino, org/user/request tagged
│   └── ui/                      design system: tokens, RTL-first primitives (Button, Input, Select, Card, Sheet, AppShell, BottomNav, EmptyState), 44px targets
├── modules/                     (empty in S0 except:)
│   └── orgs/                    org creation/settings service (country→calendar/currency defaults)
└── workers/                     inngest client + functions: image-derivatives, storage-reconcile, outbox-relay, dead-letter-alert
```

## 3. Database migrations — exact order

Every migration containing a tenant table includes its RLS enablement + policies **in the same file** (doc 10 #2). App-side UUIDv7 via Drizzle `$defaultFn` (AR-1); DB default `gen_random_uuid()` as backstop.

| # | Migration | Contents |
|---|---|---|
| 0000 | `setup_helpers` | `create extension pgcrypto`; `app` schema for helpers; `app.current_org_id()` / `app.current_user_id()` / `app.is_cost_privileged()` reading GUCs (`current_setting(…, true)`, null-safe); `app.set_updated_at()` trigger fn; **create role `app_user` (login, NOBYPASSRLS)** + grants on schema only |
| 0001 | `org_core` | `org` (base_currency ∈ 8-currency enum, country, timezone, working_week jsonb, languages, phone_login_enabled, report_cutoff_time), `company` (org FK — data-model-ready), `app_settings` (kv per org incl. capability go-live cutoffs), `org_holiday_calendar` (+ Ramadan hours profile), `currency_rate_default` (org-editable default FX table, OP-8) — all + RLS |
| 0002 | `identity` | `user_profile` (mirrors auth.users id; full_name, locale, numeral_pref), `membership` (user×org, role_key, deactivated_at, invited_by/at, invite_channel email|phone), `role_definition` (org-cloned presets; archetype ∈ registry), `sign_in_log` — + RLS (membership rows readable by own org admins + self) |
| 0003 | `entitlements` | `entitlement_def` (key, kind feature|limit), `plan`, `plan_entitlement`, `org_plan_state` (plan, billing_state = internal_pilot|trialing|active|…, period), `org_entitlement_override` — platform tables: RLS with org read-own, writes platform-only |
| 0004 | `audit_activity` | `audit_log`, `activity` — append-only: **REVOKE UPDATE, DELETE from app_user** (doc 10 #34); indexes `(org_id, created_at)`, activity `(org_id, entity_type, entity_id, created_at)` |
| 0005 | `files_storage` | `file` (org, access_class ∈ registry, attached_to type+id, bytes, mime, variants jsonb, exif_stripped bool, void fields), `org_storage_usage` (byte counter, reconciled_at) + RLS; storage buckets created via config (§13), not SQL |
| 0006 | `comments_notifications` | `comment` (polymorphic, registry-typed), `notification`, `notification_preference` + RLS |
| 0007 | `config_revisions` | `config_revision` (org, artifact_key, before/after jsonb, actor, ai_flag) + RLS — pipeline lands S1; table now so audit path is complete |
| 0008 | `events_outbox` | `domain_event` (org, name, payload jsonb, occurred_at, processed_at, attempts) + index `(processed_at) where processed_at is null`; retention note (Appendix B) |
| 0009 | `grants_hardening` | default-deny sweep: revoke ALL from public/anon on all tables; explicit grants to `app_user`; assert no table lacks RLS (the harness test mirrors this) |

**Rollback stance (Bible §4.14):** forward-only; each file header carries a rollback note; destructive rollbacks = restore-from-backup, stated explicitly.

## 4. RLS implementation sequence

1. GUC helper functions (0000) → 2. **the wrong-ctx spike (VC-1)**: a throwaway table + policy `org_id = (SELECT app.current_org_id())`, exercised through Drizzle over the **Supavisor transaction-mode pooler**, proving `set_config(..., true)` scoping holds per transaction and resets between pooled uses → 3. `withCtx(ctx, fn)` wrapper: opens transaction, sets `app.org_id`, `app.user_id`, `app.cost_priv`, runs `fn(tx)`; repositories accept only the tx handle it provides → 4. policy template applied per table in each migration (init-plan `(SELECT …)` form — doc 10 #1) → 5. privileged-side-table variant policy (`AND app.is_cost_privileged()`) — pattern established in S0, first real use S3 → 6. **migration harness test**: enumerate `pg_tables` where an `org_id` column exists; fail if `rowsecurity` false or zero policies → 7. **DB-level block test**: repository call with deliberately wrong ctx must return zero rows / error *from Postgres* → 8. lint: raw `postgres`/service-role client import banned outside `platform/tenancy/db.ts` + migration tooling.

## 5. Authentication implementation order

1. Supabase Auth config (§13): email+password (confirmations on), **phone provider = Twilio Verify**, MFA TOTP enabled. 2. `user_profile` sync trigger (on auth.users insert). 3. Signup → **org creation flow** (name, country → working-week/holiday/currency defaults per freeze C-4/OP-8, base currency, languages) → owner membership + role. 4. Ctx resolver middleware: JWT → user → active-org membership (cookie-selected, server-validated) → role/privilege flags → Ctx. 5. Org switcher (multi-membership). 6. **Invitations**: email invites (Resend) always; **phone invites only when `org.phone_login_enabled`** — per OP-6, the org toggle gates the *invite/provisioning path*; the login screen offers "sign in with phone" for phone-provisioned users (AR-3). 7. MFA: enrol flow + org-enforced flag (grace prompt → hard requirement); admin MFA-reset (audited). 8. `sign_in_log` writes on auth events. 9. Rate limits (Upstash): login, OTP send/verify (strict per-phone + per-IP), signup. 10. Membership deactivation flow (doc 10 #22 — approval-reassignment hook stubs to S4). 11. Session/device list + remote sign-out (Supabase sessions API).

## 6. Storage implementation order

1. Buckets (private): `tenant-media`, `tenant-docs` (+ dev variants). 2. `platform/files/storage.ts`: `signUpload(ctx, class, attachTo, meta)` — checks `can()` per access-class map + **quota** (org_storage_usage + limit.storage_gb; warn 80/block 100, never reads) → returns signed upload URL + file row (pending). 3. Ingest worker (Inngest, on upload-complete event): re-encode (sharp), **EXIF/GPS strip (assert in test)**, enforce ≤2048px/~q75, write `bytes`, generate **thumb 200px + medium 1280px** variants, mark file ready. 4. `signRead(ctx, fileId, variant)` — class-checked, 60–300 s TTL (≤1 h thumbs). 5. Quota counter transactional update on ready/void; **nightly reconcile cron** (Inngest) vs bucket listing, drift alarm. 6. Client upload component (compress-before-upload, progress, retry) in `platform/ui`. 7. Lifecycle hooks: void/legal-hold flags respected by any delete path (deletion pipelines themselves are later slices). Document malware scanning attaches at the first document-upload surface (S4) — images are re-encoded, which is the image-borne mitigation (AR-4).

## 7. Queue / event infrastructure

1. Inngest client + `/api/inngest` route; env-keyed apps per environment. 2. **Transactional outbox**: services write `domain_event` inside the command transaction; relay function polls unprocessed → publishes to Inngest → marks processed (idempotent by event id). 3. Worker harness: every function re-resolves ctx from payload org_id and re-verifies (doc 10 #9) — provided as a `defineOrgFunction` wrapper so it's impossible to forget. 4. Dead-letter: max-attempt events raise a Sentry alert + ops log. 5. S0 consumers: image pipeline, storage reconcile, a `demo.heartbeat` proving the loop. 6. Conventions doc-in-code (`events/README.md`): past-tense names, versioned payloads, idempotent consumers (Bible §8.6–8.7).

## 8. CI/CD pipeline (GitHub Actions)

`ci.yml` stages, all blocking: **1** install+cache → **2** lint (ESLint incl. boundaries, custom rules; prettier; gitleaks secret scan; `pnpm audit` high+) → **3** typecheck → **4** unit (vitest) → **5** integration: `supabase start` (local stack) → run migrations → **migration harness + wrong-ctx + bleed + matrix suites** → **6** build (Next) → **7** Playwright smoke (auth → org create → shell renders en/ar) → **8** Vercel preview deploy (PRs) / production deploy (main, after migrations step runs `supabase db push` against prod via protected environment). Branch protection: CI + 1 review; `ai-authored` label convention; PR template = Bible §18. Target wall time ≤ 12 min (VC-5).

## 9. Testing strategy (S0 deliverables of the standing infra)

- **Two-org bleed harness** (doc 10 #11): `seed-two-orgs.ts` seeds every S0 entity in Org A + Org B; a generic assertion sweep runs every repository list/get as A and proves zero B rows. Grows automatically: new tables must register a seeder or the harness fails (registry check).
- **Matrix runner scaffold** (doc 10 #15): doc 06 table transcribed to `authz/matrix.data.ts`; runner iterates archetype × S0 actions (org.settings, members.invite, members.deactivate, files per class) asserting allow/deny; deny-by-default test for unknown actions.
- **Migration harness** (§4.6) + **wrong-ctx DB-block test** (§4.7).
- **Storage pipeline tests**: EXIF-strip assertion (fixture with GPS tags), variant generation, quota warn/block, class-map denials.
- **Auth flows**: signup/org-create, invite accept (email + phone-provisioned), OTP rate-limit, MFA enrol/enforce, deactivated-membership rejection, sign-in log rows.
- **i18n/RTL**: term resolution en/ar, `latn` numeral formatting test, pseudo-locale + long-Arabic snapshot of the shell/primitives.
- **Unit**: ctx resolver, entitlement resolve/override precedence, command-path audit+activity writes, money formatter incl. **exponent-3 currencies** (OP-8).
- Test DB: ephemeral local Supabase per CI run; local dev uses `supabase start` too (parity).

## 10. Required environment variables

`APP_URL` · `DATABASE_URL` (pooled, **app_user**, transaction mode) · `DIRECT_URL` (migrations only) · `SUPABASE_URL` · `SUPABASE_ANON_KEY` · `SUPABASE_SERVICE_ROLE_KEY` (**CI/migration env only — never in app runtime env**, lint-guarded) · `SUPABASE_JWT_SECRET` (if server-side verification) · `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` · `RESEND_API_KEY` · `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SID` · `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` · `SENTRY_DSN` / `SENTRY_AUTH_TOKEN` (CI sourcemaps) · `FIELD_ENCRYPTION_KEY` (32-byte, future integration credentials) · `NODE_ENV` / `APP_ENV` (dev|preview|prod). Each documented in `.env.example` with owner + rotation note (values never committed).

## 11. Required external services & accounts

GitHub (repo `idaraworks`, Actions) · Supabase (project + PITR; region per AR-9) · Vercel (project; region colocated with DB) · Inngest · Resend (+ sending domain DNS) · Twilio (Verify service; sender registration for GCC SMS routes — **check UAE/KSA sender-ID prereqs early**, VC-2) · Upstash · Sentry. Later slices (not now): e-invoice partner (S6), Stripe (S9), pen-test vendor (S11).

## 12. Required secrets (storage & handling)

Vercel encrypted env (runtime) · GitHub Actions environments with protection rules (CI/deploy) · Supabase dashboard secrets stay in Supabase. Rules: service-role key exists **only** in the GitHub `migrations` environment; Twilio/Resend/Inngest keys per-environment (test vs live); gitleaks in CI; quarterly rotation entries in the ops runbook; any key that ever touches a chat/log is rotated immediately.

## 13. Required Supabase configuration

Auth: email provider on (confirmations required; SMTP → Resend); phone provider on → Twilio Verify; **MFA TOTP enabled**; JWT expiry ~1 h + refresh rotation on; redirect URLs per environment; anonymous sign-ins **off**. Database: PITR add-on; `app_user` role created by migration 0000; Supavisor transaction-mode pooling (app) + session-mode/direct (migrations). Storage: two private buckets; upload size caps (media 15 MB, docs 25 MB). API: PostgREST unused by the app (Drizzle direct) — set `db.max_rows` low (100) anyway as a tripwire; anon key exposure limited to auth. Realtime: off (nothing may require sockets). Logs/webhooks: auth webhook → sign-in log (or poll), configured per environment.

## 14. Required Vercel configuration

Project linked to repo; **function region colocated with the DB region** (AR-9); env vars per environment (Production/Preview/Development); preview deployments on PRs; production deploys only from `main` via CI (deploy hook after migration step); security headers in `next.config.ts` (CSP, HSTS, nosniff, frame-ancestors, referrer-policy — Bible §6.8); image optimization allow-list = Supabase storage host; no cron (Inngest owns schedules); Sentry integration.

## 15. Acceptance criteria per S0 deliverable

| Deliverable | AC (all automated unless marked 👁 manual) |
|---|---|
| Repo + CI | Pipeline §8 green end-to-end on a PR; boundary + raw-client + banned-noun lints demonstrably fail seeded violations; wall time ≤ 12 min |
| RLS mechanism | Wrong-ctx DB-block test green **through the pooler**; migration harness green; service-role lint fails a seeded violation |
| Bleed harness | Green across all S0 entities in 2 seeded orgs; unregistered-table check fails a seeded new table |
| Auth | Signup→org-create→owner membership e2e; email invite + phone-provisioned invite accepted; OTP rate-limit triggers; MFA enrol + org-enforcement + audited admin reset; deactivated membership rejected at ctx resolution; sign-in log rows present |
| Org settings | Country selection yields correct working-week + holiday calendar + base-currency defaults (UAE/KSA/6-day fixtures); phone_login toggle gates phone invites |
| Entitlements | `hasFeature`/`getLimit` resolve plan + override precedence; cache invalidation on override write; unknown key throws |
| Audit/activity | Every S0 mutation via the command path produces audit (and activity where applicable) rows — decorator test; UPDATE/DELETE on audit tables fails as app_user |
| Storage | Upload→re-encode→**EXIF gone (GPS fixture)**→thumb+medium exist; quota warn at 80% and block at 100% (reads still served); class-map denial (e.g. hr_doc as non-privileged) |
| Events | Outbox row → relay → consumer executed idempotently (duplicate publish test); dead-letter alert fires on forced failure; worker wrong-org re-verification test |
| i18n/terminology/RTL | `term('job')` resolves per stub template en/ar; money formats AED (2) and KWD (3) correctly with `latn` digits under `ar`; shell renders RTL with no horizontal scroll 👁 + snapshots |
| Observability | `/api/health` checks DB/queue/storage; Sentry receives a seeded error with request_id; logs carry org/user/request ids and no tenant values at info |
| Docs | `.env.example`, events README, runbook stubs (rotation, restore) committed |

## 16. Risks & validation checkpoints

| # | Checkpoint (gate — do not proceed past it on red) | When | Risk mitigated |
|---|---|---|---|
| VC-1 | **Supavisor GUC spike**: transaction-mode pooling + `set_config` scoping proven with concurrent requests (two orgs, interleaved) | Week 1, before any real table | The entire RLS mechanism (F-21). If it fails: fall back to per-request session-mode connections for writes (documented alternative, same seam) |
| VC-2 | **Twilio OTP to a real UAE/KSA number** (sender-ID/registration reality) | Week 1–2 | GCC SMS deliverability; if blocked, admin-issued credentials path (OP-6 fallback) keeps S0 unblocked |
| VC-3 | Bleed harness green on first 3 entities before building the rest | Week 2 | Catch harness design flaws early, not at 15 entities |
| VC-4 | EXIF fixture verified stripped in the deployed preview (not just local sharp) | Week 3 | Serverless sharp behaviour differences |
| VC-5 | CI wall time ≤ 12 min with the integration stage | Week 3 | Solo velocity depends on fast CI |
| VC-6 | End-of-S0 walkthrough: every §15 AC demonstrated in one session, recorded | Exit | The S0→audit gate |
| — | Standing risks: solo+AI cadence unknown until measured (doc 11 note — measure S0 actuals vs 6 bw); scope gravity (anything not in §2's tree is not S0); Supabase local-CI flakiness (pin CLI version) | — | — |

## 17. Implementation order & dependencies

| Phase | Contents | Depends on | Est. (solo + AI) |
|---|---|---|---|
| A | Repo, tooling, lints, CI skeleton (no integration stage yet), design tokens + primitives shell | OA-1..3 | 3–4 d |
| B | Migrations 0000–0001 + **VC-1 spike** + withCtx + migration harness + wrong-ctx test; CI integration stage | A | 4–5 d |
| C | Identity: 0002, auth flows, org creation, ctx resolver, invites, MFA, rate limits, sign-in log (**VC-2 parallel**) | B | 6–7 d |
| D | Entitlements (0003) + audit/activity command path (0004) | B | 3–4 d |
| E | Files (0005) + storage helper + workers (**VC-4**) | B, G(client) | 4–5 d |
| F | Comments/notifications/config-revision tables (0006–0007); i18n + terminology + formatters; RTL pass over primitives | A, B | 3–4 d |
| G | Events/outbox (0008) + Inngest + worker harness + dead-letter | B | 2–3 d |
| H | Test-infra completion: bleed sweep over all entities (**VC-3 earlier**), matrix runner, snapshots; 0009 hardening | C–G | 3–4 d |
| I | Observability (Sentry/health/logger), docs, **VC-5/VC-6**, S0 implementation audit prep | all | 2–3 d |

Total ≈ **30–39 working days ≈ 6–8 calendar weeks solo+AI** (doc 11 estimated 6 bw; the S0 actual becomes the calibration datum for all later slices per the OP-9 note).

---

## Self-review against the Build Bible

Checked section-by-section: §2 P3 (tenancy: items §3/§4/§9 of this checklist — covered, with VC-1 as the proof, not an assumption) · §2 P6 (no speculative mechanisms: the only S0 abstractions are `withCtx`, `command`, `defineOrgFunction`, and the storage class map — all mandated by doc 10) · §3 boundaries (lint from day 1) · §4 DB standards (UUIDv7, snake_case, append-only audit, forward-only migrations — §3 table complies) · §6 security (headers §14, rate limits §5.9, secrets §12) · §8 (typed errors + logger land in Phase A/I) · §9 RTL-first (Phase A tokens + Phase F pass) · §11 budgets (no S0 user surfaces beyond auth/shell; budget harness lands S5 per plan) · §13/§14 (test classes + pipeline match) · §17 DoD adopted as §15.

**Deviations found and disposition:**
1. **Dark theme** (Bible §9.2 "both themes tested"): S0 ships light-only with token structure ready — logged as *acceptable debt* per Bible §16 with an issue; dark theme is P3 polish. No freeze impact.
2. **Document malware scanning** (doc 10 #27): deferred to the first document-upload surface (S4); images are mitigated by re-encoding in S0 (AR-4). Doc-10 item ownership noted in the S4 slice.

## Ambiguity register (implementation-level resolutions — no architecture changed)

| # | Ambiguity | Resolution |
|---|---|---|
| AR-1 | UUIDv7 source (Postgres lacks native v7) | App-generated (`uuidv7` package) via Drizzle `$defaultFn`; `gen_random_uuid()` DB backstop for manual inserts |
| AR-2 | RLS connection mechanics on Supabase | Dedicated `app_user` role (NOBYPASSRLS) over Supavisor transaction mode; GUCs set per transaction in `withCtx`; **VC-1 is the gate**, with session-mode fallback documented |
| AR-3 | Per-org phone-login semantics (auth provider is global, users span orgs) | The org toggle gates the **invite/provisioning path**: phone invites only from orgs with `phone_login_enabled`; phone-authed users therefore only hold memberships that chose it. Login screen offers phone sign-in generally; no per-session org gating needed |
| AR-4 | Malware scan timing | Images: re-encode (S0). Documents: scanner attaches with the first doc surface (S4) |
| AR-5 | i18n library | `next-intl` (ICU MessageFormat per doc 07), terminology injected as variables |
| AR-6 | Test database in CI | Supabase CLI local stack (pinned version) per run; same for local dev — env parity |
| AR-7 | Where product code lives | **New `idaraworks` repo** (OA-1); specs copied in; the najolatech repo keeps the strategy/docs history only |
| AR-8 | Supabase region (doc 10 #43 record) | Recommend `ap-south-1` (Mumbai) for Gulf latency; PDPL posture identical either way (no GCC region exists) — **owner confirms at OA-2** |
| AR-9 | SMS provider | Twilio Verify default; Unifonic noted as GCC-native alternative if VC-2 exposes deliverability problems |
| AR-10 | Multi-currency in S0 | S0 builds the **formatter/exponent layer and org base-currency + default-rate table only**; document-level FX lands with quotes/invoices (S6) per OP-8 — nothing more is pulled forward |

**Approval request:** this checklist awaits owner approval. On approval, implementation begins with Phase A — S0 only, stopping automatically at S0 completion with a full implementation audit against the Freeze, the Build Bible, and doc 11 before S1.

---

## Phase B amendment log (spec-divergence filings per BUILD_BIBLE §19)

- **A-B1 — Single migration authority (review M1/M3):** `tooling/scripts/migrate.ts` (ledger `app.migrations`, over `DIRECT_URL`) is the ONLY migration applier — in CI, locally, and hosted. The Supabase CLI's auto-apply is disabled (`[db.migrations] enabled = false`, `[db.seed] enabled = false` in `supabase/config.toml`); **`supabase db push` is NOT this project's deploy path** — §8's earlier mention of it is superseded.
- **A-B2 — Ramadan working-hours profile location:** lives in `app_settings` under key `ramadan_hours_profile` (Zod schema owned by the calendar service, Phase F), NOT as rows/columns on `org_holiday_calendar`. §3's 0001 row is amended accordingly.
- **A-B3 — DATABASE_URL contract (§10):** the runtime env stores the dashboard Transaction-pooler URI **without needing its password** — `src/platform/tenancy/env.ts` swaps in `app_user` + `APP_DB_PASSWORD`. Operators should redact the dashboard password when pasting. `DIRECT_URL` note: hosted `db.<ref>.supabase.co` is IPv6-only; on IPv4-only networks use the Session-pooler URI.
- **A-B4 — app_user credential hygiene:** the migration runner sets the role password as a **SCRAM-SHA-256 verifier**, never plaintext, so `pg_stat_statements`/DDL logs contain no recoverable secret.
- **A-B5 — Shared-pool law (VC-1 empirical finding, CI runs e927f12/ae21a6b):** the shared app pool is for **withCtx transactions only**; bare `.execute()` on the pool is banned. Evidence: after an aborted transaction under Supavisor transaction-mode pooling, postgres.js can permanently stall its dispatch queue for non-transaction queries queued beyond pool size (server connections idle, client queue dead; fresh clients unaffected; concurrent *transactions* unaffected — 40-way interleave passes). One-off unscoped needs (health checks, probes) use a dedicated `createAppDb({max:1})` client. Lint guard lands with Phase C's health endpoint.
- **A-B6 — Hosted default-privilege revocation (found by the harness on the hosted project):** Supabase grants `anon`/`authenticated` on new public tables via default privileges (PostgREST convention; absent on the CI local stack). New migration `0002_revoke_builtin_role_privileges.sql` revokes existing and future grants for those roles (`service_role` untouched — platform-managed; its key stays banned from app runtime). **Planned migrations from §3 shift by one** (identity → 0003, entitlements → 0004, …). The harness test enforces zero built-in-role privileges permanently.
