# Operating IdaraWorks with credential seams disabled (the default pilot state)

**Audience:** the operator running the IdaraWorks pilot on `idaraworks.vercel.app`.

**What this covers:** every external-credential seam ships **disabled by default** and the
product is designed to run correctly in that state. This is the *intended* pilot posture, not
a degraded one — the deterministic fallbacks are the product for S0–S11. This runbook is the
single reference for **what still works, what is degraded, and how you can tell** for each seam,
plus the exact `/api/health` signals to watch.

Nothing here contains secret values. Provisioning any of these seams is an **[OWNER ACTION]** —
see the per-seam "To enable" line and the linked provisioning runbooks.

---

## The one rule that governs all of it

Every "are we in production?" decision routes through a single helper, `isProd()`
(`src/platform/env.ts`), which is true **only** when `APP_ENV=prod`. Three provider seams
(billing, e-invoice, AI narration) default to their **disabled** provider under `isProd()`;
two more (Inngest, Sentry) default to a no-op when their keys are absent. Off-production
(`APP_ENV=dev` / `preview`) the same seams default to a deterministic **fake** so CI, dev, and
the demo scripts exercise the full lifecycle without any real account.

> S10 hardening fix (do not regress): the earlier guard compared `APP_ENV === "production"`, a
> string that is never set anywhere, so in real production it fell through to the **fake**
> provider (fake ZATCA clearance, a fake checkout shown as enabled, fake narration). Every seam
> now routes through `isProd()`. If you ever see a *fake* provider active in prod, that helper
> has been bypassed — treat it as a Sev-2.

### Health at a glance

`GET https://idaraworks.vercel.app/api/health` is the ground truth. In the default pilot state a
healthy report looks like:

```json
{
  "ok": true,
  "checks": {
    "db":      { "ok": true,  "latency_ms": 12 },
    "storage": { "ok": true,  "latency_ms": 40 },
    "queue":   { "ok": true,  "unprocessed": 0, "oldest_unprocessed_age_s": 0, "dead_lettered": 0 },
    "inngest": { "configured": false, "status": "unconfigured", "detail": "INNGEST_… not provisioned …" }
  }
}
```

- Only **`db`** and **`storage`** gate the HTTP status (200 vs 503). Those are the two hard
  dependencies and they are **owner-provisioned and always on** — they are *not* disabled seams.
- **`queue`** reports outbox gauges and is informational: a dead-letter raises `alert: true` but
  never 503s the app.
- **`inngest`** is a **configuration status**, never a gate. `status: "unconfigured"` is the
  expected, explicitly-reported default — never an "unexplained failure."

Source: `src/platform/observability/health.ts`. Route: `src/app/api/health/route.ts`
(rate-limited, 5s per-instance cache). `pnpm smoke:prod` asserts every one of these fields,
including `health inngest explicit` and `queue has no dead-letters`.

---

## 1. Inngest (worker fleet + crons) — **unconfigured**

**State:** `INNGEST_SIGNING_KEY` / `INNGEST_EVENT_KEY` are not provisioned. This is the single
most consequential disabled seam, because it dormants the **entire background worker fleet**.

**What the fleet is** (`src/workers/index.ts`, 24 functions served at `/api/inngest`):

- Event consumers (`defineOrgFunction`): `image-derivatives`, `lpo-pdf-renderer`,
  `invoice-on-issued`, `payment-reconcile-on-decision`, `approval-stuck`, the six `cost-rollup-*`
  invalidators, the exception materializer/clearers, `nightly-org-run`, `demo-heartbeat`.
- Platform crons: `outbox-relay` (`* * * * *`), `outbox-retention` (`15 3 * * *`),
  `exception-nightly-dispatch` (`0 0 * * *`), `subscription-lifecycle` (`0 2 * * *`),
  `retention-prune` (`30 3 * * *`).

**What still works:**

- **Every synchronous, user-facing write.** Jobs, daily reports, approvals, supply (MR/PO/GRN),
  expenses, quotes, invoices, payments, credit notes — all commit fully in-request. None of them
  depend on a worker to be *correct*; the worker only drives the *post-commit* side effect.
