# Pilot Credential Matrix — Controlled Pilot

> **Audience:** the Owner/operator standing up the founder-onboarded, **no-real-payment** controlled
> pilot for IdaraWorks (`idaraworks.vercel.app`) with 1–2 arm's-length GCC industrial SMBs.
>
> **Purpose:** one exact, per-seam credential reference — is each external seam *required* for the
> controlled pilot, what the *disabled/manual fallback* is today, *where* to configure it, *how to
> prove* it works, and whether a *redeploy* is needed. This is the credential companion to the three
> operational runbooks; it does not restate them — it points into them:
> `runbooks/credential-disabled-operations.md` (per-seam behaviour + `/api/health` signals),
> `runbooks/inngest-provisioning.md`, `runbooks/sentry-provisioning.md`.
>
> **Secrets rule (non-negotiable):** this document names **env var identifiers and where to set
> them only**. It contains **no secret values**, and none may ever be pasted into the repo, logs,
> tickets, or chat. Every secret lives only in the platform secret store (Vercel env / Supabase /
> the provider dashboard). Rotation follows `runbooks/secret-rotation.md`.

---

## 0. Authoritative production baseline (what is real right now)

Grounding for every "active vs disabled" claim below. Do **not** describe a provider as active
unless its env var appears in the **SET** list.

- **Deployed + CI-green commit:** `97985e1`. **Hosted DB:** Supabase Seoul, migrations
  `0000–0064` (next is `0065`). **Baseline orgs:** exactly `[Alpha Marine, TESTING]`.
- **Prod env vars SET** (the two hard dependencies + app identity — *always on, not disabled
  seams*): `APP_ENV=prod` · `NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_ANON_KEY` ·
  `DATABASE_URL` (Supavisor pooler, password-redacted) · `APP_DB_PASSWORD` ·
  `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY` / `STORAGE_S3_ENDPOINT` /
  `STORAGE_S3_REGION`.
- **Deliberately NOT deployed to prod runtime** (correct posture): `SUPABASE_SERVICE_ROLE_KEY`,
  `DIRECT_URL` — tooling/migration/CI-only credentials, kept out of the runtime env.
- **Prod env vars NOT SET** ⇒ **every seam in the matrix below is DISABLED/degraded today**, by
  design. This is the *intended* pilot posture, not a fault — the deterministic fallbacks are the
  product for S0–S11 (`runbooks/credential-disabled-operations.md`).

**The one rule that governs the provider seams:** every "are we in production?" decision routes
through `isProd()` (`src/platform/env.ts`), true **only** when `APP_ENV=prod`. Under `isProd()` the
three provider seams (billing, e-invoice, AI narration) select their **disabled** adapter; Inngest
and Sentry no-op when their keys are absent. (S10 fixed the earlier guard that compared a string
never set anywhere and silently served the *fake* provider in prod — if you ever see a *fake*
provider active in prod, treat it as a Sev-2.)

**Health is ground truth:** `GET https://idaraworks.vercel.app/api/health`. Only `db` and `storage`
gate the 200/503 status — both are owner-provisioned and **always on** (they are the SET creds
above, not disabled seams). `queue` is informational; `inngest` is a **configuration status**, never
a gate — `status:"unconfigured"` is the *expected default*, not an unexplained failure.
`pnpm smoke:prod` (`tooling/scripts/smoke-prod.ts`, 18/18) asserts the whole surface, including that
every disabled seam reports its state explicitly. Pin the deployed commit with
`EXPECTED_COMMIT=97985e1 pnpm smoke:prod`.

---

## 1. The matrix

