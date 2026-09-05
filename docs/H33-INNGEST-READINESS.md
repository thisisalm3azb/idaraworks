# H33 — Inngest and background jobs: diagnosis, replay preview, owner actions

**Prepares and supports H30 owner condition O-6** (`docs/H30-OWNER-CHECKLIST.md:28` — "Provision Inngest — `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY`"). **O-6 remains open:** it needs an external account and two credential values that only the owner can add to Vercel (§4, §8); a readiness document cannot close it.
**Date:** 2026-09-05. **Branch:** `verify/h33`. **Audience:** the owner, read once; the engineer who acts on §5.

**How this was produced.** Everything below was read from the repository on this branch and from the production facts recorded in Part A of `docs/H33-TRUTH-MAP.md`. No database connection was opened, nothing was run against production, no environment file was read, and nothing was sent anywhere. Official Inngest documentation was fetched and is cited by URL wherever it is relied on. Anything that could not be checked from here is marked **UNVERIFIED — owner action**. Nothing in this document is legal advice; clauses that need a professional are marked **LEGAL REVIEW**.

---

## The short version

- Eleven background jobs from one organisation have sat untouched since 2026-09-01. Not one has been attempted (`attempts = 0`). The reason is simple: the thing that collects jobs is itself a scheduled Inngest function, and Inngest has never been connected to production. Nothing is broken in the code; the switch has not been turned on.
- When the switch is turned on, the eleven jobs drain automatically within about two minutes. Four of them trigger nothing at all. The other seven trigger ten small function runs. **None can send email.** **None writes a file to storage.** **None produces a PDF** — the PDF step is a separate, still-unbuilt seam, and the H30 checklist's wording on this point needs correcting (§5, item E). The only records that can change are a cached cost total for one job (recomputed from source, not added to) and, only if one of the approvals was a payment approval, an invoice's paid/unpaid status (also recomputed from source).
- Nothing about the eleven jobs touches stock. Provisioning Inngest does not perform, and cannot perform, the PO-002 repair (O-11). That decision stays separate and untouched.
- Turning Inngest on also starts eleven scheduled jobs (hourly and nightly sweeps). Those are the bigger operational change and are listed in §8 step 7 so the owner knows what will appear the next morning.
- Recommendation: connect Inngest through the Vercel integration, redeploy, verify the four checks, and **let the relay drain the queue on its own. Do not replay anything by hand.**

---

## 1. The eleven stalled events, one by one

Source facts (Part A, read from production): `public.domain_event` holds 11 rows, all unprocessed, all `attempts = 0`, all from one organisation, all dated 2026-09-01. Whether that organisation is Najolatech, and whether the two receipt events are PO-002's GRN-001 and GRN-002, was not read — **UNVERIFIED**. The classification below does not depend on it.

A consumer is a function registered in `src/workers/index.ts` whose trigger is that event name. Which function listens to which event was established by reading every file in `src/workers/functions/` (grep of the event constants: only the bindings listed here exist).

| # | Event | Rows | Consumer function(s) | What it would do | Database writes | Storage upload | Email |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `approval/submitted` | 3 | **none** — no function binds `APPROVAL_SUBMITTED` | Inngest records the event in its event history and triggers nothing. Informational. | none | no | no |
| 2 | `approval/decided` | 3 | **two**: `payment-reconcile-on-decision` (`src/workers/functions/invoice-billing.ts:41-48`) and `exception-clear-on-approval-decided` (`src/workers/functions/exception-engine.ts:78-84`) | *Reconcile:* if the approval's `subjectType` is not `"payment"`, returns `{ skipped: true }` and does nothing (line 44). If it is a payment, `reconcileFromPayment` (`src/modules/payments/service.ts:271-278`) looks up the payment's invoice and calls `reconcileInvoiceStatus` (`src/modules/invoices/service.ts:792-815`), which sets the invoice's status to `paid`, `partially_paid` or `issued` from the sum of its recorded/confirmed payments and credit notes. *Clear:* `clearApprovalStuck` (`src/modules/exceptions/service.ts:213-215`) marks any open `approval_stuck` exception for that approval as resolved. | `public.invoice.status`, `updated_at` (payment case only); `public.exception.resolved_at`, `resolution` (only if an open `approval_stuck` row exists — see note A) | no | no |
| 3 | `goods_receipt/recorded` | 2 | `cost-rollup-on-goods-receipt` (`src/workers/functions/cost-rollup.ts:69-76`) | Reads the purchase order's `job_id` (lines 24-32). If the PO is linked to a job, calls `refreshRollup` → `app.refresh_cost_rollup` (`supabase/migrations/0040_s5_cost_rollup.sql`), which recomputes the job's material, labour, PO-receipt and expense cost from source rows and upserts the cached totals. If the PO has no job, writes nothing. | `public.cost_rollup` and `public.cost_rollup_labour` — one row per (org, job), `insert … on conflict (org_id, job_id) do update` (0040 lines 156-167 for `cost_rollup`, which also stamps `source_version = source_version + 1`; lines 169-175 for `cost_rollup_labour`) | no | no |
| 4 | `job/created` | 1 | **none** — no function binds `JOB_CREATED` | Informational. | none | no | no |
| 5 | `purchase_order/approved` | 1 | `lpo-pdf-renderer` (`src/workers/functions/lpo-pdf.ts:35-38`) | `buildLpoForPo` builds the bilingual LPO **HTML in memory** from the PO, its lines, supplier, job, org and document branding (`src/modules/supply/service.ts:1187-1245`), writes one log line — "LPO HTML built — PDF render+store gated on render runtime + Inngest (owner action)" (lpo-pdf.ts:28-31) — and returns `{ outcome: "built", htmlChars }`. It does **not** render a PDF, does **not** upload anything, does **not** set `purchase_order.pdf_file_id`. The only storage access is a **read** of the org logo, if one exists (`src/modules/branding/service.ts:356`). | none | **no** (read of logo only) | no |
| 6 | `quote/accepted` | 1 | `quote-pdf-renderer` (`src/workers/functions/quote-pdf.ts:30-33`) | Identical pattern: builds quote HTML in memory (`src/modules/quotes/service.ts:612-667`), logs "quote HTML built — PDF render+store gated…", returns. | none | **no** (read of logo only) | no |