- **The outbox never loses an event.** Every domain event is written **inside the committing
  transaction** as a `public.domain_event` row (`src/platform/events/outbox.ts`,
  `publish.ts`). With Inngest dormant these rows simply **accumulate durably, at-least-once by
  design** — they are delivered the moment the relay runs. This is safe and expected.
- The `/api/inngest` route returns an explicit `503 {status: "inngest_unconfigured"}` instead of
  the SDK's generic 500 (`src/app/api/inngest/route.ts`). An unsigned POST is *rejected*, never
  executed — that rejection is the security boundary working.

**What is degraded (deferred, not lost):** anything a worker would have done post-commit does not
happen automatically until the relay + worker run:

- Uploaded-image derivative thumbnails (`image-derivatives`).
- LPO / invoice **PDF render+store** (also independently gated on the PDF runtime — §2).
- Cost-rollup cache invalidation → the costing screens can lag their inputs until a rollup runs.
- Exception materialization + nightly evaluation, approval-stuck sweeps.
- Subscription lifecycle (trial expiry, dunning ladder, purge scheduling), reconciliation, and
  retention pruning — but these are **commercial/housekeeping**, not tenant-blocking (§9, §10).

**Running the dormant work on-demand (the pilot substitute for the crons):** the relay,
lifecycle sweep, nightly dispatch, and retention prune are all **plain, directly-invocable
functions** — the cron is only a thin wrapper. They are exercised exactly this way in the
integration tests and the prod-demo scripts:

| Work | Function (importable) | Cron wrapper (dormant) |
| --- | --- | --- |
| Relay outbox → deliver queued events | `relayOutbox()` (`src/platform/events/relay.ts`) | `outbox-relay` |
| Dead-letter alarm | `checkDeadLetters()` | (inside `outbox-relay`) |
| Purge processed / reap dead-letters | `purgeProcessedEvents()` | `outbox-retention` |
| Redrive dead-letters | `pnpm tsx tooling/scripts/redrive-dead-letters.ts` | (manual only) |
| Subscription lifecycle + reconcile | `sweepLifecycle(Date.now())`, `runReconciliation()` (`src/workers/functions/subscription-worker.ts`) | `subscription-lifecycle` |
| Nightly exception dispatch / per-org run | `dispatchNightly(...)`, `runOrgNightly(...)` (`src/workers/functions/exception-engine.ts`) | `exception-nightly-dispatch` |
| Retention prune | `pruneRetention()` (`src/workers/functions/retention-prune.ts`) | `retention-prune` |

All of these are **platform tasks** (no tenant context) — they run against the
`assert_platform_task`-guarded DEFINER path with a dedicated `createAppDb({ max: 1 })` client and
never touch a tenant session. They are idempotent (consumers keyed by event id), so running one
twice is harmless. Redrive is the only one wrapped in a shipped `pnpm` script; the others are run
via `pnpm tsx` against an ad-hoc entrypoint or invoked inside the prod-demo scripts. For queue
recovery specifically, use **`runbooks/queue-worker-recovery.md`**.

**`/api/health` signal:** `checks.inngest.status = "unconfigured"`, `checks.inngest.configured =
false`. `checks.queue.unprocessed` will **climb** while the relay is dormant and events are being
written — that is expected; it drains to 0 the moment the relay runs (or the moment Inngest is
provisioned and the accumulated backlog is delivered).

**To enable — [OWNER ACTION] OA-4:** follow `runbooks/inngest-provisioning.md` (provision Inngest
Cloud app `idaraworks`, install `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` in Vercel prod,
redeploy, sync the app, run the four-step verify). **Never set `INNGEST_DEV=1` in production** —
it would accept unsigned invocations. Once configured, `/api/inngest` stops returning
`inngest_unconfigured`, health flips to `configured`, and all five crons go live.

---

## 2. PDF runtime — **gated (no renderer configured)**

**State:** the LPO and invoice PDF **HTML templates** are built in-app, but the
**render (HTML→PDF via headless Chromium) + store (files pipeline, class `financial_doc`)** step
is a seam that no-ops with a log line until a render runtime is configured. It is *doubly* gated:
it needs both a render runtime **and** Inngest (the render runs inside a worker).

**What still works:**

- The bilingual/bidi Arabic-primary **HTML is composed** every time a PO is approved or an invoice
  is issued (`buildLpoHtmlForPo`, `buildInvoiceHtmlInternal`). The template is the substantive
  v1 deliverable and is bidi-snapshot-tested.
