# S9 — Commercial Wiring — Completion Report

**Status:** COMPLETE (pre-D1 activation boundary) · deployed `<FINAL_COMMIT>` · CI green · Arabic DoD demo PASS · production baseline restored.
**Date:** 2026-07-14 · **Objective (verbatim):** "the business can charge money and support customers governably."

## D1 verdict — activation gate, not an implementation gate

`phase2/00-INDEX.md` defines D1 (incorporation & merchant of record) as blocking "Stripe wiring and the
DPA/data-residency final choice" but **"does NOT block any schema or capability design."** So S9 ships the
**full governed commercial logic now**, behind a provider seam **disabled in production**. Enabling a real
merchant is a pure activation step (secrets + price IDs + a real adapter behind the same interface) — **no
schema or logic change**.

## What shipped

- **Subscription state machine** (v1 §13): `internal_pilot → trialing → active → past_due → grace →
  suspended → cancelled → purge_pending → purged`. Transitions are **driven by provider events, never client
  claims** — the DB sole-writer `app.advance_subscription` is `assert_platform_task`-guarded, so a tenant
  request can never flip billing state. `purged` is terminal; a **legal hold** refuses purge (v1 §12).
- **Provider-neutral adapter** (`platform/billing`): fake (deterministic, HMAC-signed webhooks) + **disabled
  prod** default. Inbound webhooks are **signature-verified** (closes the doc-10 gap) and **idempotent** (a
  unique `(provider, event_id)` inbox); duplicate + out-of-order events are no-ops.
- **Lifecycle workers** (platform, dormant cron): a deadline sweep (expire trials, walk the dunning ladder,
  schedule/execute purge — per-org fault-isolated), dunning reminders (0/50/90%, tenant-visible), and
  **reconciliation** (local↔provider drift → recorded, never auto-overwritten).
- **Upgrade/downgrade**: upgrade immediate; downgrade scheduled to period end. **Never deletes data** — an
  over-limit org loses the ability to ADD (`checkMeteredLimit`/`checkLimit`), never to read/export (FR-9).
- **Usage metering** (append-only `usage_event`): idempotent (dedup unique), concurrency-safe, period-aware
  (UTC), reconcilable (sum-of-deltas; corrections are negative rows).
- **Support impersonation** (v1 §13): consent-gated **or** break-glass, platform-staff-gated, **dual-logged
  to the tenant's own audit log** (the 2nd DoD AC), tenant-readable for transparency.
- **Commercial catalogue**: `plan_price` price book (bigint minor units, `is_placeholder=true` pending D3,
  versioned/superseded-not-deleted), platform-staff-gated edit.
- **UI** (en/ar/RTL/375px): the customer subscription page — plan + state, trial/period end, **indicative**
  price book, upgrade/downgrade/cancel (owner-only), a **persistent support-impersonation banner**, and a
  **"commercial activation unavailable"** state that hides every Buy/checkout action while the provider is disabled.
- **Platform wiring**: `billing.view` (owner/admin/accounts) + `billing.manage` (owner-only) in both matrix
  transcriptions; the lifecycle cron registered in the worker fleet; bleed seeders for the 5 new org-scoped tables.

## Migrations (hosted Seoul DB now at 0000–0059)

`0052` subscription lifecycle fields + `plan_price` · `0053` webhook inbox + DEFINER sole-writer path ·
`0054` `usage_event` + `record_platform_audit` · `0055` `resolve_subscription_org` · `0056` `platform_staff`
+ impersonation · `0057` dunning + reconciliation · `0058` platform scans + `set_plan_price` · `0059`
legal-hold purge guard. **No DELETE grants** (D-1.7); every tenant table has RLS in-file; provider ids /
secrets never in a public payload.

## Adversarial review (5-lens + per-finding verification)

<REVIEW_SUMMARY>

## Gates

format ✓ · lint 0 errors ✓ · typecheck ✓ · **unit 299/299** (machine 12 + adapter 5 + …) · build ✓ ·
**S9 hosted integration 20/20** (subscription 7 · impersonation 4 · lifecycle-worker 5 · plan-change 4) ·
**bleed 2/2** (5 new tables isolated) · **full integration + e2e green on GitHub CI** · deployed commit confirmed by prod health.

## Production DoD demo (Arabic, `tooling/scripts/s9-prod-demo.ts`)

Synthetic org **قوارب الاشتراك** (Alpha Marine + TESTING never touched): plan catalogue; trial → active;
usage metered + **hard limit at the service boundary**; upgrade immediate + downgrade scheduled (data
preserved); dunning ladder → suspended + **read-only enforced (FR-9)**; recovery; duplicate + out-of-order
events idempotent; reconciliation drift recorded; cancel + sweep → purge_pending; **support session in the
tenant's own audit log**; platform/org separation; **real activation DISABLED**. **DoD PASS · 0 leftovers.**

## Feature classification (per the completion gate)

- **Production-operational now:** subscription state machine, entitlement + usage enforcement, the commercial
  catalogue (indicative prices), the customer subscription UI + disabled-checkout state, support impersonation
  (consent/break-glass/dual-log), reconciliation tooling, the dormant lifecycle cron. All governed, all live.
- **D1-gated (built, disabled in prod):** the real payment adapter (checkout/portal/webhook ingress), the live
  webhook source, any real charge. Enabled by supplying secrets + price IDs + a real adapter — no schema/logic change.
- **Credential-gated activation (owner, in the secret store — never in repo/logs/chat):** merchant/provider
  secrets, per-currency provider price IDs, the Inngest keys that turn the lifecycle cron live.
- **Owner decisions still open:** D1 (entity + merchant of record — leaning UAE + Stripe, unverified), D3
  pricing numbers + tier limit values (all seeded values are placeholders), tax mechanism, KSA lawful-transfer
  basis before any KSA pilot. **DPA/PDPL posture** doc (doc 10 #43) is an owner/legal deliverable.

## Notifications & telemetry (governance-appropriate MVP)

Subscription changes + impersonation + dunning write the **tenant-visible audit + activity** trail (done);
redacted email/push notifications ride the **existing disabled notification seam** (D1-gated). Pilot telemetry
uses the existing `/api/health` per-dependency observability + the audit trail; per-tenant metric **dashboards**
are sequenced into **S10 Hardening** (not a pre-D1 blocker).

## Alpha Marine & TESTING

Never read for deletion or written by S9 build, tests, or demo. Only S9 synthetic data is removed at close;
pre/post baseline = [Alpha Marine, TESTING].