**Note A (exception clear).** An open `approval_stuck` exception can only be created by the `exception-signal-materializer` consumer, which — like everything else here — has never run in production. The clear is therefore expected to update zero rows. It is a guarded update (`where … resolved_at is null`, `src/modules/exceptions/service.ts:164-175`), so it is safe either way.

**Note B (which subject types).** The three `approval/decided` payloads were not read, so their `subjectType` values are **UNVERIFIED**. The approvable subject types are the closed list `APPROVABLE_TYPES` in `src/platform/registries.ts:40-59`: material_request, expense, quote_send, purchase_order, payment, task_completion, asset_disposal, leave_request, overtime_request, expense_claim, pay_run, journal_entry, scenario_apply, document_step, crm_discount, ai_action (sixteen; nothing else can be routed for approval). Only `"payment"` causes a write — `payment-reconcile-on-decision` returns `{ skipped: true }` for every other value (`src/workers/functions/invoice-billing.ts:44`). A payment is routed for approval only if the organisation installed a payment-approval rule (`src/modules/payments/service.ts:117-131`).

**Note C (stock).** The cost-rollup reads `goods_receipt_line` and `purchase_order_line` and writes cost caches only. It does not create warehouses, units, stock movements or balances. Replaying the two receipt events neither performs nor pre-empts the PO-002 repair.

**Note D (email — why "none" is certain).** The only code that sends email is `sendEmail` in `src/platform/notifications/email.ts`, which returns `{ delivered: false }` without contacting anyone when `RESEND_API_KEY` is unset (lines 12-19), and production has no Resend key (Part A). Independently of that, none of the six consumers above imports or calls it; the modules they reach (`costing`, `payments`, `invoices`, `exceptions`, `supply`, `quotes`, `branding`) create in-app notification rows at most, never email.

---

## 2. Why no worker ever processed them

Three facts, each from the code:

1. **The collector is itself an Inngest cron.** `src/workers/functions/outbox-relay.ts:14-26`:
   ```ts
   export const outboxRelay = inngest.createFunction(
     { id: "outbox-relay", retries: 1, triggers: [cron("* * * * *")] },
     async ({ runId }) => { … relayOutbox(…) … checkDeadLetters(…) … },
   );
   ```
   Every minute, *when Inngest Cloud invokes it*, it claims a batch (`src/platform/events/relay.ts:64-67` → `app.claim_domain_events`), sends each event to Inngest keyed by the row id (`relay.ts:52-54, 73`) and marks it processed (`relay.ts:74`). Inngest's documentation is explicit that scheduled functions only run once served and synced: "You'll need to serve these functions in your Inngest API for the functions to be available to Inngest" (https://www.inngest.com/docs/guides/scheduled-functions).

2. **Production has never been synced, because the serve route refuses until both keys exist.** `src/app/api/inngest/route.ts:27,40-44`:
   ```ts
   const deployed = process.env.APP_ENV === "prod" || process.env.APP_ENV === "preview";
   const guard = deployed && !inngestStatus().configured;
   export const GET  = guard ? unconfigured : handlers.GET;
   export const POST = guard ? unconfigured : handlers.POST;
   export const PUT  = guard ? unconfigured : handlers.PUT;
   ```
   `inngestStatus()` (`src/platform/observability/health.ts:89-99`) is `configured` only when **both** `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` are set. Production answers `503 { status: "inngest_unconfigured" }` (Part A), which proves the guard is active and `APP_ENV` is a deployed value.

3. **`attempts = 0` means the relay never even tried.** `app.claim_domain_events` increments `attempts` at claim time, before any send (`supabase/migrations/0014_events_outbox.sql:67-88`: `set attempts = e.attempts + 1, last_attempt_at = now()`). Had anyone run the relay by hand from a laptop without an event key, the SDK would have thrown — in cloud mode with no event key `inngest.send` fails with "Your event or events were not sent to Inngest. We couldn't find an event key" (`node_modules/inngest/components/Inngest.js:534-536`) — and the row would show `attempts = 1` with a `last_error`. Zero attempts, no error: nothing has ever called the claim function. This is consistent, not contradictory.

The queue looked healthy for 3.2 days because the health check only watched for dead letters, and a job that is never attempted can never exhaust its attempts. H30 (LB-4) added a separate staleness alarm (`health.ts:132-147`); the exact production state — 11 unprocessed, oldest 276,434 s — is pinned as a unit test in `tests/unit/queue-staleness-law.test.ts:24-29` and now alerts.

---

## 3. Audit of the integration as it exists in code