| # | Seam | Prod state today (grounded) | Required for the controlled pilot? | Fallback that exists today | Configure at (Vercel env var + dashboard step) | Validate | Redeploy? |
|---|------|-----------------------------|:----------------------------------:|----------------------------|------------------------------------------------|----------|:---------:|
| 1 | **Inngest** (worker fleet + 5 crons) | `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` **not set** → `/api/inngest` 503 `inngest_unconfigured`; `/api/health` `inngest.status="unconfigured"`; all crons + workers dormant; events queue durably to outbox | **No** (recommended) — on-demand substitute; doc 08 §A recommends provisioning for live nightly automation | Every sync write commits in-request; outbox accumulates at-least-once; dormant crons run **on-demand** (`relayOutbox()`, `sweepLifecycle()`, `dispatchNightly()`, `pruneRetention()`) | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` (Vercel prod). Inngest dashboard: create app **`idaraworks`**, **Sync app** → `/api/inngest`. `runbooks/inngest-provisioning.md` | 4-step verify in runbook: `/api/health`→`configured`; signed `demo-heartbeat` runs, forged org pair FAILS; unsigned POST rejected 401/400; `queue.unprocessed`→0 | **Yes** |
| 2 | **Production PDF runtime** (LPO/invoice render+store) | No render runtime wired → HTML built, **no stored PDF**; also gated on Inngest (render runs in a worker) | **No** | Bilingual/bidi Arabic HTML composed every time; a real reviewable PDF is produced by the demo path via Playwright's bundled Chromium | No single env var — **activate a render runtime** (bundled Chromium or a render microservice) behind the seam in `src/workers/functions/{lpo-pdf,invoice-billing}.ts`; **also needs Inngest (#1)** | Worker log stops saying "PDF render+store gated…"; `purchase_order.pdf_file_id` / invoice PDF pointer become non-null; a `financial_doc` file is stored | **Yes** (worker deploy) |
| 3 | **Sentry** (error + worker-failure capture) | `SENTRY_DSN` **not set** → every capture call is a clean no-op; client bundle loads nothing | **No** | Structured pino JSON logs tagged `request_id`/`org_id`/`user_id` in Vercel → Logs; `/api/health` + `/api/ready` are the liveness surfaces | `SENTRY_DSN` (+ optional `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_APP_ENV=prod`) in Vercel prod. Sentry dashboard: create Next.js project. `runbooks/sentry-provisioning.md` | `pnpm tsx tooling/scripts/seed-sentry-error.ts` → event in Sentry with `request_id`/`path`/`method`, **no PII**; prod 5xx auto-creates an issue via `onRequestError` | **Yes** (`NEXT_PUBLIC_*` inlined at build) |
| 4 | **Upstash / Redis** (durable rate limits) | `UPSTASH_REDIS_REST_URL` / `_TOKEN` **not set** → in-memory sliding-window limiter | **No** (must-have before any adversarial exposure) | All rate-limited surfaces bounded per-instance (login, signup, otp_send, invite, health, share, webhook); on Upstash failure it fails **open** to in-memory, loudly | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (Vercel prod). Upstash dashboard: create Redis DB | No `/api/health` signal; verify limits persist across instances/deploys and the `"upstash rate limit unavailable"` warn is absent | **Yes** |
| 5 | **Email / messaging** (Resend) | `RESEND_API_KEY` **not set** → `sendEmail()` is a dev/CI logger sink, returns `{delivered:false}`; no email sent | **No** | Invite row + token still created; operator hands the accept link out-of-band. **In-app notifications fully work**; SMS/push are later-phase | `RESEND_API_KEY` (+ optional `EMAIL_FROM`) in Vercel prod. Resend dashboard: API key + verified sending domain | Send an invite → recipient receives the email; `sendEmail` returns `{delivered:true}` | **Yes** |
| 6 | **OAuth providers** (Google/Microsoft) | `OAUTH_ENABLED` **not set** → OAuth buttons hidden; sign-in action refuses | **No** | Email+password, phone-OTP, and TOTP MFA all work today | `OAUTH_ENABLED=true` (Vercel prod). Supabase dashboard → Authentication → Providers: configure Google/Microsoft (client id/secret live in **Supabase**, not app env) | Buttons render on sign-in; `oauthEnabled()` true; the OAuth sign-in action completes a round-trip | **Yes** (for the env var) |
| 7 | **Malware scanner** (document uploads) | `SCAN_PROVIDER` **not set** → `disabledScanner` in prod REJECTS every document; doc-upload path disabled | **No** | **Images-only** uploads accepted (re-encoded + EXIF-stripped, which neutralises image-borne payloads); no document path is exposed | `SCAN_PROVIDER=<name>` (Vercel prod) once a real scanner (ClamAV sidecar / cloud AV) exists; provider creds → secret store | `getActiveScanner()` resolves to the named provider; a known-bad (EICAR) test file is rejected; images still pass | **Yes** |
| 8 | **AI narration** (digest wording layer) | `AI_NARRATION_PROVIDER` **not set** → `disabledNarrationProvider` in prod; `text:null`, `status:"disabled"` | **No** | **The deterministic bilingual digest IS the product**; AI onboarding is a Layer-A `ConfigProposal` with a full manual fallback | `AI_NARRATION_PROVIDER=<name>` (Vercel prod); provider API creds → secret store (`runbooks/ai-provisioning.md`, not yet written) | `getNarrationProvider().enabled===true` in prod; narration text appears over the digest; `src/platform/ai/numbers-subset.ts` still constrains output to payload numbers | **Yes** |
| 9 | **Payment provider** (platform billing) | `BILLING_PROVIDER` **not set** → `disabledBillingProvider` via `isProd()`; checkout/portal throw; `verifySignature()` → `false` (webhook accepts nothing) | **No — keep DISABLED.** D1-gated; a no-real-payment pilot must not activate it | Full subscription state machine + entitlement gating run governed with **no real money**; subscription page shows "commercial activation unavailable" | **Do not set for this pilot.** Enable = D1 owner action only: real adapter + `BILLING_PROVIDER` + signing secret/API creds + per-currency price IDs → secret store | **Pilot check = still DISABLED:** `getBillingProvider().enabled===false`; subscription page hides Buy; `POST /api/billing/webhook` rejected (doc 05 §7) | n/a (do not enable) |
| 10 | **E-invoicing** (ZATCA/gov submission) | `EINVOICE_PROVIDER` **not set** → `disabledProvider` via `isProd()`; gated no-op, no `externalId`/`clearedAt`/QR | **No — keep DISABLED.** D4-gated; no government submission in the pilot | Full invoicing lifecycle (issue, credit-note, AR, payments) is independent of clearance; invoices are valid without a clearance id | **Do not set for this pilot.** Enable = D4 owner action only: certified partner adapter + `EINVOICE_PROVIDER` + partner creds → secret store | **Pilot check = still DISABLED:** `getEInvoiceProvider().enabled===false` in prod (S10 prod-demo prints `einvoice=<name>`) | n/a (do not enable) |

**Redeploy rule (applies to every row):** Vercel env changes take effect **only after a new
deployment** (`vercel deploy --prod --yes`). Server-side `process.env` reads are snapshotted per
deployment; `NEXT_PUBLIC_*` (Sentry client DSN, `NEXT_PUBLIC_APP_ENV`) are **inlined at build time**
and therefore require a fresh build. Configuring a provider in a **dashboard** (Supabase OAuth,
Inngest app sync, Sentry project, Upstash DB, Resend domain) does not by itself need a Vercel
redeploy — but the paired **Vercel env var** does.

---

## 2. Per-seam detail

Each subsection restates only the pilot-relevant credential facts; the full behavioural contract
(what still works / what's degraded / the `/api/health` signal) lives in
`runbooks/credential-disabled-operations.md` at the referenced section number.

### 2.1 Inngest — worker fleet + 5 crons (§1 of the disabled-ops runbook)

- **State today (grounded):** neither `INNGEST_EVENT_KEY` nor `INNGEST_SIGNING_KEY` is in the prod
  SET list, so `/api/inngest` returns `503 {status:"inngest_unconfigured"}`, `/api/health` reports
  `checks.inngest.status="unconfigured"`, and the **entire background fleet is dormant** (24
  functions + 5 crons: `outbox-relay`, `outbox-retention`, `exception-nightly-dispatch`,
  `subscription-lifecycle`, `retention-prune`).
- **Required for the pilot? No (recommended).** Every synchronous, user-facing write commits fully
  in-request and never depends on a worker to be correct; domain events are written **inside the
  committing transaction** to `public.domain_event` and accumulate durably (at-least-once by
  design). The dormant crons are plain, directly-invocable functions — run them **on-demand** as the
  pilot substitute (`relayOutbox()`, `checkDeadLetters()`, `purgeProcessedEvents()`,
  `sweepLifecycle(Date.now())`, `dispatchNightly(...)`, `pruneRetention()`; see the table in the
  disabled-ops runbook §1 and `runbooks/queue-worker-recovery.md`). **Note:** `docs/pilot/08-owner-action-checklist.md`
  §A lists Inngest keys as a pre-pilot item so the nightly automation runs live — and doc 05 §6.2
  notes that keeping the **lifecycle** cron dormant is actually *desirable* for a no-payment pilot
  (so trials can't auto-expire an org mid-pilot). Recommended, not blocking.
- **Configure:** `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` in Vercel prod; Inngest dashboard →
  create app **`idaraworks`** (must match the client id in `src/platform/events/inngest.ts`) →
  **Sync app** to `https://idaraworks.vercel.app/api/inngest`. **Never set `INNGEST_DEV=1` in
  production** — it would accept unsigned invocations (the signature is the trust boundary). Full
  steps: `runbooks/inngest-provisioning.md`.
