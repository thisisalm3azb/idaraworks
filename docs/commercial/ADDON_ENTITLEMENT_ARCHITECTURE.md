# Add-on Entitlement Architecture (post-MVP expansion)

How the modular monthly add-on model **extends** the existing plan/entitlement system (0005/0052/0053)
without replacing it. Prices here are a **recommended launch catalogue** (USD/month, tax-exclusive),
never a legal or irreversible commercial commitment; real payment + e-invoice providers remain
D1-gated and disabled in production.

## 1. Design invariants (all preserved, verified against the code map)

| Invariant | How it is preserved |
| --- | --- |
| Client claims cannot activate paid entitlements | `org_addon` is tenant-**read-only** (RLS select; no write grant). Every write goes through a new SECURITY DEFINER `app.set_org_addon(...)` guarded by `app.assert_platform_task()` — the same wall as `app.advance_subscription` (0053). |
| Provider events remain the sole billing-state writer | Untouched. Add-on set changes do not move `billing_state`; they are subscription-item changes driven through the provider seam (fake off-prod → HMAC-signed `addon_changed` webhook → DEFINER write; disabled in prod → `BillingProviderDisabledError`, UI shows activation-unavailable). |
| Webhook idempotency | Same inbox: `subscription_event` unique `(provider, provider_event_id)`; `addon_changed` events flow through `processSubscriptionWebhook` and dedupe identically. |
| Reads/exports never blocked (FR-9) | Entitlements continue to gate **ADD** paths and UI emphasis only. Downgrades/removals never delete data; existing records stay readable + exportable. Gated *intelligence surfaces* (costing dashboard, digest, advanced analytics) may hide behind their add-on, but entity lists + CSV exports always work. |
| Downgrades never delete data | Removal is `remove_at_period_end` scheduling; after removal the entitlement drops, rows remain. `READ_ONLY_BILLING_STATES` unchanged. |
| Trial + internal-pilot overrides | `org_entitlement_override` keeps the **highest precedence** (unchanged), so pilot/trial grants continue to work over any plan+add-on base. |
| Audit history | Every add-on change lands in `subscription_event` (provider evidence) + `audit_log` (`subscription.addons_changed`) + is reflected in the entitlement resolution deterministically. |
| Price versioning | `addon_price` mirrors `plan_price` (0052): one ACTIVE row per (addon, interval, currency); superseded rows keep history (`active=false`, `version+1`). Price changes never rewrite history. |
| Forward-only migrations | New DDL starts at `0065`; no applied migration file is modified. |

## 2. Data model (migration 0065+)

```
addon_def          key text PK (^[a-z][a-z0-9_.]{0,49}$), active bool, sort int
                   — parity-tested against the code catalogue (like entitlement_def ⇔ catalogue.ts)
addon_price        like plan_price: (addon_key FK, billing_interval, currency, unit_amount_minor,
                   is_placeholder, active, version) + unique-active index
org_addon          (org_id FK, addon_key FK, quantity int ≥1 default 1, status active|removal_scheduled,
                   added_at, remove_at timestamptz null, source text individual|bundle:<key>)
                   RLS: tenant SELECT only; writes only via app.set_org_addon (DEFINER, platform-task)
bundle_def         key text PK, active bool, sort int          — parity-tested vs code catalogue
bundle_addon       (bundle_key FK, addon_key FK, quantity int ≥1)
bundle_price       same shape as addon_price (the discounted bundle price)
```

The **semantic content** of add-ons (names, descriptions, which entitlements they grant) is
**code-owned** in `src/platform/entitlements/addons.ts` — same registry discipline as
`catalogue.ts`, with a DB⇔code parity integration test. A bundle is **only** a discounted
collection: activation expands to `org_addon` rows with `source='bundle:<key>'` — it resolves to
the **same underlying add-on keys** and creates no second entitlement system.

## 3. Resolution (deterministic, extends `loadResolved`)

