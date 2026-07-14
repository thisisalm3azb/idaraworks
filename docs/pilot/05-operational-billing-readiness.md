# Pilot Guide 05 — Operational Billing Readiness (No-Real-Payments Pilot)

> **Audience:** the operator running a pilot, and the Owner who signs off on commercial go-live.
> **Premise:** this pilot takes **NO real money.** The full commercial stack (subscription state machine, entitlements, usage metering, dunning, the customer subscription UI, support impersonation) is **production-operational and governed today** — but every path that would move real funds is **disabled behind the D1 activation gate.** This guide states exactly what is safe-live vs disabled, how the gate is enforced in code, and the Owner steps that remain open.
> **What "billing" means here:** two distinct layers — (a) **platform billing**, IdaraWorks charging the *pilot org* a subscription (S9, gated by D1); and (b) **tenant invoicing**, the pilot org billing *its own customers* with quotes/invoices/VAT (S6). This guide covers both; the two must not be confused.

---

## 0. TL;DR

- **Platform billing (IdaraWorks → pilot org):** provider seam ships **disabled in production** (`isProd()` selects the disabled adapter). No checkout, no portal, no real webhook is ever accepted. The customer subscription page renders a **"commercial activation unavailable"** state that hides every Buy/checkout action. **This is the intended pilot posture — leave it off.**
- **Tenant invoicing (pilot org → its customers):** quotes/invoices/payments/AR are **fully live and safe** — they are the pilot org's own bookkeeping, not IdaraWorks charging anyone. **VAT is org-configured** and **e-invoice government submission is disabled** until a certified partner (D4).
- **Metering + entitlements run live** during the pilot (they gate *ability to add*, never reads/exports — FR-9) but **enforce placeholder limits** until D3 pricing numbers are set.
- **Read-only billing states** (`suspended`/`cancelled`/`purge_pending`/`purged`) are enforced at the mutation chokepoint; a pilot org normally sits in `internal_pilot` or `trialing` and never hits these.
- **[OWNER ACTION] items:** D1 (entity + merchant of record), D3 (pricing/limit numbers), tax mechanism + PB-3 accountant VAT sign-off, D4 (e-invoice partner). None block the pilot; all block *real charging*.

---

## 1. Safe-disabled vs live — the matrix

