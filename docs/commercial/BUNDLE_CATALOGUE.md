# Bundle Catalogue — Recommended Launch Bundles

> **Source of truth:** `BUNDLES` in `src/platform/entitlements/addons.ts`; seeded into
> `bundle_def`/`bundle_addon`/`bundle_price` by migration 0065. Prices are per month,
> tax-exclusive, `is_placeholder = true` pending owner ratification. **Annual = 10× monthly.**

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
| `bundle.starter_ops` — Starter Operations / العمليات الأساسية | quotes_invoices + customer_updates + branding_docs | **$9** | $10 | **−10%** | $90 | 33 |
| `bundle.finance` — Finance / المالية | payments_ar + expenses_cashbook + quote_vs_actual | **$9** | $12 | **−25%** | $90 | 33 |
| `bundle.procurement` — Procurement / المشتريات | purchase_requests + purchase_orders + goods_receiving + items_catalogue + approval_workflows | **$12** | $19 | **−37%** | $120 | 45 |
| `bundle.project_control` — Project Control / ضبط المشاريع | job_costing + labour_timesheets + quote_vs_actual + owner_digest | **$12** | $20 | **−40%** | $120 | 45 |
| `bundle.growth` — Growth / النمو | quotes_invoices + payments_ar + expenses_cashbook + job_costing + customer_updates | **$19** | $24 | **−21%** | $190 | 70 |
| `bundle.full_ops` — Full Operations / العمليات الكاملة | all 18 available modules (see below) | **$29** | $69 | **−58%** | $290 | 109 |

`bundle.full_ops` members (every `available` non-seat, non-support module): quotes_invoices,
payments_ar, expenses_cashbook, purchase_requests, purchase_orders, goods_receiving,
items_catalogue, approval_workflows, job_costing, labour_timesheets, quote_vs_actual, owner_digest,
customer_updates, data_import, exports_extended, audit_history, branding_docs, branding_app.
Excluded by design: seat/storage/org packs (stackable quantities), priority_support
(manual_process service), and everything credential-gated or deferred.

> **Note (code-comment discrepancy):** the inline comment in `addons.ts` for `bundle.full_ops`
> says "vs 6600 individually (−56%)", but the actual sum of the 18 members' launch prices is
> **$69/mo (−58%)** — the runtime `bundleMemberTotalMinor()` (which the UI uses) returns $69.
> The comment should be corrected to 6900/−58% in a code pass; this catalogue records the computed
> truth.

## Positioning logic

- **Starter Ops $9** — the first-purchase path: bill customers and look professional. Shallow −10%
  because each member is already cheap.
- **Finance $9** — the owner's accounting anchor kept verbatim (see
  [OWNER_PRICING_DECISIONS.md](./OWNER_PRICING_DECISIONS.md), anchor #1).
- **Procurement $12 / Project Control $12** — functional suites at −37/−40%: the discount makes
  buying the whole workflow obviously better than cherry-picking 3 of 5 modules.
- **Growth $19** — the recommended volume path (billing + money + costing + customer sharing);
  discount kept shallow (−21%) since it is the price point we expect most orgs to land on.
- **Full Operations $29** — the "everything" anchor, sitting inside the researched $25–45
  all-in band (Odoo Standard $28.80/user, Zoho One $37/user) while being per-org, not per-user
  ([ADDON_PRICING_RATIONALE.md](./ADDON_PRICING_RATIONALE.md) §4). The steep −58% is the point:
  past ~6 modules à la carte, Full Ops is always the rational choice.

Overlap note: `addon.quote_vs_actual` appears in both Finance and Project Control — features
OR-merge in `resolve.ts`, so owning both bundles is harmless (no double entitlement, no
double-charge inside either bundle's flat price).

AED companion sums for the curious: Starter Ops 33 vs 38 (−13%), Finance 33 vs 45 (−27%),
Procurement 45 vs 71 (−37%), Project Control 45 vs 75 (−40%), Growth 70 vs 90 (−22%),
Full Ops 109 vs 259 (−58%) — AED discounts track USD within rounding of the clean-figure companion
prices.
