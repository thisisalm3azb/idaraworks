# IdaraWorks — Pilot Owner-Action Checklist (prioritised)

> **Product:** IdaraWorks — an AI-configured **Operations Management System** (not an ERP) for GCC
> project-based industrial SMEs. Arabic + English, RTL, mobile-first. Next.js + Supabase Postgres
> (Seoul, `ap-northeast-2`) + Vercel (`idaraworks.vercel.app`). Hosted DB at migrations `0000–0064`
> (next `0065`). Deployed + CI-green at commit `97985e1`. Baseline orgs = **[Alpha Marine, TESTING]**.
>
> **Target:** a **controlled pilot** — founder-onboarded, 1–2 arm's-length GCC industrial SMEs,
> **NO real payment processing**.
>
> **This document supersedes `docs/pilot/08-owner-action-checklist.md`** (the prior consolidated list)
> and re-tiers it against a single question: *does this action block the controlled pilot, or does it
> only block taking real money / broad exposure?* Doc 08 remains the historical source; use this file
> going forward. Companion detail lives in `docs/pilot/05-operational-billing-readiness.md`,
> `docs/pilot/06-launch-criteria-checklist.md`, and `runbooks/credential-disabled-operations.md`.

---

## How to read this

Every action carries the same seven fields:

- **What** — the concrete action.
- **Why** — what it protects or enables.
- **Where** — the store / dashboard / code path where it is configured.
- **Env / setting** — the exact variable or setting name (where one exists). **No secret VALUE
  appears anywhere in this repo, logs, or chat — only the name and where to set it.**
- **Validate** — how you prove it is done.
- **Safe fallback now** — what the product does today with the seam left as-is (the *intended*
  default pilot posture, not a degraded one).
- **Consequence if left** — what you actually lose by not doing it.

**Secrets rule:** every value below goes to the **platform secret store** (Vercel project env for
`idaraworks`, or the Supabase dashboard) — **never** the repo, logs, tickets, or chat. Rotation for
every key follows `runbooks/secret-rotation.md`.

### The four tiers

| Tier | Gate | Blocks a first pilot login? |
| --- | --- | --- |
| **A** | Before the first pilot user logs in | **Yes** — genuine pilot blockers |
| **B** | During pilot setup | No — configuration / operational readiness |
| **C** | Before charging customers (real money / government e-invoice) | No — gates real billing, not the pilot |
| **D** | Optional improvements | No — non-blocking credentials / enhancements |

### Current production posture (authoritative — verify, don't assume)

