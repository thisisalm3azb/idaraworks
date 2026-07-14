<!-- S9 scope freeze — synthesized from all authoritative governance sources (workflow wf_59f20402-10b). Informational; the build follows this. -->

# S9 "Commercial Wiring" — Consolidated Scope Freeze

**Slice:** S9 · **Effort:** 3 build-weeks · **Sequenced deliberately late** · **Objective (verbatim):** "the business can charge money and support customers governably."

**Governing ruling (do not contradict):** D1 (incorporation & merchant of record) is an **ACTIVATION gate, not an implementation gate**. Per `phase2/00-INDEX.md`, D1 blocks "Stripe wiring (slice S9) and DPA/data-residency final choice" but "does NOT block any schema or capability design." Therefore S9 builds the **full governed commercial logic now** behind a **provider seam that is DISABLED until D1 closes** (fake adapter in dev/test; disabled prod adapter). This mirrors §20 Q3: D1 "blocks billing implementation, not module code."

Money is in **bigint minor units** throughout (Bible §4.9). Where sources conflict, contradictions are flagged inline with **⚠ CONTRADICTION**.

---

## A. S9 Scope Freeze — the 22 required items

### (1) Official name + business outcome
- **Name:** S9 — Commercial Wiring.
- **Outcome:** IdaraWorks can (a) charge tenants for their SaaS subscription governably, and (b) support tenants via consent-gated, dual-logged impersonation. This is the **only slice hard-blocked by legal paperwork** (D1/OA-5).

### (2) Commercial workflows in scope
- Trial start (self-serve, no card) → paid conversion → active subscription.
- Upgrade (immediate, prorated) / downgrade (at period end).
- Failed-payment dunning → grace → read-only suspension → recovery.
- Cancellation → read-only export window → scheduled purge (two warnings) → purge.
- Support impersonation (consent-gated, banner, dual-logged) + break-glass.
- Admin commercial config (plans/catalogue/price-book) — provider-neutral data now, provider IDs deferred to D1.
- Pilot + commercial telemetry (metrics, per-card Today instrumentation, per-tenant egress metric).

### (3) Definition of Done / Acceptance Criteria
- **`trial → paid → past_due → recovery` lifecycle demonstrated on a test org** (Bible S9 AC).
- **A support session is visible in the tenant's own audit log** (dual-log AC).
- Mandated tests green: billing-webhook state-machine (every transition + idempotent replays), impersonation banner/log assertions, entitlement downgrade semantics (**block adds, never block reads**).
- Full §17 DoD gate per feature: spec-cited requirements met · test classes green (golden/bleed/matrix where touched) · security-review label (money/authz/files/AI/share) · perf within budget · docs/spec amendment · **two-org bleed harness green with new entities seeded** · mobile 375px · RTL+Arabic · audit/activity trail correct for every new mutation · indexes+EXPLAIN for hot queries · telemetry events added.

### (4) D1 requirements + activation boundary
- **Owner action OA-5 / OP-1:** "Start incorporation/merchant process (legal lead time; **blocks S9, not S0**)." D1 = "incorporation & merchant of record."
- **Activation boundary:** everything except *payment-processor integration, per-currency price IDs, the tax mechanism, and the live webhook source* is built and shipped now. The provider adapter ships **disabled in prod** and is exercised only by the **fake adapter** in dev/test. Flipping D1 = supplying secrets + price IDs + enabling the real adapter; **no schema or logic change** should be required at activation.