- **Validate (all four must pass):** `/api/health` flips to `configured` and `/api/inngest` stops
  returning `inngest_unconfigured`; a signed `demo-heartbeat` invocation with a real org/actor pair
  **succeeds** while a forged pair **fails** (`OrgVerificationError` — the control working); the
  `outbox-relay` schedule runs green and `checks.queue.unprocessed` drains to 0; an unsigned
  `POST /api/inngest` is rejected (401/400). `pnpm smoke:prod` asserts `health inngest explicit`.
- **Redeploy:** **Yes** — env changes need `vercel deploy --prod --yes` before the sync.

### 2.2 Production PDF runtime (§2)

- **State today (grounded):** the LPO/invoice **HTML templates** build in-app on every PO approval /
  invoice issue, but the **render (HTML→PDF headless Chromium) + store (`financial_doc`)** step
  no-ops with a log line. It is **doubly gated** — it needs both a render runtime **and** Inngest
  (§2.1), since the render runs inside a worker.
- **Required for the pilot? No.** The bilingual/bidi Arabic-primary HTML is the substantive v1
  deliverable and is bidi-snapshot-tested; the demo path renders a real, human-reviewable Arabic PDF
  via Playwright's bundled Chromium, proving the template. **Operationally: share the on-screen
  document; do not promise a downloadable stored PDF during the pilot.**