**SET in Vercel prod** (the two hard, always-on dependencies + storage): `APP_ENV=prod`,
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATABASE_URL` (Supavisor pooler,
password-redacted), `APP_DB_PASSWORD`, `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY` /
`STORAGE_S3_ENDPOINT` / `STORAGE_S3_REGION`. Deliberately **not** deployed to runtime:
`SUPABASE_SERVICE_ROLE_KEY`, `DIRECT_URL` (tooling/migrations only).

**NOT SET in prod ⇒ that seam is disabled/degraded by design** (every one has a working fallback,
detailed in `runbooks/credential-disabled-operations.md`): `INNGEST_EVENT_KEY` /
`INNGEST_SIGNING_KEY`, `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`, `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN`, `RESEND_API_KEY` / `EMAIL_FROM`, `OAUTH_ENABLED`, `SCAN_PROVIDER`,
`AI_NARRATION_PROVIDER`, `BILLING_PROVIDER` (→ disabled via `isProd()`), `EINVOICE_PROVIDER`
(→ disabled via `isProd()`).

**The one rule that governs the seams:** every "are we in production?" decision routes through
`isProd()` (`src/platform/env.ts`), true only when `APP_ENV=prod`. Only `db` and `storage` gate
`GET /api/health` (200 vs 503); everything else degrades gracefully or defers. `pnpm smoke:prod`
asserts the whole surface, including that each disabled seam reports its state *explicitly*.

---

## Tier A — Required before the first pilot user logs in

Only genuine blockers. Each has filed evidence or a completed action before a real external user
touches the system.

### A1 — External penetration test, criticals = 0  *(HARD GATE — no waiver)*

- **What:** Book and execute an external pen test against the frozen scope (tenancy isolation, IDOR,
  storage access classes, share surface, auth/session, upload validation — `phase2/10` items 1–14,
  15–22, 27, 30); drive **criticals to 0** (mediums get dated fix commitments).
- **Why:** This is the only external adversarial validation of the multi-tenant + money-path walls.
  `phase2/11` §S11 DoD and `docs/pilot/06` §F make it the one criterion with **no waiver**.
- **Where:** External vendor engagement (was flagged for booking at S6 for 4–8-week lead time). Not a
  repo/env action.
- **Env / setting:** — (vendor process; no env var).
- **Validate:** Pen-test report with criticals count = 0 + a remediation log; recorded in
  `docs/pilot/06` §F3 and §H sign-off.
- **Safe fallback now:** Internal adversarial coverage only — every slice S6–S11 passed an
  independent multi-lens review with per-finding verification (S10: an 8-lens audit + a 4-lens diff
  review). Strong, but internal.
- **Consequence if left:** No independent confidence that an arm's-length tenant cannot reach another
  tenant's data or the money path. **Do not open the pilot with any unresolved critical.**

### A2 — Confirm Supabase PITR add-on active + a nightly logical backup to a second provider/region

- **What:** Confirm Point-in-Time-Recovery is **active** on the production Supabase project, and that
  a nightly logical backup lands in a second provider/region and is readable.
- **Why:** PITR is what bounds the published **RPO ≤ 1h**; the second-region backup is the vendor-exit
  and restore-drill source (`phase2/10` #46). Without PITR the achievable RPO is only the nightly
  cadence.
- **Where:** Supabase Dashboard → Project → Settings → Add-ons → Point-in-Time Recovery; plus wherever
  the nightly logical dump is written. Referenced in `runbooks/restore-drill.md` §0 and
  `runbooks/backup-monitoring.md`.
- **Env / setting:** — (dashboard add-on + backup job; no runtime env var). The drill itself consumes
  the already-set `STORAGE_S3_*` credentials.
- **Validate:** PITR shown active in the dashboard; the latest nightly backup file confirmed present
  and readable (manually, until the backup-status monitor of `docs/S10-AUDIT-REGISTER.md` line 17 is
  built).
- **Safe fallback now:** Supabase's default managed daily backups exist, but RPO is then bounded by
  that cadence, not ≤ 1h.
- **Consequence if left:** A data-loss event could lose up to a full day; the A3 restore drill cannot
  measure a true RPO ≤ 1h and has no independent-region source to restore from.

### A3 — First restore drill executed, evidence filed (RPO ≤ 1h / RTO ≤ 4h)

- **What:** Run `runbooks/restore-drill.md` end-to-end — DB **and** storage restored into a *plain*
  Postgres 17 target and a *plain* S3 target — and file the measured evidence.
- **Why:** Proves the recovery objectives and doubles as the vendor-exit rehearsal (`phase2/10`
  #47/#48). The first drill is required **before pilot start**.
- **Where:** `runbooks/restore-drill.md` (executable procedure + evidence tables). Uses `STORAGE_S3_*`
  (already set) + a throwaway `TARGET_S3_*` the owner provisions. **Never restore onto production.**
- **Env / setting:** — (operator drill; the throwaway target creds live only on the operator machine).
- **Validate:** The completed §1f / §2d / §3 evidence tables + a §4 drill-log row co-signed by
  operator + witness, showing per-org counts match, RLS policy count = reference, `app_user`
  NOBYPASSRLS + narrow DELETE allowlist, and **measured RPO ≤ 1h / RTO ≤ 4h**.
- **Safe fallback now:** The procedure is written and GREEN; only the first *live* execution is
  outstanding.
- **Consequence if left:** Recovery is unproven — you would be discovering restore gaps during a real
  incident, with real pilot data at stake.

### A4 — Incident-response tabletop executed, evidence filed

- **What:** Run the tabletop in `runbooks/incident-response.md` (detect → contain → per-tenant scope →
  notify → post-mortem) and file the evidence entry.
- **Why:** `phase2/10` #50 / `docs/pilot/06` §E15 — the response path must be exercised, not just
  written, before real tenants are exposed.
- **Where:** `runbooks/incident-response.md`. Not a repo/env action.
- **Env / setting:** — (drill; no env var).
- **Validate:** A dated tabletop evidence entry with participants and the walked scenario.
- **Safe fallback now:** The runbook exists and is complete; structured pino logs
  (`request_id`/`org_id`/`user_id`) + `/api/health` + `/api/ready` are the live signals today.
- **Consequence if left:** First real incident is run cold — slower containment, unclear per-tenant
  notification path.

### A5 — Arabic native-reviewer sign-off (zero open sev-1 language issues)

- **What:** A native Arabic speaker signs off the all-surfaces Arabic/RTL review as sev-1 = 0.
- **Why:** Arabic is a first-class product surface, not a translation layer (`phase2/11` §S10 F-50;
  `docs/pilot/06` §A4). The S10 AI sweep fixed the found sev-1s; a human confirms.
- **Where:** Review artifact filed against `docs/pilot/06` §A4. Not a repo/env action.
- **Env / setting:** — (human review; no env var). Note the language switcher itself is per-user
  (Account → Language) and already wired.
- **Validate:** Signed reviewer confirmation of zero open sev-1 language issues across surfaces.
- **Safe fallback now:** AI i18n sweep complete; locale switcher wired; bidi snapshot tests green.
- **Consequence if left:** Risk of an Arabic-facing sev-1 (mistranslation / broken RTL on a key
  action) reaching the pilot owner in their primary language.

### A6 — DPA / PDPL lawful-transfer basis  *(CONDITIONAL — KSA pilot holding visa/ID documents)*

- **What:** For any **KSA** pilot that will hold visa/ID documents: document the lawful cross-border
  transfer basis in the DPA, record the hosting region (Seoul), and complete a PII inventory.
- **Why:** KSA PDPL requires a documented lawful-transfer basis for personal data leaving the Kingdom
  (`phase2/10` #43, F-46; `docs/pilot/06` §E8).
- **Where:** DPA / PDPL posture document (legal). Hosting region is fixed at Supabase Seoul
  (`ap-northeast-2`).
- **Env / setting:** — (legal document; no env var).
- **Validate:** DPA authored with the transfer basis + a completed PII inventory, filed before a KSA
  org onboards ID documents.
- **Safe fallback now:** **A UAE-only pilot without KSA PII does not need this before start** — but
  it is required before any KSA org (and before any KSA org uploads ID documents). Scope your first
  pilot accordingly.
- **Consequence if left:** A KSA pilot holding ID documents without a documented basis is a
  regulatory exposure. (Not applicable to a non-KSA pilot.)

### A7 — Rotate the DB / app passwords before real external users

- **What:** Rotate the Supabase database password and the `app_user` role password (the value behind
  `APP_DB_PASSWORD`), because the initial values were weak / personal.
- **Why:** These credentials guard real customer PII the moment an external pilot user's data lands.
  Rotating before that crossing is basic pre-pilot hygiene (doc 08 §D; also satisfies the first
  secret-rotation drill, `docs/pilot/06` §E11).
- **Where:** Supabase Dashboard → Database → password (postgres role) for the DB password; set the new
  `app_user` password on the role, then update **`APP_DB_PASSWORD`** in the Vercel prod env and
  redeploy. `DATABASE_URL` stays password-redacted (the app derives its pooled connection as
  `app_user` + `APP_DB_PASSWORD` in `src/platform/tenancy/env.ts`). Follow `runbooks/secret-rotation.md`.
- **Env / setting:** `APP_DB_PASSWORD` (Vercel prod env) + the Supabase postgres/role password
  (dashboard). **Name only — never the value.**
- **Validate:** Post-rotation `GET /api/health` returns `db.ok = true`; `pnpm smoke:prod` passes; the
  rotation is logged in the secret-rotation drill log.
- **Safe fallback now:** The app functions on the current credentials — this is a strength issue, not
  an outage.
- **Consequence if left:** A weak/personal credential guards real tenant data across an external trust
  boundary.

---

## Tier B — Required during pilot setup (configuration / operational readiness)

Not login-blockers, but the pilot should be configured with these resolved so the operational cadence
and the pilot org's own bookkeeping are correct.

### B1 — Inngest Cloud keys (make the nightly automation live)

- **What:** Provision Inngest Cloud app `idaraworks` and install its two keys so the worker fleet + 5
  crons run live (exception sweep, cost-rollup invalidation, subscription lifecycle/dunning, retention
  prune, outbox relay).
- **Why:** With the keys absent, `/api/inngest` returns `503 inngest_unconfigured`, all crons +
  workers are dormant, and post-commit side effects (digest/exception refresh cadence, PDF render
  seam, cache invalidation) do not fire automatically.
- **Where:** Inngest dashboard (app id must match `src/platform/events/inngest.ts`) → keys installed in
  Vercel prod env → redeploy → sync app. Full steps in `runbooks/inngest-provisioning.md`.
- **Env / setting:** `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` (Vercel prod env). **Never set
  `INNGEST_DEV=1` in production** — it would accept unsigned invocations.
- **Validate:** `GET /api/inngest` no longer returns `inngest_unconfigured`; `/api/health`
  `checks.inngest.status = "configured"`; `checks.queue.unprocessed` drains to 0; a signed
  `demo-heartbeat` invocation succeeds and a forged actor pair FAILS (`OrgVerificationError`); an
  unsigned POST is rejected.
- **Safe fallback now:** **Every synchronous user-facing write commits fully in-request** and the
  outbox never loses an event — domain events accumulate durably (at-least-once by design) and deliver
  the moment the relay runs. The dormant work is directly invocable on-demand (`relayOutbox()`,
  `sweepLifecycle()`, `dispatchNightly()`, `runOrgNightly()`, `pruneRetention()` — see
  `runbooks/credential-disabled-operations.md` §1 and `runbooks/queue-worker-recovery.md`). For a
  no-payment pilot, a dormant **lifecycle** cron is even desirable (no trial auto-expires mid-pilot).
- **Consequence if left:** The morning digest / exception views refresh only when the relevant work is
  run on-demand; stored PDFs, image thumbnails, and cost-rollup cache invalidation defer. Nothing is
  lost — it is deferred. *(Doc 08 listed this under its Section A "controlled-pilot blocking"; because
  it degrades cleanly to on-demand invocation, it is more precisely an operational-readiness item —
  resolve it before or during setup so the nightly cadence is live.)*

### B2 — Tenant VAT posture for the pilot org (`finance.vat_registered`)

- **What:** Decide and set the pilot org's VAT-registration flag and the standard line `vat_rate` to
  match the accountant's decision, so the org's **own** invoices to its **own** customers compute VAT
  correctly.
- **Why:** This is the tenant-invoicing layer the pilot org uses day-to-day (distinct from IdaraWorks
  charging the org — that stays disabled, Tier C). VAT is org-configured and also drives the costing
  engine's VAT basis, so the two never disagree (`docs/pilot/05` §3.2).
- **Where:** `app_settings` key **`finance.vat_registered`** (default **true** = VAT-registered), plus
  per-line `vat_rate` and `is_export` zero-rating on quotes/invoices. Backing:
  `src/modules/invoices/service.ts` (`computeInvoiceTotals`).
- **Env / setting:** `app_settings` key `finance.vat_registered` (per-org config, not an env var).
- **Validate:** A test invoice computes VAT per line; an `is_export` line is zero-rated; a
  non-registered org issues zero-VAT; the number matches the accountant's expectation
  (`docs/pilot/05` §7).
- **Safe fallback now:** Defaults to VAT-registered (`true`) with per-line rates; both VAT bases are
  built and golden-tested.
- **Consequence if left at a wrong default:** The pilot org's own invoices could apply VAT where they
  shouldn't (or vice-versa). *Formal accountant ratification is PB-3 in Tier C.*

### B3 — Verify the disabled-seam posture at pilot start (read-only)

- **What:** Confirm the production commercial seams are disabled and the app reports it explicitly —
  before the owner sees the workspace.
- **Why:** S10 fixed a guard that previously compared a never-set string and silently served the
  **fake** provider in prod (a fake checkout shown as enabled). Verifying at start is how you catch a
  regressed env guard (`docs/pilot/05` §2, `runbooks/credential-disabled-operations.md`).
- **Where:** `GET /api/health`, `pnpm smoke:prod`, and the subscription page
  `/o/{orgId}/settings/subscription`.
- **Env / setting:** Confirm `BILLING_PROVIDER` is **unset or `disabled`** (never `fake`) in prod;
  `EINVOICE_PROVIDER` unset (→ disabled); `APP_ENV=prod`.
- **Validate:** `/api/health` reports the expected deployed commit + `inngest.status`; the subscription
  page shows **"commercial activation unavailable"** with no Buy/checkout/portal button; a
  `POST /api/billing/webhook` with any body is rejected (`verifySignature()` → false). `pnpm smoke:prod`
  = 18/18.
- **Safe fallback now:** This is a verification, not a change — the seams already default disabled
  under `isProd()`.
- **Consequence if left:** You could miss a mis-set env (e.g. a stray `BILLING_PROVIDER=fake`)
  presenting a live-looking Buy button in prod. If you ever see one, **stop** — the env guard is wrong.

---

## Tier C — Required before charging customers (real money / government e-invoice)

**None of these block the controlled no-payment pilot.** They gate IdaraWorks charging the pilot org,
the pilot org submitting to a tax authority, and final commercial numbers. Each is a **pure activation
step** behind an interface that already ships — secrets + a real adapter, **no schema or logic change**.

### C1 — D1: incorporation & merchant of record

- **What:** Choose the entity country + payment merchant, then implement a real billing provider behind
  the `BillingProvider` interface and load its credentials.
- **Why:** D1 gates the real payment adapter, live webhooks, per-currency price IDs, and the tax
  mechanism (`docs/pilot/05` §2). No processor is wired today.
- **Where:** `src/platform/billing/adapter.ts` (`getBillingProvider()`); secrets → platform secret
  store; provider price IDs per currency.
- **Env / setting:** `BILLING_PROVIDER=<real provider>` (e.g. `stripe`/`paddle`/`tap`/`moyasar`) plus
  the processor's signing secret + API credentials (names only; values → secret store). Leaning UAE +
  Stripe is **unverified** — confirm Stripe's KSA support at decision time.
- **Validate:** After activation, a live checkout completes, a signed webhook is accepted and advances
  subscription state, `getBillingProvider().enabled === true` in prod.
- **Safe fallback now:** The entire **subscription state machine + entitlement gating** runs live and
  governed with no real money; every outbound billing op refuses with `BillingProviderDisabledError`
  and inbound webhooks are rejected. No card data is ever touched.
- **Consequence if left:** IdaraWorks cannot charge the pilot org — which is exactly the intended
  no-payment posture. Leave disabled for the pilot.

### C2 — D3: final pricing numbers + per-tier limit values

- **What:** Ratify the actual plan prices and tier limits, then (only after ratification) publish them.
- **Why:** Every seeded `plan_price` row is `is_placeholder=true`; the limit values (`full_users`,
  `active_jobs`, `storage_gb`, `ai_credits_month`) are placeholders (`docs/pilot/05` §3.1).
- **Where:** `public.plan_price` (seeded in migration `0052`), edited only via `app.set_plan_price`
  (active `platform_staff` + `assert_platform_task`); entitlement values in
  `phase2/09-entitlements-config-schemas.md`.
- **Env / setting:** — (data, not env; `is_placeholder` flag + per-currency price rows).
- **Validate:** Ratified prices inserted as new versions (supersede-not-mutate); `is_placeholder=false`
  only after D3 is signed; the subscription page stops marking prices indicative.
- **Safe fallback now:** Prices display marked **indicative/placeholder**; entitlement **keys** are
  final and enforced live at placeholder values (FR-9: gates ADD, never reads/exports). New orgs get a
  full-featured Growth trial.
- **Consequence if left:** No ratified commercial numbers to charge against; do **not** flip
  `is_placeholder=false` or activate a provider until D3 is decided.

### C3 — PB-3: accountant VAT sign-off

- **What:** The accountant formally ratifies which VAT base a real org uses (both bases are built +
  golden-tested).
- **Why:** Gates the pilot org issuing real customer invoices at scale / with confidence (`docs/pilot/05`
  §3.2, OP-5). Complements the B2 flag-setting.
- **Where:** Accountant sign-off recorded; the decision drives `finance.vat_registered` + standard
  `vat_rate` (B2).
- **Env / setting:** — (sign-off; drives the `finance.vat_registered` app_setting).
- **Validate:** Signed accountant ratification on file; the org's VAT config matches it.
- **Safe fallback now:** The interim B2 flag operates correctly; both VAT bases are tested.
- **Consequence if left:** Real customer invoices issued before an accountant confirms the VAT base.

### C4 — Tax mechanism

- **What:** Decide the tax mechanism (Stripe Tax vs merchant-of-record vs a local gateway).
- **Why:** Provider-determined and D1-blocked — you cannot pick it before the merchant is chosen
  (`docs/pilot/05` §2).
- **Where:** Determined with C1 (D1); implemented alongside the real billing adapter.
- **Env / setting:** — (mechanism decision; concrete settings arrive with the provider).
- **Validate:** Tax is computed and remitted per the chosen mechanism on a live charge.
- **Safe fallback now:** No platform charges occur, so no platform-tax mechanism is exercised; the
  tenant VAT layer (B2/C3) is independent and live.
- **Consequence if left:** Cannot correctly tax a real platform charge — moot until C1.

### C5 — D4: certified e-invoice / ZATCA partner + credentials

- **What:** Implement a real provider behind the `EInvoiceProvider` interface, supply its credentials,
  and enable it.
- **Why:** No real government/tax-authority submission can occur without a certified partner (D4/FR-16).
- **Where:** `src/platform/einvoice/adapter.ts` (`getEInvoiceProvider()`); credentials → secret store.
  (The code references `runbooks/einvoice-provisioning.md`, which lives with the D-decision and is not
  yet written.)
- **Env / setting:** `EINVOICE_PROVIDER=<real provider>` + partner credentials (names only).
- **Validate:** After activation, `getEInvoiceProvider().enabled === true` in prod; an invoice returns
  a real clearance id + QR.
- **Safe fallback now:** The **full invoicing lifecycle** (issue, credit-note, AR aging, payments) is
  independent of clearance; the disabled provider records a gated no-op — invoices are valid business
  documents without a clearance id. **Do not represent pilot invoices as government-cleared.**
- **Consequence if left:** No government e-invoice clearance — correct and expected for the pilot.

### C6 — Per-org commercial config

- **What:** Set per-org pricing / tax / VAT-registration flag / thresholds for a real paying org.
- **Why:** Real commercial operation needs the org's own commercial parameters ratified (doc 08 §B).
- **Where:** Per-org entitlement overrides + `app_settings`; plan linkage via the platform
  subscription path (`app.advance_subscription`, `assert_platform_task`-guarded).
- **Env / setting:** — (per-org data/overrides; not env vars).
- **Validate:** The org's entitlements + VAT + thresholds reflect its signed commercial terms.
- **Safe fallback now:** Pilot orgs sit in `internal_pilot` / `trialing` with `provider=null` (the same
  posture as Alpha Marine + TESTING) and never require a merchant.
- **Consequence if left:** No per-org commercial terms to bill against — expected pre-charging.

---

## Tier D — Optional improvements (non-blocking credentials / enhancements)

Each has a working disabled seam; enabling improves robustness or reach without changing the pilot's
correctness. Enable when convenient — or before broad/adversarial exposure where noted.

### D1 — Sentry (error + worker-failure capture)

- **What:** Provision a Sentry project and install the DSNs.
- **Why:** Centralised error aggregation + alerting (notably the `outbox_dead_letter` page-worthy
  signal). `runbooks/sentry-provisioning.md`.
- **Where:** Sentry dashboard → Vercel prod env → redeploy. Code: `src/platform/observability/sentry.ts`.
- **Env / setting:** `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` (optional browser capture),
  `NEXT_PUBLIC_APP_ENV=prod`.
- **Validate:** `pnpm tsx tooling/scripts/seed-sentry-error.ts` surfaces one event tagged `request_id`
  with no PII; a real 5xx creates an issue via `onRequestError`.
- **Safe fallback now:** Structured pino logs (every line tagged `request_id`/`org_id`/`user_id`) in
  Vercel → Logs, plus `/api/health` + `/api/ready`. **Dead-letter alerting is silent** — until Sentry
  is on, watch `/api/health` `checks.queue.dead_lettered` yourself (smoke:prod / an uptime monitor).
- **Consequence if left:** No aggregation/alerting; you must read logs and health by hand.

### D2 — Upstash (durable, global rate limits)

- **What:** Provision Upstash Redis and set both REST vars.
- **Why:** Moves rate limiting from per-instance in-memory to a durable global store — matters for the
  public `share` link and the unauthenticated `webhook`/`health` endpoints.
- **Where:** Vercel prod env. Code: `src/platform/http/rateLimit.ts`.
- **Env / setting:** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
- **Validate:** Limits persist across deploys/instances; no `"upstash rate limit unavailable"` warn log.
- **Safe fallback now:** In-memory sliding-window limiter bounds every limited surface per instance
  (fails **open + loudly** if Upstash is set but failing). Adequate for a controlled pilot.
- **Consequence if left:** Effective ceiling is (rule × instance count) and resets on deploy/cold
  start. **Do before any broad/adversarial exposure** — the public `share`/`webhook`/`health`
  endpoints are the enumeration/abuse surface.

### D3 — PDF render runtime (stored LPO / invoice PDFs)

- **What:** Provision a headless-Chromium render runtime (or a render microservice behind the same
  seam).
- **Why:** Turns the queued render+store step into a stored `financial_doc` PDF. Doubly gated: needs
  the runtime **and** Inngest (B1).
- **Where:** Code: `src/workers/functions/lpo-pdf.ts`, `src/workers/functions/invoice-billing.ts`.
- **Env / setting:** — (render runtime provisioning + Inngest; activation, no schema/logic change).
- **Validate:** An approved PO / issued invoice produces a stored PDF; `purchase_order.pdf_file_id` /
  the invoice PDF pointer are non-null.
- **Safe fallback now:** The bilingual/bidi Arabic-primary **HTML is composed** every time (bidi
  snapshot-tested); the demo path renders a real reviewable PDF via bundled Chromium. **Share the
  on-screen document; don't promise a downloadable stored PDF during the pilot.**
- **Consequence if left:** No stored PDF artifact; the document is on-screen only.

### D4 — OAuth providers (Google / Microsoft buttons)

- **What:** Configure Google/Microsoft providers in Supabase Auth and turn the buttons on.
- **Why:** Optional SSO convenience.
- **Where:** Supabase Auth provider config + Vercel prod env. Code: `src/platform/auth/oauth.ts`
  (`OAUTH_ENABLED === "true"`).
- **Env / setting:** `OAUTH_ENABLED=true` (plus provider config in Supabase).
- **Validate:** OAuth buttons appear and a provider sign-in completes.
- **Safe fallback now:** Email+password (≥10 chars), phone-OTP (field staff), and TOTP MFA all work;
  OAuth buttons are hidden.
- **Consequence if left:** No SSO buttons — the shipped auth methods fully cover the pilot.

### D5 — Document malware scanner (enable non-image document uploads)

- **What:** Wire a real scanner behind the scan seam.
- **Why:** Enables the document-upload path (beyond images) with malware scanning.
- **Where:** Code: `src/platform/files/scan.ts` (`disabled` rejects every non-image upload in prod).
- **Env / setting:** `SCAN_PROVIDER=<real scanner>`.
- **Validate:** A test document upload passes scanning and stores; a known-bad sample is rejected.
- **Safe fallback now:** Image uploads work and are re-encoded + EXIF-stripped; the document-upload
  path is disabled-in-prod until a scanner exists.
- **Consequence if left:** No arbitrary document uploads (images only) — usually fine for the pilot.

### D6 — Second-provider backup + management-API token (live backup monitor)

- **What:** Provision the second-provider backup destination + a management-API token so
  `runbooks/backup-monitoring.md` becomes a live automated check.
- **Why:** Turns manual backup confirmation (A2) into a monitored, alertable check
  (`docs/S10-AUDIT-REGISTER.md` line 17 — the monitor code is a seam, not yet built).
- **Where:** Backup destination + Supabase management-API token in the secret store.
- **Env / setting:** — (backup destination + management-API token; names/locations only).
- **Validate:** The backup monitor reports fresh PITR + nightly backup + bucket replication + manifest.
- **Safe fallback now:** The owner confirms PITR + nightly backup manually (A2).
- **Consequence if left:** Backup health is a manual check, not an automated monitor.

### D7 — AI narration / onboarding provider (+ no-training contract terms)

- **What:** Wire a real narration provider behind `NarrationProvider` and secure no-training contract
  terms.
- **Why:** Optional natural-language wording layered over the deterministic digest.
- **Where:** Code: `src/platform/ai/adapter.ts`. (References `runbooks/ai-provisioning.md`, not yet
  written.)
- **Env / setting:** `AI_NARRATION_PROVIDER=<real provider>` + credentials (names only).
- **Validate:** Narration returns text constrained by the numbers-subset validator
  (`src/platform/ai/numbers-subset.ts`); onboarding enrichment rephrases prose only, never widens
  config.
- **Safe fallback now:** **The deterministic digest IS the shipped product** — complete, correct,
  bilingual, with no AI. AI onboarding runs as a deterministic grounded validator with a full manual
  fallback. No tenant free-text ever leaves the system (closed label+number payload only).
- **Consequence if left:** No AI wording layer — the deterministic path is the intended product.

### D8 — Messaging (email invites / notifications; later SMS/WhatsApp)

- **What:** Set the email transport so invites and notifications deliver by email.
- **Why:** Auto-delivers invite links + notification emails instead of manual hand-off.
- **Where:** Vercel prod env. Code: `src/platform/notifications/email.ts` (falls back to a debug
  logger sink and returns the invite token).
- **Env / setting:** `RESEND_API_KEY` (+ optional `EMAIL_FROM`; SMS `TWILIO_*` are later-phase).
- **Validate:** An invite email arrives; a notification with an `email` channel preference delivers.
- **Safe fallback now:** **In-app notifications work fully**; `inviteMember` still creates the invite
  row + token and surfaces the accept link (`<APP_URL>/invite/<token>`) in the Members UI for
  out-of-band hand-off. Fine for 1–2 orgs.
- **Consequence if left:** Invite links are handed over manually; no outbound email/SMS. No blocker
  for a small founder-onboarded pilot.

### D9 — Housekeeping

- **OP-4 name check** — trademark / domain / Arabic-connotation check for "IdaraWorks". *(No env; do
  before any public branding.)*
- **Delete 4 junk Vercel projects** left from early attempts: `idaraworks-bfs`, `idaraworks-bfsc`,
  `idaraworks-cd61`, `idaraworks-wfft`. *(Reduces deploy-target confusion; the live project is
  `idaraworks`.)*
- **Pilot cohort** — line up 1–2 arm's-length GCC industrial SMEs (paying from month 2 at go-live;
  Najolatech is the test bench, not PMF proof).

---

## What runs safely today with everything above left as-is

A **founder-onboarded, no-real-payment controlled pilot** operates fully with only **Tier A** complete
(and Tier A6 only where KSA/ID-document data applies). Live and governed today: the full
operational→money loop (Plan → Assign → Report → Supply → Measure → Approve → Bill → Improve on RLS,
in Arabic, on a phone), the deterministic morning digest + customer-update share surface,
cost/price-redaction walls, the subscription state machine + entitlements in their safe disabled-billing
mode, consent-gated dual-logged support impersonation, and self-service export. Everything in Tiers B–D
either degrades gracefully or defers work behind a documented seam — none of it takes the app down, and
**only `db` and `storage` can 503 `/api/health`.**

## References (source of truth)

- `docs/pilot/08-owner-action-checklist.md` — the prior consolidated list this document **supersedes**.
- `runbooks/credential-disabled-operations.md` — per-seam "what works / what's degraded / how to tell".
- `docs/pilot/05-operational-billing-readiness.md` — the D1 gate, VAT, metering, read-only states.
- `docs/pilot/06-launch-criteria-checklist.md` — the walkable launch-criteria ceremony + sign-off.
- `docs/MVP-READINESS-REPORT.md` — capability classification + pilot-ready verdict.
- Provisioning runbooks: `runbooks/inngest-provisioning.md`, `runbooks/sentry-provisioning.md`,
  `runbooks/restore-drill.md`, `runbooks/incident-response.md`, `runbooks/backup-monitoring.md`,
  `runbooks/secret-rotation.md`, `runbooks/break-glass.md`.
- `docs/pilot/00-pilot-org-setup.md` — the operator's end-to-end org-setup workflow.