### (5) Plans + pricing model
- **Shipped tiers (DB-seeded):** `starter` (Starter, sort 1), `growth` (Growth, sort 2), `business` (Business, sort 3). `DEFAULT_PLAN = growth`; every new org starts **growth / trialing**.
- **Placeholder seeded limits (pending D3 — keys final, numbers not):** `full_users` 5/15/40 · `active_jobs` 10/40/150 · `storage_gb` 25/100/500 GB · `ai_credits_month` 2000/8000/30000 · `field_users` & `viewer_users` unlimited on all tiers.
- **Capabilities are additive:** Growth = Starter core + P3 capabilities as released; Business = Growth + API/builders/multi-company.
- **Pricing-model leaning (D3):** flat company tiers + per-seat only for full users + free/cheap (or unlimited) field seats. Numbers ride on D3.
- **⚠ CONTRADICTION — plan count:** v1 §13 names **five** plans (`Free-trial, Starter, Growth, Business, Enterprise-custom`); doc 09 and the shipped code define **three** (`starter/growth/business`). S9 must decide whether "Free-trial" is a real plan row or just the `trialing` state on `growth` (the shipped code models it as state, not plan), and whether `Enterprise-custom` is a plan row now or a later `org_entitlement_override` bundle. Recommend: keep 3 plan rows; model trial as state; represent enterprise as override bundle until an E-tier exists.

### (6) Subscription states + transitions
**⚠ CONTRADICTION — three different state sets across sources. Reconcile in S9:**
- **v1 §13 (full ordered):** `trialing → active → past_due → grace → suspended → cancelled → purge_pending → purged`, plus `paused` "if offered."
- **Shipped DB CHECK (`org_plan_state.billing_state`, 0005):** `internal_pilot, trialing, active, past_due, grace, suspended, cancelled` — has `internal_pilot` (not in v1 §13), **lacks** `purge_pending`, `purged`, `paused`.
- **Bible S9 deliverable:** `trial → active → past_due → grace → suspended`.

| State | Entered when | Effect | Window |
|---|---|---|---|
| `internal_pilot` | Platform-set (shipped) | Pilot org, not billed | n/a |
| `trialing` | Signup (no card) | Full-featured **Growth** access | **14 days** |
| `active` | Payment succeeds / trial converts | Full paid access per resolved entitlements | — |
| `past_due` | Payment fails | Stripe smart retries + dunning emails, **NOT locked out** | **~14 days** |
| `grace` | Retries exhaust | Short recoverable buffer before read-only | ⚠ no separate day-count given |
| `suspended` | Dunning window elapses | **Read-only, not lockout** (still see + export) | — |
| `cancelled` | Customer cancels / terminal non-payment | Read-only + exportable | **recommend 60 days** |
| `purge_pending` | Read-only window scheduled to end | Scheduled purge, **two warning emails** | — |
| `purged` | Purge executes | Data destroyed (subject to backup rotation + legal hold) | — |
| `paused` | Optional, "if offered" | Not committed for v1 | — |

- **Hard rule:** transitions are **"driven by Stripe webhooks, never by client claims."** The codebase must never contain `if (plan === 'pro')`.
- **⚠ AMBIGUITY (from source):** the ordered list has `grace` distinct from `suspended`, but prose collapses the failed-payment path to "~14 days (`past_due`), then read-only suspension." No separate day-count for `grace`. Interpretation to confirm at build: `past_due` = active retries/dunning; `grace` = short recoverable buffer after retries exhaust; `suspended` = read-only.

### (7) Trial + abuse controls (audit F-26/F-27; doc 10 #32)
- **14-day full-featured Growth-tier trial, no credit card.** Trial→paid conversion is "*the* metric of the whole business."
- **`feat.ai_onboarding`** stays free but **hard-capped per org (~30 LLM calls)** via `limit.ai_onboarding_calls` (added in 0050).
- Per-IP / per-device signup throttle + **disposable-email screening**.
- Platform-level **daily AI-spend circuit breaker** (`app.platform_daily_ai_spend()` RPC, 0051).
- `trialing` orgs get **deterministic digest only (no narration)**, a **small storage quota**, **short signed-URL TTLs**, and **per-org upload rate limits**.
- Rate limits: auth (strict), AI endpoints (credit + rate + trial-abuse), general per-user/org — CI + PEN.