- **Configure:** no dedicated env var — this is an **activation** (no schema/logic change): provision
  a render runtime (bundled Chromium or a render microservice behind the same seam in
  `src/workers/functions/{lpo-pdf,invoice-billing}.ts`) **and** Inngest (§2.1).
- **Validate:** the worker log stops emitting "…PDF render+store gated on render runtime + Inngest…"
  and returns a stored artifact; `purchase_order.pdf_file_id` / the invoice PDF pointer become
  non-null; the `financial_doc` file is retrievable via the files pipeline. No direct `/api/health`
  signal — inferred from Inngest status + the worker log line.
- **Redeploy:** **Yes** (worker deployment) — plus Inngest must be live.

### 2.3 Sentry (§6)

- **State today (grounded):** `SENTRY_DSN` is not in the prod SET list, so every function in
  `src/platform/observability/sentry.ts` is a clean no-op (runtime-only integration; no build plugin,
  so the Vercel build pipeline is identical with or without it).
- **Required for the pilot? No.** All observability you actually need is present: structured pino
  JSON logs, every request-scoped line tagged `request_id`/`org_id`/`user_id`, readable in
  Vercel → Project → Logs filtered by the `request_id` a user reports (every response echoes
  `x-request-id`; the error page shows the digest). `/api/health` and `/api/ready` are the liveness
  surfaces. **Caveat:** with Sentry off, the dead-letter page alert is silent — during the pilot you
  must **watch `/api/health` `checks.queue.dead_lettered` yourself** (smoke:prod / any uptime monitor
  on `/api/health` covers this).
- **Configure:** `SENTRY_DSN` (server+edge) in Vercel prod; optionally `NEXT_PUBLIC_SENTRY_DSN`
  (browser) and `NEXT_PUBLIC_APP_ENV=prod` (client env tag). Sentry dashboard → create Next.js
  project `idaraworks`, copy the DSN (Settings → Client Keys). Full steps:
  `runbooks/sentry-provisioning.md`. The `beforeSend`/`scrubEvent` PII scrub ships identifiers-only
  regardless.