| Piece | File | What it does | Verdict |
| --- | --- | --- | --- |
| Serve endpoint | `src/app/api/inngest/route.ts` | `serve({ client: inngest, functions: workerFunctions })` from `inngest/next`; exports `GET`, `POST`, `PUT` (lines 16-25, 42-44). Wrapped in the explicit-503 guard above; when keys are present the SDK handlers run unchanged, signature enforcement included. | Matches the official App Router shape ("Inngest requires `GET`, `POST`, and `PUT` methods" — https://www.inngest.com/docs/learn/serving-inngest-functions). Guard never weakens verification. |
| Client | `src/platform/events/inngest.ts:213-216` | `new Inngest({ id: "idaraworks", eventKey: process.env.INNGEST_EVENT_KEY })`. The signing key is not passed in code; the SDK reads `INNGEST_SIGNING_KEY` from the environment, which is the documented way (https://www.inngest.com/docs/sdk/environment-variables). | Correct. One inaccuracy: the comment "undefined → dev mode" (line 215) overstates. Per the official doc, "If neither the environment variable nor config option are specified, the SDK defaults to cloud mode"; dev mode requires `INNGEST_DEV`. No production consequence (the route guard blocks first), but the comment should be corrected so nobody relies on it (§5, item B). |
| `INNGEST_DEV` | `.env.example:39`, `runbooks/inngest-provisioning.md:11-13` | Documented as forbidden in production. | Correct and important: the official doc confirms `INNGEST_DEV=1` forces dev mode in which "signature verification is disabled". Never set it in Vercel. |
| Worker registry | `src/workers/index.ts:82-111` | The serve route serves exactly `workerFunctions`. **28 functions**: 11 crons (`outbox-relay`, `outbox-retention`, `storage-reconcile`, `approval-stuck-evaluator`, `exception-nightly-dispatch`, `subscription-lifecycle`, `retention-prune`, `doc-obligation-reminders`, `crm-automation-sweep`, `idara-run-executor`, `idara-schedule-sweep`) and 17 event consumers (`image-derivatives`, `demo-heartbeat`, `lpo-pdf-renderer`, `quote-pdf-renderer`, six `cost-rollup-*`, `exception-signal-materializer`, `exception-clear-on-approval-decided`, `expense-anomaly-on-create`, `expense-anomaly-on-void`, `nightly-org-run`, `invoice-on-issued`, `payment-reconcile-on-decision`). `tests/unit/s10-worker-registration.test.ts` asserts only that `retentionPruneCron` and `subscriptionLifecycleCron` are in `workerFunctions` (lines 12-15) and that the registry holds no duplicate references (17-18); the other 26 functions have no import-but-not-register guard (§5, item I). | Correct in code. The runbooks are stale on the count: `inngest-provisioning.md:43-44` says "four registered functions"; `queue-worker-recovery.md:147` and `credential-disabled-operations.md:66` say 24. The Apps page after sync must show **28** (§5, item A). |
| Org re-verification | `src/workers/harness.ts:38-66, 79-125` | Every org-scoped consumer re-checks that `(orgId, actorUserId)` is a real membership row before touching data; failures are logged, captured, and rethrown so Inngest retries apply. Default `retries: 3` (`harness.ts:95`, `retries: opts.retries ?? 3`). | Correct. Note for §9: if an actor's membership row has been *deleted* since 2026-09-01, that consumer run fails with `OrgVerificationError` after retries — visible in the Inngest dashboard, not in the outbox (which is already marked processed). |
| Health probe | `src/platform/observability/health.ts` | `checks.inngest` = configured only with both keys (89-99). `checks.queue.stale` = work waiting more than 3,600 s (40, 146); `checks.queue.alert` = dead letter **or** stale (147). Never gates HTTP 200/503: the semantics are documented at `health.ts:5-14` ("`inngest` is a CONFIGURATION status, never a gate"; a queue alert "does NOT 503 the app") and at `src/app/api/health/route.ts:8-17` ("503 when a hard dependency (db, storage) is down"). | Correct; the alarm that was missing in H30 now exists and is tested (`tests/unit/queue-staleness-law.test.ts`, `tests/unit/observability.test.ts:142-155`). |
| Middleware | `src/middleware.ts:39-45` | The matcher excludes `api/health` and `api/ready` but not `api/inngest`, so `updateSession` runs on every Inngest request. It only refreshes Supabase auth cookies (`src/platform/tenancy/supabase.ts:32-53`) and returns `NextResponse.next()`; it never redirects or blocks. | Harmless: Inngest's signed POSTs pass through. Optional tidy-up (§5, item D). |
| Build tracing | `next.config.ts:105-108` | `outputFileTracingIncludes["/api/inngest/**"]` carries sharp's Linux libraries for the `image-derivatives` worker; `tooling/scripts/check-traced-payloads.ts` verifies the built `.nft.json`. | Not needed for the eleven events (none is `file/uploaded`) but needed for the fleet. Whether the current production build passes that check: **UNVERIFIED — engineer runs it after the next build**. |
| Relay send | `src/platform/events/relay.ts:52-54, 73` | `inngest.send({ name, data, id: domain_event.id })`. | Correct: the event id is Inngest's deduplication key (§4). |
| Dead-letter alarm | `relay.ts:92-116`, `src/platform/observability/sentry.ts:103` | ERROR log + `captureDeadLetter`, which is a no-op without `SENTRY_DSN`. | With Sentry unprovisioned (O-7), `/api/health` and Vercel logs are the only signal. Acceptable for the pilot; noted. |
| Smoke | `tooling/scripts/smoke-prod.ts:106-140` | Asserts `health queue`, `health inngest explicit`, `queue has no dead-letters`, and `inngest status clarity` (503 + `inngest_unconfigured` while unprovisioned). Default base URL is `https://idaraworks.vercel.app` (line 12). | Pass the canonical URL explicitly: `pnpm smoke:prod https://www.idaraworks.com`. |

---

## 4. What Inngest officially requires today, and whether the code meets it

Fetched 2026-09-05 from inngest.com/docs. SDK in the repository: `inngest@4.12.1` (`package.json:42` declares `"inngest": "^4.12.1"`; `node_modules/inngest/package.json` resolves to 4.12.1).

| Requirement (official wording) | Source | Code status |
| --- | --- | --- |
| Serve endpoint: "create a Vercel/Next.js function at the `/api/inngest` endpoint"; App Router "requires `GET`, `POST`, and `PUT` methods". | https://www.inngest.com/docs/deploy/vercel ; https://www.inngest.com/docs/learn/serving-inngest-functions | **Met** — `src/app/api/inngest/route.ts`. |
| Signing key: "assign your signing key to an `INNGEST_SIGNING_KEY` environment variable in your hosting provider". It provides "Serve endpoint authentication", "API authentication" and "Replay attack prevention". Found in "each environment's Signing Key tab". | https://www.inngest.com/docs/learn/serving-inngest-functions ; https://www.inngest.com/docs/platform/signing-keys | **Met in code; the value is missing in Vercel** — owner action. |
| Event key: "In production, your application will need an 'Event Key' to send events to Inngest"; created in the dashboard — "Next to the environment drop down, click the key icon, then Event keys", then "+ Create Event Key"; set as `INNGEST_EVENT_KEY`. | https://www.inngest.com/docs/events ; https://www.inngest.com/docs/events/creating-an-event-key | **Met in code; the value is missing in Vercel** — owner action. |
| Environment variables: `INNGEST_EVENT_KEY` "The key to use to send events"; `INNGEST_SIGNING_KEY` "The key used to sign requests to and from Inngest"; `INNGEST_DEV=1` forces dev mode (signature verification disabled); "If neither … are specified, the SDK defaults to cloud mode". | https://www.inngest.com/docs/sdk/environment-variables | **Met**, with the comment inaccuracy noted in §3. |
| Syncing: "Sync App" / "Sync New App" with "your project's `serve()` endpoint … `https://my-app.com/api/inngest`"; `INNGEST_SIGNING_KEY` "ensures that your app is synced within the correct Inngest environment"; after deploying new function configuration, "Resync"; keep the app id unchanged "to avoid duplicate app creation". | https://www.inngest.com/docs/apps/cloud | Code is ready to be synced. App id `"idaraworks"` must stay as-is. |
| Vercel integration: "Installing Inngest's official Vercel integration does 3 things" — sets `INNGEST_SIGNING_KEY`, sets `INNGEST_EVENT_KEY`, and "Automatically syncs your app to Inngest every time you deploy". Requires a redeploy after installing. If Deployment Protection is on, "Inngest may not be able to communicate with your application" — use "Protection Bypass for Automation". | https://www.inngest.com/docs/deploy/vercel | Recommended path. Whether Deployment Protection is enabled on the production project: **UNVERIFIED — owner checks Vercel → Settings → Deployment Protection**. The canonical domain `www.idaraworks.com` serves publicly today, so the manual sync URL is reachable regardless. |
| Environments: a "Production Environment for all of your production applications"; "Each environment uses Event Keys and Signing Keys"; Vercel previews map to Branch Environments that "Share Event Keys and Signing Keys". | https://www.inngest.com/docs/platform/environments | Use **Production** keys only. Do not add keys to Vercel Preview unless preview relaying is wanted (it is not, per `runbooks/inngest-provisioning.md:18-20`). |
| Deduplication: an event `id` "acts as an idempotency key over a 24 hour period"; "any events sent with the same `id` will be ignored, regardless of the event's payload". Functions should still be written to be idempotent. | https://www.inngest.com/docs/guides/handling-idempotency ; https://www.inngest.com/docs/events | **Met** — the relay keys by `domain_event.id`. Beyond 24 h the same id would trigger again, which is why §7 assesses each consumer separately. |
| Retries: "in addition to the initial attempt, Inngest will retry a function or a step up to 4 times" by default; exponential backoff with jitter. | https://www.inngest.com/docs/features/inngest-functions/error-retries/retries | Code sets its own: 3 for org consumers (`harness.ts:95`, `lpo-pdf.ts:36`, `quote-pdf.ts:31`), 1 for crons. Fine. |
| Scheduled functions: "You'll need to serve these functions in your Inngest API for the functions to be available to Inngest"; the cron string takes an "Optional timezone prefix, e.g. `TZ=Europe/Paris 0 12 * * 5`"; the guide's only UTC remark is DST advice — "prefer TZ=UTC when you need consistent execution timing". Neither page states in words which timezone a prefix-less expression uses. | https://www.inngest.com/docs/guides/scheduled-functions ; https://www.inngest.com/docs/reference/functions/create | **Met** for serving. All eleven crons are prefix-less expressions that the code documents as UTC (e.g. `src/workers/functions/approval-stuck.ts:57` "hourly, UTC"); the "When (UTC)" column in §8 step 7 rests on those code comments, not on official wording — **UNVERIFIED — owner action**: after sync, read each function's next-run time on its Inngest Functions page and confirm it matches the UTC hour shown there. |
| Apps page: shows "App status … active Functions count and the SDK version used"; per-app "all active functions and their associated triggers" and sync history; manual "Resync"; "Archive" stops new runs. | https://www.inngest.com/docs/platform/manage/apps | This is where the owner confirms **28 functions** after sync. |
| Replay (dashboard feature): "replay functions in bulk from the Inngest dashboard" for runs in a time range — i.e. runs Inngest already has. | https://www.inngest.com/docs/platform/replay | **Not applicable** to the eleven events: Inngest has never received them. The word "replay" in this document means the outbox relay delivering them for the first time. |
| Signing-key rotation: `INNGEST_SIGNING_KEY_FALLBACK` for zero-downtime rotation (TypeScript SDK ≥ 3.18.0). | https://www.inngest.com/docs/platform/signing-keys | Supported by the installed SDK; no code change needed. `runbooks/inngest-provisioning.md` "Rotation" section should name the fallback variable (§5, item A). |
| Inngest plan/pricing limits (runs per month, concurrency). | Not on inngest.com/docs; not fetched. | **UNVERIFIED — owner action**: check the plan before the nightly fan-out begins (§8 step 7); 41 organisations × nightly + minute-level relay is small but not zero. |

---

## 5. Provider-independent work: complete versus still missing

**Complete and in place (no action):**

- Transactional outbox written inside the emitting transaction (`src/platform/events/outbox.ts`), so no event was lost during the four days of silence.
- Relay, dead-letter, retention and redrive surfaces (`relay.ts`; `supabase/migrations/0014`, `0015`, `0018`, `0019`); platform-task guard rejecting tenant sessions (`app.assert_platform_task`).
- Org re-verification harness; explicit 503 instead of an SDK crash; health status with staleness alarm; serve list generated from one registry with a registration test.
- `tooling/scripts/redrive-dead-letters.ts`; runbooks `inngest-provisioning.md`, `queue-worker-recovery.md`, `dead-letter-recovery.md`, `credential-disabled-operations.md`; `pnpm smoke:prod` assertions.
- Sharp tracing for the image worker (`next.config.ts:105-108`) with a verifier script (`tooling/scripts/check-traced-payloads.ts`). The code is in place; whether the **current production build** passes that verifier is **UNVERIFIED — engineer runs it after the next build** (§3, "Build tracing"). Listed here as built, not as passed.

**Still missing or wrong — described, not edited (no `src/` change was made by this document):**

| Item | What is wrong | What to change | Who |
| --- | --- | --- | --- |
| **A. Stale runbook facts** | `inngest-provisioning.md:41-44` says sync `https://idaraworks.vercel.app/api/inngest` and expects "four registered functions"; `queue-worker-recovery.md:147` and `credential-disabled-operations.md:66` say 24. Rotation section omits `INNGEST_SIGNING_KEY_FALLBACK`. | Sync and verify against the canonical `https://www.idaraworks.com/api/inngest`; expect **28** functions (11 crons + 17 consumers, listed in §3); add the fallback variable to Rotation. Docs only. | Engineer |
| **B. Misleading comment** | `src/platform/events/inngest.ts:215` "undefined → dev mode" contradicts the official default (cloud mode). | Change the comment to: "undefined → the SDK stays in cloud mode and `send` throws; local dev sets `INNGEST_DEV`". One-line comment edit. | Engineer |
| **C. No unit test for the 503 guard** | Only `smoke-prod.ts` asserts `inngest_unconfigured`, and only against a live deployment. | Optional: a unit test that imports the route with `APP_ENV=prod` and no keys and asserts 503 + `inngest_unconfigured`, and 200-path selection with both keys. | Engineer, optional |
| **D. Middleware runs on `/api/inngest`** | Session refresh executes on every Inngest request (harmless; an extra Supabase auth call per invocation). | Optional: add `api/inngest` to the matcher exclusion in `src/middleware.ts:43`, next to `api/health`. | Engineer, optional |
| **E. Owner expectation about PDFs** | `docs/H30-OWNER-CHECKLIST.md` O-6 says that without Inngest "Purchase-order PDFs never render, and 'LPO PDF pending render' stays on screen for ever", which reads as if Inngest alone fixes it. It does not: the LPO, quote and invoice workers build HTML and **stop at a gated seam** — "PDF render+store gated on render runtime + Inngest" (`lpo-pdf.ts:24-31`, `quote-pdf.ts:23-27`, `invoice-billing.ts:23-33`). No storage write and no `pdf_file_id` exist in those workers. | Correct the checklist wording: Inngest is necessary but not sufficient; the render-and-store step (F-42: bundled Chromium vs a render microservice, plus the `financial_doc` file write) is a separate build item that has not been done. Until it is, "pending render" remains after provisioning. | Engineer (docs) + owner (expectation) |
| **F. Sub-processor list** | `docs/H30-PRIVACY-CHECKLIST.md` §2 lists Supabase, Vercel, Sentry and Resend. Inngest is absent. Once connected, Inngest Cloud receives every relayed event payload (organisation ids, user ids, record ids — opaque identifiers, no names) and every function's return value (e.g. `{ reconciled: <paymentId> }`, `{ refreshed: <jobId> }`, `{ outcome: "built", htmlChars }`), and stores run history. | Add Inngest to §2 and to the list published under O-8. **LEGAL REVIEW** — whether Inngest needs to be named in the DPA and privacy notice under UAE PDPL (Federal Decree-Law 45/2021) and KSA PDPL, and whether the pseudonymous identifiers count as personal data in those regimes. Inngest's hosting region and its own DPA terms: **UNVERIFIED — owner action** (read them on inngest.com before connecting; a non-GCC region is a cross-border transfer question for the same review). | Owner + professional |
| **G. Vercel Deployment Protection** | Unknown whether enabled for the production project. | If enabled, configure "Protection Bypass for Automation" in Vercel and paste the secret into Inngest's integration settings (official doc, §4). | Owner — **UNVERIFIED** |
| **H. Alerting without Sentry** | Dead-letter capture is a no-op without `SENTRY_DSN` (O-7 undecided). | No code change; the owner should bookmark `/api/health` and read `checks.queue.alert` daily during the pilot, or decide O-7. | Owner |
| **I. Registration test covers two functions only** | `tests/unit/s10-worker-registration.test.ts` asserts that `retentionPruneCron` and `subscriptionLifecycleCron` are registered (lines 12-15) and that there are no duplicate references (17-18). The other 26 of the 28 functions have no import-but-not-register guard. | Optional: assert the registry length (28 today) or compare `workerFunctions` against every export of `src/workers/functions/*.ts`, so a dropped registration fails CI. Test-only change. | Engineer, optional |

---

## 6. Replay preview — exactly what happens when the relay drains the eleven

Sequence, once keys are set, the deploy is live and the app is synced: within one minute Inngest invokes `outbox-relay`. It claims all 11 rows in one batch (`RELAY_BATCH = 50`), bumping each to `attempts = 1`, sends each to Inngest keyed by its row id, marks each processed. Inngest then starts the consumer runs. Total: **11 events sent, 4 trigger no function, 7 trigger 10 function runs** (each `approval/decided` has two consumers).

| Event (rows) | Runs | Could it send email? | Could it alter records? | Could it duplicate anything? | Could it write a PDF to storage? |
| --- | --- | --- | --- | --- | --- |
| `approval/submitted` (3) | 0 | No | No | No | No |
| `job/created` (1) | 0 | No | No | No | No |
| `approval/decided` (3) | 6 | No | *Reconcile:* only if `subjectType = "payment"` — sets `invoice.status` from the sum of its payments and credit notes; a status that already reflects the truth is rewritten to the same value (`updated_at` moves). Otherwise `{ skipped: true }`. *Clear:* resolves an open `approval_stuck` exception if one exists (expected: none). | No. Both writes are "set to the computed value", not "add to". | No |
| `goods_receipt/recorded` (2) | 2 | No | If the PO is linked to a job: upserts that job's `cost_rollup` / `cost_rollup_labour` rows with totals recomputed from source. `source_version` increments and `computed_at` moves on every run. If the PO has no job: nothing. **Never** touches stock tables. | No. Two events for the same job produce the same totals twice; the second run overwrites the first with identical numbers. | No |
| `purchase_order/approved` (1) | 1 | No | No. Builds HTML in memory; one log line. Reads the org logo from storage if present. | No | **No** — the render-and-store seam is unbuilt (§5 E). "LPO PDF pending render" stays. |
| `quote/accepted` (1) | 1 | No | No. Same as above. | No | **No** |

**What the owner will observe afterwards:** `/api/health` `checks.queue` drops to `unprocessed: 0, stale: false, alert: false`; the Inngest dashboard shows one `outbox-relay` run per minute and ten completed consumer runs; a job's costing screen may show a refreshed cached total; an invoice's paid status may change **only** if a payment approval was among the three decisions and its status was stale. No email, no file, no PDF, no stock.

**What could go wrong, and what it would look like:**

- A consumer run fails with `OrgVerificationError` because the actor's membership row was deleted (not merely deactivated) since 2026-09-01. Effect: that run retries three times, then shows **Failed** in Inngest. The outbox row is already processed, so `/api/health` stays clean. No harm: every effect above is recomputable on the next real event or nightly reconcile. Do not redrive.
- The PO in a receipt event was deleted or belongs to no job: the run returns `{ refreshed: null }` and succeeds.
- Inngest sends a duplicate within 24 h: ignored by id. After 24 h (only possible via manual re-send): the consumers are idempotent (§7).

---

## 7. Idempotency verdict per consumer, with evidence

"Idempotent" here means: running it a second time with the same event produces the same end state (timestamps and version counters aside).

| Consumer | Verdict | Evidence |
| --- | --- | --- |
| Outbox relay (`outbox-relay`) | **Idempotent, proved by test.** | `tests/integration/events-outbox.test.ts:124-151` "claims → sends (keyed by id) → marks processed": a second relay pass claims 0 and the unprocessed count is unchanged. Inngest dedups the id for 24 h (official). At-least-once trade-off documented at `relay.ts:10-15`. |
| `cost-rollup-on-goods-receipt` | **Idempotent by construction; repeat-run behaviour exercised, not asserted as a pair.** | `app.refresh_cost_rollup` recomputes every component from source rows and upserts with `on conflict (org_id, job_id) do update` (0040 lines 156-167 for `cost_rollup`, 169-175 for `cost_rollup_labour`; the `(org_id, job_id)` primary key is at line 24). No cost figure is ever incremented; the only `+ 1` is `source_version` (line 167), a version stamp. `tests/integration/s5-measure.test.ts:269-281, 443-454` call `refreshRollup` repeatedly on the same job and assert exact totals each time, which is only possible if repeats are harmless. `source_version` and `computed_at` change per run by design. |
| `payment-reconcile-on-decision` | **Idempotent by construction; no explicit double-run test.** | `reconcileInvoiceStatus` is a single `update … set status = case …` computed from aggregates (`invoices/service.ts:803-815`); running it twice yields the same status. Guarded to invoices in `issued / partially_paid / paid`. Single-run behaviour covered by `tests/integration/s6-bill.test.ts:233` ("records a full payment → invoice paid …"). A two-run assertion does not exist — **unproven by test, proved by reading**. |
| `exception-clear-on-approval-decided` | **Idempotent by construction; no explicit double-run test.** | `update public.exception set resolved_at = now() … where … resolved_at is null` (`exceptions/service.ts:164-175`): the second run matches zero rows. Single-run call at `tests/integration/s5-measure.test.ts:348`. |
| `lpo-pdf-renderer`, `quote-pdf-renderer` | **Idempotent trivially — no writes.** | `lpo-pdf.ts:22-33`, `quote-pdf.ts:20-28`: read, build a string, log, return. |
| No-consumer events (`approval/submitted`, `job/created`) | Not applicable. | No function binds them (`src/workers/functions/*.ts`). |
| Harness (`defineOrgFunction`) | Adds no state. | `harness.ts:99-124`: verification is a read; the handler's own idempotency is what counts. |

For completeness, the crons that start firing at the same time (they are outside the eleven events but the owner will see their effects): `nightly-org-run` is described as idempotent by dedup-key upsert and tested ("runOrgNightly is idempotent", `tests/integration/s7-improve.test.ts:251`); `exception-signal-materializer` upserts by `dedup_key` (`exceptions/service.ts:189-212`); `sweepLifecycle`, `sweepAddonRemovals`, `recordDunning` and `pruneRetention` are described in-code as idempotent and per-org fault-isolated (`subscription-worker.ts:46-47, 107-110, 201-202`); `sweepStuckApprovals` — which belongs to the hourly `approval-stuck-evaluator` cron (`src/workers/functions/approval-stuck.ts:19-54`, registered at lines 56-59), not to the outbox relay — **is not** idempotent: it emits a fresh `exception/raised` for every pending approval older than 8 h on every hourly run (`approvals/service.ts:1101-1129`); the duplicates are absorbed downstream by the materializer's dedup key, at the cost of one extra outbox row per stuck approval per hour until it is decided. Harmless, but worth knowing when reading `checks.queue.unprocessed` briefly climb at the top of each hour.

---

## 8. Owner actions, in order

Nothing in this list has been done. Each step is yours because it needs an external account, a credential, or your decision. Do not paste key values into chat, tickets or this repository.

1. **Read the sub-processor question first (§5 F).** Decide, with your reviewer, whether connecting Inngest is acceptable before a DPA names it. **LEGAL REVIEW.** If the answer is "not yet", stop here; the queue stays safe (at-least-once, nothing lost) and the staleness alarm keeps reporting it.

2. **Create the Inngest account** at inngest.com and use its **Production** environment. Check the plan limits against: one `outbox-relay` run per minute (about 44,000 runs a month on its own), one `idara-run-executor` run every two minutes (returns immediately while the AI flag is off), the hourly and nightly crons, plus one `nightly-org-run` per organisation per night (41 today). **UNVERIFIED — owner action.**

3. **Connect through the Vercel integration** (recommended; official doc §4): Inngest → Settings → Integrations → Vercel → connect, select the `idaraworks` Vercel project, **Production** environment only. This sets `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` in Vercel and syncs on every deploy.
   *Alternative, manual:* in Inngest, "Next to the environment drop down, click the key icon, then Event keys" → "+ Create Event Key" (official wording, §4); Inngest → environment Signing Key tab → copy; then from the repo root `vercel env add INNGEST_EVENT_KEY production` and `vercel env add INNGEST_SIGNING_KEY production`, pasting at the prompt (`runbooks/inngest-provisioning.md` §2). Then sync manually: Apps → Sync New App → `https://www.idaraworks.com/api/inngest`.
   Never set `INNGEST_DEV`. Do not add either key to the Preview environment.

4. **If Vercel Deployment Protection is enabled on production**, configure Protection Bypass for Automation and give Inngest the secret (official doc §4). **UNVERIFIED** whether it is enabled.

5. **Redeploy production** (`vercel deploy --prod --yes`, or push to `main`). Environment changes need a new deployment; the integration syncs on that deploy.

6. **Verify, in this order — all must pass** (`runbooks/inngest-provisioning.md` §4, corrected for the canonical domain and function count):
   1. `GET https://www.idaraworks.com/api/inngest` no longer returns `503 inngest_unconfigured`.
   2. `GET https://www.idaraworks.com/api/health` shows `checks.inngest.status = "configured"`.
   3. Inngest → Apps → `idaraworks` shows **28 functions** and a green sync; the SDK version reads 4.12.1.
   4. Inngest → Functions → `demo-heartbeat` → Invoke with a real `{ "data": { "orgId": "<org uuid>", "actorUserId": "<member uuid>", "nonce": "provision-check-1" } }` → the run succeeds. Invoke again with a forged pair → the run **fails** with `OrgVerificationError` (that is the security control working).
   5. `curl -X POST https://www.idaraworks.com/api/inngest` with no signature → rejected (401/400), never executed.
   6. `pnpm smoke:prod https://www.idaraworks.com` passes.

7. **Know what starts the moment the sync is green.** These crons fire on their own schedule (UTC), with no further action:

   | When (UTC) | Cron | Visible effect on the first run |
   | --- | --- | --- |
   | every minute | `outbox-relay` | Drains the eleven (§6). |
   | every 2 min | `idara-run-executor` | Returns immediately — AI flag is off (`src/modules/idara/queue.ts:31`). |
   | :00 hourly | `approval-stuck-evaluator` | For every approval pending more than 8 h in any organisation, raises an `approval_stuck` exception (critical after 3 days) and an in-app notification to that organisation's owners/admins — "An approval is waiting". Tenants **will** see these. |
   | :25 hourly | `idara-schedule-sweep` | Nothing while the AI flag is off. |
   | 00:00 | `exception-nightly-dispatch` → `nightly-org-run` per org | Every organisation with an owner gets its nightly evaluators (missing reports, overdue, blockers, billing, margin drift, late supplier, document expiry), a cost-rollup reconcile, and an owner digest. Exceptions and digests will appear for all organisations the next morning. |
   | 02:00 | `subscription-lifecycle` | Lands expired trials on the free base plan; walks past_due → grace → suspended timers; schedules purge for suspended/cancelled organisations past 60 days; applies scheduled downgrades. Which organisations are in which state today: **UNVERIFIED — read `/platform` subscription states before the first 02:00 run**. No billing provider exists, so nothing is charged. |
   | 02:00 | `storage-reconcile` | Fails pending uploads older than 24 h, corrects storage counters, logs orphan objects. |
   | 03:15 | `outbox-retention` | Purges processed events older than 90 days; reaps abandoned dead letters older than 30 days. |
   | 03:30 | `retention-prune` | **Deletes** read notifications older than 90 days and any older than 12 months, resolved exceptions older than 24 months, AI-interaction metadata older than 12 months, digests older than 90 days (`supabase/migrations/0064_s10_retention_pruning.sql`). **LEGAL REVIEW** — confirm these windows match the retention schedule in the DPA and `runbooks/retention.md` before the first run. |
   | 04:15 | `crm-automation-sweep` | Only organisations with enabled automations; in-app effects only. |
   | 04:30 | `doc-obligation-reminders` | In-app notifications for due/overdue document obligations. |

   None of these sends email. The only outbound email path is `sendEmail` (`src/platform/notifications/email.ts`), which has exactly three callers, all reached from a user's action and none from a cron: CRM campaign send (`src/modules/crm/consent.ts:355`), document signature requests (`src/modules/docstudio/signatures.ts:401`) and workspace invites (`src/platform/auth/identity.ts:257`). `crm-automation-sweep` cannot reach it — automation actions "never sign, send campaigns, post accounting or move a stage without review" (`src/modules/crm/automation.ts:7-8`) — and `doc-obligation-reminders` writes in-app notifications only (`createNotificationIn`, `src/modules/docstudio/obligations.ts:11, 327-725`). Independently, `sendEmail` returns `{ delivered: false }` without contacting anyone while `RESEND_API_KEY` is unset (`email.ts:12-19`). **Recommendation:** provision Inngest before Resend, let one full daily cycle run with email structurally impossible, read what it produced, and only then decide on email.

8. **Replay decision — recommended: do nothing and let the relay drain.** Specifically:
   - Do **not** run `tooling/scripts/redrive-dead-letters.ts` — nothing is dead-lettered; it would be a no-op.
   - Do **not** hand-run `relayOutbox` from a laptop — it needs the production event key on that machine and adds nothing the cron does not do within a minute.
   - Do **not** use Inngest's dashboard Replay — Inngest has never received these events; there is nothing there to replay.
   - Do **not** mark rows processed by hand to suppress the effects. The effects are a recomputed cost cache and, at most, an invoice status corrected to the truth. Suppressing them would need a direct database write to a live customer's table for no benefit.

---

## 9. Keep the alarm on, and how to know processing is restored

**Keep it on.** `checks.queue.alert` and `checks.queue.stale` (`src/platform/observability/health.ts:146-147`, threshold `QUEUE_STALE_AFTER_S = 3600`) are the only signal that the queue is being collected at all. Do not raise the threshold, do not special-case Inngest, do not stop reading it after provisioning. It is currently `true` in production and should stay `true` until the drain — a healthy report before the keys are set would mean the alarm broke, not that the queue healed.

**Restoration is confirmed when all of the following hold, in this order:**

1. `GET https://www.idaraworks.com/api/health` → `checks.inngest.status = "configured"`, `checks.queue.unprocessed = 0`, `checks.queue.oldest_unprocessed_age_s = 0`, `checks.queue.dead_lettered = 0`, `checks.queue.stale = false`, `checks.queue.alert = false`. Expect this within two minutes of a green sync (one relay tick to claim and send; the 5-second per-instance cache can delay the reading slightly).
2. Inngest dashboard → Functions → `outbox-relay`: a completed run every minute, output showing `{ claimed: 11, sent: 11, failed: 0, deadLettered: 0 }` on the first tick and `claimed: 0` thereafter.
3. Inngest dashboard → Runs: ten completed consumer runs — six for `approval/decided` (two functions × three events), two `cost-rollup-on-goods-receipt`, one `lpo-pdf-renderer`, one `quote-pdf-renderer` — and **no Failed runs**. If a run failed with `OrgVerificationError`, see §6 "what could go wrong"; leave it.
4. `pnpm smoke:prod https://www.idaraworks.com` → green, including `queue has no dead-letters`.
5. The next morning: `nightly-org-run` completed once per organisation; `subscription-lifecycle`, `storage-reconcile`, `retention-prune` completed once; `/api/health` still all-clear.

**If it does not drain:** `checks.inngest.status = "configured"` but `unprocessed` stays 11 with `attempts` rising → the relay is claiming but the send fails; the rows' `last_error` names the cause (a wrong or revoked event key is the usual one). Follow `runbooks/queue-worker-recovery.md` §D. Rows dead-letter after 20 attempts (about 20 minutes); do not redrive until the cause is fixed and deployed (`runbooks/dead-letter-recovery.md`).

**Who watches what, during the pilot:** with Sentry undecided (O-7), the health endpoint and the Inngest dashboard are the two places failures surface. Read both daily until the first full week of crons has run clean.

---

## Appendix — what was and was not done in producing this

- Read: the files cited above under `src/`, `supabase/migrations/`, `tests/`, `runbooks/`, `docs/`, `tooling/scripts/`, and `node_modules/inngest` for the SDK's own messages.
- Fetched: the fourteen inngest.com/docs pages cited in §4. Revision pass, 2026-09-05: `guides/scheduled-functions`, `reference/functions/create` and `events/creating-an-event-key` re-fetched to correct quoted wording; every file:line citation in §1, §3, §4, §7 and §8 re-read against the repository.
- Not done: no database connection; no script executed against any database; `.env.local` / `.env.test.local` not read; no Supabase or Vercel CLI command; no build run; no `src/` file edited; nothing sent.
- Unverified items are listed in §3 (build tracing), §4 (Deployment Protection, plan limits, cron timezone), §5 (F, G), §6 (subject types, organisation identity, job linkage) and §8 (plan limits, Deployment Protection, subscription states).
- Legal review markers: §5 F (sub-processor / cross-border), §8 step 1 (DPA timing), §8 step 7 (`retention-prune` windows).