### (8) Entitlements / limits / meters
- **Feature keys — MVP `cap.*`:** `cap.jobs` (always on), `cap.daily_reports` (always on), `cap.issues`, `cap.approvals`, `cap.procurement`, `cap.quoting`, `cap.invoicing`, `cap.expenses_costing`, `cap.customers`, `cap.people`, `cap.customer_updates`, `cap.week_plan`.
- **Feature keys — P3+ `cap.*` (as released):** `cap.inventory`, `cap.qc`, `cap.contracts`, `cap.assets`, `cap.api`, `cap.workflow_builder`, `cap.report_builder`, `cap.white_label`, `cap.multi_company`.
- **Behaviour `feat.*`:** `feat.ai_narration`, `feat.ai_drafts`, `feat.ai_onboarding` (always-on, free — funnel), `feat.custom_fields`, `feat.org_terminology_overrides`, `feat.audit_export`, `feat.sso` (E-tier, later).
- **Limit keys:** `limit.full_users`, `limit.field_users` (null=unlimited every tier), `limit.viewer_users` (unlimited, F-11), `limit.active_jobs`, `limit.storage_gb` (warn 80% / block-adds 100% / never block reads), `limit.ai_credits_month` (narration/drafts/conversation only; **deterministic analytics never metered**, D-4), `limit.ai_onboarding_calls`, `limit.custom_fields_per_entity`, `limit.presets`, `limit.exception_rules_tuned` (soft).
- **Gating model (D-9.1):** capabilities gate by feature key; scale gates by limit key; **field seats are never limited**.
- **AI-credits sub-system:** metered per org/month; per-tier allowance; visible meter in settings; **top-up add-on**; every AI call records **org, feature, tokens, cost**.
- **⚠ CONTRADICTIONS (catalogue drift — reconcile in 0052 catalogue update):**
  - `cap.week_plan` is in doc 09's MVP set but **NOT in the shipped 17-key `FEATURE_KEYS`**. Add it, or record it as deferred.
  - `feat.sso` and P3+ `cap.*` (inventory/qc/contracts/assets/api/workflow_builder/report_builder/white_label/multi_company) are in doc 09 but **not yet in code** (code enables the full feature set on all tiers, gated by release not tier).
  - `limit.exception_rules_tuned` is in doc 09 but **not in the shipped 9-key `LIMIT_KEYS`**.
  - v1 §13's generic limit names (`limit.users`, `limit.active_projects`, `limit.automation_runs_month`) are **superseded** by doc 09 / code (`limit.full_users`, `limit.active_jobs`, …). `limit.automation_runs_month` has **no counterpart** in code — decide whether to introduce it or drop it.

### (9) Upgrade / downgrade
- **Upgrades: immediate, with proration.**
- **Downgrades: apply at period end.**
- **Never-delete-data rule (verbatim):** "if the org exceeds the lower plan's limits, nothing is deleted — the org keeps read access to everything and loses the ability to add until within limits."

### (10) Cancellation / grace / failed-payment
- Failed payment: `past_due` retries+dunning ~14 days → `grace` buffer → `suspended` read-only.
- Cancellation: read-only + exportable **~60 days** → `purge_pending` with **two warning emails** → `purged`.
- Distinct from account-closure pipeline: **soft-delete recycle bin = 30 days, admin-restorable** (in-app mistakes, not account closure).
- **Legal hold** = org/entity-level flag that **suspends all deletion pipelines**; must be checked before any purge.
- **Suspension is read-only, never a hard lockout** (FR-9 LAW: never block reads/exports).

### (11) Merchant / provider boundary
- **Provider-neutral by design.** Five candidate processors: **Stripe** (direct billing, not MoR; UAE supported, **KSA not supported — needs confirmation**), **Paddle** (MoR, ~5%+fees), **Lemon Squeezy** (MoR, ~5%+fees), **Tap** (local GCC + manual tax), **Moyasar** (local GCC + manual tax).
- **Leaning:** UAE entity + Stripe — **explicitly unverified**; confirm Stripe country support at decision time. "Reversible but annoying to change; make it with the incorporation decision."
- **Implication:** webhook-driven state machine + provider-agnostic plan/price-book data so the merchant is swappable.