- **Validate:** with the DSN in `.env.local`, run `pnpm tsx tooling/scripts/seed-sentry-error.ts`;
  the printed `request_id` appears on the Sentry event tagged `path`/`method`, with **no PII** (no
  cookies, body, or headers beyond `x-request-id`). In prod, any real 5xx creates an issue via
  `onRequestError` (`instrumentation.ts`). No `/api/health` signal — Sentry is a reporting sink, not
  a dependency.
- **Redeploy:** **Yes** — and because `NEXT_PUBLIC_*` is inlined at build time, the CSP `connect-src`
  auto-extends to the DSN's ingest origin only on a fresh build.

### 2.4 Upstash / Redis — rate limiting (§7)

- **State today (grounded):** neither `UPSTASH_REDIS_REST_URL` nor `UPSTASH_REDIS_REST_TOKEN` is set,
  so `rateLimit()` uses an **in-memory sliding-window** limiter. If Upstash is later configured but a
  call fails, it fails **open** to in-memory, loudly (`"upstash rate limit unavailable"`) —
  availability over lockout.
- **Required for the pilot? No — but must-have before any adversarial exposure.** Every rate-limited
  surface is still bounded within a single serverless instance (`login`, `signup`, `otp_send`,
  `invite_send`/`invite_accept`, `health`, `share`, `webhook`). The limitation: limits are
  **per-instance, not global**, and **reset on every deploy / cold start**; the effective ceiling on
  Vercel's concurrent instances is (rule × instance count). Adequate for a controlled pilot; **must**
  be Upstash-backed before the public `share` link or the unauthenticated `webhook`/`health`
  endpoints face adversarial traffic.
- **Configure:** `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` in Vercel prod; Upstash
  dashboard → create a Redis database. No code change — `rateLimit()` picks up the REST store
  automatically.
- **Validate:** no `/api/health` signal; confirm limits now persist across instances and survive a
  deploy, and that the `"upstash rate limit unavailable"` warn log is **absent** (it only appears
  when Upstash is configured *and* failing).
- **Redeploy:** **Yes.**

### 2.5 Email / messaging — Resend (§8)

- **State today (grounded):** `RESEND_API_KEY` is not set, so `sendEmail()` is a dev/CI logger sink
  (`logger.debug`, returns `{delivered:false}`). The `EMAIL_FROM` default is a placeholder sender.
- **Required for the pilot? No.** The user-facing consequence is **invites**: `inviteMember` still
  creates the invite row + token, but no email is sent. **Pilot workaround:** the function returns
  the invite `token`; the operator hands the accept link (`<APP_URL>/invite/<token>`) to the invitee
  out-of-band (it is also in the debug log). Invite acceptance itself works fully. **In-app
  notifications work fully** (persisted in the committing transaction; read via
  `listMyNotifications`). SMS (Twilio) and push transports are later-phase — auth is
  email+password / OTP / TOTP via Supabase and does not need a Twilio credential.
- **Configure:** `RESEND_API_KEY` (+ optional `EMAIL_FROM`) in Vercel prod; Resend dashboard → API
  key + a verified sending domain.
- **Validate:** send an invite → the recipient receives the email; `sendEmail` returns
  `{delivered:true}`. No `/api/health` signal (messaging is not a health dependency).
- **Redeploy:** **Yes.**

### 2.6 OAuth providers (§ owner-action C; `src/platform/auth/oauth.ts`)

- **State today (grounded):** `OAUTH_ENABLED` is not set, so `oauthEnabled()` is false — the OAuth
  buttons are hidden and the OAuth sign-in action refuses. This is the correct default.
- **Required for the pilot? No.** Email+password, phone-OTP, and TOTP MFA are all live and cover
  pilot sign-in.
- **Configure (two parts):** (a) `OAUTH_ENABLED=true` in Vercel prod; (b) configure the provider in
  the **Supabase** dashboard → Authentication → Providers (Google/Microsoft) — the client id/secret
  live in Supabase, **not** in the app env. Both parts are required before a button will work.
- **Validate:** the OAuth button(s) render on the sign-in page, `oauthEnabled()` returns true, and a
  full OAuth round-trip completes to an authenticated session.
