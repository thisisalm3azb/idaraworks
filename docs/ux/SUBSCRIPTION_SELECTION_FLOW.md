# Subscription Selection Flow — the Four Paths (U3)

> Status: shipped with migration **0072** (tier bundle seeds) on the add-on
> model (0065/0070/0071). All prices are **placeholders**
> (`is_placeholder = true`), tax-exclusive, **pending owner ratification**
> ([OWNER_PRICING_DECISIONS](../commercial/OWNER_PRICING_DECISIONS.md)). Real
> payment collection remains **D1-gated** — nothing in this flow can charge
> anyone.

## 1. The model: four paths, ONE entitlement system

Every workspace chooses (or simply lands on) one of four paths:

| Path | What it is | Mechanism |
|---|---|---|
| **Free** | The permanent base every org lands on after trial/downgrade | `free` plan (`plan_entitlement`, 0065) |
| **Medium** | A governed bundle: the balanced small-business set | `bundle.tier_medium` (bundle of ordinary add-on keys) |
| **High** | A governed bundle: everything operational today | `bundle.tier_high` (bundle of ordinary add-on keys) |
| **Custom** | À-la-carte add-ons / themed bundles | individual `addon.*` keys + existing bundles |

**There is no second entitlement system.** A tier is a `BundleDef` carrying a
`tier: "medium" | "high"` marker (`src/platform/entitlements/addons.ts`) —
selection goes through the SAME `changeAddons({ bundleKey })` path as every
bundle: the provider→webhook round-trip expands it to member `org_addon` rows
(`source = 'bundle.tier_*'`), the resolver (`resolve.ts`) merges features OR /
limit deltas ADD exactly as for individual purchases. Overlap dedupes on the
`(org_id, addon_key)` primary key — one row per key, never a double
entitlement or double charge (integration-tested in
`tests/integration/tier-selection.test.ts`).

## 2. Exact compositions, prices and savings maths

### Free — $0
From the 0065 `free` plan seeds (code mirror: `FREE_PLAN_LIMITS` /
`FREE_PLAN_FEATURES` in `catalogue.ts`): core operations (jobs*, daily
reports, issues, customers, people records), **3 office seats + 3 read-only
viewers + unlimited free field seats**, 10 active jobs*, 1 GB storage,
deterministic onboarding, core exports never gated. (*the org's own noun via
terminology.)

### Medium — `bundle.tier_medium` · **$15/mo · AED 55/mo** (Recommended)

| Member | USD | AED |
|---|---:|---:|
| addon.members_10 | 5.00 | 19.00 |
| addon.quotes_invoices | 5.00 | 19.00 |
| addon.payments_ar | 5.00 | 19.00 |
| addon.expenses_cashbook | 4.00 | 15.00 |
| addon.purchase_requests | 4.00 | 15.00 |
| addon.purchase_orders | 5.00 | 19.00 |
| **Individual sum** | **28.00** | **106.00** |
| **Tier price** | **15.00 (−46%)** | **55.00 (−48%)** |

Pricing-band justification ([ADDON_PRICING_RATIONALE](../commercial/ADDON_PRICING_RATIONALE.md) §6):
the discount curve deepens with bundle size — 6 members sits between the
5-member suites (−37…−40%) and full_ops (−54%), so −46% keeps the curve
monotone. No cheaper combination of existing bundles + singles covers this set
(the cheapest alternative is $28: `bundle.finance` $9 + quotes $5 + members $5
+ PR $4 + PO $5), so the sticker is never dominated.

### High — `bundle.tier_high` · **$39/mo · AED 143/mo** (Most complete)

ALL currently production-operational purchasable add-ons: the **full_ops
fifteen** (quotes_invoices, payments_ar, expenses_cashbook, purchase_requests,
purchase_orders, goods_receiving, items_catalogue, approval_workflows,
job_costing, labour_timesheets, quote_vs_actual, owner_digest,
customer_updates, data_import, audit_history — $63 / AED 236) **+
branding_docs ($2/AED 8) + branding_app ($1/AED 4)** (0071 reactivated the
branding capability, so both are included per the task directive) **+
members_10 ($5/AED 19) + storage_25gb ($4/AED 15)**.

| | USD | AED |
|---|---:|---:|
| **Individual sum (19 members)** | **75.00** | **282.00** |
| **Tier price** | **39.00 (−48%)** | **143.00 (−49%)** |

$39 sits inside the researched $25–45 "everything" band (rationale §4) and is
strictly cheaper than the cheapest combination path shown on the same page
(`bundle.full_ops` $29 + the two packs $9 + branding singles $3 = **$41** /
AED 155) — the tier is never a dominated sticker (the 0070 starter_ops
repricing precedent).