| Capability | Layer | Pilot state | How enforced |
|---|---|---|---|
| Subscription state machine (`internal_pilot`→…→`purged`) | platform | **LIVE** (governed, no real money) | `src/modules/subscription/machine.ts`; DB sole-writer `app.advance_subscription` (`assert_platform_task`-guarded) |
| Real checkout / billing portal | platform | **DISABLED** | `disabledBillingProvider` in prod; `startCheckout` throws `BillingProviderDisabledError` |
| Inbound billing webhooks | platform | **DISABLED** (accepts nothing) | disabled adapter `verifySignature()` → `false`; route `/api/billing/webhook` |
| Usage metering (`usage_event`) | platform | **LIVE** | `src/modules/subscription/usage.ts` (append-only, idempotent, UTC-period) |
| Entitlement enforcement (feature/limit gates) | platform | **LIVE** (placeholder limits) | `src/platform/entitlements/resolve.ts`; `checkLimit`/`checkMeteredLimit` |
| Read-only enforcement in non-paying states (FR-9) | platform | **LIVE** | `command()` chokepoint + `signUpload`; `assertTenantWritable` |
| Support impersonation (consent / break-glass) | platform | **LIVE**, dual-logged to tenant audit | `src/modules/support/service.ts` |
| Plan price book (`plan_price`) | platform | **LIVE but PLACEHOLDER** (`is_placeholder=true`) | seeded in `0052`; edited only by `app.set_plan_price` (platform-staff-gated) |
| Quotes / invoices / payments / AR | tenant | **LIVE** (pilot org's own books) | S6 modules; money in bigint minor units |
| VAT calculation | tenant | **LIVE**, org-configured | `app_settings 'finance.vat_registered'` + per-line `vat_rate` + `is_export` |
| E-invoice / ZATCA government submission | tenant | **DISABLED** in prod | `disabledProvider` in `src/platform/einvoice/adapter.ts` until D4 |

---

## 2. The D1 activation gate — what stays OFF, and why it is a pure activation step

**[OWNER ACTION] D1 — incorporation & merchant of record.** Per `phase2/00-INDEX.md`, D1 blocks *"Stripe wiring … and the DPA/data-residency final choice"* but **"does NOT block any schema or capability design."** S9 therefore shipped the **entire governed commercial logic** behind a provider seam that is **disabled in production**. Enabling a real merchant is a pure activation step — **supply secrets + provider price IDs + a real adapter behind the same interface — with no schema or logic change** (`docs/S9-COMMERCIAL-COMPLETION.md`).

**What must remain OFF for a no-real-payments pilot:**

- **Real merchant / processor** — no Stripe/Tap/Paddle/etc. adapter is wired; the default in prod is `disabledBillingProvider`.
- **Checkout & billing portal** — `startCheckout`, `createPortalSession`, `changePlan`, `cancelSubscription` all throw `BillingProviderDisabledError` while the provider is disabled.
- **Real inbound webhooks** — `/api/billing/webhook` reads the raw body and calls `processSubscriptionWebhook`; while disabled the adapter's `verifySignature` returns `false`, so **the endpoint accepts nothing.** No unsigned or forged event can move billing state.
- **Any real charge.**

> **Critical S10 note (do not skip):** the disabled default is keyed on `isProd()` (`APP_ENV === "prod"`). Before S10 the guard checked a string that was never set, so **production was silently serving the FAKE provider** (a fake checkout shown as enabled). This was found and fixed — the prod-provider guard now centralises on `isProd()` and a regression asserts billing, e-invoice, and AI-narration all disable in prod (`docs/S10-HARDENING-COMPLETION.md`). **Verify at pilot start:** `/api/health` reports the deployed commit, and the subscription page shows "commercial activation unavailable." If you ever see a live Buy button in prod, stop — the env guard is wrong.

### 2.1 Provider selection & env vars

From `src/platform/billing/adapter.ts` (`getBillingProvider()`):

- `BILLING_PROVIDER=disabled` → disabled adapter (explicit; the correct pilot setting in prod).
- `BILLING_PROVIDER=fake` → deterministic fake (dev/test/demo only — **never in prod**).
- **Unset in production → disabled** (the D1 default). Unset off-prod → fake.
- `BILLING_FAKE_WEBHOOK_SECRET` — HMAC secret for the fake provider's signed webhooks (dev/test only).
- `APP_ENV` — `dev | preview | prod`; **`prod` is what flips every seam to its disabled default.**

At D1 activation (later, not for this pilot): add a real adapter behind `BillingProvider`, set `BILLING_PROVIDER` to it, and load the processor's signing secret + **per-currency provider price IDs** into the secret store. **[OWNER ACTION]** — secrets live only in the secret store, never in repo/logs/chat.

---

## 3. Price book, tax & VAT — Owner configuration steps

### 3.1 Plan price book (platform billing) — **[OWNER ACTION] D3**

- `public.plan_price` is the provider-neutral price book: per **plan × interval × currency**, in **minor units**, versioned (supersede-not-mutate). Migration `0052` seeds **placeholder** rows for Starter/Growth/Business × month/year in **AED + USD**, all `is_placeholder = true`.
- The customer subscription page shows these prices marked **indicative/placeholder** — they are never presented as final while `is_placeholder`.
- Editing prices is a **platform operation, not a tenant Owner action**: `app.set_plan_price(...)` requires **active `platform_staff`** and `assert_platform_task()`. A used price row is never mutated in place — a new version is inserted and the old one deactivated.
- **[OWNER ACTION] D3 — pricing numbers + tier limit values.** Entitlement *keys* are final; the *values* (plan prices and per-tier limits) are placeholders until D3 is decided (`phase2/09-entitlements-config-schemas.md`; `docs/S9-COMMERCIAL-COMPLETION.md`). For a no-real-payments pilot you can leave placeholders in place — nothing charges — but do **not** switch `is_placeholder=false` or activate a provider until D3 numbers are ratified.

### 3.2 Tenant VAT / tax (the pilot org billing its customers)

This is the layer the pilot org actually uses day-to-day, and it **is** org-configurable:

- **Org VAT registration flag** — stored as `app_settings` key **`finance.vat_registered`** (default **true** = VAT-registered). A non-registered org issues **zero-VAT invoices** (VAT-disabled mode). This same setting drives the costing engine's VAT basis, so the two never disagree.
- **Per-line `vat_rate`** — captured on each quote/invoice line (0–100%). VAT is recorded **per line, never assumed** (bigint minor units).
- **`is_export` zero-rating** — an export supply is zero-rated regardless of registration.
- **Effective VAT** = applies only when the org is VAT-registered **and** the supply is not an export (`computeInvoiceTotals`, `src/modules/invoices/service.ts`).
- **Base-currency freeze at issuance** — multi-currency invoices freeze the base amount + an immutable `exchange_rate` at issuance (OP-8). Issued invoices are **immutable**; corrections are `credit_note` rows, never a post-issuance cancel.

**[OWNER ACTION] Tax mechanism + PB-3 accountant VAT sign-off.** Which VAT base the org uses and whether it is VAT-registered is an owner/accountant decision. Both VAT bases are built and golden-tested; **PB-3** is the accountant's ratification of the choice before the pilot org issues real invoices (`docs/S6-BILL-COMPLETION.md`). Set `finance.vat_registered` and the standard line `vat_rate` to match that decision.

### 3.3 E-invoice / government submission — **[OWNER ACTION] D4**

- The e-invoice adapter (`src/platform/einvoice/adapter.ts`) is a provider-agnostic seam. `EINVOICE_PROVIDER` selects it; off-prod defaults to a deterministic **fake** (contract-tested, including the ZATCA reject path), **prod defaults to `disabled`.**
- **No real government submission can occur** without a certified partner + credentials (D4/FR-16). For the pilot, invoices are fully issued and tracked internally; the e-invoice *clearance* step is a no-op recorded as `disabled`. Leave it disabled.

---

## 4. Metering & entitlement behaviour during the pilot

Both run **live** and are safe — they never touch money and never block reads.

- **Metering** (`usage_event`, migration `0054`): append-only, **idempotent** per `(org, meter, dedup_key)` (a duplicate delivery inserts nothing), **period-aware** (UTC month buckets), **reconcilable** (current value = `sum(delta)`; corrections are negative rows, never edits). A tenant may only meter its own org; the INSERT policy requires `delta >= 0` (migration `0062`, so a tenant can't self-deflate a metered limit).
- **Entitlements** (`resolveEntitlements`): plan values + per-org overrides, cached per-instance with a **60s TTL** (a stale read self-heals within one TTL; cross-instance push-invalidation is the documented scaling step). Feature keys are boolean capability gates; limit keys are numeric caps (`null` = unlimited).
- **The FR-9 law:** `checkLimit` / `checkMeteredLimit` govern the ability to **ADD**, never to **read or export.** An over-limit org loses the ability to add one more, and always keeps full read + self-service export.
- **Pilot caveat:** limits enforced today are the **placeholder** tier values (D3). If the pilot bumps a placeholder cap, that's a *placeholder* cap, not a commercial one — either raise it via a per-org entitlement override or accept the placeholder. Do not treat a placeholder-limit block as a real plan boundary.
- New orgs default to a **full-featured Growth trial** (`DEFAULT_PLAN = growth`), which is the right generous posture for a pilot.

> Known minor (documented, non-blocking): `checkMeteredLimit` has a soft TOCTOU — it is a trial-abuse counter, not a hard security gate (`docs/S9-COMMERCIAL-COMPLETION.md`). Irrelevant to a no-payments pilot.

---

## 5. Read-only commercial states (FR-9)

A pilot org normally lives in `internal_pilot` or `trialing` and never becomes read-only. But the states exist and are enforced, so know them:

- **Read-only states:** `suspended`, `cancelled`, `purge_pending`, `purged` (`READ_ONLY_BILLING_STATES`, `src/platform/entitlements/resolve.ts`).
- **What read-only means:** the workspace can still **SEE and EXPORT everything**; it cannot **ADD/mutate.** "Read-only, not lockout; never delete data" (FR-9).
- **Where it's enforced:** centrally at the **`command()` chokepoint** (every audited tenant mutation) plus `signUpload` (which bypasses `command`). **This was an S10 fix** — pre-S10 `assertTenantWritable` existed but no production write path called it, so "read-only" was a cosmetic badge; it is now enforced at the chokepoint with a regression test (a suspended org's `createCustomer` is rejected, a read still works, recovery restores writes) (`docs/S9-...` finding #1 + `docs/S10-...`).
- **Reads/exports are never blocked** by entitlements or by a read-only state — verify this holds in the pilot (self-service export at `/api/o/{orgId}/export` and `/o/{orgId}/settings/export` must work regardless of billing state).

---

## 6. Subscription lifecycle & placing a pilot org

### 6.1 The state machine

`internal_pilot → trialing → active → past_due → grace → suspended → cancelled → purge_pending → purged` (`src/modules/subscription/machine.ts`). Key laws:

- **Driven by provider events (or the platform lifecycle sweep), never by a client claim.** A tenant request can never flip billing state — `app.advance_subscription` is `assert_platform_task`-guarded.
- **`purged` is terminal**; a **legal hold** refuses purge.
- **Plan change is not a state transition:** upgrade applies immediately, downgrade is scheduled to period end, **data is never deleted** — an over-limit org just loses ADD.
- **Failed-payment ladder** (only relevant once a real provider is live): `active → past_due → grace → suspended`, with dunning reminders at 0/50/90%.

### 6.2 Placing a pilot org (no-payments posture)

- The intended pilot state is **`internal_pilot`** (platform-managed pilot org) or a **`trialing`** Growth trial. Both keep the provider linkage `null` and never require a merchant.
- Billing state is set only through the platform path (`app.advance_subscription`, platform-staff/task context) — it is **not** a tenant Owner action, by design.
- The two protected production orgs (Alpha Marine, TESTING) sit at `plan=growth, state=trialing, provider=null` — the reference posture for a clean pilot org.
- The lifecycle cron (trial expiry, dunning, purge scheduling) is **dormant until Inngest keys are provisioned** — which is fine and desirable for a no-payments pilot (you don't want trials auto-expiring an org mid-pilot). If you *do* enable Inngest for the exception sweep, be aware the lifecycle sweep shares the fleet; keep pilot orgs in `internal_pilot` (no trial deadline) so the sweep can't suspend them.

### 6.3 Support impersonation (available during the pilot)

Consent-gated **or** break-glass, platform-staff-gated, and **dual-logged to the tenant's own audit log** (tenant-readable for transparency), with a **persistent impersonation banner** in the UI (`src/modules/support/service.ts`). Safe to use for pilot support; the tenant always sees it happened.

---

## 7. Pre-pilot verification checklist

- [ ] `APP_ENV=prod` on the deployed env; `/api/health` returns the expected deployed commit.
- [ ] `BILLING_PROVIDER` is **unset or `disabled`** in prod (NOT `fake`).
- [ ] Subscription page (`/o/{orgId}/settings/subscription`) shows **"commercial activation unavailable"** — no Buy/checkout/portal button.
- [ ] `POST /api/billing/webhook` with any body is rejected (disabled adapter verifies nothing).
- [ ] E-invoice provider resolves to `disabled` in prod (no government submission).
- [ ] Tenant VAT: `finance.vat_registered` set to the accountant's (PB-3) decision; a test invoice computes VAT per line; an `is_export` line is zero-rated; a non-registered org issues zero-VAT.
- [ ] Issued invoice is immutable; a correction creates a credit note; AR outstanding = sum of aged buckets and never negative.
- [ ] Metering: same event twice records once; over-limit blocks ADD but a read + `/api/o/{orgId}/export` still work.
- [ ] Read-only enforcement: (in a scratch org) a `suspended` state blocks `createCustomer` at `command()`, a read still works, recovery restores writes. Do **not** run this on a real pilot org.
- [ ] Pilot org sits in `internal_pilot`/`trialing`, `provider=null`.
- [ ] `plan_price` rows remain `is_placeholder=true`; no real provider price IDs loaded.

---

## 8. Owner / operator action summary

| Item | Type | Blocks the pilot? | Blocks real charging? |
|---|---|:--:|:--:|
| **D1** — entity + merchant of record (+ real adapter, secrets, price IDs) | **[OWNER ACTION]** | No | **Yes** |
| **D3** — pricing numbers + per-tier limit values | **[OWNER ACTION]** | No | **Yes** (before real invoicing) |
| **Tax mechanism + PB-3 accountant VAT sign-off** | **[OWNER ACTION]** | No (set the flag) | Gates the pilot org issuing real customer invoices |
| **D4** — certified e-invoice partner + credentials | **[OWNER ACTION]** | No | Gates government submission |
| Inngest keys (lifecycle + nightly + dunning crons) | **[OWNER ACTION]** | No (dormant is fine) | — |
| DPA / PDPL posture (esp. before any KSA pilot) | **[OWNER ACTION]** (owner/legal) | Depends on data-residency choice | — |
| First restore drill + incident tabletop (evidence filed) | **[OWNER ACTION]** (pre-pilot) | Recommended before go-live | — |

**None of the [OWNER ACTION] items block a no-real-payments pilot.** They are all gates on moving real money or real government/e-invoice submission. Keep the provider disabled, keep prices placeholder, set the tenant VAT flag to the accountant's decision, and the pilot runs the full governed experience with zero financial risk.

---

## 9. Source-of-truth references

- Billing seam: `src/platform/billing/adapter.ts`; webhook route: `src/app/api/billing/webhook/route.ts`.
- Subscription: `src/modules/subscription/{machine,service,usage,windows}.ts`; DB sole-writer `app.advance_subscription` (migrations `0052`–`0060`, `0062`).
- Entitlements: `src/platform/entitlements/{catalogue,resolve}.ts`.
- Tenant invoicing/VAT: `src/modules/invoices/service.ts`, `src/modules/quotes/service.ts`; e-invoice: `src/platform/einvoice/adapter.ts`.
- Support: `src/modules/support/service.ts`. Export: `src/app/api/o/[orgId]/export/route.ts`. Health: `src/app/api/health/route.ts`.
- Governance & evidence: `phase2/00-INDEX.md` (D1/D3/D4), `phase2/09-entitlements-config-schemas.md`, `docs/S6-BILL-COMPLETION.md`, `docs/S9-COMMERCIAL-COMPLETION.md`, `docs/S10-HARDENING-COMPLETION.md`; runbooks in `runbooks/` (deployment-and-rollback, inngest-provisioning, restore-drill, incident-response, break-glass).