- **Redeploy:** **Yes** for the `OAUTH_ENABLED` env var; the Supabase-side provider config alone does
  not require a Vercel redeploy.

### 2.7 Malware scanner — document uploads (`src/platform/files/scan.ts`)

- **State today (grounded):** `SCAN_PROVIDER` is not set, so in prod `getActiveScanner()` resolves to
  `disabledScanner`, which **rejects every document** — there is no live document-upload path.
- **Required for the pilot? No.** The MVP accepts **images only**, and every image is re-encoded +
  EXIF-stripped, which neutralises image-borne payloads — so there is nothing for a scanner to guard
  during the pilot. The document-upload path stays disabled-in-prod until a real scanner exists.
- **Configure:** `SCAN_PROVIDER=<name>` in Vercel prod once a real scanner (ClamAV sidecar or a cloud
  AV API behind `src/platform/http`) is deployed; the scanner's own credentials go to the secret
  store. The adapter slots the real provider in behind the same `DocumentScanner` interface.
- **Validate:** `getActiveScanner()` resolves to the named provider; a known-bad (EICAR) test file is
  rejected with `DocumentRejectedError`; a legitimate image still passes; the document-upload path is
  now reachable.
- **Redeploy:** **Yes.**

### 2.8 AI narration / onboarding (§5; `src/platform/ai/adapter.ts`)

- **State today (grounded):** `AI_NARRATION_PROVIDER` is not set, so in prod `getNarrationProvider()`
  returns `disabledNarrationProvider` (`text:null`, `status:"disabled"`, logs the gated skip).
- **Required for the pilot? No — read this seam differently.** The **deterministic digest (Layer A)**
  is computed from tenant data with no AI at all; it is complete, correct, and bilingual on its own —
  **the deterministic output IS the shipped product**, and AI is an optional wording layer on top.
  AI onboarding (S8) is a Layer-A `ConfigProposal` pipeline with a full **manual fallback** — an
  operator can configure an org entirely by hand. No tenant free-text is ever sent anywhere (even a
  real provider only receives a closed payload of system-composed labels + numbers), so there is no
  prompt-injection surface.
- **Configure:** `AI_NARRATION_PROVIDER=<name>` in Vercel prod; provider API credentials + a
  **no-training contract term** → secret store (code references `runbooks/ai-provisioning.md`, not
  yet written).
- **Validate:** `getNarrationProvider().enabled===true` in prod (the S10 prod-demo prints the
  provider); narration text appears layered over the digest; `src/platform/ai/numbers-subset.ts`
  still constrains the provider's output to numbers present in the payload.
- **Redeploy:** **Yes.**

### 2.9 Payment provider — platform billing (§4; **KEEP DISABLED**)

- **State today (grounded):** `BILLING_PROVIDER` is not set, so via `isProd()` prod serves
  `disabledBillingProvider`. `createCheckoutSession` / `createPortalSession` / `cancelSubscription` /
  `parseEvent` all refuse with `BillingProviderDisabledError`, and **`verifySignature()` returns
  `false` for every inbound webhook** — `/api/billing/webhook` accepts nothing (still rate-limited
  per-IP). **No card data is ever touched or stored.**
- **Required for the pilot? No — and it must remain DISABLED.** This is a **no-real-payment** pilot;
  activating a real processor is **D1-gated** (incorporation + merchant of record) and is explicitly
  out of scope. The entire subscription state machine + entitlement gating run governed without any
  provider; for the pilot, subscription state is operator-driven, not customer-checkout-driven, and
  pilot orgs sit in `internal_pilot`/`trialing` (`provider=null`).
- **Do NOT configure for this pilot.** (Enabling later is a pure activation — real adapter behind the
  `BillingProvider` interface + `BILLING_PROVIDER` + signing secret/API creds + per-currency price
  IDs → secret store — but that is the D1 owner decision, not a pilot step. Never set
  `BILLING_PROVIDER=fake` in prod.)
- **Pilot validation = prove it is DISABLED** (doc 05 §7): `getBillingProvider().enabled===false` in
  prod; the subscription page (`/o/{orgId}/settings/subscription`) shows "commercial activation
  unavailable" with no Buy/checkout/portal button; `POST /api/billing/webhook` with any body is
  rejected. If you ever see a live Buy button in prod, **stop** — the `isProd()` guard is wrong.