Excluded from BOTH tiers on principle: `manual_process` items (extra_org,
priority_support — human-delivered, confirmed individually),
`credential_gated` / `d1_gated` items (not activatable), and `deferred` items
(never sold). Yearly prices are 10× monthly (two months free), same as every
other price row.

### Custom
The existing grouped add-on catalogue: every purchasable add-on individually
(quantity steppers for the stackable seat/storage packs), themed bundles, with
`credential_gated`/`d1_gated` items **visible but non-selectable with the
honest reason**, and `deferred` items excluded from the selection view
entirely.

## 3. Honesty rules (carried from the 0065/0070 honesty law)

1. Deferred capabilities are never shown as selectable anywhere in the flow.
2. Gated items always carry their `availabilityNote` — visible, not buyable.
3. Tier prices always render NEXT TO the true individual member total and the
   % saving — the discount is shown, not asserted.
4. Every price surface carries the tax-exclusive + indicative labels.
5. While the billing provider is disabled (D1), every selection surface states
   plainly that **no payment is collected now**; `<LockedFeature>` never
   implies a purchase can complete.
6. A tier must never be a dominated sticker (more expensive than another
   combination on the same page) — unit-tested.

## 4. Where selection appears

- **Settings** (`/o/[orgId]/settings/subscription`) — shipped now:
  `<TierCards>` (the four comparison cards) renders above the themed-bundle
  list; tier bundles are excluded from the regular bundle list (the
  `BundleDef.tier` marker); the Custom card anchors to the individual add-on
  catalogue (`#custom-addons`). A compact current-state strip (plan, current
  selection, active add-on count, seat + storage usage, monthly total, trial
  end, scheduled downgrade) sits in the first card.
- **Locked features** — the money-module entry pages (quotes/new,
  invoices/new, payments/new, expenses/new, material-requests/new,
  purchase-orders/new) and the costing page render `<LockedFeature>` via the
  one-line `lockedFeatureGate()` helper when the capability is off: what the
  feature does, the unlocking add-on + price, the tiers that include it, and a
  link here. Reads/exports are never blocked (freeze FR-9) — the gate wraps
  ADD/entry pages only; `requireCapability` in the services remains the
  enforcement wall.
- **Navigation** — the subscription page is linked from the header account
  area AND the org section nav (both `billing.view`-gated).
- **Onboarding (wave 2 — the contract for the onboarding agent):** the
  onboarding flow calls `buildSelectionView()`
  (`@/modules/subscription/service`) to render the same four options
  (`<TierCards>` and `<CustomBuilder>` in `src/platform/ui/subscription/` are
  pure-presentational and embed as-is), then records the choice through the
  SAME actions: Free = do nothing (it is the landing base); Medium/High =
  `changeAddons(ctx, archetype, { bundleKey: "bundle.tier_medium" | "bundle.tier_high" })`;
  Custom = `changeAddons` with an `additions` list (the `CustomBuilder`
  submission posts `addon:<key> = quantity` fields). No new writer, no new
  tables, no onboarding-specific price source.

## 5. Existing-org safety (no silent conversion)

Existing orgs — including the protected production orgs (Alpha Marine,
TESTING) — keep their current plans and add-ons untouched. 0072 only INSERTS
catalogue rows; nothing migrates `org_plan_state` or `org_addon`. The UI maps
an org's current state onto a path for DISPLAY only
(`currentSelectionLabel()`: tier-sourced rows → that tier; any other live
add-ons → "Custom"; none → the plan base). Any conversion of an existing org
to a tier is an explicit owner action later, through the normal
`changeAddons` path.

## 6. Tests

- `tests/unit/addons-catalogue.test.ts` — tier composition/pricing invariants
  (members ⊆ available add-ons, exact sums, ≥40% honest saving, non-dominated
  High price, tier-vs-regular bundle stackability law).
- `tests/unit/subscription-selection.test.ts` — buildSelectionView shape
  (Free $0 + real limits; deferred absent; gated flagged with reasons),
  monthly-total math (bundle counted once), display mapping, LockedFeature
  resolution map (every page-gated capability resolves to an add-on + a tier).
- `tests/integration/tier-selection.test.ts` — 0072 DB⇔code parity, tier
  selection end-to-end via changeAddons (all member rows
  `source='bundle.tier_medium'`), overlap = ONE `org_addon` row, resolved
  entitlements enable exactly the tier's capabilities + seat delta.