- The invoice's e-invoice clearance QR is still computed and threaded into the HTML (subject to §3).
- A real, human-reviewable Arabic PDF **is** produced by the demo path via Playwright's bundled
  chromium — so the template is provably correct even with the prod runtime unwired.

**What is degraded:** no `financial_doc` PDF file is stored and `purchase_order.pdf_file_id` /
the invoice PDF pointer stay null. When a worker *does* run (Inngest up), it logs
`"… PDF render+store gated on render runtime + Inngest (owner action)"` and returns
`outcome: "built"` without a stored artifact. Operationally: **share the on-screen document; do
not promise a downloadable stored PDF** during the pilot.

**Source:** `src/workers/functions/lpo-pdf.ts`, `src/workers/functions/invoice-billing.ts`.

**`/api/health` signal:** none directly. Presence of the seam is inferred from Inngest status +
the worker log line.

**To enable — [OWNER ACTION]:** provision a render runtime (bundled Chromium or a render
microservice behind the same seam) **and** Inngest (§1). No schema or logic change — it is an
activation.

---

## 3. E-invoice provider — **disabled in prod (`fake` off-prod)**

**State:** with no provider configured, `getEInvoiceProvider()` returns the **disabled** provider
in production (`src/platform/einvoice/adapter.ts`). Off-production it returns the deterministic
**fake** (which mirrors a real GCC provider's validation: it rejects a domestic taxable supply
with no buyer tax registration, so the clear + reject contract paths are both tested).

**What still works:** the full invoicing lifecycle — issue, credit-note, AR aging, payments — is
completely independent of clearance. Invoices are valid business documents without a clearance id.

**What is degraded:** no submission to any tax authority / clearance partner. The disabled
provider records a **gated no-op** (`logger.info … "e-invoice submission skipped — no provider
configured"`) and returns no `externalId`, no `clearedAt`, no clearance QR. Do not represent
pilot invoices as government-cleared.

**`/api/health` signal:** none. Verify by env: `getEInvoiceProvider().enabled === false` in prod
(the S10 prod-demo prints `einvoice=<name>` and notes the prod default is DISABLED).

**To enable — [OWNER ACTION] OP-3 (D-decision-gated):** implement a real provider adapter behind
the `EInvoiceProvider` interface, supply its credentials to the platform secret store (never in
code), and set `EINVOICE_PROVIDER`. Note: the code references `runbooks/einvoice-provisioning.md`,
which does not yet exist — the provisioning steps live with the D-decision that authorizes a real
tax-authority integration.

---

## 4. Payment provider (billing) — **disabled in prod (D1-gated)**

**State:** `getBillingProvider()` returns the **disabled** billing provider in production
(`src/platform/billing/adapter.ts`); off-production it returns the deterministic **fake** (which
mints stable ids and HMAC-signs its own webhook payloads so the whole subscription lifecycle is
exercisable end-to-end without a merchant account). This is the **D1** open decision
(merchant-of-record) — no real processor is wired.

**What still works:** the entire **subscription state machine and entitlement gating**. Org
state, plan, entitlements, impersonation, telemetry, and the dunning *ladder logic* all run
through the sole-writer `applyTransition` regardless of provider. For the pilot, subscription
state is operator-driven (seed/administer directly), not customer-checkout-driven.

**What is degraded:** every outbound billing op **refuses** with `BillingProviderDisabledError`:
`createCheckoutSession`, `createPortalSession`, `cancelSubscription`, `parseEvent`. Crucially,
`verifySignature()` returns **`false` for every inbound webhook** — so the `/api/billing/webhook`
endpoint accepts nothing while disabled (it is still rate-limited per-IP, rule `webhook`,
`src/platform/http/rateLimit.ts`). No card data is ever touched or stored.

**`/api/health` signal:** none. Verify by env: `getBillingProvider().enabled === false` in prod.

**To enable — [OWNER ACTION], D1 activation:** close D1, implement a real provider
(`stripe`/`paddle`/`tap`/`moyasar`/…) behind the same `BillingProvider` interface, supply its
signing secret + API credentials to the secret store, and set `BILLING_PROVIDER`. No schema/logic
change — activation only.