- **Redeploy:** n/a — do not enable.

### 2.10 E-invoicing — ZATCA / government submission (§3; **KEEP DISABLED**)

- **State today (grounded):** `EINVOICE_PROVIDER` is not set, so via `isProd()` prod serves the
  **disabled** provider; `getEInvoiceProvider().enabled===false`. Clearance is a recorded no-op — no
  `externalId`, no `clearedAt`, no clearance QR.
- **Required for the pilot? No — and it must remain DISABLED.** The full invoicing lifecycle (issue,
  credit-note, AR aging, payments) is completely independent of clearance; invoices are valid
  business documents without a clearance id. Real government submission is **D4-gated** (a certified
  GCC/ZATCA partner + credentials) and out of scope. **Do not represent pilot invoices as
  government-cleared.**
- **Do NOT configure for this pilot.** (Enabling later: a real provider adapter behind the
  `EInvoiceProvider` interface + partner credentials → secret store + `EINVOICE_PROVIDER` — the
  D-decision that authorizes a real tax-authority integration; `runbooks/einvoice-provisioning.md`
  does not yet exist. Never set `EINVOICE_PROVIDER=fake` in prod.)
- **Pilot validation = prove it is DISABLED:** `getEInvoiceProvider().enabled===false` in prod (the
  S10 prod-demo prints `einvoice=<name>` and notes the prod default is DISABLED). No `/api/health`
  signal.
- **Redeploy:** n/a — do not enable.

---

## 3. Pilot posture summary

- **Nothing in this matrix is a blocker to starting the controlled, no-real-payment pilot.** Every
  seam ships disabled by design with a working deterministic or manual fallback, and the two hard
  dependencies it *does* rely on — **`db`** (`DATABASE_URL` + `APP_DB_PASSWORD`) and **`storage`**
  (`STORAGE_S3_*`) — are already SET and always-on (they are the only two that 503 `/api/health`).
- **Two seams must stay OFF:** payment (#9, D1) and e-invoicing (#10, D4). The pilot validates that
  they are *disabled*, never that they work.
- **Recommended-but-optional owner provisioning** for a smoother pilot (all non-blocking): Inngest
  (live nightly automation), Sentry (alerting), Upstash (durable limits), Resend (email invites).
  These map to `docs/pilot/08-owner-action-checklist.md` §A/§C.
- **Every enable step needs a Vercel redeploy** to take effect (`vercel deploy --prod --yes`);
  dashboard-side configuration (Supabase/Inngest/Sentry/Upstash/Resend) is paired with, not a
  substitute for, the Vercel env var.
- **After any change, re-run** `EXPECTED_COMMIT=<new sha> pnpm smoke:prod` and re-read
  `GET /api/health` to confirm the new state is reported explicitly.

## 4. Cross-references

- `runbooks/credential-disabled-operations.md` — the authoritative per-seam behaviour contract
  (what works / what's degraded / the exact `/api/health` signal), §1–§8 map to rows 1,2,7,9,10,3,4,8
  of the matrix above.
- `runbooks/inngest-provisioning.md` — full Inngest provisioning + the four-step verify (row 1/2).
- `runbooks/sentry-provisioning.md` — full Sentry provisioning + the seeded-error verify (row 3).
- `runbooks/queue-worker-recovery.md`, `runbooks/dead-letter-recovery.md` — running the dormant fleet
  on-demand while Inngest is unconfigured.
- `docs/pilot/05-operational-billing-readiness.md` — the payment/e-invoice/VAT disabled-gate detail
  and the pre-pilot verification checklist (rows 9, 10).
- `docs/pilot/08-owner-action-checklist.md` — the consolidated owner credential/legal actions.
- `docs/MVP-READINESS-REPORT.md` — capability classification (credential-gated vs D1-gated) and the
  pilot-ready verdict.
- `.env.example` — the annotated env var catalogue (owner + phase per var).
- `tooling/scripts/smoke-prod.ts` (`pnpm smoke:prod`) — read-only assertion that every disabled seam
  reports its state explicitly.