### (12) Checkout / portal / webhook
- Checkout + customer portal + webhook ingress are **provider-specific** → built against the **fake adapter** now; real wiring deferred to D1.
- **Webhook rules:** idempotency key + idempotent replay proven in tests (Bible §8.11); **Zod validation at the webhook boundary** (§6.9); payload **carries `org_id`, worker must re-resolve + re-verify** before touching data (§5.1); state machine integration-tested against a real DB (§13.5).
- **⚠ GAP (doc 10):** there is **no checklist item for inbound webhook signature verification** and **no PCI / no-card-data-stored item**. Both are genuine gaps for S9; add new items to the living checklist (#51).

### (13) Relationship to S6 billing
- **S9 depends on S6.** They are **distinct money surfaces:** S6 = the tenant billing *their own customers* (quotations/invoices/payments/costing); S9 = the **platform billing the tenant** for the SaaS subscription.
- Both carry the **money-path review label** (P7: golden-file tests + 2-approval security-labelled review + audit coverage). Amounts are `bigint` minor units with explicit `vat_amount`.
- **L4 isolation:** commercial/billing/entitlement code lives in L4; execution modules must not import it — "money looks at work; work never looks at money."
- **External pen test** (doc 10 #51) is **booked by S6** (lead time), scoped to items 1–14, 15–22, 27, 30 — before public launch.

### (14) Admin commercial config
- Plan/catalogue/price-book editing is **owner-only** (doc 10 #21: billing actions owner-only; Owner role irremovable by Admin — CI).
- Catalogue rows (`plan`, `plan_entitlement`, `entitlement_def`) are **platform-only writes** today (no app_user grant); S9 adds a governed platform write path (SECURITY DEFINER RPC or platform role).
- Config artifacts written **only via validate→preview→revision pipeline** (v1 §15); shared **config-string sanitiser** (F-25) on every tenant string.

### (15) Tax / currency / pricing config
- **Currency on the org** (Bible §4.9); **no floats**.
- **Price books per currency/region**, promo codes, and enterprise contracts (custom plan rows + invoiced billing) fit the model with **no new architecture** — but per-currency **price IDs are D1-blocked**.
- **Tax mechanism is provider-determined and D1-blocked:** Stripe Tax (self-handled) vs Paddle/LS MoR (VAT absorbed) vs local gateway (manual tax handling).
- Monetary config params (ExceptionThresholdSet, ApprovalRuleSet `amount_gte`, JobPreset billing points) in **org minor units** (U6, F-1).

### (16) Permissions / roles
- **`can(ctx, action, resource?)` is the only authz check, deny-by-default**, closed vocabulary (Bible §6.2).
- **Billing actions owner-only; Owner role irremovable by Admin** (doc 10 #21 — CI).
- Full-user archetypes (Owner/Admin/Manager/Procurement/Accounts) count against `limit.full_users`; **field (Foreman) + viewer seats unlimited**.
- **Cost redaction at every serialization boundary** (doc 10 #17, F-23) — Today composer, approval summaries, push bodies, digests, exports — applies if S9 surfaces pricing/cost.

### (17) Events / workers
- **One command = one transaction; cross-module effects via the event bus *after* commit** (§4.12). Domain events are past-tense facts (e.g. `invoice.paid`), org-scoped, versioned, **consumers idempotent** (§8.6).
- **No network calls (Stripe, email, storage) inside a DB transaction** (§8.8).
- **Dunning/background handlers: idempotent (keyed), org-scoped, bounded runtime, explicit retry (max attempts + backoff + dead-letter with alert); no handler both computes and sends without an idempotency guard on the send** (§8.7).
- External calls wrapped with **timeout + retry + circuit-breaker from `src/platform/http`** — never hand-rolled (§8.10).
- All subscription changes, impersonation start/stop, dunning sends **route through the §4.5 command-path decorator** so they are audited (append-only, no UPDATE/DELETE grants). "The unlogged mutation" is a named anti-pattern.

### (18) Notifications
- **Dunning emails** across the `past_due`→`grace`→`suspended` window.
- **Two purge-warning emails** before `purge_pending → purged`.
- Notifications retention per doc 01 Appendix B (90d / 12mo). Logs never carry tenant business values (names, amounts) at info+ (§5.9/§8.5).

### (19) EN / AR / RTL / mobile
- Every commercial + impersonation surface: **RTL + Arabic** and **mobile 375px** (DoD gate). Labels via `TerminologyMap` (lang-keyed); tenant strings sanitised (F-25).

### (20) Performance
- **Indexes + EXPLAIN for hot queries** (DoD). Entitlement resolution stays cached (per-instance TTL 60s, max 5000, evict-oldest); **cross-instance push-invalidation** must be added by S9 (only same-process `invalidateEntitlements` exists).
- Telemetry budget surfaces: **AI spend/org, storage/egress per org, approval latency, reports/day/org** (§15.2); per-dependency health incl. billing/e-invoice/SMS adapters (§15.5).

### (21) Owner actions + credential-gated activation
- **OA-5 / OP-1:** start incorporation/merchant process (legal lead time — blocks S9).
- **D1 decision:** entity country + merchant/provider (leaning UAE+Stripe, unverified).
- **D3 / OP-2(?):** pricing numbers + tier limit values. **⚠ Mapping flag:** doc 09 routes all pricing authority through **D3**; the shipped code comments say values are "placeholders pending **OP-2/D3**." OP-2/OP-14 do **not** appear in doc 09 — if OP-2 is the governance-register entry ratifying D3, that linkage lives in the owner-decisions log, not doc 09; do not assume it.
- **Credential-gated activation:** owner supplies provider secrets → **platform secret store only** (never repo/logs/client bundle, doc 10 #37; Bible §6.3); rotation runbook; then the disabled prod adapter is enabled. Per environment rules, I cannot enter these credentials — the owner does so in the secret store.

### (22) Deferred to S10+
- `paused` subscription state (optional, "if offered" — not committed v1).
- `feat.sso` / SSO-SAML, `cap.white_label`, `cap.multi_company`, isolation add-on (E-tier / P5 platform layer, year 2–3).
- Concrete **add-on SKU catalogue** — doc 09 defines **no add-ons**; add-ons = "override bundles with their own Stripe line items" (v1 §13). Build the override mechanism now; defer the SKU list until pricing (D3) lands.
- Public REST API (`cap.api`) — "introduced only when the tier that sells it exists" (B/E).
- Enterprise-custom plan row (model as override bundle until an E-tier exists).
- `limit.automation_runs_month` (no code counterpart; decide later).

---

## B. D1 Four-Bucket Classification

### Bucket 1 — Safe to design / implement / test / deploy NOW
- All module/capability code (§20 Q3: "not module code").
- The **central entitlement service** (plans-as-data, `hasFeature`/`getLimit`/`checkLimit`, catalogue, plan-entitlements, overrides, resolved cache) — provider-agnostic; touches no processor.
- The **billing state-machine model** as states + transitions + `period_start`/`period_end` advancement (only its *webhook source* is provider-specific → drive it from the fake adapter now).
- **Trial design** (14-day Growth, no card) + all **abuse controls** (onboarding cap, IP/device throttle, disposable-email screening, daily AI-spend breaker).
- **AI-credits metering model** (counters, allowances, top-up structure).
- **Usage meters** (greenfield counter tables).
- **Support impersonation + break-glass** (consent-gated, banner, dual-logged) — fully greenfield, no processor.
- **Dunning + purge state pipeline** as governed state/email logic (send-through the disabled adapter/fake email in test).
- **The entire telemetry layer** — pilot metrics, per-card Today instrumentation, per-tenant egress metric — which *feeds* D1/D3 unit economics.
- **Provider-neutral adapter seam** itself (interface + fake + disabled-prod impl).
- **DPA / PDPL posture docs** (doc 10 #43) — schema/posture, not processor.
- Platform write path + cross-instance cache invalidation.

### Bucket 2 — Must remain DISABLED until D1 closes
- The **real payment-provider adapter** in production (checkout, portal, webhook ingress) — present in code, wired to fake in dev/test, **disabled prod**.
- The **live webhook source** that drives state transitions in prod (fake events drive it until then).
- Any UI that initiates a real charge / real card capture.

### Bucket 3 — Needs final legal / merchant / tax / pricing / provider decisions
- **D1:** entity country + merchant of record (Stripe vs Paddle/LS vs Tap/Moyasar).
- **Per-currency price IDs** attached to each plan (blocked on chosen provider).
- **Tax mechanism** (Stripe Tax vs MoR-absorbed VAT vs manual local tax).
- **D3 / OP-2(?):** pricing numbers + concrete tier limit values (all seeded numbers are placeholders).
- **Field-seat definition (Q9):** which capabilities free/cheap worker accounts get.
- **KSA lawful-transfer basis** in the DPA **before any KSA pilot holding visa/ID docs** (doc 10 #43, F-46).

### Bucket 4 — Must NOT be implemented or activated before D1
- Storing/handling real card data anywhere in our system (**no card data stored — provider is sole holder**; ⚠ this control is a doc-10 gap — add the PCI-scope item).
- Enabling the prod provider adapter / accepting real webhooks / taking real money.
- Committing any per-currency price IDs or live provider keys to the repo (secrets live only in the platform secret store).
- Hard-coding a merchant/tax assumption that a later D1 outcome would have to rip out (build provider-neutral; never `if (provider === 'stripe')` any more than `if (plan === 'pro')`).
- ⚠ Inbound webhook signature verification is currently an **unaddressed checklist gap** — it must exist and be enforced *before* the adapter is ever enabled.

---

## C. What Already Exists vs What S9 Must Add

**Foundation is already built and shipped** (migrations `0005` + `0007` hardening + `0050`/`0051`; code in `src/platform/entitlements/`). **S9 extends — does not duplicate.**

### Already exists
| Table (0005 unless noted) | Purpose | Key facts |
|---|---|---|
| `entitlement_def` | Catalogue mirror (DB⇔code parity test) | `key`, `kind ∈ (feature,limit)`; RLS read-all, **no write grant** |
| `plan` | Plan rows | Seeded `starter/growth/business`; read-all, no write |
| `plan_entitlement` | plan × entitlement value | `enabled` XOR `limit_value` (0007 `plan_entitlement_shape_ck`); null limit = unlimited |
| `org_plan_state` | **The subscription-state table today** | `plan_key`, `billing_state` (7-state CHECK, default `trialing`), `period_start`, `period_end` (nullable), `updated_at` (trigger). RLS select own org; **no app_user write** |
| `org_entitlement_override` | Per-org grants/exceptions | `enabled`/`limit_value`/`reason`; read own org, no write grant |

- Org creation (`app.create_org_with_owner`) atomically inserts `org_plan_state(org_id,'growth','trialing')`.
- **Resolve API** (`resolve.ts`): `resolveEntitlements`, `hasFeature` (unknown key throws), `getLimit` (null=unlimited; missing=0), `checkLimit` (`allowed = current < limit`; unlimited⇒always allowed), `invalidateEntitlements` (**same-process only**), `assertKnownKey`. Layering: `plan_entitlement` base → `org_entitlement_override` overwrites per key. Cache: per-instance TTL Map (60s / max 5000 / evict-oldest).
- **`billing_state` is STORED & RESOLVED ONLY, NOT ENFORCED** — referenced only in `resolve.ts`; **no transition function, nothing advances `period_end`, no consumer gates on it.** This is the core gap.
- **Metering today:** no persistent counter table. `checkLimit`'s `current` is counted **on demand** by the caller inside the write txn under `pg_advisory_xact_lock(hashtextextended(org+":jobs.create"))` (TOCTOU-safe). AI limits = `sum()` over `public.ai_interaction` (`credits`, `cost_micros`, `feature`; 0046). Platform daily AI-spend breaker = `app.platform_daily_ai_spend()` RPC (0051).
- **Shipped catalogue:** 17 `FEATURE_KEYS`, 9 `LIMIT_KEYS` (see item 8; note the drift flags there).

### What S9 must ADD (confirmed NOT to exist)
1. **Subscription lifecycle / state machine** — transition function over the 7 (→reconciled) `billing_state` values + `period_start`/`period_end` advancement.
2. **Provider seam** — `org_plan_state` has **no provider/customer/subscription id columns** and **no webhook ingress**; add provider-customer-id + provider-subscription-id (columns or new table) + idempotent webhook handler.
3. **Platform write path** — no write grant exists on `org_plan_state` / `org_entitlement_override`; add SECURITY DEFINER RPC or platform role + **cross-instance cache invalidation** (only same-process exists).
4. **`billing_state` enforcement** — nothing acts on `past_due/grace/suspended/cancelled` (FR-9: restrict ADD/writes, never reads/exports).
5. **Usage meters** — greenfield persistent counter table (if billing-grade usage needed).
6. **Dunning** — none exists (no table/schedule/state).
7. **Impersonation** — no surface exists at all; fully greenfield.
8. **Commercial/billing telemetry** — no surface exists.

---

## D. Build Plan (ordered)

### D.0 Catalogue reconciliation (do first, cheap)
Bring code + doc 09 into parity: add `cap.week_plan`, `limit.exception_rules_tuned`, the P3+ `cap.*` and `feat.sso` keys as **defined-but-release-gated**; drop or defer `limit.automation_runs_month`; decide the 3-vs-5 plan question. Update `entitlement_def` seed + `catalogue.ts` together (DB⇔code parity test must stay green).

### D.1 Migrations — forward-only, numbered from **0052**
Rules for every migration: `org_id uuid not null` + **RLS policy in the same migration** on every tenant table; **UUIDv7 PKs**; **composite org FKs** (child references parent on `(org_id, id)`); **no DELETE grant** (financial/audit rows never hard-deleted → `voided_at + void_reason` / `archived_at`); indexes + EXPLAIN for hot paths; **no data + schema in one file**; RLS + rollback note + migration-test-harness pass. Seed new entities into the **two-org bleed test**.

Suggested sequence:
- **0052** — extend `org_plan_state`: add `provider` (nullable), `provider_customer_id`, `provider_subscription_id` (nullable, encrypted where credential-like), reconcile `billing_state` CHECK to include `purge_pending`, `purged` (and optionally `paused`); add `grace_until` / `suspend_at` / `purge_at` timestamptz for window math. (Expand-only.)
- **0053** — `subscription_event` / webhook-inbox table: idempotency key unique constraint, `org_id`, raw payload, provider event id, processed_at. First-wins on replay.
- **0054** — `usage_meter` (persistent counters: `org_id`, `meter_key`, period, `value bigint`) if billing-grade metering is required; else keep on-demand + document.
- **0055** — `dunning_schedule` / dunning-attempt table (org-scoped, keyed, attempt count, next_run, dead-letter marker).
- **0056** — `impersonation_session` (consent grant, `started_at`/`ended_at`, staff id, `org_id`, reason, banner-shown flag) + break-glass two-party approval fields; dual-log wiring.
- **0057** — `reconciliation` table (provider truth vs local state drift) + telemetry tables: per-tenant egress/storage/function-cost keyed by `org_id`; per-card Today engagement/freshness events.
- **0058** — platform write path: SECURITY DEFINER RPC(s) for plan/override/state writes (owner-only billing actions; #21) + cross-instance cache-invalidation channel.

### D.2 Provider-neutral adapter seam
- Interface: `createCheckout`, `openPortal`, `cancel`, `parseWebhook`, `verifySignature`. **Fake adapter** (drives every state transition in tests) + **disabled prod adapter** (throws/no-ops until D1 flag + secrets present).
- Secrets from platform secret store only; `src/platform/http` wrapper (timeout + retry + circuit-breaker); Zod parse at the webhook boundary; **signature verification** (closes the doc-10 gap) before any state mutation.

### D.3 Services (L4 commercial only)
- Subscription state-machine service (transition fn; webhook-driven; command-path decorated; one command = one txn; events after commit — `subscription.activated`, `subscription.past_due`, `subscription.suspended`, `subscription.cancelled`, past-tense, versioned, idempotent consumers).
- Entitlement enforcement layer over resolve API: hard-stop for security features (`cap.api`, `cap.white_label`); soft-warn-then-block-adds for growth limits (`limit.full_users`, `limit.active_jobs`, `limit.storage_gb` warn 80% / block 100%); **never block reads/exports** (FR-9).
- Upgrade (immediate+proration) / downgrade (period-end) service.
- Impersonation service (consent gate, banner, **dual-log to platform + tenant audit log**, break-glass two-party + post-hoc notify).

### D.4 Workers / events
- Dunning worker (idempotent, org-scoped, bounded, backoff + dead-letter + alert; **no compute-and-send without send idempotency guard**; no network in txn).
- Purge worker (checks **legal hold** first; two warning emails; `purge_pending → purged`).
- Reconciliation worker (provider vs local drift).
- Cache-invalidation consumer on any billing event.

### D.5 UI (en / ar / RTL / 375px)
- Owner-only billing/plan/price-book admin; subscription status + meter (AI credits, storage) in settings; upgrade/downgrade flows; cancellation + export window; impersonation **persistent banner** in the tenant surface; pilot + commercial telemetry dashboards (5 role Today screens, ≤6 owner cards, per-card engagement + freshness/data-age signal, per-tenant egress). Cost redaction at every serialization boundary (#17).

### D.6 Tests
- **Billing-webhook state-machine: every transition + idempotent replays** (real DB, transactional fixtures).
- **Entitlement downgrade: block adds, never block reads.**
- **Impersonation banner + dual-log assertions** (session visible in tenant audit log).
- **Two-org bleed harness** with all new entities seeded.
- **Money-path golden-file tests** for any subscription/proration amount (P7).
- Idempotency-key proofs on webhook + dunning send.

### D.7 Review / gates / deploy / Arabic-demo / cleanup
- **Money-path review label** (2-approval, security-labelled) on any amount/VAT/subscription code; authz-diff review; **dependency + secret scanning in CI**.
- Update **doc 10** living checklist: **add webhook-signature-verification item + no-card-data/PCI-scope item** (both current gaps); state which items each PR touches.
- **Deploy expand → migrate → contract**: migrations before code; rollback = redeploy previous tag. **No manual prod SQL.**
- DPA/PDPL posture docs (doc 10 #43) incl. KSA lawful-transfer basis before any KSA pilot.
- **Arabic demo** on a test org: `trial → paid → past_due → recovery` + a support session appearing in the tenant's own audit log (the two DoD ACs), at 375px and RTL.
- Cleanup: keep provider adapter disabled in prod; document the D1-activation flip (secrets + price IDs + enable adapter) as an owner runbook requiring no schema/logic change.

---

### Contradiction / gap register (consolidated)
1. **Plan count:** v1 §13 = 5 plans; doc 09 + code = 3. → model trial as state, enterprise as override.
2. **Billing-state set:** v1 (8 + paused) vs DB (7, has `internal_pilot`, lacks purge_pending/purged/paused) vs Bible (5). → reconcile CHECK in 0052.
3. **`grace` day-window** undefined vs `past_due` ~14d. → confirm split at build.
4. **Catalogue drift:** `cap.week_plan`, `limit.exception_rules_tuned`, P3+ caps, `feat.sso` in doc 09 but not in shipped code; v1's `limit.automation_runs_month` has no code counterpart.
5. **doc 10 gaps:** no webhook-signature-verification item; no no-card-data/PCI-scope item. Both required before adapter enablement.
6. **Owner-decision mapping:** doc 09 routes pricing through **D3**; code comments say **OP-2/D3**; OP-2/OP-14 absent from doc 09 — do not assume the linkage.

**Source paths:** `saas-foundation/FOUNDATION_REPORT.md` (§8/§12/§13/§19/§20), `OPERATIONS_FIRST_FOUNDATION_REPORT.md` (§12/§13), `idaraworks/phase2/09-entitlements-config-schemas.md`, `idaraworks/phase2/10-security-tenancy-checklist.md`, `idaraworks/phase2/11-mvp-delivery-plan.md` (S9 = lines 141–148), `idaraworks/impl/S0-EXECUTION-CHECKLIST.md` (OA-5 = line 17), `saas-foundation/BUILD_BIBLE.md`, and shipped code `idaraworks/src/platform/entitlements/{catalogue,resolve,index}.ts` + migrations `0005/0007/0050/0051`.