---

## 5. AI narration / onboarding — **disabled in prod; deterministic fallback IS the product**

**State:** `getNarrationProvider()` returns the **disabled** provider in production
(`src/platform/ai/adapter.ts`); off-production it returns the deterministic **fake**. Read this
seam differently from the others: **the deterministic output is the shipped product, and the AI is
an optional wording layer on top.**

**What still works (this is the whole feature):**

- The **deterministic digest** (Layer A) is computed from tenant data with no AI at all. It is
  complete, correct, and bilingual on its own. When narration is disabled the digest simply
  **stands** — that is the AI-outage / credits-exhausted / no-credentials fallback, by design.
- **AI onboarding (S8)** is a Layer-A `ConfigProposal` pipeline with a **manual fallback**: an
  operator can configure an org fully by hand without any AI call. Onboarding is never blocked by
  this seam.

**What is degraded:** the optional natural-language *narration* layered over the digest is absent
(the disabled provider returns `status: "disabled"`, `text: null`, and logs the gated skip). No
tenant data is ever sent anywhere — even the fake provider only ever receives a **closed payload
of system-composed labels + numbers**, never raw tenant free-text, so there is no prompt-injection
surface and nothing to leak.

**`/api/health` signal:** none. Verify by env: `getNarrationProvider().enabled === false` in prod.

**To enable — [OWNER ACTION]:** implement a real narration provider behind the
`NarrationProvider` interface, supply credentials, set `AI_NARRATION_PROVIDER`. The
numbers-subset validator (`src/platform/ai/numbers-subset.ts`) still constrains any real
provider's output to numbers present in the payload. Code references
`runbooks/ai-provisioning.md` (not yet written).

---

## 6. Sentry — **no-op (no DSN)**

**State:** without `SENTRY_DSN`, every function in `src/platform/observability/sentry.ts` is a
clean no-op (`sentryEnabled()` is false). Runtime-only integration — no build plugin, no
sourcemap upload — so the Vercel build pipeline is identical with or without it.

**What still works:** **all observability you actually need for the pilot.** Structured JSON logs
(pino) with every request-scoped line tagged `request_id` / `org_id` / `user_id` are emitted
regardless — read them in Vercel → Project → Logs, filtered by the `request_id` a user reports
(every response echoes `x-request-id`; the error page shows the digest). `/api/health` and
`/api/ready` are the liveness surfaces.

**What is degraded:** no centralized error aggregation, no alerting. Notably, the **dead-letter
page alert** (`captureDeadLetter`, Sentry `outbox_dead_letter`) is silent — so during the pilot
you must **watch `/api/health` `checks.queue.dead_lettered` yourself** (the `smoke:prod` suite and
any uptime monitor pointed at `/api/health` cover this).

**`/api/health` signal:** none for Sentry itself (it is a reporting sink, not a dependency).

**To enable — [OWNER ACTION] OA-4:** follow `runbooks/sentry-provisioning.md` (create project,
install `SENTRY_DSN` in Vercel prod, redeploy, verify with `tooling/scripts/seed-sentry-error.ts`).
The `beforeSend` PII scrub ships identifiers-only regardless.

---

## 7. Upstash (rate limiting) — **in-memory fallback**

**State:** without `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, `rateLimit()` uses an
**in-memory sliding-window** limiter (`src/platform/http/rateLimit.ts`). If Upstash *is*
configured but a call fails, it **fails open to the in-memory limiter, loudly** (logs
`"upstash rate limit unavailable"`) — availability over lockout.

**What still works:** every rate-limited surface is still bounded within a single serverless
instance: `login`, `signup`, `otp_send`, `invite_send`/`invite_accept`, `health`, `share`
(public customer link), `webhook`. The rules are unchanged.

**What is degraded:** limits are **per-instance, not global**, and **reset on every deploy /
cold start**. On Vercel's multiple concurrent instances the effective ceiling is (rule × instance
count). Adequate for a controlled pilot; **must** be Upstash-backed before any adversarial
exposure — the public `share` and unauthenticated `webhook`/`health` endpoints are the ones that
matter for enumeration/abuse.

**`/api/health` signal:** none. A degraded state surfaces as the `"upstash rate limit
unavailable"` warn log (only when Upstash is *configured* and failing).