```
base   = plan_entitlement rows for org's plan          (the FREE plan is the new default base)
addons = org_addon(active) × addon grant map:
           features:  OR                                (any active addon granting a feature enables it)
           limits:    base + Σ(delta × quantity)        (additive packs; e.g. +10 members × qty)
overrides = org_entitlement_override                    (unchanged, highest precedence)
```

Order: **plan → add-ons → overrides**. Unknown keys still throw; `getLimit` still defaults 0 for
missing keys, so every new limit key is seeded for every plan in the same migration (avoiding the
documented 0-cap foot-gun). Cache stays the 60s TTL; add-on purchase UX tolerates it (success page
reads fresh in-tx like `command()` does for billing state).

## 4. Free base + plans

- New plan key **`free`** seeded in `plan` + `plan_entitlement`; **new orgs default to `free` +
  `billing_state='active'`** (an org that owes nothing is simply active — no dunning applies).
  `app.create_org_with_owner` updated accordingly (migration, forward-only).
- Existing plans starter/growth/business **remain** (existing orgs untouched; Alpha Marine + TESTING
  keep their current growth/trialing state). They become legacy/internal tiers; the customer-facing
  model is free base + add-ons/bundles. Trials remain possible via states + overrides.
- Free base contents (final numbers in `FREE_PLAN_DEFINITION.md`, research-justified): jobs/projects,
  daily reports, issues, tasks/stages, employee **records** unlimited; customers + suppliers records;
  manual entry; small login-seat allowance (full users limited; **field seats free**), limited
  storage, limited exports-per-month? (exports stay FR-9-unblocked; only bulk/scheduled extras are an
  add-on), 1 organization.

## 5. Enforcement additions (closing verified gaps)

1. **Seat limits** (`limit.full_users`, `limit.viewer_users`; field stays unlimited): enforced at
   `inviteMember` + role-change with an in-tx recount (advisory-lock pattern from jobs/service.ts).
2. **Capability gates** (`cap.quoting`, `cap.invoicing`, `cap.procurement`, `cap.approvals`,
   `cap.expenses_costing`, `cap.customer_updates`): service-entry `requireCapability(ctx, key)` on
   CREATE/mutate paths only (reads/exports untouched). Free-base caps (`cap.jobs`,
   `cap.daily_reports`, `cap.issues`, `cap.customers`, `cap.people`) stay always-on.
3. **UI awareness**: org layout nav + pricing page read `resolveEntitlements` server-side; gated
   modules render with an "add-on required" state instead of silently 404/erroring; no misleading
   payment buttons while the billing provider is disabled.
4. **Scheduled changes actually apply** (fixes a verified pre-existing gap): the lifecycle sweep
   gains a period-end step that (a) applies `scheduled_plan_key`, (b) executes `org_addon`
   removals whose `remove_at ≤ now()`. Period anchor: provider-supplied when a real provider exists;
   deterministic monthly anchor (UTC, from subscription/add-on start) under fake/disabled providers.
5. **Onboarding `requires_upgrade`** becomes entitlement-aware (replaces the hard-coded
   ALWAYS_ON_FEATURES list) so add-on-granted features never show as "requires upgrade".

## 6. Add-on catalogue classification (honesty gate)

Every add-on carries `availability`: `available` | `manual_process` | `credential_gated` |
`d1_gated` | `deferred`. The pricing page sells **only** `available` (and `manual_process` with the
manual clearly labeled); `credential_gated`/`d1_gated` render as visible-but-unavailable with honest
messaging; **`deferred` never renders as purchasable**. The catalogue is asserted by a unit test
(no deferred item priced-and-buyable; every sellable add-on maps only to capabilities that exist).

## 7. What does NOT change

- RLS second wall, composite org FKs, NO DELETE grants, `command()` chokepoint + FR-9 read-only
  billing states, redaction walls (cost/price privileges are ROLE walls, not commercial walls),
  dunning ladder, impersonation/audit, storage quota TOCTOU-safe reservation, export surfaces.
- No card data is ever stored; no real payment activation; e-invoice remains disabled.
