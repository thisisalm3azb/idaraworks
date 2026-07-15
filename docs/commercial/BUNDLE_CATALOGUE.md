# Bundle Catalogue — Recommended Launch Bundles

> **Source of truth:** `BUNDLES` in `src/platform/entitlements/addons.ts`; seeded into
> `bundle_def`/`bundle_addon`/`bundle_price` by migration 0065 and amended by **migration 0070**
> (enforcement-honesty reclassification). Prices are per month, tax-exclusive,
> `is_placeholder = true` pending owner ratification. **Annual = 10× monthly.**
>
> **0070 changes:** `addon.branding_docs`, `addon.branding_app` and `addon.exports_extended` were
> reclassified to deferred (their capabilities do not exist) and removed from every bundle.
> `bundle.starter_ops` was **repriced $9 → $7 / AED 33 → 26** — at $9 it would have cost MORE than
> its two remaining members ($8) bought individually. `bundle.full_ops` kept its price (still −54%).
> **The starter_ops reprice awaits owner ratification** like every other placeholder price.

## The invariant: bundles are NOT a second entitlement system

A bundle is nothing but a **discounted collection of the same add-on keys**. Activating a bundle
resolves to exactly the member add-ons' entitlement grants — `resolve.ts` has no bundle-specific
logic; `bundle_addon` maps each bundle to its members; the discount is shown honestly via
`bundleMemberTotalMinor()` (sum of live member prices, computed at runtime — never a hardcoded
"was" price). A bundle is purchasable only if **every** member add-on is purchasable
(`bundleIsPurchasable`); no bundle contains a credential-gated, d1-gated or deferred add-on.

## The six bundles

| Bundle | Contents | USD/mo | Sum of members | Discount | USD/yr (10×) | AED/mo |
|---|---|---|---|---|---|---|
| `bundle.starter_ops` — Starter Operations / العمليات الأساسية | quotes_invoices + customer_updates | **$7** | $8 | **−12.5%** | $70 | 26 |
| `bundle.finance` — Finance / المالية | payments_ar + expenses_cashbook + quote_vs_actual | **$9** | $12 | **−25%** | $90 | 33 |
| `bundle.procurement` — Procurement / المشتريات | purchase_requests + purchase_orders + goods_receiving + items_catalogue + approval_workflows | **$12** | $19 | **−37%** | $120 | 45 |
| `bundle.project_control` — Project Control / ضبط المشاريع | job_costing + labour_timesheets + quote_vs_actual + owner_digest | **$12** | $20 | **−40%** | $120 | 45 |
| `bundle.growth` — Growth / النمو | quotes_invoices + payments_ar + expenses_cashbook + job_costing + customer_updates | **$19** | $24 | **−21%** | $190 | 70 |
| `bundle.full_ops` — Full Operations / العمليات الكاملة | all 15 available modules (see below) | **$29** | $63 | **−54%** | $290 | 109 |

`bundle.full_ops` members (every `available` non-seat, non-support module — 15 since 0070):
quotes_invoices, payments_ar, expenses_cashbook, purchase_requests, purchase_orders,
goods_receiving, items_catalogue, approval_workflows, job_costing, labour_timesheets,
quote_vs_actual, owner_digest, customer_updates, data_import, audit_history.
Excluded by design: seat/storage/org packs (stackable quantities), priority_support
(manual_process service), and everything credential-gated or deferred (which since 0070 includes
exports_extended, branding_docs and branding_app).

## Positioning logic

- **Starter Ops $7** (was $9 pre-0070) — the first-purchase path: bill customers and share
  progress. Shallow −12.5% because each member is already cheap. Repriced when branding_docs was
  deferred; when branding ships, the owner may restore the $9 three-member shape.
- **Finance $9** — the owner's accounting anchor kept verbatim (see
  [OWNER_PRICING_DECISIONS.md](./OWNER_PRICING_DECISIONS.md), anchor #1).
- **Procurement $12 / Project Control $12** — functional suites at −37/−40%: the discount makes
  buying the whole workflow obviously better than cherry-picking 3 of 5 modules.
- **Growth $19** — the recommended volume path (billing + money + costing + customer sharing);
  discount kept shallow (−21%) since it is the price point we expect most orgs to land on.
- **Full Operations $29** — the "everything" anchor, sitting inside the researched $25–45
  all-in band (Odoo Standard $28.80/user, Zoho One $37/user) while being per-org, not per-user
  ([ADDON_PRICING_RATIONALE.md](./ADDON_PRICING_RATIONALE.md) §4). The steep −54% is the point:
  past ~6 modules à la carte, Full Ops is always the rational choice.

Overlap note: `addon.quote_vs_actual` appears in both Finance and Project Control — features
OR-merge in `resolve.ts`, so owning both bundles is harmless (no double entitlement, no
double-charge inside either bundle's flat price).

AED companion sums for the curious: Starter Ops 26 vs 30 (−13%), Finance 33 vs 45 (−27%),
Procurement 45 vs 71 (−37%), Project Control 45 vs 75 (−40%), Growth 70 vs 90 (−22%),
Full Ops 109 vs 236 (−54%) — AED discounts track USD within rounding of the clean-figure companion
prices.

## The tier bundles (U3 four-path model — migration 0072)

Two additional GOVERNED bundles present the Medium / High subscription paths
(`BundleDef.tier` marker; same invariant — nothing but discounted collections of the same add-on
keys; full flow doc: [SUBSCRIPTION_SELECTION_FLOW](../ux/SUBSCRIPTION_SELECTION_FLOW.md)):

| Tier bundle | Contents | USD/mo | Sum of members | Discount | AED/mo (vs sum) |
|---|---|---|---|---|---|
| `bundle.tier_medium` — Medium / المتوسطة | members_10 + quotes_invoices + payments_ar + expenses_cashbook + purchase_requests + purchase_orders | **$15** | $28 | **−46%** | 55 (vs 106, −48%) |
| `bundle.tier_high` — High / العليا | the full_ops fifteen + branding_docs + branding_app (0071 reactivation) + members_10 + storage_25gb (19 members) | **$39** | $75 | **−48%** | 143 (vs 282, −49%) |

Tier positioning: Medium (6 members, −46%) sits between the functional suites (−37…−40%) and
Full Ops (−54%) on the size-deepens-discount curve; High ($39) stays inside the $25–45
"everything" band and **undercuts the cheapest combination path on the same page**
(full_ops $29 + seat/storage packs $9 + branding singles $3 = $41), so neither tier is ever a
dominated sticker (unit-tested). Tiers include the seat/storage packs at quantity 1 — the one
deliberate exception to the "no stackables in bundles" rule (extra packs are bought individually
on top). `manual_process`, credential/D1-gated and deferred items are never tier members.
Prices are placeholders pending owner ratification, like every other row.