**To enable — [OWNER ACTION] OA-4:** provision Upstash Redis, set both env vars in Vercel prod,
redeploy. No code change; `rateLimit()` picks up the REST store automatically.

---

## 8. Messaging (email / SMS / push) — **dev sink / in-app only**

**Email (Resend):** without `RESEND_API_KEY`, `sendEmail()` is a **dev/CI logger sink** — it logs
the message at `debug` and returns `{ delivered: false }` (`src/platform/notifications/email.ts`).
The primary user-facing consequence is **invites**: `inviteMember` still creates the invite row
and token, but the email is not delivered. **Pilot workaround:** the function returns the invite
`token`; the operator hands the accept link (`<APP_URL>/invite/<token>`) to the invitee
out-of-band (the link is also in the debug log). Invite acceptance itself works fully.

**In-app notifications:** **fully work.** `createNotification` / `createNotificationIn` persist
the in-app record inside the committing transaction and resolve recipient channel preferences
(`src/platform/notifications/notify.ts`). Recipients read them via `listMyNotifications`. The
in-app channel has no external dependency.

**Push / email fan-out channels:** the `email` and `push` notification *channels* are a delivery
seam — the in-app record always lands; outbound email fan-out follows the Resend state above, and
there is no wired push transport. Bodies are pre-redacted (never cost/price) by design.

**SMS (Twilio):** the `TWILIO_*` vars are Phase-C placeholders in `.env.example`; no Twilio
transport is wired in the shipped auth path. Auth is email+password / OTP / TOTP via Supabase —
not dependent on a Twilio credential for the pilot.

**`/api/health` signal:** none (messaging is not a health dependency).

**To enable — [OWNER ACTION] OA-4:** set `RESEND_API_KEY` (+ optional `EMAIL_FROM`) in Vercel
prod to deliver invites/notifications by email. SMS/push transports are later-phase.

---

## Quick reference — default pilot posture

| Seam | Default in prod | Still works | Degraded / deferred | Health signal | Enable ([OWNER ACTION]) |
| --- | --- | --- | --- | --- | --- |
| Inngest workers + 5 crons | unconfigured | all sync writes; outbox durably queues | post-commit side effects until relay runs | `checks.inngest.status=unconfigured`; `checks.queue.unprocessed` climbs | `inngest-provisioning.md` (OA-4) |
| PDF runtime | gated | bilingual HTML built + demo PDF | no stored `financial_doc` PDF | (worker log) | render runtime + Inngest |
| E-invoice | disabled | full invoicing lifecycle | no tax-authority clearance/QR | (env: `.enabled=false`) | real provider + creds (OP-3 / D-gate) |
| Payment/billing | disabled (D1) | subscription state machine + entitlements | no checkout/portal; webhooks rejected | (env: `.enabled=false`) | real provider + creds (D1) |
| AI narration/onboarding | disabled | **deterministic digest + manual onboarding = the product** | optional narration wording absent | (env: `.enabled=false`) | real provider + creds |
| Sentry | no-op | pino logs + `/api/health` + `/api/ready` | no aggregation/alerting (watch health for dead-letters) | n/a (reporting sink) | `sentry-provisioning.md` (OA-4) |
| Upstash rate limit | in-memory | all limited surfaces bounded per-instance | per-instance, resets on deploy | (`upstash … unavailable` warn) | Upstash env vars (OA-4) |
| Messaging | email dev-sink; in-app on | in-app notifications; invite tokens | email invites not delivered; no SMS/push | n/a | `RESEND_API_KEY` (OA-4) |

**The two hard, always-on dependencies** (not disabled seams) are **`db`** and **`storage`** —
these are the only two that 503 `/api/health`. Everything above degrades gracefully or defers
work; none of it takes the app down.

## See also

- `runbooks/queue-worker-recovery.md` — recovering the outbox + worker fleet.
- `runbooks/dead-letter-recovery.md` — diagnosing/redriving dead-lettered events.
- `runbooks/inngest-provisioning.md`, `runbooks/sentry-provisioning.md` — the two written
  owner-provisioning runbooks.
- `pnpm smoke:prod` (`tooling/scripts/smoke-prod.ts`) — read-only assertion of the whole surface,
  including that every disabled seam reports its state *explicitly*.